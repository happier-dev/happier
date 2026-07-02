import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';

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
});
