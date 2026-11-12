import { decodeContentValueWeb, encodeContentValueWeb } from './contentByteCodecWeb.js';
import {
  frameSessionDataKeyBundle,
  readSessionDataKeyBundle,
  parseSessionDataKeyValue,
  serializeSessionDataKeyValue,
  SESSION_DATA_KEY_BYTES,
  SESSION_DATA_KEY_NONCE_BYTES,
  type SessionDataKeyOpenResult,
} from './sessionDataKeyBundleV0.js';

async function importAesGcmKey(keyBytes: Uint8Array) {
  return await globalThis.crypto.subtle.importKey('raw', new Uint8Array(keyBytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** The platform payload excludes the Happier version byte. */
export async function sealAesGcmPayloadWebCrypto(plaintext: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  const key = await importAesGcmKey(keyBytes);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(SESSION_DATA_KEY_NONCE_BYTES));
  const ciphertext = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(plaintext));
  const ciphertextBytes = new Uint8Array(ciphertext);
  const payload = new Uint8Array(iv.length + ciphertextBytes.length);
  payload.set(iv, 0);
  payload.set(ciphertextBytes, iv.length);
  return payload;
}

export async function openAesGcmPayloadWebCrypto(payload: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  if (payload.byteLength < SESSION_DATA_KEY_NONCE_BYTES) {
    throw new Error('Invalid AES-GCM payload');
  }
  const key = await importAesGcmKey(keyBytes);
  const iv = new Uint8Array(payload.subarray(0, SESSION_DATA_KEY_NONCE_BYTES));
  const ciphertext = new Uint8Array(payload.subarray(SESSION_DATA_KEY_NONCE_BYTES));
  const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(plaintext);
}

export async function sealSessionDataKeyBundleV0(value: unknown, key: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return sealSessionDataKeyBytes(new TextEncoder().encode(serializeSessionDataKeyValue(value)), key, 0);
}

export async function openSessionDataKeyBundleV0(bundle: Uint8Array, key: Uint8Array): Promise<SessionDataKeyOpenResult> {
  return bundle[0] === 0 ? await openSessionDataKeyBundle(bundle, key) : { status: 'unsupported' };
}

function sealSessionDataKeyBytes(plaintext: Uint8Array, key: Uint8Array, version: 0 | 1): Promise<Uint8Array<ArrayBuffer>> {
  if (key.length !== SESSION_DATA_KEY_BYTES) throw new Error('Session data-key encryption requires a 32-byte key');
  return sealAesGcmPayloadWebCrypto(plaintext, key).then(payload => frameSessionDataKeyBundle(payload, version));
}

/** SessionMessage writes opt in; other content keeps the V0 writer. */
export async function sealSessionMessageDataKeyBundle(value: unknown, key: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return sealSessionDataKeyBytes(await encodeContentValueWeb(value), key, 1);
}

export async function openSessionDataKeyBundle(bundle: Uint8Array, key: Uint8Array): Promise<SessionDataKeyOpenResult> {
  const parts = readSessionDataKeyBundle(bundle);
  if (parts.status !== 'ready' || key.length !== SESSION_DATA_KEY_BYTES) return { status: 'unsupported' };
  let plaintext: Uint8Array;
  try {
    plaintext = await openAesGcmPayloadWebCrypto(parts.payload, key);
  } catch {
    return { status: 'authentication_failed' };
  }
  return parts.version === 1 ? await decodeContentValueWeb(plaintext) : parseSessionDataKeyValue(new TextDecoder().decode(plaintext));
}
