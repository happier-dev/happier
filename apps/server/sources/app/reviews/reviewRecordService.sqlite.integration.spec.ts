import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { inTx } from '@/storage/inTx';
import { assertReviewRoundBinding, writeReviewRoundState } from './reviewRecordService';
import { createArtifact, updateArtifact } from '@/app/artifacts/artifactWriteService';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import * as privacyKit from 'privacy-kit';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';

describe('durable Review lifecycle metadata', () => {
    const accountId = randomUUID();
    const reviewId = randomUUID();
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-review-record-', initEncrypt: true, initAuth: true });
        await db.account.create({ data: { id: accountId, publicKey: `pk-${accountId}`, encryptionMode: 'plain' } });
        await db.artifact.create({ data: { id: reviewId, accountId, kind: 'v1:other:review.v1',
            header: Buffer.from('sealed-header'), body: Buffer.from('sealed-body'), dataEncryptionKey: Buffer.from('key') } });
    }, 180_000);
    afterAll(async () => {
        await harness?.close();
    });
    it('keeps clean, failed and cancelled rounds queryable independently of findings or runs', async () => {
        const metadata = { projectSourceId: randomUUID(), workflowId: randomUUID(), subjectKind: 'repository' as const,
            sourceKind: 'workflow' as const, currentRoundOrdinal: 1, state: 'running' as const, startedAt: 10, finishedAt: null };
        const writes: string[] = [];
        const restore = observePrismaRequests(db, { before: request => {
            if (request.model === 'ReviewMetadata' && /^(?:create|update|upsert|delete)/.test(request.action)) writes.push(request.action);
        } });
        try {
            expect(await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata }))).toBe(true);
            await expect(assertReviewRoundBinding({ reviewId, roundOrdinal: 1 })).resolves.toBeUndefined();
            expect(await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata: { currentRoundOrdinal: 1, state: 'completed', finishedAt: 20 } }))).toBe(true);
            expect(writes.length).toBeGreaterThan(0);
            expect(writes.length).toBeLessThanOrEqual(2);
            const settledWrites = writes.length;
            expect(await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata: { currentRoundOrdinal: 1, state: 'completed', finishedAt: 20 } }))).toBe(false);
            expect(writes.length - settledWrites).toBe(0);
        } finally { restore(); }
        await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata: { ...metadata,
            projectSourceId: null, workflowId: null, subjectKind: 'comparison', sourceKind: 'direct',
            currentRoundOrdinal: 2, startedAt: 30 } }));
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: reviewId } })).toMatchObject({
            ...metadata, currentRoundOrdinal: 2, startedAt: new Date(30),
        });
        await expect(assertReviewRoundBinding({ reviewId, roundOrdinal: 1 })).rejects.toMatchObject({ code: 'invalid-params' });
        await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata: { currentRoundOrdinal: 2, state: 'failed', finishedAt: 40 } }));
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: reviewId } })).toMatchObject({ state: 'failed', currentRoundOrdinal: 2 });
        await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata: { ...metadata, currentRoundOrdinal: 3, startedAt: 50 } }));
        await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata: { currentRoundOrdinal: 3, state: 'cancelled', finishedAt: 60 } }));
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: reviewId } })).toMatchObject({ state: 'cancelled', currentRoundOrdinal: 3 });
    });
    it('commits sealed content and queryable round state through the existing Artifact writer', async () => {
        const artifactId = randomUUID();
        const header = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'review.v1', v: 1, reviewId: artifactId, title: 'Private review' }));
        const body = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [] }) }));
        const metadata = { projectSourceId: null, workflowId: null, subjectKind: 'comparison' as const,
            sourceKind: 'direct' as const, currentRoundOrdinal: 1, state: 'running' as const, startedAt: 10, finishedAt: null };
        expect(await createArtifact({ actorUserId: accountId, artifactId, header, body,
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), reviewMetadata: metadata })).toMatchObject({ ok: true });
        expect(await db.reviewMetadata.findUnique({ where: { artifactId } })).toMatchObject({ state: 'running' });
        expect(await updateArtifact({ actorUserId: accountId, artifactId,
            header: { bytes: header, expectedVersion: 1 }, body: { bytes: body, expectedVersion: 1 },
            reviewMetadata: { currentRoundOrdinal: 1, state: 'completed', finishedAt: 20 } })).toMatchObject({ ok: true });
        expect(await db.reviewMetadata.findUnique({ where: { artifactId } })).toMatchObject({ state: 'completed' });
        expect(await updateArtifact({ actorUserId: accountId, artifactId,
            header: { bytes: header, expectedVersion: 2 }, body: { bytes: body, expectedVersion: 2 },
            reviewMetadata: { ...metadata, projectSourceId: randomUUID(), workflowId: randomUUID(),
                subjectKind: 'repository', sourceKind: 'workflow', currentRoundOrdinal: 2, startedAt: 30 } })).toMatchObject({ ok: true });
        expect(await db.reviewMetadata.findUnique({ where: { artifactId } })).toMatchObject({
            ...metadata, currentRoundOrdinal: 2, startedAt: new Date(30),
        });
    });
});
