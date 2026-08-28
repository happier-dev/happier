import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import {
  INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  ensureDevTargetSyncProject,
  pauseOwnedDevTargetSyncProject,
  releaseIndependentDevTargetSyncProject,
  runDevTargetControlProcess,
} from './sync_project.mjs';
import { renderMutagenProject } from './mutagen_project.mjs';

const target = {
  name: 'mac',
  platform: 'posix',
  ssh: 'mac',
  repoDir: '/Users/dev/happier',
  cliHomeDir: '/Users/dev/.happier',
};

async function writeCriticalScopeStubs(root) {
  const binDir = join(root, 'critical-scope-bin');
  const systemdRunLog = join(root, 'systemd-run.log');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'systemctl'), [
    '#!/bin/sh',
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
  for (const command of ['mutagen', 'ssh']) {
    await writeFile(join(binDir, command), '#!/bin/sh\nexit 0\n');
  }
  await Promise.all(['systemctl', 'systemd-run', 'mutagen', 'ssh'].map((command) => (
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
    /--user --scope --quiet --slice=happier-critical\.slice -- mutagen version/,
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
    /--user --scope --quiet --slice=happier-critical\.slice -- ssh guest true/,
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
    "  process.stdout.write(`${JSON.stringify([{ name: sessionName, status: 'watching', successfulCycles: 1 }])}\\n`);",
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
          out: JSON.stringify([{ name: 'happier-mac', status: 'connecting-beta', successfulCycles: 0 }]),
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
          out: JSON.stringify([{ name: 'happier-mac', status: 'connecting-beta', successfulCycles: 0 }]),
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
          ? { out: JSON.stringify([{ name: 'happier-mac', status: 'watching', successfulCycles: 1 }]) }
          : {}),
      };
    },
  });

  assert.equal(result.ownership, 'independent');
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['version', 'list', 'list']);
  await result.release('pause');
  assert.deepEqual(calls.map((call) => call.args[1] ?? call.args[0]), ['version', 'list', 'list']);
});

test('Stack refuses to replace a changed independent project owned by the sync service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-project-refresh-independent-'));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const calls = [];
  const refreshedTarget = { ...target, repoDir: '/remote/happier-refreshed' };

  await assert.rejects(
    ensureDevTargetSyncProject({
      stackBaseDir: root,
      sourceDir: '/source/happier',
      targets: [refreshedTarget],
      ownerId: 123,
      allowIndependentBorrow: true,
      env: {},
    }, {
      runProcess: async ({ command, args }) => {
        calls.push({ command, args });
        return { code: 0 };
      },
    }),
    /independent synchronization project configuration differs/,
  );

  assert.match(
    await readFile(projectFile, 'utf8'),
    new RegExp(`^# hstack-owner: ${JSON.stringify(INDEPENDENT_DEV_TARGET_SYNC_OWNER)}`),
  );
  assert.doesNotMatch(await readFile(projectFile, 'utf8'), /happier-refreshed/);
  assert.deepEqual(
    calls.filter((call) => call.command === 'mutagen').map((call) => call.args[1] ?? call.args[0]),
    ['version'],
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
