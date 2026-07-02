import { z } from 'zod';
import { buildSettingArtifacts, type SettingDefinitionMap } from '@happier-dev/protocol';

import type { ProviderSettingsDefinition } from '../types.js';

export type KimiAcpPythonSelector = 'auto' | 'poll';

export function normalizeKimiAcpPythonSelector(raw: unknown): KimiAcpPythonSelector | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === 'auto' || value === 'poll' ? value : null;
}

export function resolveKimiSpawnExtrasFromSettings(settings: Readonly<Record<string, unknown>>): Readonly<{
  kimiAcpPythonSelector?: KimiAcpPythonSelector;
}> {
  const selector = normalizeKimiAcpPythonSelector(settings.kimiAcpPythonSelector);
  return selector === 'poll' ? { kimiAcpPythonSelector: selector } : {};
}

export const KIMI_PROVIDER_FIELDS = {
  kimiAcpPythonSelector: {
    schema: z.enum(['auto', 'poll']),
    default: 'auto' satisfies KimiAcpPythonSelector,
    description: 'Kimi ACP Python stdio selector compatibility mode',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
  },
} as const satisfies SettingDefinitionMap;

const KIMI_PROVIDER_ARTIFACTS = buildSettingArtifacts(KIMI_PROVIDER_FIELDS);

export const KIMI_PROVIDER_SETTINGS_DEFAULTS = Object.freeze(KIMI_PROVIDER_ARTIFACTS.defaults);

export function buildKimiProviderSettingsShape(_zod: typeof z) {
  return KIMI_PROVIDER_ARTIFACTS.shape;
}

export const KIMI_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'kimi',
  fields: KIMI_PROVIDER_ARTIFACTS.definitions,
});
