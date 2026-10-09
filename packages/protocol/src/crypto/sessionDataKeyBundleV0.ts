import { parseSerializedJsonValue, stringifySerializedJsonValue } from './serializedJsonValue.js';

export const SESSION_DATA_KEY_BYTES = 32;
export const SESSION_DATA_KEY_NONCE_BYTES = 12;
export const SESSION_DATA_KEY_TAG_BYTES = 16;

export type SessionDataKeyOpenResult =
  | Readonly<{ status: 'authenticated'; value: unknown }>
  | Readonly<{ status: 'authentication_failed' | 'unsupported' | 'invalid_payload' }>;

export type SessionDataKeyBundleV0ReadResult =
  | Readonly<{
      status: 'ready';
      payload: Uint8Array;
      nonce: Uint8Array;
      ciphertext: Uint8Array;
      authTag: Uint8Array;
    }>
  | Readonly<{ status: 'unsupported' }>;

/** Version 0: [0x00 | nonce(12) | ciphertext | authentication tag(16)]. */
export function frameSessionDataKeyBundleV0(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (payload.length < SESSION_DATA_KEY_NONCE_BYTES + SESSION_DATA_KEY_TAG_BYTES) {
    throw new Error('Invalid session data-key AES-GCM payload');
  }
  const bundle = new Uint8Array(1 + payload.length);
  bundle.set(payload, 1);
  return bundle;
}

export function packSessionDataKeyBundleV0(parts: Readonly<{
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}>): Uint8Array {
  if (parts.nonce.length !== SESSION_DATA_KEY_NONCE_BYTES || parts.authTag.length !== SESSION_DATA_KEY_TAG_BYTES) {
    throw new Error('Invalid session data-key AES-GCM nonce or authentication tag');
  }
  const bundle = new Uint8Array(1 + parts.nonce.length + parts.ciphertext.length + parts.authTag.length);
  bundle.set(parts.nonce, 1);
  bundle.set(parts.ciphertext, 1 + parts.nonce.length);
  bundle.set(parts.authTag, 1 + parts.nonce.length + parts.ciphertext.length);
  return bundle;
}

export function readSessionDataKeyBundleV0(bundle: Uint8Array): SessionDataKeyBundleV0ReadResult {
  if (bundle.length < 1 + SESSION_DATA_KEY_NONCE_BYTES + SESSION_DATA_KEY_TAG_BYTES || bundle[0] !== 0) {
    return { status: 'unsupported' };
  }
  // Keep one payload copy, as the existing UI adapter did before awaiting its cipher.
  const payload = bundle.slice(1);
  const tagOffset = payload.length - SESSION_DATA_KEY_TAG_BYTES;
  return {
    status: 'ready',
    payload,
    nonce: payload.subarray(0, SESSION_DATA_KEY_NONCE_BYTES),
    ciphertext: payload.subarray(SESSION_DATA_KEY_NONCE_BYTES, tagOffset),
    authTag: payload.subarray(tagOffset),
  };
}

export function serializeSessionDataKeyValue(value: unknown): string {
  return stringifySerializedJsonValue(value);
}

export function parseSessionDataKeyValue(serialized: string): SessionDataKeyOpenResult {
  try {
    return { status: 'authenticated', value: parseSerializedJsonValue(serialized) };
  } catch {
    return { status: 'invalid_payload' };
  }
}
