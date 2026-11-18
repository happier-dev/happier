// @happier-test-preparation source-condition
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
import { probeStackAgentStart, runVerifiedStackStart } from './stack_reload_verification.mjs';

/** This reload's own record and a working QA sign-in: the validity evidence every READY needs. */
function validity() {
  const revision = 'a'.repeat(40);
  return { reload: { status: 'ready', fresh: true, sourceCaptures: { server: { revision }, daemon: { revision } } }, signIn: { status: 200 } };
}

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
    info.runtime.sourceRuntimeIdentities.server.sourceTime = '2026-11-09T03:38:00.000Z';
    info.runtime.sourceRuntimeIdentities.daemon.sourceTime = '2026-11-09T03:39:00.000Z';
    const input = { info, beforeManagedCli, auth: { authenticated: true }, agent: { status: 'ready' }, ...validity() };
    const verdict = projectStackReloadVerification(input);
    assert.equal(verdict.status, 'READY');
    assert.equal(verdict.baseline, 'unavailable');
    assert.deepEqual(verdict.sourceTimes, {
      server: '2026-11-09T03:38:00.000Z', daemon: '2026-11-09T03:39:00.000Z',
    });
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
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: true }, agent: { status: 'ready' }, ...validity() };
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
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: true }, agent: { status: 'ready' }, ...validity() };
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
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: false }, agent: { status: 'ready' }, ...validity() };
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
  input.render = { status: 'ready', expectedApiOrigin: 'http://qa:3101', apiOrigins: ['http://qa:3101'] };
  assert.equal(projectStackReloadVerification(input).status, 'READY');
});

test('a start whose readiness is still pending with a live runner is reported as readiness pending, not an identity mismatch', () => {
  // agent-qa-usage-insights reload 201: the background readiness budget ran out while
  // the replacement runner was still starting; the verdict said identity:server loaded null.
  const info = readyInfo();
  info.runtime.sourceRuntimeIdentities.server.loaded = null;
  info.runtime.sourceRuntimeIdentities.daemon.loaded = null;
  const verdict = projectStackReloadVerification({ info, beforeManagedCli: info.runtime.managedCli,
    start: { readiness: 'pending', runnerPid: 4242 } });
  assert.equal(verdict.status, 'NOT_READY');
  assert.equal(verdict.check, 'readiness');
  assert.deepEqual(verdict.evidence, { status: 'pending', runner: 'live', runnerPid: 4242 });
});

test('export snapshots use the existing selection and loaded projection; disabled UI needs no render', () => {
  const info = readyInfo();
  info.runtime.mode = 'require';
  info.runtime.selectedSnapshotId = 'new';
  info.runtime.loadedSnapshotId = 'old';
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: true }, agent: { status: 'ready' }, ...validity() };
  assert.equal(projectStackReloadVerification(input).check, 'identity:snapshot');
  info.runtime.loadedSnapshotId = 'new';
  assert.equal(projectStackReloadVerification(input).status, 'READY');
  delete info.runtime.managedCli;
  assert.equal(projectStackReloadVerification(input).check, 'managed-cli');
});

// The child CLI process is the boundary: each fake returns what the retained
// runtime's `happier ... --json` would print, and the probe/verdict stay real.
function fakeRuntimeCli(replies) {
  const calls = [];
  const run = async (_cmd, args) => {
    const happierArgs = args.slice(args.indexOf('--') + 1);
    calls.push(happierArgs);
    const reply = happierArgs[0] === 'actions'
      ? { ok: true, kind: 'actions_invoke', data: { items: [
          { targetKey: 'agent:claude', enabled: true, readiness: 'signedOut' },
          { targetKey: 'agent:codex', enabled: false, readiness: 'ready' },
          { targetKey: 'agent:pi', enabled: true, readiness: 'ready' },
        ] } }
      : replies[happierArgs.slice(0, 2).join(' ')];
    return { ok: reply.ok !== false, out: `preparing runtime\n${JSON.stringify(reply)}\n` };
  };
  return { calls, run };
}

test('READY requires one real Agent start; a child that exits before webhook keeps the stack NOT_READY', async () => {
  const info = readyInfo();
  const input = { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: true }, ...validity() };
  assert.equal(projectStackReloadVerification(input).check, 'agent');

  const failing = fakeRuntimeCli({ 'session create': { ok: false, kind: 'session_create',
    error: { code: 'spawn_failed', launchError: { code: 'CHILD_EXITED_BEFORE_WEBHOOK', message: 'private child log' } } } });
  input.agent = await probeStackAgentStart({ rootDir: '/repo', stackName: 'qa', machineId: 'probe-machine', run: failing.run });
  assert.deepEqual(projectStackReloadVerification(input), { status: 'NOT_READY', check: 'agent',
    evidence: { status: 'failed', phase: 'create', code: 'spawn_failed', launchErrorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' } });
  assert.equal(failing.calls.length, 2);

  const working = fakeRuntimeCli({
    'session create': { ok: true, kind: 'session_create', data: { created: true, session: { id: 'probe-1' } } },
    'session stop': { ok: true, kind: 'session_stop', data: { sessionId: 'probe-1', stopped: true } },
    'session archive': { ok: true, kind: 'session_archive', data: { sessionId: 'probe-1' } },
  });
  input.agent = await probeStackAgentStart({ rootDir: '/repo', stackName: 'qa', machineId: 'probe-machine', run: working.run });
  assert.equal(projectStackReloadVerification(input).status, 'READY');
  assert.deepEqual(working.calls.slice(2).map(args => args.slice(0, 3)),
    [['session', 'stop', 'probe-1'], ['session', 'archive', 'probe-1']]);
});

test('a source-snapshot stack runs its probe CLI from the source runtime, not a built snapshot', async () => {
  const wrapperArgs = [];
  const run = async (_cmd, args) => {
    wrapperArgs.push(args.slice(args.indexOf('qa') + 1, args.indexOf('--')));
    if (args.includes('agents.backends.list')) return { ok: true, out: JSON.stringify({ ok: true, kind: 'actions_invoke', data: { items: [{ targetKey: 'agent:pi', enabled: true, readiness: 'ready' }] } }) };
    const kind = { create: 'session_create', stop: 'session_stop', archive: 'session_archive' }[args[args.indexOf('--') + 2]];
    return { ok: true, out: `${JSON.stringify({ ok: true, kind, data: { session: { id: 'probe-3' } } })}\n` };
  };
  await probeStackAgentStart({ rootDir: '/repo', stackName: 'qa', runtimeMode: 'source-snapshot', machineId: 'probe-machine', run });
  // Bare `--runtime` selects the built runtime snapshot, which a source stack does not have.
  assert.deepEqual(wrapperArgs, [['--runtime=source'], ['--runtime=source'], ['--runtime=source'], ['--runtime=source']]);
});

test('a probe Session the stop owner cannot stop keeps the stack NOT_READY', async () => {
  const info = readyInfo();
  const leaking = fakeRuntimeCli({
    'session create': { ok: true, kind: 'session_create', data: { created: true, session: { id: 'probe-2' } } },
    'session stop': { ok: false, kind: 'session_stop', error: { code: 'session_stop_failed', message: 'private' } },
  });
  const agent = await probeStackAgentStart({ rootDir: '/repo', stackName: 'qa', machineId: 'probe-machine', run: leaking.run });
  assert.deepEqual(projectStackReloadVerification({ info, beforeManagedCli: info.runtime.managedCli,
    auth: { authenticated: true }, agent, ...validity() }).evidence, { status: 'failed', phase: 'stop', code: 'session_stop_failed' });
});

test('readiness probe explicitly starts a ready Agent instead of the signed-out CLI fallback', async () => {
  const boundary = fakeRuntimeCli({
    'session create': { ok: true, kind: 'session_create', data: { session: { id: 'probe-selected' } } },
    'session stop': { ok: true, kind: 'session_stop' },
    'session archive': { ok: true, kind: 'session_archive' },
  });
  assert.deepEqual(await probeStackAgentStart({ rootDir: '/repo', stackName: 'qa', machineId: 'probe-machine', run: boundary.run }), { status: 'ready' });
  assert.deepEqual(boundary.calls[0], ['actions', 'invoke', 'agents.backends.list', '--input-json', JSON.stringify({ machineId: 'probe-machine' }), '--json']);
  const create = boundary.calls.find(args => args[0] === 'session');
  assert.equal(create[create.indexOf('--backend') + 1], 'agent:pi');
  assert.equal(create[create.indexOf('--machine-id') + 1], 'probe-machine');
});

test('an unavailable inventory or no ready Agent settles without creating a Session', async () => {
  for (const envelope of [
    { ok: false, kind: 'actions_invoke', error: { code: 'catalog_unavailable', message: 'private' } },
    { ok: true, kind: 'actions_invoke', data: { items: [{ targetKey: 'agent:claude', enabled: true, readiness: 'signedOut' }] } },
    { ok: true, kind: 'actions_invoke', data: { items: [{ targetKey: 'agent:claude', enabled: true }] } },
  ]) {
    const calls = [];
    const result = await probeStackAgentStart({ rootDir: '/repo', stackName: 'qa', machineId: 'probe-machine',
      run: async (_command, args) => { calls.push(args); return { ok: envelope.ok, out: JSON.stringify(envelope) }; } });
    assert.equal(result.status, 'failed');
    assert.equal(result.phase, 'inventory');
    assert.equal(result.code, envelope.ok ? 'agent_cli_not_ready' : 'catalog_unavailable');
    assert.equal(calls.length, 1);
  }
});

// Usage 4 / O-DEPLOY D6 (owner 2026-11-18, QA train): three QA windows were invalidated after READY by a stale
// daemon, a UI talking to another server, and sign-in that did not work. READY now proves each one.
function validInput() {
  const info = readyInfo();
  const revision = 'a'.repeat(40);
  return { info, beforeManagedCli: info.runtime.managedCli, auth: { authenticated: true }, agent: { status: 'ready' },
    reload: { status: 'ready', fresh: true, sourceCaptures: { server: { revision }, daemon: { revision } } },
    signIn: { status: 200 } };
}

test('READY requires the daemon to run this reload\'s own revision tree', () => {
  const input = validInput();
  assert.equal(projectStackReloadVerification(input).status, 'READY');
  input.reload.sourceCaptures.daemon.revision = 'b'.repeat(40);
  assert.equal(projectStackReloadVerification(input).check, 'daemon_tree');
  delete input.reload.sourceCaptures.daemon;
  assert.equal(projectStackReloadVerification(input).check, 'daemon_tree');
  const stale = validInput();
  stale.reload.fresh = false;
  assert.equal(projectStackReloadVerification(stale).check, 'daemon_tree');
  delete stale.reload;
  assert.equal(projectStackReloadVerification(stale).check, 'daemon_tree');
});

test('READY requires a QA sign-in to work against the stack\'s own server', () => {
  const input = validInput();
  input.signIn = { status: 503 };
  assert.deepEqual(projectStackReloadVerification(input), { status: 'NOT_READY', check: 'sign_in', evidence: { status: 503 } });
  delete input.signIn;
  assert.equal(projectStackReloadVerification(input).check, 'sign_in');
});

test('READY requires the QA URL\'s API requests to reach the server that URL names', () => {
  const input = validInput();
  input.info.urls = { uiUrl: 'http://qa.localhost:8081/?server=http%3A%2F%2Fqa.localhost%3A3101' };
  input.render = { status: 'ready', expectedApiOrigin: 'http://qa.localhost:3101', apiOrigins: ['http://repo-dev.localhost:3005'] };
  assert.equal(projectStackReloadVerification(input).check, 'api_origin');
  input.render.apiOrigins = [];
  assert.equal(projectStackReloadVerification(input).check, 'api_origin');
  input.render.apiOrigins = ['http://qa.localhost:3101'];
  assert.equal(projectStackReloadVerification(input).status, 'READY');
});

test('outside the QA train canary the validity checks are reported with READY, not enforced', () => {
  const input = validInput();
  input.signIn = { status: 503 };
  input.enforceValidity = false;
  const verdict = projectStackReloadVerification(input);
  assert.equal(verdict.status, 'READY');
  assert.deepEqual(verdict.validity, { sign_in: { status: 'failed', evidence: { status: 503 } } });
});
