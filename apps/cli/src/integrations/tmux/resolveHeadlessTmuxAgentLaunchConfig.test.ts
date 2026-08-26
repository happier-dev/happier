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
        },
      },
    });
  });

  it('applies the host-owned remote-mode policy to an installed external Agent', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig(['acme-agent', '--resume', 'session-1']))
      .resolves.toEqual({
        agent: 'acme.agent',
        childArgs: ['acme-agent', '--resume', 'session-1', '--happy-starting-mode', 'remote'],
      });
  });

  it('keeps the default only for an invocation with no Agent command', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig([])).resolves.toEqual({
      agent: 'claude',
      childArgs: ['--happy-starting-mode', 'remote'],
    });
  });

  it('keeps the default for option-first invocation syntax', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig(['--verbose'])).resolves.toEqual({
      agent: 'claude',
      childArgs: ['--verbose', '--happy-starting-mode', 'remote'],
    });
  });

  it('preserves explicit remote mode and rejects terminal mode at the host launch boundary', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig(['--happy-starting-mode', 'remote'])).resolves.toEqual({
      agent: 'claude',
      childArgs: ['--happy-starting-mode', 'remote'],
    });

    await expect(resolveHeadlessTmuxAgentLaunchConfig(['--happy-starting-mode', 'local']))
      .rejects.toThrow('Headless tmux sessions require remote mode; terminal mode is not supported.');
  });

  it('fails closed for a missing value or any duplicate terminal-mode flag', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig(['acme-agent', '--happy-starting-mode']))
      .rejects.toThrow('Missing value for --happy-starting-mode (expected "remote" or "local" for terminal mode)');

    await expect(resolveHeadlessTmuxAgentLaunchConfig([
      'acme-agent',
      '--happy-starting-mode',
      'remote',
      '--happy-starting-mode',
      'local',
    ])).rejects.toThrow('Headless tmux sessions require remote mode; terminal mode is not supported.');
  });

  it('rejects an absent Agent command instead of silently launching Claude', async () => {
    await expect(resolveHeadlessTmuxAgentLaunchConfig(['missing-agent']))
      .rejects.toMatchObject({
        code: 'agent_not_installed',
        agentId: 'missing-agent',
      });
  });
});
