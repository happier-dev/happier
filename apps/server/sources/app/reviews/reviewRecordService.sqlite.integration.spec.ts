import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { inTx } from '@/storage/inTx';
import { assertReviewRoundBinding, writeReviewRoundState } from './reviewRecordService';
import { createArtifact, updateArtifact } from '@/app/artifacts/artifactWriteService';
import { readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import * as privacyKit from 'privacy-kit';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { listReviewsInTx } from './reviewListService';
import { createReviewRecordPortV1, ReviewArtifactHeaderV1Schema, type ReviewArtifactTransportV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { projectReviewFindingRoundStatusV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import { createReviewCommentOperations } from './comments/operations';
import { createSqlReviewCommentStore } from './comments/store';
import { resolveReviewAccessInTx } from './reviewAccess';

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
    it('keeps an absent finding unknown after real partial settlement without changing its decision', async () => {
        const artifactId = randomUUID();
        const read: ReviewArtifactTransportV1['read'] = async id => {
            const result = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: accountId, artifactId: id }));
            if (!result.ok) return null;
            const header = ReviewArtifactHeaderV1Schema.parse(decodePlainArtifactStoredContent(
                privacyKit.encodeBase64(result.artifact.header)));
            const body = decodePlainArtifactStoredContent(privacyKit.encodeBase64(result.artifact.body));
            if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') {
                throw new Error('Review body was not opened');
            }
            return { artifactId: id, header, body: body.body,
                revision: { headerVersion: result.artifact.headerVersion, bodyVersion: result.artifact.bodyVersion } };
        };
        // Only the Artifact transport is adapted; its real access, CAS and SQLite writers remain in the path.
        const records = createReviewRecordPortV1({ read,
            create: async input => {
                const result = await createArtifact({ actorUserId: accountId, artifactId: input.artifactId,
                    header: privacyKit.decodeBase64(encodePlainArtifactStoredContent(input.header)),
                    body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: input.body })),
                    dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), reviewMetadata: input.reviewMetadata });
                if (!result.ok) throw new Error(JSON.stringify(result));
                const opened = await read(input.artifactId);
                if (!opened) throw new Error('Created Review unavailable');
                return opened;
            },
            update: async input => {
                const result = await updateArtifact({ actorUserId: accountId, artifactId: input.artifactId,
                    header: { bytes: privacyKit.decodeBase64(encodePlainArtifactStoredContent(input.header)),
                        expectedVersion: input.expectedRevision.headerVersion },
                    body: { bytes: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: input.body })),
                        expectedVersion: input.expectedRevision.bodyVersion }, reviewMetadata: input.reviewMetadata });
                if (!result.ok || !result.header || !result.body) throw new Error(JSON.stringify(result));
                return { ok: true, revision: { headerVersion: result.header.version, bodyVersion: result.body.version } };
            },
        });
        const start = { reviewId: artifactId, title: 'Partial round evidence', subjectKind: 'repository' as const,
            sourceKind: 'direct' as const, reviewerIds: ['reviewer-a', 'reviewer-b'], startedAt: 10 };
        const first = await records.start(start);
        const reviewAccess = await inTx(tx => resolveReviewAccessInTx(tx, { actorAccountId: accountId, reviewId: artifactId }));
        if (!reviewAccess) throw new Error('Owner Review admission unavailable');
        const principal = { accountId, actor: { kind: 'user' as const, userId: accountId }, reviewAccess };
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), { now: () => 15, createId: () => randomUUID() });
        const created = await operations.create({ ...principal, input: { reviewId: artifactId, findingIdentity: 'e'.repeat(64),
            body: 'Retain this finding decision', anchor: { kind: 'file', filePath: 'reader.ts' },
            snapshot: { kind: 'none', capturedAt: 15 }, authorIntent: 'open', clientMutationId: randomUUID(),
            appearance: { roundOrdinal: first.roundOrdinal, runId: 'first-run', reviewerId: 'reviewer-a' } } });
        const ignored = await operations.transition({ ...principal, input: { reviewId: artifactId, commentId: created.comment.id,
            expectedState: 'open', expectedServerRevision: created.comment.serverRevision, toState: 'dismissed',
            reviewTriageStatus: 'reject', reason: 'Not reachable', clientMutationId: randomUUID() } });
        await records.settle({ ...first, outcome: 'completed', finishedAt: 20, runs: [], reviewerOutcomes: start.reviewerIds.map(key => ({
            key, outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' } })) });
        const second = await records.start({ ...start, startedAt: 30, newRound: true });
        const partial = await records.settle({ ...second, outcome: 'failed', finishedAt: 40, runs: [], reviewerOutcomes: [
            { key: 'reviewer-a', outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' } },
            { key: 'reviewer-b', outcome: 'failed', errorCode: 'provider_model_not_found' },
        ] });
        expect(partial.state).toBe('partial');
        const record = await records.read(artifactId);
        expect(record?.rounds.map(round => round.state)).toEqual(['completed', 'partial']);
        expect(await db.reviewMetadata.findUnique({ where: { artifactId } })).toMatchObject({ state: 'partial', currentRoundOrdinal: 2 });
        const retained = (await operations.get({ ...principal, input: { commentId: created.comment.id, includeHistory: true } })).comment;
        expect(retained).toMatchObject({ state: 'dismissed', reviewTriageStatus: 'reject', serverRevision: ignored.comment.serverRevision });
        expect(retained.appearances).toEqual(ignored.comment.appearances);
        const round = { ...second, state: partial.state, reviewerIds: partial.reviewerIds };
        expect(projectReviewFindingRoundStatusV1(retained, round)).toBe('unknown');
        const third = await records.start({ ...start, startedAt: 50, newRound: true });
        const completed = await records.settle({ ...third, outcome: 'completed', finishedAt: 60, runs: [],
            reviewerOutcomes: start.reviewerIds.map(key => ({ key, outcome: 'completed', reviewOutcome: 'complete',
                materialization: { kind: 'complete' } })) });
        expect(completed.state).toBe('completed');
        expect(projectReviewFindingRoundStatusV1(retained, { ...third, state: completed.state,
            reviewerIds: completed.reviewerIds })).toBe('looks_addressed');
    });
    it('keeps clean, failed and cancelled rounds queryable independently of findings or runs', async () => {
        const metadata = { projectSourceId: randomUUID(), workflowId: randomUUID(), subjectKind: 'repository' as const,
            sourceKind: 'workflow' as const, currentRoundOrdinal: 1, state: 'running' as const, startedAt: 10, finishedAt: null };
        const writes: string[] = [];
        const restore = observePrismaRequests(db, { before: request => {
            if (request.model === 'ReviewMetadata' && /^(?:create|update|upsert|delete)/.test(request.action)) writes.push(request.action);
        } });
        try {
            expect(await inTx(tx => writeReviewRoundState(tx, { reviewId, actorAccountId: accountId, metadata }))).toBe(true);
            await expect(assertReviewRoundBinding({ reviewId, roundOrdinal: 1 })).resolves.toBeUndefined();
            expect(await inTx(tx => writeReviewRoundState(tx, { reviewId, actorAccountId: accountId, metadata: { currentRoundOrdinal: 1, state: 'completed', finishedAt: 20 } }))).toBe(true);
            expect(writes.length).toBeGreaterThan(0);
            expect(writes.length).toBeLessThanOrEqual(2);
            const settledWrites = writes.length;
            expect(await inTx(tx => writeReviewRoundState(tx, { reviewId, actorAccountId: accountId, metadata: { currentRoundOrdinal: 1, state: 'completed', finishedAt: 20 } }))).toBe(false);
            expect(writes.length - settledWrites).toBe(0);
        } finally { restore(); }
        await expect(inTx(tx => writeReviewRoundState(tx, { reviewId, actorAccountId: accountId,
            metadata: { currentRoundOrdinal: 1, state: 'failed', finishedAt: 21 } }))).rejects.toMatchObject({ code: 'invalid-params' });
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: reviewId } }))
            .toMatchObject({ currentRoundOrdinal: 1, state: 'completed', finishedAt: new Date(20) });
        await inTx(tx => writeReviewRoundState(tx, { reviewId, actorAccountId: accountId, metadata: { ...metadata,
            projectSourceId: null, workflowId: null, subjectKind: 'comparison', sourceKind: 'direct',
            currentRoundOrdinal: 2, startedAt: 30 } }));
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: reviewId } })).toMatchObject({
            ...metadata, currentRoundOrdinal: 2, startedAt: new Date(30),
        });
        await expect(assertReviewRoundBinding({ reviewId, roundOrdinal: 1 })).rejects.toMatchObject({ code: 'invalid-params' });
        await inTx(tx => writeReviewRoundState(tx, { reviewId, actorAccountId: accountId, metadata: { currentRoundOrdinal: 2, state: 'failed', finishedAt: 40 } }));
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: reviewId } })).toMatchObject({ state: 'failed', currentRoundOrdinal: 2 });
        await inTx(tx => writeReviewRoundState(tx, { reviewId, actorAccountId: accountId, metadata: { ...metadata, currentRoundOrdinal: 3, startedAt: 50 } }));
        await inTx(tx => writeReviewRoundState(tx, { reviewId, actorAccountId: accountId, metadata: { currentRoundOrdinal: 3, state: 'cancelled', finishedAt: 60 } }));
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: reviewId } })).toMatchObject({ state: 'cancelled', currentRoundOrdinal: 3 });
        await expect(inTx(tx => writeReviewRoundState(tx, { reviewId, actorAccountId: accountId,
            metadata: { currentRoundOrdinal: 4, state: 'failed', finishedAt: 70 } }))).rejects.toMatchObject({ code: 'invalid-params' });
        await expect(inTx(tx => writeReviewRoundState(tx, { reviewId: randomUUID(), actorAccountId: accountId,
            metadata: { currentRoundOrdinal: 1, state: 'failed', finishedAt: 70 } }))).rejects.toMatchObject({ code: 'invalid-params' });
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
    it.each([
        { outcome: 'failed', latest: 'running' },
        { outcome: 'cancelled', latest: 'running' },
        { outcome: 'completed', latest: 'running' },
        { outcome: 'failed', latest: 'completed' },
    ] as const)('persists an older $outcome round without changing the latest $latest round', async ({ outcome, latest }) => {
        const artifactId = randomUUID();
        const header = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'review.v1', v: 1, reviewId: artifactId, title: 'Overlapping rounds' }));
        const first = { ordinal: 1, state: 'running', startedAt: 10, finishedAt: null, reviewerIds: [], runs: [] };
        const second = { ...first, ordinal: 2, startedAt: 30 };
        const body = (rounds: readonly unknown[]) => privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds }) }));
        const metadata = { projectSourceId: null, workflowId: null, subjectKind: 'comparison' as const,
            sourceKind: 'direct' as const, currentRoundOrdinal: 1, state: 'running' as const, startedAt: 10, finishedAt: null };
        expect(await createArtifact({ actorUserId: accountId, artifactId, header, body: body([first]),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), reviewMetadata: metadata })).toMatchObject({ ok: true });
        expect(await updateArtifact({ actorUserId: accountId, artifactId,
            header: { bytes: header, expectedVersion: 1 }, body: { bytes: body([first, second]), expectedVersion: 1 },
            reviewMetadata: { ...metadata, currentRoundOrdinal: 2, startedAt: 30 } })).toMatchObject({ ok: true });
        let version = 2;
        const latestRound = latest === 'running' ? second : { ...second, state: latest, finishedAt: 40 };
        if (latest !== 'running') {
            expect(await updateArtifact({ actorUserId: accountId, artifactId,
                header: { bytes: header, expectedVersion: version }, body: { bytes: body([first, latestRound]), expectedVersion: version },
                reviewMetadata: { currentRoundOrdinal: 2, state: latest, finishedAt: 40 } })).toMatchObject({ ok: true });
            version++;
        }
        const settledBody = body([{ ...first, state: outcome, finishedAt: 50 }, latestRound]);
        expect(await updateArtifact({ actorUserId: accountId, artifactId,
            header: { bytes: header, expectedVersion: version }, body: { bytes: settledBody, expectedVersion: version },
            reviewMetadata: { currentRoundOrdinal: 1, state: outcome, finishedAt: 50 } })).toMatchObject({ ok: true });
        expect(await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: accountId, artifactId })))
            .toMatchObject({ ok: true, artifact: { body: settledBody } });
        expect(await db.reviewMetadata.findUnique({ where: { artifactId } })).toMatchObject({
            currentRoundOrdinal: 2, state: latest, startedAt: new Date(30), finishedAt: latest === 'running' ? null : new Date(40),
        });
    });
    it('records the producing Workflow run and the Session position each round covered', async () => {
        const artifactId = randomUUID();
        const header = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'review.v1', v: 1, reviewId: artifactId, title: 'Session review' }));
        const body = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [] }) }));
        const session = await db.session.create({ data: { accountId, tag: randomUUID(), metadata: '{}', seq: 7 } });
        const start = { projectSourceId: null, workflowId: 'workflow-1', subjectKind: 'comparison' as const,
            sourceKind: 'workflow' as const, currentRoundOrdinal: 1, state: 'running' as const, startedAt: 10, finishedAt: null,
            workflowRunId: 'run-1', sourceSessionId: session.id };
        const directId = randomUUID();
        await db.artifact.create({ data: { id: directId, accountId, kind: 'v1:other:review.v1',
            header: Buffer.from('sealed-header'), body: Buffer.from('sealed-body'), dataEncryptionKey: Buffer.from('key') } });
        expect(await inTx(tx => writeReviewRoundState(tx, { reviewId: directId, actorAccountId: accountId, metadata: start }))).toBe(true);
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: directId } }))
            .toMatchObject({ workflowRunId: 'run-1', sourceSessionId: session.id, sourceSessionSeq: 7 });
        expect(await createArtifact({ actorUserId: accountId, artifactId, header, body,
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), reviewMetadata: start })).toMatchObject({ ok: true });
        await db.session.update({ where: { id: session.id }, data: { seq: 12 } });
        expect(await updateArtifact({ actorUserId: accountId, artifactId,
            header: { bytes: header, expectedVersion: 1 }, body: { bytes: body, expectedVersion: 1 },
            reviewMetadata: { currentRoundOrdinal: 1, state: 'completed', finishedAt: 20 } })).toMatchObject({ ok: true });
        expect(await db.reviewMetadata.findUnique({ where: { artifactId } })).toMatchObject({ workflowRunId: 'run-1', sourceSessionSeq: 7 });
        expect(await updateArtifact({ actorUserId: accountId, artifactId,
            header: { bytes: header, expectedVersion: 2 }, body: { bytes: body, expectedVersion: 2 },
            reviewMetadata: { ...start, currentRoundOrdinal: 2, startedAt: 30, workflowRunId: 'run-2' } })).toMatchObject({ ok: true });
        expect(await db.reviewMetadata.findUnique({ where: { artifactId } }))
            .toMatchObject({ workflowRunId: 'run-1', sourceSessionId: session.id, sourceSessionSeq: 12 });
        const byRun = await inTx(tx => listReviewsInTx(tx, { actorAccountId: accountId, workflowRunId: 'run-1', limit: 5 }));
        expect(byRun.items.map(item => [item.reviewId, item.sourceSessionSeq]).sort()).toEqual([[artifactId, 12], [directId, 7]].sort());
        expect((await inTx(tx => listReviewsInTx(tx, { actorAccountId: accountId, workflowRunId: 'run-2', limit: 5 }))).items).toEqual([]);
        expect((await inTx(tx => listReviewsInTx(tx, { actorAccountId: accountId, sourceSessionId: session.id, limit: 5 })))
            .items.map(item => item.reviewId).sort()).toEqual([artifactId, directId].sort());

        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.session.create({ data: { accountId: stranger.id, tag: randomUUID(), metadata: '{}', seq: 3 } });
        const refusedId = randomUUID();
        expect(await createArtifact({ actorUserId: accountId, artifactId: refusedId, header, body,
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            reviewMetadata: { ...start, sourceSessionId: foreign.id } })).toMatchObject({ ok: false });
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: refusedId } })).toBeNull();
    });
});
