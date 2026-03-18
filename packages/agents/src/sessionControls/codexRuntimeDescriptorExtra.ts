import type { CodexBackendMode } from '../providerSettings/definitions/codex.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCodexBackendMode(value: unknown): CodexBackendMode | null {
  if (value === 'mcp' || value === 'acp' || value === 'appServer') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === 'mcp' || trimmed === 'acp' || trimmed === 'appServer' ? trimmed : null;
}

function normalizeCodexHome(value: unknown): 'user' | 'connectedService' | null {
  return value === 'user' || value === 'connectedService' ? value : null;
}

export type CodexRuntimeDescriptorProviderExtraRuntimeAffinity = Readonly<{
  backendMode: CodexBackendMode | null;
  vendorSessionId: string | null;
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
}>;

export type CodexRuntimeDescriptorProviderExtra = Readonly<{
  v: 1;
  runtimeAffinity?: Readonly<{
    backendMode?: CodexBackendMode;
    vendorSessionId?: string;
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    homePath?: string;
  }>;
}>;

export function buildCodexRuntimeDescriptorProviderExtra(
  params: Readonly<{
    backendMode?: CodexBackendMode | null;
    vendorSessionId?: string | null;
    home?: 'user' | 'connectedService' | null;
    connectedServiceId?: string | null;
    connectedServiceProfileId?: string | null;
    homePath?: string | null;
  }>,
): CodexRuntimeDescriptorProviderExtra {
  const backendMode = normalizeCodexBackendMode(params.backendMode);
  const vendorSessionId = normalizeTrimmedString(params.vendorSessionId);
  const home = normalizeCodexHome(params.home);
  const connectedServiceId = home === 'connectedService' ? normalizeTrimmedString(params.connectedServiceId) : null;
  const connectedServiceProfileId = home === 'connectedService'
    ? normalizeTrimmedString(params.connectedServiceProfileId)
    : null;
  const homePath = normalizeTrimmedString(params.homePath);

  return {
    v: 1,
    runtimeAffinity: {
      ...(backendMode ? { backendMode } : {}),
      ...(vendorSessionId ? { vendorSessionId } : {}),
      ...(home ? { home } : {}),
      ...(connectedServiceId ? { connectedServiceId } : {}),
      ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
      ...(homePath ? { homePath } : {}),
    },
  };
}

export function readCodexRuntimeDescriptorProviderExtra(
  value: unknown,
): CodexRuntimeDescriptorProviderExtraRuntimeAffinity | null {
  const extra = asRecord(value);
  if (!extra || extra.v !== 1) return null;

  const runtimeAffinity = asRecord(extra.runtimeAffinity);
  if (!runtimeAffinity) return null;

  const home = normalizeCodexHome(runtimeAffinity.home);
  const normalizedRuntimeAffinity = {
    backendMode: normalizeCodexBackendMode(runtimeAffinity.backendMode),
    vendorSessionId: normalizeTrimmedString(runtimeAffinity.vendorSessionId),
    home,
    connectedServiceId: home === 'connectedService' ? normalizeTrimmedString(runtimeAffinity.connectedServiceId) : null,
    connectedServiceProfileId: home === 'connectedService'
      ? normalizeTrimmedString(runtimeAffinity.connectedServiceProfileId)
      : null,
    homePath: normalizeTrimmedString(runtimeAffinity.homePath),
  } satisfies CodexRuntimeDescriptorProviderExtraRuntimeAffinity;

  if (
    !normalizedRuntimeAffinity.backendMode
    && !normalizedRuntimeAffinity.vendorSessionId
    && !normalizedRuntimeAffinity.home
    && !normalizedRuntimeAffinity.homePath
  ) {
    return null;
  }

  return normalizedRuntimeAffinity;
}
