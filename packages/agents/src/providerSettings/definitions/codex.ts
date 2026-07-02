import { z } from 'zod';
import {
  buildSettingArtifacts,
  normalizeCodexBackendMode as normalizeCanonicalCodexBackendMode,
  type CodexBackendMode as CanonicalCodexBackendMode,
  type SettingDefinitionMap,
} from '@happier-dev/protocol';

import type { ProviderSettingsDefinition } from '../types.js';

export type CodexBackendMode = CanonicalCodexBackendMode;
export const normalizeCodexBackendMode = normalizeCanonicalCodexBackendMode;

export const CODEX_PROVIDER_FIELDS = {
  codexBackendMode: {
    // Back-compat: `mcp_resume` was a legacy fork that has been removed. Treat it as ACP.
    schema: z
      .union([
        z.enum(['acp', 'appServer']),
        z.enum(['mcp', 'mcp_resume']),
      ])
      .transform((value): CodexBackendMode => normalizeCodexBackendMode(value) ?? 'acp'),
    default: 'appServer' satisfies CodexBackendMode,
    description: 'Preferred Codex backend mode',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
  },
} as const satisfies SettingDefinitionMap;

const CODEX_PROVIDER_ARTIFACTS = buildSettingArtifacts(CODEX_PROVIDER_FIELDS);

export const CODEX_PROVIDER_SETTINGS_DEFAULTS = Object.freeze(CODEX_PROVIDER_ARTIFACTS.defaults);

export function buildCodexProviderSettingsShape(_zod: typeof z) {
  return CODEX_PROVIDER_ARTIFACTS.shape;
}

export const CODEX_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'codex',
  fields: CODEX_PROVIDER_ARTIFACTS.definitions,
});
