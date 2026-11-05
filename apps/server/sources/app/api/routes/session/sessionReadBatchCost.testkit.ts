import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { expect, it } from 'vitest';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { SessionSharedMetadataV1Schema, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { db } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { SESSION_ACCESS_SESSION_BATCH_SIZE, resolveEffectiveSessionAccessForSessionsInTx } from '@/app/session/access/sessionAccess';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { buildSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { observePrismaRequests, observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { registerSessionListingRoutes } from './registerSessionListingRoutes';
import { registerSessionTurnMutationRoute } from './registerSessionTurnMutationRoute';
import { registerSessionMessageRoutes } from './registerSessionMessageRoutes';
import { registerSessionReadBatchRoute } from './registerSessionReadBatchRoute';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
/** The same HTTP/storage cost contract runs on disposable SQLite and PostgreSQL. */
export function sessionReadBatchCostContract(provider: 'sqlite' | 'postgres') {
    it('WF44 reads only the demanded managed Session among 600 active and 400 archived descendants', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const rootId = crypto.randomUUID();
        const ids = Array.from({ length: 1_000 }, () => crypto.randomUUID());
        try {
            await db.session.createMany({ data: [rootId, ...ids].map((id, index) => ({
                id, accountId: owner.id, tag: id, metadata: '{}', encryptionMode: 'plain',
                archivedAt: index > 600 ? new Date() : null,
            })) });
            await db.sessionFollowEdge.createMany({ data: ids.map(id => ({ sourceSessionId: id,
                destinationSessionId: rootId, sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: id }),
                relation: 'manager', managerSourceSessionId: id, policyJson: JSON.stringify({ preset: 'important' }),
            })) });
            await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
                const selectedIds: string[][] = [];
                const observeIds = (value: unknown): void => {
                    if (!value || typeof value !== 'object') return;
                    if ('id' in value && value.id && typeof value.id === 'object' && 'in' in value.id
                        && Array.isArray(value.id.in)) selectedIds.push(value.id.in.filter((id): id is string => typeof id === 'string'));
                    for (const child of Object.values(value)) observeIds(child);
                };
                const observer = { before: (request: { model?: string; action: string; args: unknown }) => {
                    if (request.model === 'Session' && request.action === 'findMany') observeIds(request.args);
                } };
                const stop = provider === 'sqlite' ? observeSqliteRequests(observer) : observePrismaRequests(db, observer);
                const read = async (id: string, relatedIds: readonly string[] = []) => {
                    selectedIds.length = 0;
                    const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                        headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' },
                        payload: { sessionIds: [id], underSessionId: rootId, accessProjectionVersion: 1, includeTurns: false } });
                    expect(response.statusCode, response.body).toBe(200);
                    const result = SessionReadBatchResponseV1Schema.parse(response.json()).results;
                    expect(result).toHaveLength(1);
                    // Detail also reads its manager's presentation. Only the
                    // demanded Session and its manager/managed projections may enter selectors.
                    const pathIds = new Set([rootId, id, ...relatedIds]);
                    expect(selectedIds.flat().filter(selectedId => !pathIds.has(selectedId))).toEqual([]);
                    expect(Math.max(0, ...selectedIds.map(ids => ids.length))).toBeLessThanOrEqual(pathIds.size);
                    console.info('WF44_EXACT_READ', JSON.stringify({ provider, requestedSessions: 1, responseParts: result.length,
                        largestIdSelector: Math.max(0, ...selectedIds.map(ids => ids.length)), relatedSessionCount: pathIds.size,
                        detailStatus: result[0]?.detail?.status }));
                    return result[0]?.detail;
                };
                try {
                    expect(await read(ids[0]!)).toMatchObject({ status: 200, body: { session: { id: ids[0] } } });
                    expect(await read(ids[999]!)).toMatchObject({ status: 200, body: { session: { id: ids[999], archivedAt: expect.any(Number) } } });
                    await db.sessionFollowEdge.updateMany({ where: { sourceSessionId: ids[999], relation: 'manager' },
                        data: { destinationSessionId: ids[0] } });
                    expect(await read(ids[999]!, [ids[0]!])).toMatchObject({ status: 200 });
                    await db.sessionFollowEdge.deleteMany({ where: { sourceSessionId: ids[0], relation: 'manager' } });
                    expect(await read(ids[0]!)).toMatchObject({ status: 404 });
                    expect(await read(ids[999]!, [ids[0]!])).toMatchObject({ status: 404 });
                    await db.sessionFollowEdge.create({ data: { sourceSessionId: ids[0]!, destinationSessionId: rootId,
                        sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: ids[0]! }),
                        relation: 'manager', managerSourceSessionId: ids[0], policyJson: JSON.stringify({ preset: 'important' }) } });
                    expect(await read(ids[0]!, [ids[999]!])).toMatchObject({ status: 200 });
                    expect(await read(ids[999]!, [ids[0]!])).toMatchObject({ status: 200 });
                } finally { stop(); }
            });
        } finally {
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
    it('CR01 spans portable SQL chunks in one snapshot without losing pages or historical actors', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const ids = Array.from({ length: SESSION_ACCESS_SESSION_BATCH_SIZE + 1 }, () => crypto.randomUUID());
        // Seven historical authors per Session crosses the profile query's
        // portable bind boundary inside the first message-range chunk.
        const actors = ids.flatMap(() => Array.from({ length: 7 }, () => ({ id: crypto.randomUUID(), publicKey: crypto.randomUUID(), encryptionMode: 'plain' })));
        try {
            await db.account.createMany({ data: actors });
            await db.session.createMany({ data: ids.map(id => ({ id, accountId: owner.id, tag: id, metadata: '{}', encryptionMode: 'plain' })) });
            const messages = ids.flatMap((sessionId, index) => Array.from({ length: 7 }, (_, offset) => {
                const actor = actors[index * 7 + offset]!;
                return { id: crypto.randomUUID(), sessionId, seq: offset + 1, messageRole: 'user', authorAccountId: actor.id,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'historical author' } } },
                    // Retained receipt; historical authors need not retain a grant.
                    inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedAccount',
                        actorAccountId: actor.id, sessionRelationship: 'sharedEditor' }),
                } satisfies Prisma.SessionMessageCreateManyInput;
            }));
            await db.sessionMessage.createMany({ data: messages });
            await withAuthenticatedTestApp(registerSessionReadBatchRoute, async (app) => {
                let transactions = 0;
                const profileBatches: number[] = [];
                const originalTransaction = db.$transaction;
                db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args) {
                        transactions++;
                        return Reflect.apply(target, receiver, args);
                    } });
                const observer = { before: (request: {
                        model?: string;
                        action: string;
                        args: unknown;
                    }) => {
                        if (!request.model && JSON.stringify(request.args).includes('BEGIN DEFERRED'))
                            transactions++;
                        if (request.model === 'Account' && request.action === 'findMany') {
                            const args = request.args as {
                                where: {
                                    id: {
                                        in: string[];
                                    };
                                };
                            };
                            profileBatches.push(args.where.id.in.length);
                        }
                    } };
                const stop = provider === 'sqlite' ? observeSqliteRequests(observer) : observePrismaRequests(db, observer);
                const response = await (async () => {
                    try {
                        return await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                            headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' },
                            payload: { sessionIds: ids, includeSnapshot: false, includeMessages: true } });
                    }
                    finally {
                        stop();
                        db.$transaction = originalTransaction;
                    }
                })();
                expect(response.statusCode, response.body).toBe(200);
                const results = SessionReadBatchResponseV1Schema.parse(response.json()).results;
                expect(results.map(row => row.sessionId)).toEqual(ids);
                const byId = new Map<string, (typeof messages)[number]>(messages.map(row => [row.id, row]));
                for (const result of results) {
                    expect(result.messages?.status).toBe(200);
                    if (result.messages?.status !== 200)
                        continue;
                    expect(result.messages.body.messages).toHaveLength(7);
                    expect(result.messages.body.hasMore).toBe(false);
                    for (const message of result.messages.body.messages) {
                        expect(byId.get(message.id)?.sessionId).toBe(result.sessionId);
                        expect(message.accountActor).toMatchObject({ accountId: byId.get(message.id)?.authorAccountId, profile: { avatarUrl: null } });
                    }
                }
                expect(transactions).toBe(1);
                expect(profileBatches.reduce((sum, count) => sum + count, 0)).toBe(actors.length);
                expect(profileBatches.every(count => count + 2 <= 999)).toBe(true); // SQLite's portable bind contract, including LIMIT/OFFSET.
                console.info('CR01_CHUNK_COST', JSON.stringify({ provider, sessions: ids.length, transactions, profileBatches }));
            });
        }
        finally {
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: ids } } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            for (const accountIds of portableQueryChunks({ values: actors.map((actor): string => actor.id).concat(owner.id), bindingsPerValue: 1 })) {
                await db.account.deleteMany({ where: { id: { in: [...accountIds] } } });
            }
        }
    });
    it('CR01 preserves publication ceilings independently for hosted, partial and Machine-only transcripts', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
        try {
            await db.session.createMany({ data: (['hosted', 'server_partial', 'machine_only'] as const).map((currentStorageState, index) => ({
                    id: ids[index], accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
                    currentStorageState, acceptedThroughServerSeq: 1, seq: 2,
                })) });
            await db.sessionMessage.createMany({ data: ids.flatMap(sessionId => [1, 2].map(seq => ({ sessionId, seq, messageRole: 'agent',
                    content: { t: 'plain', v: { role: 'agent', content: [{ type: 'text', text: `${sessionId}:${seq}` }] } } } satisfies Prisma.SessionMessageCreateManyInput))) });
            await withAuthenticatedTestApp(app => { registerSessionReadBatchRoute(app); registerSessionMessageRoutes(app); }, async (app) => {
                const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                    payload: { sessionIds: ids, includeSnapshot: false, includeMessages: true } });
                expect(response.statusCode, response.body).toBe(200);
                const results = SessionReadBatchResponseV1Schema.parse(response.json()).results;
                for (let index = 0; index < ids.length; index++) {
                    const scalar = await app.inject({ method: 'GET', url: `/v1/sessions/${ids[index]}/messages?scope=all&roles=user,agent,event`, headers });
                    expect(results[index]?.messages).toEqual({ status: scalar.statusCode, body: scalar.json() });
                    const messages = results[index]?.messages;
                    expect(messages?.status).toBe(200);
                    if (messages?.status === 200)
                        expect(messages.body.messages.map(message => message.seq)).toEqual([[2, 1], [1], []][index]);
                }
            });
        }
        finally {
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: ids } } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
    it('CR01 admits each Session independently and withdraws/restores direct access at the next request', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const own = await db.session.create({ data: { accountId: reader.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const shared = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
                metadataLayoutVersion: 1, metadata: JSON.stringify(SessionSharedMetadataV1Schema.parse({ v: 1 })),
                ownerMetadata: JSON.stringify({ t: 'plain', v: SessionOwnerMetadataV1Schema.parse({ v: 1 }) }), encryptionMode: 'plain' } });
        const privateSession = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'e2ee' } });
        const share = () => db.sessionShare.create({ data: { sessionId: shared.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        try {
            await share();
            const sharedContent = { t: 'plain', v: { role: 'agent', content: [{ type: 'text', text: 'shared-content' }] } } satisfies Prisma.SessionMessageCreateManyInput['content'];
            await db.sessionMessage.createMany({ data: [shared.id, privateSession.id].map(sessionId => ({ sessionId, seq: 1, messageRole: 'agent',
                    content: sessionId === privateSession.id ? { t: 'encrypted', c: 'never-disclose-private-ciphertext' } : sharedContent })) });
            await withAuthenticatedTestApp(registerSessionReadBatchRoute, async (app) => {
                const headers = { 'x-test-user-id': reader.id, 'x-happier-account-stored-content-protocol': '4' };
                const read = async () => {
                    const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                        payload: { sessionIds: [own.id, shared.id, privateSession.id, 'missing-cr01', own.id],
                            accessProjectionVersion: 1, includeMessages: true } });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.body).not.toContain('never-disclose-private-ciphertext');
                    const results = SessionReadBatchResponseV1Schema.parse(response.json()).results;
                    expect(results[0]).toMatchObject({ detail: { status: 200 }, turns: { status: 200 }, messages: { status: 200 } });
                    expect(results[4]).toEqual(results[0]);
                    for (const result of results.slice(2, 4)) {
                        expect(result).toMatchObject({ detail: { status: 404 }, messages: { status: 404 } });
                        expect(result?.turns).toBeUndefined();
                    }
                    return results;
                };
                expect((await read())[1]?.messages).toMatchObject({ status: 200, body: { messages: [{ content: sharedContent }] } });
                await db.sessionShare.deleteMany({ where: { sessionId: shared.id } });
                expect((await read())[1]).toMatchObject({ detail: { status: 404 }, messages: { status: 404 } });
                await share();
                expect((await read())[1]).toMatchObject({ detail: { status: 200 }, turns: { status: 200 }, messages: { status: 200 } });
                const empty = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                    payload: { sessionIds: [], includeMessages: true } });
                expect(empty.json()).toEqual({ results: [] });
            });
        }
        finally {
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: [own.id, shared.id, privateSession.id] } } });
            await db.sessionShare.deleteMany({ where: { sessionId: { in: [own.id, shared.id, privateSession.id] } } });
            await db.session.deleteMany({ where: { accountId: { in: [owner.id, reader.id] } } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
        }
    });
    it.each(['turns', 'messages', 'all'] as const)('CR01 keeps %s batch IO constant for 1/2/20 Sessions and preserves scalar payloads', async (kind) => {
        const stamp = new Date('2026-10-01T00:00:00Z');
        const owner = await db.account.create({ data: { id: 'cr01-cost-owner', publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const ids = Array.from({ length: 20 }, (_, index) => `cr01-cost-session-${index}`);
        const content = (seq: number) => ({ t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: `message-${seq}` } } });
        try {
            await db.session.createMany({ data: ids.map(id => ({ id, accountId: owner.id, tag: id,
                    metadata: '{}', encryptionMode: 'plain', seq: 152, latestTurnId: 'turn',
                    createdAt: stamp, updatedAt: stamp, lastActiveAt: stamp })) });
            await db.sessionTurn.createMany({ data: ids.map(sessionId => ({ sessionId, turnId: 'turn', status: 'completed',
                    startedAt: 1n, updatedAt: 2n, terminalAt: 2n })) });
            const access = await inReadSnapshot(tx => resolveEffectiveSessionAccessForSessionsInTx(tx, {
                accountId: owner.id, sessionIds: ids, authentication: readSessionAccessAuthenticationFromRequest({ authAuthority: 'present_user' }),
            }));
            // More than a page in every Session distinguishes per-Session pages
            // from a global LIMIT, and catches a cursor borrowed from another id.
            await db.sessionMessage.createMany({ data: ids.flatMap(sessionId => Array.from({ length: 152 }, (_, index) => ({
                    id: `${sessionId}-message-${index + 1}`, sessionId, seq: index + 1, localId: `local-${index + 1}`,
                    messageRole: 'user', content: content(index + 1), createdAt: stamp, updatedAt: stamp,
                    authorAccountId: owner.id, inputAdmissionReceipt: buildSessionInputAdmissionReceipt({ issuer: 'authenticatedAccount', access: access.get(sessionId)! }),
                }))) });
            await withAuthenticatedTestApp(app => {
                registerSessionListingRoutes(app);
                registerSessionTurnMutationRoute(app);
                registerSessionMessageRoutes(app);
                registerSessionReadBatchRoute(app);
            }, async (app) => {
                const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
                const observations: Array<{
                    kind: string;
                    size: number;
                    operations: Record<string, number>;
                    transactions: number;
                }> = [];
                for (const size of [1, 2, 20]) {
                    const operations: Record<string, number> = {};
                    let transactions = 0;
                    const originalTransaction = db.$transaction;
                    db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args) {
                            transactions++;
                            return Reflect.apply(target, receiver, args);
                        } });
                    const observe = { before: (request: {
                            model?: string;
                            action: string;
                            args: unknown;
                        }) => {
                            const key = `${request.model ?? 'raw'}.${request.action}`;
                            operations[key] = (operations[key] ?? 0) + 1;
                            if (!request.model && JSON.stringify(request.args).includes('BEGIN DEFERRED'))
                                transactions++;
                        } };
                    const stop = provider === 'sqlite' ? observeSqliteRequests(observe) : observePrismaRequests(db, observe);
                    const response = await (async () => {
                        try {
                            return await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers, payload: {
                                    sessionIds: ids.slice(0, size), accessProjectionVersion: 1,
                                    includeSnapshot: kind !== 'messages', includeTurns: kind !== 'messages', includeMessages: kind !== 'turns',
                                } });
                        }
                        finally {
                            stop();
                            db.$transaction = originalTransaction;
                        }
                    })();
                    expect(response.statusCode, response.body).toBe(200);
                    const results = SessionReadBatchResponseV1Schema.parse(response.json()).results;
                    expect(results.map(result => result.sessionId)).toEqual(ids.slice(0, size));
                    for (const result of results) {
                        if (kind !== 'messages') {
                            expect(result.detail?.status).toBe(200);
                            expect(result.turns).toMatchObject({ status: 200, body: { sessionId: result.sessionId, latestTurnId: 'turn', turns: [{ turnId: 'turn' }] } });
                            if (size === 20 && (result === results[0] || result === results.at(-1))) {
                                const scalar = await app.inject({ method: 'GET', url: `/v2/sessions/${result.sessionId}?accessProjectionVersion=1`, headers });
                                expect(result.detail?.body).toEqual(scalar.json());
                                const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${result.sessionId}/turns`, headers });
                                expect(result.turns?.body).toEqual(turns.json());
                            }
                        }
                        if (kind !== 'turns') {
                            expect(result.messages).toMatchObject({ status: 200, body: { hasMore: true, nextBeforeSeq: 3, nextAfterSeq: null } });
                            if (result.messages?.status === 200) {
                                expect(result.messages.body.messages).toHaveLength(150);
                                expect(result.messages.body.messages[0]?.seq).toBe(152);
                                expect(result.messages.body.messages.at(-1)?.seq).toBe(3);
                            }
                            if (size === 20 && (result === results[0] || result === results.at(-1))) {
                                const scalar = await app.inject({ method: 'GET', url: `/v1/sessions/${result.sessionId}/messages?scope=all&roles=user,agent,event`, headers });
                                expect(result.messages?.body).toEqual(scalar.json());
                            }
                        }
                    }
                    observations.push({ kind, size, operations, transactions });
                    console.info('CR01_BATCH_COST', JSON.stringify({ provider, kind, size, operations, transactions,
                        payloadSha256: createHash('sha256').update(response.body).digest('hex') }));
                }
                // Changes must reach the real consumer after the measured quiet reads.
                await db.sessionMessage.update({ where: { id: `${ids[0]}-message-152` }, data: { content: content(999) } });
                const changed = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                    payload: { sessionIds: [ids[0]], includeSnapshot: false, includeMessages: true } });
                expect(changed.json().results[0].messages.body.messages[0].content).toEqual(content(999));
                const rows = observations;
                expect(rows[0]?.transactions).toBeGreaterThan(0);
                expect(rows.map(row => row.operations)).toEqual(rows.map(() => rows[0]!.operations));
                expect(rows.map(row => row.transactions)).toEqual(rows.map(() => rows[0]!.transactions));
            });
        }
        finally {
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: ids } } });
            await db.sessionTurn.deleteMany({ where: { sessionId: { in: ids } } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
}
