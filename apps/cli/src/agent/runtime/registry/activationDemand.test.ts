import { describe, expect, it, vi } from 'vitest';

import {
  activateAgentRuntimeContributionOnDemand,
  activateAllAgentRuntimeContributionsOnDemand,
} from './activationDemand';

function registryWithAgents(agents: readonly Readonly<{
  id: string;
  pluginId?: string;
  identity?: Readonly<{ pluginId: string; localId: string }>;
}>[]) {
  const activationResults = Object.freeze([Object.freeze({
    pluginId: 'happier.oh-my-pi',
    diagnostics: Object.freeze([Object.freeze({
      code: 'plugin_activation_failed',
      message: 'fixture activation failure',
    })]),
  })]);
  const activateContributionsOnDemand = vi.fn(async () => activationResults);
  return {
    registry: {
      contributes: {
        agentDefinitionsById: new Map(agents.map((agent) => [agent.id, agent])),
      },
      activateContributionsOnDemand,
    } as never,
    activateContributionsOnDemand,
    activationResults,
  };
}

describe('Agent runtime activation demand', () => {
  it('uses the manifest-qualified local identity when the global Agent id differs', async () => {
    const fixture = registryWithAgents([{
      id: 'ohMyPi',
      pluginId: 'happier.oh-my-pi',
      identity: { pluginId: 'happier.oh-my-pi', localId: 'ohmypi' },
    }]);

    const result = await activateAgentRuntimeContributionOnDemand(fixture.registry, 'ohMyPi');

    expect(fixture.activateContributionsOnDemand).toHaveBeenCalledWith([{
      pluginId: 'happier.oh-my-pi',
      family: 'agents',
      localId: 'ohmypi',
    }]);
    expect(result).toBe(fixture.activationResults);
  });

  it('batches only qualified plugin-owned Agents in stable order', async () => {
    const fixture = registryWithAgents([
      { id: 'builtin' },
      {
        id: 'zeta',
        pluginId: 'happier.zeta',
        identity: { pluginId: 'happier.zeta', localId: 'zeta-local' },
      },
      {
        id: 'alpha',
        pluginId: 'happier.alpha',
        identity: { pluginId: 'happier.alpha', localId: 'alpha-local' },
      },
    ]);

    const result = await activateAllAgentRuntimeContributionsOnDemand(fixture.registry);

    expect(fixture.activateContributionsOnDemand).toHaveBeenCalledWith([
      { pluginId: 'happier.alpha', family: 'agents', localId: 'alpha-local' },
      { pluginId: 'happier.zeta', family: 'agents', localId: 'zeta-local' },
    ]);
    expect(result).toBe(fixture.activationResults);
  });
});
