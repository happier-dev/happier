import { describe, expect, it, vi } from 'vitest';

import type { CommandContext } from './commandRegistry';

const {
  agentsModuleLoaded,
  providersModuleLoaded,
  sessionCommandContexts,
  sessionModuleLoaded,
} = vi.hoisted(() => ({
  agentsModuleLoaded: vi.fn(),
  providersModuleLoaded: vi.fn(),
  sessionCommandContexts: vi.fn(),
  sessionModuleLoaded: vi.fn(),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => {
  throw new Error('projection registry imported eagerly');
});

vi.mock('./commands/agents', () => {
  agentsModuleLoaded();
  return {
    handleAgentsCliCommand: vi.fn(async () => {}),
  };
});

vi.mock('./commands/providers', () => {
  providersModuleLoaded();
  return {
    handleProvidersMigrationNoticeCliCommand: vi.fn(async () => {}),
  };
});

vi.mock('./commands/session', () => {
  sessionModuleLoaded();
  return {
    handleSessionCliCommand: vi.fn(async (context: CommandContext) => {
      sessionCommandContexts(context.args);
    }),
  };
});

describe('commandRegistry import laziness', () => {
  it('can resolve static command descriptors without importing provider projection or command modules', async () => {
    const { commandRegistry, findCommandDispatchDescriptor } = await import('./commandRegistry');

    expect(commandRegistry.agents).toBeTypeOf('function');
    expect(commandRegistry.providers).toBeTypeOf('function');
    expect(findCommandDispatchDescriptor('session')).toMatchObject({
      id: 'session',
      command: 'session',
      handler: expect.any(Function),
    });
    expect(agentsModuleLoaded).not.toHaveBeenCalled();
    expect(providersModuleLoaded).not.toHaveBeenCalled();
    expect(sessionModuleLoaded).not.toHaveBeenCalled();
  });

  it('exposes Herdr as a first-class terminal host command without eagerly loading it', async () => {
    const { findCommandDispatchDescriptor } = await import('./commandRegistry');
    expect(findCommandDispatchDescriptor('herdr')).toMatchObject({
      id: 'herdr', command: 'herdr', handler: expect.any(Function),
    });
  });

  it('registers dedicated first-class session commands as lazy nested delegations', async () => {
    const { findCommandDispatchDescriptor } = await import('./commandRegistry');
    const firstClassSessionCommands = [
      ['spawn', ['create']],
      // list/ls, send, wait and stop are compiled Action commands, not
      // dedicated session delegations. Their real dispatch is covered by the
      // Action CLI entrypoint and compiler suites.
      ['history', ['history']],
      ['delegate', ['delegate', 'start']],
    ] as const;

    for (const [command, nestedSessionPath] of firstClassSessionCommands) {
      const descriptor = findCommandDispatchDescriptor(command);
      expect(descriptor).toMatchObject({
        id: command,
        command,
        handler: expect.any(Function),
      });
      await descriptor!.handler({
        args: [command, 'argument'],
        rawArgv: ['happier', command, 'argument'],
        terminalRuntime: null,
      });
      expect(sessionCommandContexts).toHaveBeenLastCalledWith([
        'session',
        ...nestedSessionPath,
        'argument',
      ]);
    }

    expect(sessionModuleLoaded).toHaveBeenCalledTimes(1);
  });
});
