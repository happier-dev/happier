import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from '../types.js';
import {
  assertProviderSettingsRegistryValid,
  getAllProviderSettingsDefinitions,
  getProviderSettingsDefinition,
} from './registry.js';

describe('provider settings registry', () => {
  it('covers the canonical provider settings definitions', () => {
    const definitions = getAllProviderSettingsDefinitions();
    expect(definitions.map((definition) => definition.providerId).sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(definitions).toHaveLength(3);
  });

  it('returns a definition for every registered provider', () => {
    for (const providerId of AGENT_IDS) {
      const definition = getProviderSettingsDefinition(providerId);
      if (providerId === 'claude' || providerId === 'codex' || providerId === 'opencode') {
        expect(definition?.providerId).toBe(providerId);
      } else {
        expect(definition).toBeNull();
      }
    }
  });

  it('validates the registry without duplicate keys or mismatched defaults', () => {
    expect(() => assertProviderSettingsRegistryValid()).not.toThrow();
  });
});
