import type { AgentId } from '../types.js';

import { CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION } from './definitions/claudeRemote.js';
import { CODEX_PROVIDER_SETTINGS_DEFINITION } from './definitions/codex.js';
import { OPENCODE_PROVIDER_SETTINGS_DEFINITION } from './definitions/opencode.js';
import type { ProviderSettingsDefinition } from './types.js';

const ALL_DEFINITIONS: readonly ProviderSettingsDefinition[] = Object.freeze([
  CODEX_PROVIDER_SETTINGS_DEFINITION,
  OPENCODE_PROVIDER_SETTINGS_DEFINITION,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION,
]);

export function getAllProviderSettingsDefinitions(): readonly ProviderSettingsDefinition[] {
  return ALL_DEFINITIONS;
}

export function getProviderSettingsDefinition(providerId: AgentId): ProviderSettingsDefinition | null {
  return (ALL_DEFINITIONS.find((d) => d.providerId === providerId) ?? null) as ProviderSettingsDefinition | null;
}

export function assertProviderSettingsRegistryValid(definitions: readonly ProviderSettingsDefinition[] = ALL_DEFINITIONS): void {
  assertProviderSettingsRegistryValidFor(definitions);
}

export function assertProviderSettingsRegistryValidFor(definitions: readonly ProviderSettingsDefinition[]): void {
  const seenProviders = new Set<string>();
  const seenKeys = new Set<string>();

  for (const def of definitions) {
    if (seenProviders.has(def.providerId)) {
      throw new Error(`Duplicate provider settings definition: ${def.providerId}`);
    }
    seenProviders.add(def.providerId);

    for (const key of Object.keys(def.fields)) {
      if (seenKeys.has(key)) {
        throw new Error(`Provider settings key "${key}" is defined more than once across providers`);
      }
      seenKeys.add(key);
    }
  }
}
