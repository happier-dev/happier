import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EXECUTION_PROVENANCE_SCHEMA_VERSION,
  appendExecutionProvenance,
} from './execution_provenance.mjs';

test('execution provenance appends bounded schema-owned JSON lines without command arguments', async (t) => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'happier-execution-provenance-'));
  t.after(async () => rm(stackBaseDir, { recursive: true, force: true }));

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

  const entry = JSON.parse(await readFile(
    join(stackBaseDir, 'dev-target-command-load-native', 'provenance.jsonl'),
    'utf8',
  ));
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
