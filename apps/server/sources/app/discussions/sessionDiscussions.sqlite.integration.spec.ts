import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { DiscussionInviteResponseV1Schema, DiscussionRemoveParticipantResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { buildDiscussionMutationRequestBodyV1, DiscussionCreateResponseV1Schema, DiscussionDetailsResponseV1Schema, DiscussionPostResponseV1Schema, DiscussionMessagesResponseV1Schema, DiscussionAgentPostResponseV1Schema, DiscussionAgentPublisherResponseV1Schema,
    DISCUSSION_AGENT_POST_EVENT_V1, DISCUSSION_HTTP_PATHS_V1, type DiscussionCreateRequestV1 } from '@happier-dev/protocol/discussions/api';
import { createDiscussionMessageRefV1, DiscussionMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { db } from '@/storage/db';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { eventRouter } from '@/app/events/eventRouter';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { archiveDiscussion, createDiscussion, postDiscussionMessage, renameDiscussion, restoreDiscussion } from './mutations';
import { getDiscussion, listDiscussions, readDiscussionMessages } from './queries';
import { setDiscussionReadCursor } from './readState';
import { inviteDiscussionParticipant, listDiscussionParticipants, removeDiscussionParticipant, setDiscussionParticipantPolicy, setDiscussionGrant } from './accessService';
import { observePendingSessionFollowForDestinationInTx, admitDiscussionFollowAddressingInTx, acknowledgeDiscussionFollowInputInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { deriveDiscussionFollowInputLocalIdV1, SessionFollowPendingObservationV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { DEFAULT_PENDING_REQUESTED_ACTION_V1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { createSessionInputReplyProgressInTx, projectSessionInputRepliesFromTurnInTx, readSessionMessageReplyInTx,
    mutateSessionMessageReplyForMachineInTx, mutateSessionMessageReplyForAccountInTx, isSessionInputSourceCurrentInTx } from '@/app/session/messages/sessionMessageReply';
import { deriveSessionMessageReplyReturnLocalIdV1, SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, SessionMessageReplyMutationResultV1Schema,
    SessionMessageReplyPendingHintV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, FeaturesResponseSchema } from '@happier-dev/protocol';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { SessionPendingAdmissionSettlementResponseV1Schema, SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/sessionPendingAdmissionSettlementV1';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema, SessionInputAdmissionReceiptV1Schema,
    settleSessionInputRequestV1, withSessionInputAuthorityV1, withSessionInputRequestV1,
    settleSessionMessageProvenanceV1, SESSION_MESSAGE_PROVENANCE_META_KEY, deriveWorkflowSessionInputLocalIdV2,
    SessionInputRequestV2Schema, withSessionInputRequest, readSessionInputRequest, readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { changeDeliveryMute } from '@/app/session/follow/sessionDeliveryMuteService';
import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { enqueuePendingMessageByAuthenticatedMachine, materializeNextPendingMessage, resolveAcceptedPendingDelivery, settlePendingInputAdmission } from '@/app/session/pending/pendingMessageService';
import { reconcileAutonomousExchangeAcceptedTurnInTx } from '@/app/session/pending/reconcileAutonomousExchangeAcceptedTurnInTx';
import { updateAccountFollowCreationPreferencesInTx } from '@/app/session/follow/accountFollowCreationPreferences';
import { type FollowPolicyV1, resolveFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { TriageEntryRefV1Schema } from '@happier-dev/protocol/tasks/entryRefV1';
import type { VerifiedEphemeralSessionRunnerPrincipal } from '@happier-dev/protocol/ephemeralRunner/principal';
import { createMaterializedEphemeralRunnerFixture } from '@/app/ephemeralRunner/materializedRunner.testkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionArchiveRoutes } from '@/app/api/routes/session/registerSessionArchiveRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { registerSessionFollowRoutes } from '@/app/api/routes/session/registerSessionFollowRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerSessionPatchRoute } from '@/app/api/routes/session/registerSessionPatchRoute';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { ApiSessionClient } from '../../../../cli/src/api/session/sessionClient';
import { createPlainSessionFixture } from '../../../../cli/src/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '../../../../cli/src/testkit/backends/apiSessionSocketHarness';
import { MessageQueue2 } from '../../../../cli/src/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '../../../../cli/src/agent/runtime/permissions/queuedPrompt';
import { registerPermissionModeMessageQueueBinding } from '../../../../cli/src/agent/runtime/permissions/bindModeQueue';
import { runPermissionModePromptLoop } from '../../../../cli/src/agent/runtime/runPermissionModePromptLoop';
import { createNativeAgentSessionOperations } from '../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createNativeAgentHostSessionRuntimePlan } from '../../../../cli/src/plugins/runtime/runtimeCore/plugin/session';
import { buildPluginSessionBindingInput } from '../../../../cli/src/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createCurrentSessionPresentationHost } from '../../../../cli/src/session/presentation/currentSessionPresentationService';
import { ProviderEnforcedPermissionHandler } from '../../../../cli/src/agent/permissions/providerEnforced/handler';
import { createSessionTurnLifecycle } from '../../../../cli/src/agent/runtime/session/turn/lifecycle';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeBinding } from '../../../../cli/src/agent/runtime/session/input/providerInputOutcome';
import { MessageBuffer } from '../../../../cli/src/ui/ink/messageBuffer';
import { createInitialHostRuntimeActivityMutation } from '../../../../cli/src/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { createDiscussionFollowInputIntake } from '../../../../cli/src/agent/runtime/session/follow/discussionFollowInput';
import { createMutableApiSessionClientFixture } from '../../../../cli/src/testkit/backends/sessionFixtures';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '../../../../cli/src/testkit/http/axiosAdapter';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionLookupByTagsRoute } from '@/app/api/routes/session/registerSessionLookupByTagsRoute';
import { registerSessionFollowRoutes } from '@/app/api/routes/session/registerSessionFollowRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';

const document = (text: string) => ({ v: 1 as const, parts: [{ t: 'text' as const, text }] });
const authentication = createPresentUserSessionAccessAuthentication();
function createRequest(input: Readonly<{
    creationLocalId?: string; firstLocalId?: string;
    participants?: readonly { kind: 'account'; accountId: string }[];
    anchor?: { kind: 'session'; sessionId: string; messageId?: string };
}> = {}): DiscussionCreateRequestV1 {
    return buildDiscussionMutationRequestBodyV1({
        kind: 'create', creationLocalId: input.creationLocalId ?? crypto.randomUUID(),
        titleContent: { t: 'plain', v: { v: 1, title: 'Independent discussion' } },
        firstMessage: { localId: input.firstLocalId ?? crypto.randomUUID(), content: { t: 'plain', v: document('Hello') },
            authoredContent: document('Hello'), mentionedAccountIds: [] },
        ...(input.participants ? { participants: input.participants } : {}),
        ...(input.anchor ? { anchor: input.anchor } : {}),
    });
}
const postRequest = (text: string) => buildDiscussionMutationRequestBodyV1({
    kind: 'post', localId: crypto.randomUUID(), content: { t: 'plain', v: document(text) }, authoredContent: document(text), mentionedAccountIds: [],
});
const plainMachine = (accountId: string) => db.machine.create({ data: { id: crypto.randomUUID(), installationId: crypto.randomUUID(), accountId,
    metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
    dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
    operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } },
    operationProtocolCapabilitiesRevision: 1 } });

describe('First-class Discussions service (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussions-', initAuth: true,
        env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each([false, true])('creates atomic first-message addressing from initial Session invitations (addressed: %s)', async addressed => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const friend = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: friend.id, status: 'friend' } });
        const own = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const another = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const foreign = await db.session.create({ data: { accountId: outsider.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const content = { v: 1 as const, parts: [
            ...(addressed ? [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: own.id } }] : []),
            { t: 'text' as const, text: 'First question' },
        ] };
        const request = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'Initial addressing' } },
            firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: content }, authoredContent: content,
                mentionedAccountIds: [], mentionedSessionIds: addressed ? [own.id] : [] },
            participants: [{ kind: 'account', accountId: friend.id }, { kind: 'session', sessionId: own.id }, { kind: 'session', sessionId: another.id }] });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request });
        expect(created).toMatchObject({ ok: true, value: { discussion: { participantSessionIds: expect.arrayContaining([own.id, another.id]) } } });
        if (!created.ok) throw new Error(created.error);
        expect(created.value.firstMessage).toMatchObject({ seq: 1,
            addressingV1: { throughSeq: 1, participantSessionIds: addressed ? [own.id] : [] } });
        expect(created.value.discussion.messageSeq).toBe(1);
        expect(await db.sessionFollowEdge.findMany({ where: { sourceDiscussionId: created.value.discussion.id },
            select: { deliveredTranscriptSeq: true } })).toEqual([{ deliveredTranscriptSeq: 0 }, { deliveredTranscriptSeq: 0 }]);
        const observe = (sessionId: string) => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: sessionId,
        }));
        const observations = (await observe(own.id)).observations;
        expect(observations).toEqual(addressed ? [expect.objectContaining({ source: { kind: 'discussion', discussionId: created.value.discussion.id },
            addressing: { discussionId: created.value.discussion.id, messageId: created.value.firstMessage.id, throughSeq: 1, participantSessionId: own.id } })] : []);
        expect((await observe(another.id)).observations).toEqual([]);
        const beforeRetry = await db.account.findMany({ where: { id: { in: [owner.id, friend.id] } }, select: { id: true, seq: true }, orderBy: { id: 'asc' } });
        expect(await listDiscussionParticipants({ actorAccountId: owner.id, authentication, discussionId: created.value.discussion.id }))
            .toMatchObject({ ok: true, value: { participants: expect.arrayContaining([
                { participant: { kind: 'session', sessionId: own.id }, answerPolicy: 'when_addressed', createdAt: expect.any(Number) },
                { participant: { kind: 'session', sessionId: another.id }, answerPolicy: 'when_addressed', createdAt: expect.any(Number) },
            ]) } });
        expect(await createDiscussion({ actorAccountId: owner.id, authentication, request })).toMatchObject({ ok: true, value: {
            discussion: { id: created.value.discussion.id, messageSeq: 1 }, firstMessage: { id: created.value.firstMessage.id,
                addressingV1: { throughSeq: 1, participantSessionIds: addressed ? [own.id] : [] } },
        } });
        expect(await db.account.findMany({ where: { id: { in: [owner.id, friend.id] } }, select: { id: true, seq: true }, orderBy: { id: 'asc' } })).toEqual(beforeRetry);
        expect((await observe(own.id)).observations).toEqual(observations);
        if (addressed) {
            const addressing = { discussionId: created.value.discussion.id, messageId: created.value.firstMessage.id,
                throughSeq: 1, participantSessionId: own.id };
            const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
            await inTx(async tx => {
                const progress = await createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion: addressing } });
                if (!progress) throw new Error('Initial original reply custody unavailable');
                await tx.sessionPendingMessage.create({ data: { sessionId: own.id, localId, position: 1,
                    content: { t: 'plain', v: {} }, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1, replyProgress: progress,
                    inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', discussionAddressing: addressing,
                        admittedTarget: { homeId: 'home', accountId: owner.id, sessionId: own.id, machineId: 'machine', installationId: 'installation' } } } });
                await acknowledgeDiscussionFollowInputInTx(tx, { addressing, localInputId: localId });
            });
            expect((await observe(own.id)).observations).toEqual([]);
            expect(await createDiscussion({ actorAccountId: owner.id, authentication, request })).toMatchObject({ ok: true,
                value: { firstMessage: { id: addressing.messageId, seq: 1 } } });
            expect((await observe(own.id)).observations).toEqual([]);
            expect(await db.sessionFollowEdge.findFirst({ where: { sourceDiscussionId: addressing.discussionId,
                destinationSessionId: own.id } })).toMatchObject({ deliveredTranscriptSeq: 1 });
        }
        const invalidContent = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: foreign.id } }] };
        const invalidMention = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
            titleContent: request.titleContent, participants: request.participants,
            firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: invalidContent }, authoredContent: invalidContent,
                mentionedAccountIds: [], mentionedSessionIds: [foreign.id] } });
        expect(await createDiscussion({ actorAccountId: owner.id, authentication, request: invalidMention }))
            .toMatchObject({ ok: false, error: 'discussion_invalid_mention' });
        expect(await db.account.findMany({ where: { id: { in: [owner.id, friend.id] } }, select: { id: true, seq: true }, orderBy: { id: 'asc' } })).toEqual(beforeRetry);
        const deniedRequest = { ...createRequest(), participants: [{ kind: 'account' as const, accountId: friend.id }, { kind: 'session' as const, sessionId: own.id },
            { kind: 'session' as const, sessionId: foreign.id }] };
        expect(await createDiscussion({ actorAccountId: owner.id, authentication, request: deniedRequest })).toMatchObject({ ok: false });
        expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(1);
        expect(await db.discussionMessage.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(1);
        expect(await db.discussionParticipant.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(2);
        expect(await db.discussionAccountGrant.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(1);
        expect(await db.discussionKeyEnvelope.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(0);
        expect(await db.discussionReadState.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(2);
        expect(await db.sessionFollowEdge.count({ where: { sourceDiscussion: { createdByAccountId: owner.id } } })).toBe(2);
    });
    it('creates atomic encrypted first-message addressing without changing key custody', async () => {
        const keys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'e2ee', metadata: '{}' } });
        const encryptedDataKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes }));
        const request: DiscussionCreateRequestV1 = {
            creationLocalId: crypto.randomUUID(), creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) },
            dataEncryptionKey: encryptedDataKey, expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey),
            titleContent: { t: 'encrypted', c: 'sealed-title' }, participants: [{ kind: 'session', sessionId: session.id }],
            firstMessage: { localId: crypto.randomUUID(), content: { t: 'encrypted', c: 'sealed-question' },
                requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'B'.repeat(43) }, mentionedAccountIds: [], mentionedSessionIds: [session.id] },
        };
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request });
        expect(created).toMatchObject({ ok: true, value: { firstMessage: { seq: 1, content: request.firstMessage.content,
            addressingV1: { throughSeq: 1, participantSessionIds: [session.id] } } } });
        if (!created.ok) throw new Error(created.error);
        expect(created.value.discussion).toMatchObject({ encryptionMode: 'e2ee', dataEncryptionKey: encryptedDataKey, keyReadiness: true, messageSeq: 1 });
        expect(await createDiscussion({ actorAccountId: owner.id, authentication, request })).toEqual(created);
        const cursor = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        expect(await createDiscussion({ actorAccountId: owner.id, authentication, request: { ...request, creationLocalId: crypto.randomUUID(),
            firstMessage: { ...request.firstMessage, localId: crypto.randomUUID(), mentionedSessionIds: [crypto.randomUUID()] } } }))
            .toEqual({ ok: false, error: 'discussion_invalid_mention' });
        expect(await db.discussion.count({ where: { ownerAccountId: owner.id } })).toBe(1);
        expect(await db.discussionParticipant.count({ where: { discussion: { ownerAccountId: owner.id } } })).toBe(1);
        expect(await db.discussionMessage.count({ where: { discussion: { ownerAccountId: owner.id } } })).toBe(1);
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(cursor);
    });
    async function fixture(input: Parameters<typeof createRequest>[0] = {}) {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const invitee = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [invitee.id, outsider.id]);
        const request = createRequest({ participants: [{ kind: 'account', accountId: invitee.id }], ...input });
        const result = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        return { owner, invitee, outsider, request, created: result.value, discussionId: result.value.discussion.id };
    }
    async function publisherSocket(accountId: string, sessionId: string, runner?: Readonly<{
        machineId: string; principal: VerifiedEphemeralSessionRunnerPrincipal;
    }>) {
        const machine = runner ? await db.machine.findUniqueOrThrow({ where: { id: runner.machineId } }) : await plainMachine(accountId);
        if (!runner) await db.accessKey.create({ data: { accountId, machineId: machine.id, sessionId, data: 'encrypted' } });
        const socket = createAuthenticatedFakeSocket(runner ? { data: { ephemeralRunnerAdmission: { kind: 'session-runtime', principal: runner.principal } } } : {});
        const presence = createSessionPublisherPresence();
        // Only Socket.IO is replaced. Current publisher admission and all writes remain real.
        sessionUpdateHandler(accountId, socket as never, { connectionType: 'session-scoped', socket, userId: accountId, sessionId } as never,
            { presence, binding: { accountId, machineId: machine.id, sessionId } },
            runner ? { principalKind: 'ephemeral-session-runner', principal: runner.principal } : undefined);
        let snapshotAck: unknown;
        await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId, mutationId: crypto.randomUUID(), snapshot: { state: 'idle', activeCount: 0 } }, (value: unknown) => { snapshotAck = value; });
        expect(snapshotAck).toMatchObject({ status: expect.stringMatching(/^(applied|unchanged)$/) });
        return { socket, machine, presence };
    }
    it('rolls back a declined initial Session invitation through the current trusted publisher socket', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const publisher = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const foreign = await db.session.create({ data: { accountId: outsider.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const { socket } = await publisherSocket(owner.id, publisher.id);
        const request = { ...createRequest(), participants: [
            { kind: 'session' as const, sessionId: publisher.id }, { kind: 'session' as const, sessionId: foreign.id },
        ] };
        let response: unknown;
        await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, operation: 'create', sessionId: publisher.id, request },
            (value: unknown) => { response = value; });
        expect(DiscussionAgentPublisherResponseV1Schema.parse(response))
            .toMatchObject({ ok: false, error: 'discussion_access_forbidden' });
        expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
        expect(await db.discussionMessage.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(0);
        expect(await db.discussionParticipant.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(0);
        expect(await db.discussionAccountGrant.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(0);
    });
    it('roundtrips a private Task anchor and reply through HTTP and SQLite without an available Task source', async () => {
        const [owner, invitee, outsider] = await Promise.all([1, 2, 3].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
        await makeShareEligibleForTest(owner.id, [invitee.id, outsider.id]);
        // No Task source or provider is installed in this real server fixture.
        // These authored Discussion links do not perform a Task read or write.
        const entry = TriageEntryRefV1Schema.parse({ source: { pluginId: 'unavailable.tasks', localId: 'issues' },
            kindId: 'task', collisionScope: 'https://tracker.example\u001fproject', entryId: 'PAY-212' });
        const target = { kind: 'task' as const, entry };
        let actorAccountId = owner.id;
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Credential verification is the only replaced boundary; schemas,
        // routes, resource grants, retry equality and SQLite remain real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            request.userId = actorAccountId; request.authAuthority = 'present_user'; request.authTokenKind = 'account';
        });
        registerDiscussionRoutes(app);
        try {
            const creation = await app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1.collection,
                payload: { ...createRequest({ participants: [{ kind: 'account', accountId: invitee.id }] }), anchor: target } });
            expect(creation.statusCode, creation.body).toBe(200);
            const created = DiscussionCreateResponseV1Schema.parse(creation.json());
            const discussionId = created.discussion.id;
            expect(created.discussion.anchor).toEqual(target);
            expect((await db.discussion.findUniqueOrThrow({ where: { id: discussionId } })).anchorSessionId).toBeNull();
            actorAccountId = invitee.id;
            const detailsUrl = DISCUSSION_HTTP_PATHS_V1.discussion.replace(':discussionId', discussionId);
            const details = await app.inject({ method: 'GET', url: detailsUrl });
            expect(details.statusCode).toBe(200);
            expect(DiscussionDetailsResponseV1Schema.parse(details.json()).discussion.anchor).toEqual(target);
            const messagesUrl = DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId);
            const payload = { ...postRequest('A private Discussion answer'), replyTarget: target };
            const posted = await app.inject({ method: 'POST', url: messagesUrl, payload });
            expect(posted.statusCode, posted.body).toBe(200);
            const reply = DiscussionPostResponseV1Schema.parse(posted.json());
            expect(reply.message.replyTarget).toEqual(target);
            const retried = await app.inject({ method: 'POST', url: messagesUrl, payload });
            expect(retried.statusCode).toBe(200);
            expect(DiscussionPostResponseV1Schema.parse(retried.json()).message.id).toBe(reply.message.id);
            const changedTarget = await app.inject({ method: 'POST', url: messagesUrl, payload: { ...payload,
                replyTarget: { ...target, entry: { ...entry, entryId: 'PAY-213' } } } });
            expect(changedTarget.statusCode).toBe(409);
            expect(changedTarget.json()).toEqual({ error: 'discussion_idempotency_conflict' });
            const page = await app.inject({ method: 'GET', url: messagesUrl });
            expect(page.statusCode).toBe(200);
            expect(DiscussionMessagesResponseV1Schema.parse(page.json()).messages)
                .toEqual([expect.objectContaining({ id: created.firstMessage.id }), expect.objectContaining({ id: reply.message.id, replyTarget: target })]);
            expect((await db.discussionMessage.findUniqueOrThrow({ where: { id: reply.message.id } })).replyTargetV1).toEqual(target);
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
            actorAccountId = outsider.id;
            expect((await app.inject({ method: 'GET', url: detailsUrl })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: messagesUrl })).statusCode).toBe(404);
        } finally { await app.close(); }
    });
    it.each([
        { preset: 'quiet', answerPolicy: 'when_addressed' },
        { preset: 'important', answerPolicy: 'when_addressed' },
        { preset: 'quiet', answerPolicy: 'drafts_for_approval' },
    ] as const)('carries persisted Discussion receive policy $preset/$answerPolicy and the committed addressed event', async ({ preset, answerPolicy }) => {
        const { owner, discussionId } = await fixture();
        await inTx(tx => updateAccountFollowCreationPreferencesInTx(tx, { accountId: owner.id,
            patch: { discussionReceivePolicy: { preset } } }));
        const receiver = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: receiver.id }, answerPolicy } })).toMatchObject({ ok: true });
        // Later creation preferences must not rewrite an existing attachment.
        await inTx(tx => updateAccountFollowCreationPreferencesInTx(tx, { accountId: owner.id,
            patch: { discussionReceivePolicy: { preset: preset === 'quiet' ? 'important' : 'quiet' } } }));
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Addressed question'), content: { t: 'plain', v: { v: 1, parts: [
                { t: 'mention', participant: { kind: 'session', sessionId: receiver.id } },
            ] } }, mentionedSessionIds: [receiver.id] } });
        if (!question.ok) throw new Error(question.error);
        const observed = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: receiver.id,
        }));
        expect(observed.observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: receiver.id,
            policy: { preset }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' },
            addressing: { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: receiver.id } }]);
        const observation = observed.observations[0];
        if (!observation || !('source' in observation) || observation.source.kind !== 'discussion') throw new Error('Missing Discussion observation');
        expect(SessionFollowPendingObservationV1Schema.parse(observation)).toEqual(observation);
        const reply = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id,
            reply: { mode: 'return', discussion: observation.addressing } }));
        expect(reply).toMatchObject({ disposition: 'return_pending', discussion: observation.addressing });
        expect(resolveFollowDeliveryV1({ policies: [observation.policy], event: observation.event,
            discussionInput: { addressing: observation.addressing, original: question.value.message, reply } }).session)
            .toEqual({ nextTurn: false, wake: true });
    });
    it.each(['human', 'agent'] as const)('admits a direct ask despite Follow off and skips an off watch without starving the later selected %s event', async author => {
        const { owner, discussionId } = await fixture();
        const policy: FollowPolicyV1 = { preset: 'custom', events: { needs_you: { decision: { delivery: 'off' } },
            person_wrote: { delivery: author === 'human' ? 'interrupt' : 'off' }, message: { delivery: author === 'agent' ? 'quiet' : 'off' } } };
        await inTx(tx => updateAccountFollowCreationPreferencesInTx(tx, { accountId: owner.id, patch: { discussionReceivePolicy: policy } }));
        const receiver = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const sender = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        for (const session of [receiver, sender]) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Disabled decision'), content: { t: 'plain', v: { v: 1, parts: [
                { t: 'mention', participant: { kind: 'session', sessionId: receiver.id } },
            ] } }, mentionedSessionIds: [receiver.id] } });
        if (!question.ok) throw new Error(question.error);
        const addressing = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: receiver.id };
        const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: receiver.id,
        }));
        expect((await observe()).observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: receiver.id,
            policy, event: { kind: 'needs_you', type: 'decision', mode: 'wait' }, addressing }]);
        expect(await inTx(tx => admitDiscussionFollowAddressingInTx(tx, { accountId: owner.id, discussion: addressing }))).toBe(true);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: receiver.id } })).toBe(0);
        const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
        await inTx(async tx => {
            const progress = await createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion: addressing } });
            if (!progress) throw new Error('Direct ask obligation is unavailable');
            await tx.sessionPendingMessage.create({ data: { sessionId: receiver.id, localId, position: 1,
                content: { t: 'plain', v: {} }, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1,
                replyProgress: progress, replyDisposition: progress.disposition,
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', discussionAddressing: addressing,
                    admittedTarget: { homeId: 'home', accountId: owner.id, sessionId: receiver.id, machineId: 'machine', installationId: 'installation' } } } });
            await acknowledgeDiscussionFollowInputInTx(tx, { addressing, localInputId: localId });
        });
        expect(await setDiscussionParticipantPolicy({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: receiver.id }, answerPolicy: 'watches_and_speaks_up' } })).toMatchObject({ ok: true });
        const offWatch = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: postRequest('Unselected ambient original'), ...(author === 'human' ? { producer: { v: 1 as const, kind: 'agent' as const, sessionId: sender.id } } : {}) });
        if (!offWatch.ok) throw new Error(offWatch.error);
        expect((await observe()).observations).toEqual([]);
        expect(await inTx(tx => admitDiscussionFollowAddressingInTx(tx, { accountId: owner.id, discussion: {
            discussionId, messageId: offWatch.value.message.id, throughSeq: offWatch.value.message.seq, participantSessionId: receiver.id,
        } }))).toBe(false);
        const watch = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: postRequest('Selected ambient original'), ...(author === 'agent' ? { producer: { v: 1 as const, kind: 'agent' as const, sessionId: sender.id } } : {}) });
        if (!watch.ok) throw new Error(watch.error);
        expect((await observe()).observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: receiver.id,
            policy, event: { kind: author === 'human' ? 'person_wrote' : 'message' },
            addressing: { discussionId, messageId: watch.value.message.id, throughSeq: watch.value.message.seq, participantSessionId: receiver.id } }]);
        const observation = (await observe()).observations[0];
        expect(SessionFollowPendingObservationV1Schema.parse(observation)).toEqual(observation);
        // Malformed persisted policy cannot fall back to an executable preset.
        await db.sessionFollowEdge.updateMany({ where: { destinationSessionId: receiver.id, sourceDiscussionId: discussionId }, data: { policyJson: '{"preset":"unknown"}' } });
        expect((await observe()).observations).toEqual([]);
        await db.sessionFollowEdge.updateMany({ where: { destinationSessionId: receiver.id, sourceDiscussionId: discussionId }, data: { policyJson: JSON.stringify(policy) } });
        // Corrupt non-null provenance is not evidence of a human original.
        await db.discussionMessage.update({ where: { id: watch.value.message.id }, data: { producerV1: { kind: 'agent' } } });
        expect((await observe()).observations).toEqual([]);
    });
    it.each([{ explicitNewAsk: false, requester: 'local', queue: 'none' }, { explicitNewAsk: true, requester: 'autonomous', queue: 'none' },
        { explicitNewAsk: false, requester: 'foreign', queue: 'none' },
        { explicitNewAsk: false, requester: 'local', queue: 'current' },
        { explicitNewAsk: false, requester: 'local', queue: 'revoked' }] as const)('returns one protected answer with its exact admitted cause (queued=$queue, requester=$requester, newAsk=$explicitNewAsk)', async ({ explicitNewAsk, requester, queue }) => {
        const { owner, invitee, discussionId } = await fixture();
        await db.account.update({ where: { id: invitee.id }, data: { name: 'Bob Chen' } });
        const team = await db.team.create({ data: { name: 'Requesting Team' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: invitee.id, role: 'member' }] });
        const home = await getOrCreateServerIdentityId();
        const sessions = await Promise.all(['asker', 'answerer', 'reviewer'].map(() => db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } })));
        for (const session of sessions) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id,
            discussionId, request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const [asker, answerer, reviewer] = sessions;
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            producer: { v: 1, kind: 'agent', sessionId: asker.id }, request: { ...postRequest('Question'),
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: answerer.id } }] } },
                mentionedSessionIds: [answerer.id] } });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq,
            participantSessionId: answerer.id };
        const cause = { requestRef: 'original-admitted-input', requester: requester === 'autonomous' ? null : {
            serverId: requester === 'foreign' ? 'other-home' : home, accountId: invitee.id },
            persona: { serverId: home, sessionId: asker.id },
            origin: { kind: 'discussion' as const, discussion: { serverId: home, discussionId }, messageId: question.value.message.id } };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id,
            reply: { mode: 'return', discussion, actionRequestAttributionV1: cause } }));
        expect(progress).toMatchObject({ mode: 'return', discussion, disposition: 'return_pending' });
        expect(await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id,
            reply: { mode: 'return', discussion: { ...discussion, throughSeq: discussion.throughSeq + 1 } } }))).toBeNull();
        expect(await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id,
            reply: { mode: 'return', discussion, sourceSession: { sourceSessionId: asker.id,
                sourceTurnId: 'a-caller-chosen-cause', via: 'action' } } }))).toBeNull();
        const requestLocalId = crypto.randomUUID(), acceptedTurnId = 'discussion-answer-turn';
        await db.sessionMessage.create({ data: { sessionId: answerer.id, localId: requestLocalId, seq: 1,
            messageRole: 'user', content: { t: 'plain', v: {} }, replyDisposition: 'return_pending',
            replyProgress: { ...progress!, acceptedTurnId } } });
        const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: answerer.id, localId: requestLocalId, acceptedTurnId });
        const input = { authentication, actorAccountId: owner.id, discussionId,
            producer: { v: 1 as const, kind: 'agent' as const, sessionId: answerer.id },
            replyReturn: { serverId: 'home', requestLocalId, acceptedTurnId }, request: { ...postRequest('Answer'), localId,
                ...(explicitNewAsk ? { content: { t: 'plain' as const, v: { v: 1, parts: [
                    { t: 'text', text: 'My answer. Please review it: ' }, { t: 'mention', participant: { kind: 'session', sessionId: reviewer.id } },
                ] } }, mentionedSessionIds: [reviewer.id] } : {}),
                replyTarget: { kind: 'message' as const, messageId: question.value.message.id } } };
        const { socket, presence } = await publisherSocket(owner.id, answerer.id);
        const publish = async () => {
            let response: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, sessionId: answerer.id, discussionId,
                request: input.request, replyReturn: input.replyReturn }, (value: unknown) => { response = value; });
            return DiscussionAgentPostResponseV1Schema.parse(response);
        };
        expect(await postDiscussionMessage({ ...input, replyReturn: { serverId: 'home', requestLocalId, acceptedTurnId: 'wrong-turn' } })).toMatchObject({ ok: false });
        expect(await postDiscussionMessage({ ...input, producer: { ...input.producer, sessionId: asker.id } })).toMatchObject({ ok: false });
        expect(await postDiscussionMessage({ ...input, producer: { ...input.producer,
            actionRequestAttributionV1: { ...cause, requester: { serverId: home, accountId: owner.id } } } })).toMatchObject({ ok: false });
        expect(await postDiscussionMessage({ ...input, request: { ...input.request,
            replyTarget: { kind: 'message', messageId: 'another-question' } } })).toMatchObject({ ok: false });
        let posted: Awaited<ReturnType<typeof publish>>;
        if (queue === 'none') posted = await publish();
        else {
            let release!: () => void;
            let entered!: () => void;
            const blocked = new Promise<void>(resolve => { release = resolve; });
            const ready = new Promise<void>(resolve => { entered = resolve; });
            const neighbor = presence.runAsCurrentPublisher({ socket, operation: async () => { entered(); await blocked; } });
            await ready;
            const publication = publish();
            // Reproduce the removed socket-local 5s admission cap using a real
            // current-publisher neighbor, outside any database transaction.
            // This is a test delay, not a new product deadline or retry budget.
            await new Promise(resolve => setTimeout(resolve, 6_000));
            if (queue === 'revoked') await db.session.update({ where: { id: answerer.id }, data: { active: false } });
            release();
            await neighbor;
            posted = await publication;
            if (queue === 'revoked') {
                expect(posted).toMatchObject({ ok: false, error: 'discussion_post_denied' });
                expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(0);
                expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                    sessionId: answerer.id, localId: requestLocalId,
                } } })).replyProgress).toMatchObject({ disposition: 'return_pending' });
                return;
            }
        }
        expect(posted).toMatchObject({ ok: true, value: { message: { addressingV1: { participantSessionIds: explicitNewAsk ? [reviewer.id] : [] } } } });
        if (!posted.ok) throw new Error(posted.error);
        expect(posted.value.message.producerV1).toMatchObject({ actionRequestAttributionV1: cause });
        const expectedRequester = requester === 'local' ? { v: 1, accountId: invitee.id,
            profile: expect.objectContaining({ name: 'Bob Chen', username: null }) } : null;
        expect(posted.value.message).toMatchObject({ requesterAccountActor: expectedRequester });
        const read = await readDiscussionMessages({ authentication, actorAccountId: invitee.id, discussionId });
        expect(read).toMatchObject({ ok: true, value: { messages: expect.arrayContaining([
            expect.objectContaining({ id: posted.value.message.id, producerV1: expect.objectContaining({ actionRequestAttributionV1: cause }),
                requesterAccountActor: expectedRequester === null ? null : expect.objectContaining(expectedRequester) }),
        ]) } });
        expect(await getDiscussion({ authentication, actorAccountId: invitee.id, discussionId })).toMatchObject({ ok: true,
            value: { discussion: { latestMessage: { requesterAccountActor: expectedRequester === null ? null : expect.objectContaining(expectedRequester) } } } });
        await db.discussionMessage.update({ where: { id: posted.value.message.id },
            data: { producerV1: { ...posted.value.message.producerV1!, futurePresentation: true } } });
        // The exact ordinary terminal hook sees a different final text after the
        // explicit publication ACK was lost. It must preserve the committed answer.
        await db.sessionMessage.create({ data: { sessionId: answerer.id, seq: 2, messageRole: 'agent',
            content: { t: 'plain', v: { text: 'A later final answer' } } } });
        await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, { sessionId: answerer.id, turnId: acceptedTurnId,
            status: 'completed', transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [1], finalAssistantMessageSeq: 2 }) }));
        expect(await publish()).toMatchObject({ ok: true, value: { message: { id: posted.value.message.id } } });
        expect(await postDiscussionMessage({ ...input, replyReturn: undefined })).toMatchObject({ ok: false, error: 'discussion_idempotency_conflict' });
        expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(1);
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: answerer.id, localId: requestLocalId } } })).replyProgress)
            .toMatchObject({ disposition: 'returned', outcome: { kind: 'answer', publicationRef: { kind: 'discussion', messageId: posted.value.message.id } } });
    });
    it.each(['terminal', 'reviewed'] as const)('publishes the completed settled Discussion original through the %s return source', async source => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}', seq: 2 } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Question'), content: { t: 'plain', v: { v: 1, parts: [
                { t: 'mention', participant: { kind: 'session', sessionId: session.id } },
            ] } }, mentionedSessionIds: [session.id] } });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const homeId = await getOrCreateServerIdentityId();
        const { socket, machine } = await publisherSocket(owner.id, session.id);
        const current = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        const publisherAuthority = { accountId: owner.id, sessionId: session.id, machineId: machine.id, committedFence: current.lastActiveAt };
        const requestLocalId = deriveDiscussionFollowInputLocalIdV1(discussion);
        const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
            discussionAddressing: discussion, replyIntent: { mode: 'return' } });
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Question' },
            meta: withSessionInputRequestV1({}, request) } };
        const reply = { mode: 'return' as const, discussion };
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: owner.id, sourceMachineId: machine.id,
            targetMachineId: machine.id, sessionId: session.id, localId: requestLocalId, content,
            requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1, reply })).toEqual({ status: 'accepted', localId: requestLocalId });
        const claim = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id, publisherAuthority,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' });
        expect(claim).toMatchObject({ ok: true, didMaterialize: true, message: { localId: requestLocalId } });
        if (!claim.ok || !claim.didMaterialize) throw new Error('Expected the actual original claim');
        const receipt = SessionInputAdmissionReceiptV1Schema.parse(claim.message.inputAdmissionReceipt);
        const finalContent = { ...content, v: { ...content.v, meta: {
            ...withSessionInputAuthorityV1(content.v.meta, settleSessionInputRequestV1({
                request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt })),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({
                request, requestedProvenance: undefined, inputAdmissionReceipt: receipt }),
        } } };
        expect(finalContent.v.meta).not.toHaveProperty('happierInputRequestV1');
        expect(await settlePendingInputAdmission({ actorUserId: owner.id, sessionId: session.id, localId: requestLocalId, publisherAuthority,
            decision: { kind: 'admit', finalContent, validation: { reply } } })).toMatchObject({ ok: true, result: { status: 'accepted' } });
        const acceptedTurnId = `native-final-${source}`;
        expect(await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId: requestLocalId, publisherAuthority,
            acceptedTurn: { kind: 'newTurn', turnId: acceptedTurnId } })).toMatchObject({ ok: true, didResolve: true });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
        const original = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } });
        expect(original).toMatchObject({ seq: 3, content: finalContent, acceptedTurnId });
        const final = await db.sessionMessage.create({ data: { sessionId: session.id, seq: 5, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Two plus two is four.' } } } } });
        await db.session.update({ where: { id: session.id }, data: { seq: 6 } });
        const turn = await db.sessionTurn.create({ data: { sessionId: session.id, turnId: acceptedTurnId, status: 'completed', startedAt: 1n, updatedAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 3, userMessageSeqs: [3], startSeqInclusive: 3,
                endSeqInclusive: 6, finalAssistantMessageSeq: 5 }) } });
        await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, turn));
        expect(await inTx(tx => readSessionMessageReplyInTx(tx, { accountId: owner.id, sessionId: session.id, localId: requestLocalId, authentication })))
            .toMatchObject({ status: 'available', progress: { mode: 'return', acceptedTurnId, discussion, disposition: 'return_pending',
                outcome: { kind: 'answer', result: { sessionId: session.id, messageId: final.id } } } });
        const sourceSession = { sourceSessionId: session.id, sourceTurnId: acceptedTurnId, sourceInputId: requestLocalId, via: 'action' as const };
        expect(await inTx(tx => isSessionInputSourceCurrentInTx(tx, owner.id, sourceSession))).toBe(true);
        const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: session.id, localId: requestLocalId, acceptedTurnId });
        const publication = { v: 1 as const, sessionId: session.id, discussionId,
            replyReturn: { serverId: homeId, requestLocalId, acceptedTurnId },
            request: { ...postRequest('Two plus two is four.'), localId, replyTarget: { kind: 'message' as const, messageId: discussion.messageId } } };
        const publish = async (causalSource?: typeof sourceSession) => {
            let response: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ ...publication,
                ...(causalSource ? { sourceSession: causalSource } : {}) }, (value: unknown) => { response = value; });
            return DiscussionAgentPostResponseV1Schema.parse(response);
        };
        // The approved relay uses the exact local id, not the committed row id.
        expect(await publish({ ...sourceSession, sourceInputId: original.id })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await publish({ ...sourceSession, sourceTurnId: 'another-turn' })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(0);
        const posted = await publish(source === 'reviewed' ? sourceSession : undefined);
        expect(posted).toMatchObject({ ok: true, value: { message: { producerV1: { sourceSession,
            replyReturn: { requestLocalId, acceptedTurnId } }, addressingV1: { participantSessionIds: [] } } } });
        if (!posted.ok) throw new Error(posted.error);
        expect(await publish(source === 'reviewed' ? sourceSession : undefined))
            .toMatchObject({ ok: true, value: { message: { id: posted.value.message.id } } });
        expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(1);
        expect(await inTx(tx => readSessionMessageReplyInTx(tx, { accountId: owner.id, sessionId: session.id, localId: requestLocalId, authentication })))
            .toMatchObject({ status: 'available', progress: { disposition: 'returned', outcome: { kind: 'answer', publicationRef: { messageId: posted.value.message.id } } } });
        await db.accessKey.deleteMany({ where: { accountId: owner.id, machineId: machine.id, sessionId: session.id } });
        expect(await publish(source === 'reviewed' ? sourceSession : undefined)).toMatchObject({ ok: false, error: 'discussion_post_denied' });
    });
    it('retains exact Workflow original authority through real Pending admission and refuses a changed invocation on retry', async () => {
        const { owner, discussionId, created } = await fixture();
        await getOrCreateServerIdentityId();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        expect(await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const { machine } = await publisherSocket(owner.id, session.id);
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct', causeKind: null,
            scheduledAt: new Date(), dueAt: new Date(), workflowAcceptedSnapshotEnvelope: 'accepted-by-workflow-owner', workflowCustodyState: 'pending' } });
        const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
            lifecycle: 'running', contentEnvelope: 'sealed-progress-owned-by-workflow' } });
        const workflow = { purpose: 'invocation' as const, runId: run.id, invocationRecordId: invocation.id };
        const discussion = { discussionId, messageId: created.firstMessage.id, throughSeq: created.firstMessage.seq, participantSessionId: session.id };
        const request = SessionInputRequestV2Schema.parse({ v: 2, producer: 'workflow', caller: { kind: 'host' }, permission: {}, workflow,
            replyIntent: { mode: 'wait' }, discussionAddressing: discussion });
        const localId = deriveWorkflowSessionInputLocalIdV2(workflow);
        const reply = { mode: 'wait' as const, discussion, workflow };
        const admission = { accountId: owner.id, sourceMachineId: machine.id, targetMachineId: machine.id, sessionId: session.id, localId,
            reply, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1,
            content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Original question' },
                meta: withSessionInputRequest({}, request) } } };
        expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toMatchObject({ status: 'rejected' });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(0);
        // A real implicit Workflow leaf is distinguished by immutable birth
        // provenance, not by the absence left behind when a selected slot was removed.
        await db.session.update({ where: { id: session.id }, data: { originKind: 'run_step', originRunId: 'foreign-run' } });
        expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toMatchObject({ status: 'rejected' });
        await db.session.update({ where: { id: session.id }, data: { originKind: 'run_step', originRunId: run.id } });
        expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toMatchObject({ status: 'accepted', localId });
        const stored = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
        expect(stored.replyProgress).toMatchObject({ mode: 'wait', discussion, workflow, disposition: 'observing' });
        expect(stored.inputAdmissionReceipt).toMatchObject({ issuer: 'authenticatedMachine', discussionAddressing: discussion,
            admittedTarget: { sessionId: session.id, machineId: machine.id } });
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...admission,
            reply: { ...reply, workflow: { ...workflow, invocationRecordId: 'forged-invocation' } } })).toMatchObject({ status: 'rejected' });
        expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toMatchObject({ status: 'alreadyAccepted', localId });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
    });
    it.each(['participant', 'unregistered', 'native-runtime', 'removed-observing', 'removed-inline', 'workflow-failed'] as const)('publishes a completed Workflow-selected answer once through %s and retains the committed Discussion reference', async mode => {
        const runner = mode === 'native-runtime' ? await createMaterializedEphemeralRunnerFixture() : undefined;
        const selected = runner ? await (async () => {
            const owner = await db.account.findUniqueOrThrow({ where: { id: runner.accountId } });
            const result = await createDiscussion({ actorAccountId: owner.id, authentication, request: createRequest() });
            if (!result.ok) throw new Error(result.error);
            return { owner, discussionId: result.value.discussion.id, created: result.value, invitee: undefined };
        })() : await fixture();
        const { owner, discussionId, created } = selected;
        const session = runner ? await db.session.findUniqueOrThrow({ where: { id: runner.sessionId } })
            : await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        if (mode === 'participant' || mode === 'workflow-failed' || mode.startsWith('removed-')) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        // Run… selects a participant for an existing unaddressed message. It does
        // not rewrite the original message into an ordinary @mention request.
        const question = created.firstMessage;
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct', causeKind: null, scheduledAt: new Date(), dueAt: new Date(),
            workflowAcceptedSnapshotEnvelope: 'accepted-by-workflow-owner', workflowCustodyState: 'pending' } });
        if (mode === 'unregistered' || mode === 'native-runtime') await db.session.update({ where: { id: session.id },
            data: { originKind: 'run_step', originRunId: run.id } });
        const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
            lifecycle: 'running', contentEnvelope: 'sealed-progress-owned-by-workflow' } });
        const workflow = { purpose: 'invocation' as const, runId: run.id, invocationRecordId: invocation.id };
        const discussion = { discussionId, messageId: question.id, throughSeq: question.seq, participantSessionId: session.id };
        expect(await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, requestSessionId: session.id,
            reply: { mode: 'return', discussion } }))).toBeNull();
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, requestSessionId: session.id,
            reply: { mode: 'wait', discussion, workflow } }));
        expect(progress).toMatchObject({ mode: 'wait', workflow, discussion, disposition: 'observing' });
        const requestLocalId = deriveWorkflowSessionInputLocalIdV2(workflow), acceptedTurnId = 'workflow-answer-turn';
        await db.sessionMessage.create({ data: { sessionId: session.id, localId: requestLocalId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: {} }, replyDisposition: 'observing', replyProgress: { ...progress!, acceptedTurnId,
                outcome: { kind: 'answer', result: { sessionId: session.id, messageId: 'final-answer' } } } } });
        const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: session.id, localId: requestLocalId, acceptedTurnId });
        const marker = { serverId: 'home', requestLocalId, acceptedTurnId,
            workflow: { runId: run.id, invocationRecordId: invocation.id, invocationAttempt: '0' } };
        const principal = runner ? await import('@/app/auth/auth').then(async ({ auth }) => (await auth.verifyToken(runner.token))?.ephemeralSessionRunnerPrincipal) : undefined;
        if (runner && !principal) throw new Error('Expected the real materialized Runner credential');
        const { socket } = await publisherSocket(owner.id, session.id, runner && principal ? { machineId: runner.machineId, principal } : undefined);
        const publish = async (replyReturn = marker, draftReview?: { artifactId: string; decidingAccountId: string }) => {
            let result: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, sessionId: session.id, discussionId, replyReturn,
                ...(mode === 'workflow-failed' ? { terminalReturn: true } : {}),
                ...(draftReview ? { draftReview } : {}),
                request: { ...postRequest('Accepted answer'), localId, replyTarget: { kind: 'message', messageId: question.id } } },
                (value: unknown) => { result = value; });
            return DiscussionAgentPostResponseV1Schema.parse(result);
        };
        if (mode.startsWith('removed-')) {
            await db.workflowRunInvocation.update({ where: { id: invocation.id }, data: { lifecycle: 'completed' } });
            if (mode === 'removed-inline') await db.sessionMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } },
                data: { replyDisposition: 'inline', replyProgress: { ...progress!, acceptedTurnId, disposition: 'inline',
                    outcome: { kind: 'answer', result: { sessionId: session.id, messageId: 'final-answer' } } } } });
            expect(await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
                request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
            expect(await db.discussionParticipant.findUnique({ where: { discussionId_sessionId: { discussionId, sessionId: session.id } } })).toBeNull();
            expect(await publish()).toMatchObject({ ok: false });
            expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(0);
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress)
                .toMatchObject({ disposition: 'released' });
            return;
        }
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        await db.workflowRunInvocation.update({ where: { id: invocation.id }, data: { lifecycle: mode === 'workflow-failed' ? 'failed' : 'completed' } });
        expect(await publish({ ...marker, workflow: { ...marker.workflow, invocationAttempt: '1' } })).toMatchObject({ ok: false });
        expect(await publish({ ...marker, workflow: { ...marker.workflow, runId: 'forged-run' } })).toMatchObject({ ok: false });
        if (mode === 'unregistered' && selected.invitee) {
            const review = { artifactId: crypto.randomUUID(), decidingAccountId: selected.invitee.id };
            await db.artifact.create({ data: { id: review.artifactId, accountId: owner.id,
                kind: deriveArtifactStoredKindV1({ kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn }), approvalSessionId: session.id,
                header: new Uint8Array([0]), body: new Uint8Array([0]), dataEncryptionKey: new Uint8Array([0]) } });
            expect(await publish(marker, review)).toMatchObject({ ok: true });
            expect(await setDiscussionGrant({ authentication, actorAccountId: owner.id, discussionId,
                request: { principal: { kind: 'account', accountId: selected.invitee.id }, accessLevel: 'view' } })).toMatchObject({ ok: true });
            // The real protected original remains current, but it cannot
            // bypass a supplied private review's current reviewer admission.
            expect(await publish(marker, review)).toMatchObject({ ok: false, error: 'discussion_post_denied' });
            expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(1);
        }
        const posted = await publish();
        expect(posted).toMatchObject({ ok: true, value: { message: { addressingV1: { participantSessionIds: [] } } } });
        if (!posted.ok) throw new Error(posted.error);
        expect(posted.value.message.producerV1).toMatchObject({ runId: run.id, replyReturn: { workflow: marker.workflow,
            outcome: mode === 'workflow-failed' ? 'failed' : 'answer' } });
        expect(await publish()).toMatchObject({ ok: true, value: { message: { id: posted.value.message.id } } });
        expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(1);
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress)
            .toMatchObject({ disposition: 'returned', outcome: mode === 'workflow-failed' ? { kind: 'failed' }
                : { kind: 'answer', publicationRef: { kind: 'discussion', messageId: posted.value.message.id } } });
        const returned = (await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress;
        const lateMutation = { authentication, accountId: owner.id, sessionId: session.id, localId: requestLocalId,
            kind: 'discussion_publication' as const, discussionId, messageId: discussion.messageId, acceptedTurnId,
            publication: { kind: 'failed' as const, failure: { code: 'action_outcome_unknown' as const,
                phase: 'session_publisher' as const, retryable: true } } };
        if (mode === 'participant') {
            const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id,
                sharedWithUserId: viewer.id, accessLevel: 'view' } });
            expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { ...lateMutation, accountId: viewer.id })))
                .toMatchObject({ ok: false, error: 'forbidden' });
            expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { ...lateMutation, messageId: 'another-question' })))
                .toMatchObject({ ok: false, error: 'conflict' });
            expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { ...lateMutation, acceptedTurnId: 'another-turn' })))
                .toMatchObject({ ok: false, error: 'conflict' });
        }
        // A lost append ACK rejoins the committed original; it cannot replace
        // its publication reference with a later uncertain transport result.
        expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, lateMutation)))
            .toEqual({ v: 1, ok: true, progress: returned });
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress)
            .toEqual(returned);
        expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(1);
        if (runner) {
            await db.accessKey.delete({ where: { accountId_machineId_sessionId: { accountId: owner.id, machineId: runner.machineId, sessionId: session.id } } });
            expect(await publish()).toMatchObject({ ok: false });
            expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(1);
        }
    });
    it('publishes an accepted non-Session Workflow leaf once through the canonical append and strict Discussion reader', async () => {
        const { owner, discussionId, created } = await fixture();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: '{}', dataEncryptionKey: null } });
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct', causeKind: null,
            scheduledAt: new Date(), dueAt: new Date(), claimedByMachineId: machine.id,
            workflowAcceptedSnapshotEnvelope: 'accepted-by-workflow-owner', workflowCustodyState: 'pending' } });
        const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
            lifecycle: 'running', contentEnvelope: 'sealed-progress-owned-by-workflow' } });
        const producer = { v: 1 as const, kind: 'workflow' as const, runId: run.id, invocationRecordId: invocation.id,
            invocationAttempt: '0', execution: { kind: 'action' as const, actionId: 'plugin:external/check' }, outcome: 'answer' as const };
        const origin = { discussion: { serverId: 'home', discussionId }, messageId: created.firstMessage.id, throughSeq: created.firstMessage.seq };
        const localId = deriveWorkflowDiscussionReplyLocalIdV1(producer);
        const request = { ...postRequest('External action completed'), localId, replyTarget: { kind: 'message' as const, messageId: origin.messageId } };
        // The installed Machine supplies this protected custody; ordinary HTTP callers cannot.
        const publish = (selectedOrigin = origin, expectedParentRevision?: number) => postDiscussionMessage({ authentication, actorAccountId: owner.id,
            discussionId, request, producer, workflowReturn: { machineId: machine.id, origin: selectedOrigin,
                ...(expectedParentRevision !== undefined ? { expectedParentRevision } : {}) } });
        expect(await publish()).toMatchObject({ ok: false });
        await db.workflowRunInvocation.update({ where: { id: invocation.id }, data: { lifecycle: 'completed' } });
        const posted = await publish();
        expect(posted).toMatchObject({ ok: true });
        if (!posted.ok) throw new Error(posted.error);
        expect(DiscussionPostResponseV1Schema.parse(posted.value).message.producerV1).toEqual(producer);
        expect(await publish()).toMatchObject({ ok: true, value: { message: { id: posted.value.message.id } } });
        expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(1);
        expect(await publish({ ...origin, messageId: 'different-parent' })).toMatchObject({ ok: false });
        await db.automationRun.update({ where: { id: run.id }, data: { claimedByMachineId: null } });
        expect(await publish()).toMatchObject({ ok: false });
        await db.automationRunAssignment.create({ data: { runId: run.id, machineId: machine.id } });
        await db.automationRun.update({ where: { id: run.id }, data: { state: 'interrupted' } });
        expect(await publish(origin, run.revision)).toMatchObject({ ok: true, value: { message: { id: posted.value.message.id } } });
        expect(await publish(origin, run.revision + 1)).toMatchObject({ ok: false });
    });
    it('settles an opaque E2EE Workflow answer through the same original and fails closed when the Discussion key becomes unavailable', async () => {
        const keys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: crypto.randomUUID(), titleContent: { t: 'encrypted', c: 'opaque-title' },
            creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) },
            dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes })),
            expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey),
            firstMessage: { localId: crypto.randomUUID(), content: { t: 'encrypted', c: 'opaque-question' }, mentionedAccountIds: [],
                requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'B'.repeat(43) } },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'e2ee', metadata: '{}' } });
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct', causeKind: null,
            scheduledAt: new Date(), dueAt: new Date(), workflowAcceptedSnapshotEnvelope: 'opaque-accepted', workflowCustodyState: 'pending' } });
        await db.session.update({ where: { id: session.id }, data: { originKind: 'run_step', originRunId: run.id } });
        const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
            lifecycle: 'completed', contentEnvelope: 'opaque-completed-progress' } });
        const workflow = { purpose: 'invocation' as const, runId: run.id, invocationRecordId: invocation.id };
        const discussion = { discussionId, messageId: created.value.firstMessage.id, throughSeq: 1, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, requestSessionId: session.id,
            reply: { mode: 'wait', workflow, discussion } }));
        if (!progress) throw new Error('Opaque Workflow original was refused');
        const requestLocalId = deriveWorkflowSessionInputLocalIdV2(workflow), acceptedTurnId = 'e2ee-workflow-turn';
        await db.sessionMessage.create({ data: { sessionId: session.id, localId: requestLocalId, seq: 1, messageRole: 'user',
            content: { t: 'encrypted', c: 'opaque-input' }, replyDisposition: 'observing', replyProgress: { ...progress, acceptedTurnId,
                outcome: { kind: 'answer', result: { sessionId: session.id, messageId: 'opaque-final' } } } } });
        const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: session.id, localId: requestLocalId, acceptedTurnId });
        const publication = { authentication, actorAccountId: owner.id, discussionId, producer: { v: 1 as const, kind: 'agent' as const, sessionId: session.id },
            replyReturn: { serverId: 'home', requestLocalId, acceptedTurnId,
                workflow: { runId: run.id, invocationRecordId: invocation.id, invocationAttempt: '0' } },
            request: { localId, content: { t: 'encrypted' as const, c: 'opaque-answer' }, mentionedAccountIds: [],
                requestEqualityEvidenceV1: { kind: 'e2eeTag' as const, tag: 'C'.repeat(43) },
                replyTarget: { kind: 'message' as const, messageId: discussion.messageId } } };
        const posted = await postDiscussionMessage(publication);
        if (!posted.ok) throw new Error(posted.error);
        expect(await postDiscussionMessage(publication)).toMatchObject({ ok: true, value: { message: { id: posted.value.message.id,
            content: { t: 'encrypted', c: 'opaque-answer' } } } });
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress)
            .toMatchObject({ outcome: { kind: 'answer', publicationRef: { messageId: posted.value.message.id } }, disposition: 'returned' });
        await db.discussion.update({ where: { id: discussionId }, data: { dataEncryptionKey: new Uint8Array(0) } });
        expect(await postDiscussionMessage(publication)).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(1);
    });
    it.each(['terminal_failure', 'retryable_failure', 'approval_pending'] as const)('settles a refused return visibly on original custody while preserving the successful native answer (%s)', async state => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Question'), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] } },
                mentionedSessionIds: [session.id] } });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion } }));
        if (!progress) throw new Error('Discussion original admission failed');
        const localId = deriveDiscussionFollowInputLocalIdV1(discussion), acceptedTurnId = 'successful-native-turn';
        const outcome = { kind: 'answer' as const, result: { sessionId: session.id, messageId: 'native-answer' } };
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId, messageRole: 'user', content: { t: 'plain', v: {} },
            replyDisposition: 'return_pending', replyProgress: { ...progress, acceptedTurnId, outcome } } });
        const publication = state === 'approval_pending' ? { kind: 'approval_pending' as const, artifactId: 'private-approval' }
            : { kind: 'failed' as const, failure: state === 'terminal_failure'
                ? { code: 'action_disabled' as const, phase: 'action_admission' as const, retryable: false }
                : { code: 'discussions_unavailable' as const, phase: 'session_transport' as const, retryable: true } };
        const disposition = state === 'terminal_failure' ? 'released' : 'return_pending';
        const settle = () => inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { authentication, accountId: owner.id,
            sessionId: session.id, localId, kind: 'discussion_publication', discussionId, messageId: discussion.messageId, acceptedTurnId, publication }));
        if (state === 'terminal_failure') {
            const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
            const share = await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id,
                sharedWithUserId: viewer.id, accessLevel: 'view' } });
            expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { authentication, accountId: viewer.id,
                sessionId: session.id, localId, kind: 'discussion_publication', discussionId, messageId: discussion.messageId, acceptedTurnId, publication })))
                .toMatchObject({ ok: false, error: 'forbidden' });
            await db.sessionShare.delete({ where: { id: share.id } });
            expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { authentication, accountId: owner.id,
                sessionId: session.id, localId, kind: 'discussion_publication', discussionId, messageId: 'another-question', acceptedTurnId, publication })))
                .toMatchObject({ ok: false, error: 'conflict' });
        }
        expect(await settle()).toMatchObject({ ok: true, progress: { disposition, outcome, returnPublication: publication } });
        expect(await settle()).toMatchObject({ ok: true, progress: { disposition, outcome, returnPublication: publication } });
        expect(await inTx(tx => readSessionMessageReplyInTx(tx, { authentication, accountId: owner.id, sessionId: session.id, localId })))
            .toMatchObject({ status: 'available', progress: { outcome, returnPublication: publication } });
        if (state === 'terminal_failure') {
            const visible = await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId, messageId: discussion.messageId });
            if (!visible.ok) throw new Error(visible.error);
            expect(DiscussionMessagesResponseV1Schema.parse(visible.value))
                .toMatchObject({ messages: [{ participantDeliveryV1: [{ participantSessionId: session.id,
                    disposition: 'failed', failure: publication.failure }] }] });
        }
        if (state === 'approval_pending') {
            const refused = { kind: 'failed' as const, failure: { code: 'approval_rejected' as const,
                phase: 'action_admission' as const, retryable: false } };
            const decision = { sessionId: session.id, localId, kind: 'discussion_publication' as const, discussionId,
                messageId: discussion.messageId, acceptedTurnId, approvalArtifactId: 'private-approval', publication: refused };
            expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { ...decision, accountId: owner.id,
                authentication: { ...authentication, authority: 'account_automation' } }))).toMatchObject({ ok: false, error: 'forbidden' });
            expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { ...decision, accountId: owner.id,
                authentication, approvalArtifactId: 'stale-approval' }))).toMatchObject({ ok: false, error: 'conflict' });
            expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { ...decision, accountId: owner.id, authentication })))
                .toMatchObject({ ok: true, progress: { disposition: 'released', outcome, returnPublication: refused } });
        }
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
    });
    it('wakes only the exact Workflow Machine once when its held publication is refused without changing the native answer', async () => {
        const { owner, discussionId, created } = await fixture();
        const machine = await plainMachine(owner.id);
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct', causeKind: null,
            scheduledAt: new Date(), dueAt: new Date(), workflowAcceptedSnapshotEnvelope: 'accepted-by-workflow-owner', workflowCustodyState: 'pending' } });
        const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
            lifecycle: 'completed', contentEnvelope: 'sealed-progress-owned-by-workflow' } });
        const workflow = { purpose: 'invocation' as const, runId: run.id, invocationRecordId: invocation.id };
        const discussion = { discussionId, messageId: created.firstMessage.id, throughSeq: created.firstMessage.seq, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, requestSessionId: session.id,
            reply: { mode: 'wait', discussion, workflow } }));
        if (!progress) throw new Error('Workflow original admission failed');
        const localId = deriveWorkflowSessionInputLocalIdV2(workflow), acceptedTurnId = 'confirmed-workflow-turn';
        const outcome = { kind: 'answer' as const, result: { sessionId: session.id, messageId: 'native-answer' } };
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId, messageRole: 'user', content: { t: 'plain', v: {} },
            replyDisposition: 'observing', replyProgress: { ...progress, acceptedTurnId, outcome,
                returnPublication: { kind: 'approval_pending', artifactId: 'private-confirmation' } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', admittedTarget: { homeId: await getOrCreateServerIdentityId(),
                accountId: owner.id, sessionId: session.id, machineId: machine.id, installationId: machine.installationId! } } } });
        const socket = createAuthenticatedFakeSocket();
        const otherSocket = createAuthenticatedFakeSocket();
        const connection = { connectionType: 'machine-scoped' as const, userId: owner.id, machineId: machine.id, socket: socket as never };
        const otherConnection = { ...connection, machineId: 'another-machine', socket: otherSocket as never };
        eventRouter.addConnection(owner.id, connection); eventRouter.addConnection(owner.id, otherConnection);
        onTestFinished(() => { eventRouter.removeConnection(owner.id, connection); eventRouter.removeConnection(owner.id, otherConnection); });
        const hints = () => socket.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral'
            && payload?.type === 'session-message-reply-pending-v1').map(([, payload]) => payload);
        const mutation = { authentication, accountId: owner.id, sessionId: session.id, localId, kind: 'discussion_publication' as const,
            discussionId, messageId: discussion.messageId, acceptedTurnId, approvalArtifactId: 'private-confirmation',
            publication: { kind: 'failed' as const, failure: { code: 'approval_rejected' as const, phase: 'action_admission' as const, retryable: false } } };
        expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { ...mutation, messageId: 'another-question' })))
            .toMatchObject({ ok: false, error: 'conflict' });
        expect(hints()).toEqual([]);
        expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, mutation)))
            .toMatchObject({ ok: true, progress: { disposition: 'released', outcome } });
        await vi.waitFor(() => expect(hints()).toHaveLength(1));
        expect(SessionMessageReplyPendingHintV1Schema.parse(hints()[0])).toEqual({ v: 1, type: 'session-message-reply-pending-v1',
            sessionId: session.id, requestLocalId: localId, workflowRunId: run.id });
        expect(await inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, mutation))).toMatchObject({ ok: true });
        expect(hints()).toHaveLength(1);
        expect(otherSocket.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral'
            && payload?.type === 'session-message-reply-pending-v1')).toEqual([]);
    });
    it('settles a person-declined Workflow Discussion draft on its original input without publishing it', async () => {
        const { owner, discussionId, created } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'drafts_for_approval' } })).toMatchObject({ ok: true });
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct', causeKind: null,
            scheduledAt: new Date(), dueAt: new Date(), workflowAcceptedSnapshotEnvelope: 'accepted-by-workflow-owner', workflowCustodyState: 'pending' } });
        const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
            lifecycle: 'completed', contentEnvelope: 'sealed-progress-owned-by-workflow' } });
        const workflow = { purpose: 'invocation' as const, runId: run.id, invocationRecordId: invocation.id };
        const discussion = { discussionId, messageId: created.firstMessage.id, throughSeq: created.firstMessage.seq, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, requestSessionId: session.id,
            reply: { mode: 'wait', discussion, workflow } }));
        if (!progress) throw new Error('Workflow original admission failed');
        const localId = deriveWorkflowSessionInputLocalIdV2(workflow), acceptedTurnId = 'private-workflow-turn';
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId, messageRole: 'user', content: { t: 'plain', v: {} },
            replyDisposition: 'observing', replyProgress: { ...progress, acceptedTurnId,
                returnPublication: { kind: 'approval_pending', artifactId: 'private-workflow-draft' },
                outcome: { kind: 'answer', result: { sessionId: session.id, messageId: 'private-answer' } } } } });
        const decline = () => inTx(tx => mutateSessionMessageReplyForAccountInTx(tx, { authentication, accountId: owner.id,
            sessionId: session.id, localId, kind: 'discussion_review', discussionId, messageId: discussion.messageId, acceptedTurnId, decision: 'reject' }));
        expect(await decline()).toMatchObject({ ok: true, progress: { disposition: 'released', outcome: { kind: 'declined' } } });
        expect(await decline()).toMatchObject({ ok: true, progress: { disposition: 'released', outcome: { kind: 'declined' } } });
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } })).replyProgress)
            .not.toHaveProperty('returnPublication');
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
    });
    it.each(['pass', 'failed', 'cancelled', 'terminal_no_result'] as const)('publishes a true %s return while retaining its original typed outcome', async kind => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        // The production post classifier supplies the immutable addressed snapshot.
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Question'), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] } },
                mentionedSessionIds: [session.id] } });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion } }));
        expect(progress).not.toBeNull();
        const requestLocalId = crypto.randomUUID(), acceptedTurnId = 'terminal-turn';
        await db.sessionMessage.create({ data: { sessionId: session.id, localId: requestLocalId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: {} }, replyDisposition: 'return_pending', replyProgress: { ...progress!, acceptedTurnId, outcome: { kind } } } });
        const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: session.id, localId: requestLocalId, acceptedTurnId });
        const input = { authentication, actorAccountId: owner.id, discussionId, producer: { v: 1 as const, kind: 'agent' as const, sessionId: session.id },
            replyReturn: { serverId: 'home', requestLocalId, acceptedTurnId }, terminalReturn: true as const, request: { ...postRequest(kind), localId,
                replyTarget: { kind: 'message' as const, messageId: discussion.messageId } } };
        expect(await postDiscussionMessage(input)).toMatchObject({ ok: true, value: { message: { producerV1: { replyReturn: { outcome: kind } }, addressingV1: { participantSessionIds: [] } } } });
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress)
            .toMatchObject({ disposition: 'returned', outcome: { kind } });
        await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant: { kind: 'session', sessionId: session.id } } });
        expect(await postDiscussionMessage({ ...input, request: { ...input.request, localId: crypto.randomUUID() } })).toMatchObject({ ok: false });
    });
    it('keeps the withdrawn original cancelled when the same Session is invited again', async () => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const participant = { kind: 'session' as const, sessionId: session.id };
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Question'), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant }] } }, mentionedSessionIds: [session.id] } });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion } }));
        expect(progress).not.toBeNull();
        const requestLocalId = crypto.randomUUID();
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId: requestLocalId, position: 0,
            content: { t: 'plain', v: {} }, requestedAction: { v: 1, kind: 'enqueue' }, replyProgress: progress!, replyDisposition: 'return_pending' } });
        expect(await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant } })).toMatchObject({ ok: true });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant } })).toMatchObject({ ok: true });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress)
            .toMatchObject({ disposition: 'released', outcome: { kind: 'cancelled' } });
        const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: session.id, localId: requestLocalId });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            producer: { v: 1, kind: 'agent', sessionId: session.id }, replyReturn: { serverId: 'home', requestLocalId },
            request: { ...postRequest('A stale answer'), localId, replyTarget: { kind: 'message', messageId: discussion.messageId } } })).toMatchObject({ ok: false });
        expect(await db.discussionMessage.count({ where: { discussionId, localId } })).toBe(0);
    });
    it('withdraws a materialized Discussion original without starving the next ordinary input after reinvitation', async () => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const participant = { kind: 'session' as const, sessionId: session.id };
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Question'), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant }] } }, mentionedSessionIds: [session.id] } });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const { socket, machine } = await publisherSocket(owner.id, session.id);
        const current = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        const publisherAuthority = { accountId: owner.id, sessionId: session.id, machineId: machine.id, committedFence: current.lastActiveAt };
        const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
            discussionAddressing: discussion, replyIntent: { mode: 'return' } });
        await getOrCreateServerIdentityId();
        const localId = deriveDiscussionFollowInputLocalIdV1(discussion);
        const reply = { mode: 'return' as const, discussion };
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Question' },
            meta: withSessionInputRequestV1({}, request) } };
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: owner.id, sourceMachineId: machine.id,
            targetMachineId: machine.id, sessionId: session.id, localId, content, reply,
            requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1 })).toMatchObject({ status: 'accepted', localId });
        const claim = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id, publisherAuthority,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' });
        expect(claim).toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
        if (!claim.ok || !claim.didMaterialize) throw new Error('Expected the real addressed input claim');
        const receipt = SessionInputAdmissionReceiptV1Schema.parse(claim.message.inputAdmissionReceipt);
        const finalContent = { ...content, v: { ...content.v, meta: {
            ...withSessionInputAuthorityV1(content.v.meta, settleSessionInputRequestV1({
                request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt })),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({
                request, requestedProvenance: undefined, inputAdmissionReceipt: receipt }),
        } } };
        const readmit = async () => {
            let response: unknown;
            await getSocketHandler(socket, SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1)({ v: 1, sessionId: session.id, localId,
                decision: { kind: 'admit', finalContent, validation: { reply: { mode: 'return', discussion } } } }, (value: unknown) => { response = value; });
            return SessionPendingAdmissionSettlementResponseV1Schema.parse(response);
        };
        expect(await readmit()).toMatchObject({ result: { status: 'accepted', localId } });
        expect(await readmit()).toMatchObject({ result: { status: 'alreadyAccepted', localId } });
        expect(await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant } })).toMatchObject({ ok: true });
        expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: discussionId, destinationSessionId: session.id } })).toBe(0);
        expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, { principal: {
            kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: session.id }))).observations).toEqual([]);
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } })).replyProgress)
            .toMatchObject({ disposition: 'released', outcome: { kind: 'cancelled' } });
        expect(await readmit()).toMatchObject({ result: { status: 'rejected', code: 'session_input_cancelled' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant } })).toMatchObject({ ok: true });
        expect(await readmit()).toMatchObject({ result: { status: 'rejected', code: 'session_input_cancelled' } });
        const ordinaryLocalId = crypto.randomUUID();
        const ordinaryRequest = buildTrustedHostSessionInputAdmissionV1('agent').request;
        const ordinaryContent = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'An unrelated ordinary input' },
            meta: withSessionInputRequestV1({}, ordinaryRequest) } };
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: owner.id, sourceMachineId: machine.id,
            targetMachineId: machine.id, sessionId: session.id, localId: ordinaryLocalId, content: ordinaryContent,
            requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1 })).toMatchObject({ status: 'accepted', localId: ordinaryLocalId });
        const ordinaryClaim = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id, publisherAuthority,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' });
        expect(ordinaryClaim).toMatchObject({ ok: true, didMaterialize: true, message: { localId: ordinaryLocalId } });
        if (!ordinaryClaim.ok || !ordinaryClaim.didMaterialize) throw new Error('Expected the unrelated ordinary input claim');
        const ordinaryReceipt = SessionInputAdmissionReceiptV1Schema.parse(ordinaryClaim.message.inputAdmissionReceipt);
        const ordinaryFinal = { ...ordinaryContent, v: { ...ordinaryContent.v, meta: {
            ...withSessionInputAuthorityV1(ordinaryContent.v.meta, settleSessionInputRequestV1({
                request: ordinaryRequest, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: ordinaryReceipt })),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({
                request: ordinaryRequest, requestedProvenance: undefined, inputAdmissionReceipt: ordinaryReceipt }),
        } } };
        expect(await settlePendingInputAdmission({ actorUserId: owner.id, sessionId: session.id, localId: ordinaryLocalId, publisherAuthority,
            decision: { kind: 'admit', finalContent: ordinaryFinal } })).toMatchObject({ ok: true, result: { status: 'accepted', localId: ordinaryLocalId } });
    });
    it('quietly withdraws the queued Discussion input after a busy native turn and reaches the next ordinary provider input', async () => {
        const { owner, discussionId } = await fixture();
        const receiver = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const participant = { kind: 'session' as const, sessionId: receiver.id };
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant } })).toMatchObject({ ok: true });
        const { socket, machine } = await publisherSocket(owner.id, receiver.id);
        await db.session.update({ where: { id: receiver.id }, data: { metadata: JSON.stringify({
            machineId: machine.id, path: '/repo', flavor: 'codex', permissionMode: 'default', permissionModeUpdatedAt: 0 }) } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        const transportEvents: string[] = [];
        app.addHook('onResponse', async (request, response) => {
            transportEvents.push(`${request.method} ${request.url.split('?')[0]} ${response.statusCode}`);
        });
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        // Credential verification and Socket.IO forwarding are boundaries. All
        // resource admission, input custody, CLI preparation and writes stay real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            request.userId = owner.id; request.authAuthority = 'present_user'; request.authTokenKind = 'account';
        });
        registerSessionListingRoutes(app); registerSessionMessageRoutes(app); registerSessionFollowRoutes(app);
        registerAccountEncryptionRoutes(app); registerSessionPatchRoute(app); sessionPendingRoutes(app); featuresRoutes(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        onTestFinished(() => app.close());
        const serverId = await getOrCreateServerIdentityId();
        const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse((await app.inject({ method: 'GET', url: '/v1/features' })).json()) };
        const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: owner.id })).toString('base64url')}.fixture`, encryption: null };
        const defaults = createApiSessionSocketStub();
        const transportSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
            transportEvents.push(`socket ${event}`);
            const handler = socket.handlers.get(event);
            if (!handler) return defaults.emitWithAck(event, payload);
            let response: unknown;
            await handler(payload, (value: unknown) => { response = value; });
            return response;
        } });
        socket.emit.mockImplementation((event: string, ...args: unknown[]) => transportSocket.trigger(event, ...args));
        const connection = { connectionType: 'session-scoped' as const, userId: owner.id, sessionId: receiver.id, socket: socket as never };
        eventRouter.addConnection(owner.id, connection);
        onTestFinished(() => eventRouter.removeConnection(owner.id, connection));
        let phase = 'client startup';
        onTestFailed(() => console.error('Queued Discussion withdrawal composition:', { phase, transportEvents }));
        const clientSession = createPlainSessionFixture({ id: receiver.id });
        const client = new ApiSessionClient(credentials.token, { ...clientSession, metadata: { ...clientSession.metadata,
            machineId: machine.id, path: '/repo', permissionMode: 'default', permissionModeUpdatedAt: 0 } }, {
            localMachineId: machine.id, metadataAuthority: { kind: 'owner', credentials }, getServerFeaturesSnapshot: () => features,
            initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
                sessionId: receiver.id, agentRuntimeApplicability: 'not_applicable' })],
            transport: { serverId, serverUrl: origin, createSessionSocketTransport: () => ({ socket: transportSocket as never,
                transport: createSocketTransportAdapter(transportSocket as never) }) },
        });
        const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => JSON.stringify(mode),
            { batcher: combinePermissionModeQueuedPrompts });
        registerPermissionModeMessageQueueBinding({ session: client, queue, getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {} });
        const abort = new AbortController();
        let enterBusy!: () => void;
        let releaseBusy!: () => void;
        const busyEntered = new Promise<void>(resolve => { enterBusy = resolve; });
        const busy = new Promise<void>(resolve => { releaseBusy = resolve; });
        const delivered: string[] = [];
        const failures: unknown[] = [];
        // Only the native Agent transport is replaced. Its real adapter and
        // the common host normalizer produce durable Pending acceptance.
        const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const nativeTurnIds: string[] = [];
        let sequence = 0;
        const nativeSession: AgentSessionRuntime = {
            async send(request) {
                delivered.push(request.input.text);
                nativeTurnIds.push(request.delivery.turnId);
                const emit = (event: AgentSessionRuntimeEvent) => { for (const listener of listeners) listener(event); };
                emit({ sequence: ++sequence, sessionId: receiver.id, emittedAtMs: sequence,
                    kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
                emit({ sequence: ++sequence, sessionId: receiver.id, emittedAtMs: sequence,
                    kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
                const complete = () => emit({ sequence: ++sequence, sessionId: receiver.id, emittedAtMs: sequence,
                    kind: 'turn-complete', turnId: request.delivery.turnId });
                if (delivered.length === 1) { enterBusy(); void busy.then(complete); }
                else complete();
                return { status: 'admitted' };
            },
            watch(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
            dispose: async () => undefined,
        };
        const runtime = createNativeAgentSessionOperations(nativeSession, receiver.id,
            undefined, undefined, undefined, undefined, undefined, {
                // No native control is declared or invoked by this transport fixture.
                context: {} as AgentSessionRuntimeContext, cwd: '/repo', connectedAccounts: [],
                capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
            });
        const outcomes = createSessionProviderInputOutcomeBinding({ getTarget: () => client });
        const unbindOutcomes = bindSessionProviderInputOutcome({ runtime, observe: outcomes.observeProviderInputOutcome,
            wakePendingMaterialization() {} });
        let loop: Promise<void> | undefined;
        let cleanup: Promise<void> | undefined;
        const close = () => cleanup ??= (async () => {
            releaseBusy(); abort.abort(); await loop?.catch(() => undefined); unbindOutcomes();
            await runtime.resetOrDisposeRuntime(); await client.close(); await app.close();
        })();
        onTestFinished(close);
        const enqueue = async (localId: string, text: string, discussion?: Parameters<typeof deriveDiscussionFollowInputLocalIdV1>[0]) => {
            const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
                ...(discussion ? { discussionAddressing: discussion, replyIntent: { mode: 'return' } } : {}) });
            expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: owner.id, sourceMachineId: machine.id,
                targetMachineId: machine.id, sessionId: receiver.id, localId,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text }, meta: withSessionInputRequestV1({}, request) } },
                ...(discussion ? { reply: { mode: 'return', discussion } } : {}), requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1,
            })).toMatchObject({ status: 'accepted', localId });
        };
        try {
            phase = 'canonical publisher startup claim';
            expect(await client.claimCurrentSessionPublisherAuthorityForStartup()).toMatchObject({ status: 'claimed' });
            const busyId = crypto.randomUUID();
            await enqueue(busyId, 'BUSY_NATIVE_PRELUDE');
            phase = 'busy input materialization';
            expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).toMatchObject({ type: 'materialized', localId: busyId });
            loop = runPermissionModePromptLoop({ providerName: 'Test', agentMessageType: 'codex', explicitPermissionMode: undefined,
                session: client, messageQueue: queue, permissionHandler: { setPermissionMode() {}, reset() {} }, runtime,
                createOverrideSynchronizer: () => ({ syncFromMetadata() {}, flushPendingAfterStart: async () => {} }),
                messageBuffer: new MessageBuffer(), shouldExit: () => abort.signal.aborted, getAbortSignal: () => abort.signal,
                keepAlive() {}, setThinking() {}, sendReady() {
                    if (delivered.some(text => text.includes('ORDINARY_AFTER_WITHDRAWAL'))) abort.abort();
                }, currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
                formatPromptErrorMessage: String, onPromptFailure: error => { failures.push(error); },
                registerProviderAcceptedEffect: outcomes.registerProviderAcceptedEffect,
            });
            phase = 'waiting for genuine native work';
            await Promise.race([busyEntered, loop.then(() => { throw new Error('Host loop ended before native work began'); })]);
            const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
                request: { ...postRequest('Queued revoked question'), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant }] } },
                    mentionedSessionIds: [receiver.id] } });
            if (!question.ok) throw new Error(question.error);
            const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: receiver.id };
            const localId = deriveDiscussionFollowInputLocalIdV1(discussion);
            await enqueue(localId, 'REVOKED_DISCUSSION_MUST_NOT_REACH_PROVIDER', discussion);
            phase = 'queued input materialization during native work';
            expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).toMatchObject({ type: 'materialized', localId });
            expect(queue.queue).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ localId, discussionAddressing: discussion }) }));
            expect(delivered).toHaveLength(1);
            expect(await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant } })).toMatchObject({ ok: true });
            expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: discussionId, destinationSessionId: receiver.id } })).toBe(0);
            const ordinaryId = crypto.randomUUID();
            await enqueue(ordinaryId, 'ORDINARY_AFTER_WITHDRAWAL');
            phase = 'quiet withdrawal and ordinary provider continuation';
            releaseBusy();
            await loop;
            await client.flush();
            expect(delivered).toHaveLength(2);
            expect(delivered[1]).toContain('ORDINARY_AFTER_WITHDRAWAL');
            expect(delivered.some(text => text.includes('REVOKED_DISCUSSION_MUST_NOT_REACH_PROVIDER'))).toBe(false);
            expect(failures).toEqual([]);
            expect(transportEvents.filter(event => event.includes('/v1/discussions'))).toEqual([]);
            const transcript = await db.sessionMessage.findMany({ where: { sessionId: receiver.id } });
            expect(JSON.stringify(transcript.map(message => message.content))).not.toContain('turn_failed');
            expect(transcript.find(message => message.localId === localId)?.replyProgress)
                .toMatchObject({ disposition: 'released', outcome: { kind: 'cancelled' } });
            expect(client.hasPendingProviderInput(localId)).toBe(false);
            expect(client.hasPendingProviderInput(busyId)).toBe(false);
            expect(client.hasPendingProviderInput(ordinaryId)).toBe(false);
            expect(transcript.find(message => message.localId === ordinaryId)?.acceptedTurnId).toBe(nativeTurnIds[1]);
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: receiver.id },
                select: { localId: true, status: true, discardedReason: true } }))
                .toEqual([{ localId, status: 'discarded', discardedReason: 'session_input_cancelled' }]);
            expect(await db.session.findUniqueOrThrow({ where: { id: receiver.id },
                select: { pendingCount: true, pendingBlockedCount: true } })).toEqual({ pendingCount: 0, pendingBlockedCount: 0 });
        } finally {
            await close();
        }
    });
    it('never exposes the causal Run as a Discussion destination or accepts its Session-return ACK', async () => {
        const { owner, discussionId } = await fixture();
        const [source, target] = await Promise.all([1, 2].map(() => db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } })));
        for (const session of [source, target]) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id,
            discussionId, request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const sourceSession = { sourceSessionId: source.id, sourceTurnId: 'native-source-turn', sourceInputId: 'native-source-input', via: 'action' as const };
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: sourceSession.sourceInputId, seq: 1,
            messageRole: 'user', content: { t: 'plain', v: {} }, acceptedTurnId: sourceSession.sourceTurnId, targetExecutionRunId: 'native-source-run' } });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            producer: { v: 1, kind: 'agent', sessionId: source.id, sourceSession }, request: { ...postRequest('Question'),
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: target.id } }] } }, mentionedSessionIds: [target.id] } });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: target.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion, sourceSession } }));
        expect(progress).not.toBeNull();
        const machine = await plainMachine(owner.id);
        const requestLocalId = 'original-discussion-input', acceptedTurnId = 'answer-turn';
        await db.sessionMessage.create({ data: { sessionId: target.id, localId: requestLocalId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: {} }, replyDisposition: 'return_pending', replyProgress: { ...progress!, acceptedTurnId, outcome: { kind: 'pass' } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', admittedTarget: { homeId: await getOrCreateServerIdentityId(), accountId: owner.id,
                sessionId: target.id, machineId: machine.id, installationId: machine.installationId! } } } });
        const visible = await inTx(tx => readSessionMessageReplyInTx(tx, { accountId: owner.id, sessionId: target.id, localId: requestLocalId, authentication }));
        expect(visible).toMatchObject({ status: 'available' });
        expect.soft(visible).not.toHaveProperty('returnRecipient');
        const returnedInputLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: target.id, localId: requestLocalId, acceptedTurnId });
        await db.sessionPendingMessage.create({ data: { sessionId: source.id, localId: returnedInputLocalId, position: 0,
            content: { t: 'plain', v: {} }, requestedAction: { v: 1, kind: 'enqueue' }, targetExecutionRunId: 'native-source-run',
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } } });
        expect(await inTx(tx => mutateSessionMessageReplyForMachineInTx(tx, { accountId: owner.id, installationId: machine.installationId!, authentication,
            mutation: { v: 1, machineId: machine.id, requestSessionId: target.id, requestLocalId,
                operation: { kind: 'returned', returnedInputLocalId } } }))).toMatchObject({ ok: false, error: 'conflict' });
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId: requestLocalId } } })).replyProgress)
            .toMatchObject({ disposition: 'return_pending', outcome: { kind: 'pass' } });
    });
    it('creates without a Session and admits only the independently invited Account', async () => {
        const { owner, invitee, outsider, created, discussionId } = await fixture();
        expect(created.discussion).toMatchObject({ ownerAccountId: owner.id, encryptionMode: 'plain', anchor: null, keyReadiness: true, dataEncryptionKey: null, messageSeq: 1 });
        expect(created.firstMessage).toMatchObject({ seq: 1, authorAccountId: owner.id, producerV1: null });
        expect(DiscussionCreateResponseV1Schema.safeParse(created).success).toBe(true);
        expect(await getDiscussion({ authentication, actorAccountId: invitee.id, discussionId })).toMatchObject({ ok: true });
        expect(await getDiscussion({ authentication, actorAccountId: outsider.id, discussionId })).toEqual({ ok: false, error: 'discussion_not_found' });
        expect(await db.session.count({ where: { accountId: owner.id } })).toBe(0);
    });
    it('rejoins concurrent trusted publisher appends and denies the same occurrence after publisher access is revoked', async () => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const { socket, machine } = await publisherSocket(owner.id, session.id);
        const request = postRequest('One trusted occurrence');
        const publish = async () => {
            let response: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, sessionId: session.id, discussionId, request },
                (value: unknown) => { response = value; });
            return DiscussionAgentPostResponseV1Schema.parse(response);
        };
        const replies = await Promise.all([publish(), publish()]);
        expect(replies).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
        if (!replies[0].ok || !replies[1].ok) throw new Error('Trusted append was not admitted');
        expect(replies[1].value.message.id).toBe(replies[0].value.message.id);
        expect(replies[0].value.message).toMatchObject({ seq: 2, localId: request.localId,
            producerV1: { kind: 'agent', sessionId: session.id } });
        expect(await db.discussion.findUniqueOrThrow({ where: { id: discussionId } })).toMatchObject({ messageSeq: 2 });
        await db.accessKey.deleteMany({ where: { accountId: owner.id, machineId: machine.id, sessionId: session.id } });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
    });
    it('atomically creates an Agent first post from actual Session custody and retains producer retry equality without enrolling it', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const other = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const request = createRequest();
        const producer = { v: 1 as const, kind: 'agent' as const, sessionId: session.id, toolCallId: 'create-tool' };
        const input = { authentication, actorAccountId: owner.id, request, producer };
        const result = await createDiscussion(input);
        expect(result).toMatchObject({ ok: true, value: { firstMessage: { seq: 1, producerV1: producer }, discussion: { messageSeq: 1 } } });
        if (!result.ok) throw new Error(result.error);
        const discussionId = result.value.discussion.id;
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(0);
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
        expect(await createDiscussion(input)).toMatchObject({ ok: true, value: { firstMessage: { id: result.value.firstMessage.id, producerV1: producer } } });
        expect(await createDiscussion({ ...input, producer: { ...producer, sessionId: other.id } })).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        expect(await createDiscussion({ authentication, actorAccountId: owner.id, request })).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await createDiscussion({ ...input, actorAccountId: outsider.id, request: createRequest() })).toEqual({ ok: false, error: 'discussion_post_denied' });
        expect(await db.discussion.count({ where: { ownerAccountId: outsider.id } })).toBe(0);
    });
    it('admits Session participants only through actual input authority and pairwise disclosure', async () => {
        const { owner, invitee, outsider, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const invite = () => inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'when_addressed' } });
        await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: outsider.id, accessLevel: 'view' } });
        expect(await invite()).toEqual({ ok: false, error: 'discussion_access_forbidden' });
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(0);
        await db.sessionShare.deleteMany({ where: { sessionId: session.id } });
        expect(await invite()).toMatchObject({ ok: true });
        expect(await invite()).toMatchObject({ ok: true, value: { changed: false } });
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(1);
        expect(await listDiscussionParticipants({ authentication, actorAccountId: owner.id, discussionId })).toMatchObject({ ok: true, value: {
            participants: [{ participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'when_addressed' }],
        } });
        const otherSession = await db.session.create({ data: { accountId: invitee.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionShare.create({ data: { sessionId: otherSession.id, sharedByUserId: invitee.id, sharedWithUserId: owner.id, accessLevel: 'view' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: otherSession.id } } })).toEqual({ ok: false, error: 'discussion_access_forbidden' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
        const detached = await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } });
        expect(detached).toMatchObject({ ok: true, value: { changed: true } });
        expect(detached).not.toHaveProperty('value.ownedSession');
        expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(0);
    });
    it('lets an invited human address the consenting participant without gaining Session control', async () => {
        const { owner, invitee, discussionId } = await fixture();
        const target = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: target.id } } })).toMatchObject({ ok: true });
        expect(await inTx(tx => resolveEffectiveSessionAccess(tx, { accountId: invitee.id, sessionId: target.id, authentication }))).toBeNull();
        const question = await postDiscussionMessage({ authentication, actorAccountId: invitee.id, discussionId, request: {
            localId: crypto.randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: target.id } }] } },
            mentionedAccountIds: [], mentionedSessionIds: [target.id],
        } });
        expect(question).toMatchObject({ ok: true });
        if (!question.ok) throw new Error(question.error);
        const addressing = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: target.id };
        expect(question.value.message.addressingV1).toEqual({ throughSeq: addressing.throughSeq, participantSessionIds: [target.id] });
        expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: target.id,
        }))).observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: target.id, addressing,
            policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' } }]);
        expect(await inTx(tx => resolveEffectiveSessionAccess(tx, { accountId: invitee.id, sessionId: target.id, authentication }))).toBeNull();
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.sessionShare.create({ data: { sessionId: target.id, sharedByUserId: owner.id, sharedWithUserId: outsider.id, accessLevel: 'view' } });
        expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: target.id,
        }))).observations).toEqual([]);
    });
    it('admits a shared Discussion question without granting the receiver its private producer Session', async () => {
        const { owner, invitee, discussionId } = await fixture();
        const source = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const target = await db.session.create({ data: { accountId: invitee.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        // The configuring actor needs actual input permission on the target;
        // the reverse grant to the private source is deliberately absent.
        await db.sessionShare.create({ data: { sessionId: target.id, sharedByUserId: invitee.id, sharedWithUserId: owner.id, accessLevel: 'edit' } });
        for (const session of [source, target]) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        expect(await inTx(tx => resolveEffectiveSessionAccess(tx, { accountId: invitee.id, sessionId: source.id, authentication }))).toBeNull();
        const sourceSession = { sourceSessionId: source.id, sourceTurnId: 'private-native-turn', sourceInputId: 'private-input', via: 'action' as const };
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: sourceSession.sourceInputId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: {} }, acceptedTurnId: sourceSession.sourceTurnId, targetExecutionRunId: 'private-run' } });
        const publisher = await publisherSocket(owner.id, source.id);
        let response: unknown;
        await getSocketHandler(publisher.socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, sessionId: source.id, discussionId, sourceSession,
            request: { ...postRequest('A question, not disclosure of the private transcript'), content: { t: 'plain', v: { v: 1,
                parts: [{ t: 'mention', participant: { kind: 'session', sessionId: target.id } }] } }, mentionedSessionIds: [target.id] } },
            (value: unknown) => { response = value; });
        const posted = DiscussionAgentPostResponseV1Schema.parse(response);
        expect(posted).toMatchObject({ ok: true });
        if (!posted.ok) throw new Error(posted.error);
        const discussion = { discussionId, messageId: posted.value.message.id, throughSeq: posted.value.message.seq, participantSessionId: target.id };
        expect.soft((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: invitee.id, authentication }, destinationSessionId: target.id,
        }))).observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: target.id, addressing: discussion,
            policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' } }]);
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Credential verification is the boundary; the real route, projection,
        // Discussion access and Follow observation run against the same DB.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            request.userId = invitee.id;
            request.authAuthority = 'present_user';
            request.authTokenKind = 'account';
        });
        registerDiscussionRoutes(app);
        try {
            const response = await app.inject({ method: 'GET',
                url: DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId) });
            expect(response.statusCode).toBe(200);
            const page = DiscussionMessagesResponseV1Schema.parse(response.json());
            expect(page.messages.find(message => message.id === discussion.messageId)).not.toHaveProperty('participantDeliveryV1');
        } finally { await app.close(); }
        expect(await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: invitee.id,
            reply: { mode: 'return', discussion, sourceSession } }))).toMatchObject({ discussion, sourceSession, disposition: 'return_pending' });
        expect(await inTx(tx => resolveEffectiveSessionAccess(tx, { accountId: invitee.id, sessionId: source.id, authentication }))).toBeNull();
    });
    it('holds the actual foreign Pending original visibly without starving a later local original on the same Follow attachment', async () => {
        const { owner, invitee, discussionId } = await fixture();
        const receiver = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const foreign = await db.session.create({ data: { accountId: invitee.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const localSource = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionShare.create({ data: { sessionId: foreign.id, sharedByUserId: invitee.id, sharedWithUserId: owner.id, accessLevel: 'edit' } });
        for (const session of [receiver, foreign, localSource]) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const sourceSession = { sourceSessionId: foreign.id, sourceTurnId: 'foreign-turn', sourceInputId: 'foreign-input', via: 'action' as const };
        const localSourceSession = { sourceSessionId: localSource.id, sourceTurnId: 'local-turn', sourceInputId: 'local-input', via: 'action' as const };
        for (const [source, accountId] of [[sourceSession, invitee.id], [localSourceSession, owner.id]] as const) {
            await db.sessionMessage.create({ data: { sessionId: source.sourceSessionId,
                localId: source.sourceInputId, seq: 1, messageRole: 'user', content: { t: 'plain', v: {} },
                acceptedTurnId: source.sourceTurnId, inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: accountId, sessionRelationship: 'owner' } } });
            await db.sessionTurn.create({ data: { sessionId: source.sourceSessionId, turnId: source.sourceTurnId,
                status: 'in_progress', startedAt: 1n, updatedAt: 1n, transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [1] }) } });
        }
        await getOrCreateServerIdentityId();
        const { machine } = await publisherSocket(owner.id, receiver.id);
        const current = await db.session.findUniqueOrThrow({ where: { id: receiver.id } });
        const publisherAuthority = { accountId: owner.id, sessionId: receiver.id, machineId: machine.id, committedFence: current.lastActiveAt };
        const request = () => ({ ...postRequest('Question'), content: { t: 'plain' as const, v: { v: 1,
            parts: [{ t: 'mention', participant: { kind: 'session', sessionId: receiver.id } }] } }, mentionedSessionIds: [receiver.id] });
        const foreignQuestion = await postDiscussionMessage({ authentication, actorAccountId: invitee.id, discussionId,
            producer: { v: 1, kind: 'agent', sessionId: foreign.id, sourceSession }, request: request() });
        if (!foreignQuestion.ok) throw new Error(foreignQuestion.error);
        const local = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            producer: { v: 1, kind: 'agent', sessionId: localSource.id, sourceSession: localSourceSession }, request: request() });
        if (!local.ok) throw new Error(local.error);
        const page = await readDiscussionMessages({ authentication, actorAccountId: invitee.id, discussionId });
        if (page.ok) expect(DiscussionMessagesResponseV1Schema.safeParse(page.value).success).toBe(true);
        expect.soft(page).toMatchObject({ ok: true, value: { messages: expect.arrayContaining([
            expect.objectContaining({ id: foreignQuestion.value.message.id }), expect.objectContaining({ id: local.value.message.id })]) } });
        if (page.ok) for (const message of page.value.messages) expect.soft(message).not.toHaveProperty('participantDeliveryV1');
        const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: receiver.id,
        }));
        for (const [question, source, foreignCause] of [[foreignQuestion, sourceSession, true], [local, localSourceSession, false]] as const) {
            const addressing = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: receiver.id };
            expect.soft((await observe()).observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: receiver.id, addressing,
                policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' } }]);
            const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
            const reply = { mode: 'return' as const, discussion: addressing, sourceSession: source };
            const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
                sourceSession: source, discussionAddressing: addressing, replyIntent: { mode: 'return' } });
            const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Question' }, meta: { happierInputRequestV1: request } } };
            const enqueue = () => enqueuePendingMessageByAuthenticatedMachine({ accountId: owner.id, sourceMachineId: machine.id,
                targetMachineId: machine.id, sessionId: receiver.id, localId, content, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1, reply });
            expect(await enqueue()).toEqual({ status: 'accepted', localId });
            expect(await enqueue()).toEqual({ status: 'alreadyAccepted', localId });
            expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: receiver.id, publisherAuthority,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' })).toMatchObject(
                    foreignCause ? { ok: true, didMaterialize: false } : { ok: true, didMaterialize: true, message: { localId } });
            const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: receiver.id, localId } } });
            const receipt = SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt);
            const finalContent = { ...content, v: { ...content.v, meta: { ...withSessionInputAuthorityV1(content.v.meta, settleSessionInputRequestV1({
                request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt })),
                [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request, requestedProvenance: undefined, inputAdmissionReceipt: receipt }) } } };
            const settlement = await settlePendingInputAdmission({ actorUserId: owner.id, sessionId: receiver.id, localId, publisherAuthority,
                decision: { kind: 'admit', finalContent, validation: { sourceSession: source, reply, autonomousCheckIn: { afterTurns: 5 } } } });
            if (foreignCause) expect(settlement).not.toMatchObject({ result: { status: 'accepted' } });
            else expect(settlement).toMatchObject({ ok: true, result: { status: 'accepted' } });
            const visible = await readDiscussionMessages({ authentication, actorAccountId: invitee.id, discussionId });
            if (!visible.ok) throw new Error(visible.error);
            expect.soft(DiscussionMessagesResponseV1Schema.safeParse(visible.value).success).toBe(true);
            expect.soft(visible.value.messages.find(message => message.id === foreignQuestion.value.message.id)?.participantDeliveryV1)
                .toEqual([{ participantSessionId: receiver.id, disposition: 'held', code: 'session_input_target_unavailable' }]);
            expect.soft(visible.value.messages.find(message => message.id === local.value.message.id)).not.toHaveProperty('participantDeliveryV1');
        }
        for (let scan = 0; scan < 3; scan += 1) expect((await observe()).observations).toEqual([]);
        expect.soft((await db.sessionFollowEdge.findUniqueOrThrow({ where: { destinationSessionId_sourceDiscussionId_relation: {
            destinationSessionId: receiver.id, sourceDiscussionId: discussionId, relation: 'follower' } } })).deliveredTranscriptSeq).toBe(local.value.message.seq);
        expect(await db.discussionMessage.findUnique({ where: { id: foreignQuestion.value.message.id } })).not.toBeNull();
        expect(await db.sessionPendingMessage.count({ where: { sessionId: receiver.id } })).toBe(2);
        await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: receiver.id } } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: receiver.id } } })).toMatchObject({ ok: true });
        const reinvited = await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId });
        if (!reinvited.ok) throw new Error(reinvited.error);
        expect(reinvited.value.messages.find(message => message.id === foreignQuestion.value.message.id)).not.toHaveProperty('participantDeliveryV1');
        expect((await observe()).observations).toEqual([]);
    });
    it('retains a private foreign original as blocked custody without manufacturing permission authority', async () => {
        const { owner, invitee, discussionId } = await fixture();
        const source = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const receiver = await db.session.create({ data: { accountId: invitee.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        // Only the inviter receives input permission; the receiver's owner never
        // receives the source's private transcript or its permission authority.
        await db.sessionShare.create({ data: { sessionId: receiver.id, sharedByUserId: invitee.id, sharedWithUserId: owner.id, accessLevel: 'edit' } });
        for (const session of [source, receiver]) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const sourceSession = { sourceSessionId: source.id, sourceTurnId: 'private-turn', sourceInputId: 'private-input', via: 'action' as const };
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: sourceSession.sourceInputId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: { private: 'never disclose this source' } }, acceptedTurnId: sourceSession.sourceTurnId, targetExecutionRunId: 'private-run' } });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            producer: { v: 1, kind: 'agent', sessionId: source.id, sourceSession }, request: { ...postRequest('Shared question'),
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: receiver.id } }] } }, mentionedSessionIds: [receiver.id] } });
        if (!question.ok) throw new Error(question.error);
        await getOrCreateServerIdentityId();
        const { machine } = await publisherSocket(invitee.id, receiver.id);
        const current = await db.session.findUniqueOrThrow({ where: { id: receiver.id } });
        const publisherAuthority = { accountId: invitee.id, sessionId: receiver.id, machineId: machine.id, committedFence: current.lastActiveAt };
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: receiver.id };
        const localId = deriveDiscussionFollowInputLocalIdV1(discussion);
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Shared question' } } };
        const input = { accountId: invitee.id, sourceMachineId: machine.id, targetMachineId: machine.id, sessionId: receiver.id,
            localId, content, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1, reply: { mode: 'return' as const, discussion, sourceSession } };
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...input, reply: { ...input.reply,
            sourceSession: { ...sourceSession, sourceInputId: 'forged-input' } } })).toMatchObject({ status: 'rejected' });
        const forgedSource = { ...sourceSession, sourceInputId: 'forged-input' };
        const forgedRequest = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
            sourceSession: forgedSource, discussionAddressing: discussion, replyIntent: { mode: 'return' } });
        // Matching caller-authored request/reply fields must not replace the
        // committed producer's causal original or escape its Pending hold.
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...input,
            content: { ...content, v: { ...content.v, meta: { happierInputRequestV1: forgedRequest } } },
            reply: { ...input.reply, sourceSession: forgedSource } })).toMatchObject({ status: 'rejected' });
        expect(await enqueuePendingMessageByAuthenticatedMachine(input)).toEqual({ status: 'accepted', localId });
        expect(await enqueuePendingMessageByAuthenticatedMachine(input)).toEqual({ status: 'alreadyAccepted', localId });
        const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: receiver.id, localId } } });
        expect(pending).toMatchObject({ content, status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'session_input_target_unavailable' });
        expect(pending.content).not.toHaveProperty('v.meta');
        expect(await db.sessionPendingMessage.count({ where: { sessionId: receiver.id } })).toBe(1);
        expect(await materializeNextPendingMessage({ actorUserId: invitee.id, sessionId: receiver.id, publisherAuthority,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' })).toMatchObject({ ok: true, didMaterialize: false });
        expect(await settlePendingInputAdmission({ actorUserId: invitee.id, sessionId: receiver.id, localId, publisherAuthority,
            decision: { kind: 'admit', finalContent: content, validation: { sourceSession, reply: input.reply, autonomousCheckIn: { afterTurns: 5 } } } }))
            .not.toMatchObject({ result: { status: 'accepted' } });
        const page = await readDiscussionMessages({ authentication, actorAccountId: invitee.id, discussionId });
        if (!page.ok) throw new Error(page.error);
        expect(page.value.messages.find(message => message.id === question.value.message.id)?.participantDeliveryV1)
            .toEqual([{ participantSessionId: receiver.id, disposition: 'held', code: 'session_input_target_unavailable' }]);
        expect(await inTx(tx => resolveEffectiveSessionAccess(tx, { accountId: invitee.id, sessionId: source.id, authentication }))).toBeNull();
        expect(JSON.stringify(page.value)).not.toContain('never disclose this source');
    });
    it('does not replay a prior cross-Account question after the same Session is reinvited', async () => {
        const { owner, invitee, discussionId } = await fixture();
        const source = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const receiver = await db.session.create({ data: { accountId: invitee.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionShare.create({ data: { sessionId: receiver.id, sharedByUserId: invitee.id, sharedWithUserId: owner.id, accessLevel: 'edit' } });
        for (const session of [source, receiver]) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const sourceSession = { sourceSessionId: source.id, sourceTurnId: 'original-turn', sourceInputId: 'original-input', via: 'action' as const };
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            producer: { v: 1, kind: 'agent', sessionId: source.id, sourceSession }, request: { localId: crypto.randomUUID(),
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: receiver.id } }] } },
                mentionedAccountIds: [], mentionedSessionIds: [receiver.id] } });
        if (!question.ok) throw new Error(question.error);
        const read = () => readDiscussionMessages({ authentication, actorAccountId: invitee.id, discussionId });
        const beforeRemoval = await read();
        if (!beforeRemoval.ok) throw new Error(beforeRemoval.error);
        expect(beforeRemoval.value.messages.find(message => message.id === question.value.message.id)).not.toHaveProperty('participantDeliveryV1');
        expect(await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: receiver.id } } })).toMatchObject({ ok: true });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: receiver.id } } })).toMatchObject({ ok: true });
        const page = await read();
        if (!page.ok) throw new Error(page.error);
        expect(page.value.messages.find(message => message.id === question.value.message.id)).not.toHaveProperty('participantDeliveryV1');
        expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, { principal: {
            kind: 'destination_runtime', destinationRuntimeAccountId: invitee.id, authentication }, destinationSessionId: receiver.id }))).observations).toEqual([]);
    });
    it('reserves a model slot once before allocation and refuses a changed launch on retry', async () => {
        const { owner, discussionId } = await fixture();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: '{}' } });
        const participantSlotId = crypto.randomUUID();
        const launch = { executionTarget: { serverId: 'home', machineId: machine.id }, directory: { kind: 'path' as const, path: '/tmp' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: { v: 1 as const, ref: { agentTargetKey: 'happier.agent.claude/claude', providerConnectionId: null, modelId: 'selected-model' }, updatedAt: 1 } };
        const request = { participant: { kind: 'model' as const, participantSlotId, launch }, answerPolicy: 'when_addressed' as const };
        const invite = () => inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request });
        const reserved = await invite();
        expect(reserved).toMatchObject({ ok: true, value: { changed: true, modelParticipant: { sessionId: null, launch } } });
        if (reserved.ok) expect(DiscussionInviteResponseV1Schema.safeParse(reserved.value).success).toBe(true);
        expect(await invite()).toMatchObject({ ok: true, value: { changed: false, modelParticipant: { participant: { participantSlotId }, sessionId: null, launch } } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...request, participant: { ...request.participant, launch: { ...launch,
                modelSelection: { ...launch.modelSelection, updatedAt: 2 } } } } }))
            .toMatchObject({ ok: true, value: { changed: false, modelParticipant: { launch } } });
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(1);
        expect(await db.session.count({ where: { accountId: owner.id } })).toBe(0);
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...request, participant: { ...request.participant, launch: { ...launch, title: 'Changed recipe' } } } })).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        const { validateDiscussionParticipantBirthInTx, bindDiscussionParticipantSessionInTx } = await import('./accessService');
        const discussionParticipant = { discussionId, participantSlotId };
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await inTx(tx => validateDiscussionParticipantBirthInTx(tx, { accountId: outsider.id, discussionParticipant, launch })))
            .toMatchObject({ ok: false });
        expect(await inTx(tx => validateDiscussionParticipantBirthInTx(tx, { accountId: owner.id, discussionParticipant,
            launch: { ...launch, title: 'Changed recipe' } }))).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
            originKind: 'discussion', originDiscussionId: discussionId, originDiscussionParticipantSlotId: participantSlotId } });
        const bind = () => inTx(tx => bindDiscussionParticipantSessionInTx(tx, { accountId: owner.id, discussionParticipant, launch, sessionId: session.id }));
        // Selected Workflow models use this same ordinary birth owner. A
        // broader Session audience cannot become an entitled Discussion input
        // destination merely because its slot and creator are correct.
        await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id,
            sharedWithUserId: outsider.id, accessLevel: 'view' } });
        expect(await bind()).toEqual({ ok: false, error: 'discussion_access_forbidden' });
        expect(await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: discussionParticipant } }))
            .toMatchObject({ sessionId: null });
        await db.sessionShare.deleteMany({ where: { sessionId: session.id } });
        expect(await bind()).toMatchObject({ ok: true, value: { sessionId: session.id } });
        expect(await bind()).toMatchObject({ ok: true, value: { sessionId: session.id } });
        expect(await invite()).toMatchObject({ ok: true, value: { changed: false, modelParticipant: { sessionId: session.id } } });
        const aliasLaunch = { ...launch, executionTarget: { ...launch.executionTarget, serverId: 'another-local-home-alias' } };
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...request, participant: { ...request.participant, launch: aliasLaunch } } }))
            .toMatchObject({ ok: true, value: { changed: false, modelParticipant: { sessionId: session.id, launch } } });
        expect(await inTx(tx => bindDiscussionParticipantSessionInTx(tx, { accountId: owner.id, discussionParticipant,
            launch: aliasLaunch, sessionId: session.id }))).toMatchObject({ ok: true, value: { sessionId: session.id, launch } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...request, participant: { ...request.participant, launch: { ...aliasLaunch,
                executionTarget: { ...aliasLaunch.executionTarget, machineId: crypto.randomUUID() } } } } }))
            .toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        const remove = () => removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'model', participantSlotId } } });
        const ownedSession = { discussionId, participantSlotId, sessionId: session.id };
        const removed = await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } });
        expect(removed).toMatchObject({ ok: true, value: { changed: true, ownedSession } });
        if (removed.ok) expect(DiscussionRemoveParticipantResponseV1Schema.safeParse(removed.value).success).toBe(true);
        expect(await remove()).toMatchObject({ ok: true, value: { changed: false, ownedSession } });
        expect(await db.session.findUnique({ where: { id: session.id } })).toMatchObject({ archivedAt: null });
        expect(await listDiscussionParticipants({ authentication, actorAccountId: owner.id, discussionId })).toMatchObject({ ok: true, value: { participants: [] } });
        expect(await bind()).toMatchObject({ ok: false });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: postRequest('Removed model must not post'), producer: { v: 1, kind: 'agent', sessionId: session.id } })).toEqual({ ok: false, error: 'discussion_post_denied' });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Removed model must not receive a question'), mentionedSessionIds: [session.id],
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] } } } }))
            .toEqual({ ok: false, error: 'discussion_invalid_mention' });
    });
    it('readmits an explicitly reinvited owned model Session after ordinary unarchive without reviving retired work or watch policy', async () => {
        const { owner, invitee, outsider, discussionId } = await fixture();
        const participantSlotId = crypto.randomUUID();
        const launch = { executionTarget: { serverId: 'home', machineId: crypto.randomUUID() }, directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const modelRequest = { participant: { kind: 'model' as const, participantSlotId, launch }, answerPolicy: 'watches_and_speaks_up' as const };
        const modelInvite = () => inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: modelRequest });
        expect(await modelInvite()).toMatchObject({ ok: true });
        const origin = { originKind: 'discussion' as const, originDiscussionId: discussionId, originDiscussionParticipantSlotId: participantSlotId };
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
            active: false, ...origin } });
        const { bindDiscussionParticipantSessionInTx } = await import('./accessService');
        expect(await inTx(tx => bindDiscussionParticipantSessionInTx(tx, { accountId: owner.id,
            discussionParticipant: { discussionId, participantSlotId }, launch, sessionId: session.id }))).toMatchObject({ ok: true });
        const original = await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: { discussionId, participantSlotId } } });
        const participant = { kind: 'session' as const, sessionId: session.id };
        const invite = () => inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant } });
        const addressedRequest = () => ({ ...postRequest('Question'), content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'mention', participant }] } }, mentionedSessionIds: [session.id] });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: addressedRequest() });
        if (!question.ok) throw new Error(question.error);
        const retainedRequest = addressedRequest();
        const ask = () => postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: retainedRequest });
        const addressing = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion: addressing } }));
        expect(progress).not.toBeNull();
        const requestLocalId = crypto.randomUUID();
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId: requestLocalId, position: 0,
            content: { t: 'plain', v: {} }, requestedAction: { v: 1, kind: 'enqueue' }, replyProgress: progress!, replyDisposition: 'return_pending' } });
        const ownedSession = { discussionId, participantSlotId, sessionId: session.id };
        const remove = () => removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId, request: { participant } });
        expect(await remove()).toMatchObject({ ok: true, value: { changed: true, ownedSession } });
        expect(await modelInvite()).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: discussionId, destinationSessionId: session.id } })).toBe(0);
        await withAuthenticatedTestApp(registerSessionArchiveRoutes, async app => {
            const archive = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/archive`, headers: { 'x-test-user-id': owner.id } });
            expect(archive.statusCode, archive.body).toBe(200);
            expect(await invite()).toEqual({ ok: false, error: 'discussion_subject_ineligible' });
            expect(await ask()).toEqual({ ok: false, error: 'discussion_invalid_mention' });
            const unarchive = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/unarchive`, headers: { 'x-test-user-id': owner.id } });
            expect(unarchive.statusCode, unarchive.body).toBe(200);
        });
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ active: false, archivedAt: null, ...origin });
        expect(await ask()).toEqual({ ok: false, error: 'discussion_invalid_mention' });
        expect(await modelInvite()).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        expect(await listDiscussionParticipants({ authentication, actorAccountId: owner.id, discussionId }))
            .toMatchObject({ ok: true, value: { participants: [] } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: invitee.id, discussionId, request: { participant } }))
            .toEqual({ ok: false, error: 'discussion_access_forbidden' });
        await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: outsider.id, accessLevel: 'view' } });
        expect(await invite()).toEqual({ ok: false, error: 'discussion_access_forbidden' });
        await db.sessionShare.deleteMany({ where: { sessionId: session.id } });
        const intervening = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: postRequest('While removed') });
        if (!intervening.ok) throw new Error(intervening.error);

        expect(await invite()).toMatchObject({ ok: true, value: { changed: true } });
        expect(await invite()).toMatchObject({ ok: true, value: { changed: false } });
        expect(await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: { discussionId, participantSlotId } } }))
            .toEqual({ ...original, removedAt: null, answerPolicy: 'when_addressed', updatedAt: expect.any(Date) });
        const roster = await listDiscussionParticipants({ authentication, actorAccountId: owner.id, discussionId });
        expect(roster).toMatchObject({ ok: true, value: { participants: [{ participant: { kind: 'model', participantSlotId },
            sessionId: session.id, launch, answerPolicy: 'when_addressed' }] } });
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(1);
        expect(await db.session.count({ where: { accountId: owner.id } })).toBe(1);
        expect(await db.sessionFollowEdge.findUniqueOrThrow({ where: { destinationSessionId_sourceDiscussionId_relation: {
            destinationSessionId: session.id, sourceDiscussionId: discussionId, relation: 'follower' } } }))
            .toMatchObject({ deliveredTranscriptSeq: intervening.value.message.seq });
        const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: session.id,
        }));
        expect((await observe()).observations).toEqual([]);
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } })).replyProgress)
            .toMatchObject({ disposition: 'released', outcome: { kind: 'cancelled' } });
        const staleReplyLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: session.id, localId: requestLocalId });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            producer: { v: 1, kind: 'agent', sessionId: session.id }, replyReturn: { serverId: 'home', requestLocalId },
            request: { ...postRequest('A withdrawn answer'), localId: staleReplyLocalId, replyTarget: { kind: 'message', messageId: addressing.messageId } } }))
            .toMatchObject({ ok: false });
        const newer = await ask();
        if (!newer.ok) throw new Error(newer.error);
        expect(await ask()).toMatchObject({ ok: true, value: { message: { id: newer.value.message.id } } });
        expect(await db.discussionMessage.count({ where: { discussionId, localId: retainedRequest.localId } })).toBe(1);
        expect((await observe()).observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: session.id,
            policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' },
            addressing: { discussionId, messageId: newer.value.message.id, throughSeq: newer.value.message.seq, participantSessionId: session.id } }]);
        expect(await remove()).toMatchObject({ ok: true, value: { changed: true, ownedSession } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant, answerPolicy: 'reads_only' } })).toMatchObject({ ok: true, value: { changed: true } });
        expect(await listDiscussionParticipants({ authentication, actorAccountId: owner.id, discussionId }))
            .toMatchObject({ ok: true, value: { participants: [{ participant: { kind: 'model', participantSlotId }, sessionId: session.id, launch, answerPolicy: 'reads_only' }] } });
        expect(await remove()).toMatchObject({ ok: true, value: { changed: true, ownedSession } });
    });
    it('retires an unbound model invitation by its stable slot without allocating or resurrecting it on retry', async () => {
        const { owner, discussionId } = await fixture();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: '{}' } });
        const participantSlotId = crypto.randomUUID();
        const launch = { executionTarget: { serverId: 'home', machineId: machine.id }, directory: { kind: 'path' as const, path: '/tmp' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } };
        const invite = (slot: string) => inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'model', participantSlotId: slot, launch } } });
        expect(await invite(participantSlotId)).toMatchObject({ ok: true, value: { modelParticipant: { sessionId: null } } });
        const remove = () => removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'model', participantSlotId } } });
        const first = await remove();
        expect(first).toMatchObject({ ok: true, value: { changed: true } });
        expect(first).not.toHaveProperty('value.ownedSession');
        const retired = await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: { discussionId, participantSlotId } } });
        expect(retired.removedAt).not.toBeNull();
        expect(retired.sessionId).toBeNull();
        const retried = await remove();
        expect(retried).toMatchObject({ ok: true, value: { changed: false } });
        expect(retried).not.toHaveProperty('value.ownedSession');
        expect(await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: { discussionId, participantSlotId } } })).toEqual(retired);
        expect(await invite(participantSlotId)).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        expect(await invite(crypto.randomUUID())).toMatchObject({ ok: true, value: { modelParticipant: { sessionId: null } } });
        expect(await listDiscussionParticipants({ authentication, actorAccountId: owner.id, discussionId }))
            .toMatchObject({ ok: true, value: { participants: [{ participant: { kind: 'model' }, sessionId: null }] } });
        expect(await db.session.count({ where: { accountId: owner.id } })).toBe(0);
    });
    it('returns exact owned Session archive operands on retry without archiving independent Sessions', async () => {
        const { owner, discussionId } = await fixture();
        const participantSlotId = crypto.randomUUID();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
            originKind: 'discussion', originDiscussionId: discussionId, originDiscussionParticipantSlotId: participantSlotId } });
        const independent = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: independent.id } } })).toMatchObject({ ok: true });
        // A real persisted binding isolates archive's storage contract from birth.
        await db.discussionParticipant.create({ data: { discussionId, participantSlotId, sessionId: session.id, createdByAccountId: owner.id,
            modelLaunch: { executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/tmp' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } } });
        const ownedSessions = [{ discussionId, participantSlotId, sessionId: session.id }];
        expect(await archiveDiscussion({ authentication, actorAccountId: owner.id, discussionId }))
            .toMatchObject({ ok: true, value: { ownedSessions } });
        expect(await archiveDiscussion({ authentication, actorAccountId: owner.id, discussionId }))
            .toMatchObject({ ok: true, value: { ownedSessions } });
        expect(await db.session.findUnique({ where: { id: session.id } })).toMatchObject({ archivedAt: null });
        expect(await db.session.findUnique({ where: { id: independent.id } })).toMatchObject({ archivedAt: null });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: postRequest('Archived Discussion must not accept another question') })).toEqual({ ok: false, error: 'discussion_archived' });
    });
    it('uses the Follow attachment sequence, not equal millisecond timestamps, across reinvitation', async () => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const invite = () => inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } });
        expect(await invite()).toMatchObject({ ok: true });
        const ask = () => postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Question'), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] } },
                mentionedSessionIds: [session.id] } });
        const prior = await ask();
        if (!prior.ok) throw new Error(prior.error);
        await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } });
        expect(await invite()).toMatchObject({ ok: true });
        const binding = await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_sessionId: { discussionId, sessionId: session.id } } });
        // A real database Date millisecond is not a total-order boundary: old
        // and new originals are deliberately indistinguishable by timestamp.
        await db.discussionMessage.update({ where: { id: prior.value.message.id }, data: { createdAt: binding.createdAt } });
        const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: session.id,
        }));
        expect((await observe()).observations).toEqual([]);
        const newer = await ask();
        if (!newer.ok) throw new Error(newer.error);
        await db.discussionMessage.update({ where: { id: newer.value.message.id }, data: { createdAt: binding.createdAt } });
        expect((await observe()).observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: session.id,
            policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' },
            addressing: { discussionId, messageId: newer.value.message.id, throughSeq: 3, participantSessionId: session.id } }]);
    });
    it('suppresses a muted sender original without masking a later eligible Discussion question', async () => {
        const { owner, discussionId } = await fixture();
        const [sender, receiver] = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } })));
        for (const session of [sender, receiver]) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const request = () => ({ ...postRequest('Question'), content: { t: 'plain' as const, v: { v: 1, parts: [
            { t: 'mention', participant: { kind: 'session', sessionId: receiver.id } },
        ] } }, mentionedSessionIds: [receiver.id] });
        const muted = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            producer: { v: 1, kind: 'agent', sessionId: sender.id }, request: request() });
        if (!muted.ok) throw new Error(muted.error);
        await db.session.update({ where: { id: receiver.id }, data: { deliveryMutes: JSON.stringify([{ kind: 'sender_session', sessionId: sender.id }]) } });
        const later = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: request() });
        if (!later.ok) throw new Error(later.error);
        const pending = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: receiver.id,
        }));
        expect(pending.observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: receiver.id,
            policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' },
            addressing: { discussionId, messageId: muted.value.message.id, throughSeq: 2, participantSessionId: receiver.id } }]);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: receiver.id } })).toBe(0);
        const { machine, socket, presence } = await publisherSocket(owner.id, receiver.id);
        await db.session.update({ where: { id: receiver.id }, data: {
            metadata: JSON.stringify({ machineId: machine.id, path: '/repo' }),
        } });
        const suppressedAddressing = { discussionId, messageId: muted.value.message.id, throughSeq: 2, participantSessionId: receiver.id };
        const suppressedLocalId = deriveDiscussionFollowInputLocalIdV1(suppressedAddressing);
        const requestAdmission = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
            discussionAddressing: suppressedAddressing, replyIntent: { mode: 'return' } });
        try {
            expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: owner.id, sourceMachineId: machine.id,
                targetMachineId: machine.id, sessionId: receiver.id, localId: suppressedLocalId,
                requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1, reply: { mode: 'return', discussion: suppressedAddressing },
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Suppressed question' },
                    meta: withSessionInputRequestV1({}, requestAdmission) } } }))
                .toEqual({ status: 'rejected', code: 'session_input_muted' });
        } finally {
            await presence.forgetDisconnectedPublisher({ socket });
        }
        expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: receiver.id,
        }))).observations).toEqual([{ source: { kind: 'discussion', discussionId }, destinationSessionId: receiver.id,
            policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' },
            addressing: { discussionId, messageId: later.value.message.id, throughSeq: 3, participantSessionId: receiver.id } }]);
        const addressing = { discussionId, messageId: later.value.message.id, throughSeq: 3, participantSessionId: receiver.id };
        const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
        await inTx(async tx => {
            expect(await admitDiscussionFollowAddressingInTx(tx, { accountId: owner.id, discussion: addressing })).toBe(true);
            const progress = await createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion: addressing } });
            expect(progress).not.toBeNull();
            await tx.sessionPendingMessage.create({ data: { sessionId: receiver.id, localId, position: 1,
                content: { t: 'plain', v: {} }, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1,
                replyProgress: progress!, replyDisposition: progress!.disposition,
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', discussionAddressing: addressing,
                    admittedTarget: { homeId: 'home', accountId: owner.id, sessionId: receiver.id, machineId: 'machine', installationId: 'installation' } } } });
            await acknowledgeDiscussionFollowInputInTx(tx, { addressing, localInputId: localId });
        });
        await db.session.update({ where: { id: receiver.id }, data: { deliveryMutes: null } });
        expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: receiver.id,
        }))).observations).toEqual([]);
        expect(await db.sessionPendingMessage.findMany({ where: { sessionId: receiver.id, status: 'queued' } })).toHaveLength(1);
        expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: receiver.id, localId: suppressedLocalId } } }))
            .toMatchObject({ status: 'discarded', discardedReason: 'session_input_muted' });
    });
    it('admits a host-reviewed draft only while the deciding reviewer retains current publication access', async () => {
        const { owner, invitee, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'drafts_for_approval' } })).toMatchObject({ ok: true });
        const { socket } = await publisherSocket(owner.id, session.id);
        // This is the existing trusted-host socket boundary. Private V2 review
        // and exact Artifact/body binding are exercised by the CLI replay suite.
        const artifactId = crypto.randomUUID();
        await db.artifact.create({ data: { id: artifactId, accountId: owner.id,
            kind: deriveArtifactStoredKindV1({ kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn }), approvalSessionId: session.id,
            header: new Uint8Array([0]), body: new Uint8Array([0]), dataEncryptionKey: new Uint8Array([0]) } });
        const publish = async (request = postRequest('Reviewed draft')) => {
            let response: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, sessionId: session.id, discussionId,
                request, draftReview: { artifactId, decidingAccountId: invitee.id } },
            (value: unknown) => { response = value; });
            return DiscussionAgentPostResponseV1Schema.parse(response);
        };
        const request = postRequest('Reviewed draft');
        expect(await publish(request)).toMatchObject({ ok: true, value: { message: { authorAccountId: owner.id, producerV1: { sessionId: session.id } } } });
        expect(await publish(request)).toMatchObject({ ok: true });
        expect(await setDiscussionGrant({ authentication, actorAccountId: owner.id, discussionId,
            request: { principal: { kind: 'account', accountId: invitee.id }, accessLevel: 'view' } })).toMatchObject({ ok: true });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        await removeDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'account', accountId: invitee.id } } });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
    });
    it.each(['primary', 'typed_pass'] as const)('settles the exact watch terminal quietly without preparing an automatic final publication (%s)', async boundary => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'watches_and_speaks_up' } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: postRequest('Observe') });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion } }));
        const localId = deriveDiscussionFollowInputLocalIdV1(discussion), turnId = crypto.randomUUID();
        await db.sessionMessage.create({ data: { sessionId: session.id, localId, seq: 1, messageRole: 'user', content: { t: 'plain', v: {} },
            replyDisposition: 'return_pending', replyProgress: { ...progress!, acceptedTurnId: turnId } } });
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 2, messageRole: 'agent', content: { t: 'plain', v: {} } } });
        if (boundary === 'primary') {
            await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, { sessionId: session.id, turnId, status: 'completed',
                transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [1], finalAssistantMessageSeq: 2 }) }));
        } else {
            const { socket } = await publisherSocket(owner.id, session.id);
            let response: unknown;
            await getSocketHandler(socket, SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)({ v: 1, sessionId: session.id,
                requestSessionId: session.id, requestLocalId: localId, operation: { kind: 'fulfill', turnId, outcome: { kind: 'pass' } } },
            (value: unknown) => { response = value; });
            expect(SessionMessageReplyMutationResultV1Schema.parse(response)).toMatchObject({ ok: true });
        }
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } })).replyProgress)
            .toMatchObject({ disposition: 'released', outcome: { kind: boundary === 'primary' ? 'answer' : 'pass' } });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
    });
    it.each([false, true])('counts ambient watch starts through the existing Pending check-in root (explicit person address: %s)', async explicitlyAddressed => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'watches_and_speaks_up' } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: {
            ...postRequest('An observation'), ...(explicitlyAddressed ? {
                content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] } },
                mentionedSessionIds: [session.id],
            } : {}),
        } });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion } }));
        expect(progress).not.toBeNull();
        const { socket, machine } = await publisherSocket(owner.id, session.id);
        const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
            discussionAddressing: discussion, replyIntent: { mode: 'return' } });
        const receipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine', discussionAddressing: discussion,
            admittedTarget: { homeId: await getOrCreateServerIdentityId(), accountId: owner.id, sessionId: session.id, machineId: machine.id, installationId: machine.installationId! } });
        const pendingContent = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Observe quietly' },
            meta: withSessionInputRequestV1({}, request) } };
        const finalContent = { t: 'plain' as const, v: { ...pendingContent.v,
            meta: { ...withSessionInputAuthorityV1(pendingContent.v.meta, settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt })),
                [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request, requestedProvenance: undefined, inputAdmissionReceipt: receipt }) } } };
        const localId = deriveDiscussionFollowInputLocalIdV1(discussion);
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId, position: 0, deliveryState: 'delivering',
            content: pendingContent, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1, inputAdmissionReceipt: receipt,
            replyProgress: progress!, replyDisposition: 'return_pending' } });
        let response: unknown;
        await getSocketHandler(socket, SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1)({ v: 1, sessionId: session.id, localId,
            decision: { kind: 'admit', finalContent, validation: { autonomousCheckIn: { afterTurns: 5 }, reply: { mode: 'return', discussion } } } },
        (value: unknown) => { response = value; });
        expect(SessionPendingAdmissionSettlementResponseV1Schema.parse(response).result).toEqual({ status: 'accepted', localId });
        if (explicitlyAddressed) {
            expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } }))
                .toMatchObject({ autonomousExchangeCause: null, autonomousExchangeRootSessionId: null, autonomousExchangeRootLocalId: null });
            return;
        }
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } }))
            .toMatchObject({ autonomousExchangeCause: 'agent_session', autonomousExchangeRootSessionId: session.id,
                autonomousExchangeRootLocalId: localId, autonomousExchangeState: { observedStarts: 0, afterTurns: 5 } });
        const turnId = crypto.randomUUID();
        await inTx(async tx => {
            await tx.sessionTurn.create({ data: { sessionId: session.id, turnId, status: 'running',
                startedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
            await tx.sessionMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } },
                data: { acceptedTurnId: turnId, acceptedTurnKind: 'newTurn' } });
            await reconcileAutonomousExchangeAcceptedTurnInTx(tx, { sessionId: session.id, turnId, startingInputId: localId });
            await reconcileAutonomousExchangeAcceptedTurnInTx(tx, { sessionId: session.id, turnId, startingInputId: localId });
        });
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } })).autonomousExchangeState)
            .toMatchObject({ observedStarts: 1 });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
    });
    it('sets existing participant policy through the canonical HTTP mutation and roster, denying non-admin and non-members', async () => {
        const { owner, invitee, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        let actorAccountId = invitee.id;
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Only credential verification is replaced; route, policy, grants and DB remain real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            request.userId = actorAccountId; request.authAuthority = 'present_user'; request.authTokenKind = 'account';
        });
        registerDiscussionRoutes(app);
        const url = `/v1/discussions/${discussionId}/participants/policy`;
        const payload = { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'reads_only' };
        try {
            expect((await app.inject({ method: 'PUT', url, payload })).statusCode).toBe(403);
            actorAccountId = owner.id;
            expect((await app.inject({ method: 'PUT', url, payload })).statusCode).toBe(200);
            const roster = await app.inject({ method: 'GET', url: DISCUSSION_HTTP_PATHS_V1.participants.replace(':discussionId', discussionId) });
            expect(roster.json()).toMatchObject({ participants: [{ participant: payload.participant, answerPolicy: 'reads_only' }] });
            expect((await app.inject({ method: 'PUT', url, payload })).json()).toMatchObject({ changed: false });
            expect((await app.inject({ method: 'PUT', url, payload: { ...payload, participant: { kind: 'session', sessionId: 'not-invited' } } })).statusCode).toBe(400);
            expect((await app.inject({ method: 'PUT', url, payload: { ...payload, reviewed: true } })).statusCode).toBe(400);
        } finally { await app.close(); }
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(1);
    });
    it('admits addressed drafts and opt-in watch originals through C1 while reads-only and own echoes stay silent', async () => {
        const { owner, discussionId } = await fixture();
        const draft = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const watcher = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const reader = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        for (const [sessionId, answerPolicy] of [[draft.id, 'drafts_for_approval'], [watcher.id, 'watches_and_speaks_up'], [reader.id, 'reads_only']] as const) {
            expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
                request: { participant: { kind: 'session', sessionId }, answerPolicy } })).toMatchObject({ ok: true });
        }
        const asked = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: {
            ...postRequest('Review please'), content: { t: 'plain', v: { v: 1, parts: [draft.id, reader.id].map(sessionId => ({ t: 'mention', participant: { kind: 'session', sessionId } })) } },
            mentionedSessionIds: [draft.id, reader.id] } });
        if (!asked.ok) throw new Error(asked.error);
        expect(asked.value.message.addressingV1?.participantSessionIds).toEqual([draft.id, watcher.id].sort());
        for (const sessionId of [draft.id, watcher.id]) {
            const observed = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: sessionId,
            }));
            expect(observed.observations).toContainEqual({ source: { kind: 'discussion', discussionId }, destinationSessionId: sessionId,
                policy: { preset: 'quiet' }, event: sessionId === watcher.id ? { kind: 'person_wrote' } : { kind: 'needs_you', type: 'decision', mode: 'wait' },
                addressing: { discussionId, messageId: asked.value.message.id, throughSeq: asked.value.message.seq, participantSessionId: sessionId } });
        }
        expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: reader.id,
        }))).observations).toEqual([]);
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: postRequest('Private draft'), producer: { v: 1, kind: 'agent', sessionId: draft.id } })).toEqual({ ok: false, error: 'discussion_post_denied' });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: postRequest('Reads-only cannot speak'), producer: { v: 1, kind: 'agent', sessionId: reader.id } })).toEqual({ ok: false, error: 'discussion_post_denied' });
        const own = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: postRequest('Watch contribution'), producer: { v: 1, kind: 'agent', sessionId: watcher.id } });
        expect(own).toMatchObject({ ok: true, value: { message: { addressingV1: { participantSessionIds: [] } } } });
        expect(await setDiscussionParticipantPolicy({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: watcher.id }, answerPolicy: 'when_addressed' } })).toMatchObject({ ok: true });
        expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: watcher.id,
        }))).observations).toEqual([]);
    });
    it('delivers a native Discussion-origin addressed post through the real Follow intake and Pending owner', async () => {
        const { owner, discussionId } = await fixture();
        const source = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const target = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        for (const session of [source, target]) expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const initial = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: {
            ...postRequest('Person-started question'), mentionedSessionIds: [source.id], content: { t: 'plain', v: { v: 1,
                parts: [{ t: 'mention', participant: { kind: 'session', sessionId: source.id } }] } } } });
        if (!initial.ok) throw new Error(initial.error);
        const originalAddressing = { discussionId, messageId: initial.value.message.id, throughSeq: initial.value.message.seq, participantSessionId: source.id };
        const sourceInputId = deriveDiscussionFollowInputLocalIdV1(originalAddressing);
        const sourceTurnId = 'discussion-origin-native-turn';
        const { socket, machine } = await publisherSocket(owner.id, source.id);
        const targetPublisher = await publisherSocket(owner.id, target.id);
        const serverId = await getOrCreateServerIdentityId();
        const host = buildTrustedHostSessionInputAdmissionV1('agent');
        const request = SessionInputRequestV1Schema.parse({ ...host.request, discussionAddressing: originalAddressing, replyIntent: { mode: 'return' },
            actionRequestAttributionV1: { requestRef: sourceInputId, requester: { serverId, accountId: owner.id },
                persona: { serverId, sessionId: source.id }, origin: { kind: 'discussion', discussion: { serverId, discussionId }, messageId: initial.value.message.id } } });
        const receipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine', discussionAddressing: originalAddressing,
            admittedTarget: { homeId: serverId, accountId: owner.id, sessionId: source.id, machineId: machine.id, installationId: machine.installationId } });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: sourceInputId, seq: 1, messageRole: 'user', acceptedTurnId: sourceTurnId,
            inputAdmissionReceipt: receipt, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original question' },
                meta: withSessionInputAuthorityV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance },
                    settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'read-only', inputAdmissionReceipt: receipt })) } } } });
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: sourceTurnId, status: 'completed', startedAt: 1n, updatedAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [1] }) } });
        const sourceSession = { sourceSessionId: source.id, sourceTurnId, sourceInputId, via: 'action' as const, discussionAddressing: originalAddressing };
        for (let start = 0; start < 3; start++) {
            let response: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 1, sessionId: source.id, discussionId, sourceSession,
                request: { ...postRequest('Agent question'), mentionedSessionIds: [target.id], content: { t: 'plain', v: { v: 1,
                    parts: [{ t: 'mention', participant: { kind: 'session', sessionId: target.id } }] } } } }, (value: unknown) => { response = value; });
            const posted = DiscussionAgentPostResponseV1Schema.parse(response);
            expect(posted).toMatchObject({ ok: true });
            if (!posted.ok) throw new Error(posted.error);
            const observed = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: target.id }));
            const observation = observed.observations.find(row => 'source' in row);
            if (!observation || !('source' in observation)) throw new Error('Addressed target observation missing');
            const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
            app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
            // Only authentication and the Machine socket are replaced. Resource
            // reads, opening, protected admission and database acceptance are real.
            app.decorate('authenticate', async (httpRequest: FastifyRequest) => {
                httpRequest.userId = owner.id; httpRequest.authAuthority = 'present_user'; httpRequest.authTokenKind = 'account';
            });
            registerDiscussionRoutes(app); registerAccountEncryptionRoutes(app); registerSessionListingRoutes(app);
            registerSessionLookupByTagsRoute(app); registerSessionFollowRoutes(app); registerSessionMessageRoutes(app);
            const origin = 'http://discussion-follow-composed.test';
            const restoreHttp = installAxiosFastifyAdapter({ app, origin });
            const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: owner.id })).toString('base64url')}.fixture`, encryption: null };
            const admissions: string[] = [];
            const session = createMutableApiSessionClientFixture({ sessionId: target.id, overrides: {
                getServerBinding: () => ({ serverId, serverUrl: origin }),
                getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                    sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
                    capabilities: { serverIdentity: { serverIdentityId: serverId } } }) }),
                runSessionFollowSourceRequest: ({ request: read }) => runWithServerHttpBaseUrl(origin, read),
                getMachineAdmissionTransport: () => async payload => {
                    const result = await enqueuePendingMessageByAuthenticatedMachine({ ...SessionPendingEnqueueByMachineRequestV1Schema.parse(payload),
                        accountId: owner.id, sourceMachineId: machine.id });
                    admissions.push(result.status === 'rejected' ? result.code : result.status);
                    return result;
                },
            } });
            try {
                // Current placement is supplied by the real Session read owner.
                await db.session.update({ where: { id: target.id }, data: { active: true,
                    metadata: JSON.stringify({ machineId: targetPublisher.machine.id, path: '/repo', claudeSessionId: 'target-native' }) } });
                const intake = createDiscussionFollowInputIntake({ session, credentials });
                expect(await intake({ observation, signal: new AbortController().signal }), JSON.stringify(admissions)).toBe(true);
                const localId = deriveDiscussionFollowInputLocalIdV1(observation.addressing);
                expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: target.id, localId } } }))
                    .toMatchObject({ replyProgress: { sourceSession, discussion: observation.addressing }, inputAdmissionReceipt: { discussionAddressing: observation.addressing } });
                expect((await db.sessionFollowEdge.findFirstOrThrow({ where: { destinationSessionId: target.id, sourceDiscussionId: discussionId } })).deliveredTranscriptSeq)
                    .toBe(posted.value.message.seq);
                const current = await db.session.findUniqueOrThrow({ where: { id: target.id } });
                const publisherAuthority = { accountId: owner.id, sessionId: target.id,
                    machineId: targetPublisher.machine.id, committedFence: current.lastActiveAt };
                expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: target.id, publisherAuthority,
                    deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' }))
                    .toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
                const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId } } });
                if (pending.content.t !== 'plain') throw new Error('Expected plain test input');
                const body = pending.content.v as Record<string, unknown>;
                const targetRequest = SessionInputRequestV1Schema.parse(readSessionInputRequest(body.meta, 'stored'));
                const targetReceipt = SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt);
                const finalContent = { t: 'plain' as const, v: { ...body, meta: {
                    ...withSessionInputAuthorityV1(body.meta, settleSessionInputRequestV1({ request: targetRequest,
                        currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: targetReceipt })),
                    [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request: targetRequest,
                        requestedProvenance: readSessionMessageProvenance(body.meta, 'stored'), inputAdmissionReceipt: targetReceipt }),
                } } };
                let settlement: unknown;
                await getSocketHandler(targetPublisher.socket, SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1)({ v: 1,
                    sessionId: target.id, localId, decision: { kind: 'admit', finalContent,
                        validation: { sourceSession, reply: { mode: 'return', sourceSession, discussion: observation.addressing,
                            ...(targetRequest.actionRequestAttributionV1 ? { actionRequestAttributionV1: targetRequest.actionRequestAttributionV1 } : {}) },
                        autonomousCheckIn: { afterTurns: 2 } } } }, (value: unknown) => { settlement = value; });
                const settled = SessionPendingAdmissionSettlementResponseV1Schema.parse(settlement);
                if (start === 2) {
                    expect(settled.result).toMatchObject({ status: 'held', code: 'autonomous_check_in' });
                    expect(await db.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: target.id, localId } } }))
                        .toBeNull();
                    expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: source.id, localId: sourceInputId } } }))
                        .autonomousExchangeState).toMatchObject({ observedStarts: 2 });
                    continue;
                }
                expect(settled, settled.result.status === 'rejected' || settled.result.status === 'held' ? settled.result.code : settled.result.status)
                    .toMatchObject({ v: 1, result: { status: 'accepted', localId } });
                expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId } } }))
                    .toMatchObject({ autonomousExchangeRootSessionId: source.id, autonomousExchangeRootLocalId: sourceInputId,
                        autonomousExchangeCause: 'agent_session' });
                // The person's initial Discussion wake is not an autonomous start.
                expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: source.id, localId: sourceInputId } } }))
                    .toMatchObject({ autonomousExchangeCause: null, autonomousExchangeState: { afterTurns: 2, observedStarts: start } });
                // The real native adapter must expose its immutable input witness
                // while the real host lifecycle consumes the synchronous start.
                let emitNative: ((event: AgentSessionRuntimeEvent) => void) | undefined;
                let sequence = 0;
                const nativeOperations = createNativeAgentSessionOperations({
                    async send(input) {
                        emitNative?.({ sequence: ++sequence, sessionId: target.id, emittedAtMs: sequence,
                            kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                        emitNative?.({ sequence: ++sequence, sessionId: target.id, emittedAtMs: sequence,
                            kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
                        return { status: 'admitted' };
                    },
                    watch(listener) { emitNative = listener; return { dispose() { emitNative = undefined; } }; },
                    dispose() {},
                }, target.id, undefined, undefined, undefined, undefined, undefined, {
                    context: {} as AgentSessionRuntimeContext, cwd: '/repo', connectedAccounts: [],
                    capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                    cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
                });
                // Ordinary native Sessions always cross the replaceable host
                // adapter. A raw native→lifecycle fixture hides a lost reader.
                const plan = await createNativeAgentHostSessionRuntimePlan({
                    backend: { id: 'codex', agentId: 'codex', provenance: 'first_party', source: { kind: 'bundled' },
                        definition: { kindVersion: 1, id: 'codex', agentId: 'codex' } },
                    agent: { id: 'codex', provenance: 'first_party', source: { kind: 'bundled' },
                        definition: { kindVersion: 1, id: 'codex', ownedBackendIds: ['codex'] } },
                    sessionInput: buildPluginSessionBindingInput({ credentials, startedBy: 'daemon', startingMode: 'remote' }),
                    createSessionRuntime: async () => nativeOperations,
                });
                const created = await plan.config.createSessionRuntime?.({ directory: '/repo', metadata: session.getMetadataSnapshot()!,
                    machineId: targetPublisher.machine.id, agentTargetKey: 'agent:happier.agent.codex/codex', session,
                    transcriptSession: session, messageBuffer: new MessageBuffer(), mcpServers: {},
                    currentSessionPresentation: createCurrentSessionPresentationHost({ session,
                        signal: new AbortController().signal }).bindCurrentSession,
                    permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Discussion test]' }),
                    getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
                    runnerProcessIdentity: null, startupModelSelection: null,
                    runWithTerminalModelSelection: async effect => ({ status: 'completed',
                        value: await effect(null, async localEffect => ({ status: 'completed', value: await localEffect() })) }),
                });
                const runtime = created?.nativeRuntime;
                if (!runtime) throw new Error('Missing replaceable native runtime');
                const turnId = `discussion-accepted-${start}`;
                const applied: boolean[] = [];
                const lifecycle = createSessionTurnLifecycle({ agentId: 'codex',
                    readTurnFacts: () => ({ initiator: 'agent_session', workDepth: 1 }),
                    readStartingInput: id => {
                        const inputId = runtime.readTurnStartingInputId?.(id);
                        return inputId ? { turnId: id, inputId } : null;
                    },
                    session: { sessionId: target.id, enqueueSessionTurnMutation: async mutation => {
                        applied.push((await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation })).ok);
                    } },
                });
                const unsubscribe = runtime.subscribeRuntimeEvents(event => lifecycle.observeRuntimeEvent(event));
                try {
                    await runtime.sendTurnPrompt('Addressed agent question', { localId, turnId, userMessageSeq: 1 });
                    await lifecycle.drainAcceptedLifecycle();
                    expect(applied).toEqual([true]);
                    const accepted = { actorUserId: owner.id, sessionId: target.id, localId, publisherAuthority,
                        acceptedTurn: { kind: 'newTurn' as const, turnId } };
                    expect(await resolveAcceptedPendingDelivery(accepted)).toMatchObject({ ok: true, didResolve: true });
                    expect(await resolveAcceptedPendingDelivery(accepted)).toMatchObject({ ok: true, didResolve: false });
                    expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: source.id, localId: sourceInputId } } }))
                        .autonomousExchangeState).toMatchObject({ afterTurns: 2, observedStarts: start + 1 });
                    expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId } } }))
                        .toMatchObject({ turnStartWitnessId: turnId, acceptedTurnCounted: true });
                } finally { unsubscribe(); await runtime.resetOrDisposeRuntime('runtime_recovery'); }
            } finally { restoreHttp(); await app.close(); }
        }
    });
    it('commits one immutable addressed set and cutoff, with reply addressing and silent negative controls', async () => {
        const { owner, discussionId } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const reader = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        for (const [sessionId, answerPolicy] of [[session.id, 'when_addressed'], [reader.id, 'reads_only']] as const) {
            expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
                request: { participant: { kind: 'session', sessionId }, answerPolicy } })).toMatchObject({ ok: true });
        }
        const request = { ...postRequest('Question'), content: { t: 'plain' as const, v: { v: 1, parts: [session.id, reader.id].map(sessionId => ({ t: 'mention', participant: { kind: 'session', sessionId } })) } }, mentionedSessionIds: [session.id, reader.id] };
        const asked = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request });
        expect(asked).toMatchObject({ ok: true, value: { message: { addressingV1: { throughSeq: 2, participantSessionIds: [session.id] } } } });
        if (!asked.ok) throw new Error(asked.error);
        expect(DiscussionPostResponseV1Schema.safeParse(asked.value).success).toBe(true);
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request })).toMatchObject({ ok: true, value: { message: { id: asked.value.message.id, addressingV1: { throughSeq: 2 } } } });
        const answered = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: postRequest('Answer'), producer: { v: 1, kind: 'agent', sessionId: session.id } });
        if (!answered.ok) throw new Error(answered.error);
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('A self reply without a new explicit address'), replyTarget: { kind: 'message', messageId: answered.value.message.id } },
            producer: { v: 1, kind: 'agent', sessionId: session.id } })).toMatchObject({ ok: true,
                value: { message: { addressingV1: { throughSeq: 4, participantSessionIds: [] } } } });
        expect((await db.discussion.findUniqueOrThrow({ where: { id: discussionId } })).messageSeq).toBe(4);
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(4);
        const asker = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: asker.id } } })).toMatchObject({ ok: true });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Explicit new ask'), replyTarget: { kind: 'message', messageId: answered.value.message.id },
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] } },
                mentionedSessionIds: [session.id] }, producer: { v: 1, kind: 'agent', sessionId: asker.id } })).toMatchObject({
            ok: true, value: { message: { producerV1: { sessionId: asker.id }, addressingV1: { throughSeq: 5, participantSessionIds: [session.id] } } },
        });
        const replied = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...postRequest('Follow up'), replyTarget: { kind: 'message', messageId: answered.value.message.id } } });
        expect(replied).toMatchObject({ ok: true, value: { message: { addressingV1: { throughSeq: 6, participantSessionIds: [session.id] } } } });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: postRequest('Unaddressed') })).toMatchObject({ ok: true, value: { message: { addressingV1: { participantSessionIds: [] } } } });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(7);
        const observed = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: session.id,
        }));
        expect(observed.observations).toContainEqual({ source: { kind: 'discussion', discussionId }, destinationSessionId: session.id,
            policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' },
            addressing: { discussionId, messageId: asked.value.message.id, throughSeq: 2, participantSessionId: session.id } });
        const uninvited = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: { ...request, localId: crypto.randomUUID(), mentionedSessionIds: [uninvited.id], content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: uninvited.id } }] } } } })).toEqual({ ok: false, error: 'discussion_invalid_mention' });
    });
    it('rejoins independent creation and first-message IDs and refuses changed semantic intent', async () => {
        const { owner, request, created, discussionId } = await fixture();
        expect(await createDiscussion({ authentication, actorAccountId: owner.id, request })).toMatchObject({ ok: true, value: { discussion: { id: discussionId }, firstMessage: { id: created.firstMessage.id } } });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
        expect(await createDiscussion({ authentication, actorAccountId: owner.id, request: { ...request, firstMessage: { ...request.firstMessage, content: { t: 'plain', v: document('Different') } } } })).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        const other = await fixture({ creationLocalId: request.creationLocalId, firstLocalId: request.firstMessage.localId });
        expect(other.discussionId).not.toBe(discussionId);
    });
    it('posts one attributed reply, reuses its identity and produces a committed Home reference', async () => {
        const { owner, invitee, created, discussionId } = await fixture();
        const request = { ...postRequest('Reply'), replyTarget: { kind: 'message' as const, messageId: created.firstMessage.id } };
        const posted = await postDiscussionMessage({ authentication, actorAccountId: invitee.id, discussionId, request });
        expect(posted.ok).toBe(true);
        if (!posted.ok) return;
        expect(DiscussionPostResponseV1Schema.safeParse(posted.value).success).toBe(true);
        expect(posted.value.message).toMatchObject({ seq: 2, replyTarget: request.replyTarget, authorAccountId: invitee.id });
        const ref = createDiscussionMessageRefV1({ serverId: 'captured-home', discussionId }, posted.value.message);
        expect(DiscussionMessageRefV1Schema.safeParse(ref).success).toBe(true);
        expect(ref).toEqual({ kind: 'discussion', discussion: { serverId: 'captured-home', discussionId }, messageId: posted.value.message.id });
        expect(await postDiscussionMessage({ authentication, actorAccountId: invitee.id, discussionId, request })).toMatchObject({ ok: true, value: { message: { id: posted.value.message.id, seq: 2 } } });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request })).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        expect(await postDiscussionMessage({ authentication, actorAccountId: invitee.id, discussionId, request: { ...request, replyTarget: undefined } })).toEqual({ ok: false, error: 'discussion_idempotency_conflict' });
        expect(await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId, throughSeq: 1 })).toMatchObject({ ok: true, value: { messages: [expect.objectContaining({ id: created.firstMessage.id })], messageSeq: 1 } });
    });
    it('rejects another Discussion reply target before allocating a sequence', async () => {
        const first = await fixture(), second = await fixture();
        expect(await postDiscussionMessage({ authentication, actorAccountId: first.owner.id, discussionId: first.discussionId, request: { ...postRequest('Wrong thread'), replyTarget: { kind: 'message', messageId: second.created.firstMessage.id } } })).toEqual({ ok: false, error: 'discussion_invalid_reply_target' });
        expect((await db.discussion.findUniqueOrThrow({ where: { id: first.discussionId } })).messageSeq).toBe(1);
    });
    it('retains history when an optional source Session is archived and deleted', async () => {
        const sourceOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: sourceOwner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }) } });
        const { owner, invitee, discussionId } = await fixture({ anchor: { kind: 'session', sessionId: source.id } });
        await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: postRequest('Still here') })).toMatchObject({ ok: true });
        await db.session.delete({ where: { id: source.id } });
        expect(await getDiscussion({ authentication, actorAccountId: invitee.id, discussionId })).toMatchObject({ ok: true, value: { discussion: { anchor: { kind: 'session', sessionId: source.id }, messageSeq: 2 } } });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
    });
    it('keeps tool reads cursor-neutral and explicit visible reads monotonic and private', async () => {
        const { owner, invitee, discussionId } = await fixture();
        const cursor = () => db.discussionReadState.findUniqueOrThrow({ where: { discussionId_accountId: { discussionId, accountId: invitee.id } } });
        expect((await cursor()).lastReadSeq).toBe(0);
        expect(await readDiscussionMessages({ authentication, actorAccountId: invitee.id, discussionId })).toMatchObject({ ok: true });
        expect((await cursor()).lastReadSeq).toBe(0);
        expect(await setDiscussionReadCursor({ authentication, actorAccountId: invitee.id, discussionId, lastReadSeq: 1 })).toMatchObject({ ok: true, value: { lastReadSeq: 1, didChange: true } });
        expect(await setDiscussionReadCursor({ authentication, actorAccountId: invitee.id, discussionId, lastReadSeq: 0 })).toMatchObject({ ok: true, value: { lastReadSeq: 1, didChange: false } });
        expect(await setDiscussionReadCursor({ authentication, actorAccountId: invitee.id, discussionId, lastReadSeq: 2 })).toEqual({ ok: false, error: 'discussion_read_cursor_invalid' });
        expect((await db.discussionReadState.findUniqueOrThrow({ where: { discussionId_accountId: { discussionId, accountId: owner.id } } })).lastReadSeq).toBe(0);
    });
    it('archives without deleting history, rejoins accepted creates and restores via management authority', async () => {
        const { owner, invitee, request, discussionId } = await fixture();
        expect(await archiveDiscussion({ authentication, actorAccountId: invitee.id, discussionId })).toEqual({ ok: false, error: 'discussion_manage_denied' });
        expect(await archiveDiscussion({ authentication, actorAccountId: owner.id, discussionId })).toMatchObject({ ok: true });
        expect(await createDiscussion({ authentication, actorAccountId: owner.id, request })).toMatchObject({ ok: true, value: { discussion: { id: discussionId } } });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: postRequest('Held') })).toEqual({ ok: false, error: 'discussion_archived' });
        expect(await readDiscussionMessages({ authentication, actorAccountId: invitee.id, discussionId })).toMatchObject({ ok: true });
        expect(await restoreDiscussion({ authentication, actorAccountId: owner.id, discussionId })).toMatchObject({ ok: true, value: { discussion: { archivedAt: null } } });
    });
    it('lists only independent grants and keeps local retry IDs private to their author', async () => {
        const { owner, invitee, outsider, request, created, discussionId } = await fixture();
        expect(await listDiscussions({ authentication, actorAccountId: outsider.id })).toMatchObject({ ok: true, value: { discussions: [] } });
        expect(await listDiscussions({ authentication, actorAccountId: invitee.id })).toMatchObject({ ok: true, value: { discussions: expect.arrayContaining([expect.objectContaining({ id: discussionId, creationLocalId: null, latestMessage: expect.objectContaining({ localId: null }) })]) } });
        expect(await getDiscussion({ authentication, actorAccountId: owner.id, discussionId })).toMatchObject({ ok: true, value: { discussion: { creationLocalId: created.discussion.creationLocalId } } });
        expect(await listDiscussions({ authentication, actorAccountId: owner.id, creationLocalId: request.creationLocalId })).toMatchObject({
            ok: true, value: { discussions: [expect.objectContaining({ id: discussionId, creationLocalId: request.creationLocalId })], nextCursor: null },
        });
        expect(await listDiscussions({ authentication, actorAccountId: invitee.id, creationLocalId: request.creationLocalId })).toEqual({ ok: true, value: { discussions: [], nextCursor: null } });
        await archiveDiscussion({ authentication, actorAccountId: owner.id, discussionId });
        expect(await listDiscussions({ authentication, actorAccountId: owner.id, creationLocalId: request.creationLocalId })).toEqual({ ok: true, value: { discussions: [], nextCursor: null } });
        expect(await listDiscussions({ authentication, actorAccountId: owner.id, state: 'archived', creationLocalId: request.creationLocalId })).toMatchObject({
            ok: true, value: { discussions: [expect.objectContaining({ id: discussionId })], nextCursor: null },
        });
    });
    it('admits sparse mentions and content-free change fanout through current Discussion grants', async () => {
        const { owner, invitee, outsider, discussionId } = await fixture();
        const mentioned = (accountId: string) => {
            const authoredContent = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'account' as const, accountId } }] };
            return buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
                content: { t: 'plain', v: authoredContent }, authoredContent, mentionedAccountIds: [accountId] });
        };
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: mentioned(invitee.id) })).toMatchObject({ ok: true });
        expect(await db.accountChange.count({ where: { accountId: invitee.id, kind: 'discussion', entityId: discussionId } })).toBe(1);
        expect(await db.accountChange.count({ where: { accountId: outsider.id, kind: 'discussion', entityId: discussionId } })).toBe(0);
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: mentioned(outsider.id) })).toEqual({ ok: false, error: 'discussion_invalid_mention' });
    });
    it('fails mode mismatches closed, preserves title ordering and allocates concurrent sequences', async () => {
        const { owner, invitee, discussionId } = await fixture();
        const before = await db.discussion.findUniqueOrThrow({ where: { id: discussionId } });
        expect(await renameDiscussion({ authentication, actorAccountId: owner.id, discussionId, titleContent: { t: 'plain', v: { v: 1, title: 'Renamed' } } })).toMatchObject({ ok: true });
        expect((await db.discussion.findUniqueOrThrow({ where: { id: discussionId } })).lastMessageAt).toEqual(before.lastMessageAt);
        const results = await Promise.all([owner.id, invitee.id].map(actorAccountId => postDiscussionMessage({ authentication, actorAccountId, discussionId, request: postRequest('Concurrent') })));
        expect(results.every(result => result.ok)).toBe(true);
        expect(results.flatMap(result => result.ok ? [result.value.message.seq] : []).sort()).toEqual([2, 3]);
        await db.discussion.update({ where: { id: discussionId }, data: { titleContent: { t: 'encrypted', c: 'opaque' } } });
        expect(await getDiscussion({ authentication, actorAccountId: owner.id, discussionId })).toEqual({ ok: false, error: 'discussion_encryption_mode_mismatch' });
    });
});
