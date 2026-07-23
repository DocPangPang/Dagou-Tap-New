import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(toolsDir, '..');
const main = fs.readFileSync(path.join(projectDir, 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(projectDir, 'index.html'), 'utf8');

assert.match(main, /window\.localStorage\.getItem/);
assert.match(main, /window\.localStorage\.setItem/);
assert.match(main, /设置已保存至此浏览器/);
assert.match(main, /正在从此浏览器读取设置/);
assert.match(main, /配置无法保存：浏览器存储不可用/);

for (const removedPattern of [
  /getCloudStorage/,
  /setCloudStorage/,
  /观看开发视频后解锁/,
  /unlock-confirm/,
  /\bis-locked\b/,
]) {
  assert.doesNotMatch(`${main}\n${html}`, removedPattern);
}

assert.match(
  html,
  /data-sfx="dingdong"/,
  'the dingdong sound option must remain available',
);
assert.match(
  html,
  /data-skin="emperor"/,
  'the emperor skin option must remain available',
);

console.log('Local storage and default-unlock flow verified.');
