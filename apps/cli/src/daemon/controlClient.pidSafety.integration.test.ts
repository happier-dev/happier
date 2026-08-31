import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeJsonAtomicSync } from '@/utils/fs/writeJsonAtomicSync';

function writeDaemonStateFixture(path: string, serializedState: string, encoding: 'utf-8'): void {
  void encoding;
  writeJsonAtomicSync(path, JSON.parse(serializedState));
}

function mockCurrentProcessAsDaemonLifecycleOwner(): void {
  vi.doMock('@/daemon/doctor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/doctor')>();
    return {
      ...actual,
      classifyDaemonLifecycleProcessByPid: async (pid: number) => pid === process.pid
        ? {
            kind: 'daemon' as const,
            process: {
              pid,
              command: `${process.execPath} ${process.cwd()}/src/index.ts daemon start-sync`,
              type: 'dev-daemon',
            },
          }
        : await actual.classifyDaemonLifecycleProcessByPid(pid),
    };
  });
}

describe.sequential('daemon control client PID safety', () => {
  let envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_HTTP_TIMEOUT',
    'HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT',
    'HAPPIER_DAEMON_PING_TIMEOUT_MS',
  ]);
  const spawnedChildren: Array<ReturnType<typeof spawn>> = [];

  function killTrackedChildren(): void {
    while (spawnedChildren.length > 0) {
      const child = spawnedChildren.pop();
      if (!child) continue;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  afterEach(() => {
    killTrackedChildren();
    envScope.restore();
    envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_HTTP_TIMEOUT',
      'HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT',
      'HAPPIER_DAEMON_PING_TIMEOUT_MS',
    ]);
    vi.doUnmock('@/daemon/doctor');
  });

  it('stopDaemon refuses to kill an unrelated PID when HTTP stop fails', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-safety-');
    try {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_HTTP_TIMEOUT: '150',
      });

      // Spawn an unrelated long-lived process.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      if (!child.pid) throw new Error('missing pid for child');
      spawnedChildren.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });

      vi.resetModules();
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      // Point daemon state at an unrelated PID and a dead port so HTTP stop fails.
      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: child.pid,
            httpPort: 1,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'token-123',
          },
          null,
          2,
        ),
        'utf-8',
      );

      await stopDaemon();

      // Process should still be alive (PID reuse safety).
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      // An unrelated PID is not proof that this caller owns the persisted publication.
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      removeTempDirSync(homeDir);
    }
  }, 30_000);

  it('treats daemon state whose live PID was recycled by an unrelated process as replaceable', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-recycled-pid-');
    try {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_PING_TIMEOUT_MS: '150',
      });

      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      if (!child.pid) throw new Error('missing pid for child');
      spawnedChildren.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });

      vi.resetModules();
      const [
        { configuration },
        { inspectDaemonRunningStateAndCleanupStaleState },
        { acquireDaemonLock, releaseDaemonLock },
      ] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
        import('@/persistence'),
      ]);

      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify({
          pid: child.pid,
          httpPort: 1,
          startedAt: Date.now() - 60_000,
          lastHeartbeatAt: Date.now() - 60_000,
          startedWithCliVersion: '0.2.10',
          controlToken: 'stale-token',
        }),
        'utf-8',
      );
      writeFileSync(configuration.daemonLockFile, String(child.pid), 'utf-8');

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({ status: 'not-running' });
      const lockHandle = await acquireDaemonLock(2, 1);
      expect(lockHandle).not.toBeNull();
      if (lockHandle) await releaseDaemonLock(lockHandle);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      removeTempDirSync(homeDir);
    }
  }, 90_000);

  it('checkIfDaemonRunningAndCleanupStaleState probes /ping when controlToken is present', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-ping-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '500',
    });

    vi.resetModules();
    const [
      { configuration },
      { createDaemonControlApp },
      { checkIfDaemonRunningAndCleanupStaleState },
    ] = await Promise.all([
      import('@/configuration'),
      import('./controlServer'),
      import('./controlClient'),
    ]);

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    const daemonPort = 43210;
    const realFetch = globalThis.fetch;

    try {
      await app.ready();
      vi.stubGlobal('fetch', async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname !== '127.0.0.1' || Number(url.port) !== daemonPort) {
          return await realFetch(input, init);
        }

        const method = (init?.method ?? 'GET').toUpperCase();
        const payload = typeof init?.body === 'string' ? init.body : init?.body != null ? String(init.body) : undefined;
        const headers = new Headers(init?.headers ?? {});

        const injectRes = await app.inject({
          method,
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(headers.entries()),
          payload,
        });

        return new Response(injectRes.payload, {
          status: injectRes.statusCode,
          headers: injectRes.headers as any,
        });
      });

      // Correct token => running.
      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: process.pid,
            httpPort: daemonPort,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'test-token',
          },
          null,
          2,
        ),
        'utf-8',
      );
      expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(true);

      // Wrong token => treat as not running (stale/untrusted control plane).
      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: process.pid,
            httpPort: daemonPort,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'wrong-token',
          },
          null,
          2,
        ),
        'utf-8',
      );
      expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
      removeTempDirSync(homeDir);
    }
  }, 90_000);

  it('checkIfDaemonRunningAndCleanupStaleState uses a configurable ping timeout budget', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-ping-timeout-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '500',
    });

    const daemonPort = 43210;
    const realFetch = globalThis.fetch;

    try {
      // Override ping timeout and verify it is used (instead of a hardcoded value).
      envScope.patch({ HAPPIER_DAEMON_PING_TIMEOUT_MS: '5000' });

      vi.resetModules();
      const [
        { configuration },
        { createDaemonControlApp },
        { checkIfDaemonRunningAndCleanupStaleState },
      ] = await Promise.all([
        import('@/configuration'),
        import('./controlServer'),
        import('./controlClient'),
      ]);

      const app = createDaemonControlApp({
        getChildren: () => [],
        machineId: 'machine_local',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
        requestShutdown: () => {},
        onHappySessionWebhook: () => {},
        controlToken: 'test-token',
      });

      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

      await app.ready();
      vi.stubGlobal('fetch', async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname !== '127.0.0.1' || Number(url.port) !== daemonPort) {
          return await realFetch(input, init);
        }

        const method = (init?.method ?? 'GET').toUpperCase();
        const payload =
          typeof init?.body === 'string' ? init.body : init?.body != null ? String(init.body) : undefined;
        const headers = new Headers(init?.headers ?? {});

        const injectRes = await app.inject({
          method,
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(headers.entries()),
          payload,
        });

        return new Response(injectRes.payload, {
          status: injectRes.statusCode,
          headers: injectRes.headers as any,
        });
      });

      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: process.pid,
            httpPort: daemonPort,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'test-token',
          },
          null,
          2,
        ),
        'utf-8',
      );

      expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(true);
      expect(timeoutSpy).toHaveBeenCalledWith(5000);

      timeoutSpy.mockRestore();
      await app.close();
    } finally {
      vi.unstubAllGlobals();
      removeTempDirSync(homeDir);
    }
  }, 30_000);

  it('checkIfDaemonRunningAndCleanupStaleState does not delete recent state when /ping is temporarily unreachable', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-ping-grace-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '250',
    });

    vi.resetModules();
    mockCurrentProcessAsDaemonLifecycleOwner();
    const [{ configuration }, { checkIfDaemonRunningAndCleanupStaleState }] = await Promise.all([
      import('@/configuration'),
      import('./controlClient'),
    ]);

    // Point at a port that we force fetch to fail for.
    const daemonPort = 43210;
    const realFetch = globalThis.fetch;
    try {
      vi.stubGlobal('fetch', async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname === '127.0.0.1' && Number(url.port) === daemonPort) {
          throw new TypeError('fetch failed');
        }
        return await realFetch(input, init);
      });

      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: process.pid,
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

      expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      removeTempDirSync(homeDir);
    }
  }, 30_000);

  it('inspectDaemonRunningStateAndCleanupStaleState preserves live daemon state when /ping times out after the startup grace', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-ping-stale-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '250',
    });

    vi.resetModules();
    mockCurrentProcessAsDaemonLifecycleOwner();
    const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
      import('@/configuration'),
      import('./controlClient'),
    ]);

    const daemonPort = 43211;
    const realFetch = globalThis.fetch;
    try {
      vi.stubGlobal('fetch', async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname === '127.0.0.1' && Number(url.port) === daemonPort) {
          throw new TypeError('fetch failed');
        }
        return await realFetch(input, init);
      });

      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: process.pid,
            httpPort: daemonPort,
            startedAt: Date.now() - 60_000,
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'token-123',
          },
          null,
          2,
        ),
        'utf-8',
      );

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        state: expect.objectContaining({
          pid: process.pid,
          httpPort: daemonPort,
          controlToken: 'token-123',
        }),
      });
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      removeTempDirSync(homeDir);
    }
  }, 90_000);

  it('preserves live daemon state as starting when authenticated /ping returns 503', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-ping-unavailable-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '250',
    });

    vi.resetModules();
    mockCurrentProcessAsDaemonLifecycleOwner();
    const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
      import('@/configuration'),
      import('./controlClient'),
    ]);

    const daemonPort = 43213;
    const realFetch = globalThis.fetch;
    try {
      vi.stubGlobal('fetch', async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname === '127.0.0.1' && Number(url.port) === daemonPort) {
          return new Response(JSON.stringify({ status: 'temporarily_unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return await realFetch(input, init);
      });

      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: process.pid,
            httpPort: daemonPort,
            startedAt: Date.now() - 60_000,
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'token-123',
          },
          null,
          2,
        ),
        'utf-8',
      );

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        state: expect.objectContaining({
          pid: process.pid,
          httpPort: daemonPort,
          controlToken: 'token-123',
        }),
      });
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      removeTempDirSync(homeDir);
    }
  }, 90_000);

  it('inspectDaemonRunningStateAndCleanupStaleState treats a dead stale daemon as replaceable without deleting daemon-owned state', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-dead-stale-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '250',
    });

    const deadPid = 987_654_321;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);

    try {
      vi.resetModules();
      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: deadPid,
            httpPort: 43212,
            startedAt: Date.now() - 10 * 60_000,
            lastHeartbeatAt: Date.now() - 10 * 60_000,
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'token-123',
          },
          null,
          2,
        ),
        'utf-8',
      );

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({ status: 'not-running' });
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      killSpy.mockRestore();
      removeTempDirSync(homeDir);
    }
  }, 90_000);

  it('inspectDaemonRunningStateAndCleanupStaleState treats a definitively dead fresh daemon as immediately replaceable', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-dead-fresh-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '250',
    });

    const deadPid = 987_654_320;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);

    try {
      vi.resetModules();
      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      writeDaemonStateFixture(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: deadPid,
            httpPort: 43214,
            startedAt: Date.now(),
            lastHeartbeatAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'token-123',
          },
          null,
          2,
        ),
        'utf-8',
      );

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({ status: 'not-running' });
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      killSpy.mockRestore();
      removeTempDirSync(homeDir);
    }
  }, 90_000);

  it('inspectDaemonRunningStateAndCleanupStaleState keeps fresh state fail-closed when PID liveness is permission denied', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-permission-inconclusive-');
    envScope.patch({ HAPPIER_HOME_DIR: homeDir });
    const protectedPid = 987_654_319;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === protectedPid && signal === 0) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return true;
    }) as typeof process.kill);

    try {
      vi.resetModules();
      const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      writeDaemonStateFixture(configuration.daemonStateFile, JSON.stringify({
        pid: protectedPid,
        httpPort: 43215,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken: 'token-123',
      }), 'utf-8');

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        state: expect.objectContaining({ pid: protectedPid }),
      });
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      killSpy.mockRestore();
      removeTempDirSync(homeDir);
    }
  }, 90_000);

  it('spawnDaemonSession defaults to the daemon session webhook timeout budget', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-spawn-timeout-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: undefined,
      HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT: undefined,
    });

    vi.resetModules();
    const [
      { configuration },
      { spawnDaemonSession },
    ] = await Promise.all([
      import('@/configuration'),
      import('./controlClient'),
    ]);

    writeDaemonStateFixture(
      configuration.daemonStateFile,
      JSON.stringify(
        {
          pid: process.pid,
          httpPort: 43210,
          startedAt: Date.now(),
          startedWithCliVersion: '0.0.0-test',
          controlToken: 'token-123',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true, sessionId: 's-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    try {
      vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
      const result = await spawnDaemonSession('/tmp');
      expect(result).toEqual({ success: true, sessionId: 's-1' });
      expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
      removeTempDirSync(homeDir);
    }
  });
});
