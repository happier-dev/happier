import { normalizeCodexBackendMode, type CodexBackendMode } from '../providerSettings/definitions/codex.js';
import { readSessionMetadataRuntimeDescriptor } from './agentRuntimeDescriptor.js';

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
  backendMode: CodexBackendMode;
}>;

export type CodexSpawnRuntimeAffinityCompatFields = Readonly<{
  experimentalCodexAcp?: true;
  codexBackendMode?: CodexBackendMode;
}>;

function readCodexRuntimeDescriptorV1BackendMode(value: unknown): CodexBackendMode | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1) return null;
  return normalizeCodexBackendMode(descriptor.backendMode);
}

export function resolvePersistedCodexRuntimeIdentity(metadata: unknown): PersistedCodexRuntimeIdentity | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const genericDescriptor = readSessionMetadataRuntimeDescriptor(metadataRecord, 'codex');
  const genericMode = genericDescriptor?.backendMode ?? null;
  if (genericMode) {
    return { backendMode: genericMode };
  }

  const descriptorMode = readCodexRuntimeDescriptorV1BackendMode(metadataRecord.codexRuntimeDescriptorV1);
  if (descriptorMode) {
    return { backendMode: descriptorMode };
  }

  const affinityMode = normalizeCodexBackendMode(asRecord(metadataRecord.affinity)?.backendMode);
  if (affinityMode) {
    return { backendMode: affinityMode };
  }

  const persistedMode = normalizeCodexBackendMode(metadataRecord.codexBackendMode);
  if (persistedMode) {
    return { backendMode: persistedMode };
  }

  const directSession = asRecord(metadataRecord.directSessionV1);
  const nestedMode = normalizeCodexBackendMode(directSession?.codexBackendMode);
  if (nestedMode) {
    return { backendMode: nestedMode };
  }

  const codexSessionId = typeof metadataRecord.codexSessionId === 'string' ? metadataRecord.codexSessionId.trim() : '';
  if (codexSessionId && hasGenericCodexState(metadataRecord)) {
    return { backendMode: 'appServer' };
  }

  return null;
}

export function resolvePersistedCodexVendorSessionId(metadata: unknown): string | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const genericDescriptor = readSessionMetadataRuntimeDescriptor(metadataRecord, 'codex');
  const genericVendorSessionId = genericDescriptor?.vendorSessionId ?? '';
  if (genericVendorSessionId) {
    return genericVendorSessionId;
  }

  const legacyVendorSessionId = typeof metadataRecord.codexSessionId === 'string' ? metadataRecord.codexSessionId.trim() : '';
  return legacyVendorSessionId || null;
}

export function buildCodexSpawnRuntimeAffinityCompatFields(
  runtimeIdentity: PersistedCodexRuntimeIdentity | null,
): CodexSpawnRuntimeAffinityCompatFields {
  const backendMode = runtimeIdentity?.backendMode ?? null;
  if (!backendMode) {
    return {};
  }

  return {
    codexBackendMode: backendMode,
  };
}
