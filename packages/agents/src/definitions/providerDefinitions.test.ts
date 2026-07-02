import { describe, expect, it } from 'vitest';

import { AGENT_PROVIDER_IDS } from '../types.js';
import { CANONICAL_AGENT_MODEL_CONFIG } from '../models.js';
import { CANONICAL_AGENT_LOCAL_CLI_CONFIG } from '../localCli.js';
import { CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS, CANONICAL_AGENT_SESSION_MODES } from '../sessionModes.js';
import { getProviderSettingsDefinition } from '../providerSettings/index.js';
import { CANONICAL_AGENTS_CORE } from '../manifest.js';
import {
  getAllProviderDefinitions,
  getAllProviderDefinitionContracts,
  getProviderDefinition,
  getProviderDefinitionContract,
} from './providerDefinitions.js';

describe('providerDefinitions', () => {
  it('assembles one provider definition for every canonical provider id', () => {
    expect(getAllProviderDefinitions().map((definition) => definition.id).sort()).toEqual(
      [...AGENT_PROVIDER_IDS].sort(),
    );
  });

  it('derives provider definitions from the existing canonical agent surfaces', () => {
    const claude = getProviderDefinition('claude');
    expect(claude).not.toBeNull();
    expect(claude?.core).toBe(CANONICAL_AGENTS_CORE.claude);
    expect(claude?.sessionModeDescriptor).toBe(CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS.claude);
    expect(claude?.sessionModesKind).toBe(CANONICAL_AGENT_SESSION_MODES.claude);
    expect(claude?.modelConfig).toBe(CANONICAL_AGENT_MODEL_CONFIG.claude);
    expect(claude?.localCli).toBe(CANONICAL_AGENT_LOCAL_CLI_CONFIG.claude);
    expect(claude?.agentCliRuntime.id).toBe('claude');
    expect(claude?.providerSettings).toBe(getProviderSettingsDefinition('claude'));
  });

  it('derives normalized provider definition contracts from canonical agent metadata', () => {
    expect(getAllProviderDefinitionContracts().map((definition) => definition.id).sort()).toEqual(
      [...AGENT_PROVIDER_IDS].sort(),
    );

    const customAcp = getProviderDefinitionContract('customAcp');
    expect(customAcp).toBeNull();

    const claude = getProviderDefinitionContract('claude');
    expect(claude).toEqual(
      expect.objectContaining({
        kindVersion: 1,
        id: 'claude',
        ownedBackendIds: ['claude'],
      }),
    );
  });

  it('keeps customAcp out of canonical provider definitions', () => {
    expect(getProviderDefinition('customAcp')).toBeNull();
  });
});
