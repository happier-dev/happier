import { openBoxBundle, sealBoxBundle } from './boxBundle.js';

export const ENCRYPTED_DATA_KEY_ENVELOPE_V1_VERSION_BYTE = 0;

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

