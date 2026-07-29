import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from './commandRegistry';

const { pluginsHandlerSpy } = vi.hoisted(() => ({
  pluginsHandlerSpy: vi.fn(async (_context: CommandContext) => {}),
}));

vi.mock('@/cli/commandRegistry', () => ({
  commandRegistry: {
    plugins: pluginsHandlerSpy,
  },
  ensureMergedAgentCommandRegistryLoaded: vi.fn(async () => {}),
  findCommandDispatchDescriptor: vi.fn((command: string) => {
    if (command !== 'plugins') return null;
    return {
      id: 'plugins',
      command: 'plugins',
      handler: pluginsHandlerSpy,
    };
  }),
  resolvePluginCommandTmuxMode: vi.fn(() => null),
}));

import { dispatchCli } from './dispatch';

describe('dispatchCli plugins dev cancellation', () => {
  beforeEach(() => {
    pluginsHandlerSpy.mockClear();
  });

  it('owns an interrupt signal for the long-running static development command', async () => {
    const sigintListenersBefore = process.listenerCount('SIGINT');
    const sigtermListenersBefore = process.listenerCount('SIGTERM');
    pluginsHandlerSpy.mockImplementationOnce(async (context) => {
      if (!context?.signal || context.signal.aborted) return;
      await new Promise<void>((resolveAbort) => {
        context.signal?.addEventListener('abort', () => resolveAbort(), { once: true });
      });
    });
    let settled = false;
    const command = dispatchCli({
      args: ['plugins', 'dev', '.'],
      rawArgv: ['happier', 'plugins', 'dev', '.'],
      terminalRuntime: null,
    }).then(() => {
      settled = true;
    });

    try {
      await vi.waitFor(() => expect(pluginsHandlerSpy).toHaveBeenCalled());
      await Promise.resolve();
      expect(settled).toBe(false);
      process.emit('SIGINT');
      await expect(command).resolves.toBeUndefined();
      expect(settled).toBe(true);
      expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListenersBefore);
    } finally {
      if (!settled) {
        process.emit('SIGINT');
        await command;
      }
    }
  });
});
