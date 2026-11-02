import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectStackReloadVerification } from './reload_verdict.mjs';
import { createStackRuntimeCleanupIncompleteError } from '../utils/stack/stop_failure.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withPatchedProcessEnv } from '../testkit/core/env_scope.mjs';
import { resolveStackRootFromMeta } from '../testkit/core/stack_root.mjs';
import { recordStackRuntimeStart } from '../utils/stack/runtime_state.mjs';
import { readStackInfoSnapshot } from './stack_info_snapshot.mjs';
import { runVerifiedStackStart } from './stack_reload_verification.mjs';

function readyInfo() {
  return { runtime: { mode: 'source-snapshot', running: true, valid: true,
    health: { status: 'healthy', issues: [] },
    components: { server: { running: true }, daemon: { running: true, status: 'running' } },
    daemonEntry: { selected: '/source/cli/src/index.mjs', loaded: '/source/cli/src/index.mjs' },
    sourceRuntimeIdentities: { server: { selected: 'server-new', loaded: 'server-new' },
      daemon: { selected: 'daemon-new', loaded: 'daemon-new' } },
    managedCli: { status: 'installed', binaryPath: '/managed/cli/versions/one/happier' } } };
}

test('reload without a baseline requires an identified available replacement and matching loaded identity', () => {
  for (const beforeManagedCli of [null, { status: 'unavailable', binaryPath: null }, { status: 'absent', binaryPath: null }]) {
    const info = readyInfo();
    const input = { info, beforeManagedCli, auth: { authenticated: true } };
    const verdict = projectStackReloadVerification(input);
    assert.equal(verdict.status, 'READY');
    assert.equal(verdict.baseline, 'unavailable');
    info.runtime.sourceRuntimeIdentities.daemon.loaded = 'daemon-old';
    assert.equal(projectStackReloadVerification(input).check, 'identity:daemon');
    info.runtime.sourceRuntimeIdentities.daemon.loaded = 'daemon-new';
    for (const after of [null, { status: 'unavailable', binaryPath: null },
      { status: 'absent', binaryPath: null }, { status: 'installed', binaryPath: null }]) {
      info.runtime.managedCli = after;
      assert.equal(projectStackReloadVerification(input).check, 'managed-cli');
    }
  }
});

test('missing baseline reaches the start owner and reports its failure instead of refusing reload', async t => {
  const storage = await mkdtemp(join(tmpdir(), 'hstack-reload-baseline-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storage });
  const stackName = 'missing-baseline';
  const base = join(storage, stackName);
  await mkdir(base);
  await writeFile(join(base, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source\nHAPPIER_STACK_SERVE_UI=0\n');
  await recordStackRuntimeStart(join(base, 'stack.runtime.json'), { stackName, ownerPid: null,
    placement: { daemon: 'worker' }, remoteTargets: { worker: { serviceStatus: { daemon: 'stopped' } } } });
  const rootDir = resolveStackRootFromMeta(import.meta.url);
  const before = await readStackInfoSnapshot({ rootDir, stackName });
  assert.equal(before.runtime.managedCli, null);
  // The real start owner rejects this internal-only flag before launching any process.
  const verdict = await runVerifiedStackStart({ rootDir, stackName, scriptPath: 'run.mjs',
    args: ['--prepared-source-reload'] });
  assert.equal(verdict.status, 'NOT_READY');
  assert.equal(verdict.check, 'start');
  assert.equal(verdict.baseline, 'unavailable');
});

test('reload failure retains the cleanup owner reason without exposing its diagnostic prose', () => {
  const error = createStackRuntimeCleanupIncompleteError({
    stackName: 'reload-fixture',
    finalization: { finalized: false, reason: 'remote_cleanup_incomplete' },
    errors: [{ step: 'remote-stop', error: 'private boundary diagnostic' }],
  });
  assert.deepEqual(projectStackReloadVerification({ failure: { check: 'start', error } }), {
    status: 'NOT_READY', check: 'start', baseline: 'unavailable',
    evidence: { code: 'ESTACKRUNTIMECLEANUPINCOMPLETE', reason: 'remote_cleanup_incomplete' },
  });
  assert.deepEqual(projectStackReloadVerification({ failure: { check: 'auth', error: new Error('private boundary diagnostic') } }), {
    status: 'NOT_READY', check: 'auth', evidence: { code: null }, baseline: 'unavailable',
  });
});

test('reload verdict requires loaded source entries and authenticated control, not just live processes', () => {
  const info = readyInfo();
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: true } };
  assert.equal(projectStackReloadVerification(input).status, 'READY');
  info.runtime.sourceRuntimeIdentities.daemon.loaded = 'daemon-old';
  assert.equal(projectStackReloadVerification(input).check, 'identity:daemon');
  delete info.runtime.sourceRuntimeIdentities.daemon;
  assert.equal(projectStackReloadVerification(input).check, 'identity:daemon');
  info.runtime.sourceRuntimeIdentities.daemon = { selected: 'daemon-new', loaded: 'daemon-new' };
  info.runtime.components.daemon.status = 'unreachable';
  info.runtime.components.daemon.running = false;
  assert.equal(projectStackReloadVerification(input).check, 'control');
});

test('matching recorded IDs cannot admit a promoted daemon entry or missing loaded-entry evidence', () => {
  const info = readyInfo();
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: true } };
  info.runtime.daemonEntry.loaded = '/managed/cli/package-dist/index.mjs';
  assert.deepEqual(projectStackReloadVerification(input), {
    status: 'NOT_READY', check: 'daemon_entry_mismatch', evidence: info.runtime.daemonEntry,
  });
  info.runtime.daemonEntry.loaded = null;
  assert.equal(projectStackReloadVerification(input).check, 'daemon_entry_mismatch');
  delete info.runtime.daemonEntry;
  assert.equal(projectStackReloadVerification(input).check, 'daemon_entry_mismatch');
});

test('reload verdict refuses missing sign-in, pending readiness, changed managed CLI, and unrendered UI', () => {
  const info = readyInfo();
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: false } };
  assert.equal(projectStackReloadVerification(input).check, 'auth');
  input.auth.authenticated = true;
  info.runtime.health = { status: 'degraded', issues: ['runtime_preparing'] };
  assert.equal(projectStackReloadVerification(input).check, 'readiness');
  info.runtime.health = { status: 'healthy', issues: [] };
  info.runtime.managedCli = { status: 'installed', binaryPath: '/managed/cli/versions/two/happier' };
  assert.equal(projectStackReloadVerification(input).check, 'managed-cli');
  input.beforeManagedCli = info.runtime.managedCli;
  info.urls = { uiUrl: 'ui-origin' };
  assert.equal(projectStackReloadVerification(input).check, 'render');
  input.render = { status: 'ready' };
  assert.equal(projectStackReloadVerification(input).status, 'READY');
});

test('export snapshots use the existing selection and loaded projection; disabled UI needs no render', () => {
  const info = readyInfo();
  info.runtime.mode = 'require';
  info.runtime.selectedSnapshotId = 'new';
  info.runtime.loadedSnapshotId = 'old';
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: true } };
  assert.equal(projectStackReloadVerification(input).check, 'identity:snapshot');
  info.runtime.loadedSnapshotId = 'new';
  assert.equal(projectStackReloadVerification(input).status, 'READY');
  delete info.runtime.managedCli;
  assert.equal(projectStackReloadVerification(input).check, 'managed-cli');
});
