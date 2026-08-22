import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, requireJavaScriptRuntimeExecutableMock, killProcessTreeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  requireJavaScriptRuntimeExecutableMock: vi.fn(async (): Promise<string> => process.execPath),
  killProcessTreeMock: vi.fn(async (_proc: unknown, _opts?: unknown) => {}),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@/packagedRuntime/js/requireJavaScriptRuntimeExecutable', () => ({
  requireJavaScriptRuntimeExecutable: requireJavaScriptRuntimeExecutableMock,
}));

// The process-tree helper is the OS boundary owner; its cross-platform process
// semantics have their own focused suite. This wrapper test proves ripgrep
// delegates cancellation to that owner instead of settling only its RPC promise.
vi.mock('@/agent/runtime/process/killProcessTree', () => ({
  killProcessTree: (proc: unknown, opts?: unknown) => killProcessTreeMock(proc, opts),
}));

describe('ripgrep runtime resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    killProcessTreeMock.mockReset();
    requireJavaScriptRuntimeExecutableMock.mockReset();
    requireJavaScriptRuntimeExecutableMock.mockResolvedValue(process.execPath);
  });

  it('uses the ensured JavaScript runtime instead of process.execPath', async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = stdout;
    child.stderr = stderr;

    spawnMock.mockReturnValue(child);
    requireJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');

    const { run } = await import('./index');
    const promise = run(['describe', 'needle']);
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    stdout.emit('data', Buffer.from('ok'));
    stderr.emit('data', Buffer.from(''));
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/managed/js-runtime',
      expect.arrayContaining([expect.stringContaining('ripgrep_launcher.cjs'), JSON.stringify(['describe', 'needle'])]),
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
  });

  it('fails closed when no JavaScript runtime is available', async () => {
    requireJavaScriptRuntimeExecutableMock.mockRejectedValue(new ReferenceError('Set HAPPIER_JS_RUNTIME_PATH'));

    const { run } = await import('./index');

    await expect(run(['describe', 'needle'])).rejects.toThrow(/HAPPIER_JS_RUNTIME_PATH/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('terminates the launcher process tree when its caller cancels', async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 4242;
    child.stdout = stdout;
    child.stderr = stderr;
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();

    const { run } = await import('./index');
    const pending = (run as unknown as (
      args: string[],
      options: Readonly<{ signal: AbortSignal }>,
    ) => Promise<unknown>)(['--files'], { signal: controller.signal });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    controller.abort();

    const settled = await Promise.race([
      pending.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
    ]);
    expect(settled).toMatchObject({
      status: 'rejected',
      error: { name: 'AbortError', code: 'RIPGREP_ABORTED' },
    });
    expect(killProcessTreeMock).toHaveBeenCalledWith(child, undefined);
  });
});
