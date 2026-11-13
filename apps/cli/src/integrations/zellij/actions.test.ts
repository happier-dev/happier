import { EventEmitter, once } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}));

function mockChild(exitCode = 0, stdout = '', stderr = '') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  return child;
}

function mockHangingChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  child.kill = vi.fn();
  return child;
}

async function spawnResistantTree(rootExitsOnTerm = false) {
  const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const childScript = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
  const parent = native.spawn(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    process.on('SIGTERM', () => { process.send('term'); ${rootExitsOnTerm ? 'process.exit(0);' : ''} });
    child.once('message', () => process.send(child.pid));
    setInterval(() => {}, 1000);
  `], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const [childPid] = await once(parent, 'message');
  if (typeof childPid !== 'number') throw new Error('Expected descendant PID');
  return { parent, childPid };
}

describe('zellij actions', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => mockChild());
    vi.useRealTimers();
  });

  it('keeps admitted Session removals and explicit overrides at both Zellij launch boundaries', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'physical-host-key');
    try {
      const { attachCreateBackground, runCommand, sendEnter } = await import('./actions');
      for (const sessionName of ['removed', 'selected']) {
        const environment = buildScopedProcessEnv({ baseEnv: process.env,
          explicitEnv: { TERM: `session-${sessionName}`, ...(sessionName === 'selected' ? { OPENAI_API_KEY: 'selected-account-key' } : {}) },
          unsetEnvKeys: sessionName === 'removed' ? ['OPENAI_API_KEY'] : [] });
        await runAddedHostedSession({ environment, workingDirectory: '/workspace', end() {} }, async () => {
          const params = { zellijBinary: '/tools/zellij', sessionName, cwd: '/workspace',
            env: { ...environment, TERM: `explicit-${sessionName}` } };
          await attachCreateBackground(params);
          await runCommand({ ...params, command: ['/tools/native-agent'] });
        });
        for (const call of spawnMock.mock.calls.slice(-2)) {
          const options = call[2] as SpawnOptions;
          expect(options.env?.TERM).toBe(`explicit-${sessionName}`);
          expect(options.env?.OPENAI_API_KEY).toBe(sessionName === 'selected' ? 'selected-account-key' : undefined);
        }
      }
      await sendEnter({ zellijBinary: '/tools/zellij', paneId: 'terminal_1', env: {} });
      const controlOptions = spawnMock.mock.calls.at(-1)?.[2] as SpawnOptions;
      expect(controlOptions.env?.OPENAI_API_KEY).toBe('physical-host-key');
    } finally { vi.unstubAllEnvs(); }
  });

  it('writes byte chunks and Enter to the explicit pane without shell interpolation', async () => {
    const { writeBytesChunked, sendEnter } = await import('./actions');

    await writeBytesChunked({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      text: 'hello $(rm -rf /)',
      chunkSize: 5,
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' },
    });
    await sendEnter({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' },
    });

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      '/tools/zellij',
      ['action', 'write', '--pane-id', 'terminal_1', '104', '101', '108', '108', '111'],
      expect.objectContaining({ shell: false }),
    );
    expect(spawnMock).toHaveBeenLastCalledWith(
      '/tools/zellij',
      ['action', 'send-keys', '--pane-id', 'terminal_1', 'Enter'],
      expect.objectContaining({ shell: false }),
    );
    const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    expect(options?.env).toMatchObject({ ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' });
  });

  it('sends the pinned zellij Escape key name to the explicit pane', async () => {
    const { sendEscape } = await import('./actions');

    await sendEscape({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_7',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' },
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['action', 'send-keys', '--pane-id', 'terminal_7', 'Esc'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('attaches the current terminal to the requested Zellij session without a shell', async () => {
    const { attachForeground } = await import('./actions');

    await expect(attachForeground({
      zellijBinary: '/tools/zellij',
      sessionName: 'happier',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' },
    })).resolves.toEqual({ exitCode: 0, stdout: '', stderr: '' });

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['attach', 'happier'],
      expect.objectContaining({
        shell: false,
        stdio: 'inherit',
        env: expect.objectContaining({ ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' }),
      }),
    );
  });

  it('pastes prompt text through zellij action paste without shell interpolation', async () => {
    const { pasteText } = await import('./actions');

    await pasteText({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_1',
      text: 'hello $(rm -rf /)\nline two',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' },
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['action', 'paste', '--pane-id', 'terminal_1', 'hello $(rm -rf /)\nline two'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('removes inherited environment keys case-insensitively before launching a zellij client', async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-key';
    try {
      const { sendEnter } = await import('./actions');

      await sendEnter({
        zellijBinary: '/tools/zellij',
        paneId: 'terminal_1',
        env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij sock' },
        unsetEnvKeys: ['openai_api_key'],
      });

      const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
      expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
      expect(options?.env?.ZELLIJ_SOCKET_DIR).toBe('/tmp/zellij sock');
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  it('applies one prompt-wide timeout across all write chunks', async () => {
    if (process.platform === 'win32') return; // Native POSIX signal contract; Windows owner tested separately.
    const { parent, childPid } = await spawnResistantTree();
    const first = mockHangingChild();
    spawnMock
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => parent);
    try {
      const { writeBytesChunked, ZellijActionTimeoutError } = await import('./actions');
      const term = once(parent, 'message');
      const write = writeBytesChunked({
        zellijBinary: '/tools/zellij',
        paneId: 'terminal_1',
        text: 'abcd',
        chunkSize: 2,
        env: {},
        timeoutMs: 2_000,
      }).then(() => null, (error: unknown) => error);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 1_800));
      const secondStartedAt = Date.now();
      first.emit('close', 0);
      await term;
      // Leave native census latency room while distinguishing a renewed full timeout.
      expect(Date.now() - secondStartedAt).toBeLessThan(2_000);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(await write).toBeInstanceOf(ZellijActionTimeoutError);
    } finally {
      for (const pid of [parent.pid!, childPid]) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* fixture already ended */ }
      }
    }
  });

  it('dumps the screen with SGR styling preserved via --ansi (ported S-8)', async () => {
    const esc = String.fromCharCode(0x1b);
    spawnMock.mockImplementationOnce(() => mockChild(0, `> ${esc}[2mhint${esc}[22m\n`));
    const { dumpScreen } = await import('./actions');

    await expect(dumpScreen({ zellijBinary: '/tools/zellij', paneId: 'terminal_1', env: {} }))
      .resolves.toBe(`> ${esc}[2mhint${esc}[22m\n`);
    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['action', 'dump-screen', '--ansi', '--pane-id', 'terminal_1'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('falls back to a plain dump when the zellij build rejects --ansi (ported S-8)', async () => {
    spawnMock.mockImplementationOnce(() => mockChild(2, '', 'error: unexpected argument --ansi'));
    spawnMock.mockImplementationOnce(() => mockChild(0, '> plain\n'));
    const { dumpScreen } = await import('./actions');

    await expect(dumpScreen({ zellijBinary: '/tools/zellij', paneId: 'terminal_1', env: {} }))
      .resolves.toBe('> plain\n');
    expect(spawnMock).toHaveBeenLastCalledWith(
      '/tools/zellij',
      ['action', 'dump-screen', '--pane-id', 'terminal_1'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('lists panes from JSON output', async () => {
    spawnMock.mockImplementationOnce(() => mockChild(0, '[{"id":1,"is_plugin":false,"is_focused":true}]\n'));
    const { listPanes } = await import('./actions');

    await expect(listPanes({ zellijBinary: '/tools/zellij', env: {} })).resolves.toEqual([
      { id: 1, is_plugin: false, is_focused: true },
    ]);
    expect(spawnMock).toHaveBeenCalledWith(
      '/tools/zellij',
      ['action', 'list-panes', '--json'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('reports cleanup incomplete when the authoritative census refuses the timed-out root', async () => {
    const child = mockHangingChild();
    // The actual census protects its reader. A successful signal mock cannot prove cleanup.
    child.pid = process.pid;
    spawnMock.mockImplementationOnce(() => child);
    const { listPanes } = await import('./actions');
    const failure = await listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 10 })
      .then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 'plugin_exec_termination_incomplete' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([false, true])('ends the resistant descendant before releasing its slot (root exits on TERM: %s)', async (rootExitsOnTerm) => {
    if (process.platform === 'win32') return; // Uses the real POSIX signal boundary.
    const { parent, childPid } = await spawnResistantTree(rootExitsOnTerm);
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    const nativeKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => nativeKill(pid, signal));
    spawnMock.mockImplementationOnce(() => parent).mockImplementationOnce(() => {
      expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true);
      expect(kill).toHaveBeenCalledWith(childPid, 'SIGKILL');
      return mockChild(0, '[]');
    });
    try {
      const { listPanes, ZellijActionTimeoutError } = await import('./actions');
      const first = listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 25 })
        .then(() => null, (error: unknown) => error);
      const second = listPanes({ zellijBinary: '/tools/zellij', env: {} });
      const failure = await first;
      expect(failure).toBeInstanceOf(ZellijActionTimeoutError);
      expect(failure instanceof Error ? failure.cause : failure).toBeUndefined();
      await expect(second).resolves.toEqual([]);
      expect(await waitForProcessExit(childPid)).toBe(true);
      expect(kill).toHaveBeenCalledWith(childPid, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(parent.pid, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(childPid, 'SIGKILL');
      if (!rootExitsOnTerm) expect(kill).toHaveBeenCalledWith(parent.pid, 'SIGKILL');
    } finally {
      kill.mockRestore();
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
      for (const pid of [parent.pid!, childPid]) {
        try { nativeKill(pid, 'SIGKILL'); } catch { /* fixture already ended */ }
      }
    }
  });

  it('globally caps concurrent zellij action client invocations', async () => {
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }> = [];
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      return child;
    });

    try {
      const { listPanes } = await import('./actions');
      const first = listPanes({ zellijBinary: '/tools/zellij', env: {} });
      const second = listPanes({ zellijBinary: '/tools/zellij', env: {} });

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      children[0]!.stdout.emit('data', Buffer.from('[]'));
      children[0]!.emit('close', 0);
      await first;
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));

      children[1]!.stdout.emit('data', Buffer.from('[]'));
      children[1]!.emit('close', 0);
      await second;
    } finally {
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
    }
  });

  it('shares the zellij action cap across independent module instances and jitters contention retries', async () => {
    const socketDir = await mkdtemp(join(tmpdir(), 'happier-zellij-limit-'));
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }> = [];
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      return child;
    });

    try {
      vi.resetModules();
      const firstActions = await import('./actions');
      const first = firstActions.listPanes({
        zellijBinary: '/tools/zellij',
        env: { ZELLIJ_SOCKET_DIR: socketDir },
      });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      vi.resetModules();
      const secondActions = await import('./actions');
      const second = secondActions.listPanes({
        zellijBinary: '/tools/zellij',
        env: { ZELLIJ_SOCKET_DIR: socketDir },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      // The second independent module instance shares the filesystem-brokered cap: no second client
      // spawns while the first holds the only slot, and contention retries consult the jitter source.
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(random).toHaveBeenCalled();

      children[0]!.stdout.emit('data', Buffer.from('[]'));
      children[0]!.emit('close', 0);
      await first;
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      children[1]!.stdout.emit('data', Buffer.from('[]'));
      children[1]!.emit('close', 0);
      await second;
    } finally {
      for (const child of children) child.emit('close', 0);
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
      random.mockRestore();
      await rm(socketDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('includes limiter queue wait in the zellij action timeout deadline', async () => {
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    const firstChild = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    firstChild.stdout = new EventEmitter();
    firstChild.stderr = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => firstChild)
      .mockImplementation(() => mockChild(0, '[]'));

    try {
      vi.resetModules();
      const { listPanes, ZellijActionTimeoutError } = await import('./actions');
      const first = listPanes({ zellijBinary: '/tools/zellij', env: {} });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      let queueError: unknown;
      const second = listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 25 }).catch((error: unknown) => {
        queueError = error;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const errorBeforeRelease = queueError;

      firstChild.stdout.emit('data', Buffer.from('[]'));
      firstChild.emit('close', 0);
      await first;
      await second;

      // The queued action's deadline spans the admission wait, so it times out before it is ever
      // granted a slot — it does not spawn a client with a fresh full-length timeout.
      expect(errorBeforeRelease).toBeInstanceOf(ZellijActionTimeoutError);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      firstChild.emit('close', 0);
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
      vi.resetModules();
    }
  });

  it('reclaims a shared zellij action slot whose owner process is gone', async () => {
    const socketDir = await mkdtemp(join(tmpdir(), 'happier-zellij-dead-owner-'));
    const slotDir = join(socketDir, '.happier-action-slots', 'slot-0');
    process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY = '1';
    await mkdir(slotDir, { recursive: true });
    await writeFile(join(slotDir, 'owner.json'), JSON.stringify({
      pid: 99_999_999,
      nonce: 'dead-owner',
      acquiredAtMs: 1,
    }));
    spawnMock.mockImplementation(() => mockChild(0, '[]'));

    try {
      vi.resetModules();
      const { listPanes } = await import('./actions');
      await expect(listPanes({
        zellijBinary: '/tools/zellij',
        env: { ZELLIJ_SOCKET_DIR: socketDir },
        timeoutMs: 250,
      })).resolves.toEqual([]);
    } finally {
      delete process.env.HAPPIER_ZELLIJ_ACTION_MAX_CONCURRENCY;
      await rm(socketDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
