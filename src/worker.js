const REDDIT_BASE = 'https://www.reddit.com';
const USER_AGENT = 'reddit-rss-top/1.0 (Cloudflare Worker)';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === '/rss' || url.pathname === '/rss.xml') {
        return corsResponse(await handleRss(url, env));
      }
      if (url.pathname === '/api/posts') {
        return corsResponse(await handleApi(url, env));
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return handleIndex();
      }
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      return corsResponse(
        new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
  },
};

// --- Reddit fetching ---

async function fetchRedditPage(path, after) {
  let url = `${REDDIT_BASE}${path}.json?limit=100&raw_json=1`;
  if (after) url += `&after=${after}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    cf: { cacheTtl: 300, cacheEverything: true },
  });

  if (!res.ok) throw new Error(`Reddit API error: ${res.status}`);
  const json = await res.json();
  if (!json?.data?.children) throw new Error('Unexpected Reddit response format');
  return json.data;
}

async function fetchAllPages(path, maxPages) {
  const posts = [];
  let after = null;

  for (let i = 0; i < maxPages; i++) {
    const data = await fetchRedditPage(path, after);
    posts.push(...data.children.map((c) => c.data));
    after = data.after;
    if (!after) break;
  }

  return posts;
}

function filterAndSort(posts, threshold) {
  const seen = new Set();
  return posts
    .filter((p) => p.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
}

// --- Parse params ---

function parseParams(url, env) {
  const source = url.searchParams.get('source') || 'all';
  const subreddits = url.searchParams.get('subs')?.split(',').map((s) => s.trim().replace(/^r\//, '')).filter(Boolean) || [];
  const threshold = parseInt(url.searchParams.get('threshold') || env.DEFAULT_THRESHOLD || '1000', 10);
  const timeframe = url.searchParams.get('t') || url.searchParams.get('timeframe') || env.DEFAULT_TIMEFRAME || 'day';
  const pages = Math.min(parseInt(url.searchParams.get('pages') || '2', 10), 5);

  return { source, subreddits, threshold, timeframe, pages };
}

function buildPath(source, sub, timeframe) {
  const base = sub ? `/r/${sub}` : `/r/${source}`;
  return `${base}/top/?sort=top&t=${timeframe}`;
}

async function getPosts(params) {
  const { source, subreddits, threshold, timeframe, pages } = params;
  let posts = [];

  if (source === 'custom' && subreddits.length > 0) {
    const results = await Promise.all(
      subreddits.map((sub) => fetchAllPages(buildPath(null, sub, timeframe), pages).catch(() => []))
    );
    posts = results.flat();
  } else {
    posts = await fetchAllPages(buildPath(source, null, timeframe), pages);
  }

  return filterAndSort(posts, threshold);
}

// --- RSS XML generation ---

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildRssXml(posts, params) {
  const now = new Date().toUTCString();
  const { threshold, timeframe, source, subreddits } = params;

  const titleParts = [];
  if (source === 'custom' && subreddits.length) {
    titleParts.push(subreddits.map((s) => `r/${s}`).join('+'));
  } else {
    titleParts.push(`r/${source}`);
  }
  titleParts.push(`≥${threshold} upvotes`);
  titleParts.push(timeframe);

  const items = posts
    .map(
      (p) =>
        `    <item>
      <title>${esc(p.title)}</title>
      <link>https://www.reddit.com${esc(p.permalink)}</link>
      <description>${esc(`[${p.score} upvotes] [r/${p.subreddit}] ${p.selftext?.slice(0, 300) || ''}`)}</description>
      <pubDate>${new Date(p.created_utc * 1000).toUTCString()}</pubDate>
      <guid isPermaLink="true">https://www.reddit.com${esc(p.permalink)}</guid>
      <category>${esc(p.subreddit)}</category>
    </item>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Reddit Top – ${esc(titleParts.join(' · '))}</title>
    <link>https://www.reddit.com</link>
    <description>Top Reddit posts with ${threshold}+ upvotes (${timeframe})</description>
    <lastBuildDate>${now}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

// --- Handlers ---

async function handleRss(url, env) {
  const params = parseParams(url, env);
  const posts = await getPosts(params);

  return new Response(buildRssXml(posts, params), {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

async function handleApi(url, env) {
  const params = parseParams(url, env);
  const posts = await getPosts(params);

  return new Response(
    JSON.stringify({
      count: posts.length,
      threshold: params.threshold,
      timeframe: params.timeframe,
      posts: posts.map((p) => ({
        id: p.id,
        title: p.title,
        score: p.score,
        subreddit: p.subreddit,
        permalink: p.permalink,
        url: p.url,
        num_comments: p.num_comments,
        created_utc: p.created_utc,
        author: p.author,
        thumbnail: p.thumbnail,
      })),
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    }
  );
}

function handleIndex() {
  return new Response(HTML_PAGE, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function corsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers });
}

// --- Inline HTML ---
const HTML_PAGE = `PLACEHOLDER`;
