import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withSocketTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), sessionList: vi.fn() }));

// Only executable discovery and foreground process creation are replaced; socket/version logic is real.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (_file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => ({
      stdout: args[0] === 'session'
        ? JSON.stringify({ sessions: boundary.sessionList(options?.env) })
        : 'herdr 0.9.2',
      stderr: '',
    }),
  }),
  spawn: boundary.spawn,
}));

import { runHerdrAttach } from './herdrAttach';

const envScope = createEnvKeyScope(['HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'XDG_CONFIG_HOME', 'HAPPIER_CLAUDE_UNIFIED_TERMINAL_HOST_ACTION_TIMEOUT_MS']);

beforeEach(() => {
  envScope.patch({ HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: undefined });
  boundary.spawn.mockReset();
  boundary.sessionList.mockReset();
  boundary.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
});

afterEach(() => { envScope.restore(); reloadConfiguration(); });

describe('runHerdrAttach server admission', () => {
  it.each([['work', false], ['default', false], ['work', true]] as const)('opens only the recorded restored pane using its new terminal identity after cold %s server startup (delayed=%s)', async (sessionName, delayed) => {
    const relativeSessionDir = sessionName === 'default' ? 'herdr' : `herdr/sessions/${sessionName}`;
    await withSocketTempDir(async root => await withHerdrApi(async (api) => {
      await api.stop();
      api.panes.add('managed');
      envScope.patch({ XDG_CONFIG_HOME: join(root, 'ambient') });
      if (delayed) { envScope.patch({ HAPPIER_CLAUDE_UNIFIED_TERMINAL_HOST_ACTION_TIMEOUT_MS: '100' }); reloadConfiguration(); }
      let running = false;
      let startup: Promise<void> | null = null;
      boundary.sessionList.mockImplementation((env?: NodeJS.ProcessEnv) => [
        { name: sessionName, socket_path: env?.XDG_CONFIG_HOME === root ? api.socketPath : join(root, 'ambient', relativeSessionDir, 'herdr.sock'),
          session_dir: env?.XDG_CONFIG_HOME === root ? join(root, relativeSessionDir) : join(root, 'ambient', relativeSessionDir), running },
      ]);
      boundary.spawn.mockImplementation((_file: string, args: string[]) => {
        const child = Object.assign(new EventEmitter(), { unref: () => {} });
        if (args.includes('attach')) queueMicrotask(() => child.emit('exit', 0));
        else {
          // External server readiness exceeds the configured action budget but
          // stays within the canonical terminal-host startup operation.
          startup = new Promise<void>(resolve => setTimeout(resolve, delayed ? 200 : 0))
            .then(() => api.start()).then(() => { running = true; });
          void startup.catch(error => child.emit('error', error));
        }
        return child;
      });
      try { await expect(runHerdrAttach({ terminal: {
        mode: 'herdr', herdr: {
          sessionName, socketPath: api.socketPath,
          terminalId: 'previous-terminal', paneId: 'managed',
        },
      } })).resolves.toBe(0);
      const launches = boundary.spawn.mock.calls.map(([, args, options]) => ({ args,
        socketPath: options.env?.HERDR_SOCKET_PATH, sessionName: options.env?.HERDR_SESSION }));
      expect(launches).toContainEqual({ args: ['server'], socketPath: api.socketPath, sessionName });
      expect(launches).toContainEqual({ args: ['terminal', 'attach', 'terminal_1'], socketPath: api.socketPath, sessionName });
      expect(api.requests.some((request) => request.method === 'pane.close' || request.method === 'layout.apply')).toBe(false);
      } finally { await startup; }
    }, { socketPath: join(root, relativeSessionDir, 'herdr.sock') }));
  });

  it.each(['custom_socket', 'mismatched_inventory'])('does not cold-start an unverified namespace or substitute a live ambient server (%s)', async evidence => {
    await withSocketTempDir(async root => await withHerdrApi(async ambient => {
      boundary.sessionList.mockReturnValue([{ name: 'work', socket_path: ambient.socketPath,
        session_dir: join(root, 'foreign/herdr/sessions/work'), running: true }]);
      const socketPath = evidence === 'custom_socket' ? join(root, 'custom.sock') : join(root, 'herdr/sessions/work/herdr.sock');
      await expect(runHerdrAttach({ terminal: { mode: 'herdr', herdr: {
        sessionName: 'work', socketPath, terminalId: 'old-terminal', paneId: 'managed',
      } } })).rejects.toMatchObject({ code: 'recorded_server_root_unavailable' });
      expect(boundary.spawn).not.toHaveBeenCalled();
      expect(ambient.requests).toEqual([]);
    }));
  });

  it('refuses an older running server even with a supported installed binary', async () => {
    await withHerdrApi(async (api) => {
      await expect(runHerdrAttach({ terminal: {
        mode: 'herdr', herdr: { sessionName: 'work', socketPath: api.socketPath, terminalId: 'terminal_1' },
      } })).rejects.toMatchObject({ code: 'unsupported_server_version' });
      expect(boundary.spawn).not.toHaveBeenCalled();
    }, { serverVersion: '0.9.1' });
  });

  it('attaches through the qualified exact socket without creating a pane', async () => {
    await withHerdrApi(async (api) => {
      api.panes.add('managed');
      await expect(runHerdrAttach({ terminal: {
        mode: 'herdr', herdr: { sessionName: 'work', socketPath: api.socketPath, terminalId: 'terminal_1' },
      } })).resolves.toBe(0);
      expect(api.requests.map((request) => request.method)).toEqual(['session.snapshot', 'pane.list']);
      expect(boundary.spawn.mock.calls.map(([, args, options]) => ({ args,
        socketPath: options.env?.HERDR_SOCKET_PATH, sessionName: options.env?.HERDR_SESSION })))
        .toContainEqual({ args: ['terminal', 'attach', 'terminal_1'], socketPath: api.socketPath, sessionName: 'work' });
    });
  });

  it('focuses the existing terminal inside the same qualified server', async () => {
    await withHerdrApi(async (api) => {
      api.panes.add('managed');
      envScope.patch({ HERDR_PANE_ID: 'managed', HERDR_SOCKET_PATH: api.socketPath });
      await expect(runHerdrAttach({ terminal: {
        mode: 'herdr', herdr: { sessionName: 'work', socketPath: api.socketPath, terminalId: 'terminal_1' },
      } })).resolves.toBe(0);
      expect(api.requests.map((request) => request.method)).toEqual(['session.snapshot', 'pane.list', 'pane.focus']);
      expect(boundary.spawn).not.toHaveBeenCalled();
    });
  });
});
