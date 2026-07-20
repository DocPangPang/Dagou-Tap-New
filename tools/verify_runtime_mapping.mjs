#!/usr/bin/env node

// Executes the actual pitch-mapping declarations/functions extracted from
// main.js, then compares every fixed sample/tier rate with the analyzer report.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(toolsDir);
const mainPath = path.join(rootDir, 'main.js');
const reportPath = path.join(toolsDir, 'tmp', 'pitch-analysis-report.json');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

function extractDeclaration(pattern, label) {
  const match = mainSource.match(pattern);
  if (!match) throw new Error(`Cannot find ${label} in main.js`);
  return match[0];
}

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

const declarations = [
  extractDeclaration(
    /const BARK_SOURCE_MIDI = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'BARK_SOURCE_MIDI',
  ),
  extractDeclaration(
    /const BARK_TARGET_MIDI = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'BARK_TARGET_MIDI',
  ),
].join('\n');

const runtimeRateFunction = extractFunction('barkPlaybackRate');
if (!/^function barkPlaybackRate\(sample, pitchTier\)/.test(runtimeRateFunction)) {
  throw new Error('barkPlaybackRate must depend only on sample and fixed pitch tier');
}

const sandbox = {};
vm.runInNewContext(
  `
  let cols = 4;
  let rows = 3;
  let zones = [];
  let stageMetrics = { width: 1200, height: 800 };
  function getStageMetrics() { return stageMetrics; }
  ${declarations}
  ${runtimeRateFunction}
  ${extractFunction('buildGrid')}
  globalThis.mappingApi = {
    barkPlaybackRate,
    sourceMidi: BARK_SOURCE_MIDI,
    targetMidi: BARK_TARGET_MIDI,
    buildLayout(width, height) {
      stageMetrics = { width, height };
      buildGrid();
      return {
        cols,
        rows,
        zones: zones.map(zone => ({ ...zone })),
      };
    },
  };
  `,
  sandbox,
);

const { mappingApi } = sandbox;
let checked = 0;
for (const mapping of report.mappings) {
  const actualRate = mappingApi.barkPlaybackRate(
    mapping.sample,
    mapping.tier_index,
  );
  if (Math.abs(actualRate - mapping.playback_rate) > 1e-10) {
    throw new Error(
      `${mapping.sample}/${mapping.tier}: ` +
      `expected ${mapping.playback_rate}, got ${actualRate}`,
    );
  }
  // Repeated calls and irrelevant extra arguments must never alter a key's pitch.
  const repeatedRate = mappingApi.barkPlaybackRate(
    mapping.sample,
    mapping.tier_index,
    999999,
  );
  if (repeatedRate !== actualRate) {
    throw new Error(`${mapping.sample}/${mapping.tier}: rate is not stable`);
  }
  checked++;
}

const minorPentatonicPitchClasses = new Set([9, 0, 2, 4, 7]);
for (const sample of ['da', 'gou', 'jiao']) {
  const rows = report.mappings
    .filter(item => item.sample === sample)
    .sort((left, right) => left.tier_index - right.tier_index);
  if (rows.length !== 4) {
    throw new Error(`${sample}: expected four fixed pitch keys`);
  }
  for (const row of rows) {
    if (!minorPentatonicPitchClasses.has(row.target_midi % 12)) {
      throw new Error(`${sample}/${row.tier}: target is outside A minor pentatonic`);
    }
    if (mappingApi.targetMidi[sample][row.tier_index] !== row.target_midi) {
      throw new Error(`${sample}/${row.tier}: runtime target MIDI mismatch`);
    }
  }

  const sourceMidi = mappingApi.sourceMidi[sample];
  const candidates = [];
  for (let midi = 24; midi <= 108; midi++) {
    if (minorPentatonicPitchClasses.has(midi % 12)) candidates.push(midi);
  }
  const nearest = candidates.reduce((best, midi) =>
    Math.abs(midi - sourceMidi) < Math.abs(best - sourceMidi) ? midi : best
  );
  if (rows[2].target_midi !== nearest) {
    throw new Error(
      `${sample}: tier 3 is ${rows[2].target_midi}, nearest minor note is ${nearest}`,
    );
  }
}

const landscape = mappingApi.buildLayout(1200, 800);
if (landscape.cols !== 4 || landscape.rows !== 3) {
  throw new Error('Landscape grid is not 4 columns × 3 rows');
}
for (let row = 0; row < 3; row++) {
  const rowZones = landscape.zones.slice(row * 4, row * 4 + 4);
  if (rowZones.some((zone, column) => zone.pitchTier !== column)) {
    throw new Error(`Landscape row ${row}: pitch tiers do not run 0,1,2,3`);
  }
  if (rowZones[2].pitchTier !== 2) {
    throw new Error(`Landscape row ${row}: nearest-minor key is not in column 3`);
  }
}

const portrait = mappingApi.buildLayout(800, 1200);
if (portrait.cols !== 3 || portrait.rows !== 4) {
  throw new Error('Portrait grid is not 3 columns × 4 rows');
}
for (let row = 0; row < 4; row++) {
  const rowZones = portrait.zones.slice(row * 3, row * 3 + 3);
  if (rowZones.some(zone => zone.pitchTier !== row)) {
    throw new Error(`Portrait row ${row}: pitch tier does not match row`);
  }
}
if (portrait.zones.slice(6, 9).some(zone => zone.pitchTier !== 2)) {
  throw new Error('Portrait nearest-minor keys are not in row 3');
}

console.log(`Runtime fixed pitch mapping verified: ${checked} sample/tier keys`);
console.log('Repeated-key pitch stability verified: no chord/time-dependent switching');
console.log('Layout verified: column 3 / row 3 use the nearest minor-pentatonic note');
console.log(
  `Worst remeasured transposed error: ` +
  `${report.worst_transposed_target_error_cents.toFixed(3)} cents`,
);
