import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { mayInjectResourceContextInTx } from '@/app/session/access/sessionContextInjection';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { createDiscussion, postDiscussionMessage } from './mutations';
import { inviteDiscussionParticipant, setDiscussionGrant } from './accessService';
import { readDiscussionMessages, listDiscussions, readDiscussionMessageInTx } from './queries';
import { previewDiscussionSecondOpinion } from './secondOpinion';
import { DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, DiscussionSecondOpinionPreviewResponseV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { DiscussionCreateInputV1Schema, DiscussionPostInputV1Schema, DiscussionInviteInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionSecondOpinionStartInputV1Schema } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { projectDiscussionSecondOpinionPreviewInputV1 } from '@happier-dev/protocol/actions/executor/discussionSecondOpinion';
import { resolveDiscussionSecondOpinionSourceGrantsV1 } from '@happier-dev/protocol/discussions/secondOpinion';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';
import { DiscussionInitialParticipantsV1Schema, DiscussionInviteRequestV1Schema } from '@happier-dev/protocol/discussions/participants';
import { SessionAccessGrantSetActionInputV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import { readCommittedSessionMessageInTx } from '@/app/session/messages/readCommittedSessionMessage';
import { putSessionAccessGrantInTx } from '@/app/session/access/sessionAccessGrantService';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { packSessionDataKeyBundleV0, readSessionDataKeyBundleV0, serializeSessionDataKeyValue, parseSessionDataKeyValue } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createSecondOpinionSourceFixture, discussionSecondOpinionSecurityContracts } from './secondOpinionSecurity.testkit';

const authentication = createPresentUserSessionAccessAuthentication();
const document = (text: string) => ({ v: 1 as const, parts: [{ t: 'text' as const, text }] });

describe('Second opinion source admission (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-second-opinion-', initAuth: false, initEncrypt: true,
        env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1' } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    const fixture = createSecondOpinionSourceFixture;
    async function encryptedSourceFixture() {
        const fixtureValue = await fixture();
        const binding = createSignedAccountContentBinding();
        await db.account.update({ where: { id: fixtureValue.owner.id }, data: { encryptionMode: 'e2ee',
            publicKey: binding.publicKey, contentPublicKey: Buffer.from(binding.contentPublicKey),
            contentPublicKeySig: Buffer.from(binding.contentPublicKeySig) } });
        await db.session.update({ where: { id: fixtureValue.source.id }, data: { encryptionMode: 'e2ee' } });
        return fixtureValue;
    }
    it('refuses a quoted source before creating a Discussion for a broader audience', async () => {
        const { owner, request } = await fixture();
        expect(await createDiscussion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: false, error: 'discussion_access_forbidden' });
        expect(await db.discussion.count({ where: { creationLocalId: request.creationLocalId } })).toBe(0);
    });
    discussionSecondOpinionSecurityContracts();
    it.each(['friend', 'shared_team'] as const)('admits the confirmed person grant through its real subject owner (%s)', async relationship => {
        const { owner, reader, source, answer } = await fixture();
        if (relationship === 'shared_team') {
            // The fixture's friend row would admit the person; this case proves the Team co-member route alone.
            await db.userRelationship.deleteMany({ where: { fromUserId: owner.id, toUserId: reader.id } });
            const team = await db.team.create({ data: { name: 'Second-opinion colleagues' } });
            await db.teamMembership.createMany({ data: [owner.id, reader.id].map(accountId => ({
                teamId: team.id, accountId, role: 'member', status: 'active',
            })) });
        }
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const actor = { actorAccountId: owner.id, authentication };
        const fail = (error: string) => ({ ok: false as const, errorCode: error, error });
        // These ports stand in for HTTP only. Every access decision and persistent effect below is real.
        const deps: Pick<ActionExecutorDeps, 'discussionAction' | 'sessionTranscriptGet' | 'sessionAccessAction'> = {
            discussionAction: async ({ actionId, input }) => {
                if (actionId === 'discussion.second_opinion.start') return previewDiscussionSecondOpinion({ ...actor,
                    request: projectDiscussionSecondOpinionPreviewInputV1(DiscussionSecondOpinionStartInputV1Schema.parse(input)) });
                if (actionId === 'discussion.create') {
                    const value = DiscussionCreateInputV1Schema.parse(input);
                    if (!value.creationLocalId || !value.firstMessage.localId) throw new Error('Expected explicit create/quote retry identities');
                    const result = await createDiscussion({ ...actor, request: buildDiscussionMutationRequestBodyV1({ kind: 'create',
                        creationLocalId: value.creationLocalId, anchor: value.anchor,
                        participants: value.participants ? DiscussionInitialParticipantsV1Schema.parse(value.participants) : undefined,
                        titleContent: { t: 'plain', v: { v: 1, title: value.title } }, firstMessage: {
                            localId: value.firstMessage.localId, replyTarget: value.firstMessage.replyTarget,
                            content: { t: 'plain', v: value.firstMessage.content },
                            authoredContent: value.firstMessage.content, ...readDiscussionMentionedParticipantIdsV1(value.firstMessage.content),
                        } }) });
                    if (!result.ok) return fail(result.error);
                    const { titleContent: _title, firstMessage: _summaryFirst, latestMessage, ...discussion } = result.value.discussion;
                    const { content: latestContent, ...latest } = latestMessage;
                    const { content, ...message } = result.value.firstMessage;
                    if (content.t !== 'plain') throw new Error('Expected the plain transport fixture');
                    return { v: 1, serverId: 'home', discussion: { ...discussion, title: value.title,
                        latestMessage: { ...latest, ...(latestContent?.t === 'plain' ? { content: latestContent.v } : {}) } }, firstMessage: {
                        ...message, content: content.v, messageRef: createDiscussionMessageRefV1({ serverId: 'home', discussionId: discussion.id }, result.value.firstMessage),
                    } };
                }
                if (actionId === 'discussion.invite') {
                    const { discussionId, ...request } = DiscussionInviteInputV1Schema.parse(input);
                    const result = await inviteDiscussionParticipant({ ...actor, discussionId, request: DiscussionInviteRequestV1Schema.parse(request) });
                    return result.ok ? result.value : fail(result.error);
                }
                if (actionId === 'discussion.post') {
                    const { discussionId, ...value } = DiscussionPostInputV1Schema.parse(input);
                    if (!value.localId) throw new Error('Expected explicit question retry identity');
                    const result = await postDiscussionMessage({ ...actor, discussionId,
                        request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: value.localId, replyTarget: value.replyTarget,
                            content: { t: 'plain', v: value.content }, authoredContent: value.content,
                            ...readDiscussionMentionedParticipantIdsV1(value.content) }) });
                    if (!result.ok) return fail(result.error);
                    const { content, ...message } = result.value.message;
                    if (content.t !== 'plain') throw new Error('Expected the plain transport fixture');
                    return { v: 1, serverId: 'home', messageSeq: result.value.messageSeq, message: {
                        ...message, content: content.v, messageRef: createDiscussionMessageRefV1({ serverId: 'home', discussionId }, result.value.message),
                    } };
                }
                throw new Error(`Unexpected Discussion transport: ${actionId}`);
            },
            sessionTranscriptGet: async () => {
                const result = await inTx(tx => readCommittedSessionMessageInTx(tx, { accountId: owner.id, authentication,
                    sessionId: source.id, messageId: answer.id }));
                if (!result.row) throw new Error('Expected source read admission');
                expect(result.row.content).toEqual({ t: 'plain', v: { text: 'Private answer' } });
                return { ok: true, sessionId: source.id, items: [{ id: result.row.id, semanticRole: 'assistant', role: 'assistant',
                    kind: 'message', createdAt: 1, text: 'Private answer' }], hasMore: false, nextCursor: null,
                    diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } };
            },
            sessionAccessAction: async ({ input }) => {
                const value = SessionAccessGrantSetActionInputV1Schema.parse(input);
                const result = await inTx(tx => putSessionAccessGrantInTx(tx, { ...actor, sessionId: value.sessionId,
                    subject: value.subject, grant: { accessLevel: value.accessLevel, canApprovePermissions: value.canApprovePermissions } }));
                return result.ok ? { changed: result.changed, grant: { subject: result.subject, ...result.value } } : fail(result.error);
            },
        };
        // Only the three HTTP ports this composed Action consumes are installed; unrelated host families are unreachable.
        const executor = createActionExecutor(deps as ActionExecutorDeps);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home',
            actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
                'discussion.second_opinion.start': ['ui'], 'discussion.create': ['ui'], 'discussion.invite': ['ui'],
                'discussion.post': ['ui'], 'session.access.grant.set': ['ui'], 'session.transcript.get': ['ui'],
            } }) };
        const request = { intent: 'preview', title: 'Review this answer', question: 'What would you change?',
            source: { kind: 'session', message: { kind: 'session', session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } },
            participants: [{ kind: 'account', accountId: reader.id }],
            reviewers: [{ selection: { kind: 'session', session: { serverId: 'home', sessionId: reviewer.id } } }],
            retry: { creationLocalId: crypto.randomUUID(), quoteLocalId: crypto.randomUUID(), questionLocalId: crypto.randomUUID() } };
        const preview = await executor.execute('discussion.second_opinion.start', request, context);
        expect(preview).toMatchObject({ ok: true, result: { status: 'preview', preview: {
            canGrantSource: true, missingDiscussionSourceAccountIds: [reader.id],
            reviewers: [{ canGrantSource: true, missingSourceAccountIds: [reader.id] }],
        } } });
        if (!preview.ok || !preview.result || typeof preview.result !== 'object' || !('preview' in preview.result)) throw new Error('Expected preview');
        const admittedPreview = DiscussionSecondOpinionPreviewResponseV1Schema.parse({ ok: true, value: preview.result.preview });
        if (!admittedPreview.ok) throw new Error('Expected admitted preview facts');
        expect(resolveDiscussionSecondOpinionSourceGrantsV1(admittedPreview.value)).toEqual({ ok: true, accountIds: [reader.id] });
        expect(await db.sessionShare.count({ where: { sessionId: source.id } })).toBe(0);
        expect(await inTx(tx => readCommittedSessionMessageInTx(tx, { accountId: reader.id, authentication,
            sessionId: source.id, messageId: answer.id }))).toMatchObject({ row: null });
        const ask = { ...request, intent: 'ask', confirmedPreview: preview.result.preview };
        if (relationship === 'friend') {
            // Losing eligibility after confirmation must not spend a stale promise or leave Ask pending.
            await db.userRelationship.deleteMany({ where: { fromUserId: owner.id, toUserId: reader.id, status: 'friend' } });
            expect(await executor.execute('discussion.second_opinion.start', ask, context))
                .toMatchObject({ ok: true, result: { status: 'pending', stage: 'grant', errorCode: 'discussion_subject_ineligible', grantedAccountIds: [] } });
            expect(await db.sessionShare.count({ where: { sessionId: source.id } })).toBe(0);
            expect(await db.discussion.count({ where: { creationLocalId: request.retry.creationLocalId } })).toBe(0);
            await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: reader.id, status: 'friend' } });
        }
        const asked = await executor.execute('discussion.second_opinion.start', ask, context);
        expect(asked, JSON.stringify(asked))
            .toMatchObject({ ok: true, result: { status: 'asked', grantedAccountIds: [reader.id] } });
        expect(await inTx(tx => readCommittedSessionMessageInTx(tx, { accountId: reader.id, authentication,
            sessionId: source.id, messageId: answer.id }))).toMatchObject({ row: { id: answer.id, content: { t: 'plain', v: { text: 'Private answer' } } } });
        expect(await executor.execute('discussion.second_opinion.start', ask, context)).toMatchObject({ ok: true, result: { status: 'asked' } });
        expect(await db.sessionShare.count({ where: { sessionId: source.id, sharedWithUserId: reader.id } })).toBe(1);
        expect(await db.discussionMessage.count({ where: { discussion: { creationLocalId: request.retry.creationLocalId } } })).toBe(2);
    });
    it('opens the E2EE source as the previewed person only after the explicit canonical grant stores their sealed key', async () => {
        const { owner, reader, source, answer } = await encryptedSourceFixture();
        const recipientKeys = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: reader.id }, data: { encryptionMode: 'e2ee',
            ...createSignedAccountContentBinding(recipientKeys.publicKey) } });
        const key = randomBytes(32), nonce = randomBytes(12);
        // Cipher calls are the platform boundary; framing and JSON use the actual Protocol producers/readers.
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        const ciphertext = Buffer.concat([cipher.update(serializeSessionDataKeyValue({ text: 'Private encrypted answer' }), 'utf8'), cipher.final()]);
        await db.sessionMessage.update({ where: { id: answer.id }, data: { content: { t: 'encrypted', c: encodeBase64(
            new Uint8Array(packSessionDataKeyBundleV0({ nonce, ciphertext, authTag: cipher.getAuthTag() }))) } } });
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const request = { source: { kind: 'session' as const, message: { kind: 'session' as const,
            session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } },
            participants: [{ kind: 'account' as const, accountId: reader.id }], reviewers: [{ selection: { kind: 'session' as const,
                session: { serverId: 'home', sessionId: reviewer.id } } }] };
        const preview = await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request });
        expect(preview).toMatchObject({ ok: true, value: { sourceContentReady: true, canGrantSource: true,
            missingDiscussionSourceAccountIds: [reader.id] } });
        if (!preview.ok) throw new Error(preview.error);
        expect(resolveDiscussionSecondOpinionSourceGrantsV1(preview.value)).toEqual({ ok: true, accountIds: [reader.id] });
        expect(await db.sessionShare.count({ where: { sessionId: source.id } })).toBe(0);
        expect(await inTx(tx => readCommittedSessionMessageInTx(tx, { accountId: reader.id, authentication,
            sessionId: source.id, messageId: answer.id }))).toMatchObject({ row: null });
        const grant = await inTx(tx => putSessionAccessGrantInTx(tx, { actorAccountId: owner.id, authentication,
            sessionId: source.id, subject: { kind: 'account', accountId: reader.id },
            grant: { accessLevel: 'view', canApprovePermissions: false }, accountEnvelopeInput: { v: 1,
                encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
                    recipientPublicKey: recipientKeys.publicKey, randomBytes: tweetnacl.randomBytes })) } }));
        expect(grant).toMatchObject({ ok: true, changed: true });
        const read = await inTx(tx => readCommittedSessionMessageInTx(tx, { accountId: reader.id, authentication,
            sessionId: source.id, messageId: answer.id }));
        expect(read).toMatchObject({ row: { id: answer.id } });
        const stored = SessionStoredMessageContentSchema.parse(read.row?.content);
        if (stored.t !== 'encrypted') throw new Error('Expected encrypted source');
        const envelope = await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: {
            sessionId_recipientAccountId: { sessionId: source.id, recipientAccountId: reader.id } } });
        const openedKey = openEncryptedDataKeyEnvelopeV1({ envelope: new Uint8Array(envelope.encryptedDataKey),
            recipientSecretKeyOrSeed: recipientKeys.secretKey });
        expect(openedKey).toEqual(new Uint8Array(key));
        if (!openedKey) throw new Error('Expected recipient source key');
        const bundle = readSessionDataKeyBundleV0(decodeBase64(stored.c));
        if (bundle.status !== 'ready') throw new Error('Expected canonical encrypted bundle');
        const decipher = createDecipheriv('aes-256-gcm', openedKey, bundle.nonce);
        decipher.setAuthTag(bundle.authTag);
        expect(parseSessionDataKeyValue(Buffer.concat([decipher.update(bundle.ciphertext), decipher.final()]).toString('utf8')))
            .toEqual({ status: 'authenticated', value: { text: 'Private encrypted answer' } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { missingDiscussionSourceAccountIds: [], discussionDisclosure: { ok: true } } });
    });

    it('reports an ungrantable source gap for a real source reader without access-management authority', async () => {
        const { owner, reader, source, answer } = await fixture();
        const person = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: reader.id, toUserId: person.id, status: 'friend' } });
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id,
            sharedWithUserId: reader.id, accessLevel: 'view' } });
        const reviewer = await db.session.create({ data: { accountId: reader.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const preview = await previewDiscussionSecondOpinion({ authentication, actorAccountId: reader.id, request: {
            source: { kind: 'session', message: { kind: 'session', session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } },
            participants: [{ kind: 'account', accountId: person.id }],
            reviewers: [{ selection: { kind: 'session', session: { serverId: 'home', sessionId: reviewer.id } } }],
        } });
        expect(preview).toMatchObject({ ok: true, value: { sourceContentReady: true, canGrantSource: false,
            missingDiscussionSourceAccountIds: [person.id] } });
        if (!preview.ok) throw new Error(preview.error);
        expect(resolveDiscussionSecondOpinionSourceGrantsV1(preview.value)).toEqual({ ok: false, errorCode: 'discussion_access_forbidden' });
        expect(await db.sessionShare.count({ where: { sessionId: source.id, sharedWithUserId: person.id } })).toBe(0);
    });

    it('does not promise a repairable source grant when the reviewer has a public audience', async () => {
        const { owner, reader, source, answer } = await fixture();
        // Keep subject eligibility admitted so only the public audience distinguishes this refusal.
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.publicSessionShare.create({ data: { sessionId: reviewer.id, tokenHash: randomBytes(32), createdByUserId: owner.id } });
        const preview = await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request: {
            source: { kind: 'session', message: { kind: 'session', session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } },
            participants: [{ kind: 'account', accountId: reader.id }],
            reviewers: [{ selection: { kind: 'session', session: { serverId: 'home', sessionId: reviewer.id } } }],
        } });
        if (!preview.ok) throw new Error(preview.error);
        expect(resolveDiscussionSecondOpinionSourceGrantsV1(preview.value)).toEqual({ ok: false, errorCode: 'discussion_access_forbidden' });
        expect(preview.value.reviewers[0]?.disclosure).toEqual({ ok: false, reason: 'destination_public' });
        expect(await db.sessionShare.count({ where: { sessionId: source.id } })).toBe(0);
    });

    it('previews the actual reviewer audience even for quote-only without grants, content or allocation', async () => {
        const { owner, reader, source, answer } = await fixture();
        // The reviewer audience must stay a person the owner cannot newly share the source with.
        await db.userRelationship.deleteMany({ where: { fromUserId: owner.id, toUserId: reader.id } });
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionShare.create({ data: { sessionId: reviewer.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const sourceRef = { kind: 'session' as const, message: { kind: 'session' as const,
            session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } };
        const request = { source: sourceRef, publisherSessionId: reviewer.id, reviewers: [{ selection: { kind: 'session' as const,
            session: { serverId: 'home', sessionId: reviewer.id } }, sourceAccess: 'quote_only' as const }] };
        const counts = await Promise.all([db.session.count(), db.discussion.count(), db.sessionShare.count()]);
        const preview = await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request });
        expect(DiscussionSecondOpinionPreviewResponseV1Schema.safeParse(preview).success).toBe(true);
        expect(preview).toMatchObject({ ok: true, value: { sourceContentReady: true,
            canGrantSource: true, missingDiscussionSourceAccountIds: [],
            publisher: { sessionId: reviewer.id, answerPolicy: 'when_addressed', audienceAccountIds: expect.arrayContaining([owner.id, reader.id]),
                disclosure: { ok: false, reason: 'destination_audience_broader' } }, reviewers: [{ runtimeAccountId: owner.id,
            missingSourceAccountIds: [reader.id], canGrantSource: false, sourceAccess: 'quote_only',
            disclosure: { ok: false, reason: 'destination_audience_broader' } }] } });
        expect(JSON.stringify(preview)).not.toContain('Private answer');
        expect(await Promise.all([db.session.count(), db.discussion.count(), db.sessionShare.count()])).toEqual(counts);
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { publisher: { sessionId: reviewer.id, disclosure: { ok: true } },
                reviewers: [{ missingSourceAccountIds: [], canGrantSource: true, disclosure: { ok: true } }] } });
        const uncontrolled = await db.session.create({ data: { accountId: reader.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id,
            request: { ...request, publisherSessionId: uncontrolled.id } }))
            .toEqual({ ok: false, error: 'discussion_subject_ineligible' });
        // A valid ciphertext envelope without the current recipient key stays locked.
        await db.session.update({ where: { id: source.id }, data: { encryptionMode: 'e2ee' } });
        await db.sessionMessage.update({ where: { id: answer.id }, data: { content: { t: 'encrypted', c: 'ciphertext' } } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { sourceContentReady: false } });
    });
    it('lets a source-reading Discussion editor ask an invited reviewer without acquiring control of its Session', async () => {
        const { owner, reader, source, request } = await fixture();
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: reviewer.id } } })).toMatchObject({ ok: true });
        expect(await inTx(tx => mayInjectResourceContextInTx(tx, { configuringAccountId: reader.id, authentication,
            source: { kind: 'session', sessionId: source.id }, destination: { kind: 'session', sessionId: reviewer.id } })))
            .toEqual({ ok: false, reason: 'configurer_not_allowed' });
        const content = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: reviewer.id } },
            { t: 'text' as const, text: 'Please review the source' }] };
        expect(await postDiscussionMessage({ authentication, actorAccountId: reader.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(), content: { t: 'plain', v: content },
                authoredContent: content, mentionedAccountIds: [], mentionedSessionIds: [reviewer.id] }) }))
            .toMatchObject({ ok: true, value: { message: { authorAccountId: reader.id, seq: 2 } } });
    });
    it('lets an E2EE owner attempt the historical absent-envelope source read without granting that fallback to recipients', async () => {
        const { owner, reader, source, answer } = await encryptedSourceFixture();
        // Preview inspects only the opaque envelope; the key-holding transcript reader must still open it.
        await db.sessionMessage.update({ where: { id: answer.id }, data: { content: { t: 'encrypted', c: 'opaque-ciphertext' } } });
        const request = { source: { kind: 'session' as const, message: { kind: 'session' as const,
            session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } }, reviewers: [] };
        expect(await db.sessionDataKeyEnvelope.count({ where: { sessionId: source.id } })).toBe(0);
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { sourceContentReady: true } });
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id,
            sharedWithUserId: reader.id, accessLevel: 'view' } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: reader.id, request }))
            .toMatchObject({ ok: true, value: { sourceContentReady: false } });
        await db.sessionDataKeyEnvelope.create({ data: { sessionId: source.id, recipientAccountId: owner.id,
            encryptedDataKey: Buffer.from([1, 2, 3]) } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { sourceContentReady: false } });
        await db.sessionDataKeyEnvelope.deleteMany({ where: { sessionId: source.id } });
        await db.account.update({ where: { id: owner.id }, data: { contentPublicKeySig: Buffer.from([1, 2, 3]) } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { sourceContentReady: false } });
    });
    it('uses the canonical stored Session envelope reader without reinterpreting a source mode mismatch', async () => {
        const { owner, source, answer } = await encryptedSourceFixture();
        const request = { source: { kind: 'session' as const, message: { kind: 'session' as const,
            session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } }, reviewers: [] };
        for (const content of ['opaque-ciphertext', { ciphertext: 'opaque-ciphertext' },
            { t: 'encrypted', c: 'opaque-ciphertext', futureField: true }]) {
            // Historical stored JSON is written at the database boundary, outside today's strict write type.
            await db.$executeRaw`UPDATE "SessionMessage" SET "content" = ${JSON.stringify(content)} WHERE "id" = ${answer.id}`;
            expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
                .toMatchObject({ ok: true, value: { sourceContentReady: true } });
        }
        await db.sessionMessage.update({ where: { id: answer.id }, data: { content: { t: 'plain', v: { text: 'wrong mode' } } } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { sourceContentReady: false } });
    });
    it.each([false, true])('addresses only selected reviewers for an Agent question about its own quote (explicit self mention: %s)', async explicitSelfMention => {
        const { owner, reader, source, request } = await fixture();
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const producer = { v: 1 as const, kind: 'agent' as const, sessionId: source.id };
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request, producer });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        for (const sessionId of [source.id, reviewer.id]) expect(await inviteDiscussionParticipant({ authentication,
            actorAccountId: owner.id, discussionId, request: { participant: { kind: 'session', sessionId }, answerPolicy: 'when_addressed' } }))
            .toMatchObject({ ok: true });
        const mentionedSessionIds = [reviewer.id, ...(explicitSelfMention ? [source.id] : [])].sort();
        const content = { v: 1 as const, parts: [...mentionedSessionIds.map(sessionId => ({ t: 'mention' as const,
            participant: { kind: 'session' as const, sessionId } })), { t: 'text' as const, text: 'Please review my answer' }] };
        const posted = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, producer,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(), content: { t: 'plain', v: content },
                authoredContent: content, mentionedAccountIds: [], mentionedSessionIds,
                replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } }) });
        expect(posted).toMatchObject({ ok: true, value: { message: { seq: 2,
            addressingV1: { participantSessionIds: mentionedSessionIds, throughSeq: 2 } } } });
    });
    it.each([false, true])('refuses a reviewer share added after admission (new reader has source access: %s)', async sourceAccess => {
        const { owner, reader, source, answer, request } = await fixture();
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: reviewer.id } } })).toMatchObject({ ok: true });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        if (sourceAccess) await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id,
            sharedWithUserId: outsider.id, accessLevel: 'view' } });
        const preview = await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request: {
            source: { kind: 'session', message: { kind: 'session', session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } },
            participants: [{ kind: 'account', accountId: reader.id }],
            reviewers: [{ selection: { kind: 'session', session: { serverId: 'home', sessionId: reviewer.id } }, sourceAccess: 'read' }],
        } });
        expect(preview).toMatchObject({ ok: true, value: { discussionDisclosure: { ok: true },
            missingDiscussionSourceAccountIds: [], reviewers: [{ disclosure: { ok: true }, missingSourceAccountIds: [] }] } });
        // The post must re-admit the actual Session audience, not rely on this successful preview or invite.
        await db.sessionShare.create({ data: { sessionId: reviewer.id, sharedByUserId: owner.id,
            sharedWithUserId: outsider.id, accessLevel: 'view' } });
        const content = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: reviewer.id } },
            { t: 'text' as const, text: 'Check this answer' }] };
        const post = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
            content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [], mentionedSessionIds: [reviewer.id],
            replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: post }))
            .toEqual({ ok: false, error: 'discussion_access_forbidden' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
        expect(await db.discussion.findUnique({ where: { id: discussionId }, select: { messageSeq: true } })).toEqual({ messageSeq: 1 });
        expect(await readDiscussionMessages({ authentication, actorAccountId: outsider.id, discussionId }))
            .toMatchObject({ ok: false });
    });
    it('rechecks source disclosure on invite and addressed post, withholding the deleted source quote while retaining independent chat', async () => {
        const { owner, reader, source, request } = await fixture();
        const share = await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: reviewer.id } } })).toMatchObject({ ok: true });
        await db.sessionShare.delete({ where: { id: share.id } });
        const content = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: reviewer.id } },
            { t: 'text' as const, text: 'Check this answer' }] };
        const post = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
            content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [], mentionedSessionIds: [reviewer.id] });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: post }))
            .toMatchObject({ ok: false, error: 'discussion_access_forbidden' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'account', accountId: outsider.id } } })).toMatchObject({ ok: false });
        expect(await db.discussionAccountGrant.count({ where: { discussionId, accountId: outsider.id } })).toBe(0);
        expect(await deleteOwnedSession({ sessionId: source.id, ownerAccountId: owner.id, reason: 'user_request' }))
            .toEqual({ ok: true });
        expect(await readDiscussionMessages({ authentication, actorAccountId: reader.id, discussionId }))
            .toMatchObject({ ok: true, value: { messages: [] } });
        const ordinary = document('The source is now unavailable');
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
                content: { t: 'plain', v: ordinary }, authoredContent: ordinary, mentionedAccountIds: [] }) })).toMatchObject({ ok: true });
        expect(await readDiscussionMessages({ authentication, actorAccountId: reader.id, discussionId }))
            .toMatchObject({ ok: true, value: { messages: [{ seq: 2, content: { t: 'plain', v: ordinary } }] } });
    });
    it.each(['session', 'message'] as const)('invites into the retained Discussion after its source %s is deleted without granting source access', async deleted => {
        const { owner, reader, source, answer, request } = await fixture();
        const share = await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionShare.create({ data: { sessionId: reviewer.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const invite = () => inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: reviewer.id } } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, outsider.id);
        const grant = () => inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'account', accountId: outsider.id } } });
        // A live private source still requires explicit access for the new audience.
        await db.sessionShare.delete({ where: { id: share.id } });
        expect(await invite()).toEqual({ ok: false, error: 'discussion_access_forbidden' });
        expect(await grant()).toEqual({ ok: false, error: 'discussion_access_forbidden' });
        expect(await setDiscussionGrant({ authentication, actorAccountId: owner.id, discussionId,
            request: { principal: { kind: 'account', accountId: reader.id }, accessLevel: 'admin' } })).toMatchObject({ ok: true });
        const readerReviewer = await db.session.create({ data: { accountId: reader.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        // The source still exists: loss of the configuring actor's transcript access is not deletion.
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: reader.id, discussionId,
            request: { participant: { kind: 'session', sessionId: readerReviewer.id } } }))
            .toEqual({ ok: false, error: 'discussion_content_unavailable' });
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(0);
        expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: discussionId } })).toBe(0);
        await db.session.update({ where: { id: source.id }, data: { encryptionMode: 'e2ee' } });
        expect(await invite()).toEqual({ ok: false, error: 'discussion_content_unavailable' });
        await db.session.update({ where: { id: source.id }, data: { encryptionMode: 'plain' } });
        if (deleted === 'session') expect(await deleteOwnedSession({ sessionId: source.id, ownerAccountId: owner.id, reason: 'user_request' })).toEqual({ ok: true });
        else await db.sessionMessage.delete({ where: { id: answer.id } });
        const admitted = await invite();
        expect(admitted).toMatchObject({ ok: true, value: { changed: true } });
        expect(JSON.stringify(admitted)).not.toContain('Private answer');
        expect(await invite()).toMatchObject({ ok: true, value: { changed: false } });
        expect(await grant()).toMatchObject({ ok: true });
        expect(await db.discussionParticipant.count({ where: { discussionId, sessionId: reviewer.id } })).toBe(1);
        expect(await db.sessionFollowEdge.findFirst({ where: { sourceDiscussionId: discussionId, destinationSessionId: reviewer.id } }))
            .toMatchObject({ sourceSessionId: null, deliveredTranscriptSeq: 1 });
        expect(await db.sessionShare.count({ where: { sessionId: source.id } })).toBe(0);
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
        expect(await createDiscussion({ authentication, actorAccountId: owner.id, request }))
            .toEqual({ ok: false, error: 'discussion_content_unavailable' });
        expect(await createDiscussion({ authentication, actorAccountId: owner.id, request: { ...request, creationLocalId: crypto.randomUUID() } }))
            .toEqual({ ok: false, error: 'discussion_content_unavailable' });
        expect(await db.discussion.count({ where: { ownerAccountId: owner.id } })).toBe(1);
    });
    it('exposes the closed read-only preview route and previews a model without creating its Session', async () => {
        const { owner, source, answer } = await fixture();
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Authentication is the system boundary. Route parsing and all access/key/disclosure owners remain real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            request.userId = owner.id;
            request.authAuthority = 'present_user';
            request.authTokenKind = 'account';
        });
        registerDiscussionRoutes(app);
        const payload = { source: { kind: 'session', message: { kind: 'session', session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } },
            publisherSessionId: source.id,
            reviewers: [{ selection: { kind: 'model', launch: {
                executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/work' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            } }, participantSlotId: 'slot' }] };
        const before = await db.session.count();
        try {
            const response = await app.inject({ method: 'POST', url: DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, payload });
            expect(response.statusCode).toBe(200);
            expect(DiscussionSecondOpinionPreviewResponseV1Schema.parse(response.json())).toMatchObject({ ok: true, value: {
                sourceContentReady: true, discussionAudienceAccountIds: [owner.id], missingDiscussionSourceAccountIds: [],
                publisher: { sessionId: source.id, answerPolicy: 'when_addressed', audienceAccountIds: [owner.id], disclosure: { ok: true } },
                reviewers: [{ runtimeAccountId: null, sourceAccess: 'read', audienceAccountIds: [owner.id], disclosure: { ok: true } }],
            } });
            expect(await db.session.count()).toBe(before);
            expect((await app.inject({ method: 'POST', url: DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1,
                payload: { ...payload, quote: 'Unauthorized preview text' } })).statusCode).toBe(400);
        } finally { await app.close(); }
    });
});
