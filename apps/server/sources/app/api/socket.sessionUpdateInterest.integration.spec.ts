import { randomUUID } from 'node:crypto';

import fastify from 'fastify';
import { io, type Socket } from 'socket.io-client';
import { expect, it, vi } from 'vitest';

import { auth } from '@/app/auth/auth';
import { buildAccountSettingsChangedUpdate, buildNewMessageUpdate, buildUpdateAccountUpdate, eventRouter } from '@/app/events/eventRouter';
import { emitPendingChanged } from '@/app/session/pending/publishPendingMutation';
import { db } from '@/storage/db';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { startSocket } from './socket';
import type { Fastify as AppFastify } from './types';

const shutdown = vi.hoisted(() => ({ close: undefined as (() => Promise<void>) | undefined }));
vi.mock('@/utils/process/shutdown', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/process/shutdown')>()),
    onShutdown: (name: string, callback: () => Promise<void>) => {
        if (name === 'api:socket') shutdown.close = callback;
        return () => {};
    },
}));

async function open(socket: Socket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => { socket.off('connect_error', reject); resolve(); });
        socket.once('connect_error', reject);
        socket.connect();
    });
}

async function startSocketHarness() {
    const harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-socket-session-interest-', initAuth: true, initEncrypt: false, initFiles: false,
        env: { HAPPIER_SOCKET_ADAPTER: 'memory', HAPPY_SOCKET_ROOMS_ONLY: '0' },
    });
    const app = fastify();
    const sockets: Socket[] = [];
    const { id: userId } = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
    const token = await auth.createToken(userId);
    startSocket(app as AppFastify);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const makeSocket = (handshake: {
        clientType: string; sessionId?: string; machineId?: string; clientPurpose?: string; sessionUpdateInterest?: unknown; liveTranscriptDisabled?: unknown;
    }) => {
        const socket = io(address, {
            path: '/v1/updates', transports: ['websocket'], forceNew: true, autoConnect: false, reconnection: false,
            auth: { token, ...handshake },
        });
        sockets.push(socket);
        const events: string[] = [];
        socket.on('update', (value) => {
            if (value.body?.t === 'new-message') events.push(`message:${value.body.sid}`);
            if (value.body?.t === 'pending-changed') events.push(`pending:${value.body.sid}`);
            if (value.body?.t === 'update-account' && value.body?.settingsV2) events.push('settings');
        });
        socket.on('ephemeral', (value) => {
            if (value.type === 'activity') events.push(`activity:${value.id}`);
            if (value.type === 'transcript-stream-segment') events.push(`segment:${value.sessionId}`);
            if (value.type === 'transcript-stream-segment-delta') events.push(`delta:${value.sessionId}`);
            if (value.type === 'direct-session-transcript-delta') events.push(`direct:${value.sessionId}`);
        });
        return { socket, events };
    };
    return {
        userId, sockets, makeSocket,
        close: async () => {
            for (const socket of sockets) socket.close();
            await shutdown.close?.();
            await app.close();
            eventRouter.clearIo();
            await harness.close();
        },
    };
}

it('only delivers matching session updates to runners that declare session interest', async () => {
    const { userId, sockets, makeSocket, close } = await startSocketHarness();
    try {
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: userId, metadata: '{}' } });
        const makeRunner = async () => {
            const { id: sessionId } = await db.session.create({ data: { accountId: userId, tag: randomUUID(), metadata: '{}' } });
            await db.accessKey.create({ data: { accountId: userId, machineId, sessionId, data: 'synthetic-key' } });
            const session = makeSocket({ clientType: 'session-scoped', sessionId, machineId });
            const account = makeSocket({ clientType: 'user-scoped', sessionUpdateInterest: sessionId });
            await Promise.all([open(session.socket), open(account.socket)]);
            return { sessionId, session, account };
        };
        const ui = makeSocket({ clientType: 'user-scoped', clientPurpose: 'sync' });
        await open(ui.socket);
        const legacy = makeSocket({ clientType: 'user-scoped' });
        const malformed = makeSocket({ clientType: 'user-scoped', sessionUpdateInterest: { sessionId: 'invalid' } });
        await Promise.all([open(legacy.socket), open(malformed.socket)]);
        const active = await makeRunner();
        const idle = await Promise.all(Array.from({ length: 5 }, makeRunner));
        let phase = 0;
        const messageFor = (sessionId: string, seq: number) => buildNewMessageUpdate({
            id: `msg${seq}`, seq, localId: null, createdAt: new Date(0), updatedAt: new Date(0),
            content: { t: 'encrypted', c: 'message' },
        }, sessionId, seq, `update${seq}`);
        const burst = async (sessionId: string) => {
            const nextPhase = ++phase;
            const recipients = sockets.filter(socket => socket.connected);
            const barriers = recipients.map(socket => new Promise<void>(resolve => {
                const receive = (value: { id: string }) => {
                    if (value.id !== `barrier-${nextPhase}`) return;
                    socket.off('update', receive);
                    resolve();
                };
                socket.on('update', receive);
            }));
            const recipientFilter = { type: 'all-interested-in-session', sessionId } as const;
            for (let seq = 1; seq <= 4; seq++) {
                eventRouter.emitUpdate({ userId, payload: messageFor(sessionId, seq), recipientFilter });
                eventRouter.emitEphemeral({ userId, recipientFilter, payload: {
                    type: 'transcript-stream-segment-delta', sessionId,
                    message: { localId: `stream${seq}`, content: { t: 'encrypted', c: 'delta' }, tick: seq, baseLength: 0, createdAt: 0, updatedAt: 0 },
                } });
            }
            eventRouter.emitUpdate({ userId, payload: buildAccountSettingsChangedUpdate(nextPhase, 99, `barrier-${nextPhase}`), recipientFilter: { type: 'all-user-authenticated-connections' } });
            await Promise.all(barriers);
        };
        await burst(active.sessionId);
        const transcript = (sessionId: string) => Array.from({ length: 4 }, () => [
            `message:${sessionId}`, `delta:${sessionId}`,
        ]).flat();
        expect(active.account.events).toEqual(transcript(active.sessionId));
        expect(active.session.events).toEqual(transcript(active.sessionId));
        expect(ui.events).toEqual(transcript(active.sessionId));
        expect(legacy.events).toEqual(transcript(active.sessionId));
        expect(malformed.events).toEqual(transcript(active.sessionId));
        expect(idle.map(runner => runner.session.events)).toEqual([[], [], [], [], []]);
        expect(idle.map(runner => runner.account.events)).toEqual([[], [], [], [], []]);

        const reconnected = idle[0];
        reconnected.account.socket.disconnect();
        await open(reconnected.account.socket);
        eventRouter.emitUpdate({
            userId,
            payload: buildUpdateAccountUpdate(userId, { settingsV2: { content: null, version: 42 } }, 100, 'settings'),
            recipientFilter: { type: 'user-scoped-only' },
        });
        await emitPendingChanged({
            sessionId: reconnected.sessionId,
            changedByAccountId: userId,
            pendingCount: 1,
            pendingVersion: 1,
            participantCursors: [{ accountId: userId, cursor: 101 }],
        });
        await burst(reconnected.sessionId);
        const ownSessionEvents = [`pending:${reconnected.sessionId}`, ...transcript(reconnected.sessionId)];
        expect(reconnected.account.events).toEqual(['settings', ...ownSessionEvents]);
        expect(reconnected.session.events).toEqual(ownSessionEvents);
        expect(active.account.events).toEqual([...transcript(active.sessionId), 'settings']);

        eventRouter.clearIo();
        await burst(active.sessionId);
        expect(active.account.events).toEqual([...transcript(active.sessionId), 'settings', ...transcript(active.sessionId)]);
        expect(reconnected.account.events).toEqual(['settings', ...ownSessionEvents]);
        expect(ui.events.slice(-8)).toEqual(transcript(active.sessionId));
    } finally {
        await close();
    }
});

it('excludes opted-out sockets from live transcripts while delivering durable session updates and activity', async () => {
    const { userId, makeSocket, close } = await startSocketHarness();
    try {
        const sessionId = randomUUID();
        const cache = makeSocket({ clientType: 'user-scoped', clientPurpose: 'concurrent-server-cache', liveTranscriptDisabled: true });
        const rpc = makeSocket({ clientType: 'user-scoped', clientPurpose: 'scoped-rpc', liveTranscriptDisabled: true });
        const narrowed = makeSocket({ clientType: 'user-scoped', sessionUpdateInterest: sessionId, liveTranscriptDisabled: true });
        const optsOut = [cache, rpc, narrowed];
        const legacy = makeSocket({ clientType: 'user-scoped' });
        const main = makeSocket({ clientType: 'user-scoped', clientPurpose: 'sync' });
        const malformed = makeSocket({ clientType: 'user-scoped', liveTranscriptDisabled: 'true' });
        const receivesTranscript = [legacy, main, malformed];
        const accountSockets = [...optsOut, ...receivesTranscript];
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: userId, metadata: '{}' } });
        const machine = makeSocket({ clientType: 'machine-scoped', machineId });
        await Promise.all([...accountSockets, machine].map(({ socket }) => open(socket)));
        const sessionUpdates = [`message:${sessionId}`, `activity:${sessionId}`];
        const transcript = [`direct:${sessionId}`, `message:${sessionId}`, `segment:${sessionId}`, `delta:${sessionId}`, `activity:${sessionId}`];
        let phase = 0;
        const burst = async () => {
            // A machine daemon's direct transcript delta is relayed on its own round trip, so wait for the
            // legacy socket (always a recipient) before sending the rest.
            const directReceived = new Promise<void>(resolve => {
                const receive = (value: { type: string }) => {
                    if (value.type !== 'direct-session-transcript-delta') return;
                    legacy.socket.off('ephemeral', receive);
                    resolve();
                };
                legacy.socket.on('ephemeral', receive);
            });
            machine.socket.emit('direct-session-transcript-delta', {
                type: 'direct-session-transcript-delta', sessionId, items: [], truncated: false,
            });
            await directReceived;
            const nextPhase = ++phase;
            // Machine sockets do not join the account room, so only user-facing sockets can observe the barrier.
            const barriers = accountSockets.map(({ socket }) => new Promise<void>(resolve => {
                const receive = (value: { id: string }) => {
                    if (value.id !== `barrier-${nextPhase}`) return;
                    socket.off('update', receive);
                    resolve();
                };
                socket.on('update', receive);
            }));
            const recipientFilter = { type: 'all-interested-in-session', sessionId } as const;
            const content = { t: 'encrypted', c: 'message' } as const;
            eventRouter.emitUpdate({ userId, recipientFilter, payload: buildNewMessageUpdate({
                id: `msg${nextPhase}`, seq: nextPhase, localId: null, createdAt: new Date(0), updatedAt: new Date(0), content,
            }, sessionId, nextPhase, `update${nextPhase}`) });
            const message = { localId: 'stream', content, tick: nextPhase, createdAt: 0, updatedAt: 0 };
            eventRouter.emitEphemeral({ userId, recipientFilter, payload: { type: 'transcript-stream-segment', sessionId, message } });
            eventRouter.emitEphemeral({ userId, recipientFilter, payload: {
                type: 'transcript-stream-segment-delta', sessionId, message: { ...message, baseLength: 0 },
            } });
            eventRouter.emitEphemeral({ userId, recipientFilter, payload: { type: 'activity', id: sessionId, active: true, activeAt: 1 } });
            eventRouter.emitUpdate({ userId, payload: buildAccountSettingsChangedUpdate(nextPhase, 99, `barrier-${nextPhase}`), recipientFilter: { type: 'all-user-authenticated-connections' } });
            await Promise.all(barriers);
        };
        await burst();
        for (const { events } of optsOut) expect(events.splice(0)).toEqual(sessionUpdates);
        for (const { events } of receivesTranscript) expect(events.splice(0)).toEqual(transcript);

        cache.socket.disconnect();
        await open(cache.socket);
        await burst();
        for (const { events } of optsOut) expect(events.splice(0)).toEqual(sessionUpdates);
        for (const { events } of receivesTranscript) expect(events.splice(0)).toEqual(transcript);

        eventRouter.clearIo();
        await burst();
        for (const { events } of optsOut) expect(events).toEqual(sessionUpdates);
        for (const { events } of receivesTranscript) expect(events).toEqual(transcript);
    } finally {
        await close();
    }
});
