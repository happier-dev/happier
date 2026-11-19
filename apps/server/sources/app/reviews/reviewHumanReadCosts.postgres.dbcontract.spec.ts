import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { ReviewVerdictContentV1Schema } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { listReviewsInTx } from './reviewListService';
import { readAdmittedReviewHumanStateInTx, readAdmittedReviewNeedsYouInTx } from './reviewHumanService';

let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
beforeAll(async () => { harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'review-human-read-cost-' }); }, 180_000);
afterAll(async () => { await harness?.close(); });

it('keeps list and Inbox reads bodyless and proportional to current rounds while detail preserves verdict history', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const reviewId = randomUUID();
    const currentRoundOrdinal = 10_001;
    await db.artifact.create({ data: { id: reviewId, accountId: owner.id, header: new Uint8Array(), body: new Uint8Array(),
        dataEncryptionKey: new Uint8Array(), reviewMetadata: { create: { subjectKind: 'repository', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal, startedAt: new Date(1) } } } });
    const current = await db.reviewRequestedReviewer.create({ data: { reviewId, roundOrdinal: currentRoundOrdinal,
        principalKey: `account:${owner.id}`, principal: { kind: 'account', accountId: owner.id }, required: true,
        eligibleAccounts: { create: { accountId: owner.id } } } });
    const access = { reviewId, ownerAccountId: owner.id, level: 'owner', encryptionMode: 'plain' } as const;
    const measurements: { requests: number; verdicts: number; bytes: number }[] = [];
    let history = 0;
    for (const size of [1000, 10000]) {
        while (history < size) {
            const rounds = Array.from({ length: Math.min(500, size - history) }, (_, index) => history + index + 1);
            await db.reviewRequestedReviewer.createMany({ data: rounds.map(roundOrdinal => ({ id: randomUUID(), reviewId,
                roundOrdinal, principalKey: `account:${owner.id}`, principal: { kind: 'account', accountId: owner.id }, required: true })) });
            await db.reviewVerdict.createMany({ data: rounds.map(roundOrdinal => ({ reviewId, roundOrdinal, accountId: owner.id,
                verdict: 'approve', content: { t: 'plain', v: ReviewVerdictContentV1Schema.parse({ reviewId, roundOrdinal,
                    accountId: owner.id, revision: 1, body: 'historical prose '.repeat(128) }) } })) });
            history += rounds.length;
        }
        for (const consumer of ['list', 'Inbox'] as const) {
            const measured = { requests: 0, verdicts: 0, bytes: 0 };
            const restore = observePrismaRequests(db, { after: (request, rows) => {
                const kind = request.model === 'ReviewRequestedReviewer' ? 'requests' : request.model === 'ReviewVerdict' ? 'verdicts' : null;
                if (!kind || request.action !== 'findMany' || !Array.isArray(rows)) return;
                measured[kind] += rows.length;
                measured.bytes += Buffer.byteLength(JSON.stringify(rows));
                for (const row of rows) expect(row).not.toHaveProperty('content');
            } });
            try {
                await inTx(async tx => {
                    const needsYou = consumer === 'list'
                        ? (await listReviewsInTx(tx, { actorAccountId: owner.id, limit: 1 })).items[0]!.needsYou
                        : (await readAdmittedReviewNeedsYouInTx(tx, { actorAccountId: owner.id, reviews: [access] })).get(reviewId);
                    expect(needsYou).toMatchObject({ roundOrdinal: currentRoundOrdinal, requestedVerdict: true, needsYou: true });
                });
            } finally { restore(); }
            expect(measured).toMatchObject({ requests: 1, verdicts: 0 });
            measurements.push(measured);
            console.info(`[review-human-read] consumer=${consumer} history=${history} rows=${measured.requests + measured.verdicts} bytes=${measured.bytes}`);
        }
    }
    expect(measurements.every(row => row.bytes === measurements[0]!.bytes)).toBe(true);
    await db.reviewVerdict.create({ data: { reviewId, roundOrdinal: currentRoundOrdinal, accountId: owner.id, verdict: 'comment' } });
    const settled = await inTx(tx => readAdmittedReviewNeedsYouInTx(tx, { actorAccountId: owner.id, reviews: [access] }));
    expect(settled.get(reviewId)).toMatchObject({ requestedVerdict: false, needsYou: false, canSubmitVerdict: true });
    const detail = await inTx(tx => readAdmittedReviewHumanStateInTx(tx, { actorAccountId: owner.id, access }));
    expect(detail.requests.map(row => row.id)).toEqual([current.id]);
    expect(detail.verdicts).toHaveLength(history + 1);
    expect(detail.verdicts[0]!.content).toMatchObject({ t: 'plain', v: { body: expect.stringContaining('historical prose') } });
});
