#!/usr/bin/env node

// Executes the actual interaction helpers extracted from main.js. This keeps
// geometry, queue timing, and jiao sustain-retuning checks outside production.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(toolsDir);
const mainSource = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');

function extractFunction(name) {
  const start = mainSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Cannot find function ${name} in main.js`);
  const bodyStart = mainSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainSource.length; index++) {
    if (mainSource[index] === '{') depth++;
    if (mainSource[index] === '}') {
      depth--;
      if (depth === 0) return mainSource.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed function ${name} in main.js`);
}

assert.equal(
  mainSource.includes('lastGlobalHit'),
  false,
  'the former same-beat drop gate must not remain',
);
assert.match(
  extractFunction('scheduler'),
  /scheduleQueuedInputs\(horizon\)/,
  'the audio lookahead scheduler must drain the input queue',
);
assert.match(
  extractFunction('tryActivate'),
  /zonesAlongSegment\(/,
  'pointer movement must traverse every crossed zone',
);
assert.doesNotMatch(
  extractFunction('retuneSustainVoice'),
  /createBufferSource|\.start\(/,
  'jiao sustain retuning must not create or restart an onset source',
);
assert.match(
  extractFunction('retuneHeldJiao'),
  /enqueueSustainRetune\(/,
  'crossed jiao sustain pitches must join the rhythmic input queue',
);
assert.match(
  extractFunction('playQueuedInput'),
  /entry\.kind === 'sustain-retune'[\s\S]*retuneSustainVoice\(/,
  'a queued sustain event must retune the existing voice',
);

const sandbox = {};
vm.runInNewContext(
  `
  let cols = 4;
  let rows = 3;
  let stageMetrics = { width: 400, height: 300, left: 0, top: 0 };
  function getStageMetrics() { return stageMetrics; }
  ${extractFunction('zoneIndex')}
  ${extractFunction('zonesAlongSegment')}
  let enqueuedZones = [];
  let swipeEntrySerial = 0;
  function retuneHeldJiao() { return false; }
  function releaseVoice() {}
  function enqueueActivation(zi) {
    enqueuedZones.push(zi);
    return { id: ++swipeEntrySerial };
  }
  ${extractFunction('enterZone')}
  ${extractFunction('tryActivate')}

  const S8 = 0.25;
  let nextInputTime = 0;
  let quantizedTime = 1;
  function quantize() { return quantizedTime; }
  ${extractFunction('allocateInputTime')}

  const RELEASE_SCHEDULE_LEAD = 0.006;
  let ctx = { currentTime: 2 };
  ${extractFunction('texturePositionAt')}
  ${extractFunction('textureRateAt')}
  ${extractFunction('isRetunableSustainVoice')}
  ${extractFunction('retuneSustainVoice')}
  ${extractFunction('nextTextureRelease')}

  globalThis.interactionApi = {
    setGrid(nextCols, nextRows, width, height) {
      cols = nextCols;
      rows = nextRows;
      stageMetrics = { width, height, left: 0, top: 0 };
    },
    segment: zonesAlongSegment,
    runSwipe(x0, y0, x1, y1) {
      enqueuedZones = [];
      let state = tryActivate(7, x0, y0, null);
      state = tryActivate(7, x1, y1, state);
      return { zones: [...enqueuedZones], state };
    },
    resetQueue(nextBeat, tail) {
      quantizedTime = nextBeat;
      nextInputTime = tail;
    },
    allocateInputTime,
    setNow(now) { ctx.currentTime = now; },
    texturePositionAt,
    textureRateAt,
    retuneSustainVoice,
    nextTextureRelease,
  };
  `,
  sandbox,
);

const api = sandbox.interactionApi;
const plain = value => Array.from(value);

const sustainQueueSandbox = {};
vm.runInNewContext(
  `
  const S8 = 0.25;
  let nextInputTime = 0;
  let inputSerial = 0;
  const inputQueue = [];
  const zones = [
    { sample: 'jiao', pitchTier: 0 },
    { sample: 'jiao', pitchTier: 1 },
  ];
  function quantize() { return 1; }
  function hideControlsUntilIdle() {}
  function flashZone() {}
  ${extractFunction('allocateInputTime')}
  ${extractFunction('enqueueSustainRetune')}
  ${extractFunction('isRetunableSustainVoice')}
  ${extractFunction('retuneHeldJiao')}
  const voice = {
    name: 'jiao',
    mode: 'sustain',
    held: true,
    released: false,
    stopped: false,
    cleaned: false,
    rate: 1,
  };
  const state = { zone: 0, voice, pendingEntryId: null };
  const accepted = retuneHeldJiao(7, state, 1);
  globalThis.sustainQueueResult = {
    accepted,
    zone: state.zone,
    voiceRate: voice.rate,
    entry: { ...inputQueue[0], voice: inputQueue[0].voice === voice },
  };
  `,
  sustainQueueSandbox,
);

assert.deepEqual(
  JSON.parse(JSON.stringify(sustainQueueSandbox.sustainQueueResult)),
  {
    accepted: true,
    zone: 1,
    voiceRate: 1,
    entry: {
      id: 1,
      kind: 'sustain-retune',
      pointerId: 7,
      zone: 1,
      sample: 'jiao',
      pitchTier: 1,
      voice: true,
      when: 1,
    },
  },
  'a held jiao crossing must enqueue a retune without changing pitch early',
);

api.setGrid(4, 3, 400, 300);
assert.deepEqual(
  plain(api.runSwipe(10, 50, 390, 50).zones),
  [0, 1, 2, 3],
  'the pointer state machine must enqueue every crossed zone in order',
);
assert.deepEqual(
  plain(api.segment(10, 50, 390, 50)),
  [0, 1, 2, 3],
  'fast horizontal movement must include both middle zones',
);
assert.deepEqual(
  plain(api.segment(390, 50, 10, 50)),
  [3, 2, 1, 0],
  'reverse movement must preserve reverse entry order',
);
assert.deepEqual(
  plain(api.segment(50, 10, 50, 290)),
  [0, 4, 8],
  'fast vertical movement must include the middle row',
);

api.setGrid(3, 4, 300, 400);
assert.deepEqual(
  plain(api.segment(250, 10, 250, 390)),
  [2, 5, 8, 11],
  'portrait movement must include every crossed pitch row',
);

api.resetQueue(1, 0);
assert.deepEqual(
  [api.allocateInputTime(), api.allocateInputTime(), api.allocateInputTime()],
  [1, 1.25, 1.5],
  'queued hits must occupy consecutive eighth-note slots',
);
api.resetQueue(2, 0.5);
assert.equal(
  api.allocateInputTime(),
  2,
  'after an idle gap the queue must resume on the next quantized beat',
);

const rateEvents = [];
const voice = {
  name: 'jiao',
  mode: 'sustain',
  held: true,
  released: false,
  stopped: false,
  cleaned: false,
  handoffAt: 1,
  sustain: {
    attackOffset: 0.25,
    buffer: { duration: 10 },
    releasePoints: [{ textureOffset: 3, sourceOffset: 0.4 }],
  },
  rateTimeline: [{ time: 1, rate: 2 }],
  rate: 2,
  loopSource: {
    playbackRate: {
      cancelScheduledValues: time => rateEvents.push(['cancel', time]),
      setValueAtTime: (rate, time) => rateEvents.push(['set', rate, time]),
    },
  },
};

api.setNow(2);
assert.equal(api.retuneSustainVoice(voice, 0.75), true);
assert.equal(voice.rate, 0.75);
assert.deepEqual(rateEvents, [['cancel', 2], ['set', 0.75, 2]]);
assert.equal(api.texturePositionAt(voice, 2), 2.25);
assert.equal(api.textureRateAt(voice, 2), 0.75);

assert.deepEqual(
  { ...api.nextTextureRelease(voice, 2) },
  { boundary: 3, sourceOffset: 0.4 },
  'release scheduling must continue from the retuned texture position',
);

voice.rateTimeline = [{ time: 1, rate: 2 }];
voice.rate = 2;
api.setNow(0.95);
assert.equal(api.retuneSustainVoice(voice, 0.5), true);
assert.equal(
  api.texturePositionAt(voice, 0.95),
  0.25,
  'an early sustain claim must not advance texture before handoff',
);

voice.rateTimeline = [{ time: 1, rate: 2 }];
voice.rate = 2;
rateEvents.length = 0;
api.setNow(2);
assert.equal(api.retuneSustainVoice(voice, 0.5, 2.1), true);
assert.deepEqual(rateEvents, [['cancel', 2.1], ['set', 0.5, 2.1]]);
assert.equal(
  api.textureRateAt(voice, 2.05),
  2,
  'lookahead scheduling must not change a sustain pitch before its queue slot',
);
assert.equal(api.textureRateAt(voice, 2.1), 0.5);

console.log('Interaction queue verification passed:');
console.log('- landscape and portrait fast swipes include every crossed zone');
console.log('- queued hits occupy consecutive eighth-note slots');
console.log('- held jiao retunes are queued in place and keep release-frame tracking');
