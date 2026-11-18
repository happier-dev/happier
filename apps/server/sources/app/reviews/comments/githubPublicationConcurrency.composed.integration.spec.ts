import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ReviewCommentCreateResponseV1Schema, type ReviewCommentPublicationPlanV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { buildReviewCommentPublicationTransportRequestV1, openReviewCommentPublicationTransportResponseV1 } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db } from '@/storage/db';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerReviewCommentRoutes } from './routes';
import { publishGithubIssueComment } from '../../../../../../packages/plugins/scm-github/src/triage/mutations/issue';
import { createStubGithubTransport, createTestGithubApiClient, readRecordedJsonBody } from '../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_OTHER_REPOSITORY, GITHUB_FIXTURE_OTHER_REPOSITORY_ID, GITHUB_ISSUE_RESPONSE, GITHUB_OTHER_REPOSITORY_RESPONSE } from '../../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';

describe('GitHub publication through registered Reviews routes and the SQL claim owner', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-github-publication-concurrency-', initAuth: true, initEncrypt: true, sqliteConnectionLimit: 2 });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('admits one writer before a marker exists and preserves distinct same-body comments after provider answer loss', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reviewId = randomUUID();
        await db.artifact.create({ data: {
            id: reviewId, accountId: account.id, kind: 'v1:other:review.v1',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'review.v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        } });
        await db.reviewMetadata.create({ data: { artifactId: reviewId, subjectKind: 'comparison', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(1), finishedAt: new Date(2) } });
        const headers = { authorization: `Bearer ${await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' })}` };
        const context = { accountId: account.id, mode: 'plain' as const, material: null };
        const route = { owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_OTHER_REPOSITORY };
        const localRef = { kindId: 'issue' as const, collisionScope: `github:${GITHUB_FIXTURE_OTHER_REPOSITORY_ID}`, entryId: '7' };
        const issuePath = `/repos/${route.owner}/${route.name}/issues/7`;
        const comments: Array<{ id: number; body: string }> = [];
        let holdNextWrite = false;
        let enterHeldWrite!: () => void;
        const heldWriteEntered = new Promise<void>(resolve => { enterHeldWrite = resolve; });
        let releaseHeldWrite!: () => void;
        const heldWriteReleased = new Promise<void>(resolve => { releaseHeldWrite = resolve; });
        const transport = createStubGithubTransport({ respond: async request => {
            const path = new URL(request.url).pathname;
            if (request.method === 'GET' && path === issuePath) return { status: 200, body: GITHUB_ISSUE_RESPONSE };
            if (request.method === 'GET' && path === `/repos/${route.owner}/${route.name}`) return { status: 200, body: GITHUB_OTHER_REPOSITORY_RESPONSE };
            if (request.method === 'GET' && path === `${issuePath}/comments`) return { status: 200, body: [...comments] };
            if (request.method === 'POST' && path === `${issuePath}/comments`) {
                const payload = readRecordedJsonBody(request);
                if (typeof payload !== 'object' || payload === null || !('body' in payload) || typeof payload.body !== 'string') {
                    throw new Error('Expected a GitHub issue comment request');
                }
                const loseAnswer = holdNextWrite;
                holdNextWrite = false;
                if (loseAnswer) {
                    enterHeldWrite();
                    await heldWriteReleased;
                }
                const comment = { id: 5579420454 + comments.length, body: payload.body };
                comments.push(comment);
                // The real external HTTP boundary loses its answer after GitHub stores the effect.
                if (loseAnswer) throw Object.assign(new Error('Provider answer lost'), { code: 'ECONNRESET' });
                return { status: 201, body: comment };
            }
            return undefined;
        } });
        const client = await createTestGithubApiClient(transport);
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async app => {
            const createComment = async () => {
                const response = await app.inject({ method: 'POST', url: '/v1/reviews/comments', headers, payload: {
                    reviewId, anchor: { kind: 'file', filePath: 'a.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
                    body: 'The same finding at the same anchor.', authorIntent: 'open', clientMutationId: randomUUID(),
                } });
                expect(response.statusCode, response.body).toBe(200);
                return ReviewCommentCreateResponseV1Schema.parse(response.json()).comment;
            };
            const [commentA, commentB] = await Promise.all([createComment(), createComment()]);
            expect(commentA.id).not.toBe(commentB.id);
            const makePlan = (comment: typeof commentA): ReviewCommentPublicationPlanV1 => ({
                target: { providerId: 'github', configuredAccountId: 'account-under-test', subtarget: null,
                    entryRef: { sourceId: 'happier.scm.forge.github/github-forge', ...localRef } },
                baseRevision: null, headRevision: null, verdict: null,
                entries: [{ happierCommentId: comment.id, expectedServerRevision: comment.serverRevision,
                    anchor: comment.anchor, snapshot: comment.snapshot, body: comment.body }],
            });
            const claim = async (input: Parameters<typeof buildReviewCommentPublicationTransportRequestV1>[0]['input']) => {
                const response = await app.inject({ method: 'POST', url: '/v1/reviews/comments/publication/claim', headers,
                    payload: buildReviewCommentPublicationTransportRequestV1({ input, context, randomBytes }) });
                expect(response.statusCode, response.body).toBe(200);
                return openReviewCommentPublicationTransportResponseV1({ plan: input, context, response: response.json() });
            };
            const dispositions: string[] = [];
            const publish = (plan: ReviewCommentPublicationPlanV1) => publishGithubIssueComment({
                localRef, route, publicationPlan: plan,
                claimPublicationDispatch: async () => {
                    const result = await claim(plan);
                    dispositions.push(result.disposition);
                    return result;
                },
                settlePublicationDispatch: async (dispatch, result) => {
                    await claim({ ...plan, settlement: { dispatchToken: dispatch.dispatchToken, result } });
                },
            }, { client, now: () => 1234, signal: transport.context.signal });
            const planA = makePlan(commentA);
            const planB = makePlan(commentB);
            const published = (commentId: string, externalRef: string) => ({ kind: 'settled', publication: {
                entries: [{ happierCommentId: commentId, outcome: { kind: 'published', externalRef } }],
            } });
            const providerWrites = () => transport.requests.filter(request => request.method === 'POST');

            // Control uses the same routes, SQL owner and real provider adapter before the fault.
            expect(await publish(planB)).toMatchObject(published(commentB.id, '5579420454'));
            expect(providerWrites()).toHaveLength(1);
            holdNextWrite = true;
            const first = publish(planA);
            try {
                await Promise.race([heldWriteEntered, first.then(result => {
                    throw new Error(`Publication settled before reaching the held provider write: ${JSON.stringify(result)}`);
                })]);
                expect(comments).toHaveLength(1);
                expect(await publish(planA)).toMatchObject({ kind: 'settled', publication: {
                    entries: [{ happierCommentId: commentA.id, outcome: { kind: 'uncertain' } }],
                } });
                expect(providerWrites()).toHaveLength(2);
            } finally {
                releaseHeldWrite();
            }
            expect(await first).toMatchObject(published(commentA.id, '5579420455'));
            expect(await publish(planA)).toMatchObject(published(commentA.id, '5579420455'));
            expect(dispositions).toEqual(['dispatch', 'dispatch', 'reconcile', 'reconcile']);
            expect(providerWrites()).toHaveLength(2);
            expect(comments).toHaveLength(2);
            expect(comments[0]!.body).not.toBe(comments[1]!.body);
            expect(comments.every(comment => comment.body.startsWith('The same finding at the same anchor.\n\n'))).toBe(true);
            const correlations = await db.reviewCommentPublicationCorrelation.findMany({ where: { accountId: account.id },
                select: { commentId: true, publicationCorrelationId: true } });
            expect(correlations.map(value => value.commentId).sort()).toEqual([commentA.id, commentB.id].sort());
            expect(new Set(correlations.map(value => value.publicationCorrelationId)).size).toBe(2);
        }, { authentication: 'real' });
    });
});
