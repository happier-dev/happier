import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import {
  installExecutionHostBackupSchedule,
  inspectExecutionHostBackupSchedule,
  resolveExecutionHostBackupSchedule,
  runExecutionHostBackupSchedule,
} from './backup_schedule.mjs';

function profile(instance = 'happier-dev') {
  return {
    version: 1,
    mode: 'managed-lima',
    activation: 'active',
    instance,
    limaHome: '/Users/leeroy/.happier-stack/lima',
    profile: 'heavy',
    guestWorkspaceDir: '/home/leeroy.guest/.happier-stack/workspace',
    mirrorWorkspaceDir: '/Users/leeroy/.happier-stack/workspace-mirror',
    hostMountDir: '/Users/leeroy/.happier-stack/vm-home',
  };
}

async function writeTargetServerPlacement({ storageRoot, stackName, targetCliHome, version = 3 }) {
  await mkdir(join(storageRoot, stackName), { recursive: true });
  await writeFile(join(storageRoot, stackName, 'dev-targets.json'), `${JSON.stringify({
    version,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/Users/target/happier-dev',
      cliHomeDir: targetCliHome,
    }],
    runtimePlacement: {
      server: { mode: 'prefer-target', target: 'mac-host' },
    },
  }, null, 2)}\n`, 'utf8');
}

async function writeGuestLocalServerPlacement({ guestHome, stackName }) {
  await mkdir(join(guestHome, '.happier', 'stacks', stackName), { recursive: true });
}

function mountedGuestCapture(guestHome, capture) {
  return async (command, args, options = {}) => {
    if (command === 'mount') {
      return { exitCode: 0, out: `happier on ${guestHome} (osxfuse, nodev, nosuid, synchronous)\n`, err: '' };
    }
    if (command === 'ls') {
      assert.deepEqual(args, ['-A', guestHome]);
      return { exitCode: 0, out: '.happier\n', err: '' };
    }
    return await capture(command, args, options);
  };
}

test('backup schedules require explicit stacks and destination root', () => {
  assert.throws(
    () => resolveExecutionHostBackupSchedule({ profile: profile(), stackNames: [], destinationRoot: '/Volumes/backups', intervalHours: 24 }),
    /requires at least one Stack name/i,
  );
  assert.throws(
    () => resolveExecutionHostBackupSchedule({ profile: profile(), stackNames: ['repo-dev-a1cc5e0671'], destinationRoot: '', intervalHours: 24 }),
    /destination root must be an absolute path/,
  );
});

test('backup schedule installs one non-eager LaunchAgent and status inspects every configured Stack', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-schedule-' });
  const homeDir = fixture.path('mac-home');
  const stackHome = fixture.path('stack-home');
  const destinationRoot = fixture.path('backups');
  const hstack = fixture.path('hstack');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(stackHome, { recursive: true }),
    writeFile(hstack, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
  ]);
  await chmod(hstack, 0o755);

  const commands = [];
  const boundary = {
    capture: async (command, args) => {
      commands.push({ command, args });
      return { exitCode: 0, out: '', err: '' };
    },
  };
  const env = { HAPPIER_STACK_HOME_DIR: stackHome };
  const stackNames = ['repo-remote-dev-d72117acdb', 'repo-dev-a1cc5e0671'];

  const installed = await installExecutionHostBackupSchedule({
    profile: profile(),
    env,
    homeDir,
    platform: 'darwin',
    uid: 501,
    boundary,
    programArgs: [hstack, 'dev-vm', 'backup', 'schedule', 'run', '--json'],
    stackNames,
    destinationRoot,
    intervalHours: 24,
  });

  assert.deepEqual(installed.schedule.stackNames, stackNames);
  assert.equal(installed.schedule.retention, 3);
  const saved = JSON.parse(await readFile(installed.paths.configPath, 'utf8'));
  assert.deepEqual(saved.stackNames, stackNames);
  assert.equal(saved.destinationRoot, destinationRoot);
  assert.equal(saved.retention, 3);

  const plist = await readFile(installed.paths.plistPath, 'utf8');
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>86400<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
  assert.match(plist, /schedule\.out\.log/);
  assert.match(plist, /schedule\.err\.log/);
  assert.equal(commands.some(({ command, args }) => command === 'launchctl' && args[0] === 'bootstrap'), true);
  assert.equal(commands.some(({ command, args }) => command === 'launchctl' && args[0] === 'kickstart'), false);

  const status = await inspectExecutionHostBackupSchedule({
    profile: profile(),
    env,
    homeDir,
    platform: 'darwin',
    uid: 501,
    boundary,
  });
  assert.deepEqual(status.stacks.map((stack) => stack.stackName), stackNames);
  assert.equal(status.stacks.some((stack) => stack.stackName === 'main'), false);
  assert.equal(status.launchAgent.loaded, true);
  assert.equal((await readFile(installed.paths.configPath)).length > 0, true);
});

test('backup schedule runs its configured Stacks serially through the canonical backup owner', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-schedule-run-' });
  const homeDir = fixture.path('mac-home');
  const stackHome = fixture.path('stack-home');
  const destinationRoot = fixture.path('backups');
  const hstack = fixture.path('hstack');
  const limaHome = fixture.path('lima');
  const backupProfile = { ...profile(), limaHome, hostMountDir: fixture.path('vm-home') };
  const stackNames = ['repo-remote-dev-d72117acdb', 'repo-dev-a1cc5e0671'];
  await mkdir(join(limaHome, backupProfile.instance), { recursive: true });
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(stackHome, { recursive: true }),
    writeFile(join(limaHome, backupProfile.instance, 'ssh.config'), 'Host lima-happier-dev\n', 'utf8'),
    writeFile(hstack, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
  ]);
  await chmod(hstack, 0o755);
  const env = { HAPPIER_STACK_HOME_DIR: stackHome };
  const launchBoundary = { capture: async () => ({ exitCode: 0, out: '', err: '' }) };
  await installExecutionHostBackupSchedule({
    profile: backupProfile,
    env,
    homeDir,
    platform: 'darwin',
    uid: 501,
    boundary: launchBoundary,
    programArgs: [hstack, 'dev-vm', 'backup', 'schedule', 'run', '--json'],
    stackNames,
    destinationRoot,
    intervalHours: 24,
  });
  await Promise.all(stackNames.map(async (stackName) => {
    await writeGuestLocalServerPlacement({ guestHome: backupProfile.hostMountDir, stackName });
  }));

  const guestActions = [];
  const guestArchives = new Map();
  const executor = {
    capture: async (_command, args) => {
      const pythonIndex = args.indexOf('python3');
      const mode = args[pythonIndex + 1];
      if (mode === '-c') {
        const archivePath = args.at(-1);
        await rm(archivePath, { force: true });
        guestActions.push(`cleanup:${archivePath}`);
        return { exitCode: 0, out: '', err: '' };
      }
      const action = args[pythonIndex + 2];
      const stackName = args[pythonIndex + 3];
      guestActions.push(`${action}:${stackName}`);
      if (action === 'preflight') {
        return {
          exitCode: 0,
          out: JSON.stringify({
            stackName,
            database: { provider: 'sqlite', integrity: 'pending' },
            databaseBytes: 4096,
            treeBytes: 4096,
            archiveMaxBytes: 8192,
            requiredFreeBytes: 12288,
          }),
          err: '',
        };
      }
      const archivePath = `/tmp/happier-dev-vm-backup-schedule-${process.pid}-${stackName}.tar.gz`;
      const contents = `backup:${stackName}`;
      await writeFile(archivePath, contents, 'utf8');
      guestArchives.set(stackName, archivePath);
      return {
        exitCode: 0,
        out: JSON.stringify({
          archivePath,
          archiveBytes: Buffer.byteLength(contents),
          archiveSha256: createHash('sha256').update(contents).digest('hex'),
          stackName,
          database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
          included: [],
        }),
        err: '',
      };
    },
  };
  t.after(async () => {
    await Promise.all([...guestArchives.values()].map((archivePath) => rm(archivePath, { force: true })));
  });
  const backupBoundary = {
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    capture: mountedGuestCapture(backupProfile.hostMountDir, async (command, args) => {
      if (command === 'scp') {
        const source = args.find((argument) => String(argument).startsWith('lima-happier-dev:'));
        await copyFile(String(source).slice(String(source).indexOf(':') + 1), args.at(-1));
        return { exitCode: 0, out: '', err: '' };
      }
      assert.equal(command, 'python3');
      const archiveContents = await readFile(args.at(-1), 'utf8');
      const stackName = archiveContents.slice('backup:'.length);
      return {
        exitCode: 0,
        out: JSON.stringify({
          format: 2,
          stackName,
          archiveBytes: Buffer.byteLength(archiveContents),
          archiveSha256: createHash('sha256').update(archiveContents).digest('hex'),
          database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
          secret: {
            path: 'stack/server-light/handy-master-secret.txt',
            mode: 0o600,
            sha256: createHash('sha256').update('synthetic-secret').digest('hex'),
          },
          entryCount: 2,
        }),
        err: '',
      };
    }),
  };

  const result = await runExecutionHostBackupSchedule({
    profile: backupProfile,
    executor,
    boundary: backupBoundary,
    env,
    homeDir,
  });
  assert.deepEqual(result.stacks.map((stack) => stack.stackName), stackNames);
  assert.equal(result.health.ok, true);
  assert.deepEqual(guestActions.filter((entry) => !entry.startsWith('cleanup:')), [
    `preflight:${stackNames[0]}`,
    `backup:${stackNames[0]}`,
    `preflight:${stackNames[1]}`,
    `backup:${stackNames[1]}`,
  ]);
  assert.equal(guestActions.filter((entry) => entry.startsWith('cleanup:')).length, 2);
  const firstBackup = guestActions.findIndex((entry) => entry === `backup:${stackNames[0]}`);
  const secondPreflight = guestActions.findIndex((entry) => entry === `preflight:${stackNames[1]}`);
  assert.equal(guestActions.slice(firstBackup + 1, secondPreflight).some((entry) => entry.startsWith('cleanup:')), true);
});

test('backup schedule serializes guest and target-placed stacks through the one backup owner', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-schedule-target-source-' });
  const homeDir = fixture.path('mac-home');
  const stackHome = fixture.path('stack-home');
  const stackStorageRoot = fixture.path('stack-storage');
  const destinationRoot = fixture.path('backups');
  const hstack = fixture.path('hstack');
  const limaHome = fixture.path('lima');
  const backupProfile = { ...profile(), limaHome, hostMountDir: fixture.path('vm-home') };
  const stackNames = ['repo-remote-dev-d72117acdb', 'repo-dev-a1cc5e0671'];
  const targetStorageDir = join(fixture.path('target-cli'), 'stack-state');
  await mkdir(join(limaHome, backupProfile.instance), { recursive: true });
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(stackHome, { recursive: true }),
    writeFile(join(limaHome, backupProfile.instance, 'ssh.config'), 'Host lima-happier-dev\n', 'utf8'),
    writeFile(hstack, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
  ]);
  await chmod(hstack, 0o755);
  await writeGuestLocalServerPlacement({
    guestHome: backupProfile.hostMountDir,
    stackName: stackNames[0],
  });
  await writeTargetServerPlacement({
    storageRoot: join(backupProfile.hostMountDir, '.happier', 'stacks'),
    stackName: stackNames[1],
    targetCliHome: fixture.path('target-cli'),
  });
  await mkdir(join(stackStorageRoot, stackNames[1]), { recursive: true });
  await writeFile(join(stackStorageRoot, stackNames[1], 'dev-targets.json'), `${JSON.stringify({
    version: 1,
    targets: [],
  }, null, 2)}\n`, 'utf8');
  const env = {
    HAPPIER_STACK_HOME_DIR: stackHome,
    HAPPIER_STACK_STORAGE_DIR: stackStorageRoot,
  };
  await installExecutionHostBackupSchedule({
    profile: backupProfile,
    env,
    homeDir,
    platform: 'darwin',
    uid: 501,
    boundary: { capture: async () => ({ exitCode: 0, out: '', err: '' }) },
    programArgs: [hstack, 'dev-vm', 'backup', 'schedule', 'run', '--json'],
    stackNames,
    destinationRoot,
    intervalHours: 24,
  });

  const actions = [];
  const temporaryArchives = new Set();
  t.after(async () => {
    await Promise.all([...temporaryArchives].map((archivePath) => rm(archivePath, { force: true })));
  });
  const archiveResult = (stackName, contents, archivePath) => ({
    exitCode: 0,
    out: JSON.stringify({
      archivePath,
      archiveBytes: Buffer.byteLength(contents),
      archiveSha256: createHash('sha256').update(contents).digest('hex'),
      stackName,
      database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
      included: [],
    }),
    err: '',
  });
  const executor = {
    capture: async (_command, args) => {
      const pythonIndex = args.indexOf('python3');
      if (args[pythonIndex + 1] === '-c') {
        const archivePath = args.at(-1);
        await rm(archivePath, { force: true });
        actions.push(`guest:cleanup:${archivePath.includes(stackNames[0]) ? stackNames[0] : stackNames[1]}`);
        return { exitCode: 0, out: '', err: '' };
      }
      const action = args[pythonIndex + 2];
      const stackName = args[pythonIndex + 3];
      actions.push(`guest:${action}:${stackName}`);
      if (action === 'preflight') {
        return {
          exitCode: 0,
          out: JSON.stringify({
            stackName,
            database: { provider: 'sqlite', integrity: 'pending' },
            databaseBytes: 4096,
            treeBytes: 4096,
            archiveMaxBytes: 8192,
            requiredFreeBytes: 12288,
          }),
          err: '',
        };
      }
      const archivePath = `/tmp/happier-dev-vm-backup-schedule-guest-${stackName}.tar.gz`;
      const contents = `guest:${stackName}`;
      temporaryArchives.add(archivePath);
      await writeFile(archivePath, contents, 'utf8');
      return archiveResult(stackName, contents, archivePath);
    },
  };
  const boundary = {
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    capture: mountedGuestCapture(backupProfile.hostMountDir, async (command, args, options = {}) => {
      if (command === 'scp') {
        const source = args.find((argument) => String(argument).startsWith('lima-happier-dev:'));
        await copyFile(String(source).slice(String(source).indexOf(':') + 1), args.at(-1));
        return { exitCode: 0, out: '', err: '' };
      }
      assert.equal(command, 'python3');
      const action = args[1];
      if (action === 'preflight') {
        assert.equal(options.env?.HAPPIER_STACK_STORAGE_DIR, targetStorageDir);
        actions.push(`target:preflight:${args[2]}`);
        return {
          exitCode: 0,
          out: JSON.stringify({
            stackName: args[2],
            database: { provider: 'sqlite', integrity: 'pending' },
            databaseBytes: 4096,
            treeBytes: 4096,
            archiveMaxBytes: 8192,
            requiredFreeBytes: 12288,
          }),
          err: '',
        };
      }
      if (action === 'backup') {
        assert.equal(options.env?.HAPPIER_STACK_STORAGE_DIR, targetStorageDir);
        actions.push(`target:backup:${args[2]}`);
        const archivePath = `/tmp/happier-dev-vm-backup-schedule-target-${args[2]}.tar.gz`;
        const contents = `target:${args[2]}`;
        temporaryArchives.add(archivePath);
        await writeFile(archivePath, contents, 'utf8');
        return archiveResult(args[2], contents, archivePath);
      }
      assert.equal(action, 'inspect');
      const contents = await readFile(args.at(-1), 'utf8');
      const stackName = contents.slice(contents.indexOf(':') + 1);
      return {
        exitCode: 0,
        out: JSON.stringify({
          format: 2,
          stackName,
          archiveBytes: Buffer.byteLength(contents),
          archiveSha256: createHash('sha256').update(contents).digest('hex'),
          database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
          secret: {
            path: 'stack/server-light/handy-master-secret.txt',
            mode: 0o600,
            sha256: createHash('sha256').update('synthetic-secret').digest('hex'),
          },
          entryCount: 2,
        }),
        err: '',
      };
    }),
  };

  const result = await runExecutionHostBackupSchedule({
    profile: backupProfile,
    executor,
    boundary,
    env,
    homeDir,
  });

  assert.deepEqual(result.health, { ok: true, code: 'ready' });
  assert.deepEqual(result.stacks.map((stack) => stack.backup.source), [
    { authority: 'guest-config', placement: 'guest' },
    { authority: 'guest-config', placement: 'target', target: 'mac-host' },
  ]);
  assert.deepEqual(actions, [
    `guest:preflight:${stackNames[0]}`,
    `guest:backup:${stackNames[0]}`,
    `guest:cleanup:${stackNames[0]}`,
    `target:preflight:${stackNames[1]}`,
    `target:backup:${stackNames[1]}`,
  ]);
});

test('a scheduled target failure leaves a prior guest archive stale instead of reporting it ready', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-schedule-stale-source-' });
  const homeDir = fixture.path('mac-home');
  const stackHome = fixture.path('stack-home');
  const stackStorageRoot = fixture.path('stack-storage');
  const destinationRoot = fixture.path('backups');
  const hstack = fixture.path('hstack');
  const limaHome = fixture.path('lima');
  const backupProfile = { ...profile(), limaHome, hostMountDir: fixture.path('vm-home') };
  const stackName = 'repo-dev-a1cc5e0671';
  const destination = join(destinationRoot, stackName);
  const archiveName = 'dev-vm-backup-1-00000000-0000-0000-0000-000000000000.tar.gz';
  const archivePath = join(destination, archiveName);
  await mkdir(join(limaHome, backupProfile.instance), { recursive: true });
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(stackHome, { recursive: true }),
    mkdir(destination, { recursive: true }),
    writeFile(join(limaHome, backupProfile.instance, 'ssh.config'), 'Host lima-happier-dev\n', 'utf8'),
    writeFile(hstack, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
  ]);
  await Promise.all([
    writeFile(archivePath, 'prior guest backup\n', 'utf8'),
    writeFile(join(destination, 'latest.json'), `${JSON.stringify({
      archivePath,
      archiveName,
      createdAt: '2026-08-27T00:00:00.000Z',
      stackName,
      database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
      archiveSha256: 'a'.repeat(64),
      included: [],
      source: { authority: 'guest-config', placement: 'guest' },
    })}\n`, 'utf8'),
  ]);
  await chmod(hstack, 0o755);
  await writeTargetServerPlacement({
    storageRoot: join(backupProfile.hostMountDir, '.happier', 'stacks'),
    stackName,
    targetCliHome: fixture.path('target-cli'),
  });
  await mkdir(join(stackStorageRoot, stackName), { recursive: true });
  await writeFile(join(stackStorageRoot, stackName, 'dev-targets.json'), `${JSON.stringify({
    version: 1,
    targets: [],
  }, null, 2)}\n`, 'utf8');
  const env = {
    HAPPIER_STACK_HOME_DIR: stackHome,
    HAPPIER_STACK_STORAGE_DIR: stackStorageRoot,
  };
  await installExecutionHostBackupSchedule({
    profile: backupProfile,
    env,
    homeDir,
    platform: 'darwin',
    uid: 501,
    boundary: { capture: async () => ({ exitCode: 0, out: '', err: '' }) },
    programArgs: [hstack, 'dev-vm', 'backup', 'schedule', 'run', '--json'],
    stackNames: [stackName],
    destinationRoot,
    intervalHours: 24,
  });

  let guestCalls = 0;
  const run = await runExecutionHostBackupSchedule({
    profile: backupProfile,
    executor: {
      capture: async () => {
        guestCalls += 1;
        throw new Error('guest backup must not run when a target is authoritative');
      },
    },
    boundary: {
      capture: mountedGuestCapture(backupProfile.hostMountDir, async (_command, args) => {
        assert.equal(args[1], 'preflight');
        return { exitCode: 1, out: '', err: 'target state is unavailable' };
      }),
    },
    env,
    homeDir,
  });
  assert.deepEqual(run.health, { ok: false, code: 'failed' });
  assert.equal(guestCalls, 0);

  const status = await inspectExecutionHostBackupSchedule({
    profile: backupProfile,
    env,
    homeDir,
    platform: 'darwin',
    uid: 501,
    boundary: {
      capture: mountedGuestCapture(backupProfile.hostMountDir, async () => ({ exitCode: 0, out: '', err: '' })),
    },
  });
  assert.deepEqual(status.stacks[0].source, { authority: 'guest-config', placement: 'target', target: 'mac-host' });
  assert.deepEqual(status.stacks[0].latest.source, { authority: 'guest-config', placement: 'guest' });
  assert.deepEqual(status.health, { ok: false, code: 'stack_source_stale' });
});
