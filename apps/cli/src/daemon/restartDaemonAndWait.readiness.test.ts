import http from 'node:http';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import { readDaemonState, writeDaemonState } from '@/persistence';
import { spawnInlineNodeTestProcess } from '@/testkit/process/spawn';
import { spawnStoppableHttpDaemon, withConfiguredDaemonTestHome, writeDaemonStateFixture } from './testkit/fakeDaemonLifecycle.testkit';
import { reserveEphemeralPort, waitForHttpReady } from '@/testkit/http/portUtils';

const { spawnDaemon } = vi.hoisted(() => ({ spawnDaemon: vi.fn() }));
// Process launch is the OS boundary; the restart, wait, persistence and HTTP control owners stay real.
vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({ spawnDetachedDaemonStartSync: spawnDaemon }));

let restartDaemonAndWait: typeof import('./restartDaemonAndWait')['restartDaemonAndWait'];
beforeAll(async () => { ({ restartDaemonAndWait } = await import('./restartDaemonAndWait')); }, 300_000);
afterEach(() => { spawnDaemon.mockReset(); });

describe('daemon restart readiness', () => {
  it.each(['finish', 'cancel'] as const)('waits for acknowledged shutdown lock release until completion or caller cancellation: %s', async (completion) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-restart-draining-', env: {
      HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: undefined,
    } }, async ({ homeDir }) => {
      const predecessor = spawnInlineNodeTestProcess(`
        const http = require('node:http');
        const fs = require('node:fs');
        const lockFile = ${JSON.stringify(configuration.daemonLockFile)};
        fs.mkdirSync(require('node:path').dirname(lockFile), { recursive: true });
        fs.writeFileSync(lockFile, String(process.pid));
        const server = http.createServer((req, res) => {
          req.resume();
          if (req.headers['x-happier-daemon-token'] !== 'predecessor-token') { res.writeHead(401).end(); return; }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
          if (req.url === '/stop') server.close(() => process.send('closed'));
        });
        process.on('message', message => {
          if (message === 'finish') { fs.unlinkSync(lockFile); process.exit(0); }
        });
        server.listen(0, '127.0.0.1', () => process.send(server.address().port));
      `, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const [port] = await once(predecessor, 'message');
      if (typeof port !== 'number' || !predecessor.pid) throw new Error('Missing predecessor endpoint');
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, {
        pid: predecessor.pid, httpPort: port, controlToken: 'predecessor-token',
      });
      const failedSuccessor = spawnInlineNodeTestProcess('process.exit(1)');
      await once(failedSuccessor, 'exit');
      spawnDaemon.mockImplementationOnce(async () => {
        expect(existsSync(configuration.daemonLockFile)).toBe(false);
        return failedSuccessor;
      });
      const realNow = Date.now.bind(Date);
      let elapsed = 0;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsed);
      const controller = new AbortController();
      try {
        const closed = once(predecessor, 'message');
        const restarted = restartDaemonAndWait({ signal: controller.signal });
        void restarted.catch(() => undefined);
        await closed;
        // Advance the OS clock past the previous 12 s cutoff while cleanup is held by IPC.
        elapsed = 20_000;
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(spawnDaemon.mock.calls.length).toBe(0);
        if (completion === 'cancel') {
          controller.abort();
          await expect(restarted).resolves.toMatchObject({ ok: false, failedPhase: 'stop' });
          expect(spawnDaemon.mock.calls.length).toBe(0);
          expect(() => process.kill(predecessor.pid!, 0)).not.toThrow();
        } else {
          predecessor.send('finish');
          await expect(restarted).resolves.toMatchObject({ ok: false, failedPhase: 'start' });
          expect(spawnDaemon).toHaveBeenCalledOnce();
        }
      } finally {
        clock.mockRestore();
        await stopChild(predecessor);
      }
    });
  });

  it.each([false, true])('does not launch over an incomplete predecessor shutdown (control closed: %s)', async (controlClosed) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-restart-predecessor-', env: {
      HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: '250',
    } }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const predecessor = spawnStoppableHttpDaemon(port, controlClosed ? 200 : 500, {
        controlToken: 'predecessor-token', lockFile: configuration.daemonLockFile,
        stateFile: configuration.daemonStateFile, retainLockAfterControlClose: true,
      });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, {
        pid: predecessor.pid, httpPort: port, controlToken: 'predecessor-token',
      });
      const failedSuccessor = spawnInlineNodeTestProcess('process.exit(1)');
      await once(failedSuccessor, 'exit');
      spawnDaemon.mockResolvedValueOnce(failedSuccessor);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        await expect(restartDaemonAndWait()).resolves.toMatchObject({ ok: false, failedPhase: 'stop' });
        expect(spawnDaemon.mock.calls.length).toBe(0);
        expect(() => process.kill(predecessor.pid, 0)).not.toThrow();
      } finally {
        await predecessor.kill();
      }
    });
  });

  it('waits past the startup checkpoint for the live successor to answer authenticated control', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-restart-readiness-', env: {
      HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1',
      HAPPIER_DAEMON_START_WAIT_POLL_MS: '1',
      HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS: '1',
    } }, async ({ homeDir }) => {
      let probes = 0;
      const server = http.createServer((req, res) => {
        if (req.url !== '/ping' || req.headers['x-happier-daemon-token'] !== 'successor-token') {
          res.writeHead(401).end();
          return;
        }
        probes += 1;
        if (probes === 1) {
          // A real unavailable response crosses the configured checkpoint before readiness.
          setTimeout(() => res.writeHead(503).end(), 20);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
      const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
      if (!child.pid) throw new Error('Missing successor PID');
      const pid = child.pid;
      spawnDaemon.mockImplementationOnce(async () => {
        await writeDaemonStateFixture(homeDir, configuration.activeServerId, {
          pid, httpPort: address.port, controlToken: 'successor-token',
        });
        return Object.assign(child, { detachedDaemonPid: pid });
      });
      try {
        await expect(restartDaemonAndWait()).resolves.toEqual({ ok: true });
        expect((await readDaemonState())?.pid).toBe(pid);
        expect(probes).toBeGreaterThan(1);
      } finally {
        await stopChild(child);
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  it('reports start failure when the owned successor exits before publishing readiness', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-restart-exited-', env: {
      HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1',
      HAPPIER_DAEMON_START_WAIT_POLL_MS: '1',
    } }, async () => {
      const child = spawnInlineNodeTestProcess('process.exit(1)');
      await once(child, 'exit');
      spawnDaemon.mockResolvedValueOnce(Object.assign(child, { detachedDaemonPid: child.pid }));
      await expect(restartDaemonAndWait()).resolves.toEqual({
        ok: false, failedPhase: 'start', daemonStatusAfterFailure: 'not-running',
      });
    });
  });

  it('confirms self-replacement after its checkpoint while the successor process is still starting', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-self-restart-readiness-' }, async () => {
      const { requestDaemonSelfRestart } = await import('./lifecycle/requestDaemonSelfRestart');
      let probes = 0;
      const server = http.createServer((_req, res) => {
        probes += 1;
        if (probes === 1) setTimeout(() => res.writeHead(503).end(), 20);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
      const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
      if (!child.pid) throw new Error('Missing successor PID');
      writeDaemonState({ pid: child.pid, httpPort: address.port, startedAt: Date.now(),
        startedWithCliVersion: 'test', controlToken: 'successor-token', runtimeId: 'test-runtime' });
      const exitProcess = vi.fn();
      try {
        await expect(requestDaemonSelfRestart({
          ownPid: process.pid, expectedCliVersion: 'test', runtimeId: 'test-runtime', timeoutMs: 1, pollMs: 1,
          spawnDetachedDaemonStartSyncImpl: async () => Object.assign(child, { detachedDaemonPid: child.pid }),
          exitProcess,
        })).resolves.toEqual({ status: 'exited' });
        expect(exitProcess).toHaveBeenCalledWith(0);
      } finally {
        await stopChild(child);
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  it('keeps the incumbent alive when the self-replacement process exits without readiness', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-self-restart-exited-' }, async () => {
      const { requestDaemonSelfRestart } = await import('./lifecycle/requestDaemonSelfRestart');
      const child = spawnInlineNodeTestProcess('process.exit(1)');
      await once(child, 'exit');
      const exitProcess = vi.fn();
      await expect(requestDaemonSelfRestart({
        ownPid: process.pid, expectedCliVersion: 'test', timeoutMs: 1, pollMs: 1,
        spawnDetachedDaemonStartSyncImpl: async () => Object.assign(child, { detachedDaemonPid: child.pid }),
        exitProcess,
      })).resolves.toEqual({ status: 'replacement_not_confirmed' });
      expect(exitProcess).not.toHaveBeenCalled();
    });
  });
});

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}
