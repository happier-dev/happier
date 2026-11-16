import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { eventRouter, type ClientConnection } from '@/app/events/eventRouter';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { canCallSessionScopedRpcMethod, canReadAccessKeyFromSessionScopedSocket, canRegisterSessionScopedRpcMethod,
    confirmSessionScopedMachineAccess, resolveSessionScopedSocketBinding, watchSessionScopedMachineAccess } from './sessionScopedBinding';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { sessionUpdateHandler } from './sessionUpdateHandler';

/**
 * Counts AccessKey reads at the Prisma boundary (root client and every
 * transaction client). All access, publisher and write owners stay real.
 */
function countAccessKeyReads(): Readonly<{ count: () => number; restore: () => void }> {
    let reads = 0;
    const isRead = (method: string) => /^(find|count|aggregate|groupBy)/.test(method);
    const countDelegate = <T extends object>(delegate: T): T => new Proxy(delegate, { get(model, method) {
        const execute: unknown = Reflect.get(model, method);
        if (typeof execute !== 'function' || typeof method !== 'string') return execute;
        return (...args: unknown[]) => { if (isRead(method)) reads += 1; return Reflect.apply(execute, model, args); };
    } });
    const countRaw = (query: unknown) => { if (typeof query === 'string' && /"AccessKey"/.test(query)) reads += 1; };
    const proxyClient = <T extends object>(client: T): T => new Proxy(client, { get(owner, property, receiver) {
        const value: unknown = Reflect.get(owner, property, receiver);
        if (property === 'accessKey' && value && typeof value === 'object') return countDelegate(value);
        if ((property === '$queryRawUnsafe' || property === '$executeRawUnsafe') && typeof value === 'function') {
            return (...args: unknown[]) => { countRaw(args[0]); return Reflect.apply(value, owner, args); };
        }
        return value;
    } });
    const originalTransaction = db.$transaction;
    db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args) {
        const operation: unknown = args[0];
        if (typeof operation !== 'function') return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => Reflect.apply(operation, undefined, [proxyClient(tx)]), ...args.slice(1)]);
    } });
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
            db.$transaction = originalTransaction;
            for (const [method, original] of originals) {
                Object.defineProperty(accessKey, method, { configurable: true, writable: true, value: original });
            }
        },
    };
}

describe('Admitted Session publisher after Machine grant withdrawal', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-publisher-admitted-work-', initAuth: true,
            initEncrypt: false, initFiles: false, env: { HAPPIER_SERVER_IDENTITY_ID: 'srv_publisher-admitted-work',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it('reads no Machine access per publisher event and keeps per-request admissions refused for the withdrawn guest', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            metadata: encodePlainMachineStoredContent({ host: 'admitted-work', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: randomUUID(), operationProtocolCapabilities: {
                requesterExecutionIsolation: { protocolVersions: [1] },
                sessionInputAdmission: { protocolVersions: [1, 2, 3] },
            }, operationProtocolCapabilitiesRevision: 1 } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: machine.id, principal: { kind: 'account', accountId: guest.id }, level: 'view' })))
            .toMatchObject({ kind: 'saved' });
        const session = await db.session.create({ data: { accountId: guest.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}', active: false } });
        await db.accessKey.create({ data: { accountId: guest.id, machineId: machine.id,
            sessionId: session.id, data: 'guest-binding' } });
        const binding = { accountId: guest.id, machineId: machine.id, sessionId: session.id };
        const admitted = await resolveSessionScopedSocketBinding({ userId: guest.id, ...binding });
        if (!admitted.ok) throw new Error('Publisher admission failed');
        // Socket.IO is the transport boundary; the guest's UI socket stays connected throughout.
        const socket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'session-scoped', userId: guest.id,
            sessionScopedBinding: admitted.binding } }), { disconnect: () => { socket.connected = false; } });
        const connection: ClientConnection = { connectionType: 'session-scoped', userId: guest.id,
            machineId: machine.id, sessionId: session.id, socket: socket as unknown as Socket };
        const uiSocket = createAuthenticatedFakeSocket({ data: { clientType: 'user-scoped' } });
        const uiConnection: ClientConnection = { connectionType: 'user-scoped', userId: guest.id,
            socket: uiSocket as unknown as Socket };
        const presence = createSessionPublisherPresence();
        sessionUpdateHandler(guest.id, connection.socket, connection, { presence, binding });
        eventRouter.clearIo();
        eventRouter.addConnection(guest.id, connection);
        // The connect owner's push subscription and post-join confirmation (api/socket.ts).
        const releaseAccessWatch = watchSessionScopedMachineAccess({ socket: socket as unknown as Socket, accountId: guest.id,
            onMachineAccessLoss: listener => eventRouter.onMachineAccessLoss(listener) });
        await confirmSessionScopedMachineAccess({ socket: socket as unknown as Socket, accountId: guest.id });
        eventRouter.addConnection(guest.id, uiConnection);
        const emit = async (event: string, payload: unknown) => {
            const acks: unknown[] = [];
            await getSocketHandler(socket, event)(payload, (ack: unknown) => acks.push(ack));
            return acks;
        };
        const activity = (state: 'active' | 'idle') => emit('session-runtime-activity-snapshot', { sessionId: session.id,
            mutationId: randomUUID(), snapshot: { state, activeCount: state === 'active' ? 1 : 0 } });
        const reply = (localId: string, text: string) => emit(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, { v: 1,
            sessionId: session.id, localId, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text } } },
            createdAt: 1, updatedAt: 1, provenance: { kind: 'non_dependent', source: 'external' } });
        const observeFollow = () => emit(SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1, { v: 1, sessionId: session.id });
        try {
            expect(await activity('active')).toEqual([expect.objectContaining({ status: 'applied' })]);
            const counter = countAccessKeyReads();
            let publisherEventReads: number;
            try {
                for (let index = 0; index < 7; index += 1) {
                    expect.soft(await reply(`reply-${index}`, `chunk ${index}`)).toEqual([expect.objectContaining({ ok: true })]);
                    expect.soft(await observeFollow()).toEqual([expect.not.objectContaining({ error: 'forbidden' })]);
                    if (index < 6) expect.soft(await activity(index % 2 === 0 ? 'idle' : 'active')).toHaveLength(1);
                }
                publisherEventReads = counter.count();
            } finally { counter.restore(); }
            // 20 publisher events of the admitted Session: 7 transcript, 7 Follow observations, 6 activity snapshots.
            expect(publisherEventReads).toBe(0);

            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                machineId: machine.id, principal: { kind: 'account', accountId: guest.id } })))
                .toMatchObject({ kind: 'removed' });
            expect(uiSocket.connected).toBe(true);
            expect(socket.connected).toBe(true);
            // Per-request admissions of new work stay: Session-scoped RPC call and Session access-key read.
            // The withdrawal arrived as the access owner's push: refused without an AccessKey read.
            const refusalCounter = countAccessKeyReads();
            try {
                expect(await canCallSessionScopedRpcMethod({ socket: socket as unknown as Socket, accountId: guest.id,
                    method: `${session.id}:execution.run.start` })).toBe(false);
                expect(refusalCounter.count()).toBe(0);
            } finally { refusalCounter.restore(); }
            expect(await canReadAccessKeyFromSessionScopedSocket({ socket: socket as unknown as Socket, connection,
                sessionId: session.id, machineId: machine.id })).toBe(false);
            // The admitted publisher's next events are accepted.
            expect(await reply('after-withdrawal', 'still finishing')).toEqual([expect.objectContaining({ ok: true })]);
            expect(await observeFollow()).toEqual([expect.not.objectContaining({ error: 'forbidden' })]);
            // Reconnect is a new admission and is refused.
            expect(await resolveSessionScopedSocketBinding({ userId: guest.id, ...binding })).toMatchObject({ ok: false });
        } finally {
            releaseAccessWatch();
            eventRouter.removeConnection(guest.id, connection);
            eventRouter.removeConnection(guest.id, uiConnection);
        }
    });

    // OWNER-RULINGS 2026-11-16 "Remove overbuilt re-reads" (P03 ORCH 14:10Z): connect admits the
    // Session-scoped Machine access once; the access owner's push withdraws it. RPC registration and
    // calls on an admitted socket read no AccessKey, and a deleted Session's bound socket is evicted.
    it('reads no AccessKey per Session-scoped RPC and evicts the bound socket when its Session is deleted', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            metadata: encodePlainMachineStoredContent({ host: 'rpc-access', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: randomUUID() } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: machine.id, principal: { kind: 'account', accountId: guest.id }, level: 'view' })))
            .toMatchObject({ kind: 'saved' });
        const session = await db.session.create({ data: { accountId: guest.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}', active: false } });
        await db.accessKey.create({ data: { accountId: guest.id, machineId: machine.id,
            sessionId: session.id, data: 'guest-binding' } });
        const binding = { accountId: guest.id, machineId: machine.id, sessionId: session.id };
        const admitted = await resolveSessionScopedSocketBinding({ userId: guest.id, ...binding });
        if (!admitted.ok) throw new Error('Session-scoped admission failed');
        const socket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'session-scoped', userId: guest.id,
            sessionScopedBinding: admitted.binding } }), { disconnect: () => { socket.connected = false; } });
        const connection: ClientConnection = { connectionType: 'session-scoped', userId: guest.id,
            machineId: machine.id, sessionId: session.id, socket: socket as unknown as Socket };
        eventRouter.clearIo();
        eventRouter.addConnection(guest.id, connection);
        // The connect owner's push subscription and post-join confirmation (api/socket.ts).
        const releaseAccessWatch = watchSessionScopedMachineAccess({ socket: socket as unknown as Socket, accountId: guest.id,
            onMachineAccessLoss: listener => eventRouter.onMachineAccessLoss(listener) });
        await confirmSessionScopedMachineAccess({ socket: socket as unknown as Socket, accountId: guest.id });
        const rpc = { socket: socket as unknown as Socket, accountId: guest.id };
        try {
            const counter = countAccessKeyReads();
            let rpcReads: number;
            try {
                for (const method of ['execution.run.start', 'session.status', 'session.abort', 'session.permission', 'session.read']) {
                    expect(await canRegisterSessionScopedRpcMethod({ ...rpc, method: `${session.id}:${method}` })).toBe(true);
                    expect(await canCallSessionScopedRpcMethod({ ...rpc, method: `${session.id}:${method}` })).toBe(true);
                }
                rpcReads = counter.count();
            } finally { counter.restore(); }
            // 10 RPC admissions (5 registrations, 5 calls) on the admitted socket.
            expect(rpcReads).toBe(0);
            // Another Session's method is still refused by the held binding.
            expect(await canCallSessionScopedRpcMethod({ ...rpc, method: `${randomUUID()}:session.status` })).toBe(false);

            expect(await deleteOwnedSession({ sessionId: session.id, reason: 'user_request', ownerAccountId: guest.id }))
                .toEqual({ ok: true });
            expect(socket.connected).toBe(false);
        } finally {
            releaseAccessWatch();
            eventRouter.removeConnection(guest.id, connection);
        }
    });
});
