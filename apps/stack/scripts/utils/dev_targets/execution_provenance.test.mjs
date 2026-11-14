// @happier-test-preparation source
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EXECUTION_PROVENANCE_SCHEMA_VERSION,
  appendExecutionProvenance,
} from './execution_provenance.mjs';

test('duration p99 uses successful completed records of the requested class without a fallback threshold', async t => {
  const { readExecutionDurationP99 } = await import('./execution_provenance.mjs');
  const root = await mkdtemp(join(tmpdir(), 'happier-duration-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readExecutionDurationP99(root, 'targeted-validation'), null);
  for (let durationMs = 1; durationMs <= 100; durationMs++) {
    await appendExecutionProvenance(root, { phase: 'completed', commandClass: 'targeted-validation', exitCode: 0, durationMs });
  }
  await appendExecutionProvenance(root, { phase: 'completed', commandClass: 'source-search', exitCode: 0, durationMs: 99999 });
  await appendExecutionProvenance(root, { phase: 'completed', commandClass: 'targeted-validation', exitCode: 1, durationMs: 99999 });
  await appendExecutionProvenance(root, { phase: 'completed', commandClass: 'targeted-validation', exitCode: 0, durationMs: 0 });
  assert.equal(await readExecutionDurationP99(root, 'targeted-validation'), 99);
  assert.equal(await readExecutionDurationP99(root, 'unknown-class'), null);
});

test('duration p99 remains available beyond the whole-file string boundary', async t => {
  const { readExecutionDurationP99 } = await import('./execution_provenance.mjs');
  const root = await mkdtemp(join(tmpdir(), 'happier-duration-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const durationMs of [70, 700, 7]) {
    await appendExecutionProvenance(root, { phase: 'completed', commandClass: 'targeted-validation', exitCode: 0, durationMs });
  }
  const path = join(root, 'dev-target-command-load-native', 'provenance.jsonl');
  const readWholeFile = fsPromises.readFile;
  // The real ~1.9m-record development history throws this platform error.
  // Substitute only that filesystem boundary; streamed reads still use real bytes.
  t.mock.method(fsPromises, 'readFile', async (input, ...args) => {
    if (input === path) throw new RangeError('Invalid string length');
    return await readWholeFile(input, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await readExecutionDurationP99(root, 'targeted-validation'), 700);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('execution provenance preserves existing observations past the former rotation cap without command arguments', async (t) => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'happier-execution-provenance-'));
  t.after(async () => rm(stackBaseDir, { recursive: true, force: true }));
  const path = join(stackBaseDir, 'dev-target-command-load-native', 'provenance.jsonl');
  await mkdir(join(stackBaseDir, 'dev-target-command-load-native'));
  const existing = JSON.stringify({ schemaVersion: 1, phase: 'completed', executionId: 'historical', target: 'x'.repeat(1024 * 1024) });
  await writeFile(path, `${existing}\n`);

  await appendExecutionProvenance(stackBaseDir, {
    phase: 'admitted',
    executionId: 'exec-12345678',
    timestamp: 123,
    target: 'linux',
    commandClass: 'targeted-validation',
    syncStatus: 'watching',
    syncSuccessfulCycles: 7,
    commandArgs: ['secret', '--token=value'],
  });

  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.ok(lines[0] === existing, 'the existing observation remains in the active log');
  const entry = JSON.parse(lines.at(-1));
  assert.deepEqual(entry, {
    schemaVersion: EXECUTION_PROVENANCE_SCHEMA_VERSION,
    phase: 'admitted',
    executionId: 'exec-12345678',
    timestamp: 123,
    target: 'linux',
    commandClass: 'targeted-validation',
    syncStatus: 'watching',
    syncSuccessfulCycles: 7,
  });
});
