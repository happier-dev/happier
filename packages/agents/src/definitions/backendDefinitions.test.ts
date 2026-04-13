import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '../manifest.js';
import { getProviderDefinition } from './providerDefinitions.js';
import { BACKEND_DEFINITION_AGENT_IDS } from './buildBackendArtifacts.js';
import {
  getAllBackendDefinitionContracts,
  getAllBackendDefinitions,
  getBackendDefinition,
  getBackendDefinitionContract,
} from './backendDefinitions.js';

describe('backendDefinitions', () => {
  it('assembles one backend definition for every concrete built-in backend id', () => {
    expect(getAllBackendDefinitions().map((definition) => definition.id).sort()).toEqual([...BACKEND_DEFINITION_AGENT_IDS].sort());
  });

  it('marks customAcp as compatibility-only in the canonical agent metadata', () => {
    expect(AGENTS_CORE.customAcp.backendDefinition).toBe(false);
  });

  it('does not expose customAcp as a concrete backend definition id', () => {
    expect(getBackendDefinition('customAcp')).toBeNull();
  });

  it('derives backend definitions from the existing declarative runtime surfaces', () => {
    const codex = getBackendDefinition('codex');
    expect(codex).not.toBeNull();
    expect(codex?.providerId).toBe('codex');
    expect(codex?.provider).toBe(getProviderDefinition('codex'));
    expect(codex?.provider.core).toBe(AGENTS_CORE.codex);
    expect(codex?.runtimeKinds).toBe(AGENTS_CORE.codex.runtimeKinds ?? null);
  });

  it('derives normalized backend definition contracts from canonical agent metadata', () => {
    expect(getAllBackendDefinitionContracts().map((definition) => definition.id).sort()).toEqual([...BACKEND_DEFINITION_AGENT_IDS].sort());

    const customAcp = getBackendDefinitionContract('customAcp');
    expect(customAcp).toBeNull();

    const codex = getBackendDefinitionContract('codex');
    expect(codex).toEqual(
      expect.objectContaining({
        kindVersion: 1,
        id: 'codex',
        providerId: 'codex',
      }),
    );
  });
});
