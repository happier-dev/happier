import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';
import { writePersonalHomeServerArtifactCapability } from '../firstPartyRuntime/personalHome/artifactContract.js';

const mockedLocalHost = vi.hoisted(() => ({ homeDir: null as string | null }));
const mockedLocalListener = vi.hoisted(() => ({ state: 'actual' as 'actual' | 'healthy' | 'stopped' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockedLocalHost.homeDir ?? actual.homedir(),
  };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    createConnection: (options: import('node:net').NetConnectOpts, connectionListener?: () => void) => {
      if (mockedLocalListener.state === 'actual') return actual.createConnection(options, connectionListener);
      const socket = new EventEmitter() as import('node:events').EventEmitter & {
        setTimeout: (timeoutMs: number) => void;
        destroy: () => void;
      };
      socket.setTimeout = () => undefined;
      socket.destroy = () => undefined;
      process.nextTick(() => socket.emit(mockedLocalListener.state === 'healthy' ? 'connect' : 'error', new Error('connection refused')));
      return socket;
    },
  };
});

const CANONICAL_SERVER_URL = 'http://127.0.0.1:43123';
const PUBLIC_SERVER_URL = 'https://home.example.test';
const PERSONAL_HOME_PURPOSE = { kind: 'personal-home', canonicalServerUrl: CANONICAL_SERVER_URL } as const;

describe('RelayHostEngine (Personal Home mutation seam)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockedLocalHost.homeDir = null;
    mockedLocalListener.state = 'actual';
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function createInstalledPersonalHomeRuntime(options: Readonly<{ withInitializedHome?: boolean }> = {}): Promise<Readonly<{
    homeDir: string;
    defaults: ReturnType<typeof resolveRelayRuntimeDefaults>;
    dispose: () => Promise<void>;
  }>> {
    const homeDir = await mkdtemp(join(tmpdir(), 'personal-home-mutation-'));
    const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
    await mkdir(defaults.installRoot, { recursive: true });
    await mkdir(defaults.configDir, { recursive: true });
    await writeFile(join(defaults.installRoot, 'self-host-state.json'), JSON.stringify({
      version: '0.3.0-test',
      purpose: PERSONAL_HOME_PURPOSE,
    }), 'utf8');
    await writeFile(join(defaults.configDir, 'server.env'), [
      'PORT=43123',
      'HAPPIER_SERVER_HOST=127.0.0.1',
      `HAPPIER_CANONICAL_SERVER_URL=${CANONICAL_SERVER_URL}`,
      `HAPPIER_PUBLIC_SERVER_URL=${PUBLIC_SERVER_URL}`,
      'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
      'HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=1',
      'HAPPIER_SQLITE_AUTO_MIGRATE=1',
    ].join('\n') + '\n', 'utf8');
    if (options.withInitializedHome) {
      const migrationName = '20260903000000_test';
      const migrationSql = 'CREATE TABLE test_fixture (id TEXT);';
      const migrationDir = join(defaults.installRoot, 'bin', 'prisma', 'sqlite', 'migrations', migrationName);
      await mkdir(migrationDir, { recursive: true });
      await writeFile(join(migrationDir, 'migration.sql'), migrationSql, 'utf8');
      await mkdir(defaults.dataDir, { recursive: true });
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(join(defaults.dataDir, 'happier-server-light.sqlite'));
      database.exec('CREATE TABLE SimpleCache (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      database.exec('CREATE TABLE _prisma_migrations (migration_name TEXT NOT NULL, checksum TEXT NOT NULL, finished_at TEXT, rolled_back_at TEXT)');
      database.prepare('INSERT INTO SimpleCache (key, value) VALUES (?, ?)').run('server.identity.v1', 'home-test');
      database.prepare('INSERT INTO _prisma_migrations (migration_name, checksum, finished_at) VALUES (?, ?, ?)')
        .run(migrationName, createHash('sha256').update(migrationSql).digest('hex'), '2026-09-03T00:00:00.000Z');
      database.close();
    }
    return {
      homeDir,
      defaults,
      dispose: async () => {
        await rm(homeDir, { recursive: true, force: true });
      },
    };
  }

  async function writeLocalServerBinary(homeDir: string): Promise<string> {
    const payloadRoot = join(homeDir, 'payload');
    await mkdir(payloadRoot, { recursive: true });
    const serverBinaryPath = join(payloadRoot, 'happier-server');
    await writeFile(serverBinaryPath, '#!/bin/sh\n', 'utf8');
    await writePersonalHomeServerArtifactCapability(payloadRoot);
    return serverBinaryPath;
  }

  function mockLinuxHost(homeDir: string, serviceState: 'missing' | 'active' = 'missing'): void {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockedLocalHost.homeDir = homeDir;
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: () => ({
          status: 0,
          stdout: serviceState === 'active'
            ? 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n'
            : 'LoadState=not-found\n',
          stderr: '',
        }),
      };
    });
    vi.doMock('../service/index.js', async () => {
      const actual = await vi.importActual<typeof import('../service/index.js')>('../service/index.js');
      return {
        ...actual,
        resolveServiceBackend: () => 'systemd-user',
      };
    });
  }

  function mockHealthyLocalHome(): void {
    globalThis.fetch = vi.fn(async () => {
      const homeDir = mockedLocalHost.homeDir;
      if (homeDir) {
        const unitPath = join(homeDir, '.config', 'systemd', 'user', 'happier-server-preview.service');
        const unit = await readFile(unitPath, 'utf8').catch(() => '');
        const receiptPath = unit.match(/^Environment=HAPPIER_SERVER_STARTUP_RECEIPT_PATH=(.+)$/mu)?.[1]?.replace(/^"|"$/gu, '');
        const nonce = unit.match(/^Environment=HAPPIER_SERVER_STARTUP_RECEIPT_NONCE=(.+)$/mu)?.[1]?.replace(/^"|"$/gu, '');
        if (receiptPath && nonce) {
          await mkdir(dirname(receiptPath), { recursive: true });
          await writeFile(receiptPath, JSON.stringify({
            nonce,
            pid: process.pid,
            host: '127.0.0.1',
            port: 43123,
            personalHomeReadiness: {
              authenticated: true,
              homeServerIdentityId: 'home-test',
              accountCount: 1,
              sessionCount: 0,
            },
          }));
        }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    mockedLocalListener.state = 'healthy';
  }

  function mockStoppedLocalHome(): void {
    mockedLocalListener.state = 'stopped';
  }

  function mockRecordingHomeLock(lockEvents: string[]): void {
    vi.doMock('../firstPartyRuntime/personalHome/lock.js', async () => {
      const actual = await vi.importActual<typeof import('../firstPartyRuntime/personalHome/lock.js')>(
        '../firstPartyRuntime/personalHome/lock.js',
      );
      return {
        ...actual,
        withPersonalHomeOperationLock: async (dataDir: string, operation: string, run: () => Promise<unknown>) => {
          lockEvents.push(`home:${operation}:acquired`);
          try {
            return await run();
          } finally {
            lockEvents.push(`home:${operation}:released`);
          }
        },
      };
    });
  }

  async function createTestEngine() {
    const { createRelayHostEngine } = await import('./relayHostEngine.js');
    return createRelayHostEngine({
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '/tmp/happier-server', versionId: 'preview-1' }),
    });
  }

  it('restarts an existing Personal Home under its lock without rerunning updater migrations', { timeout: 30_000 }, async () => {
    const runtime = await createInstalledPersonalHomeRuntime({ withInitializedHome: true });
    const lockEvents: string[] = [];
    try {
      mockLinuxHost(runtime.homeDir);
      mockHealthyLocalHome();
      mockRecordingHomeLock(lockEvents);

      const engine = await createTestEngine();
      await engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        action: 'restart',
      });

      expect(lockEvents).toEqual(['home:lifecycle:acquired', 'home:lifecycle:released']);
      const unit = await readFile(join(runtime.homeDir, '.config', 'systemd', 'user', 'happier-server-preview.service'), 'utf8');
      expect(unit).toMatch(/^Environment=HAPPIER_SQLITE_AUTO_MIGRATE=0$/mu);
      const envText = await readFile(join(runtime.defaults.configDir, 'server.env'), 'utf8');
      expect(envText).toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=0');
      const stateText = await readFile(join(runtime.defaults.installRoot, 'self-host-state.json'), 'utf8');
      expect(JSON.parse(stateText).purpose).toEqual(PERSONAL_HOME_PURPOSE);
    } finally {
      await runtime.dispose();
    }
  });

  it('blocks an ordinary start while this runtime is a quarantined relocation destination', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    try {
      mockLinuxHost(runtime.homeDir);
      mockStoppedLocalHome();
      const operationsDir = join(runtime.defaults.dataDir, '.operations');
      await mkdir(operationsDir, { recursive: true });
      await writeFile(join(operationsDir, 'relocation-destination.json'), `${JSON.stringify({
        version: 1,
        operationId: 'system-task:relocation-guard',
        status: 'quarantined',
        bundleSha256: 'a'.repeat(64),
        expectedHomeServerIdentityId: 'srv_home_1',
        expectedCanonicalServerUrl: CANONICAL_SERVER_URL,
        sourceDescriptorRevision: 4,
        homeServerIdentityId: 'srv_home_1',
        connectionDescriptor: {
          v: 1, homeServerIdentityId: 'srv_home_1', canonicalServerUrl: CANONICAL_SERVER_URL,
          revision: 5, endpoints: [{ kind: 'https', url: CANONICAL_SERVER_URL }],
        },
        authenticated: true,
        accountCount: 1,
        sessionCount: 0,
      })}\n`, 'utf8');

      const engine = await createTestEngine();
      await expect(engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        action: 'start',
      })).rejects.toMatchObject({
        code: 'PERSONAL_HOME_RELOCATION_DESTINATION_ACTIVATION_BLOCKED',
      });
      const serverBinaryPath = await writeLocalServerBinary(runtime.homeDir);
      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
        purpose: PERSONAL_HOME_PURPOSE,
        env: { PORT: '43123', AUTH_ANONYMOUS_SIGNUP_ENABLED: '0' },
      })).rejects.toMatchObject({
        code: 'operation_recovery_required',
      });
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  it('allows the canonical engine to activate a source only after recovery records proven source authority', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    try {
      mockLinuxHost(runtime.homeDir, 'active');
      mockHealthyLocalHome();
      const operationsDir = join(runtime.defaults.dataDir, '.operations');
      await mkdir(operationsDir, { recursive: true });
      await writeFile(join(operationsDir, 'relocation-source.json'), `${JSON.stringify({
        version: 1,
        operationId: 'system-task:relocation-return',
        phase: 'returning_to_source',
        destinationMachineId: 'destination-machine',
        bundleSha256: 'b'.repeat(64),
        homeServerIdentityId: 'srv_home_1',
        sourceCanonicalServerUrl: CANONICAL_SERVER_URL,
        sourceDescriptorRevision: 4,
        sourceDescriptor: {
          v: 1,
          homeServerIdentityId: 'srv_home_1',
          canonicalServerUrl: CANONICAL_SERVER_URL,
          revision: 4,
          endpoints: [{ kind: 'https', url: CANONICAL_SERVER_URL }],
        },
      })}\n`, 'utf8');

      const engine = await createTestEngine();
      await expect(engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        action: 'activate',
      })).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  it('does not deadlock lifecycle control inside an operation that already holds the Home lock in this process', async () => {
    const runtime = await createInstalledPersonalHomeRuntime({ withInitializedHome: true });
    try {
      mockLinuxHost(runtime.homeDir);
      mockHealthyLocalHome();

      const engine = await createTestEngine();
      const { withPersonalHomeOperationLock } = await import('../firstPartyRuntime/personalHome/lock.js');
      await withPersonalHomeOperationLock(runtime.defaults.dataDir, 'backup', async () => {
        await engine.control({
          target: { kind: 'local' },
          mode: 'user',
          channel: 'preview',
          action: 'restart',
        });
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('a managed update with an omitted purpose preserves the persisted classification, closed signup, and approval policy', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    const lockEvents: string[] = [];
    try {
      mockLinuxHost(runtime.homeDir);
      mockStoppedLocalHome();
      mockRecordingHomeLock(lockEvents);
      const serverBinaryPath = await writeLocalServerBinary(runtime.homeDir);

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: serverBinaryPath, versionId: 'preview-2' }),
        localInstallPolicy: { runServiceCommands: false, skipHealthCheck: true },
      });

      await engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      });

      const stateText = await readFile(join(runtime.defaults.installRoot, 'self-host-state.json'), 'utf8');
      expect(JSON.parse(stateText).purpose).toEqual(PERSONAL_HOME_PURPOSE);

      const envText = await readFile(join(runtime.defaults.configDir, 'server.env'), 'utf8');
      expect(envText.match(/^AUTH_ANONYMOUS_SIGNUP_ENABLED=0$/gmu)).toHaveLength(1);
      expect(envText).not.toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=1');
      expect(envText).toContain('HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=1');
      expect(envText).toContain('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=plaintext_only');
      expect(envText).toContain('HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE=plain');

      expect(lockEvents).toContain('home:upgrade:acquired');

      const status = await engine.readStatus({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
      });
      expect(status.purpose).toEqual(PERSONAL_HOME_PURPOSE);
      expect(status.canonicalServerUrl).toBe(CANONICAL_SERVER_URL);
      expect(status.anonymousSignupEnabled).toBe(false);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('fails closed when the persisted Home environment cannot be read', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    const envPath = join(runtime.defaults.configDir, 'server.env');
    try {
      mockLinuxHost(runtime.homeDir);
      mockStoppedLocalHome();
      await chmod(envPath, 0o000);

      const engine = await createTestEngine();
      await expect(engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        action: 'start',
      })).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(envPath, 0o600).catch(() => undefined);
      await runtime.dispose();
    }
  }, 30_000);

  it('rejects an unsafe persisted Home layout before uninstall mutates runtime state', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    try {
      mockLinuxHost(runtime.homeDir);
      mockStoppedLocalHome();
      const envPath = join(runtime.defaults.configDir, 'server.env');
      const statePath = join(runtime.defaults.installRoot, 'self-host-state.json');
      const stateBefore = await readFile(statePath, 'utf8');
      const unsafeEnv = `${await readFile(envPath, 'utf8')}DATABASE_URL=file:${join(runtime.homeDir, 'outside-home.sqlite')}\n`;
      await writeFile(envPath, unsafeEnv);
      const engine = await createTestEngine();
      await expect(engine.control({ target: { kind: 'local' }, mode: 'user', channel: 'preview', action: 'uninstall' }))
        .rejects.toThrow('inside the canonical data root');
      expect(await readFile(statePath, 'utf8')).toBe(stateBefore);
      expect(await readFile(envPath, 'utf8')).toBe(unsafeEnv);
    } finally { await runtime.dispose(); }
  }, 30_000);

  it('safe uninstall preserves the Personal Home classification for an omitted-purpose reinstall', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    const lockEvents: string[] = [];
    try {
      mockLinuxHost(runtime.homeDir);
      mockStoppedLocalHome();
      mockRecordingHomeLock(lockEvents);
      const serverBinaryPath = await writeLocalServerBinary(runtime.homeDir);
      const customDataDir = join(runtime.homeDir, 'custom-home-data');
      const customDatabasePath = join(customDataDir, 'database', 'home.sqlite');
      const customFilesDir = join(runtime.homeDir, 'custom-home-files');
      const customEnv = [
        'PORT=43123',
        'HAPPIER_SERVER_HOST=127.0.0.1',
        `HAPPIER_CANONICAL_SERVER_URL=${CANONICAL_SERVER_URL}`,
        `HAPPIER_PUBLIC_SERVER_URL=${PUBLIC_SERVER_URL}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${customDataDir}`,
        `DATABASE_URL=file:${customDatabasePath}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${customFilesDir}`,
        'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        'HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=1',
        '',
      ].join('\n');
      await writeFile(join(runtime.defaults.configDir, 'server.env'), customEnv, 'utf8');
      await mkdir(customDataDir, { recursive: true });
      await mkdir(customFilesDir, { recursive: true });
      await writeFile(join(customDataDir, 'handy-master-secret.txt'), 'preserved-home-secret');
      await writeFile(join(customFilesDir, 'preserved.txt'), 'preserved-home-file');

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: serverBinaryPath, versionId: 'preview-2' }),
        localInstallPolicy: { runServiceCommands: false, skipHealthCheck: true },
      });

      await engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        action: 'uninstall',
      });

      const statePath = join(runtime.defaults.installRoot, 'self-host-state.json');
      const uninstalledState = JSON.parse(await readFile(statePath, 'utf8'));
      expect(uninstalledState).toEqual({ retainedPersonalHomeVersion: '0.3.0-test', purpose: PERSONAL_HOME_PURPOSE });
      expect(await readFile(join(runtime.defaults.configDir, 'server.env'), 'utf8')).toBe(customEnv);
      expect(await readFile(join(customDataDir, 'handy-master-secret.txt'), 'utf8')).toBe('preserved-home-secret');
      expect(await readFile(join(customFilesDir, 'preserved.txt'), 'utf8')).toBe('preserved-home-file');

      // The persisted purpose and retained environment remain the canonical identity and
      // storage-location authorities while no runtime is installed.
      const uninstalledStatus = await engine.readStatus({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
      });
      expect(uninstalledStatus).toMatchObject({
        installed: false,
        purpose: PERSONAL_HOME_PURPOSE,
        baseUrl: CANONICAL_SERVER_URL,
        canonicalServerUrl: CANONICAL_SERVER_URL,
        dataPresent: true,
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      })).resolves.toMatchObject({ purpose: PERSONAL_HOME_PURPOSE });

      const reinstalledState = JSON.parse(await readFile(statePath, 'utf8'));
      expect(reinstalledState.purpose).toEqual(PERSONAL_HOME_PURPOSE);
      const reinstalledEnv = await readFile(join(runtime.defaults.configDir, 'server.env'), 'utf8');
      expect(reinstalledEnv).toContain(`HAPPIER_SERVER_LIGHT_DATA_DIR=${customDataDir}`);
      expect(reinstalledEnv).toContain(`DATABASE_URL=file:${customDatabasePath}`);
      expect(reinstalledEnv).toContain(`HAPPIER_SERVER_LIGHT_FILES_DIR=${customFilesDir}`);
      expect(await readFile(join(customDataDir, 'handy-master-secret.txt'), 'utf8')).toBe('preserved-home-secret');
      expect(await readFile(join(customFilesDir, 'preserved.txt'), 'utf8')).toBe('preserved-home-file');
      expect(lockEvents).toEqual([
        'home:uninstall:acquired',
        'home:uninstall:released',
        'home:upgrade:acquired',
        'home:upgrade:released',
      ]);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  it('uses the persisted Personal Home origin when an installed erased runtime has no environment', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    try {
      mockLinuxHost(runtime.homeDir);
      mockStoppedLocalHome();
      await rm(join(runtime.defaults.configDir, 'server.env'));

      const engine = await createTestEngine();
      const status = await engine.readStatus({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
      });

      expect(status).toMatchObject({
        installed: true,
        purpose: PERSONAL_HOME_PURPOSE,
        baseUrl: CANONICAL_SERVER_URL,
        canonicalServerUrl: CANONICAL_SERVER_URL,
      });

      await writeFile(join(runtime.defaults.configDir, 'server.env'), 'PORT=not-a-port\n', 'utf8');
      const malformedEnvironmentStatus = await engine.readStatus({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
      });
      expect(malformedEnvironmentStatus.baseUrl).toBe(CANONICAL_SERVER_URL);
    } finally {
      await runtime.dispose();
    }
  });

  it('generic runtime uninstall does not retain a caller-requested Personal Home classification', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    try {
      mockLinuxHost(runtime.homeDir);
      await writeFile(join(runtime.defaults.installRoot, 'self-host-state.json'), JSON.stringify({
        version: '0.3.0-test',
        purpose: { kind: 'generic' },
      }), 'utf8');

      const engine = await createTestEngine();
      await engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        purpose: PERSONAL_HOME_PURPOSE,
        action: 'uninstall',
      });

      expect(existsSync(join(runtime.defaults.installRoot, 'self-host-state.json'))).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it('fails closed before update when Home data exists but persisted purpose is missing', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    const lockEvents: string[] = [];
    try {
      mockLinuxHost(runtime.homeDir);
      mockRecordingHomeLock(lockEvents);
      const serverBinaryPath = await writeLocalServerBinary(runtime.homeDir);
      await rm(join(runtime.defaults.installRoot, 'self-host-state.json'), { force: true });
      await mkdir(runtime.defaults.dataDir, { recursive: true });
      await writeFile(join(runtime.defaults.dataDir, 'handy-master-secret.txt'), 'preserved-home-secret');

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: serverBinaryPath, versionId: 'preview-2' }),
        localInstallPolicy: { runServiceCommands: false, skipHealthCheck: true },
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      })).rejects.toMatchObject({ code: 'PERSONAL_HOME_CLASSIFICATION_REQUIRED' });

      expect(lockEvents).toEqual([]);
      expect(existsSync(join(runtime.defaults.installRoot, 'self-host-state.json'))).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it('reinstalls preserved Home data when an explicit purpose matches the preserved configuration', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    const lockEvents: string[] = [];
    try {
      mockLinuxHost(runtime.homeDir);
      mockRecordingHomeLock(lockEvents);
      const serverBinaryPath = await writeLocalServerBinary(runtime.homeDir);
      await rm(join(runtime.defaults.installRoot, 'self-host-state.json'), { force: true });
      await mkdir(runtime.defaults.dataDir, { recursive: true });
      await writeFile(join(runtime.defaults.dataDir, 'handy-master-secret.txt'), 'preserved-home-secret');

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: serverBinaryPath, versionId: 'preview-2' }),
        localInstallPolicy: { runServiceCommands: false, skipHealthCheck: true },
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
        purpose: PERSONAL_HOME_PURPOSE,
      })).resolves.toMatchObject({ purpose: PERSONAL_HOME_PURPOSE });

      expect(lockEvents).toContain('home:upgrade:acquired');
      const state = JSON.parse(await readFile(join(runtime.defaults.installRoot, 'self-host-state.json'), 'utf8'));
      expect(state.purpose).toEqual(PERSONAL_HOME_PURPOSE);
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects an explicit Personal Home purpose that re-points the persisted canonical origin without mutating the runtime', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    const lockEvents: string[] = [];
    try {
      mockLinuxHost(runtime.homeDir);
      mockRecordingHomeLock(lockEvents);
      const serverBinaryPath = await writeLocalServerBinary(runtime.homeDir);

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: serverBinaryPath, versionId: 'preview-2' }),
        localInstallPolicy: { runServiceCommands: false, skipHealthCheck: true },
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://localhost:43123' },
      })).rejects.toThrow(/canonical/i);

      const stateText = await readFile(join(runtime.defaults.installRoot, 'self-host-state.json'), 'utf8');
      expect(JSON.parse(stateText).purpose).toEqual(PERSONAL_HOME_PURPOSE);
      const envText = await readFile(join(runtime.defaults.configDir, 'server.env'), 'utf8');
      expect(envText).toContain(`HAPPIER_PUBLIC_SERVER_URL=${PUBLIC_SERVER_URL}`);
      expect(lockEvents).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects an explicit generic purpose on an installed Personal Home runtime instead of declassifying it', async () => {
    const runtime = await createInstalledPersonalHomeRuntime();
    const lockEvents: string[] = [];
    try {
      mockLinuxHost(runtime.homeDir);
      mockRecordingHomeLock(lockEvents);

      const engine = await createTestEngine();
      await expect(engine.control({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        purpose: { kind: 'generic' },
        action: 'uninstall',
      } as never)).rejects.toThrow(/Personal Home/i);

      expect(lockEvents).toEqual([]);
      expect(existsSync(join(runtime.defaults.installRoot, 'self-host-state.json'))).toBe(true);
      const stateText = await readFile(join(runtime.defaults.installRoot, 'self-host-state.json'), 'utf8');
      expect(JSON.parse(stateText).purpose).toEqual(PERSONAL_HOME_PURPOSE);
    } finally {
      await runtime.dispose();
    }
  });
});
