import {
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  LEGACY_ACP_SESSION_MODES_STATE_KEY,
  SESSION_MODELS_STATE_KEY,
  SESSION_MODES_STATE_KEY,
  readMetadataAliasValue,
} from '@happier-dev/agents';

import {
  decryptStoredSessionPayload,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';

export function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function readStoredSessionRecord(
  params: Readonly<{ rawValue: unknown }> & SessionStoredContentCryptoContext,
): Record<string, unknown> | null {
  const raw = params.rawValue;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }

  try {
    const decrypted = decryptStoredSessionPayload({
      ...params,
      value: raw,
    });
    return decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)
      ? decrypted as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function readSessionMetadata(
  params: Readonly<{
    rawSession?: Readonly<{ metadata?: unknown }> | null;
  }> & SessionStoredContentCryptoContext,
): Record<string, unknown> | null {
  return readStoredSessionRecord({
    ...params,
    rawValue: params.rawSession?.metadata,
  });
}

export function readSessionAgentState(
  params: Readonly<{
    rawSession?: Readonly<{ agentState?: unknown }> | null;
  }> & SessionStoredContentCryptoContext,
): Record<string, unknown> | null {
  return readStoredSessionRecord({
    ...params,
    rawValue: params.rawSession?.agentState,
  });
}

export function readSessionModesState(metadata: Record<string, unknown> | null): Readonly<{
  provider?: string;
  availableModes?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
}> | null {
  if (!metadata) return null;
  return readMetadataAliasValue(
    metadata,
    SESSION_MODES_STATE_KEY,
    LEGACY_ACP_SESSION_MODES_STATE_KEY,
  ) as Readonly<{
    provider?: string;
    availableModes?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
  }> | null;
}

export function readSessionModelsState(metadata: Record<string, unknown> | null): Readonly<{
  provider?: string;
  availableModels?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
}> | null {
  if (!metadata) return null;
  return readMetadataAliasValue(
    metadata,
    SESSION_MODELS_STATE_KEY,
    LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  ) as Readonly<{
    provider?: string;
    availableModels?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
  }> | null;
}
