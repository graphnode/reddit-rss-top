#!/usr/bin/env node
// Inlines src/index.html into src/worker.js as the HTML_PAGE constant
const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, 'src', 'worker.js');
const htmlPath = path.join(__dirname, 'src', 'index.html');

const html = fs.readFileSync(htmlPath, 'utf-8');
let worker = fs.readFileSync(workerPath, 'utf-8');

// Escape backticks and ${} in the HTML for template literal embedding
const escaped = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

worker = worker.replace(
  /const HTML_PAGE = `PLACEHOLDER`;/,
  'const HTML_PAGE = `' + escaped + '`;'
);

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);

fs.writeFileSync(path.join(distDir, 'worker.js'), worker);
console.log('Build complete: dist/worker.js');
