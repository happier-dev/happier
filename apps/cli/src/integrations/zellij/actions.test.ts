import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({
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

async function expectTimedOutAndKilled(
  result: Promise<unknown>,
  child: ReturnType<typeof mockHangingChild>,
  advanceMs: number,
  expectedError: new (...args: never[]) => Error,
) {
  let rejection: unknown;
  const killProcessGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const handled = result.catch((error: unknown) => {
    rejection = error;
  });
  try {
    await vi.advanceTimersByTimeAsync(advanceMs);
    await Promise.resolve();
    expect(rejection).toBeUndefined();
    expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', 0);
    await handled;
    expect(rejection).toBeInstanceOf(expectedError);
  } finally {
    await result.catch(() => undefined);
    killProcessGroup.mockRestore();
  }
}

describe('zellij actions', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => mockChild());
    vi.useRealTimers();
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
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = mockHangingChild();
    const second = mockHangingChild();
    spawnMock
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    const killProcessGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const { writeBytesChunked, ZellijActionTimeoutError } = await import('./actions');
      let rejection: unknown;
      const write = writeBytesChunked({
        zellijBinary: '/tools/zellij',
        paneId: 'terminal_1',
        text: 'abcd',
        chunkSize: 2,
        env: {},
        timeoutMs: 100,
      }).catch((error: unknown) => {
        rejection = error;
      });

      await Promise.resolve();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(90);
      first.emit('close', 0);
      // The machine-wide action limiter adds an admission/release microtask hop around each client
      // spawn; flush microtasks until the second write chunk has been admitted and spawned.
      for (let flush = 0; flush < 20 && spawnMock.mock.calls.length < 2; flush += 1) {
        await Promise.resolve();
      }
      expect(spawnMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(11);
      expect(killProcessGroup).toHaveBeenCalledWith(-second.pid, 'SIGTERM');
      second.emit('close', 0);
      await write;
      expect(rejection).toBeInstanceOf(ZellijActionTimeoutError);
    } finally {
      killProcessGroup.mockRestore();
      vi.useRealTimers();
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

  it('kills a hung list-panes action when its timeout elapses and rejects after the child exits', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    spawnMock.mockImplementationOnce(() => child);
    const { listPanes, ZellijActionTimeoutError } = await import('./actions');

    const result = listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 25 });

    await expectTimedOutAndKilled(result, child, 25, ZellijActionTimeoutError);
  });

  it('signals the zellij action process group when a timeout elapses', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    const killProcessGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementationOnce(() => child);
    const { listPanes, ZellijActionTimeoutError } = await import('./actions');
    const result = listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 25 });

    try {
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
      const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
      expect(options).toEqual(expect.objectContaining({ detached: true, shell: false }));
      expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      child.emit('close', 0);
      await expect(result).rejects.toBeInstanceOf(ZellijActionTimeoutError);
    } finally {
      child.emit('close', 0);
      await result.catch(() => undefined);
      killProcessGroup.mockRestore();
    }
  });

  it('rejects after a bounded kill grace when a timed-out action does not close', async () => {
    vi.useFakeTimers();
    const child = mockHangingChild();
    const killProcessGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementationOnce(() => child);
    const { listPanes, ZellijActionTimeoutError } = await import('./actions');

    let rejection: unknown;
    const result = listPanes({ zellijBinary: '/tools/zellij', env: {}, timeoutMs: 25 });
    result.catch((error: unknown) => {
      rejection = error;
    });

    try {
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
      expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(rejection).toBeUndefined();

      await vi.advanceTimersByTimeAsync(249);
      await Promise.resolve();
      expect(rejection).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(rejection).toBeInstanceOf(ZellijActionTimeoutError);
      await result.catch(() => undefined);
    } finally {
      killProcessGroup.mockRestore();
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
