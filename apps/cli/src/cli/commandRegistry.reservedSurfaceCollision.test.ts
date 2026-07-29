import { describe, expect, it, vi } from 'vitest';

const { codexHandlerSpy, primeResolvedContributionRegistryMock, providerHandlerSpy } = vi.hoisted(() => ({
  providerHandlerSpy: vi.fn(async () => {}),
  codexHandlerSpy: vi.fn(async () => {}),
  primeResolvedContributionRegistryMock: vi.fn(async () => {}),
}));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    codex: {
      id: 'codex',
      cliSubcommand: 'codex',
      cliCommandPolicy: {
        daemonAutostartDefault: 'preferLocalTui',
      },
      getCliCommandHandler: async () => codexHandlerSpy,
    },
    externalProviderCollision: {
      id: 'externalProviderCollision',
      cliSubcommand: 'provider',
      getCliCommandHandler: async () => providerHandlerSpy,
    },
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happier-test',
  },
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  primeResolvedContributionRegistry: primeResolvedContributionRegistryMock,
}));

import {
  commandRegistry,
  ensureMergedAgentCommandRegistryLoaded,
  findCommandDispatchDescriptor,
  resolveCommandDispatchRegistry,
} from './commandRegistry';

describe('commandRegistry reserved command-surface collisions', () => {
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

  it('does not let projected provider commands claim reserved command surfaces', () => {
    expect(commandRegistry.provider).toBeUndefined();
    expect(findCommandDispatchDescriptor('provider')).toBeNull();
    expect(resolveCommandDispatchRegistry().findByCommand('provider')).toBeNull();
  });
});
