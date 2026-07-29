import { describe, expect, it, vi } from 'vitest';

const { agentsModuleLoaded, providersModuleLoaded } = vi.hoisted(() => ({
  agentsModuleLoaded: vi.fn(),
  providersModuleLoaded: vi.fn(),
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
  });
});
