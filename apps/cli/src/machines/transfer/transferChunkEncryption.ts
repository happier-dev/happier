import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import {
  BOX_BUNDLE_PUBLIC_KEY_BYTES,
  deriveBoxPublicKeyFromSeed,
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

const TRANSFER_CHUNK_DATA_KEY_BYTES = 32;
const TRANSFER_CHUNK_NONCE_BYTES = 12;
const TRANSFER_CHUNK_AUTH_TAG_BYTES = 16;
const TRANSFER_CHUNK_BUNDLE_VERSION = 0;

type RandomBytesFn = (length: number) => Uint8Array;

function defaultRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

function buildTransferChunkAad(params: Readonly<{
  transferId: string;
  sequence: number;
}>): Buffer {
  return Buffer.from(`${TRANSFER_CHUNK_BUNDLE_VERSION}:${params.transferId}:${params.sequence}`, 'utf8');
}

function parseRecipientPublicKeyBase64(recipientPublicKeyBase64: string): Uint8Array {
  const recipientPublicKey = Buffer.from(recipientPublicKeyBase64, 'base64');
  if (recipientPublicKey.length !== BOX_BUNDLE_PUBLIC_KEY_BYTES) {
    throw new Error('Invalid transfer recipient public key');
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
    recipientPublicKey: parseRecipientPublicKeyBase64(params.recipientPublicKeyBase64),
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
