import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import {
  INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  ensureDevTargetSyncProject,
  pauseOwnedDevTargetSyncProject,
  releaseIndependentDevTargetSyncProject,
  runDevTargetControlProcess,
  prepareDevTargetOpenSsh,
  inspectPrimaryStandbySync,
} from './sync_project.mjs';
import { DEV_TARGET_SYNC_EXECUTOR_REPO, DEV_TARGET_MUTAGEN_IGNORE_PATHS, renderMutagenProject, resolveMutagenSessionName } from './mutagen_project.mjs';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import { parseDevTargetsConfig } from './config.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { runCaptureResult } from '../proc/proc.mjs';

const envFor = root => ({ HAPPIER_STACK_STORAGE_DIR: root });
const runtimeFor = (root, sourceDir = DEV_TARGET_SYNC_EXECUTOR_REPO) => resolveDevTargetMutagenRuntime({ stackBaseDir: root, sourceDir, env: envFor(root) });
const projectFor = root => runtimeFor(root).projectFile;

const target = {
  name: 'mac',
  platform: 'posix',
  ssh: 'mac',
  repoDir: '/Users/dev/happier',
  cliHomeDir: '/Users/dev/.happier',
};

test('partial project preparation cannot retain a replica without prior canonical admission', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-retained-admission-' });
  const stackBaseDir = fixture.path('stack');
  await mkdir(stackBaseDir);
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [target] }));
  const calls = [];
  await assert.rejects(ensureDevTargetSyncProject({
    stackBaseDir, sourceDir: fixture.root, targets: [target], requiredTargets: [],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env: envFor(fixture.root),
  }, { runProcess: async ({ command }) => {
    calls.push(command);
    return { code: 0, out: '[]' };
  } }), { code: 'DEV_TARGET_REPLICA_NOT_PREPARED' });
  assert.deepEqual(calls, []);
});

test('pin admission renders the requested endpoint when configuration changes before the lock', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pin-endpoint-' });
  const sourceDir = fixture.path('source');
  const stackBaseDir = fixture.path('stack');
  await Promise.all([mkdir(sourceDir), mkdir(stackBaseDir)]);
  const selected = { ...target, ssh: 'admitted-host', repoDir: '/admitted/mirror' };
  const replacement = { ...selected, ssh: 'unchecked-host', repoDir: '/unchecked/mirror' };
  const config = parseDevTargetsConfig({ version: 3, targets: [replacement] });
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify(config));
  const env = envFor(fixture.root);
  const checkedHosts = [];
  const runtime = await ensureDevTargetSyncProject({
    stackBaseDir, sourceDir, targets: [selected], preserveExistingTargets: true,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env,
  }, { runProcess: async ({ command, args }) => {
    if (command === 'ssh') checkedHosts.push(args.at(-2));
    return { code: 0, out: args[0] === 'sync' && args[1] === 'list' ? '[]' : '' };
  } });
  assert.ok(checkedHosts.includes(selected.ssh));
  assert.ok(await readFile(runtime.projectFile, 'utf8') === renderMutagenProject({
    sourceDir, targets: [selected], config, ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }), 'rendered destination must be the endpoint that received fresh admission');
});

test('concurrent pin extensions merge under the existing project lock and retain paused peers', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-concurrent-pins-' });
  const sourceDir = fixture.path('source');
  const stackBaseDir = fixture.path('stack');
  await Promise.all([mkdir(sourceDir), mkdir(stackBaseDir)]);
  const targets = ['peer', 'first', 'second'].map(name => ({ ...target, name, ssh: `${name}-host` }));
  const config = parseDevTargetsConfig({ version: 3, targets, commandExecution: { mode: 'auto', targets: targets.map(target => target.name), fallback: 'error' } });
  const env = envFor(fixture.root);
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify(config));
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env });
  await mkdir(dirname(runtime.projectFile), { recursive: true });
  await writeFile(runtime.projectFile, renderMutagenProject({ sourceDir, targets: [targets[0]], config, ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER }));
  const resumed = [];
  const runProcess = async ({ command, args }) => {
    if (command === 'ssh') return { code: 0, out: '' };
    if (args[0] === 'sync' && args[1] === 'resume') resumed.push(args[2]);
    if (args[0] === 'sync' && args[1] === 'list' && args[2] === '--template') {
      const project = await readFile(runtime.projectFile, 'utf8');
      return { code: 0, out: JSON.stringify(targets.filter(target => project.includes(`  ${resolveMutagenSessionName(target.name, sourceDir)}:\n`)).map(target => ({
        name: resolveMutagenSessionName(target.name, sourceDir), identifier: `session-${target.name}`,
        mode: 'one-way-replica', paused: target.name === 'peer', alpha: { protocol: 'local', path: sourceDir },
      }))) };
    }
    return { code: 0, out: '' };
  };
  await Promise.all(targets.slice(1).map(selected => ensureDevTargetSyncProject({
    stackBaseDir, sourceDir, targets: [targets[0], selected], requiredTargets: [selected],
    preserveExistingTargets: true, ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env,
  }, { runProcess })));
  const project = await readFile(runtime.projectFile, 'utf8');
  for (const target of targets) assert.ok(project.includes(`  ${resolveMutagenSessionName(target.name, sourceDir)}:\n`), `lost mirror: ${target.name}`);
  assert.equal(resumed.includes(resolveMutagenSessionName('peer', sourceDir)), false);
});

for (const platform of ['darwin', 'win32']) {
  test(`sync owner identifies a self-target across private user namespaces (${platform})`, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-replica-host-' });
    const sourceDir = join(root, 'source');
    await mkdir(sourceDir);
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    const nativeOutput = value => platform === 'darwin'
      ? `"IOPlatformUUID" = "${value}"` : `MachineGuid    REG_SZ    ${value}`;
    // Only OS facts and SSH are substituted. Identity parsing, source/path
    // admission and the Mutagen producer remain real; no private temp is shared.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: nativeOutput(uuid) }));
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    try {
      for (const observation of ['same', 'different', 'unavailable']) {
        let mutation = false;
        const admission = ensureDevTargetSyncProject({ stackBaseDir: join(root, observation), sourceDir,
          targets: [{ ...target, platform: platform === 'win32' ? 'windows' : 'posix', repoDir: sourceDir }],
          ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env: envFor(root),
        }, { runProcess: async ({ command, args }) => {
          if (command === 'ssh') {
            const raw = String(args.at(-1));
            const script = platform === 'win32' ? Buffer.from(raw.split(' ').at(-1), 'base64').toString('utf16le') : raw;
            if (script.includes('ioreg') || script.includes('reg.exe')) {
              const output = observation === 'unavailable' ? '' : nativeOutput(observation === 'same'
                ? uuid : '11111111-2222-3333-4444-555555555555');
              return { code: 0, out: output + (platform === 'win32' ? `\n${hostname()}\n` : '') };
            }
            return { code: 0, out: `HSTACK_CONTROLLER_SOURCE\n${sourceDir}\n` };
          }
          mutation = true;
          return { code: 0, out: args[1] === 'list' ? '[]' : '' };
        } });
        if (observation === 'different') {
          await admission;
          assert.equal(mutation, true, 'an equal path on another host is not a self-target');
        } else {
          await assert.rejects(admission, observation === 'same' ? /self-target.*overlap/i : /host identity unavailable/i);
          assert.equal(mutation, false, 'unsafe or unobserved destinations must not reach Mutagen');
        }
      }
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test('sync owner rejects self-target replicas overlapping its source before any Mutagen mutation', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-self-replica-' });
  const sourceDir = join(root, 'source');
  await mkdir(sourceDir);
  const alias = join(root, 'source-alias');
  await symlink(sourceDir, alias, 'dir');
  for (const repoDir of [sourceDir, root, join(sourceDir, 'nested'), alias, join(alias, 'nested')]) {
    const mutations = [];
    await assert.rejects(ensureDevTargetSyncProject({
      stackBaseDir: join(root, 'stack'), sourceDir, targets: [{ ...target, repoDir }],
      ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env: envFor(root),
    }, { runProcess: async ({ command, args }) => {
      if (command === 'ssh') {
        // Real shell/filesystem probe through a fake SSH boundary on the controller host.
        const result = await runCaptureResult('/bin/sh', ['-c', args.at(-1)]);
        return { ...result, code: result.exitCode };
      }
      if (!['list'].includes(args[1])) mutations.push(args);
      return { code: 0, out: '[]' };
    } }), /self-target.*overlap/i);
    assert.deepEqual(mutations, [], 'a dangerous one-way replica must never reach Mutagen');
  }
  for (const [repoDir, self] of [[join(root, 'source-sibling'), true], [sourceDir, false]]) {
    let started = false;
    await ensureDevTargetSyncProject({ stackBaseDir: join(root, 'stack'), sourceDir,
      targets: [{ ...target, repoDir }], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env: envFor(root),
    }, { runProcess: async ({ command, args }) => {
      if (command === 'ssh' && self) {
        const result = await runCaptureResult('/bin/sh', ['-c', args.at(-1)]);
        return { ...result, code: result.exitCode };
      }
      if (args[0] === 'project' && args[1] === 'start') started = true;
      return { code: 0, out: command === 'mutagen' && args[1] === 'list' ? '[]' : '' };
    } });
    assert.equal(started, true, 'distinct self mirrors and equal paths on other hosts remain valid');
  }
});

test('standby capture status reuses the configured SSH transport', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-standby-status-ssh-' });
  const capturedAt = '2026-10-12T07:30:00.000Z';
  const result = await inspectPrimaryStandbySync({ stackBaseDir: root, sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    target, env: envFor(root) }, {
    runProcess: async ({ command, args }) => {
      if (command === 'mutagen') return { code: 0, out: '[]' };
      assert.equal(command, 'ssh');
      assert.equal(args.includes('ControlPath=none'), false, 'a metadata query is not a credential proof');
      return { code: 0, out: JSON.stringify({ capturedAt, agentSqliteCount: 2 }) };
    },
  });
  assert.equal(result.agentSqliteCapturedAt, capturedAt);
  assert.equal(result.agentSqliteCount, 2);
});

test('candidate producer creates and pauses only its own project in the shared repository runtime', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-candidate-shared-runtime-' });
  await writeFile(join(root, 'dev-targets.json'), JSON.stringify({ version: 1, targets: [target] }));
  const sourceDir = join(root, 'source');
  const env = envFor(root);
  const ownerId = 'execution-host-candidate-0.3';
  const candidateTarget = { ...target, name: ownerId, repoDir: '/guest/candidate' };
  const ordinary = runtimeFor(root, sourceDir);
  await mkdir(dirname(ordinary.projectFile), { recursive: true });
  const ordinaryProject = renderMutagenProject({ sourceDir, targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER });
  await writeFile(ordinary.projectFile, ordinaryProject);
  await writeFile(`${ordinary.projectFile}.lock`, 'ordinary-project');
  const session = (entry, project) => ({ identifier: `sync-${entry.name}`, name: resolveMutagenSessionName(entry.name, sourceDir),
    labels: { 'io.mutagen.project': project }, mode: 'one-way-replica',
    alpha: { protocol: 'local', path: sourceDir, connected: true, scanned: true },
    beta: { protocol: 'ssh', host: entry.ssh, path: entry.repoDir, connected: true, scanned: true },
    paused: false, status: 'watching', successfulCycles: 1 });
  const sessions = [session(target, 'ordinary-project')];
  const calls = [];
  const runProcess = async ({ args, env: controlEnv }) => {
    assert.equal(controlEnv.MUTAGEN_DATA_DIRECTORY, ordinary.dataDir);
    calls.push(args);
    if (args[0] === 'sync' && args[1] === 'list') return { code: 0, out: JSON.stringify(sessions) };
    if (args[0] === 'sync' && args[1] === 'terminate') {
      const index = sessions.findIndex(entry => entry.identifier === args[2]);
      assert.ok(index >= 0);
      sessions.splice(index, 1);
    }
    if (args[0] === 'project' && args[1] === 'start') {
      sessions.push(session(candidateTarget, 'candidate-project'));
      await writeFile(`${args.at(-1)}.lock`, 'candidate-project');
    }
    if (args[0] === 'project' && args[1] === 'pause') {
      assert.notEqual(args.at(-1), ordinary.projectFile, 'candidate retirement must not pause ordinary routing');
      sessions.find(entry => entry.identifier === `sync-${ownerId}`).paused = true;
    }
    return { code: 0, out: '' };
  };
  const candidate = await ensureDevTargetSyncProject({ stackBaseDir: root, sourceDir,
    targets: [candidateTarget], ownerId, env }, { runProcess });
  assert.equal(candidate.ownership, 'owned');
  assert.notEqual(candidate.projectFile, ordinary.projectFile);
  assert.equal(candidate.dataDir, ordinary.dataDir);
  assert.equal(candidate.opensshDir, ordinary.opensshDir);
  assert.match(await readFile(candidate.projectFile, 'utf8'), /execution-host-candidate-0\.3/);
  await ensureDevTargetSyncProject({ stackBaseDir: root, sourceDir,
    targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env }, { runProcess });
  assert.equal(sessions.length, 2, 'neither producer may retire the other project as an orphan');
  assert.equal(await pauseOwnedDevTargetSyncProject({ stackBaseDir: root, sourceDir, ownerId, env }, { runProcess }), true);
  assert.equal(sessions.find(entry => entry.identifier === 'sync-mac').paused, false);
  assert.equal(sessions.find(entry => entry.identifier === `sync-${ownerId}`).paused, true);
  assert.equal(await readFile(ordinary.projectFile, 'utf8'), ordinaryProject);
  assert.equal(calls.some(args => args[0] === 'sync' && args[1] === 'terminate'), false);
});

test('replica admission refuses a destination already written by another alpha', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-beta-collision-' });
  const sourceDir = join(root, 'steward');
  await writeFile(join(root, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [target] }));
  const runtime = runtimeFor(root, sourceDir);
  const mutations = [];
  const input = { stackBaseDir: root, sourceDir, targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env: envFor(root) };
  const sessions = [{ identifier: 'primary-session', name: 'primary', mode: 'one-way-replica',
    alpha: { protocol: 'local', path: join(root, 'primary') },
    beta: { protocol: 'ssh', host: target.ssh, path: target.repoDir } }];
  const runProcess = async ({ command, args }) => {
    if (command === 'mutagen' && args[0] === 'sync' && args[1] === 'list') return { code: 0, out: JSON.stringify(sessions) };
    if (command === 'mutagen' && (args[0] === 'project' || args[1] === 'terminate')) mutations.push(args);
    return { code: 0, out: '' };
  };
  await assert.rejects(ensureDevTargetSyncProject(input, { runProcess }), { code: 'DEV_TARGET_REPLICA_COLLISION' });
  assert.deepEqual(mutations, []);
  // Mutagen 0.18.1 serializes an SSH URL's user separately from its host.
  const qualified = { ...input, targets: [{ ...target, ssh: `replica@${target.ssh}` }] };
  sessions[0].beta.user = 'replica';
  await assert.rejects(ensureDevTargetSyncProject(qualified, { runProcess }), { code: 'DEV_TARGET_REPLICA_COLLISION' });
  assert.deepEqual(mutations, []);
  await assert.rejects(readFile(runtime.projectFile), { code: 'ENOENT' });
  // The same alpha may reclaim its existing destination through the real owner.
  sessions[0].alpha.path = sourceDir;
  await ensureDevTargetSyncProject(input, { runProcess });
  assert.ok((await readFile(runtime.projectFile, 'utf8')).includes(target.repoDir));
  // Source scope can also come from the runtime owner's environment default.
  await ensureDevTargetSyncProject({ ...input, sourceDir: undefined,
    env: { ...input.env, HAPPIER_STACK_SYNC_SOURCE_DIR: sourceDir } }, { runProcess });
  await ensureDevTargetSyncProject(qualified, { runProcess });
});

test('project reconciliation removes orphan writers by identifier before resuming or rotating the repository project', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-orphan-writers-' });
  const sourceDir = join(root, '0.2');
  const runtime = runtimeFor(root, sourceDir);
  await mkdir(dirname(runtime.projectFile), { recursive: true });
  await writeFile(runtime.projectFile, renderMutagenProject({ sourceDir, targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER }));
  await writeFile(`${runtime.projectFile}.lock`, 'proj_current');
  const name = resolveMutagenSessionName(target.name, sourceDir);
  const session = (identifier, project, path = sourceDir) => ({ identifier, name,
    labels: { 'io.mutagen.project': project }, mode: 'one-way-replica',
    alpha: { protocol: 'local', path, connected: true, scanned: true },
    beta: { protocol: 'ssh', host: target.ssh, path: target.repoDir, connected: true, scanned: true },
    paused: false, status: 'watching', successfulCycles: 1 });
  const sessions = [session('sync_orphan', 'proj_old'), session('sync_current', 'proj_current'),
    // Lane brief task3: unrelated sources own distinct replica destinations.
    { ...session('sync_other_repository', 'proj_other', join(root, 'other')),
      beta: { protocol: 'ssh', host: target.ssh, path: `${target.repoDir}-other` } }];
  const input = { stackBaseDir: root, sourceDir, targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env: envFor(root) };
  const runProcess = async ({ args }) => {
    if (args[0] === 'sync' && args[1] === 'list') return { code: 0, out: JSON.stringify(sessions) };
    if (args[0] === 'sync' && args[1] === 'terminate') {
      const i = sessions.findIndex(s => s.identifier === args[2]);
      assert.ok(i >= 0, 'termination must address an exact session identifier');
      sessions.splice(i, 1);
    }
    if (args[0] === 'project' && ['resume', 'start'].includes(args[1])) {
      assert.equal(sessions.filter(s => s.alpha.path === sourceDir).length, 1, 'an orphan cannot survive project activation');
    }
    return { code: 0 };
  };
  await ensureDevTargetSyncProject(input, { runProcess });
  assert.deepEqual(sessions.map(s => s.identifier), ['sync_current', 'sync_other_repository']);
  // A failed termination must preserve the old project and lock; otherwise the
  // next start rotates the lock while its old writers remain alive.
  const before = await readFile(runtime.projectFile, 'utf8');
  await assert.rejects(ensureDevTargetSyncProject({ ...input, targets: [] }, {
    runProcess: async options => options.args[0] === 'project' && options.args[1] === 'terminate'
      ? { code: 7 } : runProcess(options),
  }), /termination|terminate/);
  assert.equal(await readFile(runtime.projectFile, 'utf8'), before);
  assert.equal(await readFile(`${runtime.projectFile}.lock`, 'utf8'), 'proj_current');
});

test('control transport retries a refused multiplex session once without replaying a dispatched command', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-control-mux-' });
  const log = join(root, 'ssh.log');
  const ssh = join(root, 'ssh');
  // A stub executable is the real process boundary; the control launch and
  // diagnostic/retry decisions remain production logic.
  await writeFile(ssh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SSH_TEST_LOG"\nif [ "$SSH_TEST_MODE" = refused ] && ! [ -f "$SSH_TEST_LOG.accepted" ]; then\n  touch "$SSH_TEST_LOG.accepted"\n  printf "%s\\n" "mux_client_request_session: session request failed: Session open refused by peer" >&2\n  exit 255\nfi\nif [ "$SSH_TEST_MODE" = disconnected ]; then exit 255; fi\nprintf "%s\\n" accepted\n');
  await chmod(ssh, 0o700);
  const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, DBUS_SESSION_BUS_ADDRESS: '',
    SSH_TEST_LOG: log, SSH_TEST_MODE: 'refused' };
  const result = await runDevTargetControlProcess({ command: 'ssh', args: ['-F', 'test.config', 'test-target', 'native stop'], env });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /accepted/);
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /ControlMaster=no.*ControlPath=none/);
  const disconnected = await runDevTargetControlProcess({ command: 'ssh', args: ['test-target', 'native stop'],
    env: { ...env, SSH_TEST_MODE: 'disconnected' } });
  assert.equal(disconnected.code, 255);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3, 'an ambiguous disconnect must not replay the operation');
});

test('shared SSH configuration reuses one target transport for controller commands', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-shared-ssh-' });
  const config = join(root, 'worker.config');
  const guestConfig = join(root, 'guest.config');
  const guestControlPath = join(root, 'guest-master');
  await writeFile(config, 'Host worker\n  HostName 192.0.2.1\n  User developer\n');
  await writeFile(guestConfig, `Host guest\n  HostName 192.0.2.2\n  ControlMaster auto\n  ControlPersist 900\n  ControlPath ${guestControlPath}\n`);
  const prepared = await prepareDevTargetOpenSsh({ targets: [
    { ...target, ssh: 'worker', sshConfigFile: config }, { ...target, ssh: 'guest', sshConfigFile: guestConfig },
  ], mutagenDir: root, env: envFor(root) });
  const result = await runDevTargetControlProcess({ command: 'ssh', args: [...prepared.sshArgs, '-G', 'worker'], env: process.env });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^controlmaster auto$/m);
  assert.match(result.out, /^controlpersist 600$/m);
  assert.match(result.out, /^controlpath .*happier-dev-target-/m);
  const guest = await runDevTargetControlProcess({ command: 'ssh', args: [...prepared.sshArgs, '-G', 'guest'], env: process.env });
  assert.equal(guest.code, 0, guest.err);
  assert.match(guest.out, /^hostname 192\.0\.2\.2$/m, 'each Include must apply independently of the previous Host block');
  assert.match(guest.out, /^controlpersist 900$/m, 'explicit guest transport policy wins over generated defaults');
  assert.ok(guest.out.split('\n').includes(`controlpath ${guestControlPath}`));
});

test('sync project waits for its live lifecycle owner beyond the former acquisition deadline', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-owner-lifetime-' });
  const projectFile = projectFor(root);
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let releaseOwner;
  let ownerStarted;
  const held = new Promise(resolve => { releaseOwner = resolve; });
  const started = new Promise(resolve => { ownerStarted = resolve; });
  const owner = withJsonOwnerFileLock(async () => { ownerStarted(); await held; }, {
    lockPath: join(runtimeFor(root).mutagenDir, 'hstack-lifecycle.lock'),
  });
  await started;
  const calls = [];
  const waiting = ensureDevTargetSyncProject({ stackBaseDir: root, sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env: envFor(root) }, {
    runProcess: async input => { calls.push(input); return { code: 0, out: '' }; },
  }).then(value => ({ value }), error => ({ error }));
  try {
    await new Promise(resolve => setImmediate(resolve));
    clock += 31_000;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(calls, [], 'a waiting caller must not mutate the live owner project');
    releaseOwner();
    await owner;
    const result = await waiting;
    assert.equal(result.error, undefined, result.error?.message);
    assert.match(await readFile(projectFile, 'utf8'), /happier-mac/);
  } finally { releaseOwner(); await Promise.allSettled([owner, waiting]); }
});

test('Git-backed project generation syncs all source using only the existing artifact and security policy', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-sync-fail-open-' });
  const sourceDir = fixture.path('source');
  const stackBaseDir = fixture.path('stack');
  for (const directory of ['.git/objects', '.git/refs', 'packages/lib/src']) {
    await mkdir(join(sourceDir, directory), { recursive: true });
  }
  // A real empty Git index supplies the external boundary; no repository work is staged.
  await writeFile(join(sourceDir, '.git/HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  await writeFile(join(sourceDir, 'packages/lib/package.json'), JSON.stringify({ name: '@happier-dev/lib' }));
  await ensureDevTargetSyncProject({ stackBaseDir, sourceDir, targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env: envFor(stackBaseDir) }, {
    // Mutagen is the process boundary; source membership and rendering remain real.
    runProcess: async () => ({ code: 0, out: '' }),
  });
  const rendered = await readFile(runtimeFor(stackBaseDir, sourceDir).projectFile, 'utf8');
  const ignores = rendered.split('\n').filter(line => line.startsWith('        - ')).map(line => JSON.parse(line.slice(10)));
  assert.deepEqual(ignores, DEV_TARGET_MUTAGEN_IGNORE_PATHS);
});

test('controlled runtime borrows the producer synchronization without rewriting or mutating its lifecycle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-borrow-producer-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  const project = renderMutagenProject({ sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO, targets: [target], ownerId: 'producer-dev-owner' });
  await writeFile(projectFile, project);
  const calls = [];
  const borrowed = await ensureDevTargetSyncProject({ stackBaseDir: root, sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target], borrowOnly: true, ownerId: 'consumer-owner', env: envFor(root) }, {
    runProcess: async input => { calls.push(input); return { code: 0, out: JSON.stringify([{ name: resolveMutagenSessionName(target.name), paused: false, status: 'watching', conflicts: [], excludedConflicts: 0,
      successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) }; },
  });
  await borrowed.release('terminate');
  assert.equal(await readFile(projectFile, 'utf8'), project);
  assert.ok(calls.every(input => !input.args.some(arg => ['start', 'resume', 'pause', 'terminate'].includes(arg))));
});

async function writeCriticalScopeStubs(root) {
  const binDir = join(root, 'critical-scope-bin');
  const systemdRunLog = join(root, 'systemd-run.log');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'systemctl'), [
    '#!/bin/sh',
    'if [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then exit 0; fi',
    'if [ "$1" = "--user" ] && [ "$2" = "show" ] && [ "$3" = "happier-critical.slice" ]; then',
    "  printf '%s\\n' 'LoadState=loaded' 'MemoryLow=4294967296'",
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(systemdRunLog)}`,
    'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
    'if [ "$1" = "--" ]; then shift; fi',
    'exec "$@"',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'ps'), '#!/bin/sh\nprintf "0\\n"\n');
  for (const command of ['mutagen', 'ssh']) {
    await writeFile(join(binDir, command), '#!/bin/sh\nexit 0\n');
  }
  await Promise.all(['systemctl', 'systemd-run', 'ps', 'mutagen', 'ssh'].map((command) => (
    chmod(join(binDir, command), 0o755)
  )));
  return { binDir, systemdRunLog };
}

test('dev-target control waits for its configured critical slice beyond the former private query cutoff', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-critical-query-' });
  const { binDir, systemdRunLog } = await writeCriticalScopeStubs(root);
  const path = join(binDir, 'systemctl');
  // systemd is the OS boundary. A healthy property query may take more than
  // one second; the real control owner must still use its configured slice.
  await writeFile(path, '#!/bin/sh\ncase "$*" in *show-environment*) exit 0 ;; *LoadState*) /bin/sleep 1.1; printf "%s\\n" LoadState=loaded MemoryLow=4294967296; exit 0 ;; *) exit 1 ;; esac\n');
  await writeFile(join(binDir, 'cat'), '#!/bin/sh\ncase "$*" in *happier-critical.slice/memory.low*) exit 1 ;; *) exec /bin/cat "$@" ;; esac\n', { mode: 0o755 });
  const result = await runDevTargetControlProcess({
    label: 'critical-query', command: '/usr/bin/printf', args: ['protected-control'],
    env: { ...process.env, ...envFor(root), PATH: `${binDir}:/usr/bin:/bin`, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture' },
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, 'protected-control');
  const scopes = await readFile(systemdRunLog, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  assert.match(scopes, /--slice=happier-critical\.slice/);
});

test('canonical dev-target control runner captures stdout while streaming diagnostics', async () => {
  let output = '';
  const diagnostics = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  const capture = (command, args, options) => runCaptureResult(command, args, {
    ...options, stdoutDiagnosticStream: diagnostics, stderrDiagnosticStream: diagnostics,
  });
  const result = await runDevTargetControlProcess({
    label: 'dev-target-control-test',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("session-json\\n"); process.stderr.write("diagnostic\\n")'],
    env: process.env,
  }, { capture });

  assert.equal(result.code, 0);
  assert.equal(result.out, 'session-json\n');
  assert.equal(result.err, 'diagnostic\n');
  assert.equal(output.split('\n').filter(Boolean).length, 2, 'ordinary command diagnostics still stream');
  output = '';
  const quiet = await runDevTargetControlProcess({
    label: 'dev-target-control-test', command: process.execPath,
    args: ['-e', 'process.stdout.write("session-json\\n"); process.stderr.write("diagnostic\\n")'],
    env: process.env, silent: true,
  }, { capture });
  assert.equal(quiet.code, 0);
  assert.equal(quiet.out, 'session-json\n');
  assert.equal(quiet.err, 'diagnostic\n');
  assert.equal(output, '', 'silent machine-readable probes retain results without publishing raw diagnostic lines');
});

test('runs a future independent Mutagen daemon control launch in the protected critical user slice', async (t) => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
  t.after(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-critical-mutagen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { binDir, systemdRunLog } = await writeCriticalScopeStubs(root);

  const result = await runDevTargetControlProcess({
    label: 'mutagen',
    command: 'mutagen',
    args: ['version'],
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
    },
  });

  assert.equal(result.code, 0);
  assert.match(
    await readFile(systemdRunLog, 'utf8'),
    /--user --scope --quiet --nice=0 --slice=happier-critical\.slice --property=MemoryLow=268435456 --property=CPUWeight=200 --property=IOWeight=200 -- mutagen version/,
  );
});

test('runs Stack outbound SSH control launches in the protected critical user slice', async (t) => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
  t.after(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-critical-ssh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { binDir, systemdRunLog } = await writeCriticalScopeStubs(root);

  const result = await runDevTargetControlProcess({
    label: 'ssh',
    command: 'ssh',
    args: ['guest', 'true'],
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
    },
  });

  assert.equal(result.code, 0);
  assert.match(
    await readFile(systemdRunLog, 'utf8'),
    /--user --scope --quiet --nice=0 --slice=happier-critical\.slice --property=MemoryLow=268435456 --property=CPUWeight=200 --property=IOWeight=200 -- ssh guest true/,
  );
});

async function writeMutagenStatusStub(root) {
  const binDir = join(root, 'bin');
  const scriptPath = join(binDir, 'mutagen-stub.mjs');
  await mkdir(binDir, { recursive: true });
  await writeFile(scriptPath, [
    "const args = process.argv.slice(2);",
    "if (args[0] === 'sync' && args[1] === 'list') {",
    "  const sessionName = args[2];",
    "  process.stderr.write(`status warning for ${sessionName}\\n`);",
    "  if (sessionName === process.env.FAKE_MUTAGEN_FAIL_SESSION) process.exit(7);",
    "  process.stdout.write(`${JSON.stringify([{ name: sessionName, paused: false, status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }])}\\n`);",
    "}",
  ].join('\n'));
  const executablePath = join(binDir, 'mutagen');
  await writeFile(executablePath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`);
  await chmod(executablePath, 0o755);
  await writeFile(
    `${executablePath}.cmd`,
    `@"${process.execPath}" "${scriptPath}" %*\r\n`,
  );
  return binDir;
}

test('independent sync start owns and resumes the canonical Mutagen project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-start-'));
  await writeFile(join(root, 'dev-targets.json'), JSON.stringify({
    version: 3, targets: [target],
    commandExecution: { mode: 'auto', targets: [target.name] },
  }));
  const calls = [];
  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false,
    env: envFor(root),
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      return { code: 0 };
    },
  });

  assert.equal(result.ownership, 'independent');
  assert.match(await readFile(result.projectFile, 'utf8'), /configurationAlpha:\n\s+watch:\n\s+mode: "no-watch"/);
  assert.ok(calls.some(call => call.command === 'mutagen' && call.args[0] === 'project' && call.args[1] === 'start'));
  assert.ok(calls.every(call => call.args[0] !== 'daemon'), 'project ownership never controls the shared daemon');
  assert.match(
    await readFile(result.projectFile, 'utf8'),
    new RegExp(`^# hstack-owner: ${JSON.stringify(INDEPENDENT_DEV_TARGET_SYNC_OWNER)}`),
  );
});

test('source policy replacement does not require a paused replica to become reachable', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-policy-offline-' });
  await writeFile(join(root, 'dev-targets.json'), JSON.stringify({ version: 1, targets: [target] }));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFile), { recursive: true });
  const desired = renderMutagenProject({ sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER });
  const stale = desired.replace('        - "/.project/plans/**/*.ndjson"\n', '');
  assert.notEqual(stale, desired);
  await writeFile(projectFile, stale);
  await writeFile(`${projectFile}.lock`, 'proj-existing-source-replicas');
  const result = await ensureDevTargetSyncProject({ stackBaseDir: root,
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO, targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, allowIndependentBorrow: false, env: envFor(root),
  }, { runProcess: async ({ command, args }) => {
    // Mutagen/SSH are process boundaries. The paused replica cannot complete
    // network synchronization, but its project can still be retired locally.
    if (command === 'mutagen' && args[0] === 'sync') {
      if (args[1] === 'list') return { code: 0, out: JSON.stringify([{
        name: 'happier-mac', paused: true, status: 'disconnected',
        alpha: { protocol: 'local', path: DEV_TARGET_SYNC_EXECUTOR_REPO, connected: false },
        beta: { connected: false },
      }]) };
      return { code: 1 };
    }
    return { code: 0 };
  } });
  assert.equal(result.projectCreated, true);
  assert.equal(await readFile(projectFile, 'utf8'), desired);
});

test('equivalent project keeps reconnecting sessions when project resume reports an offline endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-reconnect-'));
  await writeFile(join(root, 'dev-targets.json'), JSON.stringify({ version: 1, targets: [target] }));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false,
    env: envFor(root),
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      if (args[0] === 'project' && args[1] === 'resume') return { code: 1 };
      if (args[0] === 'sync' && args[1] === 'list') {
        return {
          code: 0,
          out: JSON.stringify([{ name: 'happier-mac', paused: false, status: 'connecting-beta', successfulCycles: 0 }]),
        };
      }
      return { code: 0 };
    },
  });

  assert.equal(result.projectCreated, false);
  assert.equal(calls.some((call) => call.args[1] === 'terminate'), false);
  assert.equal(calls.some((call) => call.args[1] === 'start'), false);
});

test('a project resume failure never restarts the shared daemon hosting other repositories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-ssh-daemon-'));
  await writeFile(join(root, 'dev-targets.json'), JSON.stringify({ version: 1, targets: [target] }));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [{ ...target, sshConfigFile: '/private/lima/ssh.config' }],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];
  let resumeAttempts = 0;

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [{ ...target, sshConfigFile: '/private/lima/ssh.config' }],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false,
    env: envFor(root),
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      if (args[0] === 'project' && args[1] === 'resume') {
        resumeAttempts += 1;
        return { code: resumeAttempts === 1 ? 1 : 0 };
      }
      if (args[0] === 'sync' && args[1] === 'list') {
        return {
          code: 0,
          out: JSON.stringify([{ name: 'happier-mac', paused: false, status: 'connecting-beta', successfulCycles: 0 }]),
        };
      }
      return { code: 0 };
    },
  });

  assert.equal(result.projectCreated, false);
  assert.ok(calls.every(call => call.args[0] !== 'daemon'
    && !['start', 'terminate'].includes(call.args[1])), 'an offline endpoint cannot retire sessions or their daemon');
});

test('Stack borrows an equivalent independent project without changing its lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-borrow-'));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: 123,
    allowIndependentBorrow: true,
    env: envFor(root),
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      return {
        code: 0,
        ...(args[0] === 'sync'
          ? { out: JSON.stringify([{ name: 'happier-mac', paused: false, status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) }
          : {}),
      };
    },
  });

  assert.equal(result.ownership, 'borrowed');
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['list', 'list']);
  await result.release('pause');
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['list', 'list']);
});

test('Stack reports unhealthy borrowed sessions without rejecting the whole independent project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-borrow-partial-health-'));
  const projectFile = projectFor(root);
  const healthyTarget = target;
  const unhealthyTarget = { ...target, name: 'mac2', ssh: 'mac2-ssh' };
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [healthyTarget, unhealthyTarget],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [healthyTarget, unhealthyTarget],
    requiredTargets: [healthyTarget, unhealthyTarget],
    ownerId: 123,
    allowIndependentBorrow: true,
    env: envFor(root),
  }, {
    runProcess: async ({ args }) => ({
      code: 0,
      ...(args[0] === 'sync'
        ? {
            out: JSON.stringify([{
              name: args[2],
              paused: false,
              status: args[2] === 'happier-mac2' ? 'disconnected' : 'watching',
              successfulCycles: args[2] === 'happier-mac2' ? 0 : 1,
              ...(args[2] === 'happier-mac2'
                ? { alpha: { connected: false }, beta: { connected: false } }
                : { alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }),
            }]),
          }
        : {}),
    }),
  });

  assert.equal(result.ownership, 'borrowed');
  assert.deepEqual(result.unhealthyTargets, new Map([['mac2', 'unhealthy']]));
});

test('QA consumers borrow a stale producer project without changing its membership or lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-borrow-stale-'));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFile), { recursive: true });
  const project = renderMutagenProject({ sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO, targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER });
  const staleProject = project.replace('        - "!packages/plugins/*/.happier-plugin/plugin.json"\n', '');
  await writeFile(projectFile, staleProject);
  const calls = [];
  const result = await ensureDevTargetSyncProject({ stackBaseDir: join(root, 'agent-qa'), sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target], ownerId: 123, allowIndependentBorrow: true, env: envFor(root) }, {
    runProcess: async input => { calls.push(input); return { code: 0, out: JSON.stringify([{ name: 'happier-mac', paused: false,
      status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) }; },
  });
  assert.equal(result.ownership, 'borrowed');
  assert.equal(await readFile(projectFile, 'utf8'), staleProject);
  assert.ok(calls.every(input => input.args[1] === 'list'));
  await result.release('terminate');
  assert.ok(calls.every(input => input.args[1] === 'list'));
});

test('sync-service release waits for stale independent reconciliation before changing project ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-lifecycle-lock-'));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  const desiredProject = renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  });
  const staleProject = desiredProject.replace(
    '        - "!packages/plugins/*/.happier-plugin/plugin.json"\n',
    '',
  );
  assert.notEqual(staleProject, desiredProject);
  await writeFile(projectFile, staleProject);

  let allowTermination;
  const terminationAllowed = new Promise((resolve) => { allowTermination = resolve; });
  let terminationStartedResolve;
  const terminationStarted = new Promise((resolve) => { terminationStartedResolve = resolve; });
  let releaseWaitResolve;
  const releaseWait = new Promise((resolve) => { releaseWaitResolve = resolve; });
  let pauseStartedResolve;
  const pauseStarted = new Promise((resolve) => { pauseStartedResolve = resolve; });
  const reconciliationCalls = [];
  const releaseCalls = [];
  let reconciliation;
  let release;
  try {
    reconciliation = ensureDevTargetSyncProject({
      stackBaseDir: root,
      sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
      targets: [target],
      ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
      allowIndependentBorrow: false,
      env: envFor(root),
    }, {
      runProcess: async ({ command, args }) => {
        reconciliationCalls.push({ command, args });
        if (args[0] === 'project' && args[1] === 'terminate') {
          terminationStartedResolve();
          await terminationAllowed;
        }
        return {
          code: 0,
          ...(args[0] === 'sync' && args[1] === 'list'
            ? { out: JSON.stringify([{ name: 'happier-mac', paused: false, status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) }
            : {}),
        };
      },
    });
    await terminationStarted;

    release = releaseIndependentDevTargetSyncProject({ stackBaseDir: root,
      env: { ...envFor(root), HAPPIER_STACK_SYNC_SOURCE_DIR: DEV_TARGET_SYNC_EXECUTOR_REPO } }, {
      runProcess: async ({ command, args }) => {
        releaseCalls.push({ command, args });
        pauseStartedResolve();
        return { code: 0 };
      },
      withProjectLifecycleLock: async (scope, fn) => await withJsonOwnerFileLock(fn, {
        lockPath: join(runtimeFor(scope.stackBaseDir).mutagenDir, 'hstack-lifecycle.lock'),
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        staleAfterMs: 60_000,
        errorLabel: 'test dev-target synchronization project lifecycle lock',
        onWait: releaseWaitResolve,
      }),
    });

    assert.equal(await Promise.race([
      releaseWait.then(() => 'waited'),
      pauseStarted.then(() => 'paused'),
    ]), 'waited');
    assert.deepEqual(releaseCalls, []);
    assert.equal(await readFile(projectFile, 'utf8'), staleProject);

    allowTermination();
    await reconciliation;
    await release;
    assert.deepEqual(
      reconciliationCalls.filter(call => call.command === 'mutagen').map((call) => [call.command, ...call.args.slice(0, 2)]),
      [
        ['mutagen', 'version'],
        ['mutagen', 'sync', 'list'],
        ['mutagen', 'project', 'terminate'],
        ['mutagen', 'project', 'start'],
        ['mutagen', 'project', 'list'],
      ],
    );
    assert.deepEqual(
      releaseCalls.map((call) => [call.command, ...call.args.slice(0, 2)]),
      [['mutagen', 'project', 'pause']],
    );
  } finally {
    allowTermination?.();
    await Promise.allSettled([reconciliation, release].filter(Boolean));
    await rm(root, { recursive: true, force: true });
  }
});

test('a cold QA consumer never creates a daemon, project or sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-cold-consumer-'));
  const calls = [];
  await assert.rejects(ensureDevTargetSyncProject({ stackBaseDir: join(root, 'agent-qa-test'), sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target], ownerId: 123, allowIndependentBorrow: true, env: envFor(root) }, {
    runProcess: async input => { calls.push(input); return { code: 0 }; },
  }), /requires the producer synchronization/);
  assert.deepEqual(calls, []);
  await assert.rejects(readFile(projectFor(root)), { code: 'ENOENT' });
});

test('Stack default runner captures active independent status for every configured target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-default-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = await writeMutagenStatusStub(root);
  const targets = [
    { ...target, name: 'windows', platform: 'windows', ssh: 'windows' },
    target,
    { ...target, name: 'mac2', ssh: 'mac2' },
  ];
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFor(root), renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets,
    ownerId: process.pid,
    allowIndependentBorrow: true,
    env: { ...process.env, ...envFor(root), PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
  });

  assert.equal(result.ownership, 'borrowed');
});

test('Stack default runner exposes a nonzero independent status exit as target unavailability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-default-runner-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = await writeMutagenStatusStub(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFor(root), renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: process.pid,
    allowIndependentBorrow: true,
    env: {
      ...process.env,
      ...envFor(root),
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_MUTAGEN_FAIL_SESSION: 'happier-mac',
    },
  });
  assert.equal(result.ownership, 'borrowed');
  assert.equal(result.unhealthyTargets.get(target.name), 'unavailable');
});

test('independent sync release refuses missing source scope without touching the primary project', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-sync-release-scope-' });
  const primary = projectFor(root);
  const contents = renderMutagenProject({ sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER });
  await mkdir(dirname(primary), { recursive: true });
  await writeFile(primary, contents);
  const calls = [];
  for (const source of [undefined, '', '   ', 'relative-basis']) {
    await assert.rejects(releaseIndependentDevTargetSyncProject({ stackBaseDir: root,
      env: { ...envFor(root), ...(source === undefined ? {} : { HAPPIER_STACK_SYNC_SOURCE_DIR: source }) },
    }, { runProcess: async input => { calls.push(input); return { code: 0 }; } }),
    /HAPPIER_STACK_SYNC_SOURCE_DIR.*absolute/i);
    assert.equal(await readFile(primary, 'utf8'), contents);
  }
  assert.deepEqual(calls, [], 'invalid scope must not reach Mutagen or pause primary');
  const sourceDir = join(root, 'basis');
  const scratch = runtimeFor(root, sourceDir).projectFile;
  await mkdir(dirname(scratch), { recursive: true });
  await writeFile(scratch, renderMutagenProject({ sourceDir,
    targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER }));
  assert.equal(await releaseIndependentDevTargetSyncProject({ stackBaseDir: root,
    env: { ...envFor(root), HAPPIER_STACK_SYNC_SOURCE_DIR: sourceDir },
  }, { runProcess: async input => { calls.push(input); return { code: 0 }; } }), true);
  assert.equal(await readFile(primary, 'utf8'), contents);
  assert.doesNotMatch(await readFile(scratch, 'utf8'), /^# hstack-owner:/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), scratch);
});

test('independent sync stop releases ownership before pausing so interruption cannot advertise stale ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-stop-'));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];

  const released = await releaseIndependentDevTargetSyncProject({
    stackBaseDir: root,
    env: { ...envFor(root), HAPPIER_STACK_SYNC_SOURCE_DIR: DEV_TARGET_SYNC_EXECUTOR_REPO },
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      assert.doesNotMatch(await readFile(projectFile, 'utf8'), /^# hstack-owner:/);
      return { code: 0 };
    },
  });

  assert.equal(released, true);
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['pause']);
  assert.doesNotMatch(await readFile(projectFile, 'utf8'), /^# hstack-owner:/);
});

test('independent sync stop restores ownership when project pause fails normally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-stop-failure-'));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  await assert.rejects(
    releaseIndependentDevTargetSyncProject({
      stackBaseDir: root,
      env: { ...envFor(root), HAPPIER_STACK_SYNC_SOURCE_DIR: DEV_TARGET_SYNC_EXECUTOR_REPO },
    }, {
      runProcess: async () => ({ code: 7 }),
    }),
    /independent Mutagen project pause failed \(code=7\)/,
  );

  assert.match(
    await readFile(projectFile, 'utf8'),
    /^# hstack-owner: "dev-target-sync-service"/,
  );
});

test('independent sync stop leaves ownership released when project pause is interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-stop-interrupted-'));
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  await assert.rejects(
    releaseIndependentDevTargetSyncProject({
      stackBaseDir: root,
      env: { ...envFor(root), HAPPIER_STACK_SYNC_SOURCE_DIR: DEV_TARGET_SYNC_EXECUTOR_REPO },
    }, {
      runProcess: async () => {
        throw new Error('interrupted after launch');
      },
    }),
    /interrupted after launch/,
  );

  assert.doesNotMatch(await readFile(projectFile, 'utf8'), /^# hstack-owner:/);
});

test('owned project pause preserves its owner marker for later resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-owned-pause-'));
  const projectFile = resolveDevTargetMutagenRuntime({ stackBaseDir: root,
    ownerId: 'execution-host-candidate', env: envFor(root) }).projectFile;
  await mkdir(dirname(projectFile), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: 'execution-host-candidate',
  }));
  const calls = [];

  const paused = await pauseOwnedDevTargetSyncProject({
    stackBaseDir: root,
    ownerId: 'execution-host-candidate',
    env: envFor(root),
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      return { code: 0 };
    },
  });

  assert.equal(paused, true);
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['pause']);
  assert.match(await readFile(projectFile, 'utf8'), /^# hstack-owner: "execution-host-candidate"/);
});
