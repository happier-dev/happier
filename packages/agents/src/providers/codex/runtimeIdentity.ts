import { normalizeCodexBackendMode, type CodexBackendMode } from '../../providerSettings/definitions/codex.js';
import {
  readCodexSessionMetadataRuntimeDescriptor,
  readGenericCodexSessionMetadataRuntimeDescriptor,
} from './readSessionMetadataRuntimeDescriptor.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasGenericCodexState(metadata: Record<string, unknown> | null): boolean {
  return [
    'sessionModesV1',
    'sessionModelsV1',
    'sessionConfigOptionsV1',
    'acpSessionModesV1',
    'acpSessionModelsV1',
    'acpConfigOptionsV1',
  ].some((key) => {
    const value = asRecord(metadata?.[key]);
    return value?.provider === 'codex';
  });
}

export type PersistedCodexRuntimeIdentity = Readonly<{
  backendMode: CodexBackendMode | 'mcp';
}>;

export type CodexSpawnRuntimeAffinityCompatFields = Readonly<{
  experimentalCodexAcp?: true;
  codexBackendMode?: CodexBackendMode;
}>;

function normalizeCodexRuntimeControlMode(value: unknown): PersistedCodexRuntimeIdentity['backendMode'] | null {
  if (typeof value === 'string' && value.trim() === 'mcp') return 'mcp';
  return normalizeCodexBackendMode(value);
}

function toCanonicalCodexRuntimeBackendMode(
  value: PersistedCodexRuntimeIdentity['backendMode'] | null | undefined,
): CodexBackendMode | null {
  return value === 'acp' || value === 'appServer' ? value : null;
}

function readCodexRuntimeDescriptorV1BackendMode(value: unknown): PersistedCodexRuntimeIdentity['backendMode'] | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1) return null;
  return normalizeCodexRuntimeControlMode(descriptor.backendMode);
}

function readCodexSessionLinkBackendMode(value: unknown): PersistedCodexRuntimeIdentity['backendMode'] | null {
  const link = asRecord(value);
  if (!link || link.v !== 1 || link.providerId !== 'codex') return null;
  return normalizeCodexRuntimeControlMode(link.codexBackendMode);
}

export function resolvePersistedCodexRuntimeIdentity(metadata: unknown): PersistedCodexRuntimeIdentity | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const genericDescriptor = readGenericCodexSessionMetadataRuntimeDescriptor(metadataRecord);
  const genericMode = genericDescriptor?.backendMode ?? null;
  if (genericMode) {
    return { backendMode: genericMode };
  }

  const descriptorMode = readCodexRuntimeDescriptorV1BackendMode(metadataRecord.codexRuntimeDescriptorV1);
  if (descriptorMode) {
    return { backendMode: descriptorMode };
  }

  const affinityMode = normalizeCodexRuntimeControlMode(asRecord(metadataRecord.affinity)?.backendMode);
  if (affinityMode) {
    return { backendMode: affinityMode };
  }

  const persistedMode = normalizeCodexRuntimeControlMode(metadataRecord.codexBackendMode);
  if (persistedMode) {
    return { backendMode: persistedMode };
  }

  const directSession = asRecord(metadataRecord.directSessionV1);
  const nestedMode = normalizeCodexRuntimeControlMode(directSession?.codexBackendMode);
  if (nestedMode) {
    return { backendMode: nestedMode };
  }

  const externalSessionMode = readCodexSessionLinkBackendMode(metadataRecord.externalSessionV1);
  if (externalSessionMode) {
    return { backendMode: externalSessionMode };
  }

  const codexSessionId = typeof metadataRecord.codexSessionId === 'string' ? metadataRecord.codexSessionId.trim() : '';
  if (codexSessionId && hasGenericCodexState(metadataRecord)) {
    return { backendMode: 'appServer' };
  }

  return null;
}

export function resolvePersistedCodexProviderSessionId(metadata: unknown): string | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const genericDescriptor = readCodexSessionMetadataRuntimeDescriptor(metadataRecord);
  const genericProviderSessionId = genericDescriptor?.providerSessionId ?? '';
  if (genericProviderSessionId) {
    return genericProviderSessionId;
  }

  const legacyProviderSessionId = typeof metadataRecord.codexSessionId === 'string' ? metadataRecord.codexSessionId.trim() : '';
  return legacyProviderSessionId || null;
}

export function buildCodexSpawnRuntimeAffinityCompatFields(
  runtimeIdentity: PersistedCodexRuntimeIdentity | null,
): CodexSpawnRuntimeAffinityCompatFields {
  const backendMode = toCanonicalCodexRuntimeBackendMode(runtimeIdentity?.backendMode);
  return backendMode ? { codexBackendMode: backendMode } : {};
}
