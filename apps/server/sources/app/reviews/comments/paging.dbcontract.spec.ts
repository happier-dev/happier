import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealReviewCommentSensitiveEnvelopeV1, splitReviewCommentV1, type ReviewCommentV1 } from '@happier-dev/protocol';
import { db, initDbMysql, initDbPostgres } from '@/storage/db';
import { buildReviewCommentCanonicalStorageValues } from './accountEncryptionMigrationPersistence';
import { createSqlReviewCommentStore } from './store';

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
});
