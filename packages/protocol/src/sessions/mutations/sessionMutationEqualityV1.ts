import { lazyZodSchema } from '../../lazyZodSchema.js';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';

import { encodeBase64 } from '../../crypto/base64.js';

const UTF8_ENCODER = new TextEncoder();

/**
 * One canonical serializer for every Session mutation that has to recognize a
 * repeated request after a lost response. It is a serializer only: callers
 * never supply a digest, HMAC, or encryption nonce, and randomized ciphertext
 * is never the equality contract.
 */
export function serializeCanonicalJsonForSessionMutationEqualityV1(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Session mutation equality requires canonical JSON numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('Session mutation equality requires acyclic canonical JSON');
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string')) {
        throw new TypeError('Session mutation equality requires canonical JSON arrays');
      }
      const dataKeys = keys.filter((key) => key !== 'length');
      if (dataKeys.length !== value.length) {
        throw new TypeError('Session mutation equality requires dense canonical JSON arrays');
      }
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('Session mutation equality requires canonical JSON arrays');
        }
        entries.push(serializeCanonicalJsonForSessionMutationEqualityV1(descriptor.value, ancestors));
      }
      return `[${entries.join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError('Session mutation equality requires canonical JSON');
  }
  if (ancestors.has(value)) throw new TypeError('Session mutation equality requires acyclic canonical JSON');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Session mutation equality requires canonical JSON objects');
  }
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Session mutation equality requires canonical JSON objects');
    }
    const entries = (keys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
        throw new TypeError('Session mutation equality requires canonical JSON');
      }
      return `${JSON.stringify(key)}:${serializeCanonicalJsonForSessionMutationEqualityV1(descriptor.value, ancestors)}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export const SessionMutationEqualityBase64UrlSha256V1Schema = lazyZodSchema(() => z.string().regex(
  /^[A-Za-z0-9_-]{43}$/u,
  'Expected an unpadded base64url SHA-256 value',
));

/**
 * The closed evidence a client may submit so the canonical mutation owner can
 * recognize its own repeated request. A Plain request carries a digest the
 * server can recompute; an E2EE request carries a Session-keyed tag the server
 * can only compare, never calculate, so it cannot confirm a guessed plaintext.
 */
export const SessionMutationEqualityEvidenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plainDigest'), digest: SessionMutationEqualityBase64UrlSha256V1Schema }).strict(),
  z.object({ kind: z.literal('e2eeTag'), tag: SessionMutationEqualityBase64UrlSha256V1Schema }).strict(),
]));
export type SessionMutationEqualityEvidenceV1 = z.infer<typeof SessionMutationEqualityEvidenceV1Schema>;

/**
 * Purpose labels keep one Session's derived equality keys separated per domain,
 * so a discussion tag can never be replayed as a Session-input tag.
 */
export const SESSION_INPUT_EQUALITY_HKDF_LABEL_V1 = 'happier.session-input-equality.v1';
export const SESSION_DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1 = 'happier.session-discussion-mutation-equality.v1';

export type SessionMutationEqualityPurposeV1 =
  | typeof SESSION_INPUT_EQUALITY_HKDF_LABEL_V1
  | typeof SESSION_DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1;

/**
 * Derives the server-opaque equality fact for one E2EE Session mutation. The
 * Session id is HKDF salt so tags cannot be correlated across Sessions, and the
 * purpose label separates domains that share the same Session key material.
 */
export function deriveSessionMutationEqualityTagV1(params: Readonly<{
  keyMaterial: Uint8Array;
  sessionId: string;
  purpose: SessionMutationEqualityPurposeV1;
  canonicalIntent: string;
}>): string {
  if (params.keyMaterial.length === 0) {
    throw new Error('Session mutation equality requires Session key material');
  }
  const equalityKey = hkdf(
    sha256,
    params.keyMaterial,
    UTF8_ENCODER.encode(params.sessionId),
    UTF8_ENCODER.encode(params.purpose),
    32,
  );
  return encodeBase64(
    hmac(sha256, equalityKey, UTF8_ENCODER.encode(params.canonicalIntent)),
    'base64url',
  );
}

/**
 * The Plain-mode counterpart the server derives itself from the normalized
 * semantic request. Plain content is already server-readable, so no key is
 * involved and a client-supplied digest is never trusted in its place.
 */
export function computeSessionMutationEqualityPlainDigestV1(canonicalIntent: string): string {
  return encodeBase64(sha256(UTF8_ENCODER.encode(canonicalIntent)), 'base64url');
}
