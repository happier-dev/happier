import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  completeStackRestartStopBeforeSuccessor,
  createOuterStackRuntimeStartPublication,
  hasRecordedRuntimePortsForRestart,
  shouldReuseRuntimePortsOnRestart,
} from './stack/run_script_with_stack_env.mjs';

test('restart stop rethrows an initial failure when no persisted cleanup can be continued', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'happier-stack-restart-stop-'));
  t.after(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });
  const invalidBaseDir = join(fixtureDir, 'not-a-directory');
  await writeFile(invalidBaseDir, 'file blocks cleanup state writes', 'utf8');

  await assert.rejects(
    () => completeStackRestartStopBeforeSuccessor({
      rootDir: fixtureDir,
      stackName: 'restart-stop-error',
      baseDir: invalidBaseDir,
      env: {},
      json: true,
      noDocker: true,
      aggressive: false,
      sweepOwned: true,
      preserveDaemon: true,
    }),
    { code: 'EEXIST' },
  );
});

test('outer start publication records requested UI truth before the child runner starts', () => {
  const base = {
    stackName: 'runtime-ui',
    scriptPath: 'run.mjs',
    ephemeral: false,
    ownerPid: 4242,
    ports: { server: 4101 },
    runtimeSnapshotId: 'snapshot-1',
  };

  assert.equal(createOuterStackRuntimeStartPublication({ ...base, args: ['--no-ui'], env: {} }).serveUi, false);
  assert.equal(
    createOuterStackRuntimeStartPublication({ ...base, args: [], env: { HAPPIER_STACK_SERVE_UI: '0' } }).serveUi,
    false,
  );
  assert.equal(createOuterStackRuntimeStartPublication({ ...base, args: [], env: {} }).serveUi, true);
});

test('hasRecordedRuntimePortsForRestart requires a positive server port', () => {
  assert.equal(hasRecordedRuntimePortsForRestart(null), false);
  assert.equal(hasRecordedRuntimePortsForRestart({ ports: {} }), false);
  assert.equal(hasRecordedRuntimePortsForRestart({ ports: { server: '0' } }), false);
  assert.equal(hasRecordedRuntimePortsForRestart({ ports: { server: '3010' } }), true);
});

test('shouldReuseRuntimePortsOnRestart reuses runtime ports on stale-owner restarts', () => {
  const runtimeState = { ownerPid: 999_999_999, ports: { server: 3010 } };
  assert.equal(
    shouldReuseRuntimePortsOnRestart({ wantsRestart: true, runtimeState, wasRunning: false }),
    true
  );
});

test('shouldReuseRuntimePortsOnRestart stays false when restart was not requested', () => {
  const runtimeState = { ports: { server: 3010 } };
  assert.equal(
    shouldReuseRuntimePortsOnRestart({ wantsRestart: false, runtimeState, wasRunning: true }),
    false
  );
});

test('stopped-stack restart cannot authorize the outer destructive stop path', async () => {
  assert.equal(
    shouldReuseRuntimePortsOnRestart({ wantsRestart: true, runtimeState: null, wasRunning: false }),
    false,
  );

  const source = await readFile(new URL('./stack/run_script_with_stack_env.mjs', import.meta.url), 'utf8');
  const decisionBoundary = source.indexOf('const isTrueRestart =');
  const stopBoundary = source.indexOf('await completeStackRestartStopBeforeSuccessor({', decisionBoundary);
  const stopGuardBoundary = source.lastIndexOf('if (isTrueRestart)', stopBoundary);
  assert.ok(
    decisionBoundary >= 0 && stopGuardBoundary > decisionBoundary && stopBoundary > stopGuardBoundary,
    'the canonical true-restart decision must guard the destructive outer stop',
  );
  assert.equal(
    (source.match(/await completeStackRestartStopBeforeSuccessor\(/g) ?? []).length,
    2,
    'both restart cleanup paths must complete the canonical stop before successor admission',
  );
  const helperBoundary = source.indexOf('export async function completeStackRestartStopBeforeSuccessor');
  const helperStopBoundary = source.indexOf('await stopStackWithEnv(', helperBoundary);
  const helperContinuationBoundary = source.indexOf('return await completeInterruptedStackStopBeforeStart(', helperBoundary);
  assert.ok(
    helperBoundary >= 0 && helperStopBoundary > helperBoundary && helperContinuationBoundary > helperStopBoundary,
    'restart cleanup must continue any persisted incomplete stop after the first stop attempt',
  );
  assert.doesNotMatch(
    source,
    /listListenPids\([^)]*\)[\s\S]{0,1200}killProcessGroupOwnedByStack\(/,
    'restart wrappers must never select a termination target from a listening port',
  );
});
