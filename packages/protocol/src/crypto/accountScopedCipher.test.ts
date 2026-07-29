import { describe, expect, it } from 'vitest';

import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import tweetnacl from 'tweetnacl';
import {
  sealLegacyConnectedServiceQuotaSnapshotCompatibilityCiphertext,
} from '../host/legacyConnectedServiceQuotaCompatibility.js';
import {
  sealSessionOwnerMetadataFixtureCiphertext,
} from '../testing/accountScopedCipherFixtures.js';
import { decodeBase64, encodeBase64 } from './base64.js';
import { stringifySerializedJsonValue } from './serializedJsonValue.js';

import {
  createAccountScopedCryptoMaterialSnapshotV1,
  openAccountScopedBlobCiphertext,
  readAccountScopedCiphertextKindByte,
  sealAccountScopedBlobCiphertext,
  type AccountScopedBlobKind,
  type AccountScopedCryptoMaterial,
  deriveAccountMachineKeyFromRecoverySecret,
} from './accountScopedCipher.js';

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

const FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY =
  Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS = [
  {
    kind: 'account_settings',
    kindByte: 1,
    ciphertext: 'oQEhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzj94RlZIyAv18gROn+709f0csPWYSTXX9PU9wCNwiQ+5MD1DSBhM5dHrncrvnXpyR0=',
    payload: { slot: 1, source: 'cli-v0.2.1' },
  },
  {
    kind: 'automation_template_payload',
    kindByte: 2,
    ciphertext: 'oQIhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzhjMOHQt1wcsZ9zh1gLYjtXuexTWw75AVmbN+TKHn5Tt5j6kBwDpm3wb+17yzIwLLs=',
    payload: { slot: 2, source: 'cli-v0.2.1' },
  },
  {
    kind: 'connected_service_credential',
    kindByte: 3,
    ciphertext: 'oQMhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzgGxu54j+shCt94KGyplfy49A3QCE4qv9Z6vQ1gEqx4pdbM1lTc21E6mxUQ7o2VLc4=',
    payload: { slot: 3, source: 'cli-v0.2.1' },
  },
  {
    kind: 'connected_service_quota_snapshot',
    kindByte: 4,
    ciphertext: 'oQQhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5fEl9K9e0gbQcLrSkvsMc0Wbde5VEgjODqJnwlP50/98/oh/sEPqZQamcCTwpYsU=',
    payload: { slot: 4, source: 'cli-v0.2.1' },
  },
  {
    kind: 'session_respawn_environment',
    kindByte: 5,
    ciphertext: 'oQUhIiMkJSYnKCkqKywtLi8wMTIzNDU2NzhHWU9WmWQ7nwAvyK6bcNpLDJTC6xywpyybRuQMGnRXvSaDO+M/Y8TUEVlmJ8CdSkqA5Z4yZfVMX+I=',
    payload: { slot: 5, source: 'remote-dev@165a9365' },
  },
  {
    kind: 'provider_account_usage_snapshot',
    kindByte: 6,
    ciphertext: 'oQYhIiMkJSYnKCkqKywtLi8wMTIzNDU2NziSyguEBc7xZotGmryGC78iu1JxU0l/R4iPjMjrci2oQwOWiDRnDXEMbfB31KH9hPPCBEUf4y90RdU=',
    payload: { slot: 6, source: 'remote-dev@165a9365' },
  },
  {
    kind: 'session_organization_display',
    kindByte: 7,
    ciphertext: 'oQchIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg0mkrSWNdvOq0Jvf6eiumoXFQk4kQLsvR4Fj9q/+utxYs/krndxhoJD+jdJ6u9JbMNk7oKvKkT0ks=',
    payload: { slot: 7, source: 'remote-dev@165a9365' },
  },
  {
    kind: 'session_first_intent',
    kindByte: 8,
    ciphertext: 'oQghIiMkJSYnKCkqKywtLi8wMTIzNDU2NzjT4yuWzsiuWbUcPaCjD9TdiZicxfS3G6P0UB1L1sTyUv9BLLHlfxIV4Z+eK81ltpc0NtuphiR3fZM=',
    payload: { slot: 8, source: 'remote-dev@165a9365' },
  },
  {
    kind: 'qualified_connected_account_configuration',
    kindByte: 9,
    ciphertext: 'oQkhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzh+oStuIDhXy3cUeiyw1H+ViUFnbGbprMiLCup6+VRcXSWgqJJIsTGn5g4FuiaZemQ=',
    payload: { slot: 9, source: 'dev-r4.4.6' },
  },
  {
    kind: 'session_owner_metadata',
    kindByte: 10,
    ciphertext: 'oQohIiMkJSYnKCkqKywtLi8wMTIzNDU2NzgsvICo8KXTESqbTLkYvLXJG1VfHFpp6U4WHG4Bi2KldSNqd2gMLo9JnviSP6dg8vIC',
    payload: { slot: 10, source: 'dev-r4.4.8' },
  },
] as const;

const FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS = [
  {
    kind: 'provider_account_usage_snapshot',
    ciphertext: 'oQUhIiMkJSYnKCkqKywtLi8wMTIzNDU2NziBJ/3OYHQgvc/8sPig5WoVu1JjU09qFpCDgpr5aG34XQ==',
    payload: { alias: 'pau5' },
  },
  {
    kind: 'session_respawn_environment',
    ciphertext: 'oQYhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg4WFEkTnogRv0Z2DoTzy+WDJTQ6xql9jSUSLQaBnFEqS2XI7w=',
    payload: { alias: 'respawn6' },
  },
  {
    kind: 'qualified_connected_account_configuration',
    ciphertext: 'oQghIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzhi7NCmuVdFpB4TqAoHOHCWiUF1bGD8/dCIBKtm+EdHWXig7w==',
    payload: { alias: 'config8' },
  },
] as const;

type PinnedHistoricalAccountScopedReader = Readonly<{
  provenance: string;
  kindByteByDomain: Readonly<Partial<Record<AccountScopedBlobKind, number>>>;
}>;

const RELEASED_CLI_V0_2_1_ACCOUNT_SCOPED_READER = {
  provenance:
    'cli-v0.2.1@b1d15a8a9c241737d1ca9b167459901e6259173a',
  kindByteByDomain: {
    account_settings: 1,
    automation_template_payload: 2,
    connected_service_credential: 3,
    connected_service_quota_snapshot: 4,
  },
} satisfies PinnedHistoricalAccountScopedReader;

const ROLLBACK_REMOTE_DEV_165A_ACCOUNT_SCOPED_READER = {
  provenance:
    'remote-dev@165a9365bcecc866fef967c3d86454de602a47ea',
  kindByteByDomain: {
    account_settings: 1,
    automation_template_payload: 2,
    connected_service_credential: 3,
    connected_service_quota_snapshot: 4,
    session_respawn_environment: 5,
    provider_account_usage_snapshot: 6,
    session_organization_display: 7,
    session_first_intent: 8,
  },
} satisfies PinnedHistoricalAccountScopedReader;

/**
 * Simulates the strict v1 reader algorithm and canonical kind maps observed at
 * the immutable source baselines above. It deliberately does not use Dev's
 * alias-aware reader, so unsupported new writes cannot appear rollback-safe.
 */
function openWithPinnedHistoricalAccountScopedReader(params: Readonly<{
  reader: PinnedHistoricalAccountScopedReader;
  kind: AccountScopedBlobKind;
  ciphertext: string;
}>): unknown | null {
  const kindByte = params.reader.kindByteByDomain[params.kind];
  if (kindByte === undefined) return null;

  const bytes = decodeBase64(params.ciphertext, 'base64');
  if (
    bytes.length < 2 + tweetnacl.secretbox.nonceLength + 16
    || bytes[0] !== 0xa1
    || bytes[1] !== kindByte
  ) {
    return null;
  }
  const key = hmac(
    sha512,
    FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    new TextEncoder().encode(
      `happier:account_scoped:${params.kind}:v1`,
    ),
  ).slice(0, 32);
  const opened = tweetnacl.secretbox.open(
    bytes.slice(2 + tweetnacl.secretbox.nonceLength),
    bytes.slice(2, 2 + tweetnacl.secretbox.nonceLength),
    key,
  );
  if (!opened) return null;
  try {
    return JSON.parse(new TextDecoder().decode(opened)) as unknown;
  } catch {
    return null;
  }
}

describe('accountScopedCipher', () => {
  it('freezes canonical Account mode and content-key fingerprint vectors with the exact crypto material', () => {
    const legacySecret = new Uint8Array(32).fill(7);
    const legacy = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: legacySecret },
    });
    expect(legacy).toMatchObject({
      accountEncryptionMode: 'e2ee',
      contentPublicKeyFingerprint:
        'content-public-key-sha256:b6e2f1b418486b2714dd42bc21bffd2a9099e988572c4885713e19923cc774a6',
    });

    const machineKey = new Uint8Array(32).fill(9);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const dataKey = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'plain',
      material: { type: 'dataKey', machineKey },
      dataKeyPublicKey: publicKey,
    });
    expect(dataKey).toMatchObject({
      accountEncryptionMode: 'plain',
      contentPublicKeyFingerprint:
        'content-public-key-sha256:0710e7de882119e331610cac720c1b15288f7006f083c101777be37b19f2a8a3',
    });

    legacySecret.fill(0);
    machineKey.fill(0);
    publicKey.fill(0);
    expect(legacy.material.type).toBe('legacy');
    expect(legacy.material.type === 'legacy' && legacy.material.secret[0])
      .toBe(7);
    expect(dataKey.material.type).toBe('dataKey');
    expect(dataKey.material.type === 'dataKey' && dataKey.material.machineKey[0])
      .toBe(9);
  });

  it('rejects a data-key credential whose public key does not match its private machine key', () => {
    expect(() => createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: {
        type: 'dataKey',
        machineKey: new Uint8Array(32).fill(9),
      },
      dataKeyPublicKey: new Uint8Array(32).fill(8),
    })).toThrow(/public key/i);
  });

  it('reports only the versioned-envelope kind byte for owner admission checks', () => {
    expect(readAccountScopedCiphertextKindByte(
      FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS[5].ciphertext,
    )).toBe(6);
    expect(readAccountScopedCiphertextKindByte(
      'oQUhIiMkJSYnKCkqKywtLi8wMTIzNDU2NziBJ/3OYHQgvc/8sPig5WoVu1JjU09qFpCDgpr5aG34XQ==',
    )).toBe(5);
    expect(readAccountScopedCiphertextKindByte('not-base64')).toBeNull();
  });

  /**
   * Slots 1-4 were produced from immutable cli-v0.2.1 commit
   * b1d15a8a9c241737d1ca9b167459901e6259173a. Slots 5-8 were
   * regenerated from the kind map and v1 wire algorithm observed in exact
   * rollback predecessor remote-dev commit
   * 165a9365bcecc866fef967c3d86454de602a47ea. The slot-9 vector freezes the
   * approved r4.4.6 allocation using the same v1 wire algorithm. Slot 10 freezes
   * the approved r4.4.8 owner-metadata domain.
   */
  it('opens the provenance-pinned canonical vectors for slots 1 through 10', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };

    for (const vector of FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS) {
      const bytes = decodeBase64(vector.ciphertext, 'base64');
      expect(bytes.slice(0, 2)).toEqual(Uint8Array.of(0xa1, vector.kindByte));
      const opened = openAccountScopedBlobCiphertext({
        kind: vector.kind as AccountScopedBlobKind,
        material,
        ciphertext: vector.ciphertext,
      });
      expect(opened).toMatchObject({
        format: 'account_scoped_v1',
        kindTag: 'canonical',
        value: vector.payload,
      });
    }
  });

  it('freezes canonical kind 10 with no alias or cross-domain admission', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };
    const ownerVector = FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS[9];
    const randomBytes = (length: number) =>
      Uint8Array.from({ length }, (_, index) => index + 33);

    expect(sealSessionOwnerMetadataFixtureCiphertext({
      material,
      payload: ownerVector.payload,
      randomBytes,
    })).toBe(ownerVector.ciphertext);
    expect(sealAccountScopedBlobCiphertext({
      kind: 'session_owner_metadata',
      material,
      payload: ownerVector.payload,
      randomBytes,
    })).toBe(ownerVector.ciphertext);

    for (const vector of FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.slice(0, 9)) {
      expect(openAccountScopedBlobCiphertext({
        kind: 'session_owner_metadata',
        material,
        ciphertext: vector.ciphertext,
      })).toBeNull();
      expect(openAccountScopedBlobCiphertext({
        kind: vector.kind,
        material,
        ciphertext: ownerVector.ciphertext,
      })).toBeNull();
    }
    for (const vector of FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS) {
      expect(openAccountScopedBlobCiphertext({
        kind: 'session_owner_metadata',
        material,
        ciphertext: vector.ciphertext,
      })).toBeNull();
    }
  });

  it('opens only the bounded historical Dev tag aliases under their requested domains', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };
    for (const vector of FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS) {
      expect(openAccountScopedBlobCiphertext({
        kind: vector.kind,
        material,
        ciphertext: vector.ciphertext,
      })).toMatchObject({
        format: 'account_scoped_v1',
        kindTag: 'historical_alias',
        value: vector.payload,
      });
    }

    expect(openAccountScopedBlobCiphertext({
      kind: 'session_respawn_environment',
      material,
      ciphertext:
        FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS[0]
          .ciphertext,
    })).toBeNull();
    expect(openAccountScopedBlobCiphertext({
      kind: 'provider_account_usage_snapshot',
      material,
      ciphertext:
        FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS[1]
          .ciphertext,
    })).toBeNull();
    expect(openAccountScopedBlobCiphertext({
      kind: 'session_first_intent' as AccountScopedBlobKind,
      material,
      ciphertext:
        FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS[2]
          .ciphertext,
    })).toBeNull();
  });

  it('preserves pinned layout-0 reads while proving kind-10 layout-v1 state blocks historical readers', () => {
    // Layout-zero records carry no ownerMetadata. These vector sets therefore
    // cover every account-scoped domain registered by each historical reader;
    // kind 10 first becomes necessary with the layout-v1 owner envelope.
    const releasedLayoutZeroVectors =
      FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.slice(0, 4);
    const rollbackLayoutZeroVectors =
      FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS.slice(0, 8);

    for (const vector of releasedLayoutZeroVectors) {
      expect(openWithPinnedHistoricalAccountScopedReader({
        reader: RELEASED_CLI_V0_2_1_ACCOUNT_SCOPED_READER,
        kind: vector.kind,
        ciphertext: vector.ciphertext,
      }), RELEASED_CLI_V0_2_1_ACCOUNT_SCOPED_READER.provenance)
        .toEqual(vector.payload);
    }
    for (const vector of rollbackLayoutZeroVectors) {
      expect(openWithPinnedHistoricalAccountScopedReader({
        reader: ROLLBACK_REMOTE_DEV_165A_ACCOUNT_SCOPED_READER,
        kind: vector.kind,
        ciphertext: vector.ciphertext,
      }), ROLLBACK_REMOTE_DEV_165A_ACCOUNT_SCOPED_READER.provenance)
        .toEqual(vector.payload);
    }

    const ownerMetadataVector =
      FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS[9];
    for (const reader of [
      RELEASED_CLI_V0_2_1_ACCOUNT_SCOPED_READER,
      ROLLBACK_REMOTE_DEV_165A_ACCOUNT_SCOPED_READER,
    ]) {
      expect(reader.kindByteByDomain)
        .not.toHaveProperty('session_owner_metadata');
      expect(openWithPinnedHistoricalAccountScopedReader({
        reader,
        kind: 'session_owner_metadata',
        ciphertext: ownerMetadataVector.ciphertext,
      }), reader.provenance).toBeNull();
    }

    expect(openWithPinnedHistoricalAccountScopedReader({
      reader: ROLLBACK_REMOTE_DEV_165A_ACCOUNT_SCOPED_READER,
      kind: 'provider_account_usage_snapshot',
      ciphertext:
        FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS[0]
          .ciphertext,
    })).toBeNull();
    expect(openWithPinnedHistoricalAccountScopedReader({
      reader: ROLLBACK_REMOTE_DEV_165A_ACCOUNT_SCOPED_READER,
      kind: 'session_respawn_environment',
      ciphertext:
        FROZEN_HISTORICAL_ACCOUNT_SCOPED_ALIAS_VECTORS[1]
          .ciphertext,
    })).toBeNull();
    expect(openWithPinnedHistoricalAccountScopedReader({
      reader: ROLLBACK_REMOTE_DEV_165A_ACCOUNT_SCOPED_READER,
      kind: 'qualified_connected_account_configuration',
      ciphertext:
        FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS[8].ciphertext,
    })).toBeNull();
  });

  it('allows only the narrow compatibility sealer to emit the frozen kind-4 old-reader representation', () => {
    const material: AccountScopedCryptoMaterial = {
      type: 'dataKey',
      machineKey: FROZEN_ACCOUNT_SCOPED_VECTOR_MACHINE_KEY,
    };
    const payload = { slot: 4, source: 'cli-v0.2.1' };
    const randomBytes = (length: number) =>
      Uint8Array.from({ length }, (_, index) => index + 33);

    expect(sealLegacyConnectedServiceQuotaSnapshotCompatibilityCiphertext({
      material,
      payload,
      randomBytes,
    })).toBe(FROZEN_CANONICAL_ACCOUNT_SCOPED_VECTORS[3].ciphertext);
    expect(() => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material,
      payload,
      randomBytes,
    })).toThrow(/legacy read-only/i);
  });

  it('seals/opens without Buffer or atob/btoa globals', () => {
    const prevBuffer = (globalThis as any).Buffer;
    const prevAtob = (globalThis as any).atob;
    const prevBtoa = (globalThis as any).btoa;
    (globalThis as any).Buffer = undefined;
    (globalThis as any).atob = undefined;
    (globalThis as any).btoa = undefined;

    try {
      const kind: AccountScopedBlobKind = 'account_settings';
      const machineKey = new Uint8Array(32).fill(9);
      const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
      const payload = { claudeLocalPermissionBridgeEnabled: true, schemaVersion: 1 };

      const ciphertext = sealAccountScopedBlobCiphertext({
        kind,
        material,
        payload,
        randomBytes: deterministicRandomBytesFactory(),
      });

      const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
      expect(opened?.format).toBe('account_scoped_v1');
      expect(opened?.value).toEqual(payload);
    } finally {
      (globalThis as any).Buffer = prevBuffer;
      (globalThis as any).atob = prevAtob;
      (globalThis as any).btoa = prevBtoa;
    }
  });

  it('seals and opens v1 ciphertext with dataKey material', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const machineKey = new Uint8Array(32).fill(9);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { claudeLocalPermissionBridgeEnabled: true, schemaVersion: 1 };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('seals and opens v1 ciphertext for connected service credentials', () => {
    const kind: AccountScopedBlobKind = 'connected_service_credential';
    const machineKey = new Uint8Array(32).fill(4);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { serviceId: 'openai-codex', profileId: 'work', token: 'ciphertext-payload' };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('rejects sealing new connected service quota snapshot ciphertexts as legacy read-only', () => {
    const kind: AccountScopedBlobKind = 'connected_service_quota_snapshot';
    const machineKey = new Uint8Array(32).fill(5);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: Date.now(), meters: [] };

    expect(() => sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    })).toThrow(/legacy read-only/i);
  });

  it('seals and opens v1 ciphertext for session respawn environment continuity', () => {
    const kind: AccountScopedBlobKind = 'session_respawn_environment';
    const machineKey = new Uint8Array(32).fill(6);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = {
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      CODEX_HOME: '/tmp/codex-home',
    };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('seals and opens v1 ciphertext for session organization display payloads', () => {
    const kind: AccountScopedBlobKind = 'session_organization_display';
    const machineKey = new Uint8Array(32).fill(7);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { name: 'Pinned work', color: '#4f46e5' };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext });
    expect(opened?.format).toBe('account_scoped_v1');
    expect(opened?.value).toEqual(payload);
  });

  it('emits only the canonical account-scoped v1 kind bytes', () => {
    const machineKey = new Uint8Array(32).fill(8);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { value: 'stable-kind-byte' };
    const cases: ReadonlyArray<readonly [AccountScopedBlobKind, number]> = [
      ['session_respawn_environment', 5],
      ['provider_account_usage_snapshot', 6],
      ['session_organization_display', 7],
      ['session_first_intent', 8],
      ['qualified_connected_account_configuration', 9],
      ['session_owner_metadata', 10],
    ];

    for (const [kind, expectedKindByte] of cases) {
      const ciphertext = sealAccountScopedBlobCiphertext({
        kind,
        material,
        payload,
        randomBytes: deterministicRandomBytesFactory(),
      });

      const bytes = decodeBase64(ciphertext, 'base64');
      expect(bytes[0]).toBe(0xa1);
      expect(bytes[1]).toBe(expectedKindByte);
      expect(openAccountScopedBlobCiphertext({ kind, material, ciphertext })?.value).toEqual(payload);
    }
  });

  it('allows legacy and dataKey devices to read the same v1 ciphertext', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(7);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);

    const legacyMaterial: AccountScopedCryptoMaterial = { type: 'legacy', secret: recoverySecret };
    const dataKeyMaterial: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const payload = { codexBackendMode: 'acp' };

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind,
      material: legacyMaterial,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(openAccountScopedBlobCiphertext({ kind, material: legacyMaterial, ciphertext })?.value).toEqual(payload);
    expect(openAccountScopedBlobCiphertext({ kind, material: dataKeyMaterial, ciphertext })?.value).toEqual(payload);
  });

  it('leaves untagged recovery-secret payloads to the account-settings owner for domain validation', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(3);
    const payload = { analyticsOptOut: false };

    const nonce = new Uint8Array(24).fill(4);
    const plaintext = new TextEncoder().encode(stringifySerializedJsonValue(payload));
    const boxed = tweetnacl.secretbox(plaintext, nonce, recoverySecret);
    const legacyBytes = new Uint8Array(nonce.length + boxed.length);
    legacyBytes.set(nonce, 0);
    legacyBytes.set(boxed, nonce.length);
    const legacyCiphertext = encodeBase64(legacyBytes, 'base64');

    const material: AccountScopedCryptoMaterial = { type: 'legacy', secret: recoverySecret };
    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext: legacyCiphertext });
    expect(opened).toBeNull();
  });

  it('leaves untagged machine-key payloads to the automation owner for domain validation', () => {
    const kind: AccountScopedBlobKind = 'automation_template_payload';
    const machineKey = new Uint8Array(32).fill(6);
    const payload = { directory: '/tmp/project', prompt: 'Run checks' };

    const nonce = new Uint8Array(24).fill(8);
    const plaintext = new TextEncoder().encode(stringifySerializedJsonValue(payload));
    const boxed = tweetnacl.secretbox(plaintext, nonce, machineKey);
    const legacyBytes = new Uint8Array(nonce.length + boxed.length);
    legacyBytes.set(nonce, 0);
    legacyBytes.set(boxed, nonce.length);
    const legacyCiphertext = encodeBase64(legacyBytes, 'base64');

    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext: legacyCiphertext });
    expect(opened).toBeNull();
  });

  it('does not treat an untagged legacy nonce collision as a requested-domain envelope', () => {
    const kind: AccountScopedBlobKind = 'account_settings';
    const recoverySecret = new Uint8Array(32).fill(3);
    const payload = { analyticsOptOut: false };

    // Collision case: legacy nonce begins with the account-scoped magic byte and kind byte.
    const nonce = new Uint8Array(24).fill(4);
    nonce[0] = 0xa1;
    nonce[1] = 1; // account_settings kind byte

    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const boxed = tweetnacl.secretbox(plaintext, nonce, recoverySecret);
    const legacyBytes = new Uint8Array(nonce.length + boxed.length);
    legacyBytes.set(nonce, 0);
    legacyBytes.set(boxed, nonce.length);
    const legacyCiphertext = encodeBase64(legacyBytes, 'base64');

    const material: AccountScopedCryptoMaterial = { type: 'legacy', secret: recoverySecret };
    const opened = openAccountScopedBlobCiphertext({ kind, material, ciphertext: legacyCiphertext });
    expect(opened).toBeNull();
    expect(openAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material,
      ciphertext: legacyCiphertext,
    })).toBeNull();
  });

  it('returns null when kind does not match', () => {
    const payload = { x: 1 };
    const machineKey = new Uint8Array(32).fill(8);
    const material: AccountScopedCryptoMaterial = { type: 'dataKey', machineKey };
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material,
      payload,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(openAccountScopedBlobCiphertext({ kind: 'automation_template_payload', material, ciphertext })).toBeNull();
  });
});
