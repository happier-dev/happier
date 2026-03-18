import type { z } from 'zod';

import type { ProviderSettingsDefinition, ProviderSettingsShape } from '../types.js';

export type CodexBackendMode = 'mcp' | 'acp' | 'appServer';

function normalizeCodexBackendMode(value: unknown): CodexBackendMode | null {
  if (value === 'mcp') return 'mcp';
  if (value === 'appServer') return 'appServer';
  if (value === 'acp' || value === 'mcp_resume') return 'acp';
  return null;
}

export const CODEX_PROVIDER_SETTINGS_DEFAULTS = Object.freeze({
  codexBackendMode: 'acp' satisfies CodexBackendMode,
  codexAcpInstallSpec: '',
});

export function buildCodexProviderSettingsShape(zod: typeof z): ProviderSettingsShape {
  return {
    // Back-compat: `mcp_resume` was a legacy fork that has been removed. Treat it as ACP.
    codexBackendMode: zod
      .enum(['mcp', 'mcp_resume', 'acp', 'appServer'])
      .transform((value): CodexBackendMode => {
        if (value === 'mcp') return 'mcp';
        if (value === 'appServer') return 'appServer';
        return 'acp';
      }),
    codexAcpInstallSpec: zod.string(),
  } as const;
}

export function resolveCodexRuntimeBackendMode(params: Readonly<{
  codexBackendMode?: unknown;
  experimentalCodexAcp?: boolean;
  defaultBackendMode?: CodexBackendMode | null;
}>): CodexBackendMode | null {
  const explicitMode = normalizeCodexBackendMode(params.codexBackendMode);
  if (explicitMode) return explicitMode;
  if (params.experimentalCodexAcp === true) return 'acp';
  return normalizeCodexBackendMode(params.defaultBackendMode);
}

export function resolveCodexSpawnExtrasFromSettings(settings: Readonly<Record<string, unknown>>): Readonly<{
  codexBackendMode?: CodexBackendMode;
  experimentalCodexAcp?: boolean;
}> {
  const mode = resolveCodexRuntimeBackendMode({ codexBackendMode: settings.codexBackendMode });
  if (!mode) return {};
  if (mode === 'acp') {
    return {
      codexBackendMode: 'acp',
      experimentalCodexAcp: true,
    };
  }
  return { codexBackendMode: mode };
}

export function isCodexVendorResumeBackendEnabled(settings: Readonly<Record<string, unknown>>): boolean {
  const mode = resolveCodexRuntimeBackendMode({
    codexBackendMode: settings.codexBackendMode,
    experimentalCodexAcp: settings.experimentalCodexAcp === true,
  });
  return mode === 'acp' || mode === 'appServer';
}

export const CODEX_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'codex',
  buildSettingsShape: buildCodexProviderSettingsShape,
  settingsDefaults: CODEX_PROVIDER_SETTINGS_DEFAULTS,
  buildOutgoingMessageMetaExtras: () => ({}),
  resolveSpawnExtras: ({ settings }) => resolveCodexSpawnExtrasFromSettings(settings),
});
