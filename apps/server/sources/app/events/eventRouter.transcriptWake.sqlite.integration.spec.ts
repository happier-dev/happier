import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { applySessionReadCursorOperation, applySessionTurnMutation, createSessionMessage } from '@/app/session/sessionWriteService';
import { publishSessionReadCursorUpdate } from '@/app/session/readCursor/publishSessionReadCursorUpdate';
import { eventRouter } from './connectionEventRouter';
import { buildNewMessageUpdate, buildUpdateSessionUpdate } from './eventPayloadBuilders';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { projectSessionMessageAccountActors, resolveSessionMessageAccountActor } from '@/app/session/messages/projectSessionMessageAccountActors';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createFakeSocket } from '@/app/api/testkit/socketHarness';
import type { ClientConnection } from './eventPayloadTypes';
import { publishSessionTurnMutationUpdate } from '@/app/session/turns/publishSessionTurnMutationUpdate';
import { publishSessionReadyProjectionUpdate } from '@/app/session/ready/publishSessionReadyProjectionUpdate';

describe('committed transcript socket wake (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-transcript-wake-',
            sqliteConnectionLimit: 1, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('projects waiting at the actual socket boundary for old and cumulative V4 readers', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const http = createServer();
        const io = new Server(http, { path: '/v1/updates' });
        io.on('connection', socket => {
            Object.assign(socket.data, { userId: owner.id, clientType: 'session-scoped', sessionId: session.id,
                authAuthority: 'account_automation', authTokenAuthenticationEvidence: [] });
            writeAccountStoredContentCompatibilityForSocket(socket, evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            void socket.join(`session:${session.id}:${owner.id}`);
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing test address');
        eventRouter.setIo(io);
        const clients = [undefined, 2, 3, 4].map(protocolVersion => connect(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false,
            auth: protocolVersion === undefined ? {} : { accountStoredContentCompatibility: { v: 1, protocolVersion } },
        }));
        try {
            await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => {
                client.once('connect', resolve); client.once('connect_error', reject);
            })));
            const received = clients.map(client => new Promise<unknown>(resolve => client.once('update', resolve)));
            await eventRouter.emitUpdate({ userId: owner.id,
                payload: buildUpdateSessionUpdate(session.id, 1, 'question-wait', undefined, undefined,
                    { latestTurnId: 'question-turn', latestTurnStatus: 'waiting', latestReadyEventSeq: 9 }),
                recipientFilter: { type: 'all-interested-in-session', sessionId: session.id } });
            const payloads = await Promise.all(received);
            for (let index = 0; index < payloads.length; index += 1) {
                expect(payloads[index]).toMatchObject({ body: { latestTurnStatus: index === 3 ? 'waiting' : null,
                    latestReadyEventSeq: index === 3 ? 9 : null } });
            }
        } finally {
            clients.forEach(client => client.close()); eventRouter.clearIo(); await io.close();
        }
    });

    it('projects the committed Account-authored notification before the next writer releases the pool', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }) } });
        const result = await createSessionMessage({ inputAdmission: 'authenticatedAccount', actorUserId: owner.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            sessionId: session.id, localId: 'actor-row', messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'actor' } } } });
        if (!result.ok) throw new Error(`Append failed: ${result.error}`);
        let releaseWriter!: () => void;
        let writerEntered!: () => void;
        const entered = new Promise<void>(resolve => { writerEntered = resolve; });
        const release = new Promise<void>(resolve => { releaseWriter = resolve; });
        const writer = inTx(async tx => {
            await tx.account.update({ where: { id: owner.id }, data: { seq: { increment: 1 } } });
            writerEntered();
            await release;
        });
        await entered;
        const started = performance.now();
        let mainPoolCompleted = false;
        // Sensitivity control: the prior publisher reader queues on the held
        // connection, while the canonical publisher must complete independently.
        const mainPoolProjection = projectSessionMessageAccountActors(db, [result.message]).then(actors => {
            mainPoolCompleted = true;
            return actors;
        });
        const projection = resolveSessionMessageAccountActor(result.message);
        let budgetTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            const observed = await Promise.race([projection, new Promise<null>(resolve => {
                budgetTimer = setTimeout(() => resolve(null), 1000);
            })]);
            console.info('WAKE2_TIMING', JSON.stringify({ actorProjectionMs: observed === null ? null : performance.now() - started,
                writerHeld: true }));
            expect(observed, 'Account-authored publication must not queue behind the next SQLite writer').not.toBeNull();
            expect(observed).toMatchObject({ accountId: owner.id });
            expect(mainPoolCompleted).toBe(false);
        } finally {
            clearTimeout(budgetTimer);
            releaseWriter();
            await writer;
            await projection;
            await mainPoolProjection;
        }
    });

    it('delivers a committed row within a second while the next writer holds the write pool', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }) } });
        const http = createServer();
        const io = new Server(http, { path: '/v1/updates' });
        io.on('connection', socket => {
            // Authentication is the external boundary. Stamp the same verified facts as socket admission.
            Object.assign(socket.data, { userId: owner.id, clientType: 'session-scoped', sessionId: session.id,
                authAuthority: 'account_automation', authTokenAuthenticationEvidence: [] });
            void socket.join(`session:${session.id}:${owner.id}`);
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing test address');
        eventRouter.setIo(io);
        const client = connect(`http://127.0.0.1:${address.port}`, { path: '/v1/updates', transports: ['websocket'], reconnection: false });
        let releaseWriter!: () => void;
        let writer: Promise<void> | undefined;
        let publication: void | Promise<void>;
        try {
            await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
            const writeStarted = performance.now();
            const result = await createSessionMessage({ inputAdmission: 'transcriptOnly', actorUserId: owner.id,
                sessionId: session.id, localId: 'wake-row', messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'wake' } } } });
            const committed = performance.now();
            if (!result.ok) throw new Error(`Append failed: ${result.error}`);
            const rowCreatedToCommitMs = Date.now() - result.message.createdAt.getTime();
            let writerEntered!: () => void;
            const entered = new Promise<void>(resolve => { writerEntered = resolve; });
            const release = new Promise<void>(resolve => { releaseWriter = resolve; });
            writer = inTx(async tx => {
                await tx.account.update({ where: { id: owner.id }, data: { seq: { increment: 1 } } });
                writerEntered();
                await release;
            });
            await entered;
            const received: unknown[] = [];
            const wake = new Promise<number>(resolve => client.on('update', payload => {
                if (payload.id !== 'wake-update') return;
                received.push(payload);
                resolve(performance.now());
            }));
            const emitted = performance.now();
            publication = eventRouter.emitUpdate({ userId: owner.id,
                payload: buildNewMessageUpdate(result.message, session.id, result.recipientCursors[0]!.cursor, 'wake-update'),
                recipientFilter: { type: 'all-interested-in-session', sessionId: session.id } });
            // The requested subsecond wake budget is a test assertion, never a product timer.
            let budgetTimer: ReturnType<typeof setTimeout> | undefined;
            const observed = await Promise.race([wake, new Promise<null>(resolve => { budgetTimer = setTimeout(() => resolve(null), 1000); })]);
            clearTimeout(budgetTimer);
            console.info('WAKE_TIMING', JSON.stringify({ appendToCommitMs: committed - writeStarted,
                rowCreatedToCommitMs,
                publishToSocketMs: observed === null ? null : observed - emitted, writerHeld: true }));
            expect(observed, 'Session fanout must not queue behind the next SQLite writer').not.toBeNull();
            expect(received).toHaveLength(1);
            // Parse the actual fanout producer bytes with the sync follower's consumer.
            expect(UpdateContainerSchema.parse(received[0]).body).toMatchObject({
                t: 'new-message', sid: session.id, message: { id: result.message.id, seq: result.message.seq,
                    content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'wake' } } } },
            });
        } finally {
            releaseWriter?.();
            await writer;
            await publication!;
            client.disconnect();
            eventRouter.clearIo();
            await new Promise<void>(resolve => io.close(() => resolve()));
        }
    });

    it.each(['message', 'turn', 'ready', 'read'] as const)('sends a Session viewer the row push instead of a duplicate Account wake (%s)', async writer => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }) } });
        const authentication = { env: process.env, authority: 'present_user' as const, authenticationEvidence: [] };
        // Socket admission is the external boundary: stamp its verified facts on in-process connections.
        // Index 2 is an app sync socket of the same Account that is NOT viewing this Session
        // (no consumption declared): it must get the bodyless row push, never a wake (Q10b).
        const connections = (['user-scoped', 'machine-scoped', 'user-scoped'] as const).map((kind, index) => {
            const socket = Object.assign(createFakeSocket({ id: `${kind}-${index}` }), { data: { userId: owner.id, clientType: kind,
                ...(index === 2 ? { clientPurpose: 'sync' } : {}),
                authAuthority: 'present_user', authTokenAuthenticationEvidence: [] } });
            writeAccountStoredContentCompatibilityForSocket(socket, evaluateAccountStoredContentSocketCompatibility(
                buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)));
            const connection: ClientConnection = kind === 'user-scoped'
                ? { connectionType: kind, userId: owner.id, socket: socket as unknown as ClientConnection['socket'] }
                : { connectionType: kind, userId: owner.id, machineId: 'm1', socket: socket as unknown as ClientConnection['socket'] };
            eventRouter.addConnection(owner.id, connection);
            return { socket, connection };
        });
        // Account-stream frames only; a sync socket also receives its personal-event ephemerals.
        const updates = (index: number) => connections[index]!.socket.emit.mock.calls
            .filter(([event]) => event === 'update').map(([, payload]) => UpdateContainerSchema.parse(payload).body);
        const frames = (index: number) => updates(index).map(body => body.t);
        try {
            if (writer === 'message') {
                await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
                    const response = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/messages`,
                        headers: { 'x-test-user-id': owner.id }, payload: { localId: 'viewer-row',
                            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'viewer' } } } } });
                    expect(response.statusCode, response.body).toBe(200);
                });
            } else if (writer === 'turn') {
                const result = await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation: { v: 1,
                    sessionId: session.id, mutationId: crypto.randomUUID(), action: 'begin', turnId: crypto.randomUUID(), observedAt: Date.now() } });
                if (!result.ok) throw new Error(`Turn failed: ${result.error}`);
                await publishSessionTurnMutationUpdate({ sessionId: session.id, actorUserId: owner.id, result });
            } else if (writer === 'ready') {
                await publishSessionReadyProjectionUpdate({ sessionId: session.id,
                    readyProjection: { latestReadyEventSeq: 1, latestReadyEventAt: Date.now() } });
            } else {
                // Seed this reader's frontier, then commit a row to read up to; only the second mark is counted.
                expect(await applySessionReadCursorOperation({ actorUserId: owner.id, sessionId: session.id,
                    operation: { kind: 'mark-read' }, authentication })).toMatchObject({ ok: true });
                expect(await createSessionMessage({ inputAdmission: 'transcriptOnly', actorUserId: owner.id, sessionId: session.id,
                    localId: 'read-row', messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'read' } } } }))
                    .toMatchObject({ ok: true, didWrite: true });
                for (const { socket } of connections) socket.emit.mockClear();
                const result = await applySessionReadCursorOperation({ actorUserId: owner.id, sessionId: session.id,
                    operation: { kind: 'mark-read' }, authentication });
                if (!result.ok) throw new Error(`Read failed: ${result.error}`);
                expect(result.didChange).toBe(true);
                await publishSessionReadCursorUpdate({ sessionId: session.id, ...result, authentication });
            }
            const push = writer === 'message' ? 'new-message' : 'update-session';
            // Some publishers do not await their per-recipient emit; the wake, if any, precedes the push.
            await vi.waitFor(() => expect(frames(0)).toContain(push));
            expect(frames(0)).toEqual([push]);
            // The Machine is outside the Session audience and keeps its Account wake.
            expect(frames(1)).toEqual(['account-change']);
            // Delivery follows consumption: the non-viewing sync socket gets facts, not a wake or a body.
            await vi.waitFor(() => expect(frames(2)).toContain(push));
            expect(frames(2)).toEqual([push]);
            if (writer === 'message') {
                expect(updates(2)[0]).toMatchObject({ delivery: 'hint' });
            }
        } finally { for (const { connection } of connections) eventRouter.removeConnection(owner.id, connection); }
    });

    it('rereads a committed transcript page within a second while a writer holds the write pool', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }) } });
        const result = await createSessionMessage({ inputAdmission: 'authenticatedAccount', actorUserId: owner.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            sessionId: session.id, localId: 'page-row', messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'page' } } } });
        if (!result.ok) throw new Error(`Append failed: ${result.error}`);
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            let releaseWriter!: () => void;
            let writerEntered!: () => void;
            const entered = new Promise<void>(resolve => { writerEntered = resolve; });
            const release = new Promise<void>(resolve => { releaseWriter = resolve; });
            const writer = inTx(async tx => {
                await tx.account.update({ where: { id: owner.id }, data: { seq: { increment: 1 } } });
                writerEntered();
                await release;
            });
            await entered;
            const started = performance.now();
            const response = app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/messages?afterSeq=0`,
                headers: { 'x-test-user-id': owner.id } });
            let budgetTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                const observed = await Promise.race([response, new Promise<null>(resolve => { budgetTimer = setTimeout(() => resolve(null), 1000); })]);
                console.info('WAKE_TIMING', JSON.stringify({ pageReadMs: observed === null ? null : performance.now() - started, writerHeld: true }));
                expect(observed, 'Transcript page reads must not queue behind the next SQLite writer').not.toBeNull();
                expect(observed!.statusCode).toBe(200);
                expect(SessionMessagesPageV1Schema.parse(observed!.json()).messages).toMatchObject([{ id: result.message.id, seq: result.message.seq,
                    accountActor: { accountId: owner.id } }]);
            } finally {
                clearTimeout(budgetTimer);
                releaseWriter();
                await writer;
                await response;
            }
        });
    });
});
