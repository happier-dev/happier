import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';

import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import {
  INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  ensureDevTargetSyncProject,
  pauseOwnedDevTargetSyncProject,
  releaseIndependentDevTargetSyncProject,
  runDevTargetControlProcess,
  prepareDevTargetOpenSsh,
} from './sync_project.mjs';
import { DEV_TARGET_SYNC_EXECUTOR_REPO, DEV_TARGET_MUTAGEN_IGNORE_PATHS, renderMutagenProject, resolveMutagenSessionName } from './mutagen_project.mjs';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

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
  const result = await runDevTargetControlProcess({
    label: 'dev-target-control-test',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("session-json\\n"); process.stderr.write("diagnostic\\n")'],
    env: process.env,
  });

  assert.equal(result.code, 0);
  assert.equal(result.out, 'session-json\n');
  assert.equal(result.err, 'diagnostic\n');
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
  assert.deepEqual(
    calls.filter((call) => call.command === 'mutagen').map((call) => call.args[1] ?? call.args[0]),
    ['version', 'terminate', 'start', 'list'],
  );
  assert.match(
    await readFile(result.projectFile, 'utf8'),
    new RegExp(`^# hstack-owner: ${JSON.stringify(INDEPENDENT_DEV_TARGET_SYNC_OWNER)}`),
  );
});

test('equivalent project keeps reconnecting sessions when project resume reports an offline endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-reconnect-'));
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
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args.slice(0, 2)]),
    [
      ['mutagen', 'version'],
      ['mutagen', 'project', 'resume'],
      ['mutagen', 'sync', 'list'],
      ['mutagen', 'project', 'list'],
    ],
  );
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
  const staleProject = project.replace('        - "packages/plugins/*/.happier-plugin"\n', '');
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
    '        - "packages/plugins/*/.happier-plugin"\n',
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

    release = releaseIndependentDevTargetSyncProject({ stackBaseDir: root, env: envFor(root) }, {
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
      reconciliationCalls.map((call) => [call.command, ...call.args.slice(0, 2)]),
      [
        ['mutagen', 'version'],
        ['mutagen', 'sync', 'list'],
        ['mutagen', 'sync', 'resume'],
        ['mutagen', 'sync', 'flush'],
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

test('Stack default runner preserves a nonzero independent status exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-default-runner-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = await writeMutagenStatusStub(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
  await writeFile(projectFor(root), renderMutagenProject({
    sourceDir: DEV_TARGET_SYNC_EXECUTOR_REPO,
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  await assert.rejects(
    ensureDevTargetSyncProject({
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
    }),
    /mac independent synchronization status failed \(code=7\)/,
  );
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
    env: envFor(root),
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
      env: envFor(root),
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
      env: envFor(root),
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
  const projectFile = projectFor(root);
  await mkdir(dirname(projectFor(root)), { recursive: true });
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
