import type { z } from 'zod';

import type { ProviderSettingsDefinition, ProviderSettingsShape } from '../types.js';

export type CodexBackendMode = 'mcp' | 'acp';

export const CODEX_PROVIDER_SETTINGS_DEFAULTS = Object.freeze({
  codexBackendMode: 'acp' satisfies CodexBackendMode,
  codexAcpInstallSpec: '',
});

export function buildCodexProviderSettingsShape(zod: typeof z): ProviderSettingsShape {
  return {
    // Back-compat: `mcp_resume` was a legacy fork that has been removed. Treat it as ACP.
    codexBackendMode: zod
      .enum(['mcp', 'mcp_resume', 'acp'])
      .transform((value): CodexBackendMode => (value === 'mcp' ? 'mcp' : 'acp')),
    codexAcpInstallSpec: zod.string(),
  } as const;
}

export function resolveCodexSpawnExtrasFromSettings(settings: Readonly<Record<string, unknown>>): Readonly<{
  experimentalCodexAcp?: boolean;
}> {
  const mode = settings.codexBackendMode;
  if (mode === 'mcp_resume' || mode === 'acp') return { experimentalCodexAcp: true };
  return { experimentalCodexAcp: false };
}

export const CODEX_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'codex',
  buildSettingsShape: buildCodexProviderSettingsShape,
  settingsDefaults: CODEX_PROVIDER_SETTINGS_DEFAULTS,
  buildOutgoingMessageMetaExtras: () => ({}),
  resolveSpawnExtras: ({ settings }) => resolveCodexSpawnExtrasFromSettings(settings),
});
