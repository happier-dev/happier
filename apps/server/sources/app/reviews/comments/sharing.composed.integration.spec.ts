import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { executeReviewCommentTransportV1 } from '@happier-dev/protocol/reviews/comments/transport';
import { buildReviewCommentPublicationTransportRequestV1, openReviewCommentPublicationTransportResponseV1 } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import type { ReviewCommentPublicationPlanV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { computeCanonicalDomainSeparatedKeyedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import type { ReviewCommentResourceCryptoV1 } from '@happier-dev/protocol/reviews/comments/content';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { setArtifactAccessGrantInTx, removeArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { registerReviewCommentRoutes } from './routes';
import { resolveReviewAccessInTx } from '../reviewAccess';

describe('Review comment audience through authenticated HTTP', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-review-sharing-', initAuth: true, initEncrypt: true }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('admits View comments, Edit decisions and refuses outsiders and withdrawn grants', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [reader.id]);
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId: owner.id, kind: 'v1:other:review.v1',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'review.v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        await db.reviewMetadata.create({ data: { artifactId: reviewId, subjectKind: 'comparison', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(1), finishedAt: new Date(2) } });
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
            principal: { kind: 'account', accountId: reader.id }, accessLevel: 'view' }))).toMatchObject({ ok: true });
        const admission = observePrismaReads(db, ['artifact', 'reviewMetadata']);
        expect(await resolveReviewAccessInTx(admission.tx, { actorAccountId: reader.id, reviewId }))
            .toMatchObject({ reviewId, level: 'view', ownerAccountId: owner.id });
        expect(admission.reads.filter(read => read.startsWith('artifact.'))).toHaveLength(1);
        expect(admission.reads.filter(read => read.startsWith('reviewMetadata.'))).toHaveLength(1);
        const headers = async (accountId: string) => ({ authorization: `Bearer ${await createAccountTokenForTests(accountId, { kind: 'account', authority: 'present_user' })}` });
        const ownerHeaders = await headers(owner.id);
        const readerHeaders = await headers(reader.id);
        const outsiderHeaders = await headers(outsider.id);
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async app => {
            const created = await app.inject({ method: 'POST', url: '/v1/reviews/comments', headers: ownerHeaders,
                payload: { reviewId, anchor: { kind: 'file', filePath: 'a.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
                    body: 'Owner finding', authorIntent: 'open', clientMutationId: randomUUID() } });
            expect(created.statusCode).toBe(200);
            const comment = created.json().comment;
            const url = `/v1/reviews/comments/${comment.id}`;
            expect((await app.inject({ method: 'GET', url, headers: readerHeaders })).json()).toMatchObject({ comment: { body: 'Owner finding' } });
            expect((await app.inject({ method: 'GET', url, headers: outsiderHeaders })).json()).toMatchObject({ error: 'review_comment_not_found' });
            expect((await app.inject({ method: 'PATCH', url, headers: readerHeaders, payload: {
                reviewId, nextBody: 'Reader replacement', expectedBodyVersion: 1, expectedServerRevision: 1, clientMutationId: randomUUID(),
            } })).json()).toMatchObject({ error: 'review_comment_permission_denied' });
            const reply = await app.inject({ method: 'POST', url: `${url}/reply`, headers: readerHeaders, payload: {
                reviewId, body: 'Reader reply', expectedParentServerRevision: 1, clientMutationId: randomUUID(),
            } });
            expect(reply.statusCode).toBe(200);
            const transition = { reviewId, expectedState: 'open', toState: 'dismissed', reason: 'Reviewed and dismissed', expectedServerRevision: 1, clientMutationId: randomUUID() };
            expect((await app.inject({ method: 'POST', url: `${url}/transition`, headers: readerHeaders, payload: transition })).json()).toMatchObject({ error: 'review_comment_permission_denied' });
            const publication: ReviewCommentPublicationPlanV1 = {
                target: { providerId: 'github', configuredAccountId: 'reader-forge-account', subtarget: null,
                    entryRef: { sourceId: 'github', kindId: 'pull-request', collisionScope: 'repository', entryId: reviewId } },
                baseRevision: 'base', headRevision: 'head', verdict: null,
                entries: [{ happierCommentId: comment.id, expectedServerRevision: 1,
                    anchor: { kind: 'file', filePath: 'a.ts' }, snapshot: { kind: 'none', capturedAt: 1 }, body: 'Owner finding' }],
            };
            const publicationContext = { accountId: reader.id, mode: 'plain' as const, material: null };
            const buildPublication = (input: Parameters<typeof buildReviewCommentPublicationTransportRequestV1>[0]['input']) =>
                buildReviewCommentPublicationTransportRequestV1({ input, context: publicationContext, randomBytes });
            const publicationWire = buildPublication(publication);
            const claimPublication = (payload: typeof publicationWire) => app.inject({ method: 'POST',
                url: '/v1/reviews/comments/publication/claim', headers: readerHeaders, payload });
            expect((await claimPublication(publicationWire)).json()).toMatchObject({ error: 'review_comment_permission_denied' });
            expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
                principal: { kind: 'account', accountId: reader.id }, accessLevel: 'edit' }))).toMatchObject({ ok: true });
            const publicationResponse = await claimPublication(publicationWire);
            expect(publicationResponse.statusCode, publicationResponse.body).toBe(200);
            const claim = openReviewCommentPublicationTransportResponseV1({ plan: publication, context: publicationContext,
                response: publicationResponse.json() });
            expect(claim).toMatchObject({ disposition: 'dispatch', entries: [{ happierCommentId: comment.id }],
                instructions: { entries: ['dispatch'], verdict: null } });
            expect(await db.reviewCommentPublicationCorrelation.findMany({ where: { accountId: reader.id },
                select: { commentId: true } })).toEqual([{ commentId: comment.id }]);
            expect((await claimPublication(buildPublication({ ...publication, settlement: {
                dispatchToken: claim.dispatchToken, result: { publicationPlanId: claim.publicationPlanId,
                    entries: claim.entries.map(entry => ({ ...entry, outcome: { kind: 'published' as const, externalRef: 'github-comment' } })),
                    verdict: { kind: 'notRequested' } },
            } }))).statusCode).toBe(200);
            const replay = await claimPublication(publicationWire);
            expect(openReviewCommentPublicationTransportResponseV1({ plan: publication, context: publicationContext,
                response: replay.json() })).toMatchObject({ publicationPlanId: claim.publicationPlanId,
                disposition: 'reconcile', instructions: { entries: ['confirmed'], verdict: null } });
            expect((await app.inject({ method: 'POST', url: `${url}/transition`, headers: readerHeaders, payload: transition })).json()).toMatchObject({ comment: { state: 'dismissed' } });
            expect(await inTx(tx => removeArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
                principal: { kind: 'account', accountId: reader.id } }))).toMatchObject({ ok: true });
            expect((await app.inject({ method: 'GET', url, headers: readerHeaders })).json()).toMatchObject({ error: 'review_comment_not_found' });
            expect((await app.inject({ method: 'GET', url, headers: ownerHeaders })).json()).toMatchObject({ comment: { state: 'dismissed' } });
        }, { authentication: 'real' });
    });

    it.each([
        { mode: 'plain', recipientMode: 'plain' },
        { mode: 'e2ee', recipientMode: 'plain' },
        { mode: 'e2ee', recipientMode: 'e2ee' },
    ] as const)('commits admitted $mode resource content for $recipientMode recipients after withdrawal, then refuses a new request', async ({ mode, recipientMode }) => {
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const recipient = await db.account.create({ data: { encryptionMode: recipientMode,
            ...(recipientMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        await makeShareEligibleForTest(owner.id, [recipient.id]);
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId: owner.id, kind: 'v1:other:review.v1',
            header: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'review.v1' })) : randomBytes(40),
            body: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({})) : randomBytes(40),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) : randomBytes(80) } });
        await db.reviewMetadata.create({ data: { artifactId: reviewId, subjectKind: 'comparison', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(1), finishedAt: new Date(2) } });
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
            principal: { kind: 'account', accountId: recipient.id }, accessLevel: 'view' }))).toMatchObject({ ok: true });
        const resourceKey = randomBytes(32);
        const resource: ReviewCommentResourceCryptoV1 = { reviewId, mode,
            seal: async value => {
                if (mode === 'plain') return { t: 'plain', v: value };
                const nonce = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', resourceKey, nonce);
                const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
                return { t: 'encrypted', c: Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64') };
            },
            open: async envelope => {
                if (mode === 'plain' && envelope.t === 'plain') return envelope.v;
                if (mode !== 'e2ee' || envelope.t !== 'encrypted') throw new Error('Resource mode mismatch');
                const bytes = Buffer.from(envelope.c, 'base64');
                const decipher = createDecipheriv('aes-256-gcm', resourceKey, bytes.subarray(0, 12));
                decipher.setAuthTag(bytes.subarray(12, 28));
                return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as unknown;
            },
            commitment: (purpose, input) => computeCanonicalDomainSeparatedKeyedDigest(resourceKey,
                'happier:review-comment-resource-commitment:v1', [reviewId, purpose, input]),
        };
        const headers = { authorization: `Bearer ${await createAccountTokenForTests(recipient.id, { kind: 'account', authority: 'present_user' })}` };
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async app => {
            // Replay the Q19 captured prepare wire, substituting only the disposable Review id.
            const capturedPrepare = await app.inject({ method: 'POST', url: '/v1/reviews/comments/mutations/prepare', headers,
                payload: { v: 1, mutation: { actionId: 'reviews.comments.create', input: {
                    reviewId, roundOrdinal: 1, clientMutationId: 'a86991ae-7ea2-4d61-a42d-0578eac7244b', anchorIndex: { kind: 'line' },
                } }, contentCommitment: 'Bl0oISZbAS9gMibSHaEdaf2KsBOi3H4qsAQlrNTfYP8',
                createRequestFingerprint: 'p3c5fiNF0WHxOuaA7SzKw929zJTL-ZxuR-x8YQL_u0U' } });
            expect(capturedPrepare.statusCode, capturedPrepare.body).toBe(200);
            const result = await executeReviewCommentTransportV1({ actionId: 'reviews.comments.create',
                input: { reviewId, roundOrdinal: 1, body: 'Recipient private finding', anchor: { kind: 'line', filePath: 'private.ts', line: 1 },
                    snapshot: { kind: 'none', capturedAt: 1 }, authorIntent: 'open', clientMutationId: randomUUID() },
                context: { accountId: recipient.id, mode, material: null, resource }, actor: { kind: 'user', userId: recipient.id }, randomBytes,
                request: async request => {
                    const response = await app.inject({ method: request.method.toUpperCase() as 'GET' | 'POST',
                        url: request.path, headers, payload: request.body, query: request.query });
                    expect(response.statusCode, response.body).toBe(200);
                    if (request.path.endsWith('/prepare')) {
                        expect(await inTx(tx => removeArtifactAccessGrantInTx(tx, { actorAccountId: owner.id,
                            artifactId: reviewId, principal: { kind: 'account', accountId: recipient.id } }))).toMatchObject({ ok: true });
                    }
                    return response.json() as unknown;
                } });
            expect(result).toMatchObject({ comment: { reviewId, body: 'Recipient private finding', accountId: owner.id,
                author: { kind: 'user', userId: recipient.id } } });
            const rows = await db.reviewComment.findMany({ where: { reviewId } });
            expect(rows).toHaveLength(1);
            if (mode === 'e2ee') {
                const events = await db.reviewCommentEvent.findMany({ where: { commentId: rows[0]!.id } });
                expect(events).toHaveLength(1);
                const stored = JSON.stringify({ rows, events }, (_key, value: unknown) =>
                    typeof value === 'bigint' ? value.toString() : value);
                expect(stored).not.toContain('Recipient private finding');
                expect(stored).not.toContain('private.ts');
            }
            expect((await app.inject({ method: 'GET', url: `/v1/reviews/comments/${rows[0]!.id}`, headers })).json())
                .toMatchObject({ error: 'review_comment_not_found' });
        }, { authentication: 'real' });
    });
});
