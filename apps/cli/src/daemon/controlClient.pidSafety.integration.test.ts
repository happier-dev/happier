import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

describe.sequential('daemon control client PID safety', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const previousTimeout = process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
  const previousSpawnTimeout = process.env.HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT;
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
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;

    if (previousTimeout === undefined) delete process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
    else process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = previousTimeout;

    if (previousSpawnTimeout === undefined) delete process.env.HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT;
    else process.env.HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT = previousSpawnTimeout;
  });

  it('stopDaemon refuses to kill an unrelated PID when HTTP stop fails', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-stop-safety-'));
    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = '150';

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

      await stopDaemon();

      // Process should still be alive (PID reuse safety).
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      // Stale daemon state should be removed so future control commands can recover.
      expect(existsSync(configuration.daemonStateFile)).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('checkIfDaemonRunningAndCleanupStaleState probes /ping when controlToken is present', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-ping-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = '500';

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
      stopSession: async () => false,
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
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('checkIfDaemonRunningAndCleanupStaleState does not delete recent state when /ping is temporarily unreachable', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-ping-grace-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = '250';

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
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('checkIfDaemonRunningAndCleanupStaleState deletes old state when /ping remains unreachable', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-ping-stale-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = '250';

    vi.resetModules();
    const [{ configuration }, { checkIfDaemonRunningAndCleanupStaleState }] = await Promise.all([
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

      writeFileSync(
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

      expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
      expect(existsSync(configuration.daemonStateFile)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('spawnDaemonSession uses an extended default timeout budget', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-spawn-timeout-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
    delete process.env.HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT;

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
      const result = await spawnDaemonSession('/tmp');
      expect(result).toEqual({ success: true, sessionId: 's-1' });
      expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
