import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { withTempDir } from '@/testkit/fs/tempDir';
import { authorizeMachineRpcRequest, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';
import { registerMachineNpmRegistryProfileRpcHandlers } from './rpcHandlers.npmRegistryProfiles';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { resolveMachineAdmission, setMachineAccessGrantInTx } from '../../../../server/sources/app/machines/machineAccess';
import { makeShareEligibleForTest } from '../../../../server/sources/testkit/shareEligibility.testkit';

describe('npm profile Machine admission', () => {
  let database: LightSqliteHarness;
  beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'npm-profile-admission-', initAuth: true, initEncrypt: true }); }, 120_000);
  afterAll(async () => { await database?.close(); });
  it('lets an admitted Manage member read the real snapshot while refusing Use and foreign Accounts', async () => {
    await withTempDir('npm-profile-admission-', async happyHomeDir => {
      const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
      const member = await db.account.create({ data: { encryptionMode: 'plain' } });
      const machine = await db.machine.create({ data: { id: `npm-${owner.id}`, accountId: owner.id,
        installationId: 'installation', active: true,
        metadata: encodePlainMachineStoredContent({ host: 'npm-host', platform: 'linux', happyCliVersion: 'test', homeDir: happyHomeDir, happyHomeDir }),
        daemonState: encodePlainMachineStoredContent({ status: 'running' }),
        dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
      await makeShareEligibleForTest(owner.id, member.id);
      const grant = async (level: 'admin' | 'view') => expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
        actorAccountId: owner.id, machineId: machine.id, principal: { kind: 'account', accountId: member.id }, level,
      }))).toMatchObject({ kind: 'saved' });
      await grant('admin');
      const service = createNpmRegistryProfileService({ happyHomeDir });
      await service.mutate({ action: 'add', machineId: machine.id, expectedRevision: 0,
        mutationId: 'add-registry', profileId: 'registry_acme', profile: {
          displayName: 'Acme', origin: 'https://registry.acme.test', scopes: ['@acme'],
          useAsDefault: false, allowPrivateNetwork: false,
        } });
      // Only Home's authenticated admission verification crosses a network boundary.
      const boundary: MachineRpcAdmissionBoundary = {
        machineId: machine.id, resolveInstallationId: () => 'installation',
        resolveCustodianAccountId: async () => owner.id, resolveHomeServerIdentityId: async () => 'home',
        verifyMachineAdmission: async ({ context, method }) => {
          expect(method).toBe(`${context.machineId}:${RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET}`);
          const admitted = await resolveMachineAdmission({ actorAccountId: context.actorAccountId, machineId: context.machineId,
            rpcMethod: method.slice(context.machineId.length + 1) });
          return admitted.kind === 'admitted' && admitted.role === context.role;
        },
      };
      const rpc = new RpcHandlerManager({ scopePrefix: machine.id, encryptionMode: 'plain', logger: () => {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, boundary) });
      registerMachineNpmRegistryProfileRpcHandlers({ rpcHandlerManager: rpc, machineId: machine.id, service });
      const admission = { actorAccountId: member.id, custodianAccountId: owner.id, machineId: machine.id,
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
      const request = { method: `${machine.id}:${RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET}`,
        params: { machineId: machine.id }, machineAdmission: admission };
      expect(await rpc.handleRequest(request)).toMatchObject({ status: 'success',
        snapshot: { revision: 1, profiles: [{ profileId: 'registry_acme', hasCredentials: false }] } });
      expect(await rpc.handleRequest({ ...request, machineAdmission: { ...admission, actorAccountId: owner.id } }))
        .toMatchObject({ status: 'success' });
      await grant('view');
      for (const machineAdmission of [
        { ...admission, role: 'use' as const }, { ...admission, actorAccountId: 'foreign' },
        { ...admission, custodianAccountId: 'foreign' }, { ...admission, installationId: 'replaced' },
      ]) expect(await rpc.handleRequest({ ...request, machineAdmission })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    });
  });
});
