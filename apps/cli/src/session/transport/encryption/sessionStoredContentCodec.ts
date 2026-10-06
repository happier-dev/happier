import { createHmac } from 'node:crypto';

import { stringifySerializedJsonValue } from '@happier-dev/protocol/crypto/serializedJsonValue';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol';
import { resolveSessionStoredContentEnvelope } from '@happier-dev/sync-client';

import {
  decodeBase64,
  decrypt,
  decryptResult,
  encodeBase64,
  encrypt,
  encryptWithDerivedNonce,
} from '../../../api/encryption';

export type SessionEncryptionContext = Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}>;

export type SessionStoredContentEncryptionMode = 'e2ee' | 'plain';

export type SessionStoredContentCryptoContext =
  | Readonly<{ mode: 'plain'; ctx: null }>
  | Readonly<{ mode: 'e2ee'; ctx: SessionEncryptionContext }>;

export class SessionStoredContentError extends Error {
  constructor(public readonly code: 'session_content_mode_mismatch' | 'session_content_unavailable') {
    super(code === 'session_content_mode_mismatch'
      ? 'Session stored content encryption mode mismatch'
      : 'Session stored content is unavailable');
    this.name = 'SessionStoredContentError';
  }
}

/**
 * Synchronous Node sealing adapter for the canonical Session envelope.
 * Domain codecs validate the payload; the established mode and deterministic
 * nonce namespace are preserved at this platform boundary.
 */
export function sealSessionStoredContent(
  params: SessionStoredContentCryptoContext & Readonly<{
    payload: Extract<StrictSessionStoredMessageContentEnvelope, { t: 'plain' }>['v'];
    idempotencyKey?: string;
  }>,
): StrictSessionStoredMessageContentEnvelope {
  if (params.mode === 'plain') {
    return Object.freeze({ t: 'plain' as const, v: params.payload });
  }
  return Object.freeze({
    t: 'encrypted' as const,
    c: encryptSessionPayload({
      ctx: params.ctx,
      payload: params.payload,
      ...(params.idempotencyKey === undefined ? {} : { idempotencyKey: params.idempotencyKey }),
    }),
  });
}

/** Opens a canonical envelope only under the Session's established mode. */
export function openSessionStoredContent(
  params: SessionStoredContentCryptoContext & Readonly<{
    content: unknown;
  }>,
): unknown {
  const resolved = resolveSessionStoredContentEnvelope(params, params.content);
  if (resolved.status === 'mode_mismatch') {
    throw new SessionStoredContentError('session_content_mode_mismatch');
  }
  if (resolved.status !== 'ready') throw new SessionStoredContentError('session_content_unavailable');
  if (resolved.content.t === 'plain') return resolved.content.v;
  if (params.mode !== 'e2ee') {
    throw new SessionStoredContentError('session_content_mode_mismatch');
  }
  try {
    const result = decryptResult(
      params.ctx.encryptionKey,
      params.ctx.encryptionVariant,
      decodeBase64(resolved.content.c, 'base64'),
    );
    if (result.status === 'authenticated') return result.value;
  } catch {
    // Crypto failures never downgrade the established Session content mode.
  }
  throw new SessionStoredContentError('session_content_unavailable');
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
