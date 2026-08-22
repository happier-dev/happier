import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { projectPath } from '@/projectPath';
import type { HappyProcessInfo } from './doctor';

const {
  findHappyProcessByPidMock,
  readProcessIdentityByPidMock,
} = vi.hoisted(() => ({
  findHappyProcessByPidMock: vi.fn<(pid: number) => Promise<HappyProcessInfo>>(async (pid) => ({
    pid,
    command: 'happier daemon start-sync',
    type: 'daemon' as const,
    daemonOwnershipEnvironmentVariables: {
      HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR ?? '',
      HAPPIER_ACTIVE_SERVER_ID: process.env.HAPPIER_ACTIVE_SERVER_ID ?? 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? 'cloud',
      HAPPIER_SERVER_URL: process.env.HAPPIER_SERVER_URL ?? 'https://api.happier.dev',
    },
  })),
  readProcessIdentityByPidMock: vi.fn(async (pid: number) => ({
    pid,
    command: `${process.cwd()}/apps/cli/src/index.ts daemon start-sync`,
    processStartTimeMs: 1_000,
  })),
}));

vi.mock('@/daemon/doctor', () => ({
  findHappyProcessByPid: (pid: number) => findHappyProcessByPidMock(pid),
}));

vi.mock('@/daemon/processIdentity', () => ({
  readProcessIdentityByPid: (pid: number) => readProcessIdentityByPidMock(pid),
}));

function writeDaemonLockFixture(lockPath: string, pid: number): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    t: 'happier_daemon_lock_v1',
    pid,
    ownerToken: '00000000-0000-4000-8000-000000000001',
    processStartedAtMs: 1_000,
    createdAtMs: 1,
  }), 'utf-8');
}

describe('stopDaemon: graceful wait before force kill', () => {
  let envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
    'HAPPIER_SERVER_URL',
    'HAPPIER_DAEMON_HTTP_TIMEOUT',
    'HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS',
  ]);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    findHappyProcessByPidMock.mockReset();
    findHappyProcessByPidMock.mockImplementation(async (pid: number) => ({
      pid,
      command: 'happier daemon start-sync',
      type: 'daemon' as const,
      daemonOwnershipEnvironmentVariables: {
        HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR ?? '',
        HAPPIER_ACTIVE_SERVER_ID: process.env.HAPPIER_ACTIVE_SERVER_ID ?? 'cloud',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? 'cloud',
        HAPPIER_SERVER_URL: process.env.HAPPIER_SERVER_URL ?? 'https://api.happier.dev',
      },
    }));
    readProcessIdentityByPidMock.mockReset();
    readProcessIdentityByPidMock.mockImplementation(async (pid: number) => ({
      pid,
      command: `${projectPath()}/src/index.ts daemon start-sync`,
      processStartTimeMs: 1_000,
    }));
    envScope.restore();
    envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_ACTIVE_SERVER_ID',
      'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
      'HAPPIER_SERVER_URL',
      'HAPPIER_DAEMON_HTTP_TIMEOUT',
      'HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS',
    ]);
  });

  it('uses HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS to avoid force killing during slow shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T00:00:00.000Z'));

    const homeDir = createTempDirSync('happier-cli-daemon-stop-grace-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '1000',
      HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: '5000',
    });

    const daemonPid = 12345;
    const daemonPort = 43210;

    let alive = true;
    const realKill = process.kill.bind(process);

    try {
      vi.resetModules();

      let stopDaemonFetchResolve: (() => void) | null = null;
      const stopDaemonFetchCalled = new Promise<void>((resolve) => {
        stopDaemonFetchResolve = resolve;
      });

      let fetchCallCount = 0;
      const fetchMock = vi.fn(async (input: any, _init?: any) => {
        fetchCallCount += 1;
        if (fetchCallCount === 2) stopDaemonFetchResolve?.();

        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname !== '127.0.0.1') {
          throw new Error(`Unexpected fetch hostname: ${url.hostname}`);
        }
        if (Number(url.port) !== daemonPort) {
          throw new Error(`Unexpected fetch port: ${url.port}`);
        }
        if (url.pathname !== '/stop') {
          throw new Error(`Unexpected fetch path: ${url.pathname}`);
        }

        return new Response(JSON.stringify({ status: 'stopping' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const [{ configuration }, controlClient] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const { stopDaemon, stopDaemonHttp } = controlClient;
      expect(process.env.HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS).toBe('5000');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: any) => {
        if (pid !== daemonPid) {
          return realKill(pid as any, signal as any);
        }

        if (signal === 0) {
          if (!alive) {
            throw new Error('ESRCH: process does not exist');
          }
          return undefined as any;
        }

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          alive = false;
          return undefined as any;
        }

        return undefined as any;
      }) as any);

      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: daemonPid,
            httpPort: daemonPort,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'token-123',
          },
          null,
          2,
        ),
        'utf-8',
      );

      const { existsSync } = await import('node:fs');
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      const { readDaemonState } = await import('@/persistence');
      const persisted = await readDaemonState();
      expect(persisted?.pid).toBe(daemonPid);

      expect(typeof AbortSignal.timeout).toBe('function');
      expect(AbortSignal.timeout(1)).toBeInstanceOf(AbortSignal);

      // Sanity: confirm the HTTP stop path actually hits fetch (otherwise the test could pass vacuously).
      await stopDaemonHttp();
      expect(fetchMock).toHaveBeenCalled();

      setTimeout(() => {
        alive = false;
        writeFileSync(
          configuration.daemonStateFile,
          JSON.stringify({
            pid: 67890,
            httpPort: 54321,
            startedAt: Date.now() + 1,
            startedWithCliVersion: '0.0.0-successor',
            controlToken: 'token-successor',
          }, null, 2),
          'utf-8',
        );
      }, 3000);

      const stopPromise = stopDaemon();
      await stopDaemonFetchCalled;
      await vi.advanceTimersByTimeAsync(3100);
      expect(alive).toBe(false);
      await stopPromise;

      expect(fetchMock).toHaveBeenCalled();
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(
        (await import('node:fs')).readFileSync(configuration.daemonStateFile, 'utf8'),
      )).toMatchObject({
        pid: 67890,
        controlToken: 'token-successor',
      });

      const forceSignals = killSpy.mock.calls
        .map(([, signal]) => signal)
        .filter((signal) => signal === 'SIGTERM' || signal === 'SIGKILL');
      expect(forceSignals).toEqual([]);
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('reports a force-confirmed stop after the authenticated stop request fails', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-force-confirmed-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 34567;
    let alive = true;
    const realKill = process.kill.bind(process);

    try {
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) {
          if (!alive) {
            throw Object.assign(new Error('ESRCH: process does not exist'), { code: 'ESRCH' });
          }
          return undefined as any;
        }
        if (signal === 'SIGTERM') {
          alive = false;
          return undefined as any;
        }
        throw new Error(`unexpected signal ${String(signal)}`);
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(
        configuration.daemonStateFile,
        JSON.stringify({
          pid: daemonPid,
          httpPort: 43210,
          startedAt: Date.now(),
          startedWithCliVersion: '0.0.0-test',
          controlToken: 'token-123',
        }),
        'utf-8',
      );
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).resolves.toEqual({ status: 'stopped', method: 'force' });
      expect(killSpy).toHaveBeenCalledWith(daemonPid, 'SIGTERM');
      expect(alive).toBe(false);
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('throws a typed incomplete result when neither authenticated nor force stop can be confirmed', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-incomplete-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 45678;
    const realKill = process.kill.bind(process);

    try {
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) return undefined as any;
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return undefined as any;
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(
        configuration.daemonStateFile,
        JSON.stringify({
          pid: daemonPid,
          httpPort: 43210,
          startedAt: Date.now(),
          startedWithCliVersion: '0.0.0-test',
          controlToken: 'token-123',
        }),
        'utf-8',
      );
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'force_kill_unconfirmed',
        pid: daemonPid,
      });
      expect(killSpy).toHaveBeenCalledWith(daemonPid, 'SIGTERM');
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('refuses to signal another Happier daemon whose recorded scope does not match the active state owner', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-other-happier-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 56789;
    const realKill = process.kill.bind(process);

    try {
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      findHappyProcessByPidMock.mockResolvedValueOnce({
        pid: daemonPid,
        command: 'happier daemon start-sync',
        type: 'daemon',
        daemonOwnershipEnvironmentVariables: {
          HAPPIER_HOME_DIR: `${homeDir}-other`,
          HAPPIER_ACTIVE_SERVER_ID: 'cloud',
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'other-cloud',
          HAPPIER_SERVER_URL: 'https://api.happier.dev',
        },
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) return undefined as any;
        throw new Error(`unexpected force signal ${String(signal)}`);
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: daemonPid,
        httpPort: 43210,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'token-123',
      }), 'utf-8');
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'process_identity_unverified',
        pid: daemonPid,
      });
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGTERM');
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGKILL');
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('refuses to signal a daemon whose recorded server endpoint differs from the active lifecycle owner', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-other-server-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 67890;
    const realKill = process.kill.bind(process);

    try {
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      findHappyProcessByPidMock.mockResolvedValueOnce({
        pid: daemonPid,
        command: 'happier daemon start-sync',
        type: 'daemon',
        daemonOwnershipEnvironmentVariables: {
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_ACTIVE_SERVER_ID: 'cloud',
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
          HAPPIER_SERVER_URL: 'https://another.happier.dev',
        },
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) return undefined as any;
        throw new Error(`unexpected force signal ${String(signal)}`);
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: daemonPid,
        httpPort: 43210,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'token-123',
      }), 'utf-8');
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'process_identity_unverified',
        pid: daemonPid,
      });
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGTERM');
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGKILL');
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('refuses to signal a daemon missing the recorded server endpoint fact', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-missing-server-fact-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 67892;
    const realKill = process.kill.bind(process);

    try {
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      findHappyProcessByPidMock.mockResolvedValueOnce({
        pid: daemonPid,
        command: 'happier daemon start-sync',
        type: 'daemon',
        daemonOwnershipEnvironmentVariables: {
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_ACTIVE_SERVER_ID: 'cloud',
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
        },
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) return undefined as any;
        throw new Error(`unexpected force signal ${String(signal)}`);
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: daemonPid,
        httpPort: 43210,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'token-123',
      }), 'utf-8');
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'process_identity_unverified',
        pid: daemonPid,
      });
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGTERM');
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGKILL');
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('refuses to signal a reused PID when its exact process-birth recheck changes', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-reused-pid-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 67891;
    const realKill = process.kill.bind(process);

    try {
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      readProcessIdentityByPidMock.mockResolvedValueOnce({
        pid: daemonPid,
        command: `${projectPath()}/src/index.ts daemon start-sync`,
        processStartTimeMs: 1_000,
      }).mockResolvedValueOnce({
        pid: daemonPid,
        command: `${projectPath()}/src/index.ts daemon start-sync`,
        processStartTimeMs: 1_500,
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) return undefined as any;
        throw new Error(`unexpected force signal ${String(signal)}`);
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: daemonPid,
        httpPort: 43210,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'token-123',
      }), 'utf-8');
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'process_identity_unverified',
        pid: daemonPid,
      });
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGTERM');
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGKILL');
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('uses state, structured lock, exact birth, and the current runtime command to recover a Windows daemon without environment inventory', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-windows-current-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 67893;
    let alive = true;
    const realKill = process.kill.bind(process);

    try {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      findHappyProcessByPidMock.mockResolvedValueOnce({
        pid: daemonPid,
        command: [
          `${projectPath()}\\bin\\_importRuntimeEntrypoint.mjs`,
          `${projectPath()}\\bin\\happier.mjs`,
          projectPath(),
          'index.mjs',
          'daemon',
          'start-sync',
        ].join(' '),
        type: 'daemon',
      });
      readProcessIdentityByPidMock.mockResolvedValueOnce({
        pid: daemonPid,
        command: [
          `${projectPath()}\\bin\\_importRuntimeEntrypoint.mjs`,
          `${projectPath()}\\bin\\happier.mjs`,
          projectPath(),
          'index.mjs',
          'daemon',
          'start-sync',
        ].join(' '),
        processStartTimeMs: 1_000,
      }).mockResolvedValueOnce({
        pid: daemonPid,
        command: [
          `${projectPath()}\\bin\\_importRuntimeEntrypoint.mjs`,
          `${projectPath()}\\bin\\happier.mjs`,
          projectPath(),
          'index.mjs',
          'daemon',
          'start-sync',
        ].join(' '),
        processStartTimeMs: 1_000,
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) {
          if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          return undefined as any;
        }
        if (signal === 'SIGTERM') {
          alive = false;
          return undefined as any;
        }
        throw new Error(`unexpected signal ${String(signal)}`);
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: daemonPid,
        httpPort: 43210,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'token-123',
      }), 'utf-8');
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).resolves.toEqual({ status: 'stopped', method: 'force' });
      expect(killSpy).toHaveBeenCalledWith(daemonPid, 'SIGTERM');
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('does not let a later Windows identity recheck substitute an unrelated command and shifted birth for the current daemon', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-windows-command-substitution-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 67896;
    const realKill = process.kill.bind(process);

    try {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      findHappyProcessByPidMock.mockResolvedValueOnce({
        pid: daemonPid,
        command: [
          `${projectPath()}\\bin\\_importRuntimeEntrypoint.mjs`,
          `${projectPath()}\\bin\\happier.mjs`,
          projectPath(),
          'index.mjs',
          'daemon',
          'start-sync',
        ].join(' '),
        type: 'daemon',
      });
      readProcessIdentityByPidMock.mockResolvedValueOnce({
        pid: daemonPid,
        command: [
          `${projectPath()}\\bin\\_importRuntimeEntrypoint.mjs`,
          `${projectPath()}\\bin\\happier.mjs`,
          projectPath(),
          'index.mjs',
          'daemon',
          'start-sync',
        ].join(' '),
        processStartTimeMs: 1_000,
      }).mockResolvedValueOnce({
        pid: daemonPid,
        command: `${projectPath()}\\bin\\unrelated-process.mjs --serve`,
        processStartTimeMs: 1_500,
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) return undefined as any;
        throw new Error(`unexpected force signal ${String(signal)}`);
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: daemonPid,
        httpPort: 43210,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'token-123',
      }), 'utf-8');
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'process_identity_unverified',
        pid: daemonPid,
      });
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGTERM');
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGKILL');
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('does not let the Windows inventory fallback override a present scope record missing the server URL', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-windows-missing-server-fact-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 67895;
    const realKill = process.kill.bind(process);

    try {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      findHappyProcessByPidMock.mockResolvedValueOnce({
        pid: daemonPid,
        command: `${projectPath()}\\src\\index.ts daemon start-sync`,
        type: 'daemon',
        daemonOwnershipEnvironmentVariables: {
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_ACTIVE_SERVER_ID: 'cloud',
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
        },
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) return undefined as any;
        throw new Error(`unexpected force signal ${String(signal)}`);
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: daemonPid,
        httpPort: 43210,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'token-123',
      }), 'utf-8');
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'process_identity_unverified',
        pid: daemonPid,
      });
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGTERM');
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGKILL');
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('does not treat a different Windows inventory PID as the exact current daemon', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-windows-wrong-pid-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_DAEMON_HTTP_TIMEOUT: '100',
    });
    const daemonPid = 67894;
    const realKill = process.kill.bind(process);

    try {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.resetModules();
      vi.stubGlobal('fetch', async () => {
        throw new Error('daemon control endpoint unavailable');
      });
      findHappyProcessByPidMock.mockResolvedValueOnce({
        pid: daemonPid + 1,
        command: `${projectPath()}\\src\\index.ts daemon start-sync`,
        type: 'daemon',
      });
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) return realKill(pid as any, signal as any);
        if (signal === 0) return undefined as any;
        throw new Error(`unexpected force signal ${String(signal)}`);
      }) as any);
      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: daemonPid,
        httpPort: 43210,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'token-123',
      }), 'utf-8');
      writeDaemonLockFixture(configuration.daemonLockFile, daemonPid);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'process_identity_unverified',
        pid: daemonPid,
      });
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGTERM');
      expect(killSpy.mock.calls.map(([, signal]) => signal)).not.toContain('SIGKILL');
    } finally {
      removeTempDirSync(homeDir);
    }
  });

  it('does not stop or clean an admitted live lock holder before state publication', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-lock-fallback-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
    });

    const daemonPid = 23456;
    let alive = true;
    const realKill = process.kill.bind(process);

    try {
      vi.resetModules();

      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid !== daemonPid) {
          return realKill(pid as any, signal as any);
        }

        if (signal === 0) {
          if (!alive) {
            throw Object.assign(new Error('ESRCH: process does not exist'), {
              code: 'ESRCH',
            });
          }
          return undefined as any;
        }

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          alive = false;
          return undefined as any;
        }

        return undefined as any;
      }) as any);

      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, String(daemonPid), 'utf-8');

      expect(existsSync(configuration.daemonStateFile)).toBe(false);
      expect(existsSync(configuration.daemonLockFile)).toBe(true);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'startup_in_progress',
        pid: daemonPid,
      });

      expect(killSpy).toHaveBeenCalledWith(daemonPid, 0);
      expect(killSpy).not.toHaveBeenCalledWith(daemonPid, 'SIGTERM');
      expect(alive).toBe(true);
      expect(existsSync(configuration.daemonStateFile)).toBe(false);
      expect(existsSync(configuration.daemonLockFile)).toBe(true);
    } finally {
      removeTempDirSync(homeDir);
    }
  });
});
