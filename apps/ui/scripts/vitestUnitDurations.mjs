#!/usr/bin/env node
// Measured per-file seconds for UI unit tests. Gate parts record one JSON line
// per file (vitestFileDurationReporter.mjs); this CLI folds those records into
// the committed weights that runVitestShards balances its shards with.
// Weights influence scheduling only; they never select or exclude a file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const VITEST_UNIT_DURATIONS_PATH = path.join(packageRoot, 'vitest.unit-durations.json');

/** Path key shared by the recorder and the partitioner: relative to the run's cwd, POSIX separators. */
export function vitestDurationKey(file, cwd = process.cwd()) {
  return path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/');
}

/** @returns {Map<string, number>} empty when no timings have been recorded yet */
export function loadVitestUnitDurations(file = process.env.HAPPIER_UI_VITEST_DURATIONS_FILE || VITEST_UNIT_DURATIONS_PATH) {
  if (!fs.existsSync(file)) return new Map();
  const { seconds } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(Object.entries(seconds ?? {}).filter(([, value]) => Number.isFinite(value) && value > 0));
}

export function mergeVitestDurationRecords(recordFiles) {
  const seconds = new Map();
  for (const recordFile of recordFiles) {
    for (const line of fs.readFileSync(recordFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const { file, seconds: value } = JSON.parse(line);
      if (typeof file === 'string' && Number.isFinite(value)) seconds.set(file, Math.max(seconds.get(file) ?? 0, value));
    }
  }
  return { version: 1, seconds: Object.fromEntries([...seconds].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, value]) => [file, Math.round(value * 100) / 100])) };
}

function main(argv) {
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : VITEST_UNIT_DURATIONS_PATH;
  const records = argv.filter((arg, index) => arg !== '--output' && index !== outputIndex + 1);
  if (records.length === 0) throw new Error('usage: vitestUnitDurations.mjs [--output file] <records.jsonl>...');
  const merged = mergeVitestDurationRecords(records);
  fs.writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`);
  process.stdout.write(`${Object.keys(merged.seconds).length} files -> ${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
