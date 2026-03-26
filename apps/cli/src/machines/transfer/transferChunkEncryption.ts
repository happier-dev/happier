import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import {
  BOX_BUNDLE_PUBLIC_KEY_BYTES,
  deriveBoxPublicKeyFromSeed,
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { TRANSFER_CHUNK_HARD_MAX_BYTES } from './transferChunkSizeLimit';

const TRANSFER_CHUNK_DATA_KEY_BYTES = 32;
const TRANSFER_CHUNK_NONCE_BYTES = 12;
const TRANSFER_CHUNK_AUTH_TAG_BYTES = 16;
const TRANSFER_CHUNK_BUNDLE_VERSION = 0;
const TRANSFER_RECIPIENT_PUBLIC_KEY_CACHE_MAX_ENTRIES = 256;
const TRANSFER_RECIPIENT_PUBLIC_KEY_HARD_MAX_BYTES = BOX_BUNDLE_PUBLIC_KEY_BYTES * 2;

const recipientPublicKeyCache = new Map<string, Uint8Array>();

type RandomBytesFn = (length: number) => Uint8Array;

// Keep in sync with the direct-peer/server-routed open-request guards.
const TRANSFER_ENCRYPTED_DATA_KEY_ENVELOPE_HARD_MAX_BYTES = 1024;
const TRANSFER_ENCRYPTED_CHUNK_HARD_MAX_BYTES =
  1 + TRANSFER_CHUNK_NONCE_BYTES + TRANSFER_CHUNK_HARD_MAX_BYTES + TRANSFER_CHUNK_AUTH_TAG_BYTES;

function defaultRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

function buildTransferChunkAad(params: Readonly<{
  transferId: string;
  sequence: number;
}>): Buffer {
  return Buffer.from(`${TRANSFER_CHUNK_BUNDLE_VERSION}:${params.transferId}:${params.sequence}`, 'utf8');
}

function resolveBase64EncodedBytesUpperBound(base64: string): number {
  // Base64: 4 chars encode up to 3 bytes. This intentionally ignores padding correctness; we only
  // need an upper bound to fail closed before decoding into a potentially huge Buffer.
  const raw = String(base64 ?? '');
  // Avoid `trim()` to prevent allocating a second large string before we enforce hard limits.
  let start = 0;
  while (start < raw.length && /\s/u.test(raw[start] ?? '')) {
    start += 1;
  }
  let end = raw.length;
  while (end > start && /\s/u.test(raw[end - 1] ?? '')) {
    end -= 1;
  }
  const rawLen = end - start;
  if (!rawLen) return 0;
  return Math.ceil(rawLen / 4) * 3;
}

export function parseTransferRecipientPublicKeyBase64(recipientPublicKeyBase64: string): Uint8Array {
  // This input is peer-controlled. Fail closed before decoding base64 so a hostile peer cannot
  // force us to allocate an oversized Buffer (OOM vector).
  if (resolveBase64EncodedBytesUpperBound(recipientPublicKeyBase64) > TRANSFER_RECIPIENT_PUBLIC_KEY_HARD_MAX_BYTES) {
    throw new Error('Invalid transfer recipient public key');
  }

  const normalized = String(recipientPublicKeyBase64 ?? '').trim();
  const cached = recipientPublicKeyCache.get(normalized);
  if (cached) {
    return cached;
  }

  const recipientPublicKey = Buffer.from(normalized, 'base64');
  if (recipientPublicKey.length !== BOX_BUNDLE_PUBLIC_KEY_BYTES) {
    throw new Error('Invalid transfer recipient public key');
  }

  recipientPublicKeyCache.set(normalized, recipientPublicKey);
  while (recipientPublicKeyCache.size > TRANSFER_RECIPIENT_PUBLIC_KEY_CACHE_MAX_ENTRIES) {
    const oldestKey = recipientPublicKeyCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    recipientPublicKeyCache.delete(oldestKey);
  }

  return recipientPublicKey;
}

export function createTransferManifestHash(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function createTransferRecipientKeyPair(params?: Readonly<{
  randomBytes?: RandomBytesFn;
}>): Readonly<{
  recipientSecretKeySeed: Uint8Array;
  recipientPublicKeyBase64: string;
}> {
  const randomBytesFn = params?.randomBytes ?? defaultRandomBytes;
  const recipientSecretKeySeed = randomBytesFn(TRANSFER_CHUNK_DATA_KEY_BYTES);
  return {
    recipientSecretKeySeed,
    recipientPublicKeyBase64: Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64'),
  };
}

export function createEncryptedTransferChunkEnvelope(params: Readonly<{
  transferId: string;
  sequence: number;
  payload: Buffer;
  recipientPublicKeyBase64: string;
  randomBytes?: RandomBytesFn;
}>): Readonly<{
  payloadBase64: string;
  encryptedDataKeyEnvelopeBase64: string;
}> {
  const randomBytesFn = params.randomBytes ?? defaultRandomBytes;
  const dataKey = randomBytesFn(TRANSFER_CHUNK_DATA_KEY_BYTES);
  if (dataKey.length !== TRANSFER_CHUNK_DATA_KEY_BYTES) {
    throw new Error(`Invalid transfer data key length: ${dataKey.length}`);
  }
  const nonce = randomBytesFn(TRANSFER_CHUNK_NONCE_BYTES);
  if (nonce.length !== TRANSFER_CHUNK_NONCE_BYTES) {
    throw new Error(`Invalid transfer chunk nonce length: ${nonce.length}`);
  }

  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  cipher.setAAD(buildTransferChunkAad({
    transferId: params.transferId,
    sequence: params.sequence,
  }));
  const ciphertextHead = cipher.update(params.payload);
  const ciphertextTail = cipher.final();
  const ciphertext = Buffer.allocUnsafe(ciphertextHead.length + ciphertextTail.length);
  ciphertextHead.copy(ciphertext, 0);
  ciphertextTail.copy(ciphertext, ciphertextHead.length);
  const authTag = cipher.getAuthTag();

  const encryptedChunk = Buffer.allocUnsafe(
    1 + TRANSFER_CHUNK_NONCE_BYTES + ciphertext.length + TRANSFER_CHUNK_AUTH_TAG_BYTES,
  );
  encryptedChunk[0] = TRANSFER_CHUNK_BUNDLE_VERSION;
  Buffer.from(nonce).copy(encryptedChunk, 1);
  ciphertext.copy(encryptedChunk, 1 + TRANSFER_CHUNK_NONCE_BYTES);
  authTag.copy(encryptedChunk, 1 + TRANSFER_CHUNK_NONCE_BYTES + ciphertext.length);
  const encryptedDataKeyEnvelope = sealEncryptedDataKeyEnvelopeV1({
    dataKey,
    recipientPublicKey: parseTransferRecipientPublicKeyBase64(params.recipientPublicKeyBase64),
    randomBytes: randomBytesFn,
  });

  return {
    payloadBase64: encryptedChunk.toString('base64'),
    encryptedDataKeyEnvelopeBase64: Buffer.from(encryptedDataKeyEnvelope).toString('base64'),
  };
}

export function decryptEncryptedTransferChunkEnvelope(params: Readonly<{
  transferId: string;
  sequence: number;
  payloadBase64: string;
  encryptedDataKeyEnvelopeBase64: string;
  recipientSecretKeySeed: Uint8Array;
}>): Buffer {
  // These inputs come from peer-controlled JSON. Fail closed before decoding base64 so a hostile
  // peer cannot force us to allocate an oversized Buffer (OOM vector).
  if (resolveBase64EncodedBytesUpperBound(params.encryptedDataKeyEnvelopeBase64) > TRANSFER_ENCRYPTED_DATA_KEY_ENVELOPE_HARD_MAX_BYTES) {
    throw new Error(`Invalid encrypted transfer data key for ${params.transferId}`);
  }
  if (resolveBase64EncodedBytesUpperBound(params.payloadBase64) > TRANSFER_ENCRYPTED_CHUNK_HARD_MAX_BYTES) {
    throw new Error(`Invalid encrypted transfer chunk for ${params.transferId}`);
  }

  const encryptedDataKeyEnvelope = Buffer.from(params.encryptedDataKeyEnvelopeBase64, 'base64');
  const dataKey = openEncryptedDataKeyEnvelopeV1({
    envelope: encryptedDataKeyEnvelope,
    recipientSecretKeyOrSeed: params.recipientSecretKeySeed,
  });
  if (!dataKey || dataKey.length !== TRANSFER_CHUNK_DATA_KEY_BYTES) {
    throw new Error(`Invalid encrypted transfer data key for ${params.transferId}`);
  }

  const encryptedChunk = Buffer.from(params.payloadBase64, 'base64');
  const minimumBundleBytes = 1 + TRANSFER_CHUNK_NONCE_BYTES + TRANSFER_CHUNK_AUTH_TAG_BYTES;
  if (encryptedChunk.length < minimumBundleBytes) {
    throw new Error(`Invalid encrypted transfer chunk for ${params.transferId}`);
  }
  if (encryptedChunk[0] !== TRANSFER_CHUNK_BUNDLE_VERSION) {
    throw new Error(`Unsupported encrypted transfer chunk version for ${params.transferId}`);
  }

  const nonceStart = 1;
  const ciphertextStart = nonceStart + TRANSFER_CHUNK_NONCE_BYTES;
  const authTagStart = encryptedChunk.length - TRANSFER_CHUNK_AUTH_TAG_BYTES;
  const nonce = encryptedChunk.subarray(nonceStart, ciphertextStart);
  const ciphertext = encryptedChunk.subarray(ciphertextStart, authTagStart);
  const authTag = encryptedChunk.subarray(authTagStart);

  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
    decipher.setAAD(buildTransferChunkAad({
      transferId: params.transferId,
      sequence: params.sequence,
    }));
    decipher.setAuthTag(authTag);
    const plaintextHead = decipher.update(ciphertext);
    const plaintextTail = decipher.final();
    const plaintext = Buffer.allocUnsafe(plaintextHead.length + plaintextTail.length);
    plaintextHead.copy(plaintext, 0);
    plaintextTail.copy(plaintext, plaintextHead.length);
    return plaintext;
  } catch {
    throw new Error(`Failed to decrypt transfer chunk for ${params.transferId}`);
  }
}
