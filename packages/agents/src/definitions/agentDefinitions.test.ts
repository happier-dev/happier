import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from '../types.js';
import { CANONICAL_AGENT_MODEL_CONFIG } from '../models.js';
import { CANONICAL_AGENT_LOCAL_CLI_CONFIG } from '../localCli.js';
import { CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS, CANONICAL_AGENT_SESSION_MODES } from '../sessionModes.js';
import { CANONICAL_AGENTS_CORE } from '../manifest.js';
import {
  getAllAgentCatalogDefinitions,
  getAllAgentDefinitionContracts,
  getAgentCatalogDefinition,
  getAgentDefinitionContract,
} from './agentDefinitions.js';

describe('providerDefinitions', () => {
  it('assembles one provider definition for every canonical provider id', () => {
    expect(getAllAgentCatalogDefinitions().map((definition) => definition.id).sort()).toEqual(
      [...AGENT_IDS].sort(),
    );
  });

  it('derives provider definitions from the existing canonical agent surfaces', () => {
    const claude = getAgentCatalogDefinition('claude');
    expect(claude).not.toBeNull();
    expect(claude?.settingsBackendId).toBeNull();
    expect(claude?.core).toBe(CANONICAL_AGENTS_CORE.claude);
    expect(claude?.sessionModeDescriptor).toBe(CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS.claude);
    expect(claude?.sessionModesKind).toBe(CANONICAL_AGENT_SESSION_MODES.claude);
    expect(claude?.modelConfig).toBe(CANONICAL_AGENT_MODEL_CONFIG.claude);
    expect(claude?.localCli).toBe(CANONICAL_AGENT_LOCAL_CLI_CONFIG.claude);
    expect(claude).not.toHaveProperty('agentCliRuntime');
    expect(claude).not.toHaveProperty('agentSettings');
  });

  it('surfaces the canonical settings backend id for Antigravity', () => {
    const antigravity = getAgentCatalogDefinition('antigravity');
    expect(antigravity).not.toBeNull();
    expect(antigravity?.settingsBackendId).toBe('antigravity');
  });

  it('derives normalized provider definition contracts from canonical agent metadata', () => {
    expect(getAllAgentDefinitionContracts().map((definition) => definition.id).sort()).toEqual(
      [...AGENT_IDS].sort(),
    );

    const customAcp = getAgentDefinitionContract('customAcp');
    expect(customAcp).toBeNull();

    const claude = getAgentDefinitionContract('claude');
    expect(claude).toEqual(
      expect.objectContaining({
        kindVersion: 1,
        id: 'claude',
        ownedBackendIds: ['claude'],
      }),
    );
  });

  it('keeps customAcp out of canonical provider definitions', () => {
    expect(getAgentCatalogDefinition('customAcp')).toBeNull();
  });
});
