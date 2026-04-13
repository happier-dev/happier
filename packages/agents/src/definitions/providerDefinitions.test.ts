import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from '../types.js';
import { AGENT_MODEL_CONFIG } from '../models.js';
import { AGENT_LOCAL_CLI_CONFIG } from '../localCli.js';
import { AGENT_SESSION_MODE_DESCRIPTORS, AGENT_SESSION_MODES } from '../sessionModes.js';
import { getProviderSettingsDefinition } from '../providerSettings/index.js';
import { AGENTS_CORE } from '../manifest.js';
import {
  getAllProviderDefinitions,
  getAllProviderDefinitionContracts,
  getProviderDefinition,
  getProviderDefinitionContract,
} from './providerDefinitions.js';

describe('providerDefinitions', () => {
  it('assembles one provider definition for every built-in agent', () => {
    expect(getAllProviderDefinitions().map((definition) => definition.id).sort()).toEqual([...AGENT_IDS].sort());
  });

  it('derives provider definitions from the existing canonical agent surfaces', () => {
    const claude = getProviderDefinition('claude');
    expect(claude).not.toBeNull();
    expect(claude?.core).toBe(AGENTS_CORE.claude);
    expect(claude?.sessionModeDescriptor).toBe(AGENT_SESSION_MODE_DESCRIPTORS.claude);
    expect(claude?.sessionModesKind).toBe(AGENT_SESSION_MODES.claude);
    expect(claude?.modelConfig).toBe(AGENT_MODEL_CONFIG.claude);
    expect(claude?.localCli).toBe(AGENT_LOCAL_CLI_CONFIG.claude);
    expect(claude?.providerCliRuntime.id).toBe('claude');
    expect(claude?.providerSettings).toBe(getProviderSettingsDefinition('claude'));
  });

  it('derives normalized provider definition contracts from canonical agent metadata', () => {
    expect(getAllProviderDefinitionContracts().map((definition) => definition.id).sort()).toEqual([...AGENT_IDS].sort());

    const customAcp = getProviderDefinitionContract('customAcp');
    expect(customAcp).not.toBeNull();
    expect(customAcp).toEqual(
      expect.objectContaining({
        kindVersion: 1,
        id: 'customAcp',
        ownedBackendIds: [],
      }),
    );

    const claude = getProviderDefinitionContract('claude');
    expect(claude).toEqual(
      expect.objectContaining({
        kindVersion: 1,
        id: 'claude',
        ownedBackendIds: ['claude'],
      }),
    );
  });
});
