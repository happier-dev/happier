import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const startHappyHeadlessInTmux = vi.fn(async () => {});

// TMUX launcher touches the host environment; treat it as a boundary and stub it in unit tests.
vi.mock('@/terminal/tmux/startHappyHeadlessInTmux', () => ({
  startHappyHeadlessInTmux,
}));

import { dispatchCli } from './dispatch';

describe('dispatchCli --tmux disallowed controller commands', () => {
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as any);

  beforeEach(() => {
    exitSpy.mockClear();
    startHappyHeadlessInTmux.mockClear();
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
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
});
