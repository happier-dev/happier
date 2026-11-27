import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealReviewCommentSensitiveEnvelopeV1, splitReviewCommentV1, type ReviewCommentV1 } from '@happier-dev/protocol';
import { db, initDbMysql, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { buildReviewCommentCanonicalStorageValues } from './accountEncryptionMigrationPersistence';
import { createSqlReviewCommentStore } from './store';
import { createReviewCommentOperations } from './operations';
import { claimReviewCommentPublication } from '@/testkit/reviewCommentPublicationTestkit';

describe('Review comment structural SQL paging', () => {
    const accountId = `review-paging-${randomUUID()}`;
    let connected = false;
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('Missing disposable DB contract DATABASE_URL');
        if (process.env.HAPPIER_DB_PROVIDER === 'mysql') await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
        await db.account.create({ data: { id: accountId, publicKey: `pk-${accountId}`, encryptionMode: 'plain' } });
    });
    afterAll(async () => {
        if (!connected) return;
        await db.artifact.deleteMany({ where: { accountId } });
        await db.account.deleteMany({ where: { id: accountId } });
        await db.$disconnect();
    });

    it.each([1000, 10000])('reads one candidate page from %i rows with history/author filters before LIMIT and tied keysets', async (size) => {
        const projectId = `project-${size}`;
        const commentPrefix = `${accountId}-${projectId}`;
        const makeRow = (index: number) => {
            const id = `${commentPrefix}-${String(index).padStart(5, '0')}`;
            const matching = index < 3;
            const history = !matching && index % 2 === 0;
            const comment: ReviewCommentV1 = { v: 1, id, accountId, projectId,
                anchor: { kind: 'file', filePath: 'src/a.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
                body: 'Finding', bodyVersion: 1, edits: [], author: { kind: 'user', userId: matching || history ? accountId : 'other' },
                state: history ? 'resolved' : 'open', flags: {}, dispositions: {}, threadId: id,
                transitions: [], createdAt: 1, updatedAt: matching ? 1 : 2, serverRevision: matching && index === 0 ? 1 : 2 };
            const split = splitReviewCommentV1(comment);
            const canonical = buildReviewCommentCanonicalStorageValues({ structural: split.structural,
                targetSensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'plain' }) });
            return { ...canonical, id, accountId, projectId, threadId: id, state: comment.state,
                flagsJson: '{}', authorJson: JSON.stringify(comment.author), dispositionsJson: '{}',
                bodyVersion: 1, serverRevision: comment.serverRevision, createdAt: BigInt(1), updatedAt: BigInt(comment.updatedAt) };
        };
        for (let offset = 0; offset < size; offset += 500) {
            await db.reviewComment.createMany({ data: Array.from({ length: Math.min(500, size - offset) }, (_, index) => makeRow(offset + index)) });
        }
        const raw = db.$queryRaw;
        const reads: number[] = [];
        const bytes: number[] = [];
        // Observe the real database result size without replacing SQL execution or domain logic.
        db.$queryRaw = new Proxy(raw, { apply: async (target, thisArg, args) => {
            const rows: unknown = await Reflect.apply(target, thisArg, args);
            if (Array.isArray(rows)) {
                reads.push(rows.length);
                bytes.push(Buffer.byteLength(JSON.stringify(rows, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)));
            }
            return rows;
        } });
        try {
            const store = createSqlReviewCommentStore();
            const filters = { projectId, states: [], taxonomyIds: [], includeHistory: false,
                authorKind: 'user' as const, authorId: accountId, limit: 2 };
            const first = await store.listSources({ accountId, filters });
            console.info(`[review-comment-paging] inventory=${size} rows=${reads[0]} bytes=${bytes[0]} nonmatches=active-other-author,resolved-same-author`);
            expect(first.items.map(({ structural }) => structural.id)).toEqual([`${commentPrefix}-00002`, `${commentPrefix}-00001`]);
            expect(first.cursor).toEqual(expect.any(String));
            expect(reads).toEqual([3]);
            const second = await store.listSources({ accountId, filters: { ...filters, cursor: first.cursor! } });
            expect(second.items.map(({ structural }) => structural.id)).toEqual([`${commentPrefix}-00000`]);
            expect(second.cursor).toBeNull();
            expect(reads).toEqual([3, 1]);
            reads.length = 0;
            const selected = await store.listSources({ accountId, filters: { ...filters,
                commentIds: [`${commentPrefix}-00000`], includeHistory: true } });
            expect(selected.items.map(({ structural }) => structural.id)).toEqual([`${commentPrefix}-00000`]);
            expect(selected.cursor).toBeNull();
            expect(reads).toEqual([1]);
            const empty = await store.listSources({ accountId, filters: { ...filters, commentIds: [] } });
            expect(empty).toEqual({ items: [], cursor: null });
            expect(reads).toEqual([1, 0]);
            await expect(store.listSources({ accountId, filters: { ...filters, authorId: 'other', cursor: first.cursor! } }))
                .rejects.toMatchObject({ code: 'review_comment_invalid_filter' });
            expect(reads).toEqual([1, 0]);
        } finally {
            db.$queryRaw = raw;
        }
    });

    it('loads publication admission as one set for both claim and settlement', async () => {
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 2, createId: prefix => `${prefix}-${randomUUID()}`,
        });
        const principal = { accountId, storageMode: 'plain' as const, actor: { kind: 'user' as const, userId: accountId },
            reviewAccess: { reviewId, ownerAccountId: accountId, level: 'owner' as const, encryptionMode: 'plain' as const } };
        const comments = [];
        for (let index = 0; index < 10; index++) {
            comments.push((await operations.create({ ...principal, input: { reviewId,
                anchor: { kind: 'file', filePath: `publication-${index}.ts` }, snapshot: { kind: 'none', capturedAt: 1 },
                body: `Finding ${index}`, authorIntent: 'open', clientMutationId: `publication-${index}` } })).comment);
        }
        const request = { ...principal, input: { target: { providerId: 'github', configuredAccountId: 'github-account',
            entryRef: { sourceId: 'github', kindId: 'pull-request', collisionScope: 'github:repo', entryId: '42' }, subtarget: null },
            baseRevision: 'base', headRevision: 'head', verdict: null,
            entries: comments.map((comment, index) => ({ happierCommentId: comment.id, expectedServerRevision: comment.serverRevision,
                anchor: comment.anchor, snapshot: { kind: 'none' as const, capturedAt: 1 }, body: `Finding ${index}` })) } };
        const sourceReads: number[] = [];
        let appearanceReads = 0;
        const raw = db.$queryRaw;
        const findAppearances = db.reviewCommentAppearance.findMany;
        // Observe genuine database boundaries without replacing SQL or admission logic.
        db.$queryRaw = new Proxy(raw, { apply: async (target, thisArg, args) => {
            const rows: unknown = await Reflect.apply(target, thisArg, args);
            if (Array.isArray(rows) && rows.some(row => row && typeof row === 'object' && 'body_envelope_json' in row)) sourceReads.push(rows.length);
            return rows;
        } });
        db.reviewCommentAppearance.findMany = new Proxy(findAppearances, { apply: (target, thisArg, args) => {
            appearanceReads++;
            return Reflect.apply(target, thisArg, args);
        } });
        try {
            const claim = await claimReviewCommentPublication(operations, request);
            expect(claim).toMatchObject({ disposition: 'dispatch' });
            expect(claim.entries.map(entry => entry.happierCommentId)).toEqual(comments.map(comment => comment.id));
            const settled = await claimReviewCommentPublication(operations, { ...request, input: { ...request.input,
                settlement: { dispatchToken: claim.dispatchToken, result: { publicationPlanId: claim.publicationPlanId,
                    entries: claim.entries.map(entry => ({ ...entry, outcome: { kind: 'failed' as const, code: 'provider-refused' } })),
                    verdict: { kind: 'notRequested' as const } } } } });
            expect(settled.priorResult?.entries).toHaveLength(comments.length);
            console.info(`[review-publication-admission] selected=${comments.length} phases=claim,settlement sourceQueries=${sourceReads.length} appearanceQueries=${appearanceReads}`);
            expect(sourceReads).toEqual([comments.length, comments.length]);
            expect(appearanceReads).toBe(2);
        } finally {
            db.$queryRaw = raw;
            db.reviewCommentAppearance.findMany = findAppearances;
        }
    });

    it.each([10, 200])('commits %i selected bulk decisions in one transaction and publication', async (size) => {
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        const comments = Array.from({ length: size }, (_, index): ReviewCommentV1 => ({
            v: 1, id: `${reviewId}-${index}`, accountId, reviewId, roundOrdinal: 1,
            anchor: { kind: 'file', filePath: `src/${index}.ts` }, snapshot: { kind: 'none', capturedAt: 1 },
            body: `Finding ${index}`, bodyVersion: 1, edits: [], author: { kind: 'user', userId: accountId },
            state: 'open', flags: {}, dispositions: {}, threadId: `${reviewId}-${index}`,
            transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1,
        }));
        await db.reviewComment.createMany({ data: comments.map(comment => {
            const split = splitReviewCommentV1(comment);
            return { ...buildReviewCommentCanonicalStorageValues({ structural: split.structural,
                targetSensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'plain' }) }),
                id: comment.id, accountId, reviewId, roundOrdinal: 1, threadId: comment.threadId, state: comment.state,
                flagsJson: '{}', authorJson: JSON.stringify(comment.author), dispositionsJson: '{}',
                bodyVersion: 1, serverRevision: 1, createdAt: BigInt(1), updatedAt: BigInt(1) };
        }) });
        const reads: number[] = [];
        const raw = db.$queryRaw;
        const transaction = db.$transaction;
        let transactions = 0;
        let reviewLocks = 0;
        const before = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } });
        // Count actual persistent transactions, preserving every real callback and commit.
        db.$transaction = new Proxy(transaction, { apply: (target, thisArg, args) => {
            transactions++;
            const callback: unknown = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, thisArg, args);
            return Reflect.apply(target, thisArg, [(tx: Tx) => {
                const query = tx.$queryRawUnsafe;
                tx.$queryRawUnsafe = new Proxy(query, { apply: (sql, sqlThis, sqlArgs) => {
                    if (typeof sqlArgs[0] === 'string' && /FROM ["`]Artifact["`].*FOR (?:NO KEY )?UPDATE/.test(sqlArgs[0])) reviewLocks++;
                    return Reflect.apply(sql, sqlThis, sqlArgs);
                } });
                return Promise.resolve(Reflect.apply(callback, undefined, [tx])).finally(() => { tx.$queryRawUnsafe = query; });
            }, ...args.slice(1)]);
        } });
        // Observe the selected source reads while preserving the real SQL and mutations.
        db.$queryRaw = new Proxy(raw, { apply: async (target, thisArg, args) => {
            const rows: unknown = await Reflect.apply(target, thisArg, args);
            if (Array.isArray(rows) && rows.some(row => row && typeof row === 'object' && 'body_envelope_json' in row)) reads.push(rows.length);
            return rows;
        } });
        try {
            const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
                now: () => 2, createId: prefix => `${prefix}-${randomUUID()}`,
            });
            const result = await operations.bulkTransition({ accountId, storageMode: 'plain',
                actor: { kind: 'user', userId: accountId },
                reviewAccess: { reviewId, ownerAccountId: accountId, level: 'owner', encryptionMode: 'plain' },
                input: { reviewId, commentIds: comments.map(comment => comment.id), expectedState: 'open',
                    toState: 'dismissed', reason: 'Reviewed selected findings', evidence: [],
                    expectedServerRevisions: Object.fromEntries(comments.map(comment => [comment.id, 1])),
                    clientMutationId: 'bulk-selected' } });
            expect(result.failed).toEqual([]);
            expect(result.updated.map(comment => [comment.id, comment.state, comment.serverRevision]))
                .toEqual(comments.map(comment => [comment.id, 'dismissed', 2]));
            expect(await db.reviewComment.count({ where: { reviewId, state: 'dismissed', serverRevision: 2 } })).toBe(comments.length);
            const after = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } });
            const publication = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: { accountId, kind: 'artifact', entityId: reviewId } } });
            console.info(`[review-bulk-write] selected=${comments.length} transactions=${transactions} reviewLocks=${reviewLocks} publications=${after.seq - before.seq} sourceQueries=${reads.length}`);
            expect(reads).toEqual([comments.length]);
            expect(transactions).toBe(1);
            expect(reviewLocks).toBe(1);
            expect(after.seq - before.seq).toBe(1);
            expect(publication.hint).toMatchObject({ reviewComments: { changes: comments.map(comment => ({ commentId: comment.id, serverRevision: 2, state: 'dismissed' })) } });
        } finally { db.$queryRaw = raw; db.$transaction = transaction; }
    });

    it('keeps valid bulk siblings when a prepared comment becomes stale before persistence', async () => {
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 2, createId: prefix => `${prefix}-${randomUUID()}`,
        });
        const principal = { accountId, storageMode: 'plain' as const, actor: { kind: 'user' as const, userId: accountId },
            reviewAccess: { reviewId, ownerAccountId: accountId, level: 'owner' as const, encryptionMode: 'plain' as const } };
        const comments = [];
        for (let index = 0; index < 3; index++) {
            comments.push((await operations.create({ ...principal, input: { reviewId,
                anchor: { kind: 'file', filePath: `stale-${index}.ts` }, snapshot: { kind: 'none', capturedAt: 1 },
                body: `Finding ${index}`, authorIntent: 'open', clientMutationId: `stale-${reviewId}-${index}` } })).comment);
        }
        const transaction = db.$transaction;
        // A real competing mutation wins after preparation, before the bulk transaction begins.
        db.$transaction = new Proxy(transaction, { apply: async (target, thisArg, args) => {
            db.$transaction = transaction;
            await operations.transition({ ...principal, input: { reviewId, commentId: comments[0]!.id,
                expectedState: 'open', toState: 'dismissed', reason: 'Competing decision', evidence: [], expectedServerRevision: 1,
                clientMutationId: `competing-${reviewId}` } });
            return Reflect.apply(target, thisArg, args);
        } });
        try {
            const result = await operations.bulkTransition({ ...principal, input: { reviewId,
                commentIds: comments.map(comment => comment.id), expectedState: 'open', toState: 'dismissed',
                reason: 'Bulk decision', evidence: [], expectedServerRevisions: Object.fromEntries(comments.map(comment => [comment.id, 1])),
                clientMutationId: `stale-bulk-${reviewId}` } });
            expect(result.failed).toMatchObject([{ commentId: comments[0]!.id, errorCode: 'review_comment_conflict' }]);
            expect(result.updated.map(comment => comment.id)).toEqual(comments.slice(1).map(comment => comment.id));
            expect(await db.reviewComment.count({ where: { reviewId, state: 'dismissed', serverRevision: 2 } })).toBe(3);
            expect(await db.reviewCommentEvent.count({ where: { commentId: { in: comments.map(comment => comment.id) } } })).toBe(6);
        } finally { db.$transaction = transaction; }
    });
});
