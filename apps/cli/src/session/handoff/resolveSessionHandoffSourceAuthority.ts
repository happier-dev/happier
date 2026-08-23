import {
  resolveLinkedExternalSessionAuthorityV1,
  type SessionHandoffStorageMode,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

export type SessionHandoffSourceAuthority =
  | Readonly<{
      ok: true;
      sourceMachineId: string;
      sessionStorageMode: SessionHandoffStorageMode;
    }>
  | Readonly<{
      ok: false;
      errorCode:
        | 'machine_not_found'
        | 'session_owner_metadata_unavailable'
        | 'linked_session_invalid'
        | 'linked_session_reconciliation_required';
      error: string;
    }>;

export type ResolveSessionHandoffSourceAuthorityInput = Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: 'e2ee' | 'plain';
  rawSession: Readonly<{
    machineId?: unknown;
    metadata?: unknown;
    metadataLayoutVersion?: unknown;
    ownerMetadata?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
  }>;
  decryptOwnerMetadataView?: typeof tryDecryptSessionOwnerMetadataView;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The single owner of the handoff SOURCE facts every start/prepare request is
 * stamped with: which machine currently holds the Session, and whether its
 * transcript lives with an external Agent (`direct`) or with us (`persisted`).
 *
 * It reads OWNER metadata, never the shared projection. Under the split
 * metadata layout the shared record carries presentation only — an owner-only
 * `externalSessionV1` link is simply not in it — so classifying storage from
 * the shared record reported a genuinely linked Session as `persisted` and the
 * target then imported it into the wrong storage.
 *
 * It also refuses an unresolved link outright. `persisted` must be PROVEN by
 * the metadata; a malformed or dual-row-divergent link is neither `direct` nor
 * `persisted`, and the nullable read it replaced collapsed that third answer
 * into "no link", i.e. straight into `persisted`.
 */
export function resolveSessionHandoffSourceAuthority(
  input: ResolveSessionHandoffSourceAuthorityInput,
): SessionHandoffSourceAuthority {
  const decrypt = input.decryptOwnerMetadataView ?? tryDecryptSessionOwnerMetadataView;
  const ownerMetadata = decrypt({
    credentials: input.credentials,
    rawSession: input.rawSession,
    accountEncryptionMode: input.accountEncryptionMode,
  });
  if (!ownerMetadata) {
    return {
      ok: false,
      errorCode: 'session_owner_metadata_unavailable',
      error: 'session_owner_metadata_unavailable',
    };
  }

  const transcriptAuthority = resolveLinkedExternalSessionAuthorityV1(ownerMetadata);
  if (!transcriptAuthority.ok) {
    return {
      ok: false,
      errorCode: transcriptAuthority.error,
      error: `${transcriptAuthority.error}:${transcriptAuthority.reason}`,
    };
  }

  const sourceMachineId = readNonEmptyString(input.rawSession.machineId)
    ?? readNonEmptyString(ownerMetadata.machineId);
  if (!sourceMachineId) {
    return { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
  }

  return {
    ok: true,
    sourceMachineId,
    sessionStorageMode: transcriptAuthority.transcriptStorage,
  };
}
