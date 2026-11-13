import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DiscussionCreateRequestV1Schema, DiscussionMessagesResponseV1Schema, DiscussionPostRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionMessageContentV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { prepareDocDiscussionMutationV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import tweetnacl from 'tweetnacl';
import { encrypt } from '../../../../cli/src/api/encryption';
import { openSessionStoredContent, sealSessionStoredContent } from '../../../../cli/src/session/transport/encryption/sessionStoredContentCodec';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { decideArtifactEditProposal } from '@/app/artifacts/artifactEditProposalService';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { archiveDiscussion, createDiscussion, postDiscussionMessage, restoreDiscussion } from './mutations';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { getDiscussion, listDiscussions, readDiscussionMessageInTx, readDiscussionMessages } from './queries';
import { readDiscussionAttention } from './attentionFacts';
import { setDiscussionReadCursor } from './readState';
import { inviteDiscussionParticipant } from './accessService';

const authentication = createPresentUserSessionAccessAuthentication();
const text = (value: string) => ({ v: 1, parts: [{ t: 'text', text: value }] });

describe('Doc passage Discussions through the canonical writer and client codec (SQLite composition)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-doc-discussions-', initEncrypt: true,
        env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1' } }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const created = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: 'Source', kind: 'markdown' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'again / again!' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!created.ok) throw new Error(created.error);
        const doc = { ref: { kind: 'doc' as const, artifactId: created.artifact.id, serverId: 'test-home' },
            revision: { headerVersion: created.artifact.headerVersion, bodyVersion: created.artifact.bodyVersion } };
        const passage = { ...doc, range: { start: 8, end: 13 }, quote: 'again', prefix: 'again / ', suffix: '!' };
        const request = DiscussionCreateRequestV1Schema.parse({ creationLocalId: randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'Document comments' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: {
                kind: 'doc_passage_comment', passage, content: text('Clarify this occurrence'),
            } }, mentionedAccountIds: [], replyTarget: { kind: 'doc_passage', doc } } });
        return { owner, reader, doc, passage, request };
    }

    it('projects only active matching Doc roots through the scoped list and preserves explicit source unavailability', async () => {
        const { owner, reader, doc, request } = await fixture();
        await db.artifactAccountGrant.create({ data: { artifactId: doc.ref.artifactId, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const create = async (anchorDoc = doc) => {
            const result = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                ...request, creationLocalId: randomUUID(), anchor: { kind: 'doc', doc: anchorDoc },
                participants: [{ kind: 'account', accountId: reader.id }],
                firstMessage: { ...request.firstMessage, localId: randomUUID() },
            } });
            if (!result.ok) throw new Error(result.error);
            return result.value;
        };
        const first = await create(), second = await create({ ...doc, ref: { ...doc.ref, serverId: 'another-client-profile' } });
        await archiveDiscussion({ authentication, actorAccountId: owner.id, discussionId: second.discussion.id });
        const ordinary = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            ...request, creationLocalId: randomUUID(), participants: [{ kind: 'account', accountId: reader.id }],
            firstMessage: { ...request.firstMessage, localId: randomUUID(), content: { t: 'plain', v: text('Unrelated ordinary Discussion') }, replyTarget: undefined },
        } });
        if (!ordinary.ok) throw new Error(ordinary.error);
        const other = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: 'Other source', kind: 'markdown' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'PRIVATE_OTHER_DOC' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!other.ok) throw new Error(other.error);
        const otherDoc = { ref: { ...doc.ref, artifactId: other.artifact.id },
            revision: { headerVersion: other.artifact.headerVersion, bodyVersion: other.artifact.bodyVersion } };
        await db.artifactAccountGrant.create({ data: { artifactId: other.artifact.id, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const later = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId: first.discussion.id,
            request: DiscussionPostRequestV1Schema.parse({ localId: randomUUID(), content: { t: 'plain', v: {
                kind: 'doc_passage_comment', passage: { ...otherDoc, range: { start: 0, end: 17 }, quote: 'PRIVATE_OTHER_DOC' },
                content: text('PRIVATE_LATER_CONTENT'),
            } }, replyTarget: { kind: 'doc_passage', doc: otherDoc }, mentionedAccountIds: [] }) });
        if (!later.ok) throw new Error(later.error);
        await db.artifactAccountGrant.delete({ where: { artifactId_accountId: { artifactId: other.artifact.id, accountId: reader.id } } });
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate('authenticate', async (incoming: FastifyRequest) => {
            incoming.userId = reader.id; incoming.authAuthority = 'present_user'; incoming.authTokenKind = 'account';
        });
        registerDiscussionRoutes(app);
        const scope = `anchorDocArtifactId=${encodeURIComponent(doc.ref.artifactId)}`;
        try {
            const direct = await listDiscussions({ authentication, actorAccountId: reader.id,
                ...{ anchorDocArtifactId: doc.ref.artifactId } });
            expect(direct).toMatchObject({ ok: true });
            if (!direct.ok) throw new Error(direct.error);
            expect(direct.value.discussions.map(row => row.id)).toEqual([first.discussion.id]);
            const mismatch = await app.inject({ method: 'GET', url: '/v1/discussions?anchorDocArtifactId=unrelated-doc' });
            expect(mismatch.statusCode).toBe(200);
            expect(mismatch.json()).toEqual({ discussions: [], nextCursor: null });
            const list = await app.inject({ method: 'GET', url: `/v1/discussions?${scope}&limit=1` });
            expect(list.statusCode).toBe(200);
            expect(list.json().discussions.map((row: { id: string }) => row.id)).toEqual([first.discussion.id]);
            expect(list.json().discussions[0].latestMessage).not.toHaveProperty('content');
            expect(list.json().discussions[0].firstMessage).toMatchObject({ id: first.firstMessage.id, seq: 1,
                content: request.firstMessage.content, replyTarget: request.firstMessage.replyTarget });
            expect(JSON.stringify(list.json())).not.toContain('PRIVATE_LATER_CONTENT');
            expect(JSON.stringify(list.json())).not.toContain('PRIVATE_OTHER_DOC');
            const exactUrl = `/v1/discussions/${first.discussion.id}/messages?messageId=${encodeURIComponent(first.firstMessage.id)}`;
            const exact = await app.inject({ method: 'GET', url: `${exactUrl}&throughSeq=1` });
            expect(exact.statusCode).toBe(200);
            expect(DiscussionMessagesResponseV1Schema.parse(exact.json())).toMatchObject({
                messages: [{ id: first.firstMessage.id, seq: 1 }], hasMoreOlder: false, messageSeq: 1,
            });
            const beforeExact = await app.inject({ method: 'GET', url: `${exactUrl}&throughSeq=0` });
            expect(beforeExact.statusCode).toBe(200);
            expect(beforeExact.json()).toEqual({ messages: [], hasMoreOlder: false, messageSeq: 0 });
            const privateExact = await app.inject({ method: 'GET',
                url: `/v1/discussions/${first.discussion.id}/messages?localId=${encodeURIComponent(request.firstMessage.localId)}` });
            expect(privateExact.statusCode).toBe(200);
            expect(DiscussionMessagesResponseV1Schema.parse(privateExact.json()).messages).toEqual([]);
            expect((await app.inject({ method: 'GET', url: `${exactUrl}&limit=1` })).statusCode).toBe(400);
            const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
            const destination = await db.session.create({ data: { accountId: reader.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: destination.id, createdByAccountId: reader.id, accountId: outsider.id, accessLevel: 'edit' } });
            const forbiddenContext = await listDiscussions({ actorAccountId: reader.id,
                authentication: { ...authentication, contentDisclosureSessionId: destination.id }, ...{ anchorDocArtifactId: doc.ref.artifactId } });
            expect(forbiddenContext).toMatchObject({ ok: true, value: { discussions: [{ id: first.discussion.id, firstMessage: null }] } });
            const unfiltered = await app.inject({ method: 'GET', url: '/v1/discussions' });
            expect(unfiltered.json().discussions.every((row: { firstMessage?: unknown }) => row.firstMessage === undefined)).toBe(true);
            expect((await app.inject({ method: 'GET', url: `/v1/discussions?${scope}&state=archived` })).statusCode).toBe(400);
            await restoreDiscussion({ authentication, actorAccountId: owner.id, discussionId: second.discussion.id });
            const page = await app.inject({ method: 'GET', url: `/v1/discussions?${scope}&limit=1` });
            expect(page.json().nextCursor).toEqual(expect.any(String));
            const next = await app.inject({ method: 'GET', url: `/v1/discussions?${scope}&limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}` });
            expect(new Set([...page.json().discussions, ...next.json().discussions].map((row: { id: string }) => row.id)))
                .toEqual(new Set([first.discussion.id, second.discussion.id]));
            await db.artifactAccountGrant.delete({ where: { artifactId_accountId: { artifactId: doc.ref.artifactId, accountId: reader.id } } });
            const unavailable = await app.inject({ method: 'GET', url: `/v1/discussions?${scope}` });
            expect(unavailable.statusCode).toBe(200);
            expect(unavailable.json().discussions).toHaveLength(2);
            for (const row of unavailable.json().discussions) {
                expect(row.firstMessage).toBeNull();
                expect(row.latestMessage).not.toHaveProperty('content');
            }
            expect(JSON.stringify(unavailable.json())).not.toContain('again');
            const withheldExact = await app.inject({ method: 'GET', url: exactUrl });
            expect(withheldExact.statusCode).toBe(409);
            expect(withheldExact.json()).toEqual({ error: 'discussion_content_unavailable' });
            await db.discussionMessage.delete({ where: { id: first.firstMessage.id } });
            const corrupt = await app.inject({ method: 'GET', url: `/v1/discussions?${scope}` });
            expect(corrupt.statusCode).toBe(400);
            expect(corrupt.json()).toEqual({ error: 'discussion_invalid_content' });
        } finally { await app.close(); }
    });

    it.each(['account', 'team'] as const)('a %s Doc reader starts a passage thread for the owner and all current readers', async kind => {
        const { owner, reader, doc, passage } = await fixture();
        const colleague = await db.account.create({ data: { encryptionMode: 'plain' } });
        if (kind === 'account') {
            await db.artifactAccountGrant.createMany({ data: [reader.id, colleague.id].map(accountId => ({
                artifactId: doc.ref.artifactId, accountId, accessLevel: 'view', createdByAccountId: owner.id,
            })) });
        } else {
            const team = await db.team.create({ data: { name: 'Doc audience' } });
            await db.teamMembership.createMany({ data: [owner.id, reader.id, colleague.id].map(accountId => ({
                teamId: team.id, accountId, role: accountId === owner.id ? 'owner' : 'member',
            })) });
            await db.artifactTeamGrant.create({ data: { artifactId: doc.ref.artifactId, teamId: team.id,
                accessLevel: 'view', createdByAccountId: owner.id } });
        }
        // Use the same public Doc action's child intent as the inline composer, with no chosen invitees.
        const prepared = prepareDocDiscussionMutationV1('doc.comment.reply', {
            target: passage, localId: randomUUID(), content: text('Can we clarify this?'),
        }, doc.ref.serverId);
        if (prepared.actionId !== 'discussion.create') throw new Error('Expected a new passage thread');
        const child = prepared.input;
        const request = DiscussionCreateRequestV1Schema.parse({ creationLocalId: child.creationLocalId,
            anchor: child.anchor, titleContent: { t: 'plain', v: { v: 1, title: child.title } },
            firstMessage: { ...child.firstMessage, mentionedAccountIds: [], content: { t: 'plain', v: child.firstMessage.content } } });
        const created = await createDiscussion({ authentication, actorAccountId: reader.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        for (const accountId of [owner.id, colleague.id]) {
            expect(await readDiscussionMessages({ authentication, actorAccountId: accountId, discussionId }))
                .toMatchObject({ ok: true, value: { messages: [{ id: created.value.firstMessage.id }] } });
            expect(await listDiscussions({ authentication, actorAccountId: accountId,
                anchorDocArtifactId: doc.ref.artifactId }))
                .toMatchObject({ ok: true, value: { discussions: [{ id: discussionId }] } });
            expect(await readDiscussionAttention({ authentication, actorAccountId: accountId, discussionId }))
                .toMatchObject({ ok: true, value: { discussions: [{ discussion: { id: discussionId },
                    occurrences: [{ type: 'update', message: { id: created.value.firstMessage.id } }] }] } });
        }
        expect(await db.discussionReadState.count({ where: { discussionId } })).toBe(3);
        expect(await createDiscussion({ authentication, actorAccountId: reader.id, request }))
            .toMatchObject({ ok: true, value: { discussion: { id: discussionId } } });
    });

    it('commits the exact passage once and reopens the same root after a lost create/post response', async () => {
        const { owner, passage, request } = await fixture();
        const input = { authentication, actorAccountId: owner.id, request };
        const created = await createDiscussion(input);
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) throw new Error(created.error);
        const { discussion, firstMessage } = created.value;
        expect(firstMessage.content).toMatchObject({ t: 'plain', v: { kind: 'doc_passage_comment', passage } });
        expect(JSON.stringify(firstMessage.replyTarget)).not.toContain('again');
        expect(await createDiscussion(input)).toMatchObject({ ok: true, value: {
            discussion: { id: discussion.id }, firstMessage: { id: firstMessage.id },
        } });
        const replyInput = { authentication, actorAccountId: owner.id, discussionId: discussion.id,
            request: DiscussionPostRequestV1Schema.parse({ localId: randomUUID(),
                content: { t: 'plain', v: text('An ordinary reply') }, mentionedAccountIds: [],
                replyTarget: { kind: 'message', messageId: firstMessage.id } }) };
        const reply = await postDiscussionMessage(replyInput);
        expect(reply).toMatchObject({ ok: true });
        if (!reply.ok) throw new Error(reply.error);
        expect(await postDiscussionMessage(replyInput)).toMatchObject({ ok: true, value: { message: { id: reply.value.message.id } } });
        expect(await db.discussionMessage.count({ where: { discussionId: discussion.id } })).toBe(2);
        const ref = createDiscussionMessageRefV1({ serverId: 'test-home', discussionId: discussion.id }, firstMessage);
        expect(ref.messageId).toBe(firstMessage.id);
        expect(await getDiscussion({ authentication, actorAccountId: owner.id, discussionId: ref.discussion.discussionId }))
            .toMatchObject({ ok: true, value: { discussion: { id: discussion.id } } });
        expect(await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId: ref.discussion.discussionId }))
            .toMatchObject({ ok: true, value: { messages: [
                { id: ref.messageId, content: { t: 'plain', v: { passage } } },
                { id: reply.value.message.id, replyTarget: { kind: 'message', messageId: ref.messageId } },
            ] } });
    });

    it('roundtrips the canonical Doc creator anchor and preserves its Discussion after source deletion', async () => {
        const { owner, reader, doc, passage } = await fixture();
        const prepared = prepareDocDiscussionMutationV1('doc.comment.reply', {
            target: passage, localId: randomUUID(), content: text('Discuss this passage'),
        }, doc.ref.serverId);
        if (prepared.actionId !== 'discussion.create') throw new Error('Expected the canonical root creator');
        const child = prepared.input;
        const request = DiscussionCreateRequestV1Schema.parse({ creationLocalId: child.creationLocalId,
            anchor: child.anchor, titleContent: { t: 'plain', v: { v: 1, title: child.title } },
            firstMessage: { localId: child.firstMessage.localId, content: { t: 'plain', v: child.firstMessage.content },
                mentionedAccountIds: [], replyTarget: child.firstMessage.replyTarget } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const anchor = { kind: 'doc', doc };
        expect(DiscussionSummaryV1Schema.parse(created.value.discussion)).toMatchObject({ anchor });
        expect(await getDiscussion({ authentication, actorAccountId: reader.id, discussionId })).toMatchObject({ ok: false });
        expect(await db.artifactAccountGrant.count({ where: { artifactId: doc.ref.artifactId } })).toBe(0);
        expect(await db.discussionAccountGrant.count({ where: { discussionId } })).toBe(0);
        await db.artifact.delete({ where: { id: doc.ref.artifactId } });
        const opened = await getDiscussion({ authentication, actorAccountId: owner.id, discussionId });
        expect(opened).toMatchObject({ ok: true, value: { discussion: { id: discussionId, anchor } } });
        if (!opened.ok) throw new Error(opened.error);
        expect(DiscussionSummaryV1Schema.parse(opened.value.discussion).latestMessage.content).toBeUndefined();
        expect(await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId }))
            .toMatchObject({ ok: true, value: { messages: [], hasMoreOlder: false, messageSeq: 1 } });
        const linkedOnly = await createDiscussion({ authentication, actorAccountId: owner.id,
            request: { ...request, creationLocalId: randomUUID(), firstMessage: { localId: randomUUID(),
                content: { t: 'plain', v: text('A link without copied source content') }, mentionedAccountIds: [] } } });
        expect(linkedOnly).toMatchObject({ ok: true, value: { discussion: { anchor } } });
    });

    it('rejoins a retained Doc create when the canonical producer adds its derived source anchor', async () => {
        const { owner, passage, request } = await fixture();
        const prepared = prepareDocDiscussionMutationV1('doc.comment.reply', { target: passage,
            localId: request.firstMessage.localId, content: text('Clarify this occurrence') }, passage.ref.serverId);
        if (prepared.actionId !== 'discussion.create' || !prepared.input.creationLocalId) throw new Error('Expected the canonical root creator');
        const retained = { ...request, creationLocalId: prepared.input.creationLocalId };
        const first = await createDiscussion({ authentication, actorAccountId: owner.id, request: retained });
        if (!first.ok) throw new Error(first.error);
        const retried = await createDiscussion({ authentication, actorAccountId: owner.id,
            request: { ...retained, anchor: prepared.input.anchor } });
        expect(retried).toMatchObject({ ok: true, value: {
            discussion: { id: first.value.discussion.id }, firstMessage: { id: first.value.firstMessage.id },
        } });
        expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(1);
    });

    it('initializes a plain proposal once and refuses a proposal marker on ordinary content', async () => {
        const { owner, passage, request } = await fixture();
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const proposal = { localId: randomUUID(), mentionedAccountIds: [], replyTarget: {
            kind: 'message' as const, messageId: created.value.firstMessage.id,
        }, content: { t: 'plain' as const, v: { kind: 'doc_edit_proposal', proposal: {
            target: passage, baseRevision: passage.revision, before: passage.quote, after: 'once more', reason: 'Clarify',
        } } } };
        const input = { authentication, actorAccountId: owner.id, discussionId, request: proposal };
        expect(await postDiscussionMessage(input)).toMatchObject({ ok: true, value: { message: {
            docEditProposalDispositionV1: { state: 'open' },
        } } });
        expect(await postDiscussionMessage(input)).toMatchObject({ ok: true, value: { message: {
            docEditProposalDispositionV1: { state: 'open' },
        } } });
        expect(await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId }))
            .toMatchObject({ ok: true, value: { messages: [{ id: created.value.firstMessage.id }, {
                docEditProposalDispositionV1: { state: 'open' },
            }] } });
        const forged = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { localId: randomUUID(), mentionedAccountIds: [], content: { t: 'plain', v: text('Ordinary text') }, docEditProposal: true } });
        expect(forged).toMatchObject({ ok: false, error: 'discussion_invalid_content' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
    });

    it.each(['first comment', 'reply'] as const)('admits a Doc reader’s invited Session in the %s before its proposal, without self-invitation', async entry => {
        const { owner, reader, doc, passage, request } = await fixture();
        await db.artifactAccountGrant.create({ data: { artifactId: doc.ref.artifactId, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const session = await db.session.create({ data: { accountId: reader.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const content = { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } },
            { t: 'text', text: ' Propose a clearer version' }] };
        const addressed = { ...request.firstMessage, mentionedSessionIds: [session.id], content: { t: 'plain' as const,
            v: { kind: 'doc_passage_comment', passage, content } } };
        const created = await createDiscussion({ authentication, actorAccountId: reader.id,
            request: DiscussionCreateRequestV1Schema.parse({ ...request,
                participants: entry === 'first comment' ? [{ kind: 'session', sessionId: session.id }] : [],
                firstMessage: entry === 'first comment' ? addressed : request.firstMessage }) });
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        if (entry === 'reply') {
            expect(await inviteDiscussionParticipant({ authentication, actorAccountId: reader.id, discussionId,
                request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
            expect(await postDiscussionMessage({ authentication, actorAccountId: reader.id, discussionId,
                request: DiscussionPostRequestV1Schema.parse({ ...addressed, localId: randomUUID(),
                    content: { t: 'plain', v: content }, replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } }) }))
                .toMatchObject({ ok: true, value: { message: { addressingV1: { participantSessionIds: [session.id] } } } });
        }
        expect(await db.discussionParticipant.findUnique({ where: { discussionId_sessionId: { discussionId, sessionId: session.id } } }))
            .toMatchObject({ removedAt: null, answerPolicy: 'when_addressed' });
        const prepared = prepareDocDiscussionMutationV1('doc.edit.propose', { localId: randomUUID(), target: passage,
            baseRevision: doc.revision, before: passage.quote, after: 'once more', reason: 'Clarify',
            discussionRef: { serverId: 'test-home', discussionId }, replyTo: createDiscussionMessageRefV1({ serverId: 'test-home', discussionId }, created.value.firstMessage) }, 'test-home');
        if (prepared.actionId === 'discussion.create') throw new Error('Expected a proposal in the admitted thread');
        expect(await postDiscussionMessage({ authentication: { ...authentication, contentDisclosureSessionId: session.id },
            actorAccountId: reader.id, discussionId, producer: { v: 1, kind: 'agent', sessionId: session.id },
            request: DiscussionPostRequestV1Schema.parse({ localId: prepared.input.localId, replyTarget: prepared.input.replyTarget, mentionedAccountIds: [],
                content: { t: 'plain', v: prepared.input.content } }) }))
            .toMatchObject({ ok: true, value: { message: { producerV1: { kind: 'agent', sessionId: session.id },
                docEditProposalDispositionV1: { state: 'open' } } } });
    });

    it('admits a same-Doc redo from another client Home label without admitting a different Doc', async () => {
        const { owner, doc, passage, request } = await fixture();
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const target = { ...passage, ref: { ...passage.ref, serverId: 'another-device-profile' } };
        const proposal = { kind: 'doc_edit_proposal', proposal: { target, baseRevision: doc.revision,
            before: passage.quote, after: 'once more', reason: 'QA redo from another device' } };
        const post = (content: unknown) => postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: DiscussionPostRequestV1Schema.parse({ localId: randomUUID(), content: { t: 'plain', v: content },
                mentionedAccountIds: [], replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } }) });
        expect(await post({ ...proposal, proposal: { ...proposal.proposal,
            target: { ...target, ref: { ...target.ref, artifactId: randomUUID() } } } })).toMatchObject({ ok: false });
        const posted = await post(proposal);
        expect(posted).toMatchObject({ ok: true });
        if (!posted.ok) throw new Error(posted.error);
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        const proposalRef = createDiscussionMessageRefV1({ serverId: 'reader-device-profile', discussionId }, posted.value.message);
        expect(await decideArtifactEditProposal({ authentication, actorAccountId: owner.id,
            proposalRef, expectedRevision: doc.revision, decision: 'accept' })).toMatchObject({ ok: true,
            disposition: { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 } } });
    });

    it('denies a broader audience before creating or appending any quoted content', async () => {
        const { owner, reader, request } = await fixture();
        const deniedCreate = await createDiscussion({ authentication, actorAccountId: owner.id,
            request: { ...request, participants: [{ kind: 'account', accountId: reader.id }] } });
        expect(deniedCreate).toMatchObject({ ok: false });
        expect(await db.discussion.count({ where: { createdByAccountId: owner.id, creationLocalId: request.creationLocalId } })).toBe(0);
        const normal = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            ...request, creationLocalId: randomUUID(), participants: [{ kind: 'account', accountId: reader.id }],
            firstMessage: { ...request.firstMessage, content: { t: 'plain', v: text('Ordinary chat') }, replyTarget: undefined },
        } });
        if (!normal.ok) throw new Error(normal.error);
        const post = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId: normal.value.discussion.id,
            request: request.firstMessage });
        expect(post).toMatchObject({ ok: false });
        expect(await db.discussionMessage.count({ where: { discussionId: normal.value.discussion.id } })).toBe(1);
    });

    it.each(['root', 'proposal', 'reply'] as const)('withholds latest %s content from list/get summaries after Doc revocation', async latest => {
        const { owner, reader, doc, passage, request } = await fixture();
        await db.artifactAccountGrant.create({ data: { artifactId: doc.ref.artifactId,
            accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id,
            request: { ...request, participants: [{ kind: 'account', accountId: reader.id }] } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        if (latest !== 'root') {
            const content = latest === 'proposal' ? { kind: 'doc_edit_proposal', proposal: {
                target: passage, baseRevision: doc.revision, before: passage.quote, after: 'once more', reason: 'Clarify',
            } } : text('again: inherited source context');
            const posted = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
                request: DiscussionPostRequestV1Schema.parse({ localId: randomUUID(), content: { t: 'plain', v: content },
                    mentionedAccountIds: [], replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } }) });
            if (!posted.ok) throw new Error(posted.error);
        }
        const read = { authentication, actorAccountId: reader.id, discussionId };
        const admitted = await getDiscussion(read);
        expect(admitted).toMatchObject({ ok: true });
        expect(JSON.stringify(admitted)).toContain('again');
        expect(await listDiscussions({ authentication, actorAccountId: reader.id })).toMatchObject({ ok: true });
        await db.artifactAccountGrant.delete({ where: { artifactId_accountId: { artifactId: doc.ref.artifactId, accountId: reader.id } } });
        const deniedGet = await getDiscussion(read);
        const deniedList = await listDiscussions({ authentication, actorAccountId: reader.id });
        expect(deniedGet).toMatchObject({ ok: true });
        expect(deniedList).toMatchObject({ ok: true });
        if (!deniedGet.ok || !deniedList.ok) throw new Error('Discussion metadata remains independently authorized');
        expect(deniedGet.value.discussion.latestMessage.content).toBeUndefined();
        expect(deniedList.value.discussions.find(row => row.id === discussionId)?.latestMessage.content).toBeUndefined();
        expect(JSON.stringify([deniedGet, deniedList])).not.toContain('again');
        expect(await getDiscussion({ ...read, actorAccountId: owner.id })).toMatchObject({ ok: true });
    });

    it('withholds quoted roots, inherited replies and retry acknowledgements after source revocation', async () => {
        const { owner, reader, doc, request } = await fixture();
        await db.artifactAccountGrant.create({ data: { artifactId: doc.ref.artifactId,
            accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id,
            request: { ...request, participants: [{ kind: 'account', accountId: reader.id }] } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await readDiscussionMessages({ authentication, actorAccountId: reader.id, discussionId })).toMatchObject({ ok: true });
        const committedReply = await postDiscussionMessage({ authentication, actorAccountId: reader.id, discussionId,
            request: { localId: randomUUID(), content: { t: 'plain', v: text('Context inherited from the root') }, mentionedAccountIds: [],
                replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } } });
        expect(committedReply).toMatchObject({ ok: true });
        await db.artifactAccountGrant.delete({ where: { artifactId_accountId: { artifactId: doc.ref.artifactId, accountId: reader.id } } });
        const deniedRead = await readDiscussionMessages({ authentication, actorAccountId: reader.id, discussionId });
        expect(deniedRead).toMatchObject({ ok: true, value: { messages: [], hasMoreOlder: false } });
        expect(JSON.stringify(deniedRead)).not.toContain('again');
        const deniedPage = await readDiscussionMessages({ authentication, actorAccountId: reader.id, discussionId, afterSeq: 1 });
        expect(deniedPage).toMatchObject({ ok: true, value: { messages: [], hasMoreOlder: false } });
        expect(JSON.stringify(deniedPage)).not.toContain('Context inherited');
        const deniedRetry = await createDiscussion({ authentication, actorAccountId: owner.id,
            request: { ...request, participants: [{ kind: 'account', accountId: reader.id }] } });
        expect(deniedRetry).toMatchObject({ ok: false });
        const reply = await postDiscussionMessage({ authentication, actorAccountId: reader.id, discussionId,
            request: { localId: randomUUID(), content: { t: 'plain', v: text('Reply') }, mentionedAccountIds: [],
                replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } } });
        expect(reply).toMatchObject({ ok: false });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        await db.artifact.delete({ where: { id: doc.ref.artifactId } });
        const unavailable = await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId });
        expect(unavailable).toMatchObject({ ok: true, value: { messages: [], hasMoreOlder: false } });
        expect(JSON.stringify(unavailable)).not.toContain('again');
    });

    it.each(['revoke', 'delete'] as const)('pages independent chat past unavailable Doc roots and inherited replies after source %s', async change => {
        const { owner, reader, doc, request } = await fixture();
        await db.artifactAccountGrant.create({ data: { artifactId: doc.ref.artifactId,
            accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            ...request, participants: [{ kind: 'account', accountId: reader.id }],
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: text('Independent before') }, mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const root = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: request.firstMessage });
        if (!root.ok) throw new Error(root.error);
        const reply = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: {
            localId: randomUUID(), content: { t: 'plain', v: text('Private inherited passage context') }, mentionedAccountIds: [],
            replyTarget: { kind: 'message', messageId: root.value.message.id },
        } });
        if (!reply.ok) throw new Error(reply.error);
        const last = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: {
            localId: randomUUID(), content: { t: 'plain', v: text('Independent after') }, mentionedAccountIds: [],
        } });
        if (!last.ok) throw new Error(last.error);
        const read = { authentication, actorAccountId: reader.id, discussionId };
        expect(await readDiscussionMessages(read)).toMatchObject({ ok: true, value: { messages: [
            { seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 },
        ] } });
        if (change === 'revoke') await db.artifactAccountGrant.delete({ where: {
            artifactId_accountId: { artifactId: doc.ref.artifactId, accountId: reader.id },
        } });
        else await db.artifact.delete({ where: { id: doc.ref.artifactId } });
        const page = await readDiscussionMessages(read);
        expect(page).toMatchObject({ ok: true, value: { messages: [{ seq: 1 }, { seq: 4 }], hasMoreOlder: false, messageSeq: 4 } });
        if (!page.ok) throw new Error(page.error);
        expect(DiscussionMessagesResponseV1Schema.parse(page.value).messages.map(row => row.seq)).toEqual([1, 4]);
        expect(JSON.stringify(page)).not.toContain('again');
        expect(JSON.stringify(page)).not.toContain('Private inherited');
        expect(await readDiscussionMessages({ ...read, limit: 1 })).toMatchObject({ ok: true,
            value: { messages: [{ seq: 4 }], hasMoreOlder: true, messageSeq: 4 } });
        expect(await readDiscussionMessages({ ...read, beforeSeq: 4, limit: 1 })).toMatchObject({ ok: true,
            value: { messages: [{ seq: 1 }], hasMoreOlder: false, messageSeq: 4 } });
        expect(await readDiscussionMessages({ ...read, afterSeq: 1, limit: 1 })).toMatchObject({ ok: true,
            value: { messages: [{ seq: 4 }], messageSeq: 4 } });
        expect(await readDiscussionMessages({ ...read, throughSeq: 3, limit: 1 })).toMatchObject({ ok: true,
            value: { messages: [{ seq: 1 }], hasMoreOlder: false, messageSeq: 3 } });
        expect(await readDiscussionMessages({ ...read, afterSeq: 1, throughSeq: 3, limit: 1 })).toMatchObject({ ok: true,
            value: { messages: [], hasMoreOlder: false, messageSeq: 3 } });
        for (const messageId of [root.value.message.id, reply.value.message.id]) {
            expect(await inTx(tx => readDiscussionMessageInTx(tx, { ...read, messageId })))
                .toEqual({ ok: false, error: 'discussion_content_unavailable' });
        }
        expect(await inTx(tx => readDiscussionMessageInTx(tx, { ...read, messageId: last.value.message.id })))
            .toMatchObject({ ok: true, value: { id: last.value.message.id, content: { t: 'plain', v: text('Independent after') } } });
    });

    it('roundtrips E2EE root and proposal through the one codec and rejoins randomized ciphertext', async () => {
        const keys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const docKey = tweetnacl.randomBytes(32), discussionKey = tweetnacl.randomBytes(32);
        const sealKey = (dataKey: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({ dataKey,
            recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
        const createdDoc = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: encrypt(docKey, 'dataKey', { title: 'Source', kind: 'markdown' }),
            body: encrypt(docKey, 'dataKey', { body: 'again / again!' }), dataEncryptionKey: sealKey(docKey) });
        if (!createdDoc.ok) throw new Error(createdDoc.error);
        const doc = { ref: { kind: 'doc' as const, artifactId: createdDoc.artifact.id, serverId: 'test-home' },
            revision: { headerVersion: createdDoc.artifact.headerVersion, bodyVersion: createdDoc.artifact.bodyVersion } };
        const recipientKeys = tweetnacl.box.keyPair();
        const recipient = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(recipientKeys.publicKey) } });
        const envelope = (dataKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
            recipientPublicKey: recipientKeys.publicKey, randomBytes: tweetnacl.randomBytes }));
        const recipientFingerprint = computeContentPublicKeyFingerprint(recipientKeys.publicKey);
        await db.artifactAccountGrant.create({ data: { artifactId: doc.ref.artifactId, accountId: recipient.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.artifactKeyEnvelope.create({ data: { artifactId: doc.ref.artifactId, recipientAccountId: recipient.id,
            encryptedDataKey: envelope(docKey), recipientContentPublicKeyFingerprint: recipientFingerprint } });
        const passage = { ...doc, range: { start: 8, end: 13 }, quote: 'again', prefix: 'again / ', suffix: '!' };
        const content = DiscussionMessageContentV1StoredSchema.parse({ kind: 'doc_passage_comment', passage, content: text('Review') });
        const title = { v: 1 as const, title: 'Document comments' };
        const replyTarget = { kind: 'doc_passage' as const, doc };
        const localId = randomUUID(), creationLocalId = randomUUID();
        const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: discussionKey, encryptionVariant: 'dataKey' as const } };
        const tag = (canonicalIntent: string) => ({ kind: 'e2eeTag' as const,
            tag: deriveDiscussionMutationEqualityTagV1({ dataKey: discussionKey, canonicalIntent }) });
        const anchor = { kind: 'doc' as const, doc };
        const request = DiscussionCreateRequestV1Schema.parse({ creationLocalId, anchor,
            titleContent: sealSessionStoredContent({ ...crypto, payload: title }),
            dataEncryptionKey: privacyKit.encodeBase64(sealKey(discussionKey)),
            expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey),
            creationEqualityEvidenceV1: tag(serializeDiscussionMutationEqualityIntentV1({ kind: 'create', title, anchor,
                firstMessage: { localId, content, mentionedAccountIds: [], replyTarget } })),
            firstMessage: { localId, content: sealSessionStoredContent({ ...crypto, payload: content }), mentionedAccountIds: [], replyTarget,
                requestEqualityEvidenceV1: tag(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content, mentionedAccountIds: [], replyTarget })) } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await getDiscussion({ authentication, actorAccountId: owner.id, discussionId }))
            .toMatchObject({ ok: true, value: { discussion: { recipientKeyPreparationRequired: true } } });
        const scopedOwner = await listDiscussions({ authentication, actorAccountId: owner.id, anchorDocArtifactId: doc.ref.artifactId });
        expect(scopedOwner).toMatchObject({ ok: true, value: { discussions: [{ firstMessage: { id: created.value.firstMessage.id, seq: 1 } }] } });
        if (!scopedOwner.ok || !scopedOwner.value.discussions[0]?.firstMessage) throw new Error('Expected the admitted sealed root');
        expect(DiscussionMessageContentV1StoredSchema.parse(openSessionStoredContent({ ...crypto,
            content: scopedOwner.value.discussions[0].firstMessage.content }))).toEqual(content);
        const scopedRecipient = { authentication, actorAccountId: recipient.id, anchorDocArtifactId: doc.ref.artifactId };
        const locked = await listDiscussions(scopedRecipient);
        expect(locked).toMatchObject({ ok: true, value: { discussions: [{ keyReadiness: false, firstMessage: null }] } });
        expect(JSON.stringify(locked)).not.toContain(request.firstMessage.content.t === 'encrypted' ? request.firstMessage.content.c : 'again');
        await db.discussionKeyEnvelope.create({ data: { discussionId, recipientAccountId: recipient.id,
            encryptedDataKey: envelope(discussionKey), recipientContentPublicKeyFingerprint: recipientFingerprint } });
        expect(await listDiscussions(scopedRecipient)).toMatchObject({ ok: true,
            value: { discussions: [{ keyReadiness: true, firstMessage: { id: created.value.firstMessage.id, seq: 1 } }] } });
        const reopened = await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId });
        if (!reopened.ok) throw new Error(reopened.error);
        expect(DiscussionMessageContentV1StoredSchema.parse(openSessionStoredContent({ ...crypto, content: reopened.value.messages[0]!.content }))).toEqual(content);
        const candidate = DiscussionMessageContentV1StoredSchema.parse({ kind: 'doc_edit_proposal', proposal: {
            target: passage, baseRevision: doc.revision, before: 'again', after: 'once more', reason: 'Clarify',
        } });
        const parent = { kind: 'message' as const, messageId: created.value.firstMessage.id };
        const proposalRequest = DiscussionPostRequestV1Schema.parse({ localId: randomUUID(), mentionedAccountIds: [], replyTarget: parent, docEditProposal: true,
            content: sealSessionStoredContent({ ...crypto, payload: candidate }),
            requestEqualityEvidenceV1: tag(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content: candidate, mentionedAccountIds: [], replyTarget: parent })) });
        const first = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: proposalRequest });
        if (!first.ok) throw new Error(first.error);
        expect(first.value.message.docEditProposalDispositionV1).toEqual({ state: 'open' });
        const retry = { ...proposalRequest, content: sealSessionStoredContent({ ...crypto, payload: candidate }) };
        expect(retry.content).not.toEqual(proposalRequest.content);
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: retry }))
            .toMatchObject({ ok: true, value: { message: { id: first.value.message.id } } });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...retry, docEditProposal: undefined } }))
            .toMatchObject({ ok: false, error: 'discussion_idempotency_conflict' });
        const stored = await db.discussionMessage.findMany({ where: { discussionId }, orderBy: { seq: 'asc' } });
        expect(stored).toHaveLength(2);
        expect(JSON.stringify(stored)).not.toContain('again');
        expect(DiscussionMessageContentV1StoredSchema.parse(openSessionStoredContent({ ...crypto, content: stored[1]!.content }))).toEqual(candidate);
        await setDiscussionReadCursor({ authentication, actorAccountId: owner.id, discussionId, lastReadSeq: 2 });
        const attention = await readDiscussionAttention({ authentication, actorAccountId: owner.id });
        expect(attention).toMatchObject({ ok: true, value: { discussions: [{ discussion: { lastReadSeq: 2 },
            occurrences: [{ type: 'decision', message: { id: first.value.message.id, content: stored[1]!.content } }] }] } });
        expect(JSON.stringify(attention)).not.toContain('again');
        const summary = await getDiscussion({ authentication, actorAccountId: owner.id, discussionId });
        expect(summary).toMatchObject({ ok: true, value: { discussion: { latestMessage: { content: stored[1]!.content } } } });
        await db.artifact.delete({ where: { id: doc.ref.artifactId } });
        expect(await readDiscussionAttention({ authentication, actorAccountId: owner.id }))
            .toMatchObject({ ok: true, value: { discussions: [], incomplete: true } });
        const unavailableRead = await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId });
        expect(unavailableRead).toMatchObject({ ok: true, value: { messages: [], hasMoreOlder: false } });
        expect(JSON.stringify(unavailableRead)).not.toContain(proposalRequest.content.t === 'encrypted' ? proposalRequest.content.c : 'again');
        const unavailableGet = await getDiscussion({ authentication, actorAccountId: owner.id, discussionId });
        const unavailableList = await listDiscussions({ authentication, actorAccountId: owner.id });
        expect(unavailableGet).toMatchObject({ ok: true });
        expect(unavailableList).toMatchObject({ ok: true });
        if (!unavailableGet.ok || !unavailableList.ok) throw new Error('Discussion metadata must remain readable');
        expect(unavailableGet.value.discussion.latestMessage.content).toBeUndefined();
        expect(unavailableList.value.discussions.find(row => row.id === discussionId)?.latestMessage.content).toBeUndefined();
        expect(JSON.stringify([unavailableGet, unavailableList])).not.toContain(proposalRequest.content.t === 'encrypted' ? proposalRequest.content.c : 'again');
        const changedMetadataRetry = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...retry, replyTarget: undefined } });
        expect(changedMetadataRetry).toMatchObject({ ok: false });
        expect(JSON.stringify(changedMetadataRetry)).not.toContain(stored[1]!.id);
    });
});
