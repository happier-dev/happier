import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const herdrClientMocks = vi.hoisted(() => ({
  sessions: [{ name: 'work', socketPath: '/tmp/work.sock', running: true }],
}));

// Replace session inventory/socket boundaries; version probes use a real executable.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return {
    ...actual,
    execFile: Object.assign(vi.fn((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args)), {
      [promisify.custom]: async (_binary: string, args: readonly string[]) => ({
        stdout: args.includes('--version') ? 'herdr 0.9.2' : JSON.stringify({ sessions: herdrClientMocks.sessions.map((session) => ({
          name: session.name, socket_path: session.socketPath, running: session.running,
        })) }),
        stderr: '',
      }),
    }),
  };
});
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    createConnection: () => {
      const socket = Object.assign(new EventEmitter(), {
        setTimeout() {},
        setEncoding() {},
        destroy() {},
        write(raw: string) {
          const request = JSON.parse(raw) as { method: string };
          const result = request.method === 'session.snapshot'
            ? { snapshot: { version: '0.9.2' } }
            : { pane: { pane_id: 'w1:p2', terminal_id: 'term_42', workspace_id: 'w1', tab_id: 'w1:t1' } };
          queueMicrotask(() => socket.emit('data', Buffer.from(`${JSON.stringify({ result })}\n`)));
        },
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  };
});

import { resolveInheritedHerdrRuntime } from './inheritedHerdrRuntime';

beforeEach(() => vi.stubEnv('HERDR_BIN_PATH', process.execPath));
afterEach(() => vi.unstubAllEnvs());

describe('resolveInheritedHerdrRuntime', () => {
  it('uses the successfully probed pane socket even when session-list liveness has not converged yet', async () => {
    herdrClientMocks.sessions = [{ name: 'work', socketPath: '/tmp/work.sock', running: false }];
    const env: NodeJS.ProcessEnv = {
      HERDR_BIN_PATH: process.execPath, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/work.sock', HERDR_PANE_ID: 'w1:p2',
    };

    await expect(resolveInheritedHerdrRuntime({ terminalRuntime: null, env })).resolves.toMatchObject({
      mode: 'herdr', herdrSessionName: 'work', herdrSocketPath: '/tmp/work.sock', herdrTerminalId: 'term_42',
    });
  });

  it('uses the daemon-carried Herdr session name and binary without rediscovering its own launch target', async () => {
    vi.stubEnv('HERDR_BIN_PATH', '/nonexistent-host-herdr');
    herdrClientMocks.sessions = [];
    const env: NodeJS.ProcessEnv = {
      HERDR_BIN_PATH: process.execPath, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/work.sock', HERDR_PANE_ID: 'w1:p2',
    };

    await expect(resolveInheritedHerdrRuntime({
      terminalRuntime: { mode: 'herdr', requested: 'herdr', herdrSessionName: 'work terminals' },
      env,
    })).resolves.toMatchObject({
      mode: 'herdr', herdrSessionName: 'work terminals',
      herdrSocketPath: '/tmp/work.sock', herdrTerminalId: 'term_42',
    });
  });

  it('binds an agent wrapper to the current Herdr terminal without allowing native hooks to claim it', async () => {
    herdrClientMocks.sessions = [{ name: 'work', socketPath: '/tmp/work.sock', running: true }];
    const env: NodeJS.ProcessEnv = {
      HERDR_BIN_PATH: process.execPath, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/work.sock', HERDR_PANE_ID: 'w1:p2',
    };
    await expect(resolveInheritedHerdrRuntime({ terminalRuntime: null, env })).resolves.toEqual({
      mode: 'herdr', requested: 'herdr', herdrSessionName: 'work',
      herdrSocketPath: '/tmp/work.sock', herdrTerminalId: 'term_42', herdrPaneId: 'w1:p2',
      attachmentId: expect.any(String),
    });
    expect(env.HERDR_ENV).toBeUndefined();
  });

  it('preserves the exact daemon-carried attachment identity ahead of inherited environment', async () => {
    const runtime = await resolveInheritedHerdrRuntime({
      terminalRuntime: { mode: 'herdr', herdrSessionName: 'work', attachmentId: 'daemon-attachment' },
      env: {
        HERDR_BIN_PATH: process.execPath, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/work.sock', HERDR_PANE_ID: 'w1:p2',
        HAPPIER_TERMINAL_ATTACHMENT_ID: 'ambient-attachment',
      },
    });
    expect(runtime?.attachmentId).toBe('daemon-attachment');
  });

  it('preserves an inherited exact attachment identity when flags have none', async () => {
    const runtime = await resolveInheritedHerdrRuntime({
      terminalRuntime: { mode: 'herdr', herdrSessionName: 'work' },
      env: {
        HERDR_BIN_PATH: process.execPath, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/work.sock', HERDR_PANE_ID: 'w1:p2',
        HAPPIER_TERMINAL_ATTACHMENT_ID: 'ambient-attachment',
      },
    });
    expect(runtime?.attachmentId).toBe('ambient-attachment');
  });

  it('does not override a daemon-supplied terminal decision', async () => {
    await expect(resolveInheritedHerdrRuntime({
      terminalRuntime: { mode: 'plain', requested: 'herdr' },
      env: { HERDR_BIN_PATH: process.execPath, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/work.sock', HERDR_PANE_ID: 'w1:p2' },
    })).resolves.toEqual({ mode: 'plain', requested: 'herdr' });
  });
});
