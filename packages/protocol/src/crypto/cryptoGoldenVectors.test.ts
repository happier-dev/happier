import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';
import { openBoxBundle } from './boxBundle.js';
import { openEncryptedDataKeyEnvelopeV1 } from './encryptedDataKeyEnvelopeV1.js';
import { parseSerializedJsonValue } from './serializedJsonValue.js';

type ByteVector = Readonly<{
  hex: string;
}>;

type BoxBundleVector = Readonly<{
  recipientSecretKeyOrSeed: ByteVector;
  recipientPublicKey: ByteVector;
  plaintext: ByteVector;
  bundle: ByteVector;
}>;

type EncryptedDataKeyEnvelopeVector = Readonly<{
  recipientSecretKeyOrSeed: ByteVector;
  recipientPublicKey: ByteVector;
  dataKey: ByteVector;
  envelope: ByteVector;
}>;

type CryptoGoldenVectors = Readonly<{
  schema: 'happier.cryptoGoldenVectors.v1';
  boxBundle: Readonly<{
    directSecretKey: BoxBundleVector;
    compatibilitySeed: BoxBundleVector;
    malformedBundle: ByteVector;
  }>;
  encryptedDataKeyEnvelopeV1: Readonly<{
    directSecretKey: EncryptedDataKeyEnvelopeVector;
    compatibilitySeed: EncryptedDataKeyEnvelopeVector;
    malformedEnvelope: ByteVector;
    unsupportedVersionEnvelope: ByteVector;
  }>;
  serializedJsonValue: ReadonlyArray<Readonly<{
    name: string;
    serialized: string;
  }>>;
}>;

function readGoldenVectors(): CryptoGoldenVectors {
  const value = Reflect.get(protocol, 'CRYPTO_GOLDEN_VECTORS');
  expect(value).toEqual(expect.objectContaining({
    schema: 'happier.cryptoGoldenVectors.v1',
  }));
  return value as CryptoGoldenVectors;
}

function bytesFromHex(hex: string): Uint8Array {
  expect(hex.length % 2).toBe(0);
  return Uint8Array.from(hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}

function expectBytesToMatchHex(actual: Uint8Array | null, expectedHex: string): void {
  expect(actual).not.toBeNull();
  expect(Buffer.from(actual!).toString('hex')).toBe(expectedHex);
}

describe('CRYPTO_GOLDEN_VECTORS', () => {
  it('exports deterministic protocol vectors from the public package API', () => {
    const vectors = readGoldenVectors();

    expect(vectors.boxBundle.directSecretKey.bundle.hex).toBe(
      '07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c2122232425262728292a2b2c2d2e2f30313233343536373859c1c234f45efd03c1ab22b9b03f8b3feb1276a05a7868f0c6a9c8bfcd0423033d6aea6e047523bc7413ee42040d1677',
    );
    expect(vectors.boxBundle.compatibilitySeed.bundle.hex).toBe(
      '07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c2122232425262728292a2b2c2d2e2f303132333435363738f427df224168af852aee33ba83373277a78e69b82653cae4c31bf92707cc7d03dfd549ca06b072d61318b94ad3ff8c80',
    );
    expect(vectors.encryptedDataKeyEnvelopeV1.directSecretKey.envelope.hex).toBe(
      '0007a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c2122232425262728292a2b2c2d2e2f3031323334353637387c08c8f85db24be438ff0be65a8f9599ec1571a75d7f6ff7c1aecfb8ca0324043a6ded69037224bb7314e945030a1170',
    );
    expect(vectors.encryptedDataKeyEnvelopeV1.compatibilitySeed.envelope.hex).toBe(
      '0007a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c2122232425262728292a2b2c2d2e2f3031323334353637387e1905a028d044ade8c2bec4c04b6973a1886fbe2055cce2c51dff2101ca7b05d9d34fcc00b674d0151ebf4cd5f98a86',
    );
  });

  it('opens box bundle vectors with direct and compatibility recipient material', () => {
    const vectors = readGoldenVectors();

    for (const vector of [
      vectors.boxBundle.directSecretKey,
      vectors.boxBundle.compatibilitySeed,
    ]) {
      const opened = openBoxBundle({
        bundle: bytesFromHex(vector.bundle.hex),
        recipientSecretKeyOrSeed: bytesFromHex(vector.recipientSecretKeyOrSeed.hex),
      });

      expectBytesToMatchHex(opened, vector.plaintext.hex);
    }
  });

  it('opens encrypted data-key envelope vectors with direct and compatibility recipient material', () => {
    const vectors = readGoldenVectors();

    for (const vector of [
      vectors.encryptedDataKeyEnvelopeV1.directSecretKey,
      vectors.encryptedDataKeyEnvelopeV1.compatibilitySeed,
    ]) {
      const opened = openEncryptedDataKeyEnvelopeV1({
        envelope: bytesFromHex(vector.envelope.hex),
        recipientSecretKeyOrSeed: bytesFromHex(vector.recipientSecretKeyOrSeed.hex),
      });

      expectBytesToMatchHex(opened, vector.dataKey.hex);
    }
  });

  it('keeps invalid protocol vectors as null-return cases', () => {
    const vectors = readGoldenVectors();
    const directSecretKey = bytesFromHex(vectors.encryptedDataKeyEnvelopeV1.directSecretKey.recipientSecretKeyOrSeed.hex);

    expect(openBoxBundle({
      bundle: bytesFromHex(vectors.boxBundle.malformedBundle.hex),
      recipientSecretKeyOrSeed: directSecretKey,
    })).toBeNull();
    expect(openEncryptedDataKeyEnvelopeV1({
      envelope: bytesFromHex(vectors.encryptedDataKeyEnvelopeV1.malformedEnvelope.hex),
      recipientSecretKeyOrSeed: directSecretKey,
    })).toBeNull();
    expect(openEncryptedDataKeyEnvelopeV1({
      envelope: bytesFromHex(vectors.encryptedDataKeyEnvelopeV1.unsupportedVersionEnvelope.hex),
      recipientSecretKeyOrSeed: directSecretKey,
    })).toBeNull();
  });

  it('pins serialized JSON values used around native crypto payloads', () => {
    const vectors = readGoldenVectors();

    const parsedByName = Object.fromEntries(
      vectors.serializedJsonValue.map((vector) => [vector.name, parseSerializedJsonValue(vector.serialized)]),
    );

    expect(parsedByName).toEqual({
      object: { ok: true, count: 2, nested: ['a', null] },
      array: ['x', 1, false],
      string: 'hello',
      number: 42,
      nullValue: null,
      undefinedValue: undefined,
    });
  });
});
