import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executable = vi.hoisted(() => ({ socketPath: '', spawn: vi.fn(), sessionList: vi.fn() }));

// Substitute executable session inventory and foreground process creation only.
// Version probes, admission, exact-socket transport and pane focus stay real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: Object.assign(vi.fn((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args)), {
      [Symbol.for('nodejs.util.promisify.custom')]: async (_binary: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => ({
        stdout: JSON.stringify({ sessions: executable.sessionList(options?.env) }),
        stderr: '',
      }),
    }),
    spawn: executable.spawn,
  };
});

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { handleHerdrCliCommand } from '@/cli/commands/herdr';
import { runHerdrAttach } from '@/terminal/attachment/herdrAttach';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withSocketTempDir } from '@/testkit/fs/tempDir';
import { createHerdrClient } from './client';
import { withHerdrApi } from './herdrApi.testkit';

const envScope = createEnvKeyScope(['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_BIN_PATH', 'XDG_CONFIG_HOME']);
beforeEach(() => {
  envScope.patch({ HERDR_ENV: undefined, HERDR_SOCKET_PATH: undefined, HERDR_PANE_ID: undefined, HERDR_BIN_PATH: process.execPath });
  executable.spawn.mockReset();
  executable.sessionList.mockReset();
  executable.sessionList.mockImplementation(() => [{ name: 'default', socket_path: executable.socketPath, running: true }]);
  executable.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
});
afterEach(() => envScope.restore());

describe('Herdr CLI entrypoint admission', () => {
  it.skipIf(process.platform === 'win32').each([['work', 0], ['default', 0], ['work', 5_100]] as const)('opens only the recorded restored pane after cold %s startup despite a different ambient root (delay=%s)', async (sessionName, delayMs) => {
    const relativeSessionDir = sessionName === 'default' ? 'herdr' : `herdr/sessions/${sessionName}`;
    await withSocketTempDir(async root => await withHerdrApi(async (api) => {
      executable.socketPath = api.socketPath;
      await api.stop();
      api.panes.add('managed');
      envScope.patch({ XDG_CONFIG_HOME: join(root, 'ambient') });
      let running = false;
      let startup: Promise<void> | null = null;
      executable.sessionList.mockImplementation((env?: NodeJS.ProcessEnv) => [
        { name: sessionName, socket_path: env?.XDG_CONFIG_HOME === root ? api.socketPath : join(root, 'ambient', relativeSessionDir, 'herdr.sock'),
          session_dir: env?.XDG_CONFIG_HOME === root ? join(root, relativeSessionDir) : join(root, 'ambient', relativeSessionDir), running },
      ]);
      executable.spawn.mockImplementation((_file: string, args: string[]) => {
        const child = Object.assign(new EventEmitter(), { unref: () => {} });
        if (args.includes('attach')) queueMicrotask(() => child.emit('exit', 0));
        else {
          // A server start may outlive the API action budget without exhausting
          // the existing terminal-host startup operation.
          startup = new Promise<void>(resolve => setTimeout(resolve, delayMs))
            .then(() => api.start()).then(() => { running = true; });
          void startup.catch(error => child.emit('error', error));
        }
        return child;
      });
      try { await expect(runHerdrAttach({ terminal: { mode: 'herdr', herdr: {
        sessionName, socketPath: api.socketPath,
        terminalId: 'previous-terminal', paneId: 'managed',
      } } })).resolves.toBe(0);
      const launches = executable.spawn.mock.calls.map(([, args, options]) => ({ args,
        socketPath: options.env?.HERDR_SOCKET_PATH, sessionName: options.env?.HERDR_SESSION }));
      expect(launches).toContainEqual({ args: ['server'], socketPath: api.socketPath, sessionName });
      expect(launches).toContainEqual({ args: ['terminal', 'attach', 'terminal_1'], socketPath: api.socketPath, sessionName });
      expect(api.requests.some((request) => request.method === 'pane.close' || request.method === 'layout.apply')).toBe(false);
      } finally { await startup; }
    }, { socketPath: join(root, relativeSessionDir, 'herdr.sock') }));
  });

  it.skipIf(process.platform === 'win32').each(['custom_socket', 'mismatched_inventory'])('refuses unverified cold roots without contacting a live ambient server (%s)', async evidence => {
    await withSocketTempDir(async root => await withHerdrApi(async ambient => {
      executable.sessionList.mockReturnValue([{ name: 'work', socket_path: ambient.socketPath,
        session_dir: join(root, 'foreign/herdr/sessions/work'), running: true }]);
      const socketPath = evidence === 'custom_socket' ? join(root, 'custom.sock') : join(root, 'herdr/sessions/work/herdr.sock');
      await expect(runHerdrAttach({ terminal: { mode: 'herdr', herdr: {
        sessionName: 'work', socketPath, terminalId: 'old-terminal', paneId: 'managed',
      } } })).rejects.toMatchObject({ code: 'recorded_server_root_unavailable' });
      expect(executable.spawn).not.toHaveBeenCalled();
      expect(ambient.requests).toEqual([]);
    }));
  });

  it('preserves a selected live endpoint without querying a same-name ambient server', async () => {
    await withHerdrApi(async selected => await withHerdrApi(async ambient => {
      executable.sessionList.mockReturnValue([{ name: 'work', socket_path: ambient.socketPath, running: true }]);
      const client = createHerdrClient({ binary: 'herdr', sessionName: 'work', socketPath: selected.socketPath, actionTimeoutMs: 1000, startupTimeoutMs: 1000 });
      await expect(client.ensureServer()).resolves.toBe(selected.socketPath);
      expect(client.socketPath).toBe(selected.socketPath);
      expect(selected.requests.map(request => request.method)).toEqual(['session.snapshot']);
      expect(ambient.requests).toEqual([]);
      expect(executable.sessionList).not.toHaveBeenCalled();
      expect(executable.spawn).not.toHaveBeenCalled();
    }));
  });

  it.each(['running', 'start'] as const)('discovers only the admitted environment before provider configuration changes the ambient root (%s)', async state => {
    await withHerdrApi(async selected => await withHerdrApi(async ambient => {
      const admittedEnv = { ...process.env, XDG_CONFIG_HOME: '/admitted-config' };
      envScope.patch({ XDG_CONFIG_HOME: '/provider-config' });
      let running = state === 'running';
      executable.sessionList.mockImplementation((env?: NodeJS.ProcessEnv) => [{
        name: 'work', socket_path: env?.XDG_CONFIG_HOME === admittedEnv.XDG_CONFIG_HOME
          ? selected.socketPath : ambient.socketPath, running,
      }]);
      executable.spawn.mockImplementation((_binary: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        running = options.env?.XDG_CONFIG_HOME === admittedEnv.XDG_CONFIG_HOME;
        return Object.assign(new EventEmitter(), { unref: () => {} });
      });
      const client = createHerdrClient({ binary: 'herdr', sessionName: 'work', processEnv: admittedEnv,
        actionTimeoutMs: 1000, startupTimeoutMs: 1000 });
      await expect(client.ensureServer()).resolves.toBe(selected.socketPath);
      expect(selected.requests.map(request => request.method)).toEqual(['session.snapshot']);
      expect(ambient.requests).toEqual([]);
      if (state === 'running') expect(executable.spawn).not.toHaveBeenCalled();
    }));
  });

  it('retires the server it spawned when that startup fails, and never one it adopted', async () => {
    executable.sessionList.mockReturnValue([{ name: 'work', socket_path: '/never/herdr.sock', running: false }]);
    const kill = vi.fn(() => true);
    executable.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: () => {}, kill }));
    const client = createHerdrClient({ binary: 'herdr', sessionName: 'work', actionTimeoutMs: 1000, startupTimeoutMs: 150 });
    await expect(client.ensureServer()).rejects.toMatchObject({ code: 'server_start_timeout' });
    expect(executable.spawn).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')('retires the whole process group of a spawned server that daemonizes a child', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    executable.sessionList.mockReturnValue([{ name: 'work', socket_path: '/never/herdr.sock', running: false }]);
    let grandchildPid = 0;
    const reported = new Promise<void>(resolve => {
      executable.spawn.mockImplementation((_binary: string, _args: string[], options: Parameters<typeof actual.spawn>[2]) => {
        // A forking fake: the direct child starts a grandchild in its group and reports its pid.
        const child = actual.spawn(process.execPath, ['-e', `const c = require('node:child_process').spawn(process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);`],
          { ...options, stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout?.once('data', chunk => { grandchildPid = Number(String(chunk).trim()); resolve(); });
        return child;
      });
    });
    const client = createHerdrClient({ binary: 'herdr', sessionName: 'work', actionTimeoutMs: 1000, startupTimeoutMs: 1500 });
    const startup = client.ensureServer();
    await reported;
    try {
      await expect(startup).rejects.toMatchObject({ code: 'server_start_timeout' });
      await vi.waitFor(() => {
        expect(() => process.kill(grandchildPid, 0)).toThrow();
      }, { timeout: 3000 });
    } finally {
      // The test owns this fixture tree; never leave it running on RED.
      for (const pid of [grandchildPid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });

  it('refuses a lost selected endpoint rather than substituting a live ambient server', async () => {
    await withHerdrApi(async selected => await withHerdrApi(async ambient => {
      await selected.stop();
      executable.sessionList.mockReturnValue([{ name: 'work', socket_path: ambient.socketPath, running: true }]);
      const client = createHerdrClient({ binary: 'herdr', sessionName: 'work', socketPath: selected.socketPath, actionTimeoutMs: 1000, startupTimeoutMs: 1000 });
      await expect(client.ensureServer()).rejects.toMatchObject({ code: 'unreachable' });
      expect(client.socketPath).toBe(selected.socketPath);
      expect(ambient.requests).toEqual([]);
      expect(executable.spawn).not.toHaveBeenCalled();
    }));
  });

  it.skipIf(process.platform === 'win32').each(['command', 'foreground_attach', 'inside_focus'] as const)(
    'refuses an older exact server before %s despite a supported installed executable', async (entrypoint) => {
      await withHerdrApi(async (api) => {
        executable.socketPath = api.socketPath;
        api.setServerVersion('0.9.1');
        api.panes.add('managed');
        if (entrypoint === 'inside_focus') envScope.patch({ HERDR_SOCKET_PATH: api.socketPath, HERDR_PANE_ID: 'managed' });
        const operation = entrypoint === 'command'
          ? handleHerdrCliCommand({ args: ['herdr'], rawArgv: [], terminalRuntime: null })
          : runHerdrAttach({ terminal: { mode: 'herdr', herdr: { sessionName: 'work', socketPath: api.socketPath, terminalId: 'terminal_1' } } });
        await expect(operation).rejects.toMatchObject({ code: 'unsupported_server_version' });
        expect(executable.spawn).not.toHaveBeenCalled();
        expect(api.requests.some((request) => request.method === 'pane.focus' || request.method === 'layout.apply')).toBe(false);
        expect([...api.panes]).toEqual(['managed']);
      });
    },
  );

  it.skipIf(process.platform === 'win32').each(['command', 'foreground_attach', 'inside_focus'] as const)(
    'admits the stable exact server for %s without creating another pane', async (entrypoint) => {
      await withHerdrApi(async (api) => {
        executable.socketPath = api.socketPath;
        api.panes.add('managed');
        if (entrypoint === 'inside_focus') envScope.patch({ HERDR_SOCKET_PATH: api.socketPath, HERDR_PANE_ID: 'managed' });
        if (entrypoint === 'command') await handleHerdrCliCommand({ args: ['herdr'], rawArgv: [], terminalRuntime: null });
        else await expect(runHerdrAttach({ terminal: { mode: 'herdr', herdr: {
          sessionName: 'work', socketPath: api.socketPath, terminalId: 'terminal_1',
        } } })).resolves.toBe(0);
        expect(api.requests.some((request) => request.method === 'session.snapshot')).toBe(true);
        expect(api.requests.some((request) => request.method === 'layout.apply')).toBe(false);
        if (entrypoint === 'inside_focus') {
          expect(executable.spawn).not.toHaveBeenCalled();
          expect(api.requests.some((request) => request.method === 'pane.focus')).toBe(true);
        } else expect(executable.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
          expect.objectContaining({ env: expect.objectContaining({ HERDR_SOCKET_PATH: api.socketPath }) }));
      });
    },
  );
});
