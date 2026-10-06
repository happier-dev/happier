import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import {
  INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  ensureDevTargetSyncProject,
  pauseOwnedDevTargetSyncProject,
  releaseIndependentDevTargetSyncProject,
  runDevTargetControlProcess,
} from './sync_project.mjs';
import { DEV_TARGET_MUTAGEN_IGNORE_PATHS, renderMutagenProject, resolveMutagenSessionName } from './mutagen_project.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

const target = {
  name: 'mac',
  platform: 'posix',
  ssh: 'mac',
  repoDir: '/Users/dev/happier',
  cliHomeDir: '/Users/dev/.happier',
};

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
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER, env: {} }, {
    // Mutagen is the process boundary; source membership and rendering remain real.
    runProcess: async () => ({ code: 0, out: '' }),
  });
  const rendered = await readFile(join(stackBaseDir, 'mutagen/mutagen.yml'), 'utf8');
  const ignores = rendered.split('\n').filter(line => line.startsWith('        - ')).map(line => JSON.parse(line.slice(10)));
  assert.deepEqual(ignores, DEV_TARGET_MUTAGEN_IGNORE_PATHS);
});

test('controlled runtime borrows the producer synchronization without rewriting or mutating its lifecycle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-borrow-producer-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectFile = join(root, 'mutagen/mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  const project = renderMutagenProject({ sourceDir: '/source/repo', targets: [target], ownerId: 'producer-dev-owner' });
  await writeFile(projectFile, project);
  const calls = [];
  const borrowed = await ensureDevTargetSyncProject({ stackBaseDir: root, sourceDir: '/source/repo',
    targets: [target], borrowOnly: true, ownerId: 'consumer-owner', env: {} }, {
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
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false,
    env: {},
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      return { code: 0 };
    },
  });

  assert.equal(result.ownership, 'owned');
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
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false,
    env: {},
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

test('equivalent project restarts its isolated Mutagen daemon once when custom SSH resume fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-ssh-daemon-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [{ ...target, sshConfigFile: '/private/lima/ssh.config' }],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];
  let resumeAttempts = 0;

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets: [{ ...target, sshConfigFile: '/private/lima/ssh.config' }],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false,
    env: {},
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
      ['mutagen', 'daemon', 'stop'],
      ['mutagen', 'project', 'resume'],
      ['mutagen', 'sync', 'list'],
      ['mutagen', 'project', 'list'],
    ],
  );
});

test('Stack borrows an equivalent independent project without changing its lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-borrow-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: 123,
    allowIndependentBorrow: true,
    env: {},
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

  assert.equal(result.ownership, 'independent');
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['version', 'list', 'list']);
  await result.release('pause');
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['version', 'list', 'list']);
});

test('Stack reports unhealthy borrowed sessions without rejecting the whole independent project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-borrow-partial-health-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  const healthyTarget = target;
  const unhealthyTarget = { ...target, name: 'mac2', ssh: 'mac2-ssh' };
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [healthyTarget, unhealthyTarget],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets: [healthyTarget, unhealthyTarget],
    requiredTargets: [healthyTarget, unhealthyTarget],
    ownerId: 123,
    allowIndependentBorrow: true,
    env: {},
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

  assert.equal(result.ownership, 'independent');
  assert.deepEqual(result.unhealthyTargets, new Map([['mac2', 'unhealthy']]));
});

test('Stack reconciles a stale independent project owned by the sync service and leaves it borrowable after the old project stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-refresh-independent-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  const desiredProject = renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  });
  const staleProject = desiredProject.replace(
    '        - "packages/plugins/*/.happier-plugin"\n',
    '',
  );
  assert.notEqual(staleProject, desiredProject);
  await writeFile(projectFile, staleProject);
  const calls = [];
  let projectPaused = false;

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: 123,
    allowIndependentBorrow: true,
    env: {},
  }, {
    runProcess: async ({ command, args }) => {
      calls.push({ command, args });
      if (args[0] === 'project' && args[1] === 'start') {
        assert.equal(args.includes('--paused'), true);
        projectPaused = true;
      }
      if (args[0] === 'project' && args[1] === 'resume') {
        assert.equal(projectPaused, true);
        projectPaused = false;
      }
      return {
        code: args[0] === 'project' && args[1] === 'terminate' ? 1 : 0,
        ...(args[0] === 'sync' && args[1] === 'list'
          ? {
              out: JSON.stringify([{
                name: 'happier-mac',
                paused: projectPaused,
                status: 'watching',
                successfulCycles: 1,
                ...(projectPaused
                  ? { alpha: { connected: false }, beta: { connected: false } }
                  : { alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }),
              }]),
            }
          : {}),
      };
    },
  });

  assert.equal(result.ownership, 'independent');
  assert.deepEqual(result.unhealthyTargets, new Map());
  const reconciledProject = await readFile(projectFile, 'utf8');
  assert.equal(reconciledProject, desiredProject);
  assert.match(reconciledProject, new RegExp(
    `^# hstack-owner: ${JSON.stringify(INDEPENDENT_DEV_TARGET_SYNC_OWNER)}`,
  ));
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args.slice(0, 2)]),
    [
      ['mutagen', 'version'],
      ['mutagen', 'project', 'terminate'],
      ['mutagen', 'project', 'start'],
      ['mutagen', 'project', 'resume'],
      ['mutagen', 'project', 'list'],
      ['mutagen', 'sync', 'list'],
    ],
  );
  const callsBeforeRelease = calls.length;
  await result.release('pause');
  assert.equal(calls.length, callsBeforeRelease);
});

test('sync-service release waits for stale independent reconciliation before changing project ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-lifecycle-lock-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  const desiredProject = renderMutagenProject({
    sourceDir: '/source/happier',
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
      sourceDir: '/source/happier',
      targets: [target],
      ownerId: 123,
      allowIndependentBorrow: true,
      env: {},
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

    release = releaseIndependentDevTargetSyncProject({ stackBaseDir: root, env: {} }, {
      runProcess: async ({ command, args }) => {
        releaseCalls.push({ command, args });
        pauseStartedResolve();
        return { code: 0 };
      },
      withProjectLifecycleLock: async (scope, fn) => await withJsonOwnerFileLock(fn, {
        lockPath: `${join(scope.stackBaseDir, 'mutagen', 'mutagen.yml')}.hstack-lifecycle.lock`,
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
        ['mutagen', 'project', 'terminate'],
        ['mutagen', 'project', 'start'],
        ['mutagen', 'project', 'resume'],
        ['mutagen', 'project', 'list'],
        ['mutagen', 'sync', 'list'],
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

test('Stack fails closed when independent ownership changes while reconciling a stale project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-refresh-race-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  const desiredProject = renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  });
  const staleProject = desiredProject.replace(
    '        - "packages/plugins/*/.happier-plugin"\n',
    '',
  );
  assert.notEqual(staleProject, desiredProject);
  await writeFile(projectFile, staleProject);
  const replacementProject = renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: 123,
  });
  const calls = [];

  await assert.rejects(
    ensureDevTargetSyncProject({
      stackBaseDir: root,
      sourceDir: '/source/happier',
      targets: [target],
      ownerId: 123,
      allowIndependentBorrow: true,
      env: {},
    }, {
      runProcess: async ({ command, args }) => {
        calls.push({ command, args });
        if (args[0] === 'project' && args[1] === 'terminate') {
          await writeFile(projectFile, replacementProject);
        }
        return { code: 0 };
      },
    }),
    /independent synchronization ownership changed during Stack startup/,
  );

  assert.equal(await readFile(projectFile, 'utf8'), replacementProject);
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args.slice(0, 2)]),
    [
      ['mutagen', 'version'],
      ['mutagen', 'project', 'terminate'],
    ],
  );
});

test('Stack refuses destructive fallback when independent ownership appears during ensure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-raced-independent-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: 123,
  }));
  const calls = [];

  await assert.rejects(
    ensureDevTargetSyncProject({
      stackBaseDir: root,
      sourceDir: '/source/happier',
      targets: [target],
      ownerId: 123,
      allowIndependentBorrow: true,
      env: {},
    }, {
      runProcess: async ({ command, args }) => {
        calls.push({ command, args });
        if (args[0] === 'sync' && args[1] === 'list') {
          await writeFile(projectFile, renderMutagenProject({
            sourceDir: '/source/happier',
            targets: [target],
            ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
          }));
        }
        return { code: args[0] === 'version' ? 0 : 1 };
      },
    }),
    /independent synchronization ownership changed during Stack startup/,
  );

  assert.equal(calls.some((call) => call.args[1] === 'terminate'), false);
  assert.match(
    await readFile(projectFile, 'utf8'),
    /^# hstack-owner: "dev-target-sync-service"/,
  );
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
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(join(root, 'mutagen', 'mutagen.yml'), renderMutagenProject({
    sourceDir: '/source/happier',
    targets,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  const result = await ensureDevTargetSyncProject({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets,
    ownerId: process.pid,
    allowIndependentBorrow: true,
    env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
  });

  assert.equal(result.ownership, 'independent');
});

test('Stack default runner preserves a nonzero independent status exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-default-runner-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = await writeMutagenStatusStub(root);
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(join(root, 'mutagen', 'mutagen.yml'), renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  await assert.rejects(
    ensureDevTargetSyncProject({
      stackBaseDir: root,
      sourceDir: '/source/happier',
      targets: [target],
      ownerId: process.pid,
      allowIndependentBorrow: true,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        FAKE_MUTAGEN_FAIL_SESSION: 'happier-mac',
      },
    }),
    /mac independent synchronization status failed \(code=7\)/,
  );
});

test('independent sync stop releases ownership before pausing so interruption cannot advertise stale ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-stop-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];

  const released = await releaseIndependentDevTargetSyncProject({
    stackBaseDir: root,
    env: {},
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
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  await assert.rejects(
    releaseIndependentDevTargetSyncProject({
      stackBaseDir: root,
      env: {},
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
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));

  await assert.rejects(
    releaseIndependentDevTargetSyncProject({
      stackBaseDir: root,
      env: {},
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
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: 'execution-host-candidate',
  }));
  const calls = [];

  const paused = await pauseOwnedDevTargetSyncProject({
    stackBaseDir: root,
    ownerId: 'execution-host-candidate',
    env: {},
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
