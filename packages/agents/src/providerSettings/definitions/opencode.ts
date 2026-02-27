import type { z } from 'zod';

import type { ProviderSettingsDefinition, ProviderSettingsShape } from '../types.js';

export type OpenCodeBackendMode = 'server' | 'acp';

export const OPENCODE_PROVIDER_SETTINGS_DEFAULTS = Object.freeze({
  opencodeBackendMode: 'server' satisfies OpenCodeBackendMode,
});

export function buildOpenCodeProviderSettingsShape(zod: typeof z): ProviderSettingsShape {
  return {
    opencodeBackendMode: zod.enum(['server', 'acp']),
  } as const;
}

export const OPENCODE_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'opencode',
  buildSettingsShape: buildOpenCodeProviderSettingsShape,
  settingsDefaults: OPENCODE_PROVIDER_SETTINGS_DEFAULTS,
  buildOutgoingMessageMetaExtras: () => ({}),
});

