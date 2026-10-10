import http from 'node:http';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import {
  withConfiguredDaemonTestHome,
  writeDaemonStateFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { PLUGIN_DEVELOPMENT_CONTROL_PATH } from '@/plugins/daemon/controlRoutes';
import type { DaemonPluginDevelopmentControlResult } from '@/plugins/daemon/developmentRoots';

import { dispatchCli } from './dispatch';

// Only the daemon's HTTP peer is simulated. Dispatch, command admission,
// persisted daemon discovery and the development command remain real.
async function withDevelopmentDaemon(
  run: (context: { registeredRoots: string[] }) => Promise<void>,
): Promise<void> {
  await withConfiguredDaemonTestHome({ prefix: 'happier-dispatch-development-' }, async ({ homeDir }) => {
    const registeredRoots: string[] = [];
    const token = 'development-control-fixture';
    const server = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.headers['x-happier-daemon-token'] !== token) {
        response.writeHead(401).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (request.url === '/ping') {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === PLUGIN_DEVELOPMENT_CONTROL_PATH) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || !('kind' in body) || body.kind !== 'registerExplicit'
          || !('rootPath' in body) || typeof body.rootPath !== 'string') {
          response.writeHead(400).end(JSON.stringify({ error: 'invalid development request' }));
          return;
        }
        registeredRoots.push(body.rootPath);
        const result = { kind: 'status', status: { roots: [], plugins: [] } } satisfies DaemonPluginDevelopmentControlResult;
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(404).end();
    });
    try {
      await new Promise<void>((ready, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', ready);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing daemon fixture address');
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, {
        pid: process.pid,
        httpPort: address.port,
        startedWithCliVersion: configuration.currentCliVersion,
        controlToken: token,
      });
      await run({ registeredRoots });
    } finally {
      await new Promise<void>((closed, reject) => server.close((error) => error ? reject(error) : closed()));
    }
  });
}

describe('dispatchCli command cancellation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['SIGINT', 'SIGTERM'] as const)('stops the real development command on %s and releases its listeners', async (interrupt) => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    await withDevelopmentDaemon(async ({ registeredRoots }) => {
      let settled = false;
      let resolveOutput!: () => void;
      const printed = new Promise<void>((ready) => { resolveOutput = ready; });
      vi.spyOn(console, 'log').mockImplementation(() => {
        if (registeredRoots.length > 0) resolveOutput();
      });
      const command = dispatchCli({
        args: ['plugins', 'dev', '.'],
        rawArgv: ['happier', 'plugins', 'dev', '.'],
        terminalRuntime: null,
      }).then(() => { settled = true; });
      try {
        await Promise.race([printed, command.then(() => { throw new Error('Development command stopped before waiting'); })]);
        expect(registeredRoots).toEqual([resolve('.')]);
        expect(settled).toBe(false);
        process.emit(interrupt);
        await expect(command).resolves.toBeUndefined();
        expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
        expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
      } finally {
        if (!settled) {
          process.emit(interrupt);
          await command;
        }
      }
    });
  });

  it.each(['auth', 'setup', 'home'] as const)('owns interrupt listeners while the real %s command runs and releases them', async (root) => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    let observedOwnedListeners = false;
    vi.spyOn(console, 'log').mockImplementation(() => {
      observedOwnedListeners ||= process.listenerCount('SIGINT') > before.SIGINT
        && process.listenerCount('SIGTERM') > before.SIGTERM;
    });
    await withConfiguredDaemonTestHome({ prefix: 'happier-dispatch-command-help-' }, async () => {
      await dispatchCli({
        args: [root, '--help'],
        rawArgv: ['happier', root, '--help'],
        terminalRuntime: null,
      });
    });
    expect(observedOwnedListeners).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
  });

  it('uses the parent signal to stop development without installing process listeners', async () => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const caller = new AbortController();
    await withDevelopmentDaemon(async ({ registeredRoots }) => {
      let settled = false;
      let resolveOutput!: () => void;
      const printed = new Promise<void>((ready) => { resolveOutput = ready; });
      vi.spyOn(console, 'log').mockImplementation(() => {
        if (registeredRoots.length > 0) resolveOutput();
      });
      const command = dispatchCli({
        args: ['plugins', 'dev', '.'],
        rawArgv: ['happier', 'plugins', 'dev', '.'],
        terminalRuntime: null,
        signal: caller.signal,
      }).then(() => { settled = true; });
      try {
        await Promise.race([printed, command.then(() => { throw new Error('Development command stopped before waiting'); })]);
        expect(registeredRoots).toEqual([resolve('.')]);
        expect(settled).toBe(false);
        expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
        expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
        caller.abort();
        await expect(command).resolves.toBeUndefined();
      } finally {
        caller.abort();
        await command;
      }
    });
  });

  it('cleans up owned listeners when the real command exits unsuccessfully', async () => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const exit = new Error('fixture process exit');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw exit; });
    await withConfiguredDaemonTestHome({ prefix: 'happier-dispatch-command-failure-' }, async () => {
      await expect(dispatchCli({
        args: ['auth', 'unknown-fixture-command'],
        rawArgv: ['happier', 'auth', 'unknown-fixture-command'],
        terminalRuntime: null,
      })).rejects.toBe(exit);
    });
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
  });
});
