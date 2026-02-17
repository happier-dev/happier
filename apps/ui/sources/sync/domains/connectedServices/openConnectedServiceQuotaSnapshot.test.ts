import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceQuotaSnapshotV1Schema,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import { encodeBase64 } from '@/encryption/base64';

import { openConnectedServiceQuotaSnapshot } from './openConnectedServiceQuotaSnapshot';

function fixedRandomBytes(byte: number) {
  return (length: number) => new Uint8Array(length).fill(byte);
}

describe('openConnectedServiceQuotaSnapshot', () => {
  it('opens ciphertext in legacy auth mode', () => {
    const secretBytes = new Uint8Array(32).fill(3);
    const credentials = { token: 't', secret: encodeBase64(secretBytes, 'base64url') } as const;

    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: 'pro',
      accountLabel: 'user@example.com',
      meters: [],
    });

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material: { type: 'legacy', secret: secretBytes },
      payload: snapshot,
      randomBytes: fixedRandomBytes(9),
    });

    const opened = openConnectedServiceQuotaSnapshot(credentials, {
      format: 'account_scoped_v1',
      ciphertext,
    });
    expect(opened).toEqual(snapshot);
  });

  it('opens ciphertext in dataKey auth mode', () => {
    const machineKey = new Uint8Array(32).fill(7);
    const credentials = {
      token: 't',
      encryption: { publicKey: encodeBase64(new Uint8Array(32).fill(1)), machineKey: encodeBase64(machineKey) },
    } as const;

    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'personal',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    });

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material: { type: 'dataKey', machineKey },
      payload: snapshot,
      randomBytes: fixedRandomBytes(4),
    });

    const opened = openConnectedServiceQuotaSnapshot(credentials, {
      format: 'account_scoped_v1',
      ciphertext,
    });
    expect(opened).toEqual(snapshot);
  });
});
