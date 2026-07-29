import { describe, expect, it, vi } from 'vitest';

import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const { dynamicAgentsHandler, resolveMergedContributionRegistryMock, staticAgentsHandler } = vi.hoisted(() => ({
  dynamicAgentsHandler: vi.fn(async () => {}),
  staticAgentsHandler: vi.fn(async () => {}),
  resolveMergedContributionRegistryMock: vi.fn(async () => ({
    agents: [],
    backends: [],
    runtimeAdaptersByBackendId: new Map(),
    catalogEntriesById: {},
    agentDefinitionsById: new Map(),
    backendDefinitionsById: new Map(),
    pluginDiagnosticsByPluginId: {},
  })),
}));

vi.mock('./commands/agents', () => ({
  handleAgentsCliCommand: staticAgentsHandler,
}));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    collidingAgent: {
      id: 'collidingAgent',
      cliSubcommand: 'agents',
      getCliCommandHandler: async () => dynamicAgentsHandler,
    },
  },
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
  };
});

import { commandRegistry } from './commandRegistry';

describe('commandRegistry static command collisions', () => {
  it('does not let projected agent subcommands replace static CLI namespaces', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await commandRegistry.agents({
        args: ['agents', '--help'],
        rawArgv: ['happier', 'agents', '--help'],
        terminalRuntime: null,
      });
    } finally {
      output.restore();
    }

    expect(staticAgentsHandler).toHaveBeenCalledOnce();
    expect(dynamicAgentsHandler).not.toHaveBeenCalled();
  });
});
