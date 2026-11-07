import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { withTempDir } from '@/testkit/fs/tempDir';
import { inspectRetiredWorkspaceReplicationState } from '@/workspaces/sync/workspaceSyncLegacyState';
import { authorizeMachineRpcRequest, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { resolveMachineAdmission, setMachineAccessGrantInTx } from '../../../../server/sources/app/machines/machineAccess';
import { makeShareEligibleForTest } from '../../../../server/sources/testkit/shareEligibility.testkit';

describe('legacy Workspace Sync diagnostic admission', () => {
  let database: LightSqliteHarness;
  beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'legacy-sync-admission-', initAuth: true, initEncrypt: true }); }, 120_000);
  afterAll(async () => { await database?.close(); });

  it('admits Manage without execution isolation and refuses Use and unrelated Accounts', async () => {
    await withTempDir('legacy-sync-admission-', async happyHomeDir => {
      const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
      const member = await db.account.create({ data: { encryptionMode: 'plain' } });
      const machine = await db.machine.create({ data: { id: `legacy-${owner.id}`, accountId: owner.id,
        installationId: 'installation', active: true,
        metadata: encodePlainMachineStoredContent({ host: 'legacy-host', platform: 'linux', happyCliVersion: 'test', homeDir: happyHomeDir, happyHomeDir }),
        daemonState: encodePlainMachineStoredContent({ status: 'running' }),
        dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
      await makeShareEligibleForTest(owner.id, member.id);
      const grant = async (level: 'admin' | 'view') => expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
        actorAccountId: owner.id, machineId: machine.id, principal: { kind: 'account', accountId: member.id }, level,
      }))).toMatchObject({ kind: 'saved' });
      await grant('admin');
      const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_LEGACY_INSPECT;
      const admit = (actorAccountId: string) => resolveMachineAdmission({ actorAccountId, machineId: machine.id, rpcMethod: method });
      // Only Home's authenticated admission verification is a network boundary.
      const boundary: MachineRpcAdmissionBoundary = {
        machineId: machine.id, resolveInstallationId: () => 'installation',
        resolveCustodianAccountId: async () => owner.id, resolveHomeServerIdentityId: async () => 'home',
        verifyMachineAdmission: async ({ context }) => {
          const admitted = await admit(context.actorAccountId);
          return admitted.kind === 'admitted' && admitted.role === context.role;
        },
      };
      const admitted = await admit(member.id);
      expect(admitted).toMatchObject({ kind: 'admitted', role: 'manage' });
      if (admitted.kind !== 'admitted') throw new Error('Manage admission refused');
      const { kind: _kind, ...admission } = admitted;
      // No requester execution identity or isolation runtime is installed.
      expect(await authorizeMachineRpcRequest({ method: `${machine.id}:${method}`, params: {}, machineAdmission: admission }, boundary))
        .toMatchObject({ ok: true });
      expect(await inspectRetiredWorkspaceReplicationState({ activeServerDir: happyHomeDir })).toEqual({ status: 'absent' });
      await mkdir(join(happyHomeDir, 'workspace-replication'));
      expect(await inspectRetiredWorkspaceReplicationState({ activeServerDir: happyHomeDir }))
        .toEqual({ status: 'preserved', path: join(happyHomeDir, 'workspace-replication') });
      expect(await admit(owner.id)).toMatchObject({ kind: 'admitted', role: 'manage' });
      await grant('view');
      expect(await admit(member.id)).toMatchObject({ kind: 'denied', code: 'access_denied' });
      expect(await admit('unrelated-account')).toMatchObject({ kind: 'denied', code: 'access_denied' });
      for (const machineAdmission of [
        { ...admission, role: 'use' as const }, { ...admission, actorAccountId: 'unrelated-account' },
      ]) expect(await authorizeMachineRpcRequest({ method: `${machine.id}:${method}`, params: {}, machineAdmission }, boundary))
        .toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
    });
  });
});
