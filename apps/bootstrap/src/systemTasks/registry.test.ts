import { createBuiltinRelayAccessSelection as relaySelection, getRelayAccessProviderDescriptor as relayDescriptor } from '@happier-dev/cli-common/relayAccess';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  readSqliteMigrationCatalog,
  resolveInstalledPersonalHomeSqliteMigrationPaths,
  resolvePersonalHomeRuntimeLayout,
  resolveRelayRuntimeDefaults,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  executeSystemTask,
  SystemTaskExecutionError,
  type PersonalHomeTaskOperationContext,
} from '@happier-dev/cli-common/systemTasks';
import { createFakeTailscaleCli } from '@happier-dev/tests/testkit/tailscale/fakeTailscaleCli';
import { buildLaunchdPlistXml, renderSystemdServiceUnit } from '@happier-dev/cli-common/service';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createFakeHappierCli, restoreEnvVar } from './fakeHappierCli.testkit.js';
import { createHsetupSystemTaskRegistry } from './registry.js';

function prepareInstalledDaemonFixture(cliPath: string): void {
  const homeDir = join(cliPath, '..');
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const previousServiceHomeDir = process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
  process.env.HAPPIER_HOME_DIR = homeDir;
  process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
  const env = {
    HAPPIER_HOME_DIR: homeDir,
    HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
    HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
    HAPPIER_SERVER_URL: 'https://relay.example.test',
  };
  if (process.platform === 'darwin') {
    const folder = join(homeDir, 'Library', 'LaunchAgents');
    mkdirSync(folder, { recursive: true });
    const label = 'com.happier.cli.daemon.default';
    writeFileSync(join(folder, label + '.plist'), buildLaunchdPlistXml({ label, programArgs: [cliPath, 'daemon', 'start-sync'], env, stdoutPath: join(homeDir, 'out'), stderrPath: join(homeDir, 'err') }));
  } else {
    const folder = join(homeDir, '.config', 'systemd', 'user');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'happier-daemon.default.service'), renderSystemdServiceUnit({ description: 'Happier', execStart: [cliPath, 'daemon', 'start-sync'], env }));
  }
  onTestFinished(() => {
    restoreEnvVar('HAPPIER_HOME_DIR', previousHomeDir);
    restoreEnvVar('HAPPIER_DAEMON_SERVICE_USER_HOME_DIR', previousServiceHomeDir);
  });
}

async function prepareBootstrapPersonalHomeFixture(homeDir: string): Promise<Readonly<{
  archivePath: string;
  canonicalServerUrl: string;
  identity: string;
  layout: ReturnType<typeof resolvePersonalHomeRuntimeLayout>;
}>> {
  const canonicalServerUrl = 'http://127.0.0.1:52123';
  const identity = 'bootstrap-default-registry-home';
  const defaults = resolveRelayRuntimeDefaults({
    platform: process.platform,
    mode: 'user',
    channel: 'stable',
    homeDir,
  });
  mkdirSync(defaults.configDir, { recursive: true });
  writeFileSync(join(defaults.configDir, 'server.env'), [
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}`,
    `HAPPIER_PUBLIC_SERVER_URL=${canonicalServerUrl}`,
    'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=plaintext_only',
    'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE=plain',
    'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
    '',
  ].join('\n'));
  const layout = resolvePersonalHomeRuntimeLayout({ homeDir, platform: process.platform, mode: 'user' });
  const migrationPaths = resolveInstalledPersonalHomeSqliteMigrationPaths({
    installRoot: layout.installRoot,
    platform: layout.platform,
  });
  const migration = {
    name: '20260830000000_bootstrap_default_registry',
    sql: 'CREATE TABLE bootstrap_default_registry_fixture (id TEXT);',
  } as const;
  const migrationDir = join(migrationPaths.migrationsDir, migration.name);
  mkdirSync(migrationDir, { recursive: true });
  writeFileSync(join(migrationDir, 'migration.sql'), migration.sql);
  const [installedMigration] = await readSqliteMigrationCatalog(migrationPaths.migrationsDir);
  if (!installedMigration) throw new Error('Bootstrap Personal Home migration fixture was not installed.');
  const serverBinaryPath = join(layout.installRoot, 'bin', 'happier-server');
  mkdirSync(join(layout.installRoot, 'bin'), { recursive: true });
  writeFileSync(serverBinaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(serverBinaryPath, 0o755);
  mkdirSync(layout.publicFilesDir, { recursive: true });
  mkdirSync(layout.privateFilesDir, { recursive: true });
  writeFileSync(layout.masterSecretPath, 'bootstrap-master-secret');
  writeFileSync(join(layout.publicFilesDir, 'public.txt'), 'bootstrap-public-bytes');
  writeFileSync(join(layout.privateFilesDir, 'private.txt'), 'bootstrap-private-bytes');
  const database = new DatabaseSync(layout.databasePath);
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('CREATE TABLE "Account" (id TEXT PRIMARY KEY)');
  database.exec('CREATE TABLE "Session" (id TEXT PRIMARY KEY)');
  database.exec('CREATE TABLE SimpleCache (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.exec('CREATE TABLE bootstrap_transcript (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  database.exec('CREATE TABLE _prisma_migrations (migration_name TEXT NOT NULL, checksum TEXT NOT NULL, finished_at TEXT, rolled_back_at TEXT)');
  database.prepare('INSERT INTO SimpleCache (key, value) VALUES (?, ?)').run('server.identity.v1', identity);
  database.prepare('INSERT INTO "Account" (id) VALUES (?)').run('bootstrap-account-1');
  database.prepare('INSERT INTO "Session" (id) VALUES (?)').run('bootstrap-session-1');
  database.prepare('INSERT INTO bootstrap_transcript (id, body) VALUES (?, ?)').run('message-1', 'bootstrap transcript bytes');
  database.prepare('INSERT INTO _prisma_migrations (migration_name, checksum, finished_at, rolled_back_at) VALUES (?, ?, ?, NULL)').run(
    migration.name,
    createHash('sha256').update(migration.sql).digest('hex'),
    new Date().toISOString(),
  );
  database.close();
  return {
    archivePath: join(homeDir, 'bootstrap-default-registry.tar'),
    canonicalServerUrl,
    identity,
    layout,
  };
}

describe('createHsetupSystemTaskRegistry', () => {
  it('runs daemon.service.status.v1 and reports the local daemon status snapshot', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.status.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_status_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_status_1',
        ok: true,
        data: expect.objectContaining({
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonMachineRegistered: true,
          daemonAccountId: null,
          daemonComparableKey: null,
        }),
      });
      expect(fakeCli.readInvocations()).toContainEqual(['daemon', 'status', '--json']);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('runs daemon.service.start.v1 and waits for the ready daemon status snapshot', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      prepareInstalledDaemonFixture(fakeCli.cliPath);
      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.start.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_start_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_start_1',
        ok: true,
        data: expect.objectContaining({
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonMachineRegistered: true,
          daemonAccountId: null,
          daemonComparableKey: null,
        }),
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['daemon', 'status', '--json'],
        ['service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('runs daemon.service.stop.v1 and stops the local daemon service through the canonical CLI wrapper', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: false,
            pid: null,
          },
          service: {
            installed: true,
            running: false,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      prepareInstalledDaemonFixture(fakeCli.cliPath);
      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.stop.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_stop_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_stop_1',
        ok: true,
        data: expect.objectContaining({
          serviceInstalled: true,
          daemonRunning: false,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonMachineRegistered: true,
          daemonAccountId: null,
          daemonComparableKey: null,
        }),
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['daemon', 'status', '--json'],
        ['service', 'stop', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('runs daemon.service.restart.v1 and restarts the local daemon service through the canonical CLI wrapper', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
        {
          server: {
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      prepareInstalledDaemonFixture(fakeCli.cliPath);
      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.restart.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_restart_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_restart_1',
        ok: true,
        data: expect.objectContaining({
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonMachineRegistered: true,
          daemonAccountId: null,
          daemonComparableKey: null,
        }),
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['daemon', 'status', '--json'],
        ['service', 'restart', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs relay.runtime.status.v1 with deterministic progress and result payloads', async () => {
    const events: unknown[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.status.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
        },
      },
      taskId: 'task_status_1',
      registry: createHsetupSystemTaskRegistry({
        relayRuntime: {
          async readStatus() {
            return {
              installed: true,
              version: '1.2.3',
              service: {
                active: true,
                enabled: true,
              },
              baseUrl: 'http://127.0.0.1:3005',
            };
          },
          async checkHealth() {
            return true;
          },
        },
      }),
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'progress',
        stepId: 'relay.status.inspect',
        message: 'Inspecting relay runtime',
      }),
      expect.objectContaining({
        type: 'progress',
        stepId: 'relay.status.health',
        message: 'Checking relay runtime health',
      }),
    ]);
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_status_1',
      ok: true,
      data: {
        installed: true,
        version: '1.2.3',
        channel: 'stable',
        mode: 'user',
        relayUrl: 'http://127.0.0.1:3005',
        healthy: true,
        service: {
          active: true,
          enabled: true,
        },
      },
    });
  });

  it('reconciles interrupted Personal Home restore state before every generic runtime contact', async () => {
    const contacts: string[] = [];
    const reconcileRestore = vi.fn(async (context: PersonalHomeTaskOperationContext) => {
      contacts.push(`reconcile:${context.runtimeTarget.channel}:${context.runtimeTarget.mode}:${context.requestedPurpose.canonicalServerUrl}`);
    });
    const registry = createHsetupSystemTaskRegistry({
      relayRuntime: {
        async readStatus(params) {
          contacts.push(`status:${params.channel}:${params.mode}`);
          return {
            installed: true,
            version: '1.2.3',
            service: { active: true, enabled: true },
            baseUrl: 'http://127.0.0.1:43007',
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43007' },
          };
        },
        async checkHealth() {
          return true;
        },
        async installOrUpdate(params) {
          contacts.push(`install:${params.channel}:${params.mode}`);
          return { relayUrl: 'http://127.0.0.1:43007', mode: params.mode ?? 'user' };
        },
        async control(params) {
          contacts.push(`control:${params.action}:${params.channel}:${params.mode}`);
        },
      },
      personalHomeOperations: {
        reconcileRestore,
        inspect: async () => ({}),
        backup: async () => ({}),
        verifyBackup: async () => ({}),
        restore: async () => ({}),
        recoverRestore: async () => ({}),
        erase: async () => ({}),
      },
    });

    for (const [index, kind] of [
      'relay.runtime.status.v1',
      'relay.runtime.installOrUpdate.v1',
      'relay.runtime.start.v1',
      'relay.runtime.restart.v1',
      'relay.runtime.stop.v1',
      'relay.runtime.uninstall.v1',
    ].entries()) {
      contacts.length = 0;
      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind,
          params: { target: { kind: 'local' }, channel: 'preview', mode: 'system' },
        },
        taskId: `task_personal_home_runtime_contact_${index}`,
        registry,
        emitEvent() {},
      });

      expect(result.ok).toBe(true);
      expect(contacts[0]).toBe('status:preview:system');
      expect(contacts[1]).toBe('reconcile:preview:system:http://127.0.0.1:43007');
    }
    expect(reconcileRestore).toHaveBeenCalledTimes(6);
  });

  it('allows a fresh Personal Home install before a restore contact exists', async () => {
    const reconcileRestore = vi.fn(async () => undefined);
    const installOrUpdate = vi.fn(async () => ({
      relayUrl: 'http://127.0.0.1:43007',
      mode: 'user' as const,
    }));
    const registry = createHsetupSystemTaskRegistry({
      relayRuntime: {
        readStatus: async () => ({
          installed: false,
          version: null,
          service: { active: null, enabled: null },
          baseUrl: 'http://127.0.0.1:43007',
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43007' },
          dataPresent: false,
        }),
        installOrUpdate,
      },
      personalHomeOperations: {
        reconcileRestore,
        inspect: async () => ({}),
        backup: async () => ({}),
        verifyBackup: async () => ({}),
        restore: async () => ({}),
        recoverRestore: async () => ({}),
        erase: async () => ({}),
      },
    });

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.installOrUpdate.v1',
        params: {
          target: { kind: 'local' },
          channel: 'preview',
          mode: 'user',
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43007' },
        },
      },
      taskId: 'task_fresh_personal_home_install',
      registry,
      emitEvent() {},
    });

    expect(result.ok).toBe(true);
    expect(reconcileRestore).not.toHaveBeenCalled();
    expect(installOrUpdate).toHaveBeenCalledOnce();
  });

  it('fails a generic Personal Home runtime mutation closed when restore reconciliation requires recovery', async () => {
    const installOrUpdate = vi.fn(async () => ({ relayUrl: 'http://127.0.0.1:43007', mode: 'user' as const }));
    const registry = createHsetupSystemTaskRegistry({
      relayRuntime: {
        readStatus: async () => ({
          installed: true,
          version: '1.2.3',
          service: { active: false, enabled: true },
          baseUrl: 'http://127.0.0.1:43007',
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43007' },
        }),
        installOrUpdate,
      },
      personalHomeOperations: {
        reconcileRestore: async () => {
          throw new SystemTaskExecutionError(
            'restore_recovery_required',
            'Interrupted Personal Home restore requires recovery.',
          );
        },
        inspect: async () => ({}),
        backup: async () => ({}),
        verifyBackup: async () => ({}),
        restore: async () => ({}),
        recoverRestore: async () => ({}),
        erase: async () => ({}),
      },
    });

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.installOrUpdate.v1',
        params: { target: { kind: 'local' }, channel: 'stable', mode: 'user' },
      },
      taskId: 'task_personal_home_restore_recovery_required',
      registry,
      emitEvent() {},
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'restore_recovery_required' } });
    expect(installOrUpdate).not.toHaveBeenCalled();
  });

  it('runs relay.runtime.start.v1 through the lifecycle controller before returning fresh status', async () => {
    const controlled: string[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.start.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
        },
      },
      taskId: 'task_start_1',
      registry: createHsetupSystemTaskRegistry({
        relayRuntime: {
          async readStatus() {
            return {
              installed: true,
              version: '1.2.3',
              service: {
                active: true,
                enabled: true,
              },
              baseUrl: 'http://127.0.0.1:3005',
            };
          },
          async checkHealth() {
            return true;
          },
          async control(params) {
            controlled.push(params.action);
          },
        },
      }),
      emitEvent() {},
    });

    expect(controlled).toEqual(['start']);
    expect(result.ok).toBe(true);
  });

  it('runs relay.runtime.uninstall.v1 through the canonical safe lifecycle controller', async () => {
    const controlled: string[] = [];
    const events: unknown[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.uninstall.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
        },
      },
      taskId: 'task_uninstall_1',
      registry: createHsetupSystemTaskRegistry({
        relayRuntime: {
          async control(params) {
            controlled.push(params.action);
          },
        },
      }),
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(controlled).toEqual(['uninstall']);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'progress',
        stepId: 'relay.uninstall',
        message: 'Uninstalling relay runtime',
      }),
    ]);
    expect(result).toMatchObject({ ok: true, data: { uninstalled: true } });
  });

  it('uses the publicdev release ring when daemon.service.status.v1 specifies channel dev', async () => {
    const fakeCli = createFakeHappierCli({});
    const homeDir = join(fakeCli.cliPath, '..');
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousRepoDir = process.env.HAPPIER_STACK_REPO_DIR;
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_STACK_REPO_DIR = homeDir;
      delete process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(homeDir, 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(homeDir, 'invocations.log');

      const stablePath = join(homeDir, 'cli', 'current', 'happier');
      mkdirSync(join(homeDir, 'cli', 'current'), { recursive: true });
      writeFileSync(stablePath, `#!/bin/sh\nexit 1\n`);
      chmodSync(stablePath, 0o755);

      const devPath = join(homeDir, 'cli-dev', 'current', 'happier');
      mkdirSync(join(homeDir, 'cli-dev', 'current'), { recursive: true });
      writeFileSync(devPath, readFileSync(fakeCli.cliPath, 'utf8'));
      chmodSync(devPath, 0o755);

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.status.v1',
          params: {
            target: { kind: 'local' },
            surface: 'desktop.ui',
            mode: 'user',
            channel: 'dev',
          },
        },
        taskId: 'task_daemon_status_release_ring_publicdev',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_daemon_status_release_ring_publicdev',
        ok: true,
        data: expect.objectContaining({
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
          daemonServerUrl: 'https://relay.example.test',
          daemonComparableKey: null,
          daemonAccountId: null,
          daemonMachineRegistered: true,
          daemonAccountLabel: null,
          daemonServiceManaged: null,
          daemonCliVersion: null,
          cliUpdate: null,
          // Nothing was asked and no other `happier` is on the search path (R12).
          cliChoice: { mode: null, otherCli: null },
        }),
      });
      expect(fakeCli.readInvocations()).toEqual([
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_HOME_DIR', previousHomeDir);
      restoreEnvVar('HAPPIER_STACK_REPO_DIR', previousRepoDir);
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('returns prompt_required when remote.ssh.manageHost.v1 needs host trust', async () => {
    const events: unknown[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.manageHost.v1',
        params: {
          action: 'testConnection',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
      },
      taskId: 'task_remote_manage_1',
      registry: createHsetupSystemTaskRegistry({
        remoteSshBootstrap: {
          async resolveHostTrust() {
            return {
              status: 'prompt',
              promptKind: 'sshHostTrust',
              promptMessage: 'Trust the remote SSH host key',
              promptData: {
                host: 'example.test',
                fingerprint: 'SHA256:test',
                knownHostKey: 'example.test ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ',
              },
              accept: async () => undefined,
            };
          },
        },
      }),
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'progress',
        stepId: 'ssh.trust',
        message: 'Verifying SSH host trust',
      }),
      expect.objectContaining({
        type: 'prompt',
        stepId: 'ssh.hostTrust',
        message: 'Trust the remote SSH host key',
        data: {
          kind: 'ssh.trustHost',
          host: 'example.test',
          fingerprint: 'SHA256:test',
          knownHostKey: 'example.test ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ',
        },
      }),
    ]);
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_remote_manage_1',
      ok: false,
      error: {
        code: 'prompt_required',
        message: 'Trust the remote SSH host key',
      },
    });
  });

  it('composes remote Personal Home relocation through the injected source coordinator', async () => {
    const runPersonalHomeRelocation = vi.fn(async () => ({ operationId: 'operation-1', status: 'committed' }));
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.manageHost.v1',
        params: {
          action: 'personalHome.relocate',
          channel: 'preview',
          relayRuntime: { channel: 'preview', mode: 'system' },
          personalHomeRelocation: {
            operationId: 'operation-1',
            destinationMachineId: 'machine-2',
            sourceDescriptorRevision: 7,
          },
          ssh: { target: 'relocation@example.test', auth: 'agent', port: 2222 },
        },
      },
      taskId: 'task_remote_relocation_1',
      registry: createHsetupSystemTaskRegistry({
        remoteSshManageHost: {
          resolveHostTrust: async () => ({ status: 'trusted' }),
          installRemoteCli: async () => undefined,
          runPersonalHomeRelocation,
        },
      }),
      now: () => 1700000000000,
      emitEvent: () => undefined,
    });
    expect(result).toMatchObject({ ok: true, data: { action: 'personalHome.relocate', personalHome: { operationId: 'operation-1', status: 'committed' } } });
    expect(runPersonalHomeRelocation).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'preview',
      mode: 'system',
      operationId: 'operation-1',
      sourceDescriptorRevision: 7,
      destinationMachineId: 'machine-2',
      ssh: expect.objectContaining({ target: 'relocation@example.test', port: 2222 }),
    }));
  });

  it('runs secureAccess.tailscale.v1 with the existing tailnet-only serve URL when tailscale is already ready', async () => {
    const fakeCli = createFakeTailscaleCli({
      serveStatuses: [
        [
          'https://relay.tailf00.ts.net',
          '|-- / proxy http://127.0.0.1:3005',
        ].join('\n'),
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
          },
        },
        taskId: 'task_tailscale_ready_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_ready_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: true,
          shareableHttpsUrl: 'https://relay.tailf00.ts.net',
          requiresApproval: null,
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.verifyUrl' }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
        ['status', '--json'],
        ['serve', 'status'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs secureAccess.tailscale.v1 through interactive login and returns a structured approval URL when serve needs tailnet approval', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusJsons: [
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
        {
          BackendState: 'Running',
          AuthURL: '',
          HaveNodeKey: true,
          Self: {
            DNSName: 'relay.tailf00.ts.net.',
          },
          CurrentTailnet: {
            Name: 'example-tailnet',
          },
          TailscaleIPs: ['100.64.0.10'],
        },
      ],
      loginOutputs: [
        {
          exitCode: 0,
          stdout: 'To authenticate, visit https://login.tailscale.com/a/example',
        },
      ],
      serveStatuses: ['', ''],
      serveEnableOutputs: [
        {
          exitCode: 1,
          stderr: 'To authorize your tailnet, visit https://login.tailscale.com/f/serve?node=node-123',
        },
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const previousPollTimeoutMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
    const previousPollIntervalMs = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');
      process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = '0';
      process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = '1';

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            loginPolicy: 'interactive',
          },
        },
        taskId: 'task_tailscale_approval_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_approval_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: false,
          shareableHttpsUrl: null,
          requiresApproval: {
            url: 'https://login.tailscale.com/f/serve?node=node-123',
          },
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.login',
          data: {
            kind: 'needsUserAction.scanQr',
            url: 'https://login.tailscale.com/a/example',
            usedQr: true,
          },
        }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'tailscale.serveEnable',
        }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.serveEnable',
          data: {
            kind: 'tailscaleServeApproval',
            url: 'https://login.tailscale.com/f/serve?node=node-123',
          },
        }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
        ['login', '--qr'],
        ['status', '--json'],
        ['status', '--json'],
        ['serve', 'status'],
        ['serve', 'status'],
        ['serve', '--bg', 'http://127.0.0.1:3005'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      restoreEnvVar('HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS', previousPollTimeoutMs);
      restoreEnvVar('HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS', previousPollIntervalMs);
      fakeCli.cleanup();
    }
  });

  it('polls for interactive tailscale login completion when status remains logged out after the login command', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusJsons: [
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
        {
          BackendState: 'Running',
          AuthURL: '',
          HaveNodeKey: true,
          Self: {
            DNSName: 'relay.tailf00.ts.net.',
          },
          CurrentTailnet: {
            Name: 'example-tailnet',
          },
          TailscaleIPs: ['100.64.0.10'],
        },
      ],
      loginOutputs: [
        {
          exitCode: 0,
          stdout: 'To authenticate, visit https://login.tailscale.com/a/example',
        },
      ],
      serveStatuses: [
        [
          'https://relay.tailf00.ts.net',
          '|-- / proxy http://127.0.0.1:3005',
        ].join('\n'),
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const previousLoginTimeoutMs = process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS;
    const previousLoginIntervalMs = process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');
      process.env.HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS = '5000';
      process.env.HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS = '1';

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            loginPolicy: 'interactive',
          },
        },
        taskId: 'task_tailscale_login_poll_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_login_poll_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: true,
          shareableHttpsUrl: 'https://relay.tailf00.ts.net',
          requiresApproval: null,
        },
      });
      expect(fakeCli.readInvocations().filter((invocation) => invocation[0] === 'status' && invocation[1] === '--json')).toHaveLength(4);
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.login',
        }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'tailscale.verifyUrl',
        }),
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      restoreEnvVar('HAPPIER_TAILSCALE_LOGIN_POLL_TIMEOUT_MS', previousLoginTimeoutMs);
      restoreEnvVar('HAPPIER_TAILSCALE_LOGIN_POLL_INTERVAL_MS', previousLoginIntervalMs);
      fakeCli.cleanup();
    }
  });

  it('prompts for managedAdmin tailscale login without running the interactive login command', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusJsons: [
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            mode: 'managedAdmin',
            loginPolicy: 'interactive',
          },
        },
        taskId: 'task_tailscale_managed_admin_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_managed_admin_1',
        ok: false,
        error: {
          code: 'prompt_required',
          message: 'Complete Tailscale sign-in before enabling secure access.',
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.login',
          data: {
            kind: 'needsUserAction.openUrl',
            url: 'https://login.tailscale.com/a/example',
            usedQr: false,
          },
        }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('returns prompt_required with a structured install prompt when installIfMissing is requested but tailscale is unavailable', async () => {
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousInstallMode = process.env.HAPPIER_TAILSCALE_INSTALL_MODE;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = join(tmpdir(), `missing-tailscale-${Date.now()}`);
      process.env.HAPPIER_TAILSCALE_INSTALL_MODE = 'manual';

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            installPolicy: 'installIfMissing',
          },
        },
        taskId: 'task_tailscale_install_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_install_1',
        ok: false,
        error: {
          code: 'prompt_required',
          message: 'Install Tailscale and rerun secure access setup.',
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'tailscale.install',
        }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.install',
          data: {
            kind: 'tailscaleInstall',
            platform: process.platform,
            url: expect.any(String),
          },
        }),
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_TAILSCALE_INSTALL_MODE', previousInstallMode);
      vi.unstubAllGlobals();
    }
  });

  it('runs tailscale.ensureReady.v1 through interactive login and returns structured readiness data', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusJsons: [
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
        {
          BackendState: 'Running',
          AuthURL: '',
          HaveNodeKey: true,
          Self: {
            DNSName: 'relay.tailf00.ts.net.',
          },
          CurrentTailnet: {
            Name: 'example-tailnet',
          },
          TailscaleIPs: ['100.64.0.10'],
        },
      ],
      loginOutputs: [
        {
          exitCode: 0,
          stdout: 'To authenticate, visit https://login.tailscale.com/a/example',
        },
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'tailscale.ensureReady.v1',
          params: {
            loginPolicy: 'interactive',
          },
        },
        taskId: 'task_tailscale_ensure_ready_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_ensure_ready_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          authUrl: null,
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'tailscale.detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'tailscale.login',
          data: {
            kind: 'needsUserAction.scanQr',
            url: 'https://login.tailscale.com/a/example',
            usedQr: true,
          },
        }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
        ['login', '--qr'],
        ['status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs relay.access.configure.v1 and redacts sensitive provider details in the task result', async () => {
    const store: { config: unknown } = { config: null };
    const events: unknown[] = [];

    const registry = createHsetupSystemTaskRegistry({
      relayAccess: {
        readConfig: async () => store.config as never,
        writeConfig: async (params) => {
          store.config = params.config;
        },
        getProvider: () => ({
          descriptor: relayDescriptor({ kind: 'builtin', id: 'cloudflareNamed' }),
          status: async () => ({
            state: 'enabled',
            shareUrl: 'https://relay.example.test',
            details: {
              token: 'super-secret',
              ok: true,
            },
          }),
        }),
      },
    });

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.access.configure.v1',
        params: {
          target: { kind: 'local' },
          config: relaySelection('cloudflareNamed', { hostname: 'relay.example.test' }, [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'account-a' } } }]),
        },
      },
      taskId: 'task_relay_access_configure_1',
      registry,
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events.map((event) => (event as { stepId?: string }).stepId)).toEqual([
      'relay.access.configure.persist',
      'relay.access.configure.verify',
    ]);
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_relay_access_configure_1',
      ok: true,
      data: {
        configured: true,
        providerId: 'cloudflareNamed',
        selection: relaySelection('cloudflareNamed', { hostname: 'relay.example.test' }, [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'account-a' } } }]),
        status: {
          state: 'enabled',
          shareUrl: 'https://relay.example.test',
          details: {
            ok: true,
          },
        },
      },
    });
  });

  it('provides a local command runner for relay.access.configure.v1 when configuring command-backed providers', async () => {
    const events: unknown[] = [];

    const registry = createHsetupSystemTaskRegistry({
      relayAccess: {
        readConfig: async () => null as never,
        writeConfig: async () => {},
        getProvider: () => ({
          descriptor: relayDescriptor({ kind: 'builtin', id: 'tailscaleServe' }),
          configure: async ({ ctx }) => {
            if (!ctx.runCommand) {
              return { state: 'error', details: { reason: 'missing_run_command' } };
            }
            if (ctx.upstreamUrl !== 'http://127.0.0.1:3005') {
              return { state: 'error', details: { reason: 'unexpected_upstream_url', upstreamUrl: ctx.upstreamUrl } };
            }
            return { state: 'enabled', shareUrl: 'https://relay.example.test' };
          },
          status: async ({ ctx }) => {
            if (!ctx.runCommand) {
              return { state: 'error', details: { reason: 'missing_run_command' } };
            }
            return { state: 'enabled', shareUrl: 'https://relay.example.test' };
          },
        }),
      },
    });

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.access.configure.v1',
        params: {
          target: { kind: 'local' },
          upstreamUrl: 'http://127.0.0.1:3005',
          config: relaySelection('tailscaleServe'),
        },
      },
      taskId: 'task_relay_access_configure_local_runner_1',
      registry,
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_relay_access_configure_local_runner_1',
      ok: true,
      data: {
        configured: true,
        providerId: 'tailscaleServe',
        selection: relaySelection('tailscaleServe'),
        status: {
          state: 'enabled',
          shareUrl: 'https://relay.example.test',
          details: null,
        },
      },
    });
  });

  it('persists relay access configuration across registry restarts by default', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hsetup-relay-access-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const registry1 = createHsetupSystemTaskRegistry();
      const configure = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'relay.access.configure.v1',
          params: {
            target: { kind: 'local' },
            config: relaySelection('lan', { url: 'http://10.0.0.5:3005' }),
          },
        },
        taskId: 'task_relay_access_persist_1',
        registry: registry1,
        now: () => 1700000000000,
        emitEvent: () => undefined,
      });
      expect(configure.ok).toBe(true);

      const registry2 = createHsetupSystemTaskRegistry();
      const status = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'relay.access.status.v1',
          params: {
            target: { kind: 'local' },
          },
        },
        taskId: 'task_relay_access_persist_2',
        registry: registry2,
        now: () => 1700000000000,
        emitEvent: () => undefined,
      });

      expect(status).toEqual({
        protocolVersion: 1,
        taskId: 'task_relay_access_persist_2',
        ok: true,
        data: {
          configured: true,
          providerId: 'lan',
          selection: relaySelection('lan', { url: 'http://10.0.0.5:3005' }),
          status: {
            state: 'enabled',
            shareUrl: 'http://10.0.0.5:3005',
            details: null,
          },
        },
      });
    } finally {
      process.env.HOME = previousHome;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('routes a Personal Home operation task through the registry owner', async () => {
    const invoked: unknown[] = [];
    const registry = createHsetupSystemTaskRegistry({
      personalHomeOperations: {
        inspect: async () => {
          invoked.push('inspect');
          return { operation: 'inspect', status: 'ok' };
        },
        backup: async () => ({}),
        verifyBackup: async () => ({}),
        restore: async () => ({}),
        reconcileRestore: async () => undefined,
        recoverRestore: async () => ({}),
        erase: async () => ({}),
      },
    });

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.personal_home.inspect.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        },
      },
      taskId: 'task_personal_home_inspect_1',
      registry,
      now: () => 1700000000000,
      emitEvent: () => undefined,
    });

    expect(result).toMatchObject({ ok: true, data: { operation: 'inspect', status: 'ok' } });
    expect(invoked).toEqual(['inspect']);
  });

  it('routes the hosting-desktop owner claim through the Personal Home operations owner', async () => {
    const claimOwner = vi.fn(async () => ({
      v: 1,
      command: 'claim-home-owner',
      intent: 'initial_claim',
      homeServerIdentityId: 'home-1',
      targetAccountId: 'acct_1',
      result: { status: 'claimed', ownerAccountId: 'acct_1' },
    }));
    const registry = createHsetupSystemTaskRegistry({
      personalHomeOperations: {
        inspect: async () => ({}),
        backup: async () => ({}),
        verifyBackup: async () => ({}),
        restore: async () => ({}),
        reconcileRestore: async () => undefined,
        recoverRestore: async () => ({}),
        erase: async () => ({}),
        claimOwner,
      },
    });

    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.personal_home.claim_owner.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
          accountId: 'acct_1',
        },
      },
      taskId: 'task_personal_home_claim_owner_1',
      registry,
      now: () => 1700000000000,
      emitEvent: () => undefined,
    });

    expect(result).toMatchObject({ ok: true, data: { result: { status: 'claimed', ownerAccountId: 'acct_1' } } });
    expect(claimOwner).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct_1' }));
  });

  it('routes destination relocation status through the installed-CLI registry boundary', async () => {
    const status = vi.fn(async () => ({
      operationId: 'operation-1',
      status: 'quarantined' as const,
      bundleSha256: 'a'.repeat(64),
      expectedHomeServerIdentityId: 'home-1',
      expectedCanonicalServerUrl: 'http://127.0.0.1:43123',
      sourceDescriptorRevision: 4,
    }));
    const registry = createHsetupSystemTaskRegistry({
      loadPersonalHomeRelocationDestination: async (target) => {
        expect(target).toEqual({ channel: 'stable', mode: 'user' });
        return {
          stage: async () => { throw new Error('not used'); },
          status,
          commit: async () => { throw new Error('not used'); },
          abort: async () => { throw new Error('not used'); },
        };
      },
    });
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.personal_home.relocation_destination.status.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
          operationId: 'operation-1',
        },
      },
      taskId: 'task_personal_home_relocation_destination_status_1',
      registry,
      now: () => 1700000000000,
      emitEvent: () => undefined,
    });
    expect(result).toMatchObject({ ok: true, data: { operationId: 'operation-1', status: 'quarantined' } });
    expect(status).toHaveBeenCalledWith('operation-1');
  });

  it('registers the five source-local Personal Home task kinds against one operations instance', async () => {
    const calls: string[] = [];
    const registry = createHsetupSystemTaskRegistry({
      personalHomeOperations: {
        inspect: async () => (calls.push('inspect'), {}),
        backup: async () => (calls.push('backup'), {}),
        verifyBackup: async () => (calls.push('verify_backup'), {}),
        restore: async () => (calls.push('restore'), {}),
        reconcileRestore: async () => undefined,
        recoverRestore: async () => ({}),
        erase: async () => (calls.push('erase'), {}),
      },
    });
    const base = {
      target: { kind: 'local' as const },
      channel: 'stable' as const,
      mode: 'user' as const,
      purpose: { kind: 'personal-home' as const, canonicalServerUrl: 'http://127.0.0.1:43123' },
    };
    const specs = [
      ['relay.runtime.personal_home.inspect.v1', base],
      ['relay.runtime.personal_home.backup.v1', { ...base, outputPath: '/tmp/home.tar' }],
      ['relay.runtime.personal_home.verify_backup.v1', { ...base, archivePath: '/tmp/home.tar' }],
      ['relay.runtime.personal_home.restore.v1', { ...base, archivePath: '/tmp/home.tar', confirmOverwrite: true }],
      ['relay.runtime.personal_home.erase.v1', base],
    ] as const;

    for (const [kind, params] of specs) {
      const result = await executeSystemTask({
        spec: { protocolVersion: 1, kind, params },
        taskId: `task_${kind}`,
        registry,
        now: () => 1700000000000,
        emitEvent: () => undefined,
      });
      expect(result.ok).toBe(true);
    }

    const removedFinalization = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.personal_home.restore.v1',
        params: { ...base, action: 'finalize' },
      },
      taskId: 'task_removed_personal_home_restore_finalization',
      registry,
      now: () => 1700000000000,
      emitEvent: () => undefined,
    });
    expect(removedFinalization).toMatchObject({ ok: false, error: { code: 'invalid_params' } });

    expect(calls).toEqual(['inspect', 'backup', 'verify_backup', 'restore', 'erase']);
  });

  it('archives and restores real Home bytes through the default bootstrap registry composition', { timeout: 120_000 }, async () => {
    const homeDir = mkdtempSync(join(realpathSync(tmpdir()), 'hsetup-personal-home-default-registry-'));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    let running = true;
    let startupReceiptPath = '';
    let readinessIdentity = '';
    const engine = {
      readStatus: vi.fn(async () => ({
        installed: true,
        version: 'happier-server-bootstrap-test',
        service: { active: running, enabled: true },
        baseUrl: 'http://127.0.0.1:52123',
        healthy: true,
        purpose: { kind: 'personal-home' as const, canonicalServerUrl: 'http://127.0.0.1:52123' },
        canonicalServerUrl: 'http://127.0.0.1:52123',
        anonymousSignupEnabled: false,
      })),
      installOrUpdate: vi.fn(async () => ({ relayUrl: 'http://127.0.0.1:52123', mode: 'user' as const })),
      control: vi.fn(async (input: { action?: string }) => {
        if (input.action === 'stop') running = false;
        if (input.action === 'start') {
          running = true;
          if (startupReceiptPath && readinessIdentity) {
            mkdirSync(join(startupReceiptPath, '..'), { recursive: true });
            writeFileSync(startupReceiptPath, JSON.stringify({
              pid: process.pid,
              personalHomeReadiness: {
                authenticated: true,
                homeServerIdentityId: readinessIdentity,
                accountCount: 1,
                sessionCount: 1,
              },
            }));
          }
        }
      }),
    };
    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      const fixture = await prepareBootstrapPersonalHomeFixture(homeDir);
      startupReceiptPath = join(fixture.layout.dataDir, 'startup-receipt.json');
      readinessIdentity = fixture.identity;
      vi.resetModules();
      vi.doMock('@happier-dev/cli-common/systemTasks', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@happier-dev/cli-common/systemTasks')>();
        return {
          ...actual,
          createRelayHostEngine: (() => engine) as unknown as typeof actual.createRelayHostEngine,
          ensureLocalFirstPartyComponentCommand: vi.fn(async () => join(fixture.layout.installRoot, 'bin', 'happier-server')),
        };
      });
      const registryModule = await import('./registry.js');
      const registry = registryModule.createHsetupSystemTaskRegistry();
      const baseParams = {
        target: { kind: 'local' as const },
        channel: 'stable' as const,
        mode: 'user' as const,
        purpose: { kind: 'personal-home' as const, canonicalServerUrl: fixture.canonicalServerUrl },
      };
      const backup = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'relay.runtime.personal_home.backup.v1',
          params: { ...baseParams, outputPath: fixture.archivePath },
        },
        taskId: 'task_bootstrap_default_backup',
        registry,
        now: () => 1700000000000,
        emitEvent: () => undefined,
      });
      expect(backup).toMatchObject({
        ok: true,
        data: {
          path: fixture.archivePath,
          manifest: {
            homeServerIdentityId: fixture.identity,
            entries: expect.arrayContaining([
              expect.objectContaining({ path: 'database/home.sqlite' }),
              expect.objectContaining({ path: 'files/public/public.txt' }),
              expect.objectContaining({ path: 'files/private/private.txt' }),
              expect.objectContaining({ path: 'secrets/handy-master-secret.txt' }),
              expect.objectContaining({ path: 'configuration/home.env.json' }),
            ]),
          },
        },
      });
      expect(readFileSync(fixture.archivePath).byteLength).toBeGreaterThan(0);

      rmSync(fixture.layout.databasePath, { force: true });
      rmSync(`${fixture.layout.databasePath}-wal`, { force: true });
      rmSync(`${fixture.layout.databasePath}-shm`, { force: true });
      rmSync(fixture.layout.publicFilesDir, { recursive: true, force: true });
      rmSync(fixture.layout.privateFilesDir, { recursive: true, force: true });
      rmSync(fixture.layout.masterSecretPath, { force: true });
      running = false;
      const inspection = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'relay.runtime.personal_home.inspect.v1',
          params: baseParams,
        },
        taskId: 'task_bootstrap_default_empty_inspection',
        registry,
        now: () => 1700000000000,
        emitEvent: () => undefined,
      });
      expect(inspection).toMatchObject({ ok: true, data: { storage: { destinationEmpty: true } } });

      const restored = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'relay.runtime.personal_home.restore.v1',
          params: {
            ...baseParams,
            archivePath: fixture.archivePath,
            expectedHomeServerIdentityId: fixture.identity,
          },
        },
        taskId: 'task_bootstrap_default_restore',
        registry,
        now: () => 1700000000000,
        emitEvent: () => undefined,
      });
      expect(restored).toMatchObject({ ok: true, data: { outcome: 'restored' } });
      const restoredDatabase = new DatabaseSync(fixture.layout.databasePath, { readOnly: true });
      try {
        expect(restoredDatabase.prepare('SELECT body FROM bootstrap_transcript WHERE id = ?').get('message-1'))
          .toEqual({ body: 'bootstrap transcript bytes' });
        expect(restoredDatabase.prepare('SELECT value FROM SimpleCache WHERE key = ?').get('server.identity.v1'))
          .toEqual({ value: fixture.identity });
      } finally {
        restoredDatabase.close();
      }
      expect(readFileSync(join(fixture.layout.publicFilesDir, 'public.txt'), 'utf8')).toBe('bootstrap-public-bytes');
      expect(readFileSync(join(fixture.layout.privateFilesDir, 'private.txt'), 'utf8')).toBe('bootstrap-private-bytes');
      expect(readFileSync(fixture.layout.masterSecretPath, 'utf8')).toBe('bootstrap-master-secret');
      expect(readFileSync(join(fixture.layout.configDir, 'server.env'), 'utf8')).toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=0');
      expect(running).toBe(true);
      expect(engine.control).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop' }));
      expect(engine.control).toHaveBeenCalledWith(expect.objectContaining({ action: 'start' }));
      expect(readFileSync(join(fixture.layout.installRoot, 'bin', 'happier-server'), 'utf8')).toContain('exit 0');

      const recoveryId = '69d4c47f-d023-4d5f-8097-867b050eebac';
      const rollbackDatabase = `${fixture.layout.databasePath}.restore-rollback-${recoveryId}`;
      const recoveryStage = `${fixture.layout.dataDir}.restore-stage-${process.pid}-${recoveryId}`;
      const recoveryJournal = join(fixture.layout.dataDir, '.operations', 'restore-journal.json');
      renameSync(fixture.layout.databasePath, rollbackDatabase);
      writeFileSync(fixture.layout.databasePath, 'interrupted-new-database');
      mkdirSync(join(fixture.layout.dataDir, '.operations'), { recursive: true });
      mkdirSync(recoveryStage, { recursive: true });
      writeFileSync(recoveryJournal, JSON.stringify({
        version: 2,
        phase: 'promoting',
        stage: recoveryStage,
        wasRunning: true,
        entries: [
          { target: fixture.layout.databasePath, source: join(recoveryStage, 'database/home.sqlite'), rollback: rollbackDatabase, hadTarget: true, state: 'preserved' },
          { target: fixture.layout.publicFilesDir, source: join(recoveryStage, 'files/public'), rollback: `${fixture.layout.publicFilesDir}.restore-rollback-${recoveryId}`, hadTarget: false, state: 'untouched' },
          { target: fixture.layout.privateFilesDir, source: join(recoveryStage, 'files/private'), rollback: `${fixture.layout.privateFilesDir}.restore-rollback-${recoveryId}`, hadTarget: false, state: 'untouched' },
          { target: fixture.layout.masterSecretPath, source: join(recoveryStage, 'secrets/handy-master-secret.txt'), rollback: `${fixture.layout.masterSecretPath}.restore-rollback-${recoveryId}`, hadTarget: false, state: 'untouched' },
          { target: fixture.layout.derivedDataDir, source: join(recoveryStage, 'derived'), rollback: `${fixture.layout.derivedDataDir}.restore-rollback-${recoveryId}`, hadTarget: false, state: 'untouched' },
        ],
      }));
      running = true;
      const recovered = await executeSystemTask({
        spec: { protocolVersion: 1, kind: 'relay.runtime.personal_home.restore.v1', params: { ...baseParams, action: 'recover' } },
        taskId: 'task_bootstrap_default_recover_restore', registry, now: () => 1700000000000, emitEvent: () => undefined,
      });
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, data: { outcome: 'rolled_back', restartedHome: true } });
      const recoveredDatabase = new DatabaseSync(fixture.layout.databasePath, { readOnly: true });
      try {
        expect(recoveredDatabase.prepare('SELECT body FROM bootstrap_transcript WHERE id = ?').get('message-1'))
          .toEqual({ body: 'bootstrap transcript bytes' });
      } finally { recoveredDatabase.close(); }
      expect(() => readFileSync(recoveryJournal)).toThrow();
      expect(running).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      vi.doUnmock('@happier-dev/cli-common/systemTasks');
      vi.resetModules();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

posixDescribe('createHsetupSystemTaskRegistry cli.pathExposure kinds', () => {
  it('adds the managed CLI bin dir to the shell profile through the registry and removes it again', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hsetup-registry-cli-path-'));
    const previousHome = process.env.HOME;
    const previousShell = process.env.SHELL;
    const previousHappierHome = process.env.HAPPIER_HOME_DIR;
    const previousNoPathUpdate = process.env.HAPPIER_NO_PATH_UPDATE;
    const zshrcPath = join(homeDir, '.zshrc');
    writeFileSync(zshrcPath, '# mine\n', 'utf8');
    try {
      process.env.HOME = homeDir;
      process.env.SHELL = '/bin/zsh';
      process.env.HAPPIER_HOME_DIR = join(homeDir, '.happier');
      delete process.env.HAPPIER_NO_PATH_UPDATE;
      const registry = createHsetupSystemTaskRegistry();
      const params = { surface: 'desktop.ui', target: { kind: 'local' }, mode: 'user' };

      const ensured = await executeSystemTask({
        spec: { protocolVersion: 1, kind: 'cli.pathExposure.ensure.v1', params },
        taskId: 'task_cli_path_ensure_1',
        registry,
        now: () => 1700000000000,
        emitEvent() {},
      });
      expect(ensured).toMatchObject({
        ok: true,
        data: { changed: true, shellReloadHint: expect.stringContaining(zshrcPath), failure: null },
      });
      expect(readFileSync(zshrcPath, 'utf8')).toContain(`export PATH="${join(homeDir, '.happier', 'bin')}:$PATH"`);

      const removed = await executeSystemTask({
        spec: { protocolVersion: 1, kind: 'cli.pathExposure.remove.v1', params },
        taskId: 'task_cli_path_remove_1',
        registry,
        now: () => 1700000000000,
        emitEvent() {},
      });
      expect(removed).toMatchObject({ ok: true, data: { removed: true, failure: null } });
      expect(readFileSync(zshrcPath, 'utf8')).toBe('# mine\n');
    } finally {
      restoreEnvVar('HOME', previousHome);
      restoreEnvVar('SHELL', previousShell);
      restoreEnvVar('HAPPIER_HOME_DIR', previousHappierHome);
      restoreEnvVar('HAPPIER_NO_PATH_UPDATE', previousNoPathUpdate);
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
