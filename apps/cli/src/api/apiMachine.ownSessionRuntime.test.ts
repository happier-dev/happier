import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { Machine } from '@/api/types';
import { ApiMachineClient } from './apiMachine';

const osStore = vi.hoisted(() => ({
  identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null,
  credentials: null as StoredCredentials | null,
  reads: [] as string[],
}));
// Credential files and installation key storage are the actual OS boundaries.
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentialsForServerId: async (serverId: string) => {
    osStore.reads.push(serverId);
    return osStore.credentials;
  },
}));
vi.mock('@/daemon/identity/store', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/identity/store')>(),
  readInstallationIdentityIfExistsSync: () => osStore.identity,
}));

describe('ApiMachine own Session Account read custody', () => {
  it('provides only its verified owner material and retires it after credential or installation replacement', async () => {
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
    osStore.reads.length = 0;
    // Authenticated Home profile is the network boundary; Account resolution stays real.
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, statusText: 'OK',
      headers: {}, config: { headers: new AxiosHeaders() }, data: { id: 'alice' } });
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient('alice-token', machine);
    let replaceCredentialDuringAdmission = false;
    const ingress: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: machine.id,
        installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => {
        if (replaceCredentialDuringAdmission) osStore.credentials = {
          token: 'replacement-token', encryption: null, credentialProvenance: 'stored_session',
        };
        return true;
      } };
    try {
      await expect(client.resolveOwnSessionRuntime({ ...ingress,
        machineAdmission: { ...ingress.machineAdmission!, actorAccountId: 'bob' } })).resolves.toBeNull();
      expect(osStore.reads).toEqual([]);
      expect(profile).not.toHaveBeenCalled();
      const runtime = await client.resolveOwnSessionRuntime(ingress);
      expect(runtime).toMatchObject({ accountId: 'alice', serverId: configuration.activeServerId,
        machineId: machine.id, credentials: osStore.credentials });
      expect(profile).toHaveBeenCalledWith(expect.stringContaining('/v1/account/profile'),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer alice-token' }) }));
      osStore.reads.length = 0;
      await expect(client.resolveOwnSessionRuntime({ ...ingress, machineAdmission: {
        ...ingress.machineAdmission!, actorAccountId: 'bob', custodianAccountId: 'bob',
      } })).resolves.toBeNull();
      expect(osStore.reads).toEqual([]);
      await expect(runtime?.isCurrent?.()).resolves.toBe(true);
      replaceCredentialDuringAdmission = true;
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      replaceCredentialDuringAdmission = false;
      await expect(client.resolveOwnSessionRuntime(ingress)).resolves.toBeNull();
      osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
      osStore.identity = { ...osStore.identity!, installationId: '22222222-2222-4222-8222-222222222222' };
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      await expect(client.resolveOwnSessionRuntime({ ...ingress, machineAdmission: {
        ...ingress.machineAdmission!, installationId: osStore.identity.installationId,
      } })).resolves.toBeNull();
    } finally {
      profile.mockRestore();
      osStore.identity = null;
      osStore.credentials = null;
    }
  });
});
