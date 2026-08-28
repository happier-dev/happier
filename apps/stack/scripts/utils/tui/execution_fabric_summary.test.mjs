import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createExecutionFabricSummaryReader,
  formatExecutionFabricSummaryLines,
} from './execution_fabric_summary.mjs';

test('execution fabric summary combines cached target load, live reservations, and retained delegation history', async (t) => {
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
  await writeFile(join(cacheDir, 'provenance.jsonl'), [
    JSON.stringify({ schemaVersion: 1, phase: 'admitted', timestamp: now - 1_000, target: 'linux', normalizedLoad: 0.5 }),
    JSON.stringify({ schemaVersion: 1, phase: 'admitted', timestamp: now - 2_000, target: 'mac-host' }),
    JSON.stringify({ schemaVersion: 1, phase: 'completed', timestamp: now - 500, target: 'linux', durationMs: 100 }),
  ].join('\n') + '\n');

  const reader = createExecutionFabricSummaryReader({
    stackBaseDir,
    targetNames: ['linux', 'mac-host'],
    historyRefreshMs: 0,
    sampleLocal: () => ({
      name: 'primary', platform: 'linux', capacity: 14, load: 7,
      memAvailableKiB: 35_000_000, memTotalKiB: 70_000_000,
      cpuPsiAvg10: 10, memoryPsiAvg10: 1,
    }),
  });
  const summary = await reader.read({ now });

  assert.equal(summary.live.find((target) => target.name === 'linux').activeReservations, 1);
  assert.equal(summary.live.find((target) => target.name === 'linux').cacheAgeSeconds, 4);
  assert.deepEqual(summary.history.retainedByTarget, [
    { target: 'linux', count: 1, share: 0.5, averageNormalizedLoad: 0.5 },
    { target: 'mac-host', count: 1, share: 0.5, averageNormalizedLoad: null },
  ]);
  assert.equal(summary.history.recentAdmissions, 2);

  const lines = formatExecutionFabricSummaryLines(summary);
  assert.ok(lines.some((line) => line.includes('primary') && line.includes('load 7.0/14')));
  assert.ok(lines.some((line) => line.includes('linux') && line.includes('jobs 1/8')));
  assert.ok(lines.some((line) => line.includes('linux') && line.includes('mem 75% free')));
  assert.ok(lines.some((line) => line.includes('linux') && line.includes('50%')));
  assert.ok(lines.some((line) => line.includes('retained dispatches: 2')));
});
