import {
  decryptStoredSessionPayload,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { normalizeSessionMetadataForRead } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { readSessionMetadataLayoutVersion } from '@/session/metadata/sessionMetadataLayout';

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

/** Opens released layout-0 snapshots; layout-1 owner facts require the Account reader. */
export function readSessionLegacyMetadata(
  params: Readonly<{
    rawSession?: Readonly<{ metadata?: unknown; metadataLayoutVersion?: unknown }> | null;
  }> & SessionStoredContentCryptoContext,
): Record<string, unknown> | null {
  if (readSessionMetadataLayoutVersion(params.rawSession?.metadataLayoutVersion) !== 0) return null;
  try {
    return normalizeSessionMetadataForRead(readStoredSessionRecord({
      ...params,
      rawValue: params.rawSession?.metadata,
    }));
  } catch {
    return null;
  }
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
