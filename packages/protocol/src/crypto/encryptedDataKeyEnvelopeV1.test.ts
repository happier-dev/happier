import { describe, expect, it } from 'vitest';

import { sha512 } from '@noble/hashes/sha512';
import tweetnacl from 'tweetnacl';

import {
  DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
  openEncryptedDataKeyEnvelopeV1,
  parseDirectShareEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
} from './encryptedDataKeyEnvelopeV1.js';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('encryptedDataKeyEnvelopeV1', () => {
  it('parses the exact envelope shape emitted for a 32-byte direct-share data key', () => {
    const recipientSecretKey = new Uint8Array(32).fill(9);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(recipientSecretKey).publicKey;
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: new Uint8Array(32).fill(4),
      recipientPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const parsed = parseDirectShareEncryptedDataKeyEnvelopeV1(envelope);

    expect(envelope).toHaveLength(DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES);
    expect(parsed?.encryptedDataKey).toEqual(envelope);
    expect(parsed?.encryptedDataKey).not.toBe(envelope);
  });

  it('rejects unsupported versions and non-direct-share envelope lengths', () => {
    const validLengthEnvelope = new Uint8Array(DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES);
    const unsupportedVersion = new Uint8Array(validLengthEnvelope);
    unsupportedVersion[0] = 1;

    expect(parseDirectShareEncryptedDataKeyEnvelopeV1(unsupportedVersion)).toBeNull();
    expect(parseDirectShareEncryptedDataKeyEnvelopeV1(validLengthEnvelope.slice(0, -1))).toBeNull();
    expect(parseDirectShareEncryptedDataKeyEnvelopeV1(
      new Uint8Array(DIRECT_SHARE_ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES + 1),
    )).toBeNull();
  });

  it('seals and opens a v1 envelope with recipient secret key', () => {
    const recipientSecretKey = new Uint8Array(32).fill(9);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(recipientSecretKey).publicKey;
    const dataKey = new Uint8Array(32).fill(4);

    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey,
      recipientPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openEncryptedDataKeyEnvelopeV1({
      envelope,
      recipientSecretKeyOrSeed: recipientSecretKey,
    });

    expect(opened).not.toBeNull();
    expect(Array.from(opened!)).toEqual(Array.from(dataKey));
  });

  it('opens a v1 envelope when recipient secret key is provided as a seed (CLI compat)', () => {
    const seed = new Uint8Array(32).fill(11);
    const compatSecretKey = sha512(seed).slice(0, 32);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(compatSecretKey).publicKey;
    const dataKey = new Uint8Array(32).fill(1);

    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey,
      recipientPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openEncryptedDataKeyEnvelopeV1({
      envelope,
      recipientSecretKeyOrSeed: seed,
    });

    expect(opened).not.toBeNull();
    expect(Array.from(opened!)).toEqual(Array.from(dataKey));
  });

  it('returns null when envelope version byte is unsupported', () => {
    const recipientSecretKey = new Uint8Array(32).fill(9);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(recipientSecretKey).publicKey;
    const dataKey = new Uint8Array(32).fill(4);

    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey,
      recipientPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });
    const mutated = new Uint8Array(envelope);
    mutated[0] = 99;

    expect(openEncryptedDataKeyEnvelopeV1({ envelope: mutated, recipientSecretKeyOrSeed: recipientSecretKey })).toBeNull();
  });

  it('returns null (and does not throw) when envelope is malformed', () => {
    const seed = new Uint8Array(32).fill(1);
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: new Uint8Array([0, 1, 2]), recipientSecretKeyOrSeed: seed })).toBeNull();
  });
});
