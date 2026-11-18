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

    it('requires Edit to request, permits only the requested person to submit, and grants no access', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const person = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const editor = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [person.id, outsider.id, editor.id]);
        const reviewId = randomUUID();
        const header = { kind: 'review.v1', v: 1, reviewId, title: 'Private review title' };
        const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        // Persisted boundary fixture: lifecycle production is covered by the record owner's contract test.
        await db.artifact.create({ data: { id: reviewId, accountId: owner.id,
            kind: encodeArtifactKindV1({kind:'other',kindHint:'review.v1'}), header: bytes(header), body: bytes('{}'),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), reviewMetadata: {create:{
                subjectKind: 'comparison', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1,
                startedAt: new Date(1), finishedAt: new Date(2),
            }} } });
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
            principal: { kind: 'account', accountId: person.id }, accessLevel: 'view' }))).toMatchObject({ ok: true });
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
            principal: { kind: 'account', accountId: editor.id }, accessLevel: 'edit' }))).toMatchObject({ ok: true });
        await withAuthenticatedTestApp(registerHttpRoutes, async app => {
            const reviewers = { roundOrdinal: 1, reviewers: [{ principal: { kind: 'account', accountId: person.id }, required: true },
                { principal: { kind: 'account', accountId: outsider.id }, required: false }] };
            const headers = (accountId: string) => ({ 'x-test-user-id': accountId });
            // Known-good same-resource read proves the fixture's admission before the new mutation.
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${reviewId}`, headers: headers(person.id) })).statusCode).toBe(200);
            const post = (accountId: string, tail: string, payload: unknown, extra: Record<string, string> = {}) => app.inject({
                method: 'POST', url: `/v1/reviews/${reviewId}/${tail}`, headers: { ...headers(accountId), ...extra }, payload });
            // These Accounts have no friendship with the editor. A request does not create a new share.
            const requested = await post(editor.id, 'reviewers', reviewers);
            expect(requested.statusCode).toBe(200);
            expect(requested.json().requests).toEqual(expect.arrayContaining([expect.objectContaining({
                principal: { kind: 'account', accountId: outsider.id }, needsAccess: true,
            }), expect.objectContaining({
                principal: { kind: 'account', accountId: person.id }, needsAccess: false,
            })]));
            expect(requested.json().requests.every((request: Record<string, unknown>) => !('eligibleAccountIds' in request))).toBe(true);
            expect(requested.json().needsYou).toMatchObject({ requestedVerdict: false, reason: 'review_needs_you' });
            const listFor = async (accountId: string) => app.inject({ method: 'POST',
                url: homeDomainActionPathForMethod('reviews.list', 'POST'), headers: headers(accountId), payload: { limit: 10 } });
            expect((await listFor(person.id)).json().items).toEqual([expect.objectContaining({ reviewId,
                needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: true,
                    requestedVerdict: true, pendingDecisions: false, canSubmitVerdict: true } })]);
            expect((await listFor(outsider.id)).json().items).toEqual([]);
            const denied = await post(person.id, 'reviewers', reviewers);
            expect(denied.statusCode).toBe(403);
            expect(denied.json()).toMatchObject({ error: 'review_access_forbidden' });
            expect((await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}/human`, headers: headers(outsider.id) })).statusCode).toBe(404);
            expect((await post(owner.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve' })).json())
                .toMatchObject({ error: 'review_reviewer_not_requested' });
            expect((await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve' }, { 'x-test-auth-token-kind': 'terminal' })).json())
                .toMatchObject({ error: 'present_user_required' });
            expect((await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve', accountId: outsider.id })).statusCode).toBe(400);
            const submitted = await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve' });
            expect(submitted.statusCode).toBe(200);
            expect(submitted.json()).toMatchObject({ verdicts: [{ accountId: person.id, roundOrdinal: 1, verdict: 'approve', revision: 1 }],
                needsYou: { needsYou: false, canSubmitVerdict: true } });
            expect((await listFor(person.id)).json().items[0].needsYou).toMatchObject({ needsYou: false, requestedVerdict: false });
            const replay = await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve' });
            expect(replay.json().verdicts[0].revision).toBe(1);
            expect((await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve', expectedRevision: 1,
                content: { t: 'encrypted', c: 'ciphertext-for-a-plain-review' } })).json())
                .toMatchObject({ error: 'review_verdict_encryption_mode_mismatch' });
            const prose = { reviewId, roundOrdinal: 1, accountId: person.id, revision: 2, body: 'Looks ready' };
            expect((await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve', expectedRevision: 1,
                content: { t: 'plain', v: { ...prose, accountId: outsider.id } } })).json())
                .toMatchObject({ error: 'review_verdict_content_mismatch' });
            const { createReviewHumanActionExecutorV1 } = await import('@happier-dev/protocol/reviews/reviewHumanTransportV1');
            const { REVIEW_HUMAN_ACTION_IDS_V1 } = await import('@happier-dev/protocol/actions/actionIds');
            const executeHuman = createReviewHumanActionExecutorV1({ accountId: person.id,
                request: async (method, path, body) => {
                    const response = await app.inject({ method: method as 'GET' | 'POST', url: path,
                        headers: headers(person.id), ...(body === undefined ? {} : { payload: body }) });
                    expect(response.statusCode).toBe(200);
                    return response.json();
                },
                resolveResource: async () => ({ mode: 'plain', seal: async value => ({ t: 'plain', v: value }),
                    open: async content => content.t === 'plain' ? content.v : null }),
            });
            const withProse = await executeHuman(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
                { reviewId, roundOrdinal: 1, verdict: 'approve', body: prose.body });
            expect(withProse.verdicts[0]).toMatchObject({ revision: 2, body: prose.body });
            expect((await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'request_changes', expectedRevision: 1,
                content: { t: 'plain', v: prose } })).json()).toMatchObject({ error: 'review_verdict_revision_mismatch' });
            await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata: { projectSourceId: null, workflowId: null,
                subjectKind: 'comparison', sourceKind: 'direct', state: 'running', currentRoundOrdinal: 2, startedAt: 3, finishedAt: null } }));
            const renewed = await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}/human`, headers: headers(person.id) });
            expect(renewed.json()).toMatchObject({ roundOrdinal: 2, needsYou: { requestedVerdict: true, reason: 'review_needs_you' } });
            expect(renewed.json().requests.filter((request: { roundOrdinal: number }) => request.roundOrdinal === 2))
                .toEqual([expect.objectContaining({ principal: { kind: 'account', accountId: person.id }, required: true })]);
            expect(await db.reviewRequestedReviewer.findMany({ where: { reviewId, roundOrdinal: 2 },
                select: { principal: true, required: true, eligibleAccounts: { select: { accountId: true } } } }))
                .toEqual([{ principal: { kind: 'account', accountId: person.id }, required: true,
                    eligibleAccounts: [{ accountId: person.id }] }]);
            expect(renewed.json().verdicts).toEqual([expect.objectContaining({ roundOrdinal: 1, revision: 2 })]);
            expect((await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve' })).json())
                .toMatchObject({ error: 'review_round_not_admitted' });
            expect((await post(person.id, 'verdicts', { roundOrdinal: 2, verdict: 'approve' })).statusCode).toBe(200);
            expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
                principal: { kind: 'account', accountId: person.id }, accessLevel: 'edit' }))).toMatchObject({ ok: true });
            expect((await post(person.id, 'reviewers', { roundOrdinal: 2, reviewers: [] })).statusCode).toBe(200);
        });
    });

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
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: guest.id } }, data: { role: 'member' } });
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
            expect((await post(bob.id, 'verdicts', { roundOrdinal: 2, verdict: 'approve' })).json())
                .toMatchObject({ error: 'review_reviewer_not_requested' });
            expect((await post(guest.id, 'verdicts', { roundOrdinal: 2, verdict: 'approve' })).statusCode).toBe(200);
        });
    });
});
