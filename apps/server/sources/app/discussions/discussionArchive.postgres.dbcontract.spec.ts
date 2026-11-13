import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { DISCUSSION_HTTP_PATHS_V1, DiscussionDetailsResponseV1Schema, DiscussionPostResponseV1Schema, type DiscussionCreateRequestV1 } from '@happier-dev/protocol/discussions/api';

import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import type { Tx } from '@/storage/inTx';
import { kvMutate } from '@/app/kv/kvMutate';
import { createDiscussion } from './mutations';
import { archiveDiscussion } from './mutations';
import { renameDiscussion } from './mutations';
import { setDiscussionReadCursor } from './readState';
import { inviteDiscussionParticipant, removeDiscussionGrant, setDiscussionGrant } from './accessService';

const authentication = createPresentUserSessionAccessAuthentication();

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Discussion archive admission (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { vi.unstubAllEnvs(); await shutdownDbClient(); });

    async function fixture(archived = false) {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const request = {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Archive contention' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'First' }] } },
                mentionedAccountIds: [] },
        } satisfies DiscussionCreateRequestV1;
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        if (archived) await db.discussion.update({ where: { id: discussionId }, data: { archivedAt: new Date() } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableErrorHandlers(app);
        // Credential verification is the boundary; all routing, authority,
        // projection, native locks and terminal publication remain real.
        let actorAccountId = owner.id;
        app.decorate('authenticate', async (incoming: FastifyRequest) => {
            incoming.userId = actorAccountId; incoming.authAuthority = 'present_user'; incoming.authTokenKind = 'account';
        });
        registerDiscussionRoutes(app);
        await app.ready();
        const initialCursor = (await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).seq;
        return { owner, discussionId, initialCursor, app, setActor: (accountId: string) => { actorAccountId = accountId; }, close: async () => {
            await app.close();
            await db.account.delete({ where: { id: owner.id } });
        } };
    }

    it('appends after a same-Account publisher commits between discovery and Account admission without conflict retries', async () => {
        const current = await fixture();
        const maxRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        const original = db.$transaction;
        let publishingPeer = false;
        let published = false;
        let attempts = 0;
        const payload = { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Concurrent append' }] } }, mentionedAccountIds: [] };
        // Schedule a genuine KV publication at the Prisma query boundary. All
        // route, append, lock, retry and terminal publication logic stays real.
        db.$transaction = new Proxy(original, { apply(target, receiver, args) {
            const operation: unknown = args[0];
            const options: unknown = args[1];
            if (publishingPeer || typeof operation !== 'function'
                || options && typeof options === 'object' && Reflect.get(options, 'isolationLevel') === 'RepeatableRead') {
                return Reflect.apply(target, receiver, args);
            }
            attempts++;
            return Reflect.apply(target, receiver, [async (tx: Tx) => Reflect.apply(operation, undefined, [new Proxy(tx, {
                get(owner, property, proxyReceiver) {
                    const member: unknown = Reflect.get(owner, property, proxyReceiver);
                    if (property !== '$queryRawUnsafe' || typeof member !== 'function') return member;
                    return (...queryArgs: unknown[]) => {
                        const query: unknown = Reflect.apply(member, owner, queryArgs);
                        if (!/FROM "Account".*FOR KEY SHARE/.test(String(queryArgs[0])) || published) return query;
                        return observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), async () => {
                            if (published) return;
                            published = true;
                            publishingPeer = true;
                            try {
                                expect(await kvMutate({ uid: current.owner.id }, [{ key: `append-peer-${randomUUID()}`,
                                    value: 'cGVlcg==', version: -1 }])).toMatchObject({ success: true });
                            } finally { publishingPeer = false; }
                        });
                    };
                },
            })]), ...args.slice(1)]);
        } });
        try {
            const response = await current.app.inject({ method: 'POST',
                url: DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', current.discussionId), payload });
            expect(published).toBe(true);
            expect(response.statusCode, response.body).toBe(200);
            const posted = DiscussionPostResponseV1Schema.parse(response.json());
            expect(posted).toMatchObject({ messageSeq: 2, message: { localId: payload.localId, seq: 2 } });
            expect(await db.account.findUniqueOrThrow({ where: { id: current.owner.id } })).toMatchObject({ seq: current.initialCursor + 2 });
            expect(attempts).toBe(1);
        } finally {
            db.$transaction = original;
            if (maxRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = maxRetries;
            await current.close();
        }
    });

    it.each(['rename', 'read'] as const)('%s commits while a peer advances the Account cursor before every publication attempt', async operation => {
        const current = await fixture();
        await db.discussionReadState.update({ where: { discussionId_accountId: {
            discussionId: current.discussionId, accountId: current.owner.id,
        } }, data: { lastReadSeq: 0 } });
        const transaction = db.$transaction;
        let peerWrites = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            let advanced = false;
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                    return (query: string, ...values: unknown[]) => {
                        const pending = inner.$queryRawUnsafe(query, ...values);
                        if (!query.includes('FROM "Account"') || !query.includes('FOR NO KEY UPDATE')) return pending;
                        return observeLazyPrismaQuery(pending, () => ({ started() {}, settled() {} }), async () => {
                            if (advanced) return;
                            advanced = true;
                            await db.account.update({ where: { id: current.owner.id }, data: { seq: { increment: 1 } } });
                            peerWrites++;
                        });
                    };
                },
            })), ...args.slice(1)]);
        } });
        try {
            const input = { actorAccountId: current.owner.id, discussionId: current.discussionId, authentication };
            const result = operation === 'rename'
                ? await renameDiscussion({ ...input, titleContent: { t: 'plain', v: { v: 1, title: 'Renamed under contention' } } })
                : await setDiscussionReadCursor({ ...input, lastReadSeq: 1 });
            expect(peerWrites).toBe(1);
            expect(result).toMatchObject({ ok: true });
            expect(await db.account.findUniqueOrThrow({ where: { id: current.owner.id } }))
                .toMatchObject({ seq: current.initialCursor + 2 });
            if (operation === 'rename') expect(await db.discussion.findUniqueOrThrow({ where: { id: current.discussionId } }))
                .toMatchObject({ titleContent: { t: 'plain', v: { title: 'Renamed under contention' } } });
            else expect(await db.discussionReadState.findUniqueOrThrow({ where: { discussionId_accountId: {
                discussionId: current.discussionId, accountId: current.owner.id,
            } } })).toMatchObject({ lastReadSeq: 1 });
        } finally { db.$transaction = transaction; await current.close(); }
    });

    it('replays a newly invited same-Account Session before extending locks past the Discussion parent', async () => {
        const current = await fixture();
        const session = await db.session.create({ data: { accountId: current.owner.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        const original = db.$transaction;
        const attempts: string[][] = [];
        let inviting = false;
        let invited = false;
        // The real invite commits after the captured cohort was admitted, but
        // before append obtains its parent. No internal owner is replaced.
        db.$transaction = new Proxy(original, { apply(target, receiver, args) {
            const operation: unknown = args[0];
            const options: unknown = args[1];
            if (inviting || typeof operation !== 'function'
                || options && typeof options === 'object' && Reflect.get(options, 'isolationLevel') === 'RepeatableRead') {
                return Reflect.apply(target, receiver, args);
            }
            const queries: string[] = [];
            attempts.push(queries);
            return Reflect.apply(target, receiver, [async (tx: Tx) => Reflect.apply(operation, undefined, [new Proxy(tx, {
                get(owner, property, proxyReceiver) {
                    const member: unknown = Reflect.get(owner, property, proxyReceiver);
                    if (property !== '$queryRawUnsafe' || typeof member !== 'function') return member;
                    return (...queryArgs: unknown[]) => {
                        const sql = String(queryArgs[0]);
                        queries.push(sql);
                        const query: unknown = Reflect.apply(member, owner, queryArgs);
                        if (!/FROM "Discussion".*FOR NO KEY UPDATE/.test(sql) || invited) return query;
                        return observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), async () => {
                            if (invited) return;
                            invited = true;
                            inviting = true;
                            try {
                                expect(await inviteDiscussionParticipant({ authentication, actorAccountId: current.owner.id,
                                    discussionId: current.discussionId, request: { participant: { kind: 'session', sessionId: session.id } } }))
                                    .toMatchObject({ ok: true });
                            } finally { inviting = false; }
                        });
                    };
                },
            })]), ...args.slice(1)]);
        } });
        try {
            const response = await current.app.inject({ method: 'POST',
                url: DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', current.discussionId),
                payload: { localId: randomUUID(), content: { t: 'plain', v: { v: 1,
                    parts: [{ t: 'text', text: 'Current participant cohort' }] } }, mentionedAccountIds: [] } });
            expect(response.statusCode, response.body).toBe(200);
            expect(invited).toBe(true);
            expect(attempts).toHaveLength(2);
            expect(attempts[0].filter(sql => /FROM "Session".*FOR NO KEY UPDATE/.test(sql))).toEqual([]);
            const admittedSession = attempts[1].findIndex(sql => /FROM "Session".*FOR NO KEY UPDATE/.test(sql));
            const admittedDiscussion = attempts[1].findIndex(sql => /FROM "Discussion".*FOR NO KEY UPDATE/.test(sql));
            expect(admittedSession).toBeGreaterThan(-1);
            expect(admittedDiscussion).toBeGreaterThan(admittedSession);
        } finally { db.$transaction = original; await db.session.delete({ where: { id: session.id } }); await current.close(); }
    });

    it('rejoins concurrent identical append IDs before allocating another Discussion sequence', async () => {
        const current = await fixture();
        const payload = { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Same occurrence' }] } }, mentionedAccountIds: [] };
        const append = () => current.app.inject({ method: 'POST',
            url: DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', current.discussionId), payload });
        const responses: Array<ReturnType<typeof append>> = [];
        try {
            await db.$transaction(async holder => {
                await holder.$queryRaw`SELECT "id" FROM "Discussion" WHERE "id" = ${current.discussionId} FOR UPDATE`;
                let finished = 0;
                const start = () => { const response = append(); responses.push(response); void response.finally(() => { finished++; }); };
                for (let count = 1; count <= 2; count++) {
                    start();
                    let waiting = 0;
                    while (finished === 0 && waiting < count) {
                        const [row] = await db.$queryRaw<Array<{ waiting: number }>>`
                            SELECT COUNT(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database()
                                AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%Discussion%'
                        `;
                        waiting = row.waiting;
                    }
                    expect(waiting).toBe(count);
                }
            });
            const results = await Promise.all(responses);
            for (const result of results) expect(result.statusCode, result.body).toBe(200);
            const messages = results.map(result => DiscussionPostResponseV1Schema.parse(result.json()));
            expect(messages[1].message.id).toBe(messages[0].message.id);
            expect(messages.map(result => result.messageSeq)).toEqual([2, 2]);
            expect(await db.discussionMessage.count({ where: { discussionId: current.discussionId, localId: payload.localId } })).toBe(1);
            expect(await db.discussion.findUniqueOrThrow({ where: { id: current.discussionId } })).toMatchObject({ messageSeq: 2 });
            expect(await db.account.findUniqueOrThrow({ where: { id: current.owner.id } })).toMatchObject({ seq: current.initialCursor + 1 });
        } finally { await Promise.allSettled(responses); await current.close(); }
    });

    it.each(['archive', 'revoke'] as const)('rechecks %s committed while an append waits for its Discussion parent', async change => {
        const current = await fixture();
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(current.owner.id, reader.id);
        expect(await setDiscussionGrant({ authentication, actorAccountId: current.owner.id, discussionId: current.discussionId,
            request: { principal: { kind: 'account', accountId: reader.id }, accessLevel: 'edit' } })).toMatchObject({ ok: true });
        current.setActor(reader.id);
        const original = db.$transaction;
        let changed = false;
        db.$transaction = new Proxy(original, { apply(target, receiver, args) {
            const operation: unknown = args[0];
            if (typeof operation !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => Reflect.apply(operation, undefined, [new Proxy(tx, {
                get(owner, property, proxyReceiver) {
                    const member: unknown = Reflect.get(owner, property, proxyReceiver);
                    if (property !== '$queryRawUnsafe' || typeof member !== 'function') return member;
                    return (...queryArgs: unknown[]) => {
                        const query: unknown = Reflect.apply(member, owner, queryArgs);
                        if (!/FROM "Discussion".*FOR NO KEY UPDATE/.test(String(queryArgs[0])) || changed) return query;
                        return observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), async () => {
                            if (changed) return;
                            changed = true;
                            const result = change === 'archive'
                                ? await archiveDiscussion({ authentication, actorAccountId: current.owner.id, discussionId: current.discussionId })
                                : await removeDiscussionGrant({ authentication, actorAccountId: current.owner.id, discussionId: current.discussionId,
                                    request: { principal: { kind: 'account', accountId: reader.id } } });
                            expect(result).toMatchObject({ ok: true });
                        });
                    };
                },
            })]), ...args.slice(1)]);
        } });
        try {
            const response = await current.app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', current.discussionId),
                payload: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Must stay unsent' }] } }, mentionedAccountIds: [] } });
            expect(changed).toBe(true);
            expect(response.statusCode, response.body).toBe(change === 'archive' ? 409 : 400);
            expect(response.json()).toEqual({ error: change === 'archive' ? 'discussion_archived' : 'discussion_publication_context_unavailable' });
            expect(await db.discussionMessage.count({ where: { discussionId: current.discussionId } })).toBe(1);
            expect(await db.discussion.findUniqueOrThrow({ where: { id: current.discussionId } })).toMatchObject({ messageSeq: 1 });
        } finally { db.$transaction = original; await current.close(); await db.account.delete({ where: { id: reader.id } }); }
    });

    it.each(['archive', 'restore'] as const)('commits %s across a concurrent Account cursor writer without conflict retries', async intent => {
        const current = await fixture(intent === 'restore');
        const maxRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        const requestChange = () => current.app.inject({ method: 'POST',
            url: DISCUSSION_HTTP_PATHS_V1[intent].replace(':discussionId', current.discussionId) });
        let response: ReturnType<typeof requestChange> | undefined;
        try {
            await db.$transaction(async writer => {
                const [{ pid }] = await writer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await writer.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${current.owner.id} FOR NO KEY UPDATE`;
                let finished = false;
                const requested = requestChange();
                response = requested;
                void requested.then(() => { finished = true; }, () => { finished = true; });
                let waiting = false;
                while (!finished && !waiting) {
                    const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                            AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(true);
                await writer.account.update({ where: { id: current.owner.id }, data: { seq: { increment: 1 } } });
            });
            if (!response) throw new Error('Archive route did not start');
            const result = await response;
            expect(result.statusCode, result.body).toBe(200);
            const projected = DiscussionDetailsResponseV1Schema.parse(result.json());
            expect(projected.discussion.id).toBe(current.discussionId);
            expect(projected.discussion.archivedAt === null).toBe(intent === 'restore');
            const persisted = await db.discussion.findUniqueOrThrow({ where: { id: current.discussionId } });
            expect(persisted.archivedAt?.getTime() ?? null).toBe(projected.discussion.archivedAt);
            expect(await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                accountId: current.owner.id, kind: 'discussion', entityId: current.discussionId,
            } }, select: { cursor: true } })).toEqual({ cursor: current.initialCursor + 2 });
            const repeated = await current.app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1[intent].replace(':discussionId', current.discussionId) });
            expect(repeated.statusCode, repeated.body).toBe(200);
            expect(DiscussionDetailsResponseV1Schema.parse(repeated.json()).discussion.archivedAt).toBe(projected.discussion.archivedAt);
        } finally {
            if (maxRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = maxRetries;
            if (response) await response;
            await current.close();
        }
    });

    it('admits Accounts before mutation reads and replays a newly granted recipient through the archive route', async () => {
        const current = await fixture();
        const recipient = await db.account.create({ data: {
            id: `000-discussion-archive-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: 'plain',
        } });
        const original = db.$transaction;
        const attempts: string[][] = [];
        let addedRecipient = false;
        // Observe the native transaction boundary without replacing its queries.
        db.$transaction = new Proxy(original, { apply(target, receiver, args) {
            const operation: unknown = args[0];
            if (typeof operation !== 'function') return Reflect.apply(target, receiver, args);
            const options: unknown = args[1];
            if (options && typeof options === 'object' && Reflect.get(options, 'isolationLevel') === 'RepeatableRead') {
                return Reflect.apply(target, receiver, args);
            }
            const queries: string[] = [];
            attempts.push(queries);
            return Reflect.apply(target, receiver, [async (tx: Tx) => Reflect.apply(operation, undefined, [new Proxy(tx, {
                get(owner, property, proxyReceiver) {
                    const member: unknown = Reflect.get(owner, property, proxyReceiver);
                    if (typeof property === 'string' && property.startsWith('$') && typeof member === 'function') {
                        return (...queryArgs: unknown[]) => {
                            const sql = String(queryArgs[0]);
                            if (!/^(SHOW|SET)\b/.test(sql)) queries.push(sql);
                            const query: unknown = Reflect.apply(member, owner, queryArgs);
                            if (!/FROM "Account".*FOR KEY SHARE/.test(sql) || addedRecipient) return query;
                            return observeLazyPrismaQuery(query, () => ({ started() {}, settled() {} }), async () => {
                                if (addedRecipient) return;
                                addedRecipient = true;
                                // A real committed grant appears after preparation,
                                // before Account admission. It must trigger whole-
                                // attempt replay, never late lower-id acquisition.
                                await db.discussionGrant.create({ data: { principalKind: 'account', discussionId: current.discussionId,
                                    accountId: recipient.id, accessLevel: 'view', createdByAccountId: current.owner.id } });
                            });
                        };
                    }
                    if (member && typeof member === 'object' && typeof property === 'string' && !property.startsWith('_')) {
                        return new Proxy(member, { get(delegate, method) {
                            const execute: unknown = Reflect.get(delegate, method);
                            return typeof execute === 'function' ? (...queryArgs: unknown[]) => {
                                queries.push(`${property}.${String(method)}`);
                                return Reflect.apply(execute, delegate, queryArgs);
                            } : execute;
                        } });
                    }
                    return member;
                },
            })]), ...args.slice(1)]);
        } });
        try {
            const result = await current.app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1.archive.replace(':discussionId', current.discussionId) });
            expect(result.statusCode, result.body).toBe(200);
            expect(attempts).toHaveLength(2);
            for (const attempt of attempts) expect(attempt[0]).toMatch(/FROM "Account".*FOR KEY SHARE/);
            expect(DiscussionDetailsResponseV1Schema.parse(result.json()).discussion.archivedAt).not.toBeNull();
            expect(await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                accountId: recipient.id, kind: 'discussion', entityId: current.discussionId,
            } }, select: { cursor: true } })).toEqual({ cursor: 1 });
        } finally {
            db.$transaction = original;
            await current.close();
            await db.account.delete({ where: { id: recipient.id } });
        }
    });

    it('keeps one archived timestamp when concurrent archive requests read the same active Discussion', async () => {
        const current = await fixture();
        const archive = () => current.app.inject({ method: 'POST',
            url: DISCUSSION_HTTP_PATHS_V1.archive.replace(':discussionId', current.discussionId) });
        const responses: Array<ReturnType<typeof archive>> = [];
        try {
            await db.$transaction(async holder => {
                await holder.$queryRaw`SELECT "id" FROM "Discussion" WHERE "id" = ${current.discussionId} FOR UPDATE`;
                let finished = 0;
                const start = () => {
                    const response = archive();
                    void response.then(() => { finished += 1; }, () => { finished += 1; });
                    responses.push(response);
                };
                start();
                let waiting = 0;
                while (finished === 0 && waiting < 1) {
                    const [row] = await db.$queryRaw<Array<{ waiting: number }>>`
                        SELECT COUNT(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database()
                            AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%Discussion%'
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(1);
                start();
                while (finished === 0 && waiting < 2) {
                    const [row] = await db.$queryRaw<Array<{ waiting: number }>>`
                        SELECT COUNT(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database()
                            AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%Discussion%'
                    `;
                    waiting = row.waiting;
                }
                expect(waiting).toBe(2);
            });
            const results = await Promise.all(responses);
            for (const result of results) expect(result.statusCode, result.body).toBe(200);
            const timestamps = results.map(result => DiscussionDetailsResponseV1Schema.parse(result.json()).discussion.archivedAt);
            expect(timestamps[0]).not.toBeNull();
            expect(timestamps[1]).toBe(timestamps[0]);
            expect((await db.discussion.findUniqueOrThrow({ where: { id: current.discussionId } })).archivedAt?.getTime()).toBe(timestamps[0]);
        } finally {
            await Promise.all(responses);
            await current.close();
        }
    });
});
