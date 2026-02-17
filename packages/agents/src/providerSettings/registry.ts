import * as zod from 'zod';

import type { AgentId } from '../types.js';

import { CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION } from './definitions/claudeRemote.js';
import { CODEX_PROVIDER_SETTINGS_DEFINITION } from './definitions/codex.js';
import type { ProviderSettingsDefinition } from './types.js';

const ALL_DEFINITIONS: readonly ProviderSettingsDefinition[] = Object.freeze([
  CODEX_PROVIDER_SETTINGS_DEFINITION,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION,
]);

export function getAllProviderSettingsDefinitions(): readonly ProviderSettingsDefinition[] {
  return ALL_DEFINITIONS;
}

export function getProviderSettingsDefinition(providerId: AgentId): ProviderSettingsDefinition | null {
  return (ALL_DEFINITIONS.find((d) => d.providerId === providerId) ?? null) as ProviderSettingsDefinition | null;
}

export function assertProviderSettingsRegistryValid(): void {
  const seenProviders = new Set<string>();
  const seenKeys = new Set<string>();

  for (const def of ALL_DEFINITIONS) {
    if (seenProviders.has(def.providerId)) {
      throw new Error(`Duplicate provider settings definition: ${def.providerId}`);
    }
    seenProviders.add(def.providerId);

    const shape = def.buildSettingsShape(zod);
    const shapeKeys = Object.keys(shape);
    const defaultKeys = Object.keys(def.settingsDefaults);

    for (const key of shapeKeys) {
      if (!Object.prototype.hasOwnProperty.call(def.settingsDefaults, key)) {
        throw new Error(`Provider settings defaults missing key "${key}" for provider "${def.providerId}"`);
      }
      if (seenKeys.has(key)) {
        throw new Error(`Provider settings key "${key}" is defined more than once across providers`);
      }
      seenKeys.add(key);
    }

    for (const key of defaultKeys) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) {
        throw new Error(`Provider settings shape missing key "${key}" for provider "${def.providerId}"`);
      }
    }
  }
}
