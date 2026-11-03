import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { recordMachineAlive } from './presenceRecorder';
import { createMachinePresenceDeadlineOwner, stopLocalMachinePresenceTimeout, resolvePresenceTimeoutConfig } from './timeout';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { inTx } from '@/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerMachineAccessRoutes } from '@/app/api/routes/machines/machineAccessRoutes';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'presence-events-', initAuth: false });
}, 120_000);
afterAll(async () => { await stopLocalMachinePresenceTimeout(); await harness?.close(); });

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
        await beat();
        expect(await read()).toBeNull();
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
