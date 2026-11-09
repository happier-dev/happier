import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceQuotaSnapshotV1Schema,
} from '@happier-dev/protocol/connect/connected-service-schemas';
import { sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext } from '@happier-dev/protocol/testing/accountScopedCipherFixtures';

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
      recoveryCredits: { availableCount: 1, credits: [{ id: 'reset-1', kind: 'usage_limit_reset', status: 'available' }] },
    });

    const ciphertext = sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
      material: { type: 'legacy', secret: secretBytes },
      payload: { ...snapshot, retired: true, recoveryCredits: { ...snapshot.recoveryCredits, retired: true } },
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

    const ciphertext = sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
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

  it.each(['current', 'predecessor'] as const)('retains encrypted %s recovery-credit identity while dropping retired fields', (shape) => {
    const machineKey = new Uint8Array(32).fill(7);
    const credentials = {
      token: 't',
      encryption: { publicKey: encodeBase64(new Uint8Array(32).fill(1)), machineKey: encodeBase64(machineKey) },
    } as const;
    const snapshot = {
      v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: 1,
      staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [],
      retired: true,
      recoveryCredits: {
        ...(shape === 'predecessor' ? { kind: 'usage_limit_resets' } : {}),
        availableCount: 1, retired: true,
        credits: [{
          ...(shape === 'predecessor' ? { providerCreditId: 'reset-1' } : { id: 'reset-1' }),
          kind: 'usage_limit_reset', status: 'available', retired: true,
        }],
      },
    };
    const seal = (payload: unknown) => ({
      format: 'account_scoped_v1' as const,
      ciphertext: sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
        material: { type: 'dataKey', machineKey }, payload, randomBytes: fixedRandomBytes(4),
      }),
    });
    expect(openConnectedServiceQuotaSnapshot(credentials, seal(snapshot))).toEqual({
      v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: 1,
      staleAfterMs: 60_000, planLabel: null, accountLabel: null, meters: [],
      recoveryCredits: {
        availableCount: 1,
        credits: [{ id: 'reset-1', kind: 'usage_limit_reset', status: 'available' }],
      },
    });
    expect(openConnectedServiceQuotaSnapshot(credentials, seal({
      ...snapshot,
      recoveryCredits: { ...snapshot.recoveryCredits, availableCount: -1 },
    }))).toBeNull();
    expect(() => openConnectedServiceQuotaSnapshot({ token: 'token-only' }, seal(snapshot))).toThrow();
  });
});
