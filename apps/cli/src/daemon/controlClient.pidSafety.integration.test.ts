import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

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

      vi.resetModules();
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      // Point daemon state at an unrelated PID and a dead port so HTTP stop fails.
      writeFileSync(
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

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'process_identity_unverified',
        pid: child.pid,
      });

      // Process should still be alive (PID reuse safety).
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      // An external client must not delete a publication it cannot prove it owns.
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
      expect(JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8'))).toMatchObject({
        pid: child.pid,
        controlToken: 'token-123',
      });
    } finally {
      removeTempDirSync(homeDir);
    }
  }, 30_000);

  it('replaces legacy daemon state and lock records whose live PID belongs to an unrelated process', async () => {
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

      writeFileSync(configuration.daemonStateFile, JSON.stringify({
        pid: child.pid,
        httpPort: 1,
        startedAt: Date.now() - 60_000,
        lastHeartbeatAt: Date.now() - 60_000,
        startedWithCliVersion: '0.3.0',
        controlToken: 'stale-token',
      }), 'utf-8');
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
  }, 120_000);

  it('stopDaemon reports a completed stop when the recorded daemon PID has already exited', async () => {
    // F-DAEMON-6: `happier daemon restart` stopped the daemon and then refused its own force-kill
    // with "daemon identity does not match the active lifecycle owner", leaving the stack daemonless.
    // The refused pid was already gone. A pid that is provably absent is a COMPLETED stop, not a
    // hostile identity: there is nothing left to signal and nothing left to protect.
    const homeDir = createTempDirSync('happier-cli-daemon-stop-exited-');
    try {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_HTTP_TIMEOUT: '150',
      });

      // A real pid that we watch exit, so "gone" is observed rather than assumed.
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      const exitedPid = child.pid;
      if (!exitedPid) throw new Error('missing pid for child');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(() => process.kill(exitedPid, 0)).toThrow();

      vi.resetModules();
      const [{ configuration }, { stopDaemon }] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);

      // Exactly the observed precondition: state and lock both still name the dead daemon
      // (nothing cleans them up, because the refusal happens before cleanup), and the HTTP
      // port is dead so the graceful stop falls through to the force path.
      writeFileSync(
        configuration.daemonStateFile,
        JSON.stringify({
          pid: exitedPid,
          httpPort: 1,
          startedAt: Date.now(),
          startedWithCliVersion: '0.0.0-test',
          controlToken: 'token-123',
        }, null, 2),
        'utf-8',
      );
      writeFileSync(
        configuration.daemonLockFile,
        JSON.stringify({
          t: 'happier_daemon_lock_v1',
          pid: exitedPid,
          ownerToken: '00000000-0000-4000-8000-000000000123',
          processStartedAtMs: Date.now() - 60_000,
          createdAtMs: Date.now() - 60_000,
        }),
        'utf-8',
      );

      await expect(stopDaemon()).resolves.toMatchObject({ status: 'stopped' });
    } finally {
      removeTempDirSync(homeDir);
    }
  }, 30_000);

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
      writeFileSync(
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
      writeFileSync(
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
    } finally {
      vi.unstubAllGlobals();
      await app.close();
      removeTempDirSync(homeDir);
    }
  }, 30_000);

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

      writeFileSync(
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

  it('checkIfDaemonRunningAndCleanupStaleState does not delete live daemon state when /ping is temporarily unreachable', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-ping-live-timeout-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '250',
    });

    vi.resetModules();
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

      writeFileSync(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: process.pid,
            httpPort: daemonPort,
            startedAt: Date.now() - 120_000,
            startedWithCliVersion: '0.0.0-test',
            lastHeartbeatAt: Date.now() - 120_000,
            controlToken: 'token-123',
          },
          null,
          2,
        ),
        'utf-8',
      );

      expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
      expect(JSON.parse(readFileSync(configuration.daemonStateFile, 'utf-8'))).toEqual(expect.objectContaining({
        pid: process.pid,
        httpPort: daemonPort,
      }));
    } finally {
      vi.unstubAllGlobals();
      removeTempDirSync(homeDir);
    }
  }, 30_000);

  it('checkIfDaemonRunningAndCleanupStaleState replaces a definitively dead PID even when state is fresh', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-dead-fresh-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '250',
    });

    vi.resetModules();
    const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
      import('@/configuration'),
      import('./controlClient'),
    ]);

    try {
      writeFileSync(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: 999_999_999,
            httpPort: 43211,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
            lastHeartbeatAt: Date.now(),
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
      removeTempDirSync(homeDir);
    }
  }, 30_000);

  it('checkIfDaemonRunningAndCleanupStaleState treats dead stale state as replaceable without client deletion', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-dead-stale-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '250',
    });

    vi.resetModules();
    const [{ configuration }, { inspectDaemonRunningStateAndCleanupStaleState }] = await Promise.all([
      import('@/configuration'),
      import('./controlClient'),
    ]);

    try {
      writeFileSync(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: 999_999_999,
            httpPort: 43211,
            startedAt: Date.now() - 120_000,
            startedWithCliVersion: '0.0.0-test',
            lastHeartbeatAt: Date.now() - 120_000,
            controlToken: 'token-123',
          },
          null,
          2,
        ),
        'utf-8',
      );

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'not-running',
      });
      expect(existsSync(configuration.daemonStateFile)).toBe(true);
    } finally {
      removeTempDirSync(homeDir);
    }
  }, 30_000);

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
      writeFileSync(configuration.daemonStateFile, JSON.stringify({
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

    writeFileSync(
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
      const result = await spawnDaemonSession({ directory: '/tmp' });
      expect(result).toEqual({ success: true, sessionId: 's-1' });
      expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
      removeTempDirSync(homeDir);
    }
  });
});
