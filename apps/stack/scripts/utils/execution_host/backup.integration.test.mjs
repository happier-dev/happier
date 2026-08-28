import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, statfs, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { runCommandCapture } from '../../testkit/core/run_node_capture.mjs';
import {
  createExecutionHostBackup,
  inspectExecutionHostBackup,
  resolveExecutionHostBackupSource,
  resolveExecutionHostBackupPaths,
} from './backup.mjs';
import { resolveRemoteStackStatePaths } from '../dev_targets/remote_commands.mjs';
import * as executionHostBackup from './backup.mjs';

function waitForWriterReady(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) resolvePromise();
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      reject(new Error(`SQLite writer exited before ready (${code}): ${stderr}`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise();
    child.once('close', resolvePromise);
  });
}

function guestProfile(limaHome) {
  return {
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'happier-agent-primary',
    limaHome,
    profile: 'balanced',
    guestWorkspaceDir: '/home/leeroy.guest/.happier-stack/workspace',
    mirrorWorkspaceDir: '/Users/leeroy/.happier-stack/workspace-mirror',
    hostMountDir: '/Users/leeroy/.happier-stack/vm-home',
  };
}

async function writeTargetServerPlacement({
  storageRoot,
  stackName = 'main',
  version = 2,
  target = {},
} = {}) {
  const configuredTarget = {
    name: 'mac-host',
    platform: 'posix',
    ssh: 'mac-host',
    repoDir: '/Users/target/happier-dev',
    cliHomeDir: '/Users/target/.happier/dev-targets/mac-host',
    ...target,
  };
  await mkdir(join(storageRoot, stackName), { recursive: true });
  await writeFile(join(storageRoot, stackName, 'dev-targets.json'), `${JSON.stringify({
    version,
    targets: [configuredTarget],
    runtimePlacement: {
      server: { mode: 'prefer-target', target: configuredTarget.name },
    },
  }, null, 2)}\n`, 'utf8');
  return configuredTarget;
}

function mountedGuestBoundary(guestHome, capture = async (command) => {
  throw new Error(`unexpected command: ${command}`);
}) {
  return {
    capture: async (command, args, options = {}) => {
      if (command === 'mount') {
        return { exitCode: 0, out: `happier on ${guestHome} (osxfuse, nodev, nosuid, synchronous)\n`, err: '' };
      }
      if (command === 'ls') {
        assert.deepEqual(args, ['-A', guestHome]);
        return { exitCode: 0, out: '', err: '' };
      }
      return await capture(command, args, options);
    },
  };
}

test('active execution-host backups resolve server placement from the mounted guest configuration', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-guest-config-authority-' });
  const macStorageRoot = fixture.path('mac-stack-storage');
  const guestHome = fixture.path('vm-home');
  const targetCliHome = fixture.path('authoritative-target-cli');
  const profile = {
    ...guestProfile(fixture.path('lima')),
    activation: 'active',
    hostMountDir: guestHome,
  };
  await mkdir(join(macStorageRoot, 'main'), { recursive: true });
  await writeFile(join(macStorageRoot, 'main', 'dev-targets.json'), `${JSON.stringify({
    version: 1,
    targets: [],
  }, null, 2)}\n`, 'utf8');
  const configuredTarget = await writeTargetServerPlacement({
    storageRoot: join(guestHome, '.happier', 'stacks'),
    target: { cliHomeDir: targetCliHome },
  });
  const remoteState = resolveRemoteStackStatePaths(configuredTarget, { stackName: 'main' });

  const source = await resolveExecutionHostBackupSource({
    profile,
    stackName: 'main',
    env: {
      HAPPIER_STACK_HOME_DIR: fixture.path('mac-home'),
      HAPPIER_STACK_STORAGE_DIR: macStorageRoot,
    },
    boundary: mountedGuestBoundary(guestHome),
  });

  assert.deepEqual(source, {
    authority: 'guest-config',
    placement: 'target',
    target: 'mac-host',
    stackStorageDir: remoteState.stackStorageDir,
    stackStateDir: remoteState.stackBaseDir,
  });
});

test('active execution-host backups retain v1 guest placement when its mounted config is absent', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-guest-config-v1-' });
  const macStorageRoot = fixture.path('mac-stack-storage');
  const guestHome = fixture.path('vm-home');
  await writeTargetServerPlacement({
    storageRoot: macStorageRoot,
    target: { cliHomeDir: fixture.path('stale-mac-target-cli') },
  });
  await mkdir(join(guestHome, '.happier', 'stacks', 'main'), { recursive: true });

  const source = await resolveExecutionHostBackupSource({
    profile: {
      ...guestProfile(fixture.path('lima')),
      activation: 'active',
      hostMountDir: guestHome,
    },
    stackName: 'main',
    env: {
      HAPPIER_STACK_HOME_DIR: fixture.path('mac-home'),
      HAPPIER_STACK_STORAGE_DIR: macStorageRoot,
    },
    boundary: mountedGuestBoundary(guestHome),
  });

  assert.deepEqual(source, { authority: 'guest-config', placement: 'guest' });
});

test('active execution-host backups fail closed when the guest configuration transport is unavailable', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-guest-config-unavailable-' });
  let guestCalls = 0;
  await assert.rejects(
    () => createExecutionHostBackup({
      profile: {
        ...guestProfile(fixture.path('lima')),
        activation: 'active',
        hostMountDir: fixture.path('vm-home'),
      },
      executor: {
        capture: async () => {
          guestCalls += 1;
          throw new Error('guest snapshot must not run without authoritative placement');
        },
      },
      boundary: {
        availableBytes: async () => Number.MAX_SAFE_INTEGER,
        capture: async (command) => {
          if (command === 'mount') return { exitCode: 0, out: '', err: '' };
          if (command === 'sshfs') return { exitCode: 0, out: 'SSHFS version 3\n', err: '' };
          throw new Error(`unexpected command: ${command}`);
        },
      },
      env: { HAPPIER_STACK_HOME_DIR: fixture.path('mac-home') },
      destination: fixture.path('backups'),
    }),
    /authoritative guest dev-target configuration is unavailable/,
  );
  assert.equal(guestCalls, 0);
});

test('target-placed v2 and v3 backups snapshot the configured target without invoking the guest', async (t) => {
  for (const version of [2, 3]) {
    await t.test(`version ${version}`, async (subtest) => {
      const fixture = await createTempFixture(subtest, { prefix: `execution-host-target-backup-v${version}-` });
      const limaHome = fixture.path('lima');
      const destination = fixture.path('backups');
      const storageRoot = fixture.path('stack-storage');
      const guestHome = fixture.path('vm-home');
      const targetCliHome = fixture.path('target-cli');
      const targetStorageDir = join(targetCliHome, 'stack-state');
      const sourceArchive = `/tmp/happier-dev-vm-backup-target-${process.pid}-${version}.tar.gz`;
      const archiveContents = `target-backup:${version}`;
      await mkdir(join(limaHome, 'happier-agent-primary'), { recursive: true });
      await writeFile(join(limaHome, 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8');
      await writeTargetServerPlacement({
        storageRoot: join(guestHome, '.happier', 'stacks'),
        version,
        target: { cliHomeDir: targetCliHome },
      });
      await mkdir(join(storageRoot, 'main'), { recursive: true });
      await writeFile(join(storageRoot, 'main', 'dev-targets.json'), `${JSON.stringify({
        version: 1,
        targets: [],
      }, null, 2)}\n`, 'utf8');
      subtest.after(async () => {
        await rm(sourceArchive, { force: true });
      });

      let guestCalls = 0;
      const targetActions = [];
      const boundary = {
        availableBytes: async () => Number.MAX_SAFE_INTEGER,
        capture: mountedGuestBoundary(guestHome, async (command, args, options = {}) => {
          assert.equal(command, 'python3');
          const action = args[1];
          if (action === 'preflight' || action === 'backup') {
            assert.equal(options.env?.TMPDIR, '/tmp');
          }
          targetActions.push({ action, storageDir: options.env?.HAPPIER_STACK_STORAGE_DIR });
          if (action === 'preflight') {
            assert.equal(options.env?.HAPPIER_STACK_STORAGE_DIR, targetStorageDir);
            return {
              exitCode: 0,
              out: JSON.stringify({
                stackName: 'main',
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
            await writeFile(sourceArchive, archiveContents, 'utf8');
            return {
              exitCode: 0,
              out: JSON.stringify({
                archivePath: sourceArchive,
                archiveBytes: Buffer.byteLength(archiveContents),
                archiveSha256: createHash('sha256').update(archiveContents).digest('hex'),
                stackName: 'main',
                database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
                included: [],
              }),
              err: '',
            };
          }
          assert.equal(action, 'inspect');
          return {
            exitCode: 0,
            out: JSON.stringify({
              format: 2,
              stackName: 'main',
              archiveBytes: Buffer.byteLength(archiveContents),
              archiveSha256: createHash('sha256').update(archiveContents).digest('hex'),
              database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
              secret: {
                path: 'stack/server-light/handy-master-secret.txt',
                mode: 0o600,
                sha256: createHash('sha256').update('target-secret').digest('hex'),
              },
              entryCount: 2,
            }),
            err: '',
          };
        }).capture,
      };
      const env = {
        HAPPIER_STACK_HOME_DIR: fixture.path('mac-home'),
        HAPPIER_STACK_STORAGE_DIR: storageRoot,
      };
      const backup = await createExecutionHostBackup({
        profile: { ...guestProfile(limaHome), activation: 'active', hostMountDir: guestHome },
        executor: {
          capture: async () => {
            guestCalls += 1;
            throw new Error('guest backup must not run for a target-placed server');
          },
        },
        boundary,
        env,
        destination,
      });

      assert.equal(guestCalls, 0);
      assert.deepEqual(backup.source, { authority: 'guest-config', placement: 'target', target: 'mac-host' });
      assert.deepEqual(targetActions.map(({ action }) => action), ['preflight', 'backup', 'inspect']);
      const status = await inspectExecutionHostBackup({
        profile: { ...guestProfile(limaHome), activation: 'active', hostMountDir: guestHome },
        env,
        destination,
        boundary,
      });
      assert.deepEqual(status.source, { authority: 'guest-config', placement: 'target', target: 'mac-host' });
      assert.deepEqual(status.latest.source, { authority: 'guest-config', placement: 'target', target: 'mac-host' });
      assert.deepEqual(status.health, { ok: true, code: 'ready' });
    });
  }
});

test('target-placed backups fail closed when target snapshotting is unavailable or unsupported', async (t) => {
  const unavailable = await createTempFixture(t, { prefix: 'execution-host-target-backup-unavailable-' });
  const unavailableLimaHome = unavailable.path('lima');
  const unavailableStorageRoot = unavailable.path('stack-storage');
  const unavailableGuestHome = unavailable.path('vm-home');
  await mkdir(join(unavailableLimaHome, 'happier-agent-primary'), { recursive: true });
  await writeFile(join(unavailableLimaHome, 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8');
  await writeTargetServerPlacement({
    storageRoot: join(unavailableGuestHome, '.happier', 'stacks'),
    target: { cliHomeDir: unavailable.path('target-cli') },
  });
  let unavailableGuestCalls = 0;
  await assert.rejects(
    () => createExecutionHostBackup({
      profile: { ...guestProfile(unavailableLimaHome), activation: 'active', hostMountDir: unavailableGuestHome },
      executor: {
        capture: async () => {
          unavailableGuestCalls += 1;
          throw new Error('guest backup must not run for an unavailable target');
        },
      },
      boundary: {
        availableBytes: async () => Number.MAX_SAFE_INTEGER,
        capture: mountedGuestBoundary(unavailableGuestHome, async (_command, args) => {
          assert.equal(args[1], 'preflight');
          return { exitCode: 1, out: '', err: 'target state is unavailable' };
        }).capture,
      },
      env: {
        HAPPIER_STACK_HOME_DIR: unavailable.path('mac-home'),
        HAPPIER_STACK_STORAGE_DIR: unavailableStorageRoot,
      },
      destination: unavailable.path('backups'),
    }),
    /target backup preflight failed: target state is unavailable/,
  );
  assert.equal(unavailableGuestCalls, 0);

  const unsupported = await createTempFixture(t, { prefix: 'execution-host-target-backup-unsupported-' });
  const unsupportedLimaHome = unsupported.path('lima');
  const unsupportedStorageRoot = unsupported.path('stack-storage');
  const unsupportedGuestHome = unsupported.path('vm-home');
  await mkdir(join(unsupportedLimaHome, 'happier-agent-primary'), { recursive: true });
  await writeFile(join(unsupportedLimaHome, 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8');
  await writeTargetServerPlacement({
    storageRoot: join(unsupportedGuestHome, '.happier', 'stacks'),
    target: {
      platform: 'windows',
      cliHomeDir: 'C:/Users/target/.happier/dev-targets/windows',
    },
  });
  let unsupportedGuestCalls = 0;
  await assert.rejects(
    () => createExecutionHostBackup({
      profile: { ...guestProfile(unsupportedLimaHome), activation: 'active', hostMountDir: unsupportedGuestHome },
      executor: {
        capture: async () => {
          unsupportedGuestCalls += 1;
          throw new Error('guest backup must not run for an unsupported target');
        },
      },
      boundary: {
        capture: mountedGuestBoundary(unsupportedGuestHome, async () => {
          throw new Error('unsupported target must not start a snapshot');
        }).capture,
      },
      env: {
        HAPPIER_STACK_HOME_DIR: unsupported.path('mac-home'),
        HAPPIER_STACK_STORAGE_DIR: unsupportedStorageRoot,
      },
      destination: unsupported.path('backups'),
    }),
    /target-placed backup only supports locally reachable POSIX target state/,
  );
  assert.equal(unsupportedGuestCalls, 0);
});

test('backup inspection treats placement-only legacy metadata as unverified', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-legacy-source-' });
  const destination = fixture.path('backups');
  const archiveName = 'dev-vm-backup-1-00000000-0000-0000-0000-000000000000.tar.gz';
  const archivePath = join(destination, archiveName);
  await mkdir(destination, { recursive: true });
  await Promise.all([
    writeFile(archivePath, 'legacy archive\n', 'utf8'),
    writeFile(join(destination, 'latest.json'), `${JSON.stringify({
      archivePath,
      archiveName,
      createdAt: '2026-08-27T00:00:00.000Z',
      stackName: 'main',
      database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
      archiveSha256: 'a'.repeat(64),
      included: [],
      source: { placement: 'guest' },
    })}\n`, 'utf8'),
  ]);

  const status = await inspectExecutionHostBackup({
    profile: guestProfile(fixture.path('lima')),
    env: {
      HAPPIER_STACK_HOME_DIR: fixture.path('mac-home'),
      HAPPIER_STACK_STORAGE_DIR: fixture.path('stack-storage'),
    },
    destination,
  });

  assert.deepEqual(status.source, { authority: 'host-config', placement: 'guest' });
  assert.equal(status.latest.archivePath, archivePath);
  assert.deepEqual(status.health, { ok: false, code: 'source_unverified' });
});

test('backup inspection marks a prior host-config target archive stale after guest authority takes over', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-authority-stale-' });
  const destination = fixture.path('backups');
  const guestHome = fixture.path('vm-home');
  const archiveName = 'dev-vm-backup-1-00000000-0000-0000-0000-000000000000.tar.gz';
  const archivePath = join(destination, archiveName);
  await writeTargetServerPlacement({
    storageRoot: join(guestHome, '.happier', 'stacks'),
    target: { cliHomeDir: fixture.path('target-cli') },
  });
  await mkdir(destination, { recursive: true });
  await Promise.all([
    writeFile(archivePath, 'prior target archive\n', 'utf8'),
    writeFile(join(destination, 'latest.json'), `${JSON.stringify({
      archivePath,
      archiveName,
      createdAt: '2026-08-27T00:00:00.000Z',
      stackName: 'main',
      database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
      archiveSha256: 'a'.repeat(64),
      included: [],
      source: { authority: 'host-config', placement: 'target', target: 'mac-host' },
    })}\n`, 'utf8'),
  ]);

  const status = await inspectExecutionHostBackup({
    profile: {
      ...guestProfile(fixture.path('lima')),
      activation: 'active',
      hostMountDir: guestHome,
    },
    env: { HAPPIER_STACK_HOME_DIR: fixture.path('mac-home') },
    destination,
    boundary: mountedGuestBoundary(guestHome),
  });

  assert.deepEqual(status.source, { authority: 'guest-config', placement: 'target', target: 'mac-host' });
  assert.deepEqual(status.latest.source, { authority: 'host-config', placement: 'target', target: 'mac-host' });
  assert.deepEqual(status.health, { ok: false, code: 'source_stale' });
});

test('backup destinations cannot be placed inside a configured guest-home mount', () => {
  const profile = {
    ...guestProfile('/Users/leeroy/.happier-stack/lima'),
    hostMountDir: '/Users/leeroy/.happier-stack/custom-vm-home',
  };
  const env = { HAPPIER_STACK_HOME_DIR: '/Users/leeroy/.happier-stack' };

  assert.equal(
    resolveExecutionHostBackupPaths({ profile, env }).destination,
    '/Users/leeroy/.happier-stack/vm-backups/happier-agent-primary/main',
  );
  assert.throws(
    () => resolveExecutionHostBackupPaths({
      profile,
      env,
      destination: '/Users/leeroy/.happier-stack/custom-vm-home/backups',
    }),
    /backup destination must be outside the mounted guest home/,
  );
});

test('dev-vm backup refuses before the guest snapshot when host capacity cannot hold its archive plan', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-host-capacity-' });
  const limaHome = fixture.path('lima');
  const destination = fixture.path('mac-backups');
  await mkdir(join(limaHome, 'happier-agent-primary'), { recursive: true });
  await writeFile(join(limaHome, 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8');

  const guestActions = [];
  const executor = {
    capture: async (_command, args) => {
      const action = args.at(-2);
      guestActions.push(action);
      if (action !== 'preflight') throw new Error(`unexpected guest action: ${action}`);
      return {
        exitCode: 0,
        out: JSON.stringify({
          stackName: 'main',
          database: { provider: 'sqlite', integrity: 'pending' },
          databaseBytes: 4096,
          treeBytes: 4096,
          archiveMaxBytes: 8192,
          requiredFreeBytes: 12288,
        }),
        err: '',
      };
    },
  };
  const boundary = {
    availableBytes: async () => 1024,
    capture: async () => {
      throw new Error('transfer must not start when host capacity is insufficient');
    },
  };

  await assert.rejects(
    createExecutionHostBackup({
      profile: guestProfile(limaHome),
      executor,
      boundary,
      env: { HAPPIER_STACK_HOME_DIR: fixture.path('mac-home') },
      stackName: 'main',
      destination,
    }),
    /host backup destination has insufficient free space/,
  );
  assert.deepEqual(guestActions, ['preflight']);
});

test('guest backup preflight refuses when its SQLite snapshot and archive cannot fit', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-guest-capacity-' });
  const guestHome = fixture.path('guest-home');
  const storageRoot = join(guestHome, '.happier', 'stacks');
  const stackDir = join(storageRoot, 'main');
  const dataDir = join(stackDir, 'server-light');
  const databasePath = join(dataDir, 'happier-server-light.sqlite');
  await mkdir(dataDir, { recursive: true });
  await Promise.all([
    writeFile(join(stackDir, 'env'), 'HAPPIER_STACK_STACK=main\n', 'utf8'),
    writeFile(databasePath, '', 'utf8'),
    writeFile(join(dataDir, 'handy-master-secret.txt'), 'test-secret\n', { mode: 0o600 }),
  ]);
  const volume = await statfs(guestHome);
  const availableBytes = Number(volume.bavail) * Number(volume.bsize);
  await truncate(databasePath, availableBytes + 1024 * 1024);

  const result = await runCommandCapture('python3', [new URL('./guest_backup.py', import.meta.url).pathname, 'preflight', 'main'], {
    env: { ...process.env, HOME: guestHome, HAPPIER_STACK_STORAGE_DIR: storageRoot },
    sanitizeEnv: false,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /insufficient free space for SQLite snapshot and archive/);
});

async function inspectArchive(archivePath) {
  const result = await runCommandCapture('python3', ['-c', `
import json
import os
import sqlite3
import stat
import tarfile
import tempfile
import sys

archive = sys.argv[1]
with tarfile.open(archive, 'r:gz') as bundle:
    names = sorted(bundle.getnames())
    with tempfile.TemporaryDirectory() as directory:
        db_path = os.path.join(directory, 'snapshot.sqlite')
        with open(db_path, 'wb') as output:
            output.write(bundle.extractfile('stack/server-light/happier-server-light.sqlite').read())
        connection = sqlite3.connect(db_path)
        integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
        foreign_keys = connection.execute('PRAGMA foreign_key_check').fetchall()
        migrations = connection.execute('SELECT count(*) FROM _prisma_migrations').fetchone()[0]
        rows = connection.execute('SELECT count(*) FROM events').fetchone()[0]
        connection.close()
    secret_member = bundle.getmember('stack/server-light/handy-master-secret.txt')
    secret = bundle.extractfile(secret_member).read().decode('utf-8')
    manifest = json.load(bundle.extractfile('manifest.json'))
print(json.dumps({
    'names': names,
    'integrity': integrity,
    'foreignKeys': foreign_keys,
    'migrations': migrations,
    'rows': rows,
    'secret': secret,
    'secretMode': stat.S_IMODE(secret_member.mode),
    'manifest': manifest,
}))
`, archivePath]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function sqliteCount(databasePath) {
  const result = await runCommandCapture('python3', ['-c', `
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
print(connection.execute('SELECT count(*) FROM events').fetchone()[0])
connection.close()
`, databasePath]);
  assert.equal(result.code, 0, result.stderr);
  return Number(result.stdout.trim());
}

async function createRestorableServerStateArchive(t) {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-server-state-archive-' });
  const guestHome = fixture.path('guest-home');
  const storageRoot = join(guestHome, '.happier', 'stacks');
  const stackDir = join(storageRoot, 'main');
  const dataDir = join(stackDir, 'server-light');
  const databasePath = join(dataDir, 'happier-server-light.sqlite');
  const secretPath = join(dataDir, 'handy-master-secret.txt');
  await mkdir(join(dataDir, 'files'), { recursive: true });
  await Promise.all([
    writeFile(join(stackDir, 'env'), 'HAPPIER_STACK_STACK=main\n', 'utf8'),
    writeFile(join(dataDir, 'files', 'upload.txt'), 'retained upload\n', 'utf8'),
    writeFile(secretPath, 'retained-master-secret\n', { mode: 0o640 }),
  ]);
  await chmod(secretPath, 0o640);
  const created = await runCommandCapture('python3', ['-c', `
import sqlite3
import sys

database = sys.argv[1]
connection = sqlite3.connect(database)
connection.execute('PRAGMA foreign_keys=ON')
connection.execute('CREATE TABLE accounts (id INTEGER PRIMARY KEY)')
connection.execute('CREATE TABLE events (account_id INTEGER NOT NULL REFERENCES accounts(id), value TEXT NOT NULL)')
connection.execute('INSERT INTO accounts (id) VALUES (1)')
connection.execute("INSERT INTO events (account_id, value) VALUES (1, 'retained event')")
connection.commit()
connection.close()
`, databasePath]);
  assert.equal(created.code, 0, created.stderr);

  const backup = await runCommandCapture('python3', [new URL('./guest_backup.py', import.meta.url).pathname, 'backup', 'main'], {
    env: { ...process.env, HOME: guestHome, HAPPIER_STACK_STORAGE_DIR: storageRoot },
    sanitizeEnv: false,
  });
  assert.equal(backup.code, 0, backup.stderr);
  const archive = JSON.parse(backup.stdout);
  t.after(async () => {
    await rm(archive.archivePath, { force: true });
  });
  return { archive, fixture, databasePath, secretPath };
}

test('server-state inspection rejects a boundary result without its manifest Stack name', async () => {
  await assert.rejects(
    () => executionHostBackup.inspectExecutionHostServerStateArchive({
      archivePath: '/tmp/happier-dev-vm-backup-missing-stack.tar.gz',
      boundary: {
        capture: async () => ({
          exitCode: 0,
          out: JSON.stringify({
            format: 2,
            archiveBytes: 1,
            archiveSha256: 'a'.repeat(64),
            database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
            secret: {
              path: 'stack/server-light/handy-master-secret.txt',
              mode: 0o600,
              sha256: 'b'.repeat(64),
            },
            entryCount: 2,
          }),
          err: '',
        }),
      },
    }),
    /Stack name/i,
  );
});

test('server-state restore plans, validates, and promotes only into an absent native server-light target', async (t) => {
  const source = await createRestorableServerStateArchive(t);
  const targetStackStateDir = source.fixture.path('mac-target', 'stack-state', 'main');

  const plan = await executionHostBackup.planExecutionHostServerStateRestore({
    archivePath: source.archive.archivePath,
    archiveSha256: source.archive.archiveSha256,
    stackName: 'main',
    targetStackStateDir,
  });
  assert.equal(plan.targetServerLightDir, join(targetStackStateDir, 'server-light'));
  assert.deepEqual(plan.database, { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' });
  await assert.rejects(stat(plan.targetServerLightDir), /ENOENT/);

  const restored = await executionHostBackup.restoreExecutionHostServerState({
    archivePath: source.archive.archivePath,
    archiveSha256: source.archive.archiveSha256,
    stackName: 'main',
    targetStackStateDir,
  });
  assert.equal(restored.targetServerLightDir, plan.targetServerLightDir);
  assert.equal(restored.archiveSha256, source.archive.archiveSha256);
  assert.deepEqual(restored.database, { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' });
  assert.equal(await sqliteCount(join(plan.targetServerLightDir, 'happier-server-light.sqlite')), 1);
  assert.equal(await readFile(join(plan.targetServerLightDir, 'files', 'upload.txt'), 'utf8'), 'retained upload\n');
  assert.equal(await readFile(join(plan.targetServerLightDir, 'handy-master-secret.txt'), 'utf8'), 'retained-master-secret\n');
  assert.equal((await stat(join(plan.targetServerLightDir, 'handy-master-secret.txt'))).mode & 0o777, 0o640);

  await assert.rejects(
    () => executionHostBackup.restoreExecutionHostServerState({
      archivePath: source.archive.archivePath,
      archiveSha256: source.archive.archiveSha256,
      stackName: 'main',
      targetStackStateDir,
    }),
    /target server-light directory must be absent/i,
  );
});

test('server-state restore refuses a pre-existing target without replacing retained state', async (t) => {
  const source = await createRestorableServerStateArchive(t);
  const targetStackStateDir = source.fixture.path('mac-target', 'stack-state', 'main');
  const targetServerLightDir = join(targetStackStateDir, 'server-light');
  await mkdir(targetServerLightDir, { recursive: true });
  await writeFile(join(targetServerLightDir, 'historical-state.txt'), 'do not replace\n', 'utf8');

  await assert.rejects(
    () => executionHostBackup.restoreExecutionHostServerState({
      archivePath: source.archive.archivePath,
      archiveSha256: source.archive.archiveSha256,
      stackName: 'main',
      targetStackStateDir,
    }),
    /target server-light directory must be absent/i,
  );
  assert.equal(await readFile(join(targetServerLightDir, 'historical-state.txt'), 'utf8'), 'do not replace\n');
});

test('server-state restore requires the exact inspected archive checksum before staging', async (t) => {
  const source = await createRestorableServerStateArchive(t);
  const targetStackStateDir = source.fixture.path('mac-target', 'stack-state', 'main');

  await assert.rejects(
    () => executionHostBackup.restoreExecutionHostServerState({
      archivePath: source.archive.archivePath,
      archiveSha256: '0'.repeat(64),
      stackName: 'main',
      targetStackStateDir,
    }),
    /checksum did not match the expected backup/i,
  );
  await assert.rejects(stat(join(targetStackStateDir, 'server-light')), /ENOENT/);
});

test('server-state restore rejects a payload that no longer matches its manifest before staging', async (t) => {
  const source = await createRestorableServerStateArchive(t);
  const tamperedArchive = source.fixture.path('tampered.tar.gz');
  const tampered = await runCommandCapture('python3', ['-c', `
import io
import tarfile
import sys

source, destination = sys.argv[1:]
with tarfile.open(source, 'r:gz') as original, tarfile.open(destination, 'w:gz') as changed:
    for member in original.getmembers():
        if member.isdir():
            changed.addfile(member)
            continue
        contents = original.extractfile(member).read()
        if member.name == 'stack/server-light/files/upload.txt':
            contents = b'tampered payload\\n'
            member.size = len(contents)
        changed.addfile(member, io.BytesIO(contents))
`, source.archive.archivePath, tamperedArchive]);
  assert.equal(tampered.code, 0, tampered.stderr);
  const targetStackStateDir = source.fixture.path('mac-target', 'stack-state', 'main');

  await assert.rejects(
    () => executionHostBackup.planExecutionHostServerStateRestore({
      archivePath: tamperedArchive,
      stackName: 'main',
      targetStackStateDir,
    }),
    /manifest.*checksum/i,
  );
  await assert.rejects(stat(join(targetStackStateDir, 'server-light')), /ENOENT/);
});

test('dev-vm backup makes a SQLite-consistent guest snapshot on the Mac host and prunes retained archives', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-backup-' });
  const guestHome = fixture.path('guest-home');
  const stackDir = join(guestHome, '.happier', 'stacks', 'main');
  const dataDir = join(stackDir, 'server-light');
  const databasePath = join(dataDir, 'happier-server-light.sqlite');
  const secretPath = join(dataDir, 'handy-master-secret.txt');
  const destination = fixture.path('mac-backups');
  const limaHome = fixture.path('lima');
  await Promise.all([
    mkdir(join(dataDir, 'files'), { recursive: true }),
    mkdir(join(stackDir, 'cli'), { recursive: true }),
    mkdir(join(limaHome, 'happier-agent-primary'), { recursive: true }),
    mkdir(destination, { recursive: true, mode: 0o755 }),
  ]);
  await chmod(destination, 0o755);
  await Promise.all([
    writeFile(join(stackDir, 'env'), [
      'HAPPIER_STACK_STACK=main',
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      '',
    ].join('\n'), 'utf8'),
    writeFile(join(stackDir, 'stack.runtime.json'), '{"stackName":"main","version":1}\n', 'utf8'),
    writeFile(join(stackDir, 'cli', 'credentials.json'), '{"token":"super-secret-backup-value"}\n', 'utf8'),
    writeFile(join(dataDir, 'files', 'upload.txt'), 'uploaded data\n', 'utf8'),
    writeFile(secretPath, 'super-secret-backup-value\n', { mode: 0o640 }),
    writeFile(join(limaHome, 'happier-agent-primary', 'ssh.config'), 'Host lima-happier-agent-primary\n', 'utf8'),
  ]);
  await chmod(secretPath, 0o640);

  const writer = spawn('python3', ['-c', `
import sqlite3
import sys
import time

database = sys.argv[1]
connection = sqlite3.connect(database, timeout=10)
connection.execute('PRAGMA journal_mode=WAL')
connection.execute('CREATE TABLE IF NOT EXISTS events (value INTEGER NOT NULL)')
connection.execute('CREATE TABLE IF NOT EXISTS _prisma_migrations (migration_name TEXT NOT NULL)')
connection.execute('INSERT INTO _prisma_migrations (migration_name) VALUES ("initial")')
connection.commit()
print('READY', flush=True)
value = 0
while True:
    connection.execute('INSERT INTO events (value) VALUES (?)', (value,))
    connection.commit()
    value += 1
    time.sleep(0.002)
`, databasePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForWriterReady(writer);
  t.after(async () => {
    writer.kill('SIGTERM');
    await waitForExit(writer);
  });

  const guestCalls = [];
  const executor = {
    capture: async (command, args, { input } = {}) => {
      guestCalls.push({ command, args, input });
      assert.equal(command, 'limactl');
      const pythonIndex = args.indexOf('python3');
      if (pythonIndex < 0) throw new Error(`unexpected guest invocation: ${args.join(' ')}`);
      const result = await runCommandCapture('python3', args.slice(pythonIndex + 1), {
        input,
        env: { ...process.env, HOME: guestHome, TMPDIR: '/tmp' },
        sanitizeEnv: false,
      });
      return { exitCode: result.code, out: result.stdout, err: result.stderr };
    },
  };
  const transferCalls = [];
  const boundary = {
    capture: async (command, args) => {
      transferCalls.push({ command, args });
      if (command === 'scp') {
        const source = args.find((argument) => String(argument).startsWith('lima-happier-agent-primary:'));
        assert.ok(source, `missing Lima SSH source in ${args.join(' ')}`);
        await copyFile(source.slice(String(source).indexOf(':') + 1), args.at(-1));
        await chmod(args.at(-1), 0o644);
        return { exitCode: 0, out: '', err: '' };
      }
      assert.equal(command, 'python3');
      const result = await runCommandCapture(command, args);
      return { exitCode: result.code, out: result.stdout, err: result.stderr };
    },
  };
  const env = {
    HAPPIER_STACK_HOME_DIR: fixture.path('mac-home'),
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stack-storage'),
  };

  let latest;
  for (let index = 0; index < 3; index += 1) {
    latest = await createExecutionHostBackup({
      profile: guestProfile(limaHome),
      executor,
      boundary,
      env,
      stackName: 'main',
      destination,
      retention: 2,
    });
    assert.equal(latest.database.integrity, 'ok');
    assert.equal(latest.destination, destination);
    assert.doesNotMatch(JSON.stringify(latest), /super-secret-backup-value/);
  }

  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tar.gz'));
  assert.equal(archives.length, 2);
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(latest.archivePath)).mode & 0o777, 0o600);
  const gzipHeader = await readFile(latest.archivePath);
  assert.equal(gzipHeader[8], 4, 'large Stack backups use gzip fastest compression');
  assert.equal(transferCalls.filter((call) => call.command === 'scp').length, 3);
  assert.equal(transferCalls.filter((call) => call.command === 'python3').length, 3);
  assert.equal(guestCalls.length >= 3, true);

  const archive = await inspectArchive(latest.archivePath);
  assert.equal(archive.integrity, 'ok');
  assert.deepEqual(archive.foreignKeys, []);
  assert.equal(archive.migrations, 1);
  assert.equal(archive.names.includes('stack/env'), false);
  assert.equal(archive.names.includes('stack/stack.runtime.json'), false);
  assert.equal(archive.names.includes('stack/cli/credentials.json'), false);
  assert.equal(archive.names.includes('stack/server-light/files/upload.txt'), true);
  assert.equal(archive.names.includes('stack/server-light/happier-server-light.sqlite'), true);
  assert.equal(archive.names.includes('stack/server-light/handy-master-secret.txt'), true);
  assert.equal(archive.names.some((name) => name === 'stack/server-light/happier-server-light.sqlite-wal' || name === 'stack/server-light/happier-server-light.sqlite-shm'), false);
  assert.equal(archive.secret, 'super-secret-backup-value\n');
  assert.equal(archive.secretMode, 0o640);
  assert.equal(archive.manifest.format, 2);
  assert.equal(archive.manifest.database.integrity, 'ok');
  assert.equal(archive.manifest.database.foreignKeys, 'ok');
  assert.equal(archive.manifest.secret.mode, 0o640);
  assert.equal(
    archive.manifest.entries.some((entry) => entry.path === 'stack/server-light/handy-master-secret.txt'),
    true,
  );

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.ok((await sqliteCount(databasePath)) >= archive.rows, 'writer remained live after the backup snapshot');

  const status = await inspectExecutionHostBackup({
    profile: guestProfile(limaHome),
    env,
    stackName: 'main',
    destination,
  });
  assert.deepEqual(status.health, { ok: true, code: 'ready' });
  assert.equal(status.archiveCount, 2);
  assert.equal(status.latest.archivePath, latest.archivePath);
  assert.deepEqual(status.source, { authority: 'host-config', placement: 'guest' });
  assert.deepEqual(status.latest.source, { authority: 'host-config', placement: 'guest' });
});
