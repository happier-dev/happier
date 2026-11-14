import assert from 'node:assert/strict';
import fsPromises, { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createExecutionFabricSummaryReader,
  formatExecutionFabricSummaryLines,
} from './execution_fabric_summary.mjs';

test('execution fabric summary combines cached target load, live reservations, and the run-time duration projection', async (t) => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'happier-fabric-summary-'));
  t.after(async () => rm(stackBaseDir, { recursive: true, force: true }));
  const cacheDir = join(stackBaseDir, 'dev-target-command-load-native');
  await mkdir(cacheDir, { recursive: true });
  const now = 1_800_000_000_000;

  await writeFile(join(cacheDir, 'linux.telemetry'), [
    8, 4, 0.75, 10_000_000, 30, 3, 0, 0,
    1_000, 8_000, 2.5, 1.25, 0.5, 0, 0, 'linux',
  ].join(' '));
  await writeFile(join(cacheDir, 'linux.cache'), `${Math.floor(now / 1000) - 4} 1 0.5 8\n`);
  await writeFile(join(cacheDir, `linux.active.${process.pid}`), `${process.pid}\nfull-validation\nexec-live\n`);
  const reader = createExecutionFabricSummaryReader({
    stackBaseDir,
    targetNames: ['linux', 'mac-host'],
    readDurations: async (root) => {
      assert.equal(root, stackBaseDir);
      return [{ commandClass: 'targeted-validation', p99DurationMs: 70_000, samples: 3 }];
    },
    sampleLocal: () => ({
      name: 'primary', platform: 'linux', capacity: 14, load: 7,
      memAvailableKiB: 35_000_000, memTotalKiB: 70_000_000,
      cpuPsiAvg10: 10, memoryPsiAvg10: 1,
    }),
  });
  const summary = await reader.read({ now });

  assert.equal(summary.live.find((target) => target.name === 'linux').activeReservations, 1);
  assert.equal(summary.live.find((target) => target.name === 'linux').cacheAgeSeconds, 4);
  assert.deepEqual(summary.durations, [{ commandClass: 'targeted-validation', p99DurationMs: 70_000, samples: 3 }]);

  const lines = formatExecutionFabricSummaryLines(summary);
  assert.ok(lines.some((line) => line.includes('primary') && line.includes('load 7.0/14')));
  assert.ok(lines.some((line) => line.includes('linux') && line.includes('jobs 1/8')));
  assert.ok(lines.some((line) => line.includes('linux') && line.includes('mem 75% free')));
  assert.ok(lines.some((line) => line.includes('targeted-validation') && line.includes('70s') && line.includes('n=3')));
});

test('fabric never opens audit files, even when they cannot be read as strings', async t => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'happier-fabric-cost-'));
  t.after(() => rm(stackBaseDir, { recursive: true, force: true }));
  const cacheDir = join(stackBaseDir, 'dev-target-command-load-native');
  await mkdir(join(cacheDir, 'provenance.jsonl'), { recursive: true });
  await mkdir(join(cacheDir, 'provenance.jsonl.previous'));
  const reader = createExecutionFabricSummaryReader({ stackBaseDir, targetNames: [], sampleLocal: () => ({ name: 'primary' }) });
  const summary = await reader.read();
  assert.deepEqual(summary.durations, []);
});

test('recent dispatches read only the window tail first, then only appended bytes', async t => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'happier-fabric-tail-'));
  t.after(() => rm(stackBaseDir, { recursive: true, force: true }));
  const cacheDir = join(stackBaseDir, 'dev-target-command-load-native');
  await mkdir(cacheDir, { recursive: true });
  const path = join(cacheDir, 'provenance.jsonl');
  const now = 1_800_000_000_000;
  const line = (timestamp, target) => JSON.stringify({ schemaVersion: 1, phase: 'admitted', timestamp, target,
    commandClass: 'targeted-validation', memAvailableKiB: 123_456_789 }) + '\n';
  // ~8 MiB of history older than the 60 min window, then 100 recent dispatches.
  const old = line(now - 2 * 60 * 60 * 1000, 'nl1');
  await writeFile(path, old.repeat(Math.ceil(8 * 1024 * 1024 / old.length)));
  const recent = Array.from({ length: 100 }, (_, index) => line(now - 30 * 60 * 1000 + index, index % 4 ? 'nl3' : 'nl1')).join('');
  await appendFile(path, recent);

  let bytes = 0;
  const realOpen = fsPromises.open;
  const realReadFile = fsPromises.readFile;
  // Count bytes at the filesystem boundary; parsing stays real.
  t.mock.method(fsPromises, 'open', async (...args) => {
    const handle = await realOpen(...args);
    if (String(args[0]) !== path) return handle;
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => { const result = await read(...readArgs); bytes += result.bytesRead; return result; };
    return handle;
  });
  t.mock.method(fsPromises, 'readFile', async (input, ...args) => {
    const result = await realReadFile(input, ...args);
    if (String(input) === path) bytes += Buffer.byteLength(result);
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const reader = createExecutionFabricSummaryReader({ stackBaseDir, targetNames: [], historyRefreshMs: 0,
    sampleLocal: () => ({ name: 'primary' }), readDurations: async () => [] });
  const first = await reader.read({ now });
  assert.equal(first.history.recentAdmissions, 100);
  assert.deepEqual(first.history.recentByTarget.map(({ target, count }) => [target, count]), [['nl1', 25], ['nl3', 75]]);
  assert.ok(bytes <= 2 * 1024 * 1024, `first read is bounded by the window tail, read ${bytes} bytes`);

  const appended = line(now + 1_000, 'mac-host');
  await appendFile(path, appended);
  bytes = 0;
  const second = await reader.read({ now: now + 2_000 });
  assert.equal(bytes, Buffer.byteLength(appended));
  assert.equal(second.history.recentAdmissions, 101);
});
