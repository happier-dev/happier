import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerApiRoutes } from '@/app/api/api';
import { resolveApiRateLimitPluginOptions } from '@/app/api/utils/apiRateLimitPolicy';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import type { Fastify } from '@/app/api/types';

function registerHttpRoutes(app: Fastify) {
    app.register(import('@fastify/rate-limit'), resolveApiRateLimitPluginOptions(process.env));
    registerApiRoutes(app);
}
import { setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { writeReviewRoundState } from './reviewRecordService';

describe('Review requested-person HTTP flow', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'review-human-', initEncrypt: true }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('admits Team eligibility once per round and keeps separately named people outstanding', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const alice = await db.account.create({ data: { encryptionMode: 'plain' } });
        const bob = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const unsharedMember = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [alice.id, bob.id, guest.id]);
        const team = await db.team.create({ data: { name: 'Reviewers', memberships: { create: [
            { accountId: owner.id, role: 'owner' }, { accountId: alice.id, role: 'member' },
            { accountId: bob.id, role: 'member' }, { accountId: guest.id, role: 'guest' },
            { accountId: unsharedMember.id, role: 'member' },
        ] } } });
        const reviewId = randomUUID();
        const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        await db.artifact.create({ data: { id: reviewId, accountId: owner.id, kind: encodeArtifactKindV1({ kind: 'other', kindHint: 'review.v1' }),
            header: bytes({ v: 1, kind: 'review.v1', reviewId, title: 'Team review' }), body: bytes('{}'),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), reviewMetadata: { create: {
                subjectKind: 'comparison', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1,
                startedAt: new Date(1), finishedAt: new Date(2),
            } } } });
        for (const accountId of [alice.id, bob.id, guest.id]) expect(await inTx(tx => setArtifactAccessGrantInTx(tx, {
            actorAccountId: owner.id, artifactId: reviewId, principal: { kind: 'account', accountId }, accessLevel: 'view',
        }))).toMatchObject({ ok: true });
        await withAuthenticatedTestApp(registerHttpRoutes, async app => {
            const headers = (accountId: string) => ({ 'x-test-user-id': accountId });
            const post = (accountId: string, tail: string, payload: unknown) => app.inject({ method: 'POST',
                url: `/v1/reviews/${reviewId}/${tail}`, headers: headers(accountId), payload });
            const requested = await post(owner.id, 'reviewers', { roundOrdinal: 1, reviewers: [
                { principal: { kind: 'team', teamId: team.id }, required: true },
                { principal: { kind: 'account', accountId: alice.id }, required: true },
                { principal: { kind: 'account', accountId: unsharedMember.id }, required: false },
            ] });
            expect(requested.statusCode).toBe(200);
            expect(requested.json().requests).toEqual(expect.arrayContaining([expect.objectContaining({
                principal: { kind: 'team', teamId: team.id }, needsAccess: true,
            })]));
            expect((await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}/human`,
                headers: headers(unsharedMember.id) })).statusCode).toBe(404);
            const { resolveReviewAccessInTx } = await import('./reviewAccess');
            const { readAdmittedReviewNeedsYouInTx } = await import('./reviewHumanService');
            const admitted = await inTx(async tx => {
                expect(await resolveReviewAccessInTx(tx, { actorAccountId: unsharedMember.id, reviewId })).toBeNull();
                expect((await readAdmittedReviewNeedsYouInTx(tx, { actorAccountId: unsharedMember.id, reviews: [] })).size).toBe(0);
                const access = await resolveReviewAccessInTx(tx, { actorAccountId: alice.id, reviewId });
                if (!access) throw new Error('Expected the existing View grant to admit Alice');
                return readAdmittedReviewNeedsYouInTx(tx, { actorAccountId: alice.id, reviews: [access] });
            });
            expect(admitted.get(reviewId)).toMatchObject({ reviewId, roundOrdinal: 1, reason: 'review_needs_you',
                needsYou: true, requestedVerdict: true, canSubmitVerdict: true, pendingDecisions: false });
            expect((await post(guest.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve' })).json())
                .toMatchObject({ error: 'review_reviewer_not_requested' });
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: bob.id } }, data: { status: 'suspended' } });
            expect((await post(bob.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve' })).statusCode).toBe(200);
            const outstanding = await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}/human`, headers: headers(alice.id) });
            expect(outstanding.json().needsYou).toMatchObject({ requestedVerdict: true, needsYou: true });
            expect((await post(alice.id, 'verdicts', { roundOrdinal: 1, verdict: 'comment' })).json().needsYou)
                .toMatchObject({ requestedVerdict: false, needsYou: false });
            await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata: { projectSourceId: null, workflowId: null,
                subjectKind: 'comparison', sourceKind: 'direct', state: 'running', currentRoundOrdinal: 2, startedAt: 3, finishedAt: null } }));
            const renewedRequests = await db.reviewRequestedReviewer.findMany({ where: { reviewId, roundOrdinal: 2 },
                select: { principal: true, required: true } });
            expect(renewedRequests).toHaveLength(2);
            expect(renewedRequests).toEqual(expect.arrayContaining([
                { principal: { kind: 'team', teamId: team.id }, required: true },
                { principal: { kind: 'account', accountId: alice.id }, required: true },
            ]));
            expect((await post(bob.id, 'verdicts', { roundOrdinal: 2, verdict: 'approve' })).statusCode).toBe(200);
        });
    });
});
