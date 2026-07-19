'use strict';
/* ============================================================
 * 大狗Tap —— 仿 Mikutap：点击屏幕，狗叫会卡在节拍上
 * 背景音轨：Web Audio 实时合成的劲爆鼓组 + 洗脑和弦循环
 * ============================================================ */

/* ---------- 节奏常量 ---------- */
const BPM = 128;          // 激情劲爆的速度
const SPB = 60 / BPM;     // 每拍秒数
const S16 = SPB / 4;      // 16 分音符（调度步长）
const S8  = SPB / 2;      // 8 分音符（点击量化的最小节奏点）

/* ---------- 全局状态 ---------- */
let ctx = null;           // AudioContext
let master = null;        // 总线增益
let noiseBuf = null;      // 白噪声（鼓组用）
let started = false;

let startTime = 0;        // 第 0 步对应的 audio 时间
let nextNoteTime = 0;     // 调度器下一个音符时间
let stepCount = 0;        // 16 分步进计数（0..63 循环 = 4 小节）

const buffers = {};       // 解码后的狗叫样本

let cols = 4, rows = 3;   // 分区网格
let zones = [];           // 每个分区的音色配置
let cells = [];           // 分区 DOM

let mouthTimer = 0;       // 闭嘴定时器
const lastHitAt = {};     // 防止同一分区在同一节奏点重复触发

/* ---------- DOM ---------- */
const stage    = document.getElementById('stage');
const gridEl   = document.getElementById('grid');
const fxEl     = document.getElementById('fx');
const glowEl   = document.getElementById('glow');
const dogEl    = document.getElementById('dog');
const dogInner = document.getElementById('dog-inner');
const overlay  = document.getElementById('overlay');
const subEl    = overlay.querySelector('.sub');

/* ---------- 和弦走向：C - G - Am - F（简单洗脑） ---------- */
const CHORDS = [
  { bass: 65.41, notes: [261.63, 329.63, 392.00, 523.25] }, // C
  { bass: 49.00, notes: [196.00, 246.94, 293.66, 392.00] }, // G
  { bass: 55.00, notes: [220.00, 261.63, 329.63, 440.00] }, // Am
  { bass: 43.65, notes: [174.61, 220.00, 261.63, 349.23] }, // F
];
const HAT_VEL = [0.34, 0.16, 0.42, 0.16];

/* ============================================================
 * 音频初始化
 * ==========================================================*/
function initAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  master = ctx.createGain();
  master.gain.value = 0.85;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 24;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  master.connect(comp);
  comp.connect(ctx.destination);

  // 1 秒白噪声
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadSamples() {
  for (const n of ['da', 'gou', 'jiao']) {
    buffers[n] = await ctx.decodeAudioData(b64ToArrayBuffer(AUDIO_B64[n]));
  }
}

/* ============================================================
 * 鼓组 / 贝斯 / 和弦 合成音色
 * ==========================================================*/
function kick(t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
  g.gain.setValueAtTime(0.95, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + 0.26);
}

function snare(t, vol = 0.5) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + 0.18);
  // 军鼓腔体
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(240, t);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(vol * 0.5, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(g2); g2.connect(master);
  o.start(t); o.stop(t + 0.1);
}

function hat(t, vol, decay) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + decay + 0.02);
}

function crash(t) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 5000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + 1.3);
}

function stab(t, freqs) {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(2600, t);
  f.frequency.exponentialRampToValueAtTime(600, t + 0.28);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  f.connect(g); g.connect(master);
  for (const fr of freqs) {
    for (const det of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fr;
      o.detune.value = det;
      o.connect(f);
      o.start(t); o.stop(t + 0.3);
    }
  }
}

function bass(t, fr, vol) {
  const o = ctx.createOscillator(); o.type = 'square';
  o.frequency.value = fr * 2;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + S8 * 0.9);
  o.connect(f); f.connect(g); g.connect(master);
  o.start(t); o.stop(t + S8);
}

/* ============================================================
 * 循环音轨调度器（lookahead 模式）
 * ==========================================================*/
function scheduleStep(s, t) {
  const bar = (s / 16) | 0;   // 第几小节 0..3
  const pos = s % 16;         // 小节内 16 分位置
  const ch = CHORDS[bar];

  if (bar === 0 && pos === 0) crash(t);            // 循环开头镲片
  if (pos % 4 === 0) kick(t);                      // 四踩地板鼓
  if (pos === 4 || pos === 12) snare(t);           // 2、4 拍军鼓
  if (bar === 3 && pos === 14) snare(t, 0.3);      // 末尾加花
  hat(t, HAT_VEL[pos % 4], pos === 14 ? 0.12 : 0.04);
  if (pos % 4 === 2) stab(t, ch.notes);            // 反拍和弦刺
  if (pos % 2 === 0) bass(t, ch.bass, pos % 4 === 0 ? 0.4 : 0.26);
}

function scheduler() {
  while (nextNoteTime < ctx.currentTime + 0.12) {
    scheduleStep(stepCount, nextNoteTime);
    nextNoteTime += S16;
    stepCount = (stepCount + 1) % 64;
  }
}

/* ============================================================
 * 点击量化：下一个 8 分节奏点
 * ==========================================================*/
function quantize(unit) {
  const now = ctx.currentTime;
  const k = Math.ceil((now + 0.02 - startTime) / unit);
  let t = startTime + k * unit;
  if (t < now) t += unit;
  return t;
}

function playSample(name, rate, t) {
  const src = ctx.createBufferSource();
  src.buffer = buffers[name];
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = 1.0;
  src.connect(g); g.connect(master);
  src.start(t);
}

/* ============================================================
 * 分区网格
 * ==========================================================*/
function buildGrid() {
  const landscape = innerWidth >= innerHeight;
  cols = landscape ? 4 : 3;
  rows = landscape ? 3 : 4;
  // 横排 = 音节：大 / 狗 / 叫 /（叫！低音收尾）
  const colMap = landscape
    ? [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }, { n: 'jiao', s: '叫！', r: 0.8 }]
    : [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }];
  // 纵排 = 音高（上高下低）
  const rowRates = landscape ? [1.33, 1.12, 1.0] : [1.5, 1.25, 1.0, 0.89];

  zones = [];
  gridEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  gridEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const m = colMap[c];
      zones.push({ sample: m.n, syllable: m.s, rate: rowRates[r] * (m.r || 1) });
      const cell = document.createElement('div');
      cell.className = 'cell';
      gridEl.appendChild(cell);
    }
  }
  cells = Array.from(gridEl.children);
}

function zoneIndex(x, y) {
  const c = Math.min(cols - 1, Math.max(0, Math.floor(x / innerWidth * cols)));
  const r = Math.min(rows - 1, Math.max(0, Math.floor(y / innerHeight * rows)));
  return r * cols + c;
}

/* ============================================================
 * 点击特效
 * ==========================================================*/
const VMIN = () => Math.min(innerWidth, innerHeight) / 100;

function spawnRipple(x, y, big = false) {
  const size = (big ? 52 : 34) * VMIN();
  const el = document.createElement('div');
  el.className = 'ripple';
  el.style.width = el.style.height = size + 'px';
  el.style.left = (x - size / 2) + 'px';
  el.style.top = (y - size / 2) + 'px';
  fxEl.appendChild(el);
  el.animate([
    { transform: 'scale(.12)', opacity: 0.95 },
    { transform: 'scale(1)', opacity: 0 }
  ], { duration: big ? 750 : 600, easing: 'cubic-bezier(.16,.84,.44,1)' })
    .onfinish = () => el.remove();
}

function spawnDots(x, y) {
  for (let i = 0; i < 6; i++) {
    const el = document.createElement('div');
    el.className = 'dot';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    fxEl.appendChild(el);
    const ang = Math.random() * Math.PI * 2;
    const dist = (5 + Math.random() * 9) * VMIN();
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist - 2 * VMIN();
    el.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(0)`, opacity: 0 }
    ], { duration: 450 + Math.random() * 300, easing: 'cubic-bezier(.2,.7,.3,1)' })
      .onfinish = () => el.remove();
  }
}

function spawnSyllable(x, y, text) {
  const el = document.createElement('div');
  el.className = 'float-text';
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  fxEl.appendChild(el);
  el.animate([
    { transform: 'translate(-50%,-50%) scale(.5) rotate(0deg)', opacity: 1 },
    { transform: `translate(-50%,-160%) scale(1.15) rotate(${(Math.random() * 16 - 8).toFixed(1)}deg)`, opacity: 0 }
  ], { duration: 800, easing: 'cubic-bezier(.2,.8,.3,1)' })
    .onfinish = () => el.remove();
}

function flashCell(i) {
  const cell = cells[i];
  if (!cell) return;
  cell.animate([
    { backgroundColor: 'rgba(245,201,107,.45)' },
    { backgroundColor: 'rgba(245,201,107,0)' }
  ], { duration: 450, easing: 'ease-out' });
}

/* ---------- 张嘴 / 闭嘴（Q弹） ---------- */
function openMouth(holdMs) {
  dogInner.classList.add('bark');
  clearTimeout(mouthTimer);
  mouthTimer = setTimeout(() => dogInner.classList.remove('bark'), holdMs);
}

/* ============================================================
 * 点击主流程
 * ==========================================================*/
function onTap(x, y) {
  const zi = zoneIndex(x, y);
  const z = zones[zi];
  const when = quantize(S8);                 // 量化到下一个 8 分节奏点

  if (lastHitAt[zi] !== when) {              // 同一节奏点不重复触发
    lastHitAt[zi] = when;
    playSample(z.sample, z.rate, when);
  }

  const waitMs = Math.max(0, (when - ctx.currentTime) * 1000);

  // 立即反馈：张嘴(Q弹) + 涟漪 + 粒子 + 音节字
  openMouth(waitMs + 280);
  flashCell(zi);
  spawnRipple(x, y);
  spawnDots(x, y);
  spawnSyllable(x, y, z.syllable);

  // 节奏点到达时，从大狗身上炸开一圈金环（看得见的"卡在拍上"）
  setTimeout(() => spawnRipple(innerWidth / 2, innerHeight / 2, true), waitMs);
}

/* ============================================================
 * 节拍动画循环：大狗随节奏起伏 + 背景呼吸光
 * ==========================================================*/
function tick() {
  requestAnimationFrame(tick);
  if (!started || !ctx) return;
  const t = ctx.currentTime;
  const phase = (((t - startTime) / SPB) % 1 + 1) % 1;  // 当前拍内相位 0..1
  const p = Math.pow(1 - phase, 2.4);                    // 拍头强、迅速衰减
  dogEl.style.transform =
    `translateY(${(-10 * p).toFixed(2)}px) scale(${(1 + 0.05 * p).toFixed(4)})`;
  glowEl.style.opacity = (0.1 + p * 0.45).toFixed(3);
}

/* ============================================================
 * 启动
 * ==========================================================*/
async function start() {
  if (started) return;
  started = true;
  subEl.textContent = '狗 叫 加 载 中 …';

  initAudio();
  if (ctx.state === 'suspended') await ctx.resume();
  await loadSamples();

  startTime = ctx.currentTime + 0.12;
  nextNoteTime = startTime;
  stepCount = 0;
  setInterval(scheduler, 25);

  overlay.classList.add('hide');
}

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!started || !buffers.da) { start(); return; }
  onTap(e.clientX, e.clientY);
}, { passive: false });

window.addEventListener('contextmenu', (e) => e.preventDefault());

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildGrid, 150);
});

buildGrid();
requestAnimationFrame(tick);
