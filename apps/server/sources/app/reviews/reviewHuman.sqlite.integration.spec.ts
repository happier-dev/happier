import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { REVIEW_HUMAN_ACTION_IDS_V1, isReviewHumanActionIdV1 } from '@happier-dev/protocol/actions/actionIdsReviewHumanV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createReviewHumanActionExecutorV1 } from '@happier-dev/protocol/reviews/reviewHumanTransportV1';
import { createActionToolExecutorBridge } from '../../../../cli/src/agent/tools/happierTools/createActionToolExecutorBridge';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, buildAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createFakeSocket } from '@/app/api/testkit/socketHarness';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { eventRouter } from '@/app/events/eventRouter';
import type { ClientConnection } from '@/app/events/eventPayloadTypes';
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
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'review-human-', initAuth: true, initEncrypt: true }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('publishes changed verdicts to the person, skips exact replays, and refuses agent-origin verdicts', async () => {
        const person = await db.account.create({ data: { encryptionMode: 'plain' } });
        const review = await db.artifact.create({ data: { id: randomUUID(), accountId: person.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
            reviewMetadata: { create: { subjectKind: 'comparison', sourceKind: 'direct', state: 'completed',
                currentRoundOrdinal: 2, startedAt: new Date(1), finishedAt: new Date(2) } } } });
        const personToken = await createAccountTokenForTests(person.id, { kind: 'account', authority: 'present_user' });
        const terminalToken = await createAccountTokenForTests(person.id, { kind: 'terminal', authority: 'account_automation' });
        await withAuthenticatedTestApp(registerHttpRoutes, async app => {
            // Only the network boundary is fake: HTTP auth, transactions and the event router stay real.
            const socket = Object.assign(createFakeSocket({ id: randomUUID() }), { data: {} });
            writeAccountStoredContentCompatibilityForSocket(socket,
                evaluateAccountStoredContentSocketCompatibility(buildAccountStoredContentCompatibilitySocketAuthV1(
                    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)));
            const connection: ClientConnection = { connectionType: 'user-scoped', userId: person.id,
                socket: socket as unknown as ClientConnection['socket'] };
            const publications = () => socket.emit.mock.calls.filter(([event]) => event === 'update')
                .map(([, payload]) => UpdateContainerSchema.parse(payload).body);
            const reviewChange = { t: 'account-change', changeKinds: ['artifact'], entityIds: [review.id],
                artifactKinds: [encodeArtifactKindV1({ kind: 'other', kindHint: 'review.v1' })] };
            const post = (token: string, tail: string, payload: unknown, extra: Record<string, string> = {}) => app.inject({ method: 'POST',
                url: `/v1/reviews/${review.id}/${tail}`, headers: { authorization: `Bearer ${token}`, ...extra }, payload });
            eventRouter.addConnection(person.id, connection);
            try {
                expect((await post(personToken, 'reviewers', { roundOrdinal: 2,
                    reviewers: [{ principal: { kind: 'account', accountId: person.id }, required: true }] })).statusCode).toBe(200);
                expect(publications()).toEqual([reviewChange]);
                expect((await post(personToken, 'verdicts', { roundOrdinal: 2, verdict: 'approve' })).statusCode).toBe(200);
                expect(publications()).toEqual([reviewChange, reviewChange]);
                const approved = await db.reviewVerdict.findFirstOrThrow({ where: { reviewId: review.id } });
                expect((await post(terminalToken, 'verdicts', { roundOrdinal: 2, verdict: 'approve' })).statusCode).toBe(200);
                expect(publications()).toEqual([reviewChange, reviewChange]);
                expect(await db.reviewVerdict.findFirstOrThrow({ where: { reviewId: review.id } })).toEqual(approved);
                expect((await post(personToken, 'verdicts', { roundOrdinal: 2, verdict: 'request_changes' })).statusCode).toBe(200);
                expect(publications()).toEqual([reviewChange, reviewChange, reviewChange]);
                const changed = await db.reviewVerdict.findFirstOrThrow({ where: { reviewId: review.id } });
                expect(changed).toMatchObject({ accountId: person.id, verdict: 'request_changes', revision: 2 });
                expect((await post(personToken, 'verdicts', { roundOrdinal: 2, verdict: 'request_changes' })).statusCode).toBe(200);
                expect(publications()).toEqual([reviewChange, reviewChange, reviewChange]);
                expect(await db.reviewVerdict.findFirstOrThrow({ where: { reviewId: review.id } })).toEqual(changed);
                const denied = await post(terminalToken, 'verdicts', { roundOrdinal: 2, verdict: 'approve', expectedRevision: 2 },
                    { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' });
                expect(denied.statusCode).toBe(403);
                expect(denied.json()).toMatchObject({ error: 'present_user_required' });
                expect(publications()).toEqual([reviewChange, reviewChange, reviewChange]);
                expect(await db.reviewVerdict.findFirstOrThrow({ where: { reviewId: review.id } })).toEqual(changed);
                // Exercise the real Agent/MCP ingress and core admission. Approval
                // policy and the host's approved-continuation flag cannot turn
                // this person-only Action into an Agent verdict.
                for (const surface of ['agent', 'mcp'] as const) {
                    for (const policy of ['ask', 'waived', 'approved'] as const) {
                        const settings = ActionsSettingsV1Schema.parse({ v: 1,
                            ...(policy === 'waived' ? { approvalWaivedSurfaces: {
                                [REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict]: [surface],
                            } } : {}),
                        });
                        const executor = createActionExecutor({ homeDomainAction: async ({ actionId, input, context }) => {
                            if (!isReviewHumanActionIdV1(actionId)) throw new Error('Unexpected Home family');
                            return createReviewHumanActionExecutorV1({ accountId: person.id,
                                request: async (method, path, body) => {
                                    const response = await app.inject({ method: method as 'GET' | 'POST', url: path,
                                        headers: { authorization: `Bearer ${personToken}`,
                                            ...(context.authority === 'account_automation'
                                                ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) }, payload: body });
                                    if (response.statusCode !== 200) throw Object.assign(new Error('Home refused verdict'),
                                        { code: response.json().error });
                                    return response.json();
                                },
                                resolveResource: async () => { throw new Error('A prose-free verdict needs no Artifact codec'); },
                            })(actionId, input);
                        } });
                        const context = { surface, authority: 'account_automation' as const,
                            actionsSettings: settings, ...(policy === 'approved' ? { bypassApprovals: true } : {}) };
                        const bridge = createActionToolExecutorBridge({ surface, actionsSettings: settings,
                            executor: { execute: (actionId, input, origin) => executor.execute(actionId, input,
                                { ...origin, ...context }) } });
                        const input = { reviewId: review.id, roundOrdinal: 2, verdict: 'approve' };
                        if (surface === 'agent' && policy === 'ask') {
                            const personResult = await executor.execute(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
                                { ...input, verdict: 'request_changes' }, { surface: 'cli', authority: 'present_user', bypassApprovals: true });
                            expect(personResult, JSON.stringify(personResult)).toMatchObject({ ok: true, result: { verdicts: [expect.objectContaining({ verdict: 'request_changes', revision: 2 })] } });
                        }
                        expect(await bridge.executeActionByToolName('action_execute', {
                            actionId: REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict, input,
                        }, undefined)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
                        expect(await executor.execute(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict, input, context))
                            .toMatchObject({ ok: false, errorCode: 'action_disabled' });
                        expect(await db.reviewVerdict.findFirstOrThrow({ where: { reviewId: review.id } })).toEqual(changed);
                        expect(publications()).toEqual([reviewChange, reviewChange, reviewChange]);
                    }
                }
            } finally { eventRouter.removeConnection(person.id, connection); }
        }, { authentication: 'real' });
    });

    it('renews required and optional requested people through Artifact HTTP without changing history or access', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const optional = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [optional.id]);
        const ownerToken = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
        const optionalToken = await createAccountTokenForTests(optional.id, { kind: 'account', authority: 'present_user' });
        const outsiderToken = await createAccountTokenForTests(outsider.id, { kind: 'account', authority: 'present_user' });
        const reviewId = randomUUID();
        const header = encodePlainArtifactStoredContent({ kind: 'review.v1', v: 1, reviewId, title: 'Round history' });
        const firstRound = { ordinal: 1, state: 'completed', startedAt: 10, finishedAt: 20, reviewerIds: [], runs: [] };
        const metadata = { projectSourceId: null, workflowId: null, subjectKind: 'comparison', sourceKind: 'direct' };
        await withAuthenticatedTestApp(registerHttpRoutes, async app => {
            const headers = (token: string) => ({ authorization: `Bearer ${token}`,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) });
            const post = (token: string, url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: headers(token), payload });
            const create = await post(ownerToken, '/v1/artifacts', { id: reviewId,
                kind: encodeArtifactKindV1({ kind: 'other', kindHint: 'review.v1' }), header,
                body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1,
                    rounds: [{ ...firstRound, state: 'running', finishedAt: null }] }) }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                reviewMetadata: { ...metadata, currentRoundOrdinal: 1, state: 'running', startedAt: 10, finishedAt: null } });
            expect(create.statusCode, create.body).toBe(200);
            expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
                principal: { kind: 'account', accountId: optional.id }, accessLevel: 'view' }))).toMatchObject({ ok: true });
            expect((await post(ownerToken, `/v1/reviews/${reviewId}/reviewers`, { roundOrdinal: 1, reviewers: [
                { principal: { kind: 'account', accountId: owner.id }, required: true },
                { principal: { kind: 'account', accountId: optional.id }, required: false },
            ] })).statusCode).toBe(200);
            expect((await post(ownerToken, `/v1/reviews/${reviewId}/verdicts`, { roundOrdinal: 1, verdict: 'approve' })).statusCode).toBe(200);
            expect((await post(optionalToken, `/v1/reviews/${reviewId}/verdicts`, { roundOrdinal: 1, verdict: 'comment' })).statusCode).toBe(200);
            const settled = await post(ownerToken, `/v1/artifacts/${reviewId}`, { header, expectedHeaderVersion: 1,
                body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [firstRound] }) }), expectedBodyVersion: 1,
                reviewMetadata: { currentRoundOrdinal: 1, state: 'completed', finishedAt: 20 } });
            expect(settled.json()).toMatchObject({ success: true, headerVersion: 2, bodyVersion: 2 });
            const oldRequests = await db.reviewRequestedReviewer.findMany({ where: { reviewId, roundOrdinal: 1 }, orderBy: { id: 'asc' } });
            const oldVerdicts = await db.reviewVerdict.findMany({ where: { reviewId, roundOrdinal: 1 }, orderBy: { accountId: 'asc' } });
            const grants = await db.artifactGrant.findMany({ where: { artifactId: reviewId }, orderBy: { id: 'asc' } });
            const next = await post(ownerToken, `/v1/artifacts/${reviewId}`, { header, expectedHeaderVersion: 2,
                body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [firstRound,
                    { ordinal: 2, state: 'running', startedAt: 30, finishedAt: null, reviewerIds: [], runs: [] }] }) }), expectedBodyVersion: 2,
                reviewMetadata: { ...metadata, currentRoundOrdinal: 2, state: 'running', startedAt: 30, finishedAt: null } });
            expect(next.json()).toMatchObject({ success: true });
            for (const token of [ownerToken, optionalToken]) {
                const human = await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}/human`, headers: headers(token) });
                expect(human.json()).toMatchObject({ roundOrdinal: 2, needsYou: { requestedVerdict: true, canSubmitVerdict: true } });
                expect(human.json().requests).toEqual(expect.arrayContaining([
                    expect.objectContaining({ roundOrdinal: 2, principal: { kind: 'account', accountId: owner.id }, required: true }),
                    expect.objectContaining({ roundOrdinal: 2, principal: { kind: 'account', accountId: optional.id }, required: false }),
                ]));
                expect(human.json().requests).toHaveLength(2);
                expect(human.json().verdicts).toHaveLength(2);
            }
            expect(await db.reviewRequestedReviewer.findMany({ where: { reviewId, roundOrdinal: 1 }, orderBy: { id: 'asc' } })).toEqual(oldRequests);
            expect(await db.reviewVerdict.findMany({ where: { reviewId, roundOrdinal: 1 }, orderBy: { accountId: 'asc' } })).toEqual(oldVerdicts);
            expect(await db.artifactGrant.findMany({ where: { artifactId: reviewId }, orderBy: { id: 'asc' } })).toEqual(grants);
            expect((await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}/human`, headers: headers(outsiderToken) })).statusCode).toBe(404);
            expect((await post(optionalToken, `/v1/reviews/${reviewId}/verdicts`, { roundOrdinal: 2, verdict: 'approve' })).statusCode).toBe(200);
        }, { authentication: 'real' });
    });

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
            const changes = () => db.accountChange.findMany({ where: { kind: 'artifact', entityId: reviewId }, orderBy: { accountId: 'asc' } });
            const beforeRequest = await changes();
            // These Accounts have no friendship with the editor. A request does not create a new share.
            const requested = await post(editor.id, 'reviewers', reviewers);
            expect(requested.statusCode).toBe(200);
            const requestedChanges = await changes();
            expect(requestedChanges).not.toEqual(beforeRequest);
            expect(requestedChanges.map(row => row.accountId).sort()).toEqual([owner.id, person.id, editor.id].sort());
            const identicalRequest = await post(editor.id, 'reviewers', { ...reviewers, reviewers: [...reviewers.reviewers].reverse() });
            expect(identicalRequest.json().requests).toEqual(requested.json().requests);
            expect(await changes()).toEqual(requestedChanges);
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
            expect((await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve', accountId: outsider.id })).statusCode).toBe(400);
            const submitted = await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve' });
            expect(submitted.statusCode).toBe(200);
            expect(submitted.json()).toMatchObject({ verdicts: [{ accountId: person.id, roundOrdinal: 1, verdict: 'approve', revision: 1 }],
                needsYou: { needsYou: false, canSubmitVerdict: true } });
            expect((await listFor(person.id)).json().items[0].needsYou).toMatchObject({ needsYou: false, requestedVerdict: false });
            const submittedChanges = await changes();
            expect(submittedChanges).not.toEqual(requestedChanges);
            const replay = await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'approve' });
            expect(replay.json().verdicts[0].revision).toBe(1);
            expect(await changes()).toEqual(submittedChanges);
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
            const proseChanges = await changes();
            expect((await executeHuman(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
                { reviewId, roundOrdinal: 1, verdict: 'approve' })).verdicts).toEqual(withProse.verdicts);
            expect(await changes()).toEqual(proseChanges);
            const changedWithoutProse = await executeHuman(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
                { reviewId, roundOrdinal: 1, verdict: 'request_changes' });
            expect(changedWithoutProse.verdicts).toEqual([expect.objectContaining({ verdict: 'request_changes', revision: 3 })]);
            expect(changedWithoutProse.verdicts[0]).not.toHaveProperty('body');
            expect(await db.reviewVerdict.findFirstOrThrow({ where: { reviewId } })).toMatchObject({ verdict: 'request_changes', revision: 3, content: null });
            const changedVerdictChanges = await changes();
            expect((await executeHuman(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
                { reviewId, roundOrdinal: 1, verdict: 'request_changes' })).verdicts).toEqual(changedWithoutProse.verdicts);
            expect(await changes()).toEqual(changedVerdictChanges);
            expect((await post(person.id, 'verdicts', { roundOrdinal: 1, verdict: 'request_changes', expectedRevision: 1,
                content: { t: 'plain', v: prose } })).json()).toMatchObject({ error: 'review_verdict_revision_mismatch' });
            await inTx(tx => writeReviewRoundState(tx, { reviewId, metadata: { projectSourceId: null, workflowId: null,
                subjectKind: 'comparison', sourceKind: 'direct', state: 'running', currentRoundOrdinal: 2, startedAt: 3, finishedAt: null } }));
            const renewed = await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}/human`, headers: headers(person.id) });
            expect(renewed.json()).toMatchObject({ roundOrdinal: 2, needsYou: { requestedVerdict: true, reason: 'review_needs_you' } });
            expect(renewed.json().requests).toHaveLength(2);
            expect(renewed.json().requests.filter((request: { roundOrdinal: number }) => request.roundOrdinal === 2))
                .toEqual(expect.arrayContaining([
                    expect.objectContaining({ principal: { kind: 'account', accountId: person.id }, required: true }),
                    expect.objectContaining({ principal: { kind: 'account', accountId: outsider.id }, required: false, needsAccess: true }),
                ]));
            const renewedRows = await db.reviewRequestedReviewer.findMany({ where: { reviewId, roundOrdinal: 2 },
                select: { principal: true, required: true, eligibleAccounts: { select: { accountId: true } } } });
            expect(renewedRows).toHaveLength(2);
            expect(renewedRows).toEqual(expect.arrayContaining([
                    { principal: { kind: 'account', accountId: person.id }, required: true, eligibleAccounts: [{ accountId: person.id }] },
                    { principal: { kind: 'account', accountId: outsider.id }, required: false, eligibleAccounts: [{ accountId: outsider.id }] },
                ]));
            expect((await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}/human`, headers: headers(outsider.id) })).statusCode).toBe(404);
            expect(renewed.json().verdicts).toEqual([expect.objectContaining({ roundOrdinal: 1, revision: 3 })]);
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
            expect(renewedRequests).toHaveLength(3);
            expect(renewedRequests).toEqual(expect.arrayContaining([
                { principal: { kind: 'team', teamId: team.id }, required: true },
                { principal: { kind: 'account', accountId: alice.id }, required: true },
                { principal: { kind: 'account', accountId: unsharedMember.id }, required: false },
            ]));
            expect((await post(bob.id, 'verdicts', { roundOrdinal: 2, verdict: 'approve' })).json())
                .toMatchObject({ error: 'review_reviewer_not_requested' });
            expect((await post(guest.id, 'verdicts', { roundOrdinal: 2, verdict: 'approve' })).statusCode).toBe(200);
        });
    });
});
