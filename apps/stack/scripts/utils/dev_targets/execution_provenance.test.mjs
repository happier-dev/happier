import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EXECUTION_PROVENANCE_SCHEMA_VERSION,
  appendExecutionProvenance,
} from './execution_provenance.mjs';

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
