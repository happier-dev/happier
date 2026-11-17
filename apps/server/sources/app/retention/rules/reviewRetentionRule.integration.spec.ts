import { randomUUID } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { REVIEW_ARTIFACT_KIND_V1, ReviewArtifactHeaderV1Schema,
    ReviewArtifactBodyV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';

import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { runRetentionDryRun } from '@/app/retention/runtime/runRetentionDryRun';
import { runRetentionSweep } from '@/app/retention/runtime/runRetentionSweep';
import { createRetentionRuleRegistry } from '@/app/retention/runtime/retentionRuleRegistry';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

const now = new Date('2026-11-17T12:00:00Z');
const old = new Date('2026-01-01T00:00:00Z');
const cutoff = new Date('2026-11-10T12:00:00Z');
const env = {
    HAPPIER_SERVER_RETENTION__ENABLED: 'true',
    HAPPIER_SERVER_RETENTION__REVIEWS__MODE: 'delete_older_than',
    HAPPIER_SERVER_RETENTION__REVIEWS__DAYS: '7',
    HAPPIER_SERVER_RETENTION__BATCH_SIZE: '1',
};

async function seedReview(accountId: string, finishedAt: Date | null, runId?: string) {
    const id = randomUUID();
    const state = finishedAt ? 'completed' : 'running';
    const header = ReviewArtifactHeaderV1Schema.parse({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId: id,
        title: 'Retained Review' });
    const body = ReviewArtifactBodyV1Schema.parse({ v: 1, rounds: [{ ordinal: 1, state, startedAt: old.getTime(),
        finishedAt: finishedAt?.getTime() ?? null, reviewerIds: ['reviewer'],
        runs: runId ? [{ kind: 'workflow', runId }] : [],
    }] });
    return db.artifact.create({ data: {
        id, accountId, kind: deriveArtifactStoredKindV1(header),
        header: privacyKit.decodeBase64(encodePlainArtifactStoredContent(header)),
        body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
        dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        headerVersion: 1, bodyVersion: 1, createdAt: old,
        reviewMetadata: { create: {
            subjectKind: 'comparison', sourceKind: runId ? 'workflow' : 'direct',
            state, currentRoundOrdinal: 1, startedAt: old, finishedAt,
        } },
    } });
}

describe('Review retention through the shared sweep and Artifact deletion', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-review-retention-', initEncrypt: true });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => {
        await harness.resetDbTables([
            () => db.artifact.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('reports eligible terminal Reviews in dry run, then deletes their graph and publishes to the shared audience', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', automationRunRetention: 'keepForever' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const expired = await seedReview(owner.id, old);
        const secondExpired = await seedReview(owner.id, old);
        const active = await seedReview(owner.id, null);
        const boundary = await seedReview(owner.id, cutoff);
        const fresh = await seedReview(owner.id, now);
        await db.artifactGrant.create({ data: {
            artifactId: expired.id, principalKind: 'account', accountId: viewer.id,
            accessLevel: 'view', createdByAccountId: owner.id,
        } });
        const commentId = randomUUID();
        // Opaque content is irrelevant to deletion; the real FK graph is the boundary under test.
        await db.reviewComment.create({ data: {
            id: commentId, accountId: viewer.id, reviewId: expired.id, threadId: commentId, state: 'open',
            flagsJson: '{}', anchorJson: '{}', snapshotEnvelopeJson: '{}', bodyEnvelopeJson: '{}', bodyVersion: 1,
            authorJson: '{}', editsJson: '[]', dispositionsJson: '{}', transitionsJson: '[]',
            serverRevision: 1, createdAt: 1n, updatedAt: 1n,
            appearances: { create: { reviewId: expired.id, roundOrdinal: 1, sourceKey: 'reviewer', runId: 'run', reviewerId: 'reviewer' } },
            events: { create: { eventId: randomUUID(), accountId: viewer.id, eventKind: 'created', eventEnvelopeJson: '{}',
                actorJson: '{}', serverRevision: 1, createdAt: 1n } },
        } });
        const request = await db.reviewRequestedReviewer.create({ data: {
            reviewId: expired.id, roundOrdinal: 1, principalKey: `account:${viewer.id}`,
            principal: { kind: 'account', accountId: viewer.id }, required: true,
            eligibleAccounts: { create: { accountId: viewer.id } },
        } });
        await db.reviewVerdict.create({ data: { reviewId: expired.id, roundOrdinal: 1, accountId: viewer.id, verdict: 'approve' } });

        const dryRun = await runRetentionDryRun({ env, now });
        expect(dryRun).toMatchObject({ status: 'ok', result: { byDomain: { reviews: { wouldDelete: 2 } } } });
        expect(await db.artifact.findUnique({ where: { id: expired.id } })).not.toBeNull();
        expect(await db.accountChange.count({ where: { entityId: expired.id } })).toBe(0);

        const sweep = await runRetentionSweep({ policy: readRetentionPolicyFromEnv(env), now });
        expect(sweep.byRule.reviews).toBe(2);
        expect(await db.artifact.findUnique({ where: { id: expired.id } })).toBeNull();
        expect(await db.artifact.findUnique({ where: { id: secondExpired.id } })).toBeNull();
        expect(await db.reviewMetadata.count({ where: { artifactId: expired.id } })).toBe(0);
        expect(await db.reviewComment.count({ where: { reviewId: expired.id } })).toBe(0);
        expect(await db.reviewCommentAppearance.count({ where: { commentId } })).toBe(0);
        expect(await db.reviewCommentEvent.count({ where: { commentId } })).toBe(0);
        expect(await db.reviewRequestedReviewer.count({ where: { reviewId: expired.id } })).toBe(0);
        expect(await db.reviewRequestedReviewerAccount.count({ where: { requestId: request.id } })).toBe(0);
        expect(await db.reviewVerdict.count({ where: { reviewId: expired.id } })).toBe(0);
        expect((await db.artifact.findMany({ where: { id: { in: [active.id, boundary.id, fresh.id] } }, select: { id: true } })))
            .toHaveLength(3);
        expect((await db.accountChange.findMany({ where: { kind: 'artifact', entityId: expired.id }, select: { accountId: true } }))
            .map(row => row.accountId).sort()).toEqual([owner.id, viewer.id].sort());
    });

    it('keeps Review history when its linked workflow run expires', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', automationRunRetention: 'thirtyDays' } });
        const runId = randomUUID();
        const machineId = randomUUID();
        const materialized = await materializeWorkflowAcceptedSnapshotV1({
            definition: { version: 1, inputs: [], defaults: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            }, blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] },
                input: [], result: { kind: 'text' } }] },
            context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        });
        if (!materialized.ok) throw new Error(materialized.error.code);
        const accepted = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: owner.id, runId },
            acceptedSnapshot: materialized.snapshot,
        }));
        const run = await db.automationRun.create({ data: {
            id: runId, accountId: owner.id, originKind: 'direct', causeKind: null, state: 'succeeded',
            workflowCustodyState: 'settled', workflowAcceptedSnapshotEnvelope: accepted, executionInputEnvelope: accepted,
            scheduledAt: old, dueAt: old, finishedAt: old,
        } });
        const review = await seedReview(owner.id, old, run.id);
        await runRetentionSweep({ policy: readRetentionPolicyFromEnv({}), now });
        expect(await db.automationRun.findUnique({ where: { id: run.id } })).toBeNull();
        expect(await db.artifact.findUnique({ where: { id: review.id } })).toEqual(review);
        expect(await db.reviewMetadata.findUnique({ where: { artifactId: review.id } })).not.toBeNull();
    });

    it('preserves a Review whose new round starts after candidate selection and before retirement', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const review = await seedReview(owner.id, old);
        const originalTransaction = db.$transaction;
        let restarted = false;
        // Instrument only the DB transaction boundary: commit the new round after the real
        // candidate query and before Artifact deletion begins, leaving its content revisions unchanged.
        const restartBeforeTransaction = async (...args: unknown[]) => {
            if (!restarted) {
                restarted = true;
                await db.reviewMetadata.update({ where: { artifactId: review.id }, data: {
                    state: 'running', currentRoundOrdinal: 2, startedAt: now, finishedAt: null,
                } });
            }
            return Reflect.apply(originalTransaction, db, args);
        };
        db.$transaction = restartBeforeTransaction as typeof db.$transaction;
        try {
            const rule = createRetentionRuleRegistry().find(item => item.id === 'reviews');
            expect(rule).toBeDefined();
            const result = await rule!.run({ policy: readRetentionPolicyFromEnv(env), now, dryRun: false,
                batchSize: 1, maxDeletesPerRulePerRun: 1 });
            expect(restarted).toBe(true);
            expect(result.deleted).toBe(0);
            expect(await db.artifact.findUnique({ where: { id: review.id } })).toEqual(review);
            expect(await db.reviewMetadata.findUnique({ where: { artifactId: review.id } }))
                .toMatchObject({ state: 'running', currentRoundOrdinal: 2, finishedAt: null });
            expect(await db.accountChange.count({ where: { entityId: review.id } })).toBe(0);
        } finally {
            db.$transaction = originalTransaction;
        }
    });
});
