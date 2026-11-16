import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { DiscussionReplyInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { buildDiscussionMutationRequestBodyV1, DiscussionMessagesResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { deriveSessionMessageReplyReturnLocalIdV1, SessionMessageReplyAccountMutationV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionInputReplyProgressInTx, mutateSessionMessageReplyForAccountInTx } from '@/app/session/messages/sessionMessageReply';
import { createDiscussion, postDiscussionMessage } from './mutations';
import { inviteDiscussionParticipant, listDiscussionParticipants, setDiscussionParticipantPolicy } from './accessService';
import { readDiscussionMessages } from './queries';

const authentication = createPresentUserSessionAccessAuthentication();
const document = (text: string) => ({ v: 1 as const, parts: [{ t: 'text' as const, text }] });

describe('Approved Discussion publication settlement (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-draft-publication-', env: {
            HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['policy_withdrawn', 'transient', 'settlement_ack_lost', 'settlement_unavailable'] as const)(
        'settles the original through draft Post and preserves retry semantics (%s)', async scenario => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            const artifactId = randomUUID();
            // Artifact content persistence remains this harness's external port;
            // the server consumes its real Account/Session query binding.
            await db.artifact.create({ data: { id: artifactId, accountId: owner.id,
                kind: deriveArtifactStoredKindV1({ kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn }), approvalSessionId: session.id,
                header: new Uint8Array([0]), body: new Uint8Array([0]), dataEncryptionKey: new Uint8Array([0]) } });
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Draft publication' } },
                firstMessage: { localId: randomUUID(), content: { t: 'plain', v: document('Start') }, mentionedAccountIds: [] },
            } });
            if (!created.ok) throw new Error(created.error);
            const discussionId = created.value.discussion.id;
            expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
                request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'drafts_for_approval' } })).toMatchObject({ ok: true });
            const questionContent = { v: 1 as const, parts: [{ t: 'mention' as const,
                participant: { kind: 'session' as const, sessionId: session.id } }, { t: 'text' as const, text: 'Question' }] };
            const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
                request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: randomUUID(),
                    content: { t: 'plain', v: questionContent }, authoredContent: questionContent,
                    mentionedAccountIds: [], mentionedSessionIds: [session.id] }) });
            if (!question.ok) throw new Error(question.error);
            const discussion = { discussionId, messageId: question.value.message.id,
                throughSeq: question.value.message.seq, participantSessionId: session.id };
            const requestLocalId = deriveDiscussionFollowInputLocalIdV1(discussion), acceptedTurnId = 'native-answer-turn';
            const outcome = { kind: 'answer' as const, result: { sessionId: session.id, messageId: 'native-answer' } };
            const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id,
                requestSessionId: session.id, reply: { mode: 'return', discussion } }));
            if (!progress) throw new Error('Original reply admission failed');
            await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId: requestLocalId,
                messageRole: 'user', content: { t: 'plain', v: {} }, replyDisposition: 'return_pending',
                inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine',
                    discussionAddressing: discussion, admittedTarget: { homeId: 'srv_home', accountId: owner.id,
                        sessionId: session.id, machineId: 'machine', installationId: 'installation' } }),
                replyProgress: { ...progress, acceptedTurnId, disposition: 'return_pending', outcome } } });
            const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: session.id, localId: requestLocalId, acceptedTurnId });
            const input = { discussionId, localId, content: document('Private native answer'),
                replyTarget: { kind: 'message' as const, messageId: discussion.messageId } };
            const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home', serverIdentityId: 'srv_home',
                runtimeAccountId: owner.id, actionCaller: { kind: 'host' }, defaultSessionId: session.id,
                defaultSessionMachineId: 'machine', actionRequestId: localId,
                discussionReplyReturn: { serverId: 'srv_home', requestLocalId, acceptedTurnId },
                sessionInputSource: { sourceSessionId: session.id, sourceInputId: requestLocalId,
                    sourceTurnId: acceptedTurnId, via: 'action', discussionAddressing: discussion },
                actionsSettings: normalizeActionsSettingsV1({ v: 1 }) };
            let stored: ApprovalRequestV2 | undefined;
            let transportUnavailable = false;
            let loseSettlementAck = scenario === 'settlement_ack_lost';
            let settlementUnavailable = scenario === 'settlement_unavailable';
            let publicPosts = 0;
            // These ports replace HTTP/Artifact persistence and Machine currentness only.
            // Policy, approval CAS/replay, original custody, projection and invalidation stay real.
            const deps: Partial<ActionExecutorDeps> = {
                isApprovalExecutionOriginCurrent: async () => true,
                approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId }; },
                approvalsGet: async () => stored ?? null,
                approvalsUpdate: async ({ request }) => {
                    if (!stored) throw new Error('Missing private draft');
                    const transition = decideApprovalRequestTransition(stored, request);
                    if (!transition.ok) return transition;
                    stored = ApprovalRequestV2Schema.parse(request);
                    return { ok: true };
                },
                discussionAction: async ({ actionId, input: raw }) => {
                    if (transportUnavailable) return { ok: false, errorCode: 'discussions_unavailable', error: 'discussions_unavailable' };
                    if (actionId === 'discussion.participants.list') {
                        const roster = await listDiscussionParticipants({ authentication, actorAccountId: owner.id, discussionId });
                        if (!roster.ok) throw new Error(roster.error);
                        return roster.value;
                    }
                    const reply = DiscussionReplyInputV1Schema.parse(raw);
                    if (!reply.localId) throw new Error('Missing publication retry identity');
                    const posted = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
                        producer: { v: 1, kind: 'agent', sessionId: session.id },
                        draftReview: { artifactId, decidingAccountId: owner.id },
                        replyReturn: { serverId: 'srv_home', requestLocalId, acceptedTurnId },
                        request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: reply.localId,
                            content: { t: 'plain', v: reply.content }, authoredContent: reply.content,
                            mentionedAccountIds: [], mentionedSessionIds: [], replyTarget: reply.replyTarget }) });
                    if (!posted.ok) return { ok: false, errorCode: posted.error, error: posted.error };
                    publicPosts += 1;
                    return { v: 1, serverId: 'home', ...posted.value, message: { ...posted.value.message, content: reply.content,
                        messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId }, messageId: posted.value.message.id } } };
                },
                sessionMessageReply: async ({ sessionId, requestLocalId, reviewDecision }) => {
                    if (!reviewDecision) throw new Error('Expected existing original settlement port');
                    if (settlementUnavailable) { settlementUnavailable = false; throw new Error('Settlement transport unavailable'); }
                    const settled = await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { authentication,
                        accountId: owner.id, sessionId, localId: requestLocalId, ...SessionMessageReplyAccountMutationV1Schema.parse(reviewDecision) }));
                    if (loseSettlementAck) { loseSettlementAck = false; throw new Error('Settlement acknowledgement lost'); }
                    return settled;
                },
            };
            const executor = createActionExecutor(deps as ActionExecutorDeps);
            expect(await executor.execute('discussion.reply', input, context)).toMatchObject({ ok: true,
                result: { kind: 'approval_request_created', artifactId } });
            expect(stored).toMatchObject({ status: 'open', discussionDraftReview: true });
            expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { authentication, accountId: owner.id,
                sessionId: session.id, localId: requestLocalId, kind: 'discussion_publication', discussionId,
                messageId: discussion.messageId, acceptedTurnId, publication: { kind: 'approval_pending', artifactId } })))
                .toMatchObject({ ok: true });
            if (scenario !== 'transient') expect(await setDiscussionParticipantPolicy({ authentication, actorAccountId: owner.id,
                discussionId, request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'reads_only' } })).toMatchObject({ ok: true });
            else transportUnavailable = true;
            const before = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
            const person: ActionExecutorContext = { surface: 'ui', authority: 'present_user', serverId: 'home',
                serverIdentityId: 'srv_home', runtimeAccountId: owner.id };
            const post = () => executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, person);
            const result = await post();
            expect(result).toMatchObject(scenario === 'settlement_ack_lost' || scenario === 'settlement_unavailable' ? { ok: false } : { ok: true,
                result: { status: 'failed', execution: { ok: false,
                    errorCode: scenario === 'transient' ? 'discussions_unavailable' : 'discussion_answer_policy_denied' } } });
            if (scenario === 'settlement_unavailable') {
                expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress)
                    .toMatchObject({ disposition: 'return_pending', returnPublication: { kind: 'approval_pending', artifactId } });
                expect((await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).seq).toBe(before.seq);
                expect(await post()).toMatchObject({ ok: true, result: { status: 'failed' } });
            }
            const failure = { code: scenario === 'transient' ? 'discussions_unavailable' : 'discussion_answer_policy_denied',
                phase: 'action_admission', retryable: scenario === 'transient' };
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress)
                .toMatchObject({ outcome, disposition: scenario === 'transient' ? 'return_pending' : 'released',
                    returnPublication: { kind: 'failed', failure } });
            const read = await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId, messageId: discussion.messageId });
            if (!read.ok) throw new Error(read.error);
            const original = DiscussionMessagesResponseV1Schema.parse(read.value).messages[0]!;
            expect(original.participantDeliveryV1).toEqual(scenario === 'transient' ? undefined
                : [{ participantSessionId: session.id, disposition: 'failed', failure }]);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).seq - before.seq)
                .toBe(scenario === 'transient' ? 0 : 1);
            expect(publicPosts).toBe(0);
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
            expect(await post()).toMatchObject({ ok: true, result: { status: 'failed' } });
            expect(await executor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' }))
                .toMatchObject({ ok: true, result: { status: 'failed' } });
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).seq - before.seq)
                .toBe(scenario === 'transient' ? 0 : 1);
            if (scenario === 'transient') {
                transportUnavailable = false;
                expect(await executor.execute('discussion.reply', input, context)).toMatchObject({ ok: true,
                    result: { kind: 'approval_request_created' } });
                expect(await post()).toMatchObject({ ok: true, result: { status: 'executed' } });
                expect(publicPosts).toBe(1);
            }
        });
});
