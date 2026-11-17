import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { applySessionTurnMutation, createSessionMessage } from '@/app/session/sessionWriteService';
import { publishSessionTurnMutationUpdate } from '@/app/session/turns/publishSessionTurnMutationUpdate';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { eventRouter } from './connectionEventRouter';
import { buildNewMessageUpdate } from './eventPayloadBuilders';

type Request = Readonly<{ model?: string; action: string }>;
const isSessionRead = (request: Request) => request.model === 'Session' && /^find/.test(request.action);

/**
 * A Session write's fan-out decides each recipient socket from the access facts the write read in
 * its own transaction (OWNER-RULINGS 2026-11-16 "Remove overbuilt re-reads"), on real SQLite and a
 * real Socket.IO server: no Session read at fan-out, and a recipient revoked before the write
 * commits receives nothing.
 */
describe('committed delivery access (SQLite)', () => {
    let harness: LightSqliteHarness;
    let io: Server | undefined;
    let clients: ClientSocket[] = [];
    const authentication = readSessionAccessAuthenticationFromRequest({ authAuthority: 'present_user' });

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-committed-delivery-',
            sqliteConnectionLimit: 1, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterEach(async () => {
        clients.forEach(client => client.close());
        clients = [];
        eventRouter.clearIo();
        await io?.close();
        io = undefined;
    });
    afterAll(async () => { await harness?.close(); });

    /** Owner and one direct viewer, each with a connected user-scoped client. */
    async function sharedSessionWithClients() {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
            metadata: JSON.stringify({ t: 'plain', v: {} }) } });
        const grant = await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id,
            createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view' } });
        const http = createServer();
        io = new Server(http, { path: '/v1/updates' });
        io.on('connection', socket => {
            const userId = socket.handshake.auth.userId as string;
            Object.assign(socket.data, { userId, clientType: 'user-scoped', authAuthority: 'present_user', authTokenAuthenticationEvidence: [] });
            writeAccountStoredContentCompatibilityForSocket(socket, evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            void socket.join([`user-scoped:${userId}`, `user:${userId}`]);
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing test address');
        eventRouter.setIo(io);
        const connectAs = async (userId: string) => {
            const client = connect(`http://127.0.0.1:${address.port}`, { path: '/v1/updates', transports: ['websocket'],
                reconnection: false, auth: { userId, accountStoredContentCompatibility: { v: 1, protocolVersion: 4 } } });
            clients.push(client);
            await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
            const updates: unknown[] = [];
            client.on('update', update => updates.push(update));
            return updates;
        };
        return { owner, viewer, session, grant, ownerUpdates: await connectAs(owner.id), viewerUpdates: await connectAs(viewer.id) };
    }

    async function observeSessionReads<T>(run: () => Promise<T>): Promise<Readonly<{ result: T; sessionReads: number }>> {
        let sessionReads = 0;
        const stop = observeSqliteRequests({ before: request => { if (isSessionRead(request)) sessionReads += 1; } });
        try {
            return { result: await run(), sessionReads };
        } finally { stop(); }
    }

    const until = async (condition: () => boolean) => {
        for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    };

    it('pushes a turn mutation to every recipient from the write\'s own access facts, with no Session read at fan-out', async () => {
        const f = await sharedSessionWithClients();
        const turnId = `turn-${randomUUID()}`;
        await applySessionTurnMutation({ actorUserId: f.owner.id, authentication, mutation: {
            v: 1, sessionId: f.session.id, mutationId: randomUUID(), action: 'begin', turnId, observedAt: Date.now() - 1_000 } });
        const completed = await applySessionTurnMutation({ actorUserId: f.owner.id, authentication, mutation: {
            v: 1, sessionId: f.session.id, mutationId: randomUUID(), action: 'complete', turnId, observedAt: Date.now() } });
        if (!completed.ok || !completed.didApply) throw new Error('Expected the turn to complete');
        f.ownerUpdates.length = 0;
        f.viewerUpdates.length = 0;

        const published = await observeSessionReads(() => publishSessionTurnMutationUpdate({
            sessionId: f.session.id, actorUserId: f.owner.id, result: completed }));
        await until(() => f.ownerUpdates.length > 0 && f.viewerUpdates.length > 0);

        expect(f.ownerUpdates).toEqual([expect.objectContaining({ body: expect.objectContaining({ t: 'update-session', id: f.session.id }) })]);
        expect(f.viewerUpdates).toEqual([expect.objectContaining({ body: expect.objectContaining({ t: 'update-session', id: f.session.id }) })]);
        // RED (HEAD 3ba6310f489): 4 — the router re-read each recipient's access row at fan-out.
        expect(published.sessionReads).toBe(0);
    });

    it('pushes a transcript line from the write\'s own access facts, with no Session read at fan-out', async () => {
        const f = await sharedSessionWithClients();
        const written = await createSessionMessage({ inputAdmission: 'authenticatedAccount', actorUserId: f.owner.id, authentication,
            sessionId: f.session.id, localId: `line-${randomUUID()}`, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'line' } } } });
        if (!written.ok || !written.didWrite) throw new Error('Expected the line to be written');

        // The transcript-observation publisher's fan-out for each recipient cursor.
        const published = await observeSessionReads(() => Promise.all(written.recipientCursors.map(({ accountId, cursor }) =>
            eventRouter.emitUpdate({ userId: accountId,
                payload: buildNewMessageUpdate({ ...written.message, accountActor: null }, f.session.id, cursor, randomUUID()),
                recipientFilter: { type: 'all-interested-in-session', sessionId: f.session.id },
                deliveryAccess: written.deliveryAccess }))));
        await until(() => f.ownerUpdates.length > 0 && f.viewerUpdates.length > 0);

        expect(f.ownerUpdates).toEqual([expect.objectContaining({ body: expect.objectContaining({ t: 'new-message' }) })]);
        expect(f.viewerUpdates).toEqual([expect.objectContaining({ body: expect.objectContaining({ t: 'new-message' }) })]);
        // RED (HEAD 3ba6310f489): 3 — fan-out access reads per recipient Account.
        expect(published.sessionReads).toBe(0);
    });

    it('delivers nothing to a recipient whose access was revoked before the write committed', async () => {
        const f = await sharedSessionWithClients();
        const turnId = `turn-${randomUUID()}`;
        await applySessionTurnMutation({ actorUserId: f.owner.id, authentication, mutation: {
            v: 1, sessionId: f.session.id, mutationId: randomUUID(), action: 'begin', turnId, observedAt: Date.now() - 1_000 } });
        await db.sessionGrant.delete({ where: { id: f.grant.id } });
        const completed = await applySessionTurnMutation({ actorUserId: f.owner.id, authentication, mutation: {
            v: 1, sessionId: f.session.id, mutationId: randomUUID(), action: 'complete', turnId, observedAt: Date.now() } });
        if (!completed.ok || !completed.didApply) throw new Error('Expected the turn to complete');
        f.ownerUpdates.length = 0;
        f.viewerUpdates.length = 0;

        await publishSessionTurnMutationUpdate({ sessionId: f.session.id, actorUserId: f.owner.id, result: completed });
        await until(() => f.ownerUpdates.length > 0);
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(f.ownerUpdates).toHaveLength(1);
        expect(f.viewerUpdates).toEqual([]);
        expect(completed.recipientCursors.map(cursor => cursor.accountId)).toEqual([f.owner.id]);
    });
});
