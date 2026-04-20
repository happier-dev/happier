import type { CodexBackendMode } from './backendMode.js';
import { normalizeCodexBackendMode } from './backendMode.js';
import { readCodexRuntimeHandleCompatCarrier } from './runtimeDescriptorCompat.js';

type CodexRuntimeDescriptorProviderExtra = Readonly<{
  owner: 'codex';
  schemaId: 'codex.agentRuntimeDescriptorExtra';
  v: 1;
  runtimeHandle?: Readonly<{
    backendMode?: CodexBackendMode;
    vendorSessionId?: string;
    homePath?: string;
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
  }>;
}>;

type CodexAgentRuntimeDescriptorProvider = Readonly<{
  backendMode: CodexBackendMode;
  vendorSessionId?: string;
  homePath?: string;
  home?: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  providerExtra?: CodexRuntimeDescriptorProviderExtra;
}>;

export type CodexAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  providerId: 'codex';
  provider: CodexAgentRuntimeDescriptorProvider;
} & Record<string, unknown>>;

export type CanonicalCodexAgentRuntimeDescriptorV1 = Readonly<{
  providerId: 'codex';
  backendMode: CodexBackendMode | null;
  vendorSessionId: string | null;
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCodexHome(value: unknown): CanonicalCodexAgentRuntimeDescriptorV1['home'] {
  return value === 'user' || value === 'connectedService' ? value : null;
}

function buildCodexRuntimeHandleProviderExtra(params: Readonly<{
  backendMode: 'mcp' | 'acp' | 'appServer';
  vendorSessionId?: string | null;
  home?: 'user' | 'connectedService' | null;
  connectedServiceId?: string | null;
  connectedServiceProfileId?: string | null;
  homePath?: string | null;
}>): CodexRuntimeDescriptorProviderExtra {
  return {
    owner: 'codex',
    schemaId: 'codex.agentRuntimeDescriptorExtra',
    v: 1,
    runtimeHandle: {
      backendMode: params.backendMode,
      ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
      ...(params.homePath ? { homePath: params.homePath } : {}),
      ...(params.home ? { home: params.home } : {}),
      ...(params.home === 'connectedService' && params.connectedServiceId
        ? { connectedServiceId: params.connectedServiceId }
        : {}),
      ...(params.home === 'connectedService' && params.connectedServiceProfileId
        ? { connectedServiceProfileId: params.connectedServiceProfileId }
        : {}),
    },
  };
}

function readCanonicalCodexProviderExtra(value: unknown) {
  const runtimeHandle = readCodexRuntimeHandleCompatCarrier(value);
  if (!runtimeHandle) return null;

  const home = normalizeCodexHome(runtimeHandle.home);
  return {
    backendMode: normalizeCodexBackendMode(runtimeHandle.backendMode),
    vendorSessionId: normalizeTrimmedString(runtimeHandle.vendorSessionId),
    home,
    connectedServiceId: home === 'connectedService' ? normalizeTrimmedString(runtimeHandle.connectedServiceId) : null,
    connectedServiceProfileId: home === 'connectedService'
      ? normalizeTrimmedString(runtimeHandle.connectedServiceProfileId)
      : null,
    homePath: normalizeTrimmedString(runtimeHandle.homePath),
  };
}

export function buildCodexAgentRuntimeDescriptorV1(params: Readonly<{
  backendMode: 'mcp' | 'acp' | 'appServer';
  vendorSessionId?: string | null;
  home?: 'user' | 'connectedService' | null;
  connectedServiceId?: string | null;
  connectedServiceProfileId?: string | null;
  homePath?: string | null;
}>): CodexAgentRuntimeDescriptorV1 {
  return {
    v: 1,
    providerId: 'codex',
    provider: {
      backendMode: params.backendMode,
      ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
      ...(params.homePath ? { homePath: params.homePath } : {}),
      ...(params.home ? { home: params.home } : {}),
      ...(params.home === 'connectedService' && params.connectedServiceId
        ? { connectedServiceId: params.connectedServiceId }
        : {}),
      ...(params.home === 'connectedService' && params.connectedServiceProfileId
        ? { connectedServiceProfileId: params.connectedServiceProfileId }
        : {}),
      providerExtra: buildCodexRuntimeHandleProviderExtra(params),
    },
  };
}

export function readCanonicalCodexAgentRuntimeDescriptorV1(
  descriptor: CodexAgentRuntimeDescriptorV1 | null,
): CanonicalCodexAgentRuntimeDescriptorV1 | null {
  if (!descriptor) return null;
  const providerExtra = readCanonicalCodexProviderExtra(descriptor.provider.providerExtra);
  const home = providerExtra?.home ?? normalizeCodexHome(descriptor.provider.home);
  return {
    providerId: 'codex',
    backendMode: providerExtra?.backendMode ?? normalizeCodexBackendMode(descriptor.provider.backendMode),
    vendorSessionId: providerExtra?.vendorSessionId ?? normalizeTrimmedString(descriptor.provider.vendorSessionId),
    home,
    connectedServiceId: providerExtra?.connectedServiceId
      ?? (home === 'connectedService' ? normalizeTrimmedString(descriptor.provider.connectedServiceId) : null),
    connectedServiceProfileId: providerExtra?.connectedServiceProfileId
      ?? (home === 'connectedService' ? normalizeTrimmedString(descriptor.provider.connectedServiceProfileId) : null),
    homePath: providerExtra?.homePath ?? normalizeTrimmedString(descriptor.provider.homePath),
  };
}
