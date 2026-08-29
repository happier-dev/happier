import { beforeEach, describe, expect, it, vi } from 'vitest';

const { codexHandlerSpy, resolveMergedContributionRegistryMock, providerHandlerSpy } = vi.hoisted(() => ({
  providerHandlerSpy: vi.fn(async () => {}),
  codexHandlerSpy: vi.fn(async () => {}),
  resolveMergedContributionRegistryMock: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happier-test',
  },
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
}));

import {
  commandRegistry,
  ensureMergedAgentCommandRegistryLoaded,
  findCommandDispatchDescriptor,
  resolveCommandDispatchRegistry,
} from './commandRegistry';

describe('commandRegistry reserved command-surface collisions', () => {
  beforeEach(() => {
    codexHandlerSpy.mockClear();
    providerHandlerSpy.mockClear();
    resolveMergedContributionRegistryMock.mockReset();
    resolveMergedContributionRegistryMock.mockResolvedValue({
      commands: [],
      catalogEntriesById: {
        codex: {
          id: 'codex',
          cliSubcommand: 'codex',
          cliCommandPolicy: { daemonAutostartDefault: 'preferLocalTui' },
          getCliCommandHandler: async () => codexHandlerSpy,
        },
        externalProviderCollision: {
          id: 'externalProviderCollision',
          cliSubcommand: 'provider',
          getCliCommandHandler: async () => providerHandlerSpy,
        },
      },
      agentDefinitionsById: new Map(),
    });
  });

  it('lets catalog-owned provider commands claim static root-help placeholders', async () => {
    await ensureMergedAgentCommandRegistryLoaded();

    const descriptor = findCommandDispatchDescriptor('codex');

    expect(commandRegistry.codex).toBeTypeOf('function');
    expect(descriptor).toMatchObject({
      id: 'codex',
      command: 'codex',
      policy: {
        daemonAutostartDefault: 'preferLocalTui',
      },
    });
    await descriptor?.handler({
      args: ['codex'],
      rawArgv: ['happier', 'codex'],
      terminalRuntime: null,
    });
    expect(codexHandlerSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the singular provider alias owned by the canonical providers namespace', () => {
    expect(commandRegistry.provider).toBe(commandRegistry.providers);
    expect(findCommandDispatchDescriptor('provider')).toMatchObject({ command: 'provider' });
    expect(resolveCommandDispatchRegistry().findByCommand('provider')).toMatchObject({ command: 'provider' });
    expect(providerHandlerSpy).not.toHaveBeenCalled();
  });
});
