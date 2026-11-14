import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { MachinePoolListOutputV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { readMachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';

import type { StoredCredentials } from '@/persistence';
import { openCliMachineReferencePoolList } from './machineReferences';

const credentials = { token: 'interactive', encryption: null } satisfies StoredCredentials;
const pool = {
  pool: {
    id: '12345678-1234-4234-8234-123456789abc',
    name: { kind: 'available' as const, label: { content: { t: 'plain' as const, v: 'Private builders' }, recipientEnvelope: null } },
    description: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    members: [{ machineId: 'machine-1', priorityTier: 0, enabled: true, state: 'connected' as const }],
  },
  availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
};

describe('CLI managed Machine reference Pool labels', () => {
  it('opens the complete raw Pool list before the reference census can consume a name', () => {
    const raw = MachinePoolListOutputV1Schema.parse({ pools: [pool] });
    expect(openCliMachineReferencePoolList({ raw, credentials, accountContentEncryptionMode: 'plain' })).toMatchObject({
      pools: [{ pool: { name: 'Private builders' } }],
    });
  });

  it('withholds the Pool source when its display label cannot be opened', () => {
    const raw = MachinePoolListOutputV1Schema.parse({ pools: [{
      ...pool,
      pool: { ...pool.pool, name: { kind: 'unavailable' } },
    }] });
    expect(openCliMachineReferencePoolList({ raw, credentials, accountContentEncryptionMode: 'plain' })).toBeNull();
  });

  it('uses the captured Account policy for private Pools without applying it to Team Pool labels', () => {
    const privatePool = MachinePoolListOutputV1Schema.parse({ pools: [pool] });
    expect(openCliMachineReferencePoolList({
      raw: privatePool,
      credentials,
      accountContentEncryptionMode: 'e2ee',
    })).toBeNull();

    const teamPool = MachinePoolListOutputV1Schema.parse({ pools: [{
      ...pool,
      pool: { ...pool.pool, audience: { kind: 'team', teamId: 'team-1' } },
    }] });
    expect(openCliMachineReferencePoolList({
      raw: teamPool,
      credentials,
      accountContentEncryptionMode: 'e2ee',
    })).toMatchObject({ pools: [{ pool: { name: 'Private builders' } }] });
  });

  it('opens an E2EE Pool name with the stored Account material before census', () => {
    const recoverySecret = new Uint8Array(32).fill(17);
    const accountKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const dataKey = new Uint8Array(32).fill(23);
    try {
      const envelope = sealEncryptedDataKeyEnvelopeV1({
        dataKey,
        recipientPublicKey,
        randomBytes: (length) => new Uint8Array(length).fill(29),
      });
      const stored = sealPrivateLabelV1({
        mode: 'e2ee',
        binding: { entity: 'machine_pool', field: 'name', id: pool.pool.id },
        value: 'Encrypted builders',
        dataKey,
        recipients: [{
          accountId: 'account-1',
          envelope: {
            encryptedDataKey: encodeBase64(envelope, 'base64'),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientPublicKey),
          },
        }],
        randomBytes: (length) => new Uint8Array(length).fill(31),
      });
      const raw = MachinePoolListOutputV1Schema.parse({ pools: [{
        ...pool,
        pool: {
          ...pool.pool,
          name: {
            kind: 'available',
            label: { content: stored.content, recipientEnvelope: stored.recipients[0]!.envelope },
          },
        },
      }] });

      expect(openCliMachineReferencePoolList({
        raw,
        credentials: { token: 'interactive', encryption: { type: 'legacy', secret: recoverySecret } },
        accountContentEncryptionMode: 'e2ee',
      })).toMatchObject({ pools: [{ pool: { name: 'Encrypted builders' } }] });
    } finally {
      dataKey.fill(0);
      accountKey.fill(0);
    }
  });

  it('lets the real reference census display only an opened Pool name', async () => {
    const raw = MachinePoolListOutputV1Schema.parse({ pools: [pool] });
    const census = async (readPools: () => Promise<ReturnType<typeof openCliMachineReferencePoolList>>) =>
      await readMachineReferenceCensusV1({ homeId: 'home', machineId: 'machine-1' }, {
        artifacts: { list: async () => ({ coverage: 'complete' as const, items: [] }), read: async () => null, readMany: async () => [] },
        readSettings: async () => { throw new Error('profiles_not_needed'); },
        readPools: async () => {
          const opened = await readPools();
          if (!opened) throw new Error('machine_pool_private_label_unavailable');
          return opened;
        },
        readAssignments: async () => ({ automations: [], nextCursor: null }),
      });

    await expect(census(async () => openCliMachineReferencePoolList({
      raw,
      credentials,
      accountContentEncryptionMode: 'plain',
    }))).resolves.toMatchObject({
      references: [{ kind: 'machine_pool', id: pool.pool.id, name: 'Private builders' }],
      unavailable: expect.not.arrayContaining(['pools']),
    });
    const unavailable = MachinePoolListOutputV1Schema.parse({ pools: [{
      ...pool,
      pool: { ...pool.pool, name: { kind: 'unavailable' } },
    }] });
    await expect(census(async () => openCliMachineReferencePoolList({
      raw: unavailable,
      credentials,
      accountContentEncryptionMode: 'plain',
    }))).resolves.toMatchObject({
      references: [],
      unavailable: expect.arrayContaining(['pools']),
    });
  });
});
