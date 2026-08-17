import { describe, expect, it } from 'vitest';

import {
  PluginAccountStorageEnvelopeV1Schema,
  PluginAccountStorageJsonValueV1Schema,
  PLUGIN_ACCOUNT_STORAGE_LIMITS_V1,
  PluginAccountStorageMutationRequestV1Schema,
  PluginAccountStorageMutationResponseV1Schema,
  PluginAccountStorageReadResponseV1Schema,
  PluginAccountStorageRowV1Schema,
  assertPluginAccountStorageEnvelopeForModeV1,
  openPluginAccountStoragePrivatePayloadV1,
  sealPluginAccountStoragePrivatePayloadV1,
} from './accountKvV1.js';
import { sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';

describe('Plugin Account KV v1', () => {
  it('uses the Protocol strict-JSON grammar without its own depth or node quota', () => {
    let deepValue: unknown = 'leaf';
    for (let depth = 0; depth < 64; depth += 1) {
      deepValue = { next: deepValue };
    }
    const withSymbol = Object.defineProperty({}, Symbol('hidden'), {
      enumerable: true,
      value: true,
    });
    const withNonEnumerable = Object.defineProperty({}, 'hidden', {
      enumerable: false,
      value: true,
    });

    expect(PluginAccountStorageJsonValueV1Schema.safeParse(deepValue).success).toBe(true);
    expect(PluginAccountStorageJsonValueV1Schema.safeParse(withSymbol).success).toBe(false);
    expect(PluginAccountStorageJsonValueV1Schema.safeParse(withNonEnumerable).success).toBe(false);
  });

  it('accepts one bounded versioned map and rejects the host-reserved logical namespace', () => {
    expect(PluginAccountStorageRowV1Schema.parse({
      v: 1,
      values: {
        'selected-project': { version: 0, value: { id: 'p1' } },
      },
    })).toEqual({
      v: 1,
      values: {
        'selected-project': { version: 0, value: { id: 'p1' } },
      },
    });

    expect(() => PluginAccountStorageRowV1Schema.parse({
      v: 1,
      values: {
        '@happier/settings/v1': { version: 0, value: true },
      },
    })).toThrow();
  });

  it('retains deletion as a strict per-key versioned tombstone', () => {
    expect(PluginAccountStorageRowV1Schema.parse({
      v: 1,
      values: {
        checkpoint: { version: 4, deleted: true },
      },
    })).toEqual({
      v: 1,
      values: {
        checkpoint: { version: 4, deleted: true },
      },
    });
    expect(PluginAccountStorageRowV1Schema.safeParse({
      v: 1,
      values: {
        checkpoint: { version: 4, deleted: true, value: 'must not coexist' },
      },
    }).success).toBe(false);
  });

  it('keeps explicit envelopes mode-safe instead of interpreting one representation as the other', () => {
    const ciphertext = sealPluginAccountStoragePrivatePayloadV1({
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(2) },
      payload: { v: 1, values: {} },
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    const plain = PluginAccountStorageEnvelopeV1Schema.parse({
      t: 'plain',
      v: { v: 1, values: { theme: { version: 0, value: 'dark' } } },
    });
    const encrypted = PluginAccountStorageEnvelopeV1Schema.parse({
      t: 'encrypted',
      c: ciphertext,
    });

    expect(assertPluginAccountStorageEnvelopeForModeV1(plain, 'plain')).toEqual(plain);
    expect(assertPluginAccountStorageEnvelopeForModeV1(encrypted, 'e2ee')).toEqual(encrypted);
    expect(() => assertPluginAccountStorageEnvelopeForModeV1(plain, 'e2ee')).toThrow();
    expect(() => assertPluginAccountStorageEnvelopeForModeV1(encrypted, 'plain')).toThrow();
  });

  it('bounds encrypted Account-KV ciphertext to the maximum row plus its exact cipher encoding overhead', () => {
    const maximumCiphertextUtf8Bytes = 4 * Math.ceil(
      (
        PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumRowEncodedBytes
        // account-scoped v1 magic + kind, secretbox nonce, and authentication tag
        + 2 + 24 + 16
      ) / 3,
    );

    expect(maximumCiphertextUtf8Bytes).toBe(699_108);
    expect(PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumEncryptedCiphertextUtf8Bytes)
      .toBe(maximumCiphertextUtf8Bytes);
    expect(PluginAccountStorageEnvelopeV1Schema.safeParse({
      t: 'encrypted',
      c: 'A'.repeat(maximumCiphertextUtf8Bytes),
    }).success).toBe(true);
    expect(PluginAccountStorageEnvelopeV1Schema.safeParse({
      t: 'encrypted',
      c: 'A'.repeat(maximumCiphertextUtf8Bytes + 1),
    }).success).toBe(false);
  });

  it('seals an E2EE Account KV row in its exact Account-scoped domain', () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(11) };
    const payload = {
      v: 1 as const,
      values: {
        theme: { version: 0, value: 'dark' },
      },
    };
    const randomBytes = (length: number) => new Uint8Array(length).fill(5);
    const ciphertext = sealPluginAccountStoragePrivatePayloadV1({
      material,
      payload,
      randomBytes,
    });

    expect(openPluginAccountStoragePrivatePayloadV1({ material, ciphertext })).toEqual(payload);
    expect(assertPluginAccountStorageEnvelopeForModeV1({
      t: 'encrypted',
      c: ciphertext,
    }, 'e2ee')).toEqual({ t: 'encrypted', c: ciphertext });

    const collectionCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'plugin_collection_private_payload',
      material,
      payload,
      randomBytes,
    });
    expect(openPluginAccountStoragePrivatePayloadV1({
      material,
      ciphertext: collectionCiphertext,
    })).toBeNull();
    expect(() => assertPluginAccountStorageEnvelopeForModeV1({
      t: 'encrypted',
      c: collectionCiphertext,
    }, 'e2ee')).toThrow('Plugin Account KV envelope');
  });

  it('fails closed for an oversized row rather than accepting a partial map', () => {
    expect(() => PluginAccountStorageRowV1Schema.parse({
      v: 1,
      values: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
        `key-${index}`,
        { version: 0, value: index },
      ])),
    })).toThrow();
  });

  it('publishes row-CAS request and result unions without leaking content in conflicts', () => {
    const content = PluginAccountStorageEnvelopeV1Schema.parse({
      t: 'plain',
      v: { v: 1, values: { theme: { version: 0, value: 'dark' } } },
    });
    expect(PluginAccountStorageReadResponseV1Schema.parse({
      status: 'present',
      revision: 4,
      content,
    })).toEqual({
      status: 'present',
      revision: 4,
      content,
    });
    expect(PluginAccountStorageMutationRequestV1Schema.parse({
      expectedRevision: 'absent',
      content,
    })).toEqual({ expectedRevision: 'absent', content });
    expect(PluginAccountStorageMutationResponseV1Schema.parse({
      status: 'conflict',
      revision: 4,
    })).toEqual({ status: 'conflict', revision: 4 });
    expect(PluginAccountStorageMutationResponseV1Schema.safeParse({
      status: 'conflict',
      revision: 4,
      content,
    }).success).toBe(false);
  });
});
