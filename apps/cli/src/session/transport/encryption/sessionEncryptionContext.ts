import { createHmac, hkdfSync } from 'node:crypto';

import {
  openSessionOwnerMetadataEnvelopeV1,
  projectSessionOwnerCompatibilityViewV1,
  SESSION_METADATA_LAYOUT_VERSION_V1,
  serializeSessionInputRequestEqualityIntentV1,
  SessionSharedMetadataV1Schema,
  type PendingRequestedActionV1,
  type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';
import type { Credentials, StoredCredentials } from '../../../persistence';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../../../api/encryption';
import { openSessionDataEncryptionKey } from '../../../api/client/openSessionDataEncryptionKey';
import { tryParseJsonRecord } from '../../../utils/tryParseJsonRecord';
import {
  readSessionMetadataLayoutVersion,
  tryReadSessionMetadataRecordForLayout,
} from '../../metadata/sessionMetadataLayout';

export type SessionEncryptionContext = Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}>;

export type SessionStoredContentEncryptionMode = 'e2ee' | 'plain';
type AccountEncryptionMode = 'e2ee' | 'plain';
export type SessionStoredContentCryptoContext =
  | Readonly<{ mode: 'plain'; ctx: null }>
  | Readonly<{ mode: 'e2ee'; ctx: SessionEncryptionContext }>;

export function resolveSessionStoredContentEncryptionMode(rawSession?: Readonly<{ encryptionMode?: unknown }>): SessionStoredContentEncryptionMode {
  return rawSession?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
}

export function resolveSessionEncryptionContextFromCredentials(
  credentials: Credentials,
  rawSession?: Readonly<{ dataEncryptionKey?: unknown }>,
): SessionEncryptionContext;
export function resolveSessionEncryptionContextFromCredentials(
  credentials: StoredCredentials,
  rawSession?: Readonly<{ dataEncryptionKey?: unknown }>,
): SessionEncryptionContext | null;
export function resolveSessionEncryptionContextFromCredentials(
  credentials: StoredCredentials,
  rawSession?: Readonly<{ dataEncryptionKey?: unknown }>,
): SessionEncryptionContext | null {
  if (!credentials.encryption) return null;
  if (credentials.encryption.type === 'legacy') {
    return { encryptionKey: credentials.encryption.secret, encryptionVariant: 'legacy' };
  }

  const encryptedDekBase64 =
    typeof rawSession?.dataEncryptionKey === 'string' ? String(rawSession.dataEncryptionKey).trim() : '';

  // Prefer the session's published DEK, but allow machineKey fallback for older sessions.
  const opened = openSessionDataEncryptionKey({
    credential: credentials,
    encryptedDataEncryptionKeyBase64: encryptedDekBase64 || null,
  });

  return { encryptionKey: opened ?? credentials.encryption.machineKey, encryptionVariant: 'dataKey' };
}

export function tryDecryptSessionMetadata(params: Readonly<{
  credentials: StoredCredentials;
  rawSession: Readonly<{
    metadata?: unknown;
    metadataLayoutVersion?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
  }>;
}>): Record<string, unknown> | null {
  const encryptedMetadataBase64 =
    typeof params.rawSession.metadata === 'string' ? String(params.rawSession.metadata).trim() : '';
  if (!encryptedMetadataBase64) return null;

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'plain') {
    const metadata = tryParseJsonRecord(encryptedMetadataBase64);
    return metadata
      ? tryReadSessionMetadataRecordForLayout(
          metadata,
          params.rawSession.metadataLayoutVersion,
        )
      : null;
  }

  const { encryptionKey, encryptionVariant } = resolveSessionEncryptionContextFromCredentials(
    params.credentials,
    params.rawSession,
  ) ?? {};
  if (!encryptionKey || !encryptionVariant) return null;

  try {
    const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encryptedMetadataBase64, 'base64'));
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
    return tryReadSessionMetadataRecordForLayout(
      Object.fromEntries(Object.entries(decrypted)),
      params.rawSession.metadataLayoutVersion,
    );
  } catch {
    return null;
  }
}

export function tryDecryptSessionOwnerMetadata(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: 'plain' | 'e2ee';
  rawSession: Readonly<{
    metadataLayoutVersion?: unknown;
    ownerMetadata?: unknown;
  }>;
}>): SessionOwnerMetadataV1 | null {
  if (params.rawSession.metadataLayoutVersion !== 1) return null;
  const material = !params.credentials.encryption
    ? null
    : params.credentials.encryption.type === 'legacy'
      ? {
          type: 'legacy' as const,
          secret: params.credentials.encryption.secret,
        }
      : {
          type: 'dataKey' as const,
          machineKey: params.credentials.encryption.machineKey,
        };
  const opened = openSessionOwnerMetadataEnvelopeV1({
    accountMode: params.accountEncryptionMode,
    envelope: params.rawSession.ownerMetadata,
    material,
  });
  return opened.ok ? opened.ownerMetadata : null;
}

export function tryDecryptSessionOwnerMetadataView(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionMode;
  rawSession: Readonly<{
    metadata?: unknown;
    metadataLayoutVersion?: unknown;
    ownerMetadata?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
  }>;
}>): Record<string, unknown> | null {
  const sharedOrLegacyMetadata = tryDecryptSessionMetadata(params);
  if (!sharedOrLegacyMetadata) return null;

  const metadataLayoutVersion = readSessionMetadataLayoutVersion(
    params.rawSession.metadataLayoutVersion,
  );
  if (metadataLayoutVersion === 0) return sharedOrLegacyMetadata;
  if (metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) return null;

  const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(
    sharedOrLegacyMetadata,
  );
  const ownerMetadata = tryDecryptSessionOwnerMetadata(params);
  if (!sharedMetadata.success || !ownerMetadata) return null;

  return projectSessionOwnerCompatibilityViewV1({
    sharedMetadata: sharedMetadata.data,
    ownerMetadata,
  });
}

export function tryDecryptSessionPresentationMetadataView(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionMode;
  rawSession: Readonly<{
    metadata?: unknown;
    metadataLayoutVersion?: unknown;
    ownerMetadata?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
  }>;
}>): Record<string, unknown> | null {
  return tryDecryptSessionOwnerMetadataView(params)
    ?? tryDecryptSessionMetadata(params);
}

export function encryptStoredSessionPayload(
  params: SessionStoredContentCryptoContext & Readonly<{ payload: unknown }>,
): string {
  if (params.mode === 'plain') {
    return JSON.stringify(params.payload);
  }
  return encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload), 'base64');
}

export function decryptStoredSessionPayload(
  params: SessionStoredContentCryptoContext & Readonly<{ value: string }>,
): unknown {
  const raw = params.value.trim();
  if (params.mode === 'plain') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return decrypt(
    params.ctx.encryptionKey,
    params.ctx.encryptionVariant,
    decodeBase64(raw, 'base64'),
  );
}

export function encryptSessionPayload(params: Readonly<{
  ctx: SessionEncryptionContext;
  payload: unknown;
}>): string {
  const ciphertext = encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload);
  return encodeBase64(ciphertext, 'base64');
}

const SESSION_INPUT_EQUALITY_HKDF_LABEL_V1 = 'happier.session-input-equality.v1';

/**
 * Derives the server-opaque equality fact used only to reconcile an E2EE
 * Session input after its randomized request ciphertext has been replaced.
 * The Session id is HKDF salt so tags cannot be correlated across Sessions.
 */
export function deriveSessionInputEqualityTagV1(params: Readonly<{
  ctx: SessionEncryptionContext;
  sessionId: string;
  requestEnvelope: unknown;
  requestedAction: PendingRequestedActionV1;
}>): string {
  const encoder = new TextEncoder();
  const equalityKey = new Uint8Array(hkdfSync(
    'sha256',
    params.ctx.encryptionKey,
    encoder.encode(params.sessionId),
    encoder.encode(SESSION_INPUT_EQUALITY_HKDF_LABEL_V1),
    32,
  ));
  const canonicalIntent = serializeSessionInputRequestEqualityIntentV1({
    requestEnvelope: params.requestEnvelope,
    requestedAction: params.requestedAction,
  });
  return createHmac('sha256', equalityKey)
    .update(canonicalIntent, 'utf8')
    .digest('base64url');
}

export function decryptSessionPayload(params: Readonly<{
  ctx: SessionEncryptionContext;
  ciphertextBase64: string;
}>): unknown {
  return decrypt(
    params.ctx.encryptionKey,
    params.ctx.encryptionVariant,
    decodeBase64(params.ciphertextBase64, 'base64'),
  );
}
