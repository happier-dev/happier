import { randomUUID } from 'node:crypto';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ChangeEntrySchema, type ChangeEntry } from '@happier-dev/protocol/changes';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { ApiMachineClient } from '@/api/apiMachine';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './managedMachinePolicyRuntime';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { invalidateManagedMachineInTx } from '../../../../server/sources/app/machines/managed/managedRows';
import { setMachineAccessGrantInTx } from '../../../../server/sources/app/machines/machineAccess';
import { makeShareEligibleForTest } from '../../../../server/sources/testkit/shareEligibility.testkit';

let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-policy-invalidation-' });
}, 120_000);
afterAll(async () => { if (database) await database.close(); });
afterEach(() => vi.restoreAllMocks());

it('consumes a committed managed-row invalidation for its controller without waking for unrelated Account work', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const storedMachineContent = { metadata: encodePlainMachineStoredContent({ host: 'policy', platform: 'linux',
        happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
        dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) };
    const controller = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
        installationId: randomUUID(), ...storedMachineContent, active: true } });
    const row = await db.managedMachine.create({ data: { homeId: 'home', custodianAccountId: account.id,
        controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
        admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
        launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        desired: 'start', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } });
    await inTx(tx => invalidateManagedMachineInTx(tx, row));
    const stored = await db.accountChange.findUniqueOrThrow({ where: {
        accountId_kind_entityId: { accountId: account.id, kind: 'account', entityId: row.id },
    } });
    const produced = ChangeEntrySchema.parse({ cursor: stored.cursor, kind: stored.kind, entityId: stored.entityId,
        changedAt: stored.changedAt.getTime(), hint: stored.hint });
    expect(produced.hint).toEqual({ managedMachinePolicy: true, machineId: controller.id });

    let changes: ChangeEntry[] = [];
    const machine = { id: controller.id, encryptionMode: 'plain' as const, metadata: null, metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0 };
    // Only Home HTTP is replaced; the real feed parser, classification, subscription and policy pump run together.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: account.id } };
        if (String(url).includes('/v2/changes')) return { status: 200, data: { changes, nextCursor: stored.cursor } };
        if (String(url).includes('/v1/machines/')) return { status: 200, data: { machine } };
        throw new Error(`Unexpected policy invalidation HTTP boundary: ${url}`);
    });
    const client = new ApiMachineClient('fixture-token', machine);
    const classifiedManagedChanges: unknown[] = [];
    client.onManagedMachinePolicyInvalidated(change => { classifiedManagedChanges.push(change); });
    const censuses: number[] = [];
    const signing = nacl.sign.keyPair();
    vi.spyOn(axios, 'post').mockImplementation(async () => {
        censuses.push(1);
        return { status: 200, data: { machines: [], targets: [] } };
    });
    const runtime = createDaemonManagedMachinePolicyRuntime({ apiMachine: client,
        readCensus: signal => readManagedMachinePolicyCensus({ homeId: 'home',
            controller: { machineId: controller.id, installationId: controller.installationId! },
            custodianAccountId: account.id, privateKey: signing.secretKey,
            token: 'fixture-token', serverUrl: 'https://policy.example', signal }),
        executePolicy: async () => { throw new Error('No policy work'); } });
    const sync = (current = client) => (current as unknown as {
        syncChangesOnConnect(options: { reason: 'live' }): Promise<void>;
    }).syncChangesOnConnect({ reason: 'live' });
    try {
        changes = [{ ...produced, entityId: 'unrelated', hint: null }];
        await sync();
        expect(censuses).toHaveLength(0);
        changes = [produced];
        await sync();
        expect(censuses).toHaveLength(1);
        expect(classifiedManagedChanges).toEqual([{ kind: 'managed', managedIds: [row.id] }]);
        changes = [{ ...produced, hint: { managedMachinePolicy: true, machineId: 'other-controller' } }];
        await sync();
        expect(censuses).toHaveLength(1);
        changes = [{ ...produced, kind: 'machine', entityId: controller.id, hint: null }];
        await sync();
        // The controller's own publication can retire an incumbent, but cannot
        // schedule work when there is no outstanding policy to reauthorize.
        expect(censuses).toHaveLength(1);

        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const replacement = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), ...storedMachineContent, active: true } });
        await makeShareEligibleForTest(account.id, viewer.id);
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: account.id, machineId: replacement.id,
            principal: { kind: 'account', accountId: viewer.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
        await inTx(async tx => {
            const moved = await tx.managedMachine.update({ where: { id: row.id }, data: {
                controllerMachineId: replacement.id, controllerInstallationId: replacement.installationId!,
            } });
            // The control owner invalidates both the former and replacement controller audiences.
            await invalidateManagedMachineInTx(tx, row);
            await invalidateManagedMachineInTx(tx, moved);
        });
        const replacementChange = await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: viewer.id, kind: 'account', entityId: row.id },
        } });
        expect(replacementChange.hint).toEqual({ managedMachinePolicy: true, machineId: replacement.id });
        const retiredControllerChange = await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'machine', entityId: controller.id },
        } });
        const movedControllerChange = await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'account', entityId: row.id },
        } });
        changes = [retiredControllerChange, movedControllerChange].map(change => ChangeEntrySchema.parse({
            cursor: change.cursor, kind: change.kind, entityId: change.entityId,
            changedAt: change.changedAt.getTime(), hint: change.hint,
        }));
        const replacementClient = new ApiMachineClient('fixture-token', { ...machine, id: replacement.id });
        let replacementWakes = 0;
        replacementClient.onManagedMachinePolicyInvalidated(() => { replacementWakes += 1; });
        try {
            await sync();
            expect(censuses).toHaveLength(1);
            await sync(replacementClient);
            expect(replacementWakes).toBe(1);
        } finally { await replacementClient.shutdown(); }
        await inTx(async tx => {
            const accountOwned = await tx.managedMachine.update({ where: { id: row.id }, data: {
                controllerMachineId: null, controllerInstallationId: null,
            } });
            await invalidateManagedMachineInTx(tx, accountOwned);
        });
        const accountOwnedChange = await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'account', entityId: row.id },
        } });
        expect(accountOwnedChange.hint).toEqual({ managedMachinePolicy: true });
        changes = [ChangeEntrySchema.parse({ cursor: accountOwnedChange.cursor, kind: accountOwnedChange.kind,
            entityId: accountOwnedChange.entityId, changedAt: accountOwnedChange.changedAt.getTime(), hint: accountOwnedChange.hint })];
        await sync();
        expect(censuses).toHaveLength(2);
        expect(classifiedManagedChanges).toContainEqual({ kind: 'managed', managedIds: [row.id] });
    } finally {
        await runtime.stop();
        await client.shutdown();
    }
});
