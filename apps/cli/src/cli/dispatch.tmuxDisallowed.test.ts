import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

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

  it('leaves implicit profile terminal policy to the tmux child invocation', async () => {
    const original = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    try {
      delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
      await dispatchCli({ args: ['--profile', 'codex', '--tmux'], rawArgv: [], terminalRuntime: null });
      expect(startHappyHeadlessInTmux).toHaveBeenCalledWith(['--profile', 'codex', '--tmux']);
      expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBeUndefined();
      process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '1';
      await dispatchCli({ args: ['--profile', 'codex', '--tmux'], rawArgv: [], terminalRuntime: null });
      expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('1');
    } finally {
      if (original === undefined) delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
      else process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = original;
    }
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

  it('does not interpret literal --tmux after the option terminator', async () => {
    const output = captureStdoutJsonOutput<{ kind: string }>();
    try {
      await dispatchCli({
        args: ['capabilities', '--json', '--', '--tmux'],
        rawArgv: ['happier', 'capabilities', '--json', '--', '--tmux'],
        terminalRuntime: null,
      });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(output.json().kind).toBe('capabilities_describe');
    } finally {
      output.restore();
    }
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
