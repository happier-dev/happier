import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { recordMachineAlive, recordMachineAliveInTx } from './presenceRecorder';
import { createMachinePresenceDeadlineOwner, stopLocalMachinePresenceTimeout, resolvePresenceTimeoutConfig, recordMachineDisconnect } from './timeout';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { inTx } from '@/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerMachineAccessRoutes } from '@/app/api/routes/machines/machineAccessRoutes';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'presence-events-', initAuth: false });
}, 120_000);
afterAll(async () => { await stopLocalMachinePresenceTimeout(); await harness?.close(); });

it('pushes enrolled guest changes to its audience when its controller disconnects and recovers, without heartbeat republication', async () => {
    const account = () => db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const [owner, recipient] = await Promise.all([account(), account()]);
    const metadata = encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
        host: 'wake-controller', platform: 'linux', happyCliVersion: '0.3.0',
        homeDir: '/home/wake', happyHomeDir: '/home/wake/.happier',
    }));
    const dataEncryptionKey = decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER);
    const controller = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
        installationId: randomUUID(), metadata, dataEncryptionKey, active: false } });
    const guest = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
        metadata, dataEncryptionKey, active: false } });
    await db.managedMachine.create({ data: {
        homeId: await getOrCreateServerIdentityId(), custodianAccountId: owner.id, enrolledMachineId: guest.id,
        controllerMachineId: controller.id, controllerInstallationId: controller.installationId,
        admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
        launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
        observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
    } });
    expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: guest.id,
        principal: { kind: 'account', accountId: recipient.id }, level: 'view' }))).toMatchObject({ kind: 'saved', readiness: 'ready' });
    const cursor = async () => (await db.accountChange.findUnique({ where: {
        accountId_kind_entityId: { accountId: recipient.id, kind: 'machine', entityId: guest.id },
    } }))?.cursor ?? 0;
    const beat = () => recordMachineAlive({ accountId: owner.id, machineId: controller.id, timestamp: Date.now() }, async (_, row) => ({
        recipientAccountIds: [owner.id], wasOffline: !row.active, lastActiveAt: row.lastActiveAt,
    }));
    const initial = await cursor();
    await beat();
    const online = await cursor();
    expect(online).toBeGreaterThan(initial);
    // A continuing beat must not reread managed dependents or republish their facts.
    const dependentReads = vi.spyOn(db.managedMachine, 'findMany');
    try {
        await beat();
        expect(await cursor()).toBe(online);
        expect(dependentReads).not.toHaveBeenCalled();
    } finally { dependentReads.mockRestore(); }
    await recordMachineDisconnect({ accountId: owner.id, machineId: controller.id }, async () => true, async () => {});
    const offline = await cursor();
    expect(offline).toBeGreaterThan(online);
    await beat();
    expect(await cursor()).toBeGreaterThan(offline);
});

it('retains the exact deadline decision and recovery, with no enrollment or heartbeat occurrence', async () => {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', active: false } });
    const read = async () => (await db.$queryRaw<Array<{ presenceTransitions: string | null }>>`
        SELECT "presenceTransitions" FROM "Machine" WHERE "id" = ${machine.id}`)[0]?.presenceTransitions;
    const beat = () => recordMachineAlive({ accountId: owner.id, machineId: machine.id, timestamp: Date.now() }, async (_, row) => {
        return { recipientAccountIds: [owner.id], wasOffline: !row.active, lastActiveAt: row.lastActiveAt };
    });
    const deadline = createMachinePresenceDeadlineOwner();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
        const before = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
        await beat();
        expect(await read()).toBeNull();
        // The first false→true decision changes Account inventory even though
        // it creates no historical offline/recovery occurrence.
        expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } }))
            .toEqual({ seq: before.seq + 1 });
        await deadline.start();
        await vi.advanceTimersByTimeAsync(resolvePresenceTimeoutConfig().machineTimeoutMs);
        await deadline.stop();
        await stopLocalMachinePresenceTimeout();
        expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(false);
        const offline = await read();
        expect(offline).not.toBeNull();
        expect(JSON.parse(offline!)).toMatchObject({ v: 1, revision: 1,
            offline: { revision: 1, occurredAt: Date.now() }, online: null });
        await beat();
        const recovered = JSON.parse((await read())!);
        expect(recovered).toMatchObject({ revision: 2, offline: JSON.parse(offline!).offline,
            online: { revision: 2, occurredAt: Date.now() } });
        await beat();
        expect(JSON.parse((await read())!)).toEqual(recovered);
        const change = await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: owner.id, kind: 'machine', entityId: machine.id },
        } });
        expect(change.machineId).toBe(machine.id);
    } finally { await deadline.stop(); await stopLocalMachinePresenceTimeout(); vi.useRealTimers(); }
});

it('exposes structural occurrences to the owner and current grantees, and refuses another Account', async () => {
    const account = () => db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const [owner, viewer, other] = await Promise.all([account(), account(), account()]);
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
        metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
    await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
        principal: { kind: 'account', accountId: viewer.id }, level: 'view' }));
    await withAuthenticatedTestApp(registerMachineAccessRoutes, async app => {
        for (const actor of [owner, viewer]) {
            const response = await app.inject({ method: 'GET', url: `/v1/machines/${machine.id}/presence`,
                headers: { 'x-test-user-id': actor.id } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ kind: 'present', machineId: machine.id, transitions: null });
        }
        const denied = await app.inject({ method: 'GET', url: `/v1/machines/${machine.id}/presence`,
            headers: { 'x-test-user-id': other.id } });
        expect(denied.json()).toEqual({ kind: 'refused', code: 'machine_unavailable' });
    });
});

it('shares one Account publication with the semantic writer recovering the Machine', async () => {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', active: false } });
    const daemonState = encodePlainMachineStoredContent({ status: 'running' });
    await inTx(tx => recordMachineAliveInTx(tx, { accountId: owner.id, machineId: machine.id, timestamp: Date.now() },
        async (transaction, row) => {
            await transaction.machine.update({ where: { id: machine.id }, data: { daemonState, daemonStateVersion: 1 } });
            const accountChanges = await markAccountsChanged(transaction, { accountIds: [owner.id], kind: 'machine', entityId: machine.id });
            return { recipientAccountIds: [owner.id], wasOffline: !row.active, lastActiveAt: row.lastActiveAt, accountChanges };
        }));
    expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).toEqual({ seq: 1 });
    expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { active: true, daemonState: true, daemonStateVersion: true } }))
        .toEqual({ active: true, daemonState, daemonStateVersion: 1 });
});
