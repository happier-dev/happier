import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

import { resolveHeadlessTmuxAgentLaunchConfig } from './resolveHeadlessTmuxAgentLaunchConfig';

describe('headless tmux Agent launch configuration', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        claude: {
          id: 'claude',
          cliSubcommand: 'claude',
        },
        'acme.agent': {
          id: 'acme.agent',
          cliSubcommand: 'acme-agent',
          getHeadlessTmuxArgvTransform: async () => (argv: string[]) => [
            '--from-acme-agent',
            ...argv,
          ],
        },
      },
    });
  });

  it('resolves an installed external Agent through its current CLI subcommand', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig(['acme-agent', '--resume', 'session-1']))
      .resolves.toEqual({
        agent: 'acme.agent',
        childArgs: ['--from-acme-agent', 'acme-agent', '--resume', 'session-1'],
      });
  });

  it('keeps the default only for an invocation with no Agent command', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig([])).resolves.toEqual({
      agent: 'claude',
      childArgs: [],
    });
  });

  it('keeps the default for option-first invocation syntax', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig(['--verbose'])).resolves.toEqual({
      agent: 'claude',
      childArgs: ['--verbose'],
    });
  });

  it('rejects an absent Agent command instead of silently launching Claude', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig(['missing-agent']))
      .rejects.toMatchObject({
        code: 'agent_not_installed',
        agentId: 'missing-agent',
      });
  });
});
