import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { x25519 } from '@noble/curves/ed25519';
import { REVIEW_HUMAN_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ReviewVerdictSubmitInputV1Schema, type ReviewHumanStateV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE } from './artifacts/accountArtifactStore';

const token = `header.${Buffer.from(JSON.stringify({ sub: 'person' })).toString('base64url')}.signature`;
const context = { surface: 'cli', authority: 'present_user', serverId: 'home', runtimeAccountId: 'person',
    actionCaller: { kind: 'host' } } as const;
const state: ReviewHumanStateV1 = { reviewId: 'review', roundOrdinal: 2, requests: [], verdicts: [],
    needsYou: { reviewId: 'review', roundOrdinal: 2, reason: 'review_needs_you', requestedVerdict: true,
        pendingDecisions: false, needsYou: true, canSubmitVerdict: true } };

describe('Review human CLI transport', () => {
    let app = fastify();
    let restore = () => {};
    beforeEach(() => {
        app = fastify();
        app.addHook('onRequest', async request => { expect(request.headers.authorization).toBe(`Bearer ${token}`); });
        // HTTP is the boundary; the Action executor, Artifact codec and domain adapter stay real.
        restore = installAxiosFastifyAdapter({ app, origin: 'http://home.test' });
    });
    afterEach(async () => { restore(); await app.close(); });
    const executor = (credentials: StoredCredentials = { token, encryption: null }) => createCliActionExecutorHarness({
        token, credentials, sessionId: 'cli-global', serverId: 'home', serverHttpBaseUrl: 'http://home.test',
        mode: 'plain', ctx: null,
    }, createAccountServerActionDeps({ token, credentials, serverId: 'home', serverHttpBaseUrl: 'http://home.test' })).executor;

    it('submits a prose-free person verdict without reading Artifact material', async () => {
        const requests: string[] = [];
        app.addHook('onRequest', async request => {
            if (request.url.startsWith('/v1/reviews/') || request.url.startsWith('/v1/artifacts/')) requests.push(request.url);
        });
        app.post('/v1/reviews/review/verdicts', async request => {
            expect(request.body).toEqual({ roundOrdinal: 2, verdict: 'request_changes' });
            return state;
        });
        expect(await executor().execute(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
            { reviewId: 'review', roundOrdinal: 2, verdict: 'request_changes', body: undefined },
            { ...context, presentUserConfirmation: { actionId: REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict } }))
            .toMatchObject({ ok: true, result: state });
        expect(requests).toEqual(['/v1/reviews/review/verdicts']);
    });

    it.each(['plain', 'e2ee'] as const)('seals prose and opens history using a View-only %s Review resource', async mode => {
        const machineKey = new Uint8Array(32).fill(37);
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
            : { type: 'dataKey', machineKey, publicKey: x25519.getPublicKey(machineKey) } };
        const resource = await createResourceDataKey({ credentials, mode });
        const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, resource.dataKey));
        const seal = (value: unknown) => resource.mode === 'plain' ? { t: 'plain' as const, v: value }
            : { t: 'encrypted' as const, c: encodeBase64(encryptWithDataKey(value, resource.dataKey)) };
        const history = { accountId: 'alice', roundOrdinal: 1, verdict: 'approve' as const, revision: 1, submittedAt: 1,
            content: seal({ reviewId: 'review', roundOrdinal: 1, accountId: 'alice', revision: 1, body: 'Earlier verdict' }) };
        const secondHistory = { ...history, roundOrdinal: 2, revision: 2, submittedAt: 2,
            content: seal({ reviewId: 'review', roundOrdinal: 2, accountId: 'alice', revision: 2, body: 'Later retained verdict' }) };
        let artifactReads = 0;
        app.get('/v1/artifacts/review', async () => {
            artifactReads += 1;
            return { id: 'review', ownerAccountId: 'owner', access: 'view', publicAudience: 'none',
                encryptionMode: mode, dataEncryptionKey: resource.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encode({ title: 'Review' }), body: encode({ body: '{}' }), headerVersion: 2, bodyVersion: 3,
                seq: 1, createdAt: 1, updatedAt: 1 };
        });
        let retained = [history, secondHistory];
        app.get('/v1/reviews/review/human', async () => ({ ...state, verdicts: retained }));
        app.post('/v1/reviews/review/verdicts', async request => {
            const wire = ReviewVerdictSubmitInputV1Schema.parse({ ...request.body as object, reviewId: 'review' });
            expect(wire).toMatchObject({ roundOrdinal: 2, expectedRevision: 0, content: { t: mode === 'plain' ? 'plain' : 'encrypted' } });
            expect(request.body).not.toHaveProperty('body');
            expect(request.body).not.toHaveProperty('accountId');
            if (mode === 'e2ee') expect(JSON.stringify(request.body)).not.toContain('Private reviewer prose');
            return { ...state, verdicts: [history, secondHistory, { accountId: 'person', roundOrdinal: 2,
                verdict: wire.verdict, content: wire.content, revision: 1, submittedAt: 2 }] };
        });
        const read = await executor(credentials).execute(REVIEW_HUMAN_ACTION_IDS_V1.get, { reviewId: 'review' }, context);
        expect(read, JSON.stringify(read)).toMatchObject({ ok: true, result: { verdicts: [
            { accountId: 'alice', roundOrdinal: 1, revision: 1, body: 'Earlier verdict' },
            { accountId: 'alice', roundOrdinal: 2, revision: 2, body: 'Later retained verdict' },
        ] } });
        expect(artifactReads).toBe(1);
        const result = await executor(credentials).execute(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
            { reviewId: 'review', roundOrdinal: 2, verdict: 'approve', body: 'Private reviewer prose' },
            { ...context, presentUserConfirmation: { actionId: REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict } });
        expect(result).toMatchObject({ ok: true, result: { verdicts: [
            { accountId: 'alice', body: 'Earlier verdict' }, { accountId: 'alice', body: 'Later retained verdict' },
            { accountId: 'person', body: 'Private reviewer prose' },
        ] } });
        // Each invocation reads one resource for every historical opener and its optional seal.
        expect(artifactReads).toBe(2);
        retained = [{ ...history, content: seal({ reviewId: 'review', roundOrdinal: 1,
            accountId: 'someone-else', revision: 1, body: 'Mismatched author prose' }) }];
        expect(await executor(credentials).execute(REVIEW_HUMAN_ACTION_IDS_V1.get, { reviewId: 'review' }, context))
            .toMatchObject({ ok: false, errorCode: 'review_verdict_content_mismatch' });
        retained = [{ ...history, content: mode === 'plain' ? { t: 'encrypted', c: 'not-plain' }
            : { t: 'plain', v: { body: 'Must not reinterpret plain prose' } } }];
        expect(await executor(credentials).execute(REVIEW_HUMAN_ACTION_IDS_V1.get, { reviewId: 'review' }, context))
            .toMatchObject({ ok: false, errorCode: ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE });
    });

    it.each([
        { actionId: REVIEW_HUMAN_ACTION_IDS_V1.setReviewers, method: 'POST', path: '/v1/reviews/review/reviewers', status: 403,
            code: 'review_access_forbidden', input: { reviewId: 'review', roundOrdinal: 2, reviewers: [] } },
        { actionId: REVIEW_HUMAN_ACTION_IDS_V1.get, method: 'GET', path: '/v1/reviews/review/human', status: 404,
            code: 'review_not_found', input: { reviewId: 'review' } },
        { actionId: REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict, method: 'POST', path: '/v1/reviews/review/verdicts', status: 400,
            code: 'review_round_not_admitted', input: { reviewId: 'review', roundOrdinal: 1, verdict: 'approve' } },
    ] as const)('preserves the Home refusal $code ($status)', async row => {
        app.route({ method: row.method, url: row.path, handler: async (_request, reply) =>
            reply.code(row.status).send({ error: row.code }) });
        expect(await executor().execute(row.actionId, row.input,
            { ...context, presentUserConfirmation: { actionId: row.actionId } })).toMatchObject({
            ok: false, errorCode: row.code, details: { error: row.code },
        });
    });

    it('refuses prose before POST when the Review Artifact codec is unavailable', async () => {
        let posted = false;
        app.get('/v1/reviews/review/human', async () => state);
        app.get('/v1/artifacts/review', async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
        app.post('/v1/reviews/review/verdicts', async () => { posted = true; return state; });
        expect(await executor().execute(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
            { reviewId: 'review', roundOrdinal: 2, verdict: 'approve', body: 'Private reviewer prose' },
            { ...context, presentUserConfirmation: { actionId: REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict } }))
            .toMatchObject({ ok: false, errorCode: 'review_verdict_content_unavailable' });
        expect(posted).toBe(false);
    });

    it('preserves an unknown mutation outcome when Home returns a malformed verdict acknowledgement', async () => {
        app.post('/v1/reviews/review/verdicts', async () => ({ unexpected: 'must not disclose this response' }));
        const result = await executor().execute(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
            { reviewId: 'review', roundOrdinal: 2, verdict: 'approve' },
            { ...context, presentUserConfirmation: { actionId: REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict } });
        expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
        expect(JSON.stringify(result)).not.toContain('must not disclose this response');
    });
});
