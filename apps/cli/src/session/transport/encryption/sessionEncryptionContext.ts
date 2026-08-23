import { createHmac } from 'node:crypto';

import { stringifySerializedJsonValue } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { decodeBase64, decrypt, encodeBase64, encrypt, encryptWithDerivedNonce } from '@/api/encryption';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';

export type SessionEncryptionContext = Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}>;

export type SessionStoredContentEncryptionMode = 'e2ee' | 'plain';

export function resolveSessionStoredContentEncryptionMode(rawSession?: Readonly<{ encryptionMode?: unknown }>): SessionStoredContentEncryptionMode {
  return rawSession?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
}

export function resolveSessionEncryptionContextFromCredentials(
  credentials: Credentials,
  rawSession?: Readonly<{ dataEncryptionKey?: unknown }>,
): SessionEncryptionContext {
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
  credentials: Credentials;
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
}>): Record<string, unknown> | null {
  const encryptedMetadataBase64 =
    typeof params.rawSession.metadata === 'string' ? String(params.rawSession.metadata).trim() : '';
  if (!encryptedMetadataBase64) return null;

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'plain') {
    return tryParseJsonRecord(encryptedMetadataBase64);
  }

  const { encryptionKey, encryptionVariant } = resolveSessionEncryptionContextFromCredentials(
    params.credentials,
    params.rawSession,
  );

  try {
    const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encryptedMetadataBase64, 'base64'));
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
    return decrypted as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function encryptStoredSessionPayload(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  payload: unknown;
}>): string {
  if (params.mode === 'plain') {
    return JSON.stringify(params.payload);
  }
  return encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload), 'base64');
}

export function decryptStoredSessionPayload(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  value: string;
}>): unknown {
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
  idempotencyKey?: string;
}>): string {
  const nonce = params.idempotencyKey === undefined
    ? undefined
    : deriveIdempotentSessionPayloadNonce({
        ctx: params.ctx,
        idempotencyKey: params.idempotencyKey,
        payload: params.payload,
      });
  const ciphertext = nonce === undefined
    ? encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload)
    : encryptWithDerivedNonce(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload, nonce);
  return encodeBase64(ciphertext, 'base64');
}

/**
 * Keep these exact bytes for the existing idempotent Session-payload namespace.
 * The `session-pending` wording is historical: this shared primitive also
 * supports transition dividers. Retain it to preserve durable Pending retry
 * ciphertext; changing it would change a predecessor-created row on retry.
 */
const IDEMPOTENT_SESSION_PAYLOAD_NONCE_DOMAIN_V1 =
  'happier.session-pending.idempotent-content.v1';

function deriveIdempotentSessionPayloadNonce(params: Readonly<{
  ctx: SessionEncryptionContext;
  idempotencyKey: string;
  payload: unknown;
}>): Uint8Array {
  // A keyed synthetic nonce makes same-ID/same-content retries byte-identical
  // without reusing a nonce when either the identity or plaintext changes.
  const fields = [
    IDEMPOTENT_SESSION_PAYLOAD_NONCE_DOMAIN_V1,
    params.ctx.encryptionVariant,
    params.idempotencyKey,
    stringifySerializedJsonValue(params.payload),
  ];
  const encodedFields = fields.map((field) => new TextEncoder().encode(field));
  const totalLength = encodedFields.reduce((total, field) => total + 4 + field.length, 0);
  const input = new Uint8Array(totalLength);
  const view = new DataView(input.buffer);
  let offset = 0;
  for (const field of encodedFields) {
    view.setUint32(offset, field.length, false);
    offset += 4;
    input.set(field, offset);
    offset += field.length;
  }
  const digest = createHmac('sha256', params.ctx.encryptionKey).update(input).digest();
  const nonceLength = params.ctx.encryptionVariant === 'legacy' ? 24 : 12;
  return new Uint8Array(digest.subarray(0, nonceLength));
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
