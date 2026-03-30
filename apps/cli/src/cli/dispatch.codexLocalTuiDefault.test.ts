import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '@/cli/commandRegistry';

import { dispatchCli } from './dispatch';

describe('dispatchCli (codex local TUI default)', () => {
  const codexHandlerSpy = vi.fn(async () => {});
  let prevEnv: string | undefined;
  let prevInTty: boolean | undefined;
  let prevOutTty: boolean | undefined;
  let prevCodexHandler: unknown;

  beforeEach(() => {
    prevEnv = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    prevInTty = process.stdin.isTTY;
    prevOutTty = process.stdout.isTTY;
    prevCodexHandler = (commandRegistry as any).codex as unknown;
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

  it('does not disable daemon autostart when `--started-by=daemon` is used', async () => {
    await dispatchCli({
      args: ['codex', '--started-by=daemon'],
      rawArgv: ['happier', 'codex', '--started-by=daemon'],
      terminalRuntime: null,
    });

    expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).not.toBe('0');
    expect(codexHandlerSpy).toHaveBeenCalled();
  });

  it('does not disable daemon autostart when `--started-by` is malformed', async () => {
    await dispatchCli({
      args: ['codex', '--started-by'],
      rawArgv: ['happier', 'codex', '--started-by'],
      terminalRuntime: null,
    });

    expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).not.toBe('0');
    expect(codexHandlerSpy).toHaveBeenCalled();
  });
});
