import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { MachineSecurityInspectResultV1Schema } from '@happier-dev/protocol/machines/security/machineSecurityInspectV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';

const homeDatabase = vi.hoisted(() => ({ current: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary> | null }));
vi.mock('../../../../server/sources/storage/db', () => ({
  db: {
    machine: {
      findFirst: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findFirst']>) => homeDatabase.current!.db.machine.findFirst(...args),
      findUnique: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findUnique']>) => homeDatabase.current!.db.machine.findUnique(...args),
      findMany: (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findMany']>) => homeDatabase.current!.db.machine.findMany(...args),
    },
    $transaction: <T>(operation: (tx: ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']) => Promise<T>) => homeDatabase.current!.db.$transaction(operation),
  },
  getDbProviderFromEnv: () => 'postgres',
}));

describe('Machine Security inspection', () => {
  it.skipIf(process.platform !== 'linux')('reads a failing update and its review target, then refuses to grade stale evidence', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const input = { machineId: fixture.machine.id };
    const requester = fixture.context('machines.setup.plan');
    const invoke = (settled?: 'settled') => fixture.client.invokeLocalMachineAction(RPC_METHODS.MACHINES_SECURITY_INSPECT, {
      ...input, ...(settled ? { observation: settled } : {}),
    }, {
      rpcContext: requester,
    });
    const homeReads = vi.mocked(axios.get).mock.calls.length;
    const homeWrites = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected Home POST during Security inspection'));
    await expect(fixture.client.invokeLocalMachineAction(RPC_METHODS.MACHINES_SECURITY_INSPECT, input))
      .resolves.toMatchObject({ ok: false, errorCode: 'machine_access_denied' });
    const result = MachineSecurityInspectResultV1Schema.parse(await invoke());
    expect(result).toMatchObject({
      grade: { kind: 'incomplete', lowerBand: 'C', upperBand: 'F' },
      rows: expect.arrayContaining([
        { check: 'osUpdates', state: 'fail', evidence: { pendingAll: 1, pendingSecurity: 1 },
          repair: { actionId: 'machines.setup.plan', target: input, inputHints: { scope: 'security' } } },
        { check: 'rebootRequired', state: 'pass', evidence: { rebootNeeded: false } },
      ]),
    });
    const settled = MachineSecurityInspectResultV1Schema.parse(await invoke('settled'));
    expect(settled).toMatchObject({ grade: result.grade, rows: result.rows });
    expect(JSON.parse(await readFile(fixture.statePath, 'utf8'))).toMatchObject({ updatesChecks: 1, effects: [] });
    const bin = join(dirname(fixture.statePath), 'bin');
    // The fixture still lists jq as upgradable; only the authoritative dpkg hold changes.
    await writeFile(join(bin, 'dpkg-query'), "#!/bin/sh\nprintf 'jq\\thold ok installed\\t0.5\\tamd64\\n'\n");
    const held = MachineSecurityInspectResultV1Schema.parse(await invoke());
    expect(held).toMatchObject({
      grade: { kind: 'incomplete', lowerBand: 'A', upperBand: 'F' },
      rows: expect.arrayContaining([{ check: 'osUpdates', state: 'pass', evidence: { pendingAll: 0, pendingSecurity: 0 } }]),
      updates: { heldPackages: ['jq'] },
    });
    const manageAdmission = requester.machineAdmission;
    if (!manageAdmission) throw new Error('Expected installed Machine test admission');
    const readOnly = MachineSecurityInspectResultV1Schema.parse(await fixture.client.invokeLocalMachineAction(
      RPC_METHODS.MACHINES_SECURITY_INSPECT, { ...input, observation: 'settled' },
      { rpcContext: { ...requester, machineAdmission: { ...manageAdmission, actorAccountId: 'bob', role: 'use' } } },
    ));
    expect(readOnly.rows).toEqual(held.rows);
    expect(readOnly.updates).not.toHaveProperty('heldPackages');
    await writeFile(join(bin, 'python3'), '#!/bin/sh\nexit 1\n');
    expect(MachineSecurityInspectResultV1Schema.parse(await invoke())).toMatchObject({
      grade: { kind: 'incomplete', lowerBand: 'A', upperBand: 'F' },
      rows: expect.arrayContaining([{
        check: 'osUpdates', state: 'unread', reason: 'required_fact_unavailable',
      }]),
    });
    expect(vi.mocked(axios.get).mock.calls).toHaveLength(homeReads);
    expect(homeWrites).not.toHaveBeenCalled();
    expect(fixture.rootLaunches).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('admits a different Account through Home and refuses an ungranted Account before native work', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const manager: unknown = Reflect.get(fixture.client, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Expected installed daemon RPC owner');
    const machineId = fixture.machine.id;
    const installation = { version: 1 as const, installationId: fixture.installation.installationId,
      createdAt: Date.now(), privateKey: Buffer.from(fixture.pair.secretKey).toString('base64url'),
      publicKey: Buffer.from(fixture.pair.publicKey).toString('base64url') };
    homeDatabase.current = createInstalledMachineRpcDatabaseBoundary({ machineId, installation, ownerAccountId: 'alice',
      members: [{ accountId: 'bob', accessLevel: 'view' }] });
    homeDatabase.current.machine.metadata = encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
      host: 'security-observation', platform: 'linux', happyCliVersion: 'test',
      homeDir: '/home/fixture', happyHomeDir: '/home/fixture/.happier',
    }));
    const method = RPC_METHODS.MACHINES_SECURITY_INSPECT;
    const relay = await createInstalledMachineRpcRelay({ manager, machineId, transportOwnerAccountId: 'alice',
      methods: [method], authenticatedHomeReceiver: true, ui: { installation } });
    try {
      expect(await fixture.client.resolveAuthenticatedAccountId()).toBe('alice');
      const homeReads = vi.mocked(axios.get).mock.calls.length;
      const raw = await relay.invokeUi(method, { machineId }, { actorAccountId: 'bob' });
      if (raw && typeof raw === 'object' && 'errorCode' in raw) throw new Error(`Shared Security read refused: ${JSON.stringify(raw)}`);
      const result = MachineSecurityInspectResultV1Schema.parse(raw);
      expect(result.grade).toEqual({ kind: 'incomplete', lowerBand: 'C', upperBand: 'F' });
      expect(result.rows.find(row => row.check === 'osUpdates')).toEqual({ check: 'osUpdates', state: 'fail',
        evidence: { pendingAll: 1, pendingSecurity: 1 } });
      expect(await relay.invokeUiRaw(method, { machineId }, { actorAccountId: 'charlie' }))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(JSON.parse(await readFile(fixture.statePath, 'utf8'))).toMatchObject({ updatesChecks: 1, effects: [] });
      expect(vi.mocked(axios.get).mock.calls).toHaveLength(homeReads);
    } finally {
      await relay.close();
      homeDatabase.current = null;
    }
  });
});
