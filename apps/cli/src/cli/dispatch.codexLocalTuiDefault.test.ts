import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/cli/commandRegistry';

const { codexHandlerSpy, findCommandDispatchDescriptorSpy } = vi.hoisted(() => {
  const handler = vi.fn(async (_context: CommandContext) => {});
  return {
    codexHandlerSpy: handler,
    findCommandDispatchDescriptorSpy: vi.fn((command: string) => {
      if (command !== 'codex') return null;
      return {
        id: 'codex',
        command: 'codex',
        handler,
        policy: {
          daemonAutostartDefault: 'preferLocalTui' as const,
        },
      };
    }),
  };
});

vi.mock('@/cli/commandRegistry', () => ({
  commandRegistry: {
    codex: codexHandlerSpy,
  },
  ensureMergedAgentCommandRegistryLoaded: vi.fn(async () => {}),
  findCommandDispatchDescriptor: findCommandDispatchDescriptorSpy,
  resolvePluginCommandTmuxMode: vi.fn(() => null),
}));

import { dispatchCli } from './dispatch';

describe('dispatchCli (codex local TUI default)', () => {
  let prevEnv: string | undefined;
  let prevInTty: boolean | undefined;
  let prevOutTty: boolean | undefined;

  beforeEach(() => {
    prevEnv = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    prevInTty = process.stdin.isTTY;
    prevOutTty = process.stdout.isTTY;
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    codexHandlerSpy.mockClear();
    findCommandDispatchDescriptorSpy.mockClear();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    else process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = prevEnv;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevInTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: prevOutTty, configurable: true });
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

  it('projects daemon-spawned explicit environment values and unsets into command scope', async () => {
    const keys = [
      'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'UNMARKED_AMBIENT_VALUE',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON = JSON.stringify([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.test/anthropic';
    process.env.ANTHROPIC_API_KEY = 'provider-api-key';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.UNMARKED_AMBIENT_VALUE = 'must-not-be-scoped';

    try {
      await dispatchCli({
        args: ['codex', '--started-by=daemon'],
        rawArgv: ['happier', 'codex', '--started-by=daemon'],
        terminalRuntime: null,
      });

      expect(codexHandlerSpy).toHaveBeenCalledWith(expect.objectContaining({
        scopedEnvironment: {
          env: {
            ANTHROPIC_BASE_URL: 'https://provider.example.test/anthropic',
            ANTHROPIC_API_KEY: 'provider-api-key',
          },
          unsetEnvKeys: ['ANTHROPIC_AUTH_TOKEN'],
        },
      }));
      const context = codexHandlerSpy.mock.calls[0]?.[0];
      expect(context?.scopedEnvironment?.env).not.toHaveProperty('UNMARKED_AMBIENT_VALUE');
      expect(context?.scopedEnvironment?.env).not.toHaveProperty(
        'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON',
      );
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
