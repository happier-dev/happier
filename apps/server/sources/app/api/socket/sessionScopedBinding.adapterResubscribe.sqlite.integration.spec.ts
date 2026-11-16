import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedFakeSocket } from '@/app/api/testkit/socketHarness';
import { registerMachineAccessLossHandler, type MachineAccessLoss } from '@/app/events/machineAccessLoss';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { startRedisAdapterRecoveryCluster } from '@/testkit/redisAdapterRecoveryCluster';
import { canCallSessionScopedRpcMethod, confirmSessionScopedMachineAccess, reconfirmSessionScopedMachineAccess,
    resolveSessionScopedSocketBinding, watchSessionScopedMachineAccess } from './sessionScopedBinding';

/** Counts AccessKey reads at the Prisma boundary; every access owner stays real. */
function countAccessKeyReads(): Readonly<{ count: () => number; restore: () => void }> {
    let reads = 0;
    const accessKey = db.accessKey;
    const methods = ['findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'findMany', 'count'] as const;
    const originals = methods.map(method => [method, Reflect.get(accessKey, method)] as const);
    for (const [method, original] of originals) {
        Object.defineProperty(accessKey, method, { configurable: true, writable: true,
            value: (...args: unknown[]) => { reads += 1; return Reflect.apply(original as (...a: unknown[]) => unknown, accessKey, args); } });
    }
    return {
        count: () => reads,
        restore: () => {
            for (const [method, original] of originals) {
                Object.defineProperty(accessKey, method, { configurable: true, writable: true, value: original });
            }
        },
    };
}

// Machine access loss reaches other API nodes as `serverSideEmit`, which the Redis Streams
// adapter sends over at-most-once Pub/Sub. A loss published while a node's subscriber is down
// is never resent, so that node re-checks its local Session-scoped sockets once when its
// subscriber is ready again.
describe('Session-scoped Machine access after a dropped cluster access-loss push', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-access-resubscribe-', initAuth: true,
            initEncrypt: false, initFiles: false, env: { HAPPIER_SERVER_IDENTITY_ID: 'srv_access-resubscribe',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it('withdraws the access once the subscriber is ready again, with one AccessKey read per local socket', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            metadata: encodePlainMachineStoredContent({ host: 'resubscribe', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: randomUUID() } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: machine.id, principal: { kind: 'account', accountId: guest.id }, level: 'view' })))
            .toMatchObject({ kind: 'saved' });
        const sockets = await Promise.all([0, 1].map(async () => {
            const session = await db.session.create({ data: { accountId: guest.id, tag: randomUUID(),
                encryptionMode: 'plain', metadata: '{}', active: false } });
            await db.accessKey.create({ data: { accountId: guest.id, machineId: machine.id,
                sessionId: session.id, data: 'guest-binding' } });
            const admitted = await resolveSessionScopedSocketBinding({ userId: guest.id, accountId: guest.id,
                machineId: machine.id, sessionId: session.id });
            if (!admitted.ok) throw new Error('Session-scoped admission failed');
            return { sessionId: session.id, socket: createAuthenticatedFakeSocket({ data: { clientType: 'session-scoped',
                userId: guest.id, sessionScopedBinding: admitted.binding } }) as unknown as Socket };
        }));
        // An unrelated local socket (user-scoped) is not re-checked.
        const uiSocket = createAuthenticatedFakeSocket({ data: { clientType: 'user-scoped', userId: guest.id } }) as unknown as Socket;
        const callAllowed = (entry: (typeof sockets)[number]) => canCallSessionScopedRpcMethod({ socket: entry.socket,
            accountId: guest.id, method: `${entry.sessionId}:execution.run.start` });

        const cluster = await startRedisAdapterRecoveryCluster();
        const nodeB = cluster.nodes[1];
        // Node B's connect owner (api/socket.ts): the cluster access-loss push feeds each socket's watch.
        const nodeBLossListeners = new Set<(input: MachineAccessLoss) => void>();
        const releaseLoss = registerMachineAccessLossHandler(nodeB.io, input => { for (const listener of nodeBLossListeners) listener(input); });
        const releaseWatches = [];
        for (const entry of sockets) {
            releaseWatches.push(watchSessionScopedMachineAccess({ socket: entry.socket, accountId: guest.id,
                onMachineAccessLoss: listener => { nodeBLossListeners.add(listener); return () => nodeBLossListeners.delete(listener); } }));
            await confirmSessionScopedMachineAccess({ socket: entry.socket, accountId: guest.id });
        }
        // Node B's backstop wiring (api/socket.ts), over its local sockets.
        const passes: Promise<void>[] = [];
        const releaseBackstop = nodeB.owner.onSocketClusterAdapterResubscribed(() => {
            passes.push(reconfirmSessionScopedMachineAccess([...sockets.map(entry => entry.socket), uiSocket]));
        });
        try {
            for (const entry of sockets) expect(await callAllowed(entry)).toBe(true);
            const counter = countAccessKeyReads();
            let controlReads = -1;
            let backstopReads = -1;
            try {
                await cluster.recover('restart', { duringOutage: async () => {
                    // The grant is withdrawn while node B's subscriber is down. Its loss push is the one
                    // Pub/Sub dropped: nothing reaches node B's listeners (no io is attached to the local
                    // event router here, so the withdrawal publishes nothing).
                    expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                        machineId: machine.id, principal: { kind: 'account', accountId: guest.id } })))
                        .toMatchObject({ kind: 'removed' });
                    // Control: without the subscriber-ready signal the dropped push leaves the access
                    // admitted, and nothing reads AccessKey.
                    for (const entry of sockets) expect(await callAllowed(entry)).toBe(true);
                    controlReads = counter.count();
                } });
                await vi.waitFor(() => { if (passes.length === 0) throw new Error('No subscriber-ready signal yet'); },
                    { timeout: 40_000, interval: 50 });
                await Promise.all(passes);
                backstopReads = counter.count() - controlReads;
            } finally { counter.restore(); }
            expect(controlReads).toBe(0);
            // One signal for node B's Pub/Sub subscriber, not its root or Stream reader.
            expect(passes).toHaveLength(1);
            // One access read per local Session-scoped socket.
            expect(backstopReads).toBe(sockets.length);
            const refusalCounter = countAccessKeyReads();
            try {
                for (const entry of sockets) expect(await callAllowed(entry)).toBe(false);
                expect(refusalCounter.count()).toBe(0);
            } finally { refusalCounter.restore(); }
        } finally {
            releaseBackstop();
            for (const release of releaseWatches) release();
            releaseLoss();
            await cluster.close();
        }
    }, 120_000);
});
