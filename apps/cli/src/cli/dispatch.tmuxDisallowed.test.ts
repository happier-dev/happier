import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const startHappyHeadlessInTmux = vi.fn(async () => {});

// TMUX launcher touches the host environment; treat it as a boundary and stub it in unit tests.
vi.mock('@/terminal/tmux/startHappyHeadlessInTmux', () => ({
  startHappyHeadlessInTmux,
}));

import { dispatchCli } from './dispatch';

describe('dispatchCli --tmux disallowed controller commands', () => {
  let consoleErrorSpy: MockInstance;
  let exitSpy: MockInstance;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      const normalized = typeof code === 'number' ? code : Number(code ?? 0);
      throw new Error(`process.exit(${Number.isFinite(normalized) ? normalized : 0})`);
    });

    exitSpy.mockClear();
    startHappyHeadlessInTmux.mockClear();
    consoleErrorSpy.mockClear();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects --tmux for session controller commands', async () => {
    await expect(
      dispatchCli({
        args: ['session', 'list', '--tmux'],
        rawArgv: ['happier', 'session', 'list', '--tmux'],
        terminalRuntime: null,
      }),
    ).rejects.toThrow('process.exit(1)');
    expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
  });

  it('does not start tmux when process.exit is mocked to no-op', async () => {
    exitSpy.mockImplementation(() => undefined);

    await expect(
      dispatchCli({
        args: ['session', 'list', '--tmux'],
        rawArgv: ['happier', 'session', 'list', '--tmux'],
        terminalRuntime: null,
      }),
    ).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
  });
});
