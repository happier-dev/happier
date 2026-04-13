import { describe, expect, it } from 'vitest';

import { AGENT_IDS, getAllBackendDefinitionContracts } from '@happier-dev/agents';

import { resolveBuiltInContributions } from './resolveBuiltInContributions';

describe('resolveBuiltInContributions', () => {
  it('assembles built-in providers and backends into separate contribution tables', () => {
    const contributions = resolveBuiltInContributions();
    const backendDefinitionIds = getAllBackendDefinitionContracts().map((entry) => entry.id).slice().sort();

    expect(contributions.providers.map((entry) => entry.id).slice().sort()).toEqual([...AGENT_IDS].slice().sort());
    expect(contributions.backends.map((entry) => entry.id).slice().sort()).toEqual(backendDefinitionIds);

    for (const provider of contributions.providers) {
      expect(provider.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: provider.id,
        }),
      );
      expect(provider.catalogEntry?.id).toBe(provider.id);
      expect(provider.catalogEntry?.cliSubcommand).toBe(provider.id);
    }

    for (const backend of contributions.backends) {
      expect(backend.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: backend.id,
          providerId: backend.providerId,
        }),
      );
    }
  });
});
