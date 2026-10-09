import { describe, expect, it } from 'vitest';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol/crypto/boxBundle';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { parseMachineBootstrapRows, resolveMachineProtectedActionMaterial } from './machines.js';

describe('shared Machine protected Action material', () => {
  const actorMaterial = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(17) };
  const machineKey = new Uint8Array(32).fill(23);
  const recipientEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: machineKey,
    recipientPublicKey: deriveBoxPublicKeyFromSeed(actorMaterial.machineKey),
    randomBytes: (length) => new Uint8Array(length).fill(31),
  }));

  function resolve(envelope: string | null, accessState = 'ready') {
    return resolveMachineProtectedActionMaterial({
      rows: parseMachineBootstrapRows([{
        id: 'alice-machine', kind: 'persistent', active: true,
        revokedAt: null, replacedByMachineId: null, installationId: 'alice-installation',
        dataEncryptionKey: envelope,
        access: { custodian: { accountId: 'alice', displayName: 'Alice' },
          role: 'use', resourceMode: 'e2ee', accessState },
      }]),
      target: { kind: 'machine', machineId: 'alice-machine' },
      homeServerIdentityId: 'home', accountId: 'bob', accountMaterial: actorMaterial,
    });
  }

  it('opens the exact target Machine key delivered to the actor', () => {
    expect(resolve(recipientEnvelope)).toEqual({ kind: 'machine', material: { type: 'dataKey', machineKey } });
  });

  it.each(['bob', 'alice'])('selects a Plain resource independently of %s Account encryption mode', (accountId) => {
    const rows = parseMachineBootstrapRows([{
      id: 'alice-machine', kind: 'persistent', active: true,
      revokedAt: null, replacedByMachineId: null, installationId: 'alice-installation',
      dataEncryptionKey: null,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' },
        role: 'use', resourceMode: 'plain', accessState: 'ready' },
    }]);
    expect(resolveMachineProtectedActionMaterial({ rows,
      target: { kind: 'machine', machineId: 'alice-machine' },
      homeServerIdentityId: 'home', accountId,
    })).toEqual({ kind: 'plain' });
  });

  it('requests Account material only after selecting an E2EE resource', () => {
    const rows = parseMachineBootstrapRows([{
      id: 'alice-machine', kind: 'persistent', active: true,
      revokedAt: null, replacedByMachineId: null, installationId: 'alice-installation',
      dataEncryptionKey: recipientEnvelope,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' },
        role: 'use', resourceMode: 'e2ee', accessState: 'ready' },
    }]);
    expect(resolveMachineProtectedActionMaterial({ rows,
      target: { kind: 'machine', machineId: 'alice-machine' }, homeServerIdentityId: 'home', accountId: 'bob',
    })).toEqual({ kind: 'needs_account_material' });
  });

  it('refuses a Plain resource projection carrying an encrypted envelope', () => {
    const rows = parseMachineBootstrapRows([{
      id: 'alice-machine', kind: 'persistent', active: true,
      revokedAt: null, replacedByMachineId: null, installationId: 'alice-installation',
      dataEncryptionKey: recipientEnvelope,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' },
        role: 'use', resourceMode: 'plain', accessState: 'ready' },
    }]);
    expect(resolveMachineProtectedActionMaterial({ rows,
      target: { kind: 'machine', machineId: 'alice-machine' }, homeServerIdentityId: 'home', accountId: 'bob',
    })).toEqual({ kind: 'unavailable' });
  });

  it('never substitutes actor Account material for absent, stale or wrong-recipient shared material', () => {
    expect(resolve(null)).toEqual({ kind: 'unavailable' });
    expect(resolve(recipientEnvelope, 'key_pending')).toEqual({ kind: 'unavailable' });
    const otherEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: machineKey,
      recipientPublicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(5)),
      randomBytes: (length) => new Uint8Array(length).fill(29),
    }));
    expect(resolve(otherEnvelope)).toEqual({ kind: 'unavailable' });
  });
});
