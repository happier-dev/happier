import { describe, expect, it } from 'vitest';

import {
  AGENT_IDS,
  CANONICAL_AGENT_IDS,
  getAllBackendDefinitionContracts,
  getAllProviderDefinitionContracts,
} from '@happier-dev/agents';

import { resolveBuiltInContributions } from './resolveBuiltInContributions';

describe('resolveBuiltInContributions', () => {
  it('assembles built-in providers and backends into separate contribution tables', () => {
    const contributions = resolveBuiltInContributions();
    const backendDefinitionIds = getAllBackendDefinitionContracts().map((entry) => entry.id).slice().sort();
    const providerDefinitionIds = getAllProviderDefinitionContracts().map((entry) => entry.id).slice().sort();

    expect(contributions.providers.map((entry) => entry.id).slice().sort()).toEqual(providerDefinitionIds);
    expect(contributions.backends.map((entry) => entry.id).slice().sort()).toEqual(backendDefinitionIds);
    expect((contributions.catalogEntries ?? []).map((entry) => entry.id)).toEqual([]);
    expect(contributions.providers.map((entry) => entry.id).slice().sort()).toEqual([...CANONICAL_AGENT_IDS].slice().sort());
    expect(contributions.providers.map((entry) => entry.id).slice().sort()).toEqual([...AGENT_IDS].slice().sort());

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

    expect(contributions.activationTargets).toEqual([
      expect.objectContaining({
        pluginId: 'opencode',
        daemonEntryPath: '@happier-dev/extensions-opencode',
      }),
    ]);
  });

  it('publishes a runtime kind for every built-in backend contribution', () => {
    const contributions = resolveBuiltInContributions();

    expect(contributions.backends.map((backend) => [backend.id, backend.runtimeKind]).sort()).toEqual([
      ['auggie', 'native'],
      ['claude', 'native'],
      ['codex', 'appServer'],
      ['copilot', 'native'],
      ['gemini', 'native'],
      ['kilo', 'native'],
      ['kimi', 'native'],
      ['kiro', 'native'],
      ['ohMyPi', 'native'],
      ['opencode', 'server'],
      ['pi', 'native'],
      ['qwen', 'native'],
    ]);
  });

  it('projects built-in backend bindings through the canonical getBindings seam only', () => {
    const contributions = resolveBuiltInContributions();
    const codex = contributions.backends.find((backend) => backend.id === 'codex');

    expect(codex?.getBindings).toEqual(expect.any(Function));
    expect(codex).not.toHaveProperty('getRuntimeCore');
  });
});
