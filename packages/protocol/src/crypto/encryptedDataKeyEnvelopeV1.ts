import { BOX_BUNDLE_MIN_BYTES, openBoxBundle, sealBoxBundle } from './boxBundle.js';

export const ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE = 0;
export const DIRECT_SHARE_DATA_KEY_V1_BYTES = 32;
export const DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES =
  1 + BOX_BUNDLE_MIN_BYTES + DIRECT_SHARE_DATA_KEY_V1_BYTES;

export type DirectShareEncryptedDataKeyEnvelopeV1 = Readonly<{
  encryptedDataKey: Uint8Array<ArrayBuffer>;
}>;

/**
 * Validates the structural contract used when a named session share transports
 * its 32-byte data key. The server cannot authenticate the sealed box, but it
 * can reject envelopes that no conforming direct-share producer could emit.
 */
export function parseDirectShareEncryptedDataKeyEnvelopeV1(
  envelope: Uint8Array,
): DirectShareEncryptedDataKeyEnvelopeV1 | null {
  if (envelope.byteLength !== DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES) {
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
}): Uint8Array {
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
  if (params.envelope.length < 2) return null;
  if (params.envelope[0] !== ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE) return null;
  return openBoxBundle({
    bundle: params.envelope.slice(1),
    recipientSecretKeyOrSeed: params.recipientSecretKeyOrSeed,
  });
}
