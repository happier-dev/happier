import { openBoxBundle, sealBoxBundle } from './boxBundle.js';
import {
  ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
  ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE,
  ENCRYPTED_DATA_KEY_V1_BYTES,
} from './encryptedDataKeyEnvelopeFormatV1.js';

export {
  ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
  ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE,
  ENCRYPTED_DATA_KEY_V1_BYTES,
};

export type EncryptedDataKeyEnvelopeV1 = Readonly<{
  encryptedDataKey: Uint8Array<ArrayBuffer>;
}>;

/**
 * Validates the structural contract used whenever a fixed 32-byte data key is
 * transported to one recipient. The server cannot authenticate the sealed box,
 * but it can reject envelopes that no conforming producer could emit.
 */
export function parseEncryptedDataKeyEnvelopeV1(
  envelope: Uint8Array,
): EncryptedDataKeyEnvelopeV1 | null {
  if (envelope.byteLength !== ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES) {
    return null;
  }
  if (envelope[0] !== ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE) {
    return null;
  }
  const encryptedDataKey = new Uint8Array(envelope.byteLength);
  encryptedDataKey.set(envelope);
  return { encryptedDataKey };
}

export function sealEncryptedDataKeyEnvelopeV1(params: {
  dataKey: Uint8Array;
  recipientPublicKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}): Uint8Array<ArrayBuffer> {
  if (params.dataKey.length !== ENCRYPTED_DATA_KEY_V1_BYTES) {
    throw new Error(`Invalid data key length: ${params.dataKey.length}`);
  }
  const bundle = sealBoxBundle({
    plaintext: params.dataKey,
    recipientPublicKey: params.recipientPublicKey,
    randomBytes: params.randomBytes,
  });
  const out = new Uint8Array(1 + bundle.length);
  out[0] = ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE;
  out.set(bundle, 1);
  return out;
}

export function openEncryptedDataKeyEnvelopeV1(params: {
  envelope: Uint8Array;
  recipientSecretKeyOrSeed: Uint8Array;
}): Uint8Array | null {
  if (params.envelope.length !== ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES) return null;
  if (params.envelope[0] !== ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE) return null;
  const opened = openBoxBundle({
    bundle: params.envelope.slice(1),
    recipientSecretKeyOrSeed: params.recipientSecretKeyOrSeed,
  });
  // Fixed-size postcondition stated at the boundary every runtime (JS, Swift,
  // Android, and the native bridge) mirrors: callers may rely on exactly one
  // data-key length, never a shorter or longer opened plaintext.
  if (!opened || opened.length !== ENCRYPTED_DATA_KEY_V1_BYTES) return null;
  return opened;
}
