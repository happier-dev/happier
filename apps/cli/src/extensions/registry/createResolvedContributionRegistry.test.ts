import { describe, expect, it } from 'vitest';

import { AGENT_IDS, getAllBackendDefinitionContracts, getAllProviderDefinitionContracts } from '@happier-dev/agents';

import { getResolvedContributionRegistry } from './createResolvedContributionRegistry';

describe('getResolvedContributionRegistry', () => {
  it('indexes built-in provider, backend, and catalog entries through one resolved registry', () => {
    const registry = getResolvedContributionRegistry();
    const backendDefinitionIds = getAllBackendDefinitionContracts().map((entry) => entry.id).slice().sort();
    const providerDefinitionIds = getAllProviderDefinitionContracts().map((entry) => entry.id).slice().sort();

    expect(Object.keys(registry.catalogEntriesById).slice().sort()).toEqual([...AGENT_IDS].slice().sort());
    expect(registry.providers.map((entry) => entry.definition.id).slice().sort()).toEqual(providerDefinitionIds);

    for (const agentId of AGENT_IDS) {
      expect(registry.providerDefinitionsById.get(agentId)?.id).toBe(agentId);
      expect(registry.providerDefinitionsById.get(agentId)?.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: agentId,
        }),
      );
      expect(registry.catalogEntriesById[agentId]?.id).toBe(agentId);
    }

    for (const backendId of backendDefinitionIds) {
      expect(registry.backendDefinitionsById.get(backendId)?.id).toBe(backendId);
      expect(registry.backendDefinitionsById.get(backendId)?.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: backendId,
          providerId: backendId,
        }),
      );
    }
  });
});
