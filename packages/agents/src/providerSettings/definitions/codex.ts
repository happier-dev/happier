import type { z } from 'zod';

import type { ProviderSettingsDefinition, ProviderSettingsShape } from '../types.js';

export type CodexBackendMode = 'mcp' | 'mcp_resume' | 'acp';

export const CODEX_PROVIDER_SETTINGS_DEFAULTS = Object.freeze({
  codexBackendMode: 'mcp' satisfies CodexBackendMode,
  codexMcpResumeInstallSpec: '',
  codexAcpInstallSpec: '',
});

export function buildCodexProviderSettingsShape(zod: typeof z): ProviderSettingsShape {
  return {
    codexBackendMode: zod.enum(['mcp', 'mcp_resume', 'acp']),
    codexMcpResumeInstallSpec: zod.string(),
    codexAcpInstallSpec: zod.string(),
  } as const;
}

export function resolveCodexSpawnExtrasFromSettings(settings: Readonly<Record<string, unknown>>): Readonly<{
  experimentalCodexResume?: boolean;
  experimentalCodexAcp?: boolean;
}> {
  const mode = settings.codexBackendMode;
  if (mode === 'mcp_resume') return { experimentalCodexResume: true, experimentalCodexAcp: false };
  if (mode === 'acp') return { experimentalCodexResume: false, experimentalCodexAcp: true };
  return { experimentalCodexResume: false, experimentalCodexAcp: false };
}

export const CODEX_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'codex',
  buildSettingsShape: buildCodexProviderSettingsShape,
  settingsDefaults: CODEX_PROVIDER_SETTINGS_DEFAULTS,
  buildOutgoingMessageMetaExtras: () => ({}),
  resolveSpawnExtras: ({ settings }) => resolveCodexSpawnExtrasFromSettings(settings),
});
