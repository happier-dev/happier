import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { ArtifactCreateHttpResponseV1Schema, ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { MEMORY_ARCHIVE_TOPIC_TITLE_V1, MemoryDocArtifactHeaderV1StoredSchema, renderMemoryDocV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { createMemoryDocInLibrary, readMemoryDocInLibrary, readMemoryDocVersionInLibrary, rememberMemoryFactInLibrary, type PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1 as paths, DocEditAcceptTransportInputV1Schema, DocEditDecisionResultV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { readDiscussionMessages } from '@/app/discussions/queries';
import { createArtifact, updateArtifactTx } from '@/app/artifacts/artifactWriteService';
import { readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { eventRouter } from '@/app/events/eventRouter';
import { enableAuthentication } from '../../utils/enableAuthentication';
import { enableErrorHandlers } from '../../utils/enableErrorHandlers';
import { artifactsRoutes } from './artifactsRoutes';
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

const authentication = createPresentUserSessionAccessAuthentication();
const encoded = encodePlainArtifactStoredContent;
const bytes = (value: unknown) => privacyKit.decodeBase64(encoded(value));

describe('Doc proposal HTTP decisions with verified credentials and SQLite', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-doc-decision-http-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true', HAPPIER_FEATURE_SESSIONS__ENABLED: 'true',
                HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: 'true' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifactId = crypto.randomUUID();
        expect(await createArtifact({ actorUserId: owner.id, artifactId, header: bytes({ title: 'Doc' }), body: bytes({ body: 'Passage follows' }),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) })).toMatchObject({ ok: true });
        const revision = { headerVersion: 1, bodyVersion: 1 };
        const target = { ref: { kind: 'doc' as const, artifactId, serverId: 'home' }, revision,
            range: { start: 0, end: 7 }, quote: 'Passage' };
        const content = { kind: 'doc_edit_proposal' as const, proposal: {
            target, baseRevision: revision, before: target.quote, after: '**Passage**', reason: 'Emphasis' } };
        const comment = { kind: 'doc_passage_comment' as const, passage: target, content: {
            v: 1 as const, parts: [{ t: 'text' as const, text: 'Make the Payments runbook instruction stand out.' }],
        } };
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: buildDiscussionMutationRequestBodyV1({
            kind: 'create', creationLocalId: crypto.randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Proposal' } },
            firstMessage: { localId: crypto.randomUUID(), mentionedAccountIds: [],
                content: { t: 'plain', v: comment }, authoredContent: comment,
                replyTarget: { kind: 'doc_passage', doc: { ref: target.ref, revision } } },
        }) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const proposal = await postDiscussionMessage({ actorAccountId: owner.id, authentication, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(), mentionedAccountIds: [],
                content: { t: 'plain', v: content }, authoredContent: content,
                replyTarget: { kind: 'doc_passage', doc: { ref: target.ref, revision } },
            }) });
        if (!proposal.ok) throw new Error(proposal.error);
        const proposalRef = createDiscussionMessageRefV1({ serverId: 'home', discussionId }, proposal.value.message);
        const accept = DocEditAcceptTransportInputV1Schema.parse({ proposalRef, expectedRevision: revision,
            preparation: { doc: { ref: target.ref, revision }, body: encoded({ body: '**Passage** follows' }) } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableErrorHandlers(app);
        enableAuthentication(app);
        artifactsRoutes(app);
        await app.ready();
        const post = (decision: keyof typeof paths, payload: unknown = decision === 'accept' ? accept : { proposalRef }, bearer = token,
            headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: paths[decision], payload: JSON.stringify(payload),
                headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...headers } });
        const current = () => db.artifact.findUniqueOrThrow({ where: { id: artifactId } });
        const disposition = () => db.discussionMessage.findUniqueOrThrow({ where: { id: proposalRef.messageId },
            select: { docEditProposalDispositionV1: true } });
        return { owner, artifactId, discussionId, firstMessageId: created.value.firstMessage.id, comment, proposalRef,
            accept, token, app, post, current, disposition };
    }

    it('opens a passage Discussion, rejoins one accepted proposal and replaces the saved decision through real HTTP', async () => {
        const f = await fixture();
        const events = vi.spyOn(eventRouter, 'emitUpdate');
        try {
            expect(await readDiscussionMessages({ authentication, actorAccountId: f.owner.id, discussionId: f.discussionId }))
                .toMatchObject({ ok: true, value: { messages: [
                    { id: f.firstMessageId, content: { t: 'plain', v: f.comment } },
                    { id: f.proposalRef.messageId, content: { t: 'plain', v: { kind: 'doc_edit_proposal' } } },
                ] } });
            const accepted = await f.post('accept');
            expect(accepted.statusCode, accepted.body).toBe(200);
            const receipt = DocEditDecisionResultV1Schema.parse(accepted.json());
            expect(receipt).toMatchObject({ proposalRef: f.proposalRef, docEditProposalDispositionV1: {
                state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 }, decidedBy: { accountId: f.owner.id } } });
            const read = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: f.owner.id, artifactId: f.artifactId }));
            if (!read.ok) throw new Error(read.error);
            expect(decodePlainArtifactStoredContent(privacyKit.encodeBase64(new Uint8Array(read.artifact.body)))).toEqual({ body: '**Passage** follows' });
            const updateCount = () => events.mock.calls.filter(([event]) => event.payload.body.t === 'update-artifact').length;
            expect(updateCount()).toBe(1);
            for (const decision of ['accept', 'decline'] as const) {
                const retry = await f.post(decision);
                expect(retry.statusCode, retry.body).toBe(200);
                expect(DocEditDecisionResultV1Schema.parse(retry.json())).toEqual(receipt);
            }
            expect((await f.current()).bodyVersion).toBe(2);
            expect(await db.artifactRevision.count({ where: { artifactId: f.artifactId } })).toBe(1);
            expect(updateCount()).toBe(1);

            const settlement = receipt.docEditProposalDispositionV1;
            if (settlement.state !== 'accepted') throw new Error('Expected the accepted proposal');
            const headers = { authorization: `Bearer ${f.token}`,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
            const decision = { reason: 'Highlight the Payments runbook instruction', sourceMessageRef: receipt.proposalRef,
                approvedBy: settlement.decidedBy };
            const expiresAtMs = Date.UTC(2030, 0, 1);
            const store: PromptLibraryArtifactStore = {
                read: async artifactId => {
                    const response = await f.app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}`, headers });
                    expect(response.statusCode, response.body).toBe(200);
                    const { id, header, body, headerVersion, bodyVersion } = ArtifactHttpReadV1Schema.parse(response.json());
                    const stored = decodePlainArtifactStoredContent(body);
                    if (!stored || typeof stored !== 'object' || !('body' in stored) || typeof stored.body !== 'string') {
                        throw new Error('Expected a plain Memory document');
                    }
                    return { id, revision: { headerVersion, bodyVersion },
                        header: MemoryDocArtifactHeaderV1StoredSchema.parse(decodePlainArtifactStoredContent(header)), body: stored.body };
                },
                create: async ({ header, body, memoryDecisionSource }) => {
                    const id = crypto.randomUUID();
                    const response = await f.app.inject({ method: 'POST', url: '/v1/artifacts/memory-decision/create', headers,
                        payload: { id, header: encoded(header), body: encoded({ body }),
                            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, memoryDecisionSource } });
                    expect(response.statusCode, response.body).toBe(200);
                    return ArtifactCreateHttpResponseV1Schema.parse(response.json()).id;
                },
                update: async ({ artifactId, expectedRevision, body, memoryDecisionSource }) => {
                    const response = await f.app.inject({ method: 'POST', url: `/v1/artifacts/${artifactId}/memory-decision`, headers,
                        payload: { expectedBodyVersion: expectedRevision.bodyVersion, body: encoded({ body }), memoryDecisionSource } });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json()).toMatchObject({ success: true, bodyVersion: expectedRevision.bodyVersion + 1 });
                },
            };
            const text = 'Emphasize the runbook passage';
            const topic = 'Rollout decisions';
            const author = { store, sourceSessionRef: null, randomId: () => crypto.randomUUID() };
            const saved = await createMemoryDocInLibrary({ ...author, decision, request: { title: 'Payments decisions', topic, text, expiresAtMs } });
            const readMemory = { store, artifactId: saved.artifactId };
            const before = await readMemoryDocInLibrary({ ...readMemory, topic });
            expect(before).toMatchObject({ topic: { facts: [{ id: saved.factId, text, decision, expiresAtMs }] } });

            const replacement = { ...decision, reason: 'Keep the warning prominent during the Payments rollout' };
            const request = { ref: { kind: 'doc' as const, serverId: 'home', artifactId: saved.artifactId },
                expectedRevision: before.revision, text: 'Always emphasize the runbook passage', expiresAtMs: Date.UTC(2031, 0, 1) };
            expect(await rememberMemoryFactInLibrary({ ...author, decision: replacement, request })).toMatchObject({ ok: false,
                errorCode: 'memory_duplicate_choice_required', revision: before.revision, candidates: [{ factId: saved.factId }] });
            const replaced = await rememberMemoryFactInLibrary({ ...author, decision: replacement, request: { ...request,
                duplicateChoice: { kind: 'replace', factId: saved.factId, expectedRevision: before.revision } } });
            expect(replaced).toMatchObject({ ok: true });
            if (!replaced.ok) throw new Error(replaced.errorCode);
            const current = await readMemoryDocVersionInLibrary(readMemory);
            const prompt = renderMemoryDocV1({ body: current.body, nowMs: Date.now() });
            expect(prompt.loadedTopicTitles).toContain(topic);
            expect(prompt.markdown).not.toContain(request.text);
            expect(prompt.markdown).not.toContain(replacement.reason);
            expect(await readMemoryDocInLibrary({ ...readMemory, topic })).toMatchObject({ topic: { facts: [{ id: replaced.factId,
                supersedes: saved.factId, text: request.text, decision: replacement, expiresAtMs: request.expiresAtMs }] } });
            expect(await readMemoryDocInLibrary({ ...readMemory, topic: MEMORY_ARCHIVE_TOPIC_TITLE_V1 })).toMatchObject({ topic: {
                facts: [{ id: saved.factId, text, decision, expiresAtMs, archivedByMutation: true }],
            } });
        } finally { events.mockRestore(); await f.app.close(); }
    });

    it('refuses automation and caller-supplied authority without any writes or update events', async () => {
        const f = await fixture();
        const pat = await auth.createApiToken({ accountId: f.owner.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(f.owner.id, 'Cannot decide') });
        const events = vi.spyOn(eventRouter, 'emitUpdate');
        const before = await db.accountChange.count({ where: { accountId: f.owner.id } });
        try {
            expect((await f.post('accept', f.accept, pat.token)).statusCode).toBe(403);
            expect((await f.post('accept', f.accept, f.token, { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' })).statusCode).toBe(403);
            for (const extra of [{ decidingBy: { accountId: f.owner.id } }, { presentPerson: true }, { bypassApprovals: true }]) {
                expect((await f.post('accept', { ...f.accept, ...extra })).statusCode).toBe(400);
            }
            expect((await f.current()).bodyVersion).toBe(1);
            expect(await f.disposition()).toMatchObject({ docEditProposalDispositionV1: { state: 'open' } });
            expect(await db.accountChange.count({ where: { accountId: f.owner.id } })).toBe(before);
            expect(events.mock.calls).toHaveLength(0);
        } finally { events.mockRestore(); await f.app.close(); }
    });

    it('refuses view-only or revoked source access and a stale revision without partial mutation', async () => {
        const f = await fixture();
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const token = await auth.createToken(reader.id, undefined, { kind: 'account', authority: 'present_user' });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: f.artifactId, accountId: reader.id, accessLevel: 'view', createdByAccountId: f.owner.id } });
        await db.discussionGrant.create({ data: { principalKind: 'account', discussionId: f.proposalRef.discussion.discussionId, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: f.owner.id } });
        try {
            expect((await f.post('accept', f.accept, token)).statusCode).toBe(403);
            await db.artifactGrant.delete({ where: { principalKind: 'account', artifactId_accountId: { artifactId: f.artifactId, accountId: reader.id } } });
            const revoked = await f.post('decline', { proposalRef: f.proposalRef }, token);
            expect(revoked.statusCode, revoked.body).toBe(409);
            expect(revoked.json()).toEqual({ error: 'discussion_content_unavailable' });
            expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: f.owner.id, artifactId: f.artifactId,
                body: { bytes: bytes({ body: 'Competing change' }), expectedVersion: 1 } }))).toMatchObject({ ok: true });
            const events = vi.spyOn(eventRouter, 'emitUpdate');
            const before = await db.accountChange.count({ where: { accountId: f.owner.id } });
            try {
                expect((await f.post('accept')).statusCode).toBe(409);
                expect((await f.current()).bodyVersion).toBe(2);
                expect(await f.disposition()).toMatchObject({ docEditProposalDispositionV1: { state: 'open' } });
                expect(await db.accountChange.count({ where: { accountId: f.owner.id } })).toBe(before);
                expect(events.mock.calls).toHaveLength(0);
            } finally { events.mockRestore(); }
        } finally { await f.app.close(); }
    });

    it('declines without a Doc revision and fails closed when the existing Discussion feature is disabled', async () => {
        const f = await fixture();
        try {
            process.env.HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED = 'false';
            expect((await f.post('decline')).statusCode).toBe(404);
            expect(await f.disposition()).toMatchObject({ docEditProposalDispositionV1: { state: 'open' } });
            process.env.HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED = 'true';
            const declined = await f.post('decline');
            expect(declined.statusCode, declined.body).toBe(200);
            expect(DocEditDecisionResultV1Schema.parse(declined.json())).toMatchObject({
                docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: f.owner.id } } });
            expect((await f.current()).bodyVersion).toBe(1);
            expect(await db.artifactRevision.count({ where: { artifactId: f.artifactId } })).toBe(0);
        } finally { process.env.HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED = 'true'; await f.app.close(); }
    });
});
