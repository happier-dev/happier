import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { readExecutionHostProfile, resolveExecutionHostProfilePath } from './config.mjs';
import { renderMutagenProject } from '../dev_targets/mutagen_project.mjs';
import * as sync from '../dev_targets/sync_project.mjs';
import * as primary from './primary.mjs';
import { resolveDevTargetMutagenRuntime } from '../dev_targets/mutagen_runtime.mjs';
import { resolvePrimaryStandbySessionNames } from '../dev_targets/mutagen_project.mjs';

test('primary verification inspects native public prerequisites without sending messages or claiming restore certification', async t => {
  const fixture = await createTempFixture(t);
  const env = { HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks') };
  const home = '/home/pswitch';
  const source = { name: 'a', platform: 'posix', ssh: 'primary-a', repoDir: `${home}/workspace/dev`, cliHomeDir: `${home}/.happier/cli` };
  const target = { ...source, name: 'b', ssh: 'primary-b' };
  await mkdir(fixture.path('stacks', 'proof'), { recursive: true });
  await writeFile(fixture.path('stacks', 'proof', 'dev-targets.json'), JSON.stringify({ version: 3, targets: [source, target] }));
  const calls = [];
  const adapterCapture = async (command, args) => {
    calls.push({ command, args });
    const remote = args.at(-1);
    const peer = args.at(-2);
    let value;
    if (remote.includes("'daemon' 'status'")) value = { daemon: { running: true },
      auth: { authenticated: true, machineId: peer === source.ssh ? 'machine-a' : 'machine-b', accountId: 'account' },
      server: { comparableKey: 'https://relay.example' }, runtimeConvergence: { controlReachable: true, machineIdMatches: true } };
    else if (remote.includes("'actions' 'describe'")) value = { ok: true, kind: 'session_actions_describe',
      data: { actionSpec: { surfaces: { cli: true }, inputHints: { fields: [{ path: 'stateTransfer', options: [{ value: 'existing' }] }] } } } };
    else if (remote.includes("'session' 'list'")) value = { ok: true, kind: 'session_list', data: {
      sessions: [{ id: 'source-parent', machineId: 'machine-a', permissionMode: 'read-only', active: true }], hasNext: false, nextCursor: null } };
    else throw new Error('verification attempted a mutating public command');
    return { exitCode: 0, out: JSON.stringify(value), err: '' };
  };
  const runProcess = async input => {
    calls.push(input);
    if (input.command === 'ssh') {
      const remote = input.args.at(-1);
      if (remote.endsWith('inspect-home')) return { code: 0, out: JSON.stringify({ homeDir: home, user: 'pswitch', availableBytes: 1000, requiredBytes: 100 }) };
      if (remote.endsWith('capture-status')) return { code: 0, out: JSON.stringify({ capturedAt: '2026-10-10T09:00:00Z', agentSqliteCount: 1 }) };
      throw new Error('verification attempted a mutating snapshot action');
    }
    assert.equal(input.command, 'mutagen');
    assert.equal(input.args[1], 'list');
    return { code: 0, out: JSON.stringify(resolvePrimaryStandbySessionNames(source.repoDir).map(name => ({ name,
      paused: false, status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }))) };
  };
  assert.equal(typeof primary.verifyPrimaryWorkload, 'function');
  const result = await primary.verifyPrimaryWorkload({ sourceName: 'a', targetName: 'b', homeDir: home, stackName: 'proof',
    workStackName: 'work-proof', workRepoDir: `${home}/workspace/0.2`, env }, { runProcess, capture: adapterCapture });
  assert.equal(result.state, 'prerequisites-inspected');
  assert.equal(result.executable, false);
  assert.equal(result.restoreVerified, false);
  assert.equal(result.standby.state, 'ready');
  assert.equal(result.standby.endpointMatch, 'unverified');
  assert.equal(result.sessionControl.state, 'public-cli-contract-inspected');
  assert.equal(result.sessionControl.daemonIdentity, 'observed');
  assert.equal(result.sessionControl.existingStateCapability, 'unverified');
  assert.equal(result.sessionControl.sessionCount, 1);
  assert.ok(result.blockers.some(blocker => blocker.code === 'WORK_SESSION_HANDOFF_UNVERIFIED'));
  assert.ok(result.blockers.some(blocker => blocker.code === 'STANDBY_ENDPOINTS_UNVERIFIED'));
  assert.ok(result.blockers.some(blocker => blocker.code === 'PRIMARY_API_MOVE_UNAVAILABLE'));
  assert.ok(calls.length > 0);
});

export function sshProfile(overrides = {}) {
  return { version: 2, activation: 'active', mode: 'ssh', instance: 'a', ssh: 'primary-a',
    sshConfigFile: '/controller/ssh.config', homeDir: '/home/pswitch',
    guestWorkspaceDir: '/home/pswitch/workspace', mirrorWorkspaceDir: '/controller/mirror',
    controllerEntrypoint: '/controller/bridge.mjs',
    workspaces: [{ id: 'dev', stackName: 'proof', hostSourceDir: '/controller/source',
      hostMirrorDir: '/controller/mirror/dev', guestDir: '/home/pswitch/workspace/dev' }], ...overrides };
}

test('standby uses the same Mutagen owner, retains Git and secrets, excludes live SQLite and disposable homes', async (t) => {
  const fixture = await createTempFixture(t);
  const profile = sshProfile({ standby: { ...sshProfile({ instance: 'b', ssh: 'primary-b' }) } });
  const rendered = renderMutagenProject({ sourceDir: '/home/pswitch/workspace/dev', targets: [], standby: profile });
  assert.match(rendered, /primary-a:\/home\/pswitch/);
  assert.match(rendered, /primary-b:\/home\/pswitch/);
  assert.match(rendered, /vcs: false/);
  assert.match(rendered, /one-way-safe/);
  // A generated snapshot is a replaceable projection. Unlike portable home
  // state, its fresh manifest must replace an older target manifest.
  assert.match(rendered, /primary--standby--sqlite:[\s\S]*mode: "one-way-replica"/);
  assert.match(rendered, /materialized/);
  assert.match(rendered, /installation-identity\.json/);
  assert.doesNotMatch(rendered, /- "\.ssh"|- "\.git"|- "\.happier"/);
  assert.equal(typeof sync.ensurePrimaryStandbySync, 'function');
  const calls = [];
  await sync.ensurePrimaryStandbySync({ stackBaseDir: fixture.path('stack'), profile,
    env: { HAPPIER_STACK_STORAGE_DIR: fixture.root } }, { runProcess: async input => {
      calls.push(input);
      if (input.command === 'ssh') return { code: 0, out: JSON.stringify(input.args.at(-1).endsWith('inspect-home')
        ? { homeDir: profile.homeDir, user: 'pswitch', availableBytes: 1000, requiredBytes: 100 }
        : { format: 1, paths: [], capturedAt: new Date().toISOString() }) };
      const name = input.args[0] === 'sync' && input.args[1] === 'list' && input.args[2] !== '--template' ? input.args[2] : null;
      return { code: 0, out: JSON.stringify(name ? [{ name, paused: false, status: 'watching', successfulCycles: 1,
        alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }] : []) };
    } });
  assert.equal(new Set(calls.map(call => call.env.MUTAGEN_DATA_DIRECTORY)).size, 1);
  assert.ok(calls.some(call => call.args.includes('start')));
});

test.skip('switch mid-turn refusal: blocked pending consumed 0.2 handoff contract', async (t) => {
  const fixture = await createTempFixture(t);
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('stack-home') };
  await mkdir(env.HAPPIER_STACK_HOME_DIR);
  const profile = sshProfile({ standby: sshProfile({ instance: 'b', ssh: 'primary-b' }) });
  await writeFile(resolveExecutionHostProfilePath(env), JSON.stringify(profile));
  const calls = [];
  const boundary = { capture: async (command, args) => {
    calls.push({ command, args });
    return { exitCode: 0, out: JSON.stringify({ homeDir: profile.homeDir, user: 'pswitch',
      availableBytes: 1000000, requiredBytes: 100, midTurn: true, stacks: ['proof'], machineIds: ['machine-proof'] }), err: '' };
  } };
  assert.equal(typeof primary.switchPrimaryWorkload, 'function');
  await assert.rejects(primary.switchPrimaryWorkload({ profile, targetName: 'b', env, boundary }), /MID_TURN/);
  assert.deepEqual(readExecutionHostProfile(env), profile);
  assert.ok(calls.every(call => !call.args.some(arg => String(arg).includes("'quiesce'"))));
});

test('standby capture freshness uses a fresh authenticated SSH connection and both session states', async t => {
  const fixture = await createTempFixture(t);
  const env = { HAPPIER_STACK_STORAGE_DIR: fixture.root };
  const stackBaseDir = fixture.path('stack');
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  await mkdir(runtime.opensshDir, { recursive: true });
  const config = `${runtime.opensshDir}/config`;
  await writeFile(config, '# transport boundary fixture\n');
  const result = await sync.inspectPrimaryStandbySync({ stackBaseDir,
    sourceDir: '/home/pswitch/workspace/dev', target: { ssh: 'primary-a', sshConfigFile: '/fixture/transport' },
    env }, { runProcess: async input => {
      if (input.command === 'ssh') {
        assert.ok(input.args.includes('ControlMaster=no'));
        assert.ok(input.args.includes('ControlPath=none'));
        assert.equal(input.args[input.args.indexOf('-F') + 1], config);
        return { code: 0, out: JSON.stringify({ capturedAt: '2026-10-09T20:55:00Z', agentSqliteCount: 1 }) };
      }
      const names = input.args.slice(2, input.args.indexOf('--template'));
      return { code: 0, out: JSON.stringify(names.map(name => ({ name, paused: false, status: 'watching', successfulCycles: 1,
        alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }))) };
    } });
  assert.equal(result.state, 'ready');
  assert.equal(result.agentSqliteCount, 1);
  assert.equal(result.syncLag, null);
});
