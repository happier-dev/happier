import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, requireJavaScriptRuntimeExecutableMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  requireJavaScriptRuntimeExecutableMock: vi.fn(async (): Promise<string> => process.execPath),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@/runtime/js/requireJavaScriptRuntimeExecutable', () => ({
  requireJavaScriptRuntimeExecutable: requireJavaScriptRuntimeExecutableMock,
}));

describe('ripgrep runtime resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
