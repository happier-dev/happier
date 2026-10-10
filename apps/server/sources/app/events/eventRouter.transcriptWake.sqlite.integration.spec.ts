import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSessionMessage } from '@/app/session/sessionWriteService';
import { eventRouter } from './connectionEventRouter';
import { buildNewMessageUpdate } from './eventPayloadBuilders';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { projectSessionMessageAccountActors, resolveSessionMessageAccountActor } from '@/app/session/messages/projectSessionMessageAccountActors';

describe('committed transcript socket wake (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-transcript-wake-',
            sqliteConnectionLimit: 1, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

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
        } finally {
            releaseWriter?.();
            await writer;
            await publication!;
            client.disconnect();
            eventRouter.clearIo();
            await new Promise<void>(resolve => io.close(() => resolve()));
        }
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
                expect(observed!.json().messages).toMatchObject([{ id: result.message.id, seq: result.message.seq,
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
