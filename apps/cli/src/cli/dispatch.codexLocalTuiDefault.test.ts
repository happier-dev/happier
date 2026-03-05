import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '@/cli/commandRegistry';

import { dispatchCli } from './dispatch';

describe('dispatchCli (codex local TUI default)', () => {
  const prevEnv = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
  const prevInTty = process.stdin.isTTY;
  const prevOutTty = process.stdout.isTTY;
  const prevCodexHandler = (commandRegistry as any).codex as unknown;
  const codexHandlerSpy = vi.fn(async () => {});

  beforeEach(() => {
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    (commandRegistry as any).codex = codexHandlerSpy;
    codexHandlerSpy.mockClear();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    else process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = prevEnv;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevInTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: prevOutTty, configurable: true });
    (commandRegistry as any).codex = prevCodexHandler;
  });

  it('does not force daemon autostart for `happier codex` in a TTY when unset', async () => {
    await dispatchCli({
      args: ['codex'],
      rawArgv: ['happier', 'codex'],
      terminalRuntime: null,
    });

    expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('0');
    expect(codexHandlerSpy).toHaveBeenCalled();
  });
});
