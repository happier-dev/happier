import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeDiscussionUploadMetadataV1, readBinaryUploadFrameV1, DISCUSSION_UPLOAD_PATH_V1,
  DISCUSSION_UPLOAD_CONTENT_TYPE_V1 } from '@happier-dev/transfers';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { openResourceBinaryContent } from '@/api/encryption/resourceBinaryContent';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import tweetnacl from 'tweetnacl';
import { createActionExecutor, FeaturesResponseSchema, accountSettingsParse, type ActionExecutorDeps } from '@happier-dev/protocol';
import { DiscussionCreateRequestV1Schema, DiscussionPostRequestV1Schema, DiscussionAgentCreateRequestV1Schema, DiscussionAgentPostRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionSummaryV1Schema, type DiscussionMessageV1 } from '@happier-dev/protocol/discussions/models';
import { DiscussionSecondOpinionPreviewV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { CoordinationMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeAccountEncryptionMigrateKeyFingerprintV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { Credentials } from '@/persistence';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

const { axiosRequest, axiosGet, axiosPost } = vi.hoisted(() => ({ axiosRequest: vi.fn(), axiosGet: vi.fn(), axiosPost: vi.fn() }));
vi.mock('axios', () => ({ default: { request: axiosRequest, get: axiosGet, post: axiosPost } }));

import { createDiscussionActionDeps, createDiscussionAutonomousCheckInReader } from './discussionActionDeps';
import { DiscussionAgentPublisherRequestV1Schema } from './discussionAgentPublisher';
import { createResourceDataKey, openResourceDataKey, type ResourceDataKey } from '@/api/encryption/resourceDataKey';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { deriveKey } from '@/utils/deriveKey';
import { openSessionStoredContent, sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createDiscussionReplyReturnPublisher } from './discussionReplyReturnPublisher';
import { projectWorkflowDiscussionResultContentV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { createWorkflowRunRecoveryReader } from '@/daemon/workflows/recovery';
import { createWorkflowDiscussionResultPublisher } from '@/daemon/workflows/workflowDiscussionPublication';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import * as sessionRpc from '@/session/transport/rpc/sessionRpc';
import { DiscussionMachinePublicationV2Schema, type DiscussionAgentPostPublicationV1,
  type DiscussionWorkflowPostPublicationV1 } from '@happier-dev/protocol/discussions/api';

const credentials = { token: 'token-1', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
const keyless = { token: 'token-1', encryption: null };
const context = { serverId: 'server-1', surface: 'cli' as const, authority: 'present_user' as const };
const plain = { mode: 'plain' as const, ctx: null };
const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse({
  features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
}) };
const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Hello' }] };
const createInput = {
  creationLocalId: 'creation-1', title: 'Title',
  firstMessage: { localId: 'message-1', content },
};
let ownerFingerprint: string;
const currentness = (mode: 'plain' | 'e2ee') => ({
  mode, version: 1, signingKeyFingerprint: mode === 'e2ee' ? 'a'.repeat(64) : null,
  contentKeyFingerprint: mode === 'e2ee' ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(ownerFingerprint) : null, updatedAt: 1,
  recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' },
});

function wireMessage(crypto: SessionStoredContentCryptoContext = plain) {
  return {
    id: 'message-1', discussionId: 'discussion-1', localId: 'message-1', seq: 1,
    authorAccountId: 'account-1', accountActor: { v: 1, accountId: 'account-1', profile: null },
    producerV1: null, content: sealSessionStoredContent({ ...crypto, payload: content }),
    mentionedAccountIds: [], createdAt: 1,
  } satisfies DiscussionMessageV1;
}

function wireSummary(crypto: SessionStoredContentCryptoContext = plain, envelope: string | null = null) {
  return DiscussionSummaryV1Schema.parse({
    id: 'discussion-1', ownerAccountId: 'account-1', encryptionMode: crypto.mode,
    anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: envelope,
    creationLocalId: 'creation-1', titleContent: sealSessionStoredContent({ ...crypto, payload: { v: 1, title: 'Title' } }),
    latestMessage: { id: 'message-1', localId: 'message-1', seq: 1, authorAccountId: 'account-1',
      accountActor: { v: 1, accountId: 'account-1', profile: null }, producerV1: null, createdAt: 1 },
    messageSeq: 1, lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: ['account-1'],
    archivedAt: null, capabilities: { postMessages: true, rename: true, archive: true, restore: false,
      askAgent: true, sendToSession: true, manageAccess: true, leave: false },
  });
}

function action(options: Partial<Parameters<typeof createDiscussionActionDeps>[0]> = {}) {
  return createDiscussionActionDeps({
    credentials: keyless, serverId: 'server-1', serverHttpBaseUrl: 'https://home.example.test',
    resolveServerFeaturesSnapshot: () => features, ...options,
  }).discussionAction!;
}

function discussionExecutor(deps: Pick<ActionExecutorDeps, 'discussionAction'> & Partial<ActionExecutorDeps>) {
  return createActionExecutor({
    ...createCliActionDeps({ token: keyless.token, credentials: keyless, sessionId: 'cli-global',
      mode: 'plain', ctx: null, serverId: 'server-1', serverHttpBaseUrl: 'https://home.example.test',
      resolveServerFeaturesSnapshot: () => features }),
    ...deps,
  });
}

describe('Home Discussion resource transport', () => {
  it.each(['discussion.create', 'discussion.post', 'discussion.reply'] as const)('carries workspace attachment sources through the admitted Agent publisher (%s)', async actionId => {
    const blobId = '7578de54-3f59-4d6d-8293-ff6e4682fd10';
    const attached = { v: 1 as const, parts: [{ t: 'attachment' as const, attachment: {
      kind: 'file' as const, id: blobId, name: 'evidence.txt', file: { blobId, mime: 'text/plain', sizeBytes: 5,
        sha256: createHash('sha256').update('bytes').digest('hex') },
    } }] };
    const attachmentSources = [{ blobId, path: '/workspace/evidence.txt' }];
    const published: unknown[] = [];
    const deps = action({ postAgentMessage: async request => {
      published.push(request);
      return 'operation' in request ? { v: 1, ok: true, value: { discussion: wireSummary(),
        firstMessage: { ...wireMessage(), content: request.request.firstMessage.content } } }
        : { v: 1, ok: true, value: { message: { ...wireMessage(), content: request.request.content }, messageSeq: 1 } };
    } });
    const input = actionId === 'discussion.create'
      ? { ...createInput, attachmentSources, firstMessage: { ...createInput.firstMessage, content: attached } }
      : { discussionId: 'discussion-1', localId: 'message-1', content: attached, attachmentSources,
        ...(actionId === 'discussion.reply' ? { replyTarget: { kind: 'message' as const, messageId: 'parent' } } : {}) };
    const result = await deps({ actionId, input,
      context: { ...context, surface: 'agent', defaultSessionId: 'agent-session',
        actionCaller: { kind: 'session', sessionId: 'agent-session', starterDepth: 0, turnDepth: 0 } } });
    expect(result).toMatchObject(actionId === 'discussion.create' ? { firstMessage: { content: attached } } : { message: { content: attached } });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ sessionId: 'agent-session', attachmentSources });
    expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST' && request.url.endsWith('/upload'))).toBe(false);
    const execution = { v: 1, token: 'external-proof', binding: {
      serverIdentityId: 'server-1', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
      grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine-1', actionId, requestId: 'request-1',
      custodianAccountId: 'account-1', installationId: 'installation-1', requestEnvelopeDigest: 'd'.repeat(43),
      target: { kind: 'session', sessionId: 'agent-session' },
    } } satisfies ExternalActionExecutionAuthorizationV1;
    for (const external of [
      { externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1 } },
      { externalActionExecutionAuthorization: execution },
    ]) {
      expect(await deps({ actionId, input, context: { ...context, ...external, surface: 'agent',
        defaultSessionId: 'agent-session', actionCaller: { kind: 'session', sessionId: 'agent-session', starterDepth: 0, turnDepth: 0 } } }))
        .toMatchObject({ ok: false, errorCode: 'discussion_attachment_upload_authority_unavailable' });
    }
    expect(published).toHaveLength(1);
  });
  it.each(['material_unavailable', 'session_not_found', 'identity_denied', 'retired_session', 'missing_machine_publisher', 'machine_unavailable', 'machine_ack_lost'] as const)(
    'retains terminal publication custody for unavailable Session material but settles proved refusal (%s)', async scenario => {
    const accountId = 'account-1';
    const machineId = 'machine-1';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const sessionId = 'c123456789012345678901234';
    const recordId = 'invocation';
    const rootId = 'root';
    const workflow = { runId, invocationRecordId: recordId, invocationAttempt: '0' };
    const inputLocalId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId: recordId });
    const origin = { discussion: { serverId: 'server-1', discussionId: 'discussion-1' }, messageId: 'message-1', throughSeq: 1 };
    const addressing = { discussionId: 'discussion-1', messageId: 'message-1', throughSeq: 1, participantSessionId: sessionId };
    const retiredSession = ['retired_session', 'missing_machine_publisher', 'machine_unavailable', 'machine_ack_lost'].includes(scenario);
    let machineAcknowledged = scenario !== 'machine_ack_lost';
    // A retired receiver has no RPC handler. The installed Machine remains the
    // transport owner for its already-accepted Workflow result.
    const retiredRpc = vi.spyOn(sessionRpc, 'callSessionRpc').mockRejectedValue(new Error('Session publisher retired'));
    onTestFinished(() => retiredRpc.mockRestore());
    const machinePackets: unknown[] = [];
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'test' } },
    }, blocks: [{ kind: 'step', id: 'answer', document: { text: 'Answer', references: [], attachments: [] },
      input: [], result: { kind: 'text' } }] }, context: { source: { kind: 'inline' }, inputs: {}, machineId,
      executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct', discussion: origin }, resultDelivery: { kind: 'originating_discussion', ...origin },
      authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
      effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error('Workflow fixture admission failed');
    const kit = createWorkflowRunStorageTestkit({ runId, accountId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot })) });
    const checkpoint = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: { kind: 'happier.workflow-checkpoint.v1',
        rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 1, paused: false } } }));
    const seal = (root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: root ? rootId : recordId,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
        invocationPath: { blockId: root ? '$root' : 'answer', scope: [] }, attempt: '0', logicalInvocationRecordId: root ? rootId : recordId,
        ...(root ? {} : { result: 'Accepted answer', execution: { kind: 'session' as const, sessionId, localInputId: inputLocalId } }) } }));
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpoint,
      rootInvocation: { id: rootId, contentEnvelope: seal(true) } });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpoint,
      invocations: [{ id: recordId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'completed', contentEnvelope: seal(false) }] });
    kit.requestControl('cancelled');
    // Only the HTTP boundary reports absence; the canonical resolver must
    // prove it through the exact read and both accessible inventories.
    axiosPost.mockResolvedValue({ status: 200, data: { sessions: [] } });
    const session = createCurrentSessionProjectionRecordFixture({ id: sessionId, active: false, encryptionMode: retiredSession ? 'plain' : 'e2ee',
      metadata: 'unavailable', dataEncryptionKey: null, share: null,
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness(retiredSession ? 'plain' : 'e2ee') };
      if (path === `/v2/sessions/${sessionId}`) return scenario === 'session_not_found'
        ? { status: 404, data: { error: 'Session not found' } } : { status: 200, data: { session } };
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') {
        return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
      }
      if (path.endsWith('/reply')) return { status: 200, data: { v: 1, status: 'available', progress: {
        v: 1, mode: 'wait', workflow: { purpose: 'invocation', runId, invocationRecordId: recordId },
        discussion: addressing, acceptedTurnId: 'turn', disposition: 'observing',
        outcome: { kind: 'answer', result: { sessionId, messageId: 'native-final' } },
      } } };
      return { status: 200, data: features.features };
    });
    const defaultRequest = axiosRequest.getMockImplementation()!;
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string }) => {
      if (request.url.endsWith('/participants')) return { status: 200, data: DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'discussion-1', ownerAccountId: accountId, access: 'owner', grants: [],
        participants: [{ participant: { kind: 'session', sessionId }, answerPolicy: 'when_addressed', createdAt: 1 }],
      }) };
      return defaultRequest(request);
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ...features.features,
      capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } }), { status: 200 }));
    onTestFinished(() => fetch.mockRestore());
    await runWithServerHttpBaseUrl('https://home.example.test', async () => {
      expect(await resolveSessionTransportContext({ credentials: keyless, idOrPrefix: sessionId }))
        .toMatchObject(retiredSession ? { ok: true, mode: 'plain' }
          : { ok: false, code: scenario === 'session_not_found' ? 'session_not_found' : 'encryption_material_unavailable' });
      axiosGet.mockClear();
      const diagnostics = vi.spyOn(logger, 'warnLocalFile');
      onTestFinished(() => diagnostics.mockRestore());
      const publish = createDiscussionReplyReturnPublisher({ credentials: keyless, machineId,
        serverId: 'server-1', serverHttpBaseUrl: 'https://home.example.test', signal: new AbortController().signal,
        workflowAuthorization: accepted.snapshot.authorization, isCurrent: async () => scenario !== 'identity_denied',
        ...(retiredSession && scenario !== 'missing_machine_publisher' ? { postWorkflowMessage: async (publication: DiscussionAgentPostPublicationV1 | DiscussionWorkflowPostPublicationV1) => {
          machinePackets.push({ v: 2, operation: 'terminal_return', machineId, publication });
          if (scenario === 'machine_unavailable') return { v: 1 as const, ok: false as const, error: 'discussions_unavailable' as const };
          if (!machineAcknowledged) throw new Error('Committed Machine return acknowledgement lost');
          return { v: 1 as const, ok: true as const, value: { messageSeq: 2, message: { ...wireMessage(),
            id: 'accepted-reply', localId: publication.request.localId, seq: 2,
            replyTarget: publication.request.replyTarget, content: publication.request.content } } };
        } } : {}),
        actionsSettingsProvider: { getAccountSettings: () => accountSettingsParse({}),
          getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } });
      const recover = createWorkflowRunRecoveryReader({ accountId, machineId, storage: { execute: async (operation, options) =>
        operation.operation === 'recovery.list' ? { candidates: [{ run: kit.run(), parentAttempt: 0 }] }
          : kit.execute(operation, options) },
        resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        reconcileInvocation: async () => { throw new Error('A terminal result must not execute again'); },
        onInvocationSettled: async ({ invocation }) => {
          await createWorkflowDiscussionResultPublisher({ credentials: keyless, origin,
            isCurrent: async () => true, publish })({ runId, invocation });
        } });
      await recover('startup');
      if (scenario === 'machine_ack_lost') {
        expect(kit.run().workflowCustodyState).toBe('pending');
        machineAcknowledged = true;
        await recover('reconnect');
      }
      expect(axiosGet.mock.calls.some(([url]) => new URL(String(url)).pathname === `/v2/sessions/${sessionId}`), JSON.stringify({
        reads: axiosGet.mock.calls.map(([url]) => new URL(String(url)).pathname),
        requests: axiosRequest.mock.calls.map(([request]) => ({ method: request.method, path: new URL(request.url).pathname })),
        diagnostics: diagnostics.mock.calls, custody: kit.run().workflowCustodyState,
      }))
        .toBe(scenario !== 'identity_denied');
      const pending = ['material_unavailable', 'missing_machine_publisher', 'machine_unavailable'].includes(scenario);
      expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: pending ? 'pending' : 'settled' });
      expect(kit.rowById(recordId)?.index.lifecycle).toBe('completed');
      if (retiredSession) {
        expect(retiredRpc).not.toHaveBeenCalled();
        expect(machinePackets).toHaveLength(scenario === 'missing_machine_publisher' ? 0 : scenario === 'machine_ack_lost' ? 2 : 1);
        if (scenario === 'machine_ack_lost') expect(machinePackets[1]).toEqual(machinePackets[0]);
        for (const packet of machinePackets) expect(DiscussionMachinePublicationV2Schema.safeParse(packet).success).toBe(true);
        return;
      }
      const result = await publish({ serverId: 'server-1', requestSessionId: sessionId, requestLocalId: inputLocalId,
        acceptedTurnId: 'turn', workflow, discussion: addressing,
        outcome: { kind: 'answer', result: { sessionId, messageId: 'native-final' } }, message: 'Accepted answer' });
      expect(result).toMatchObject({ ok: false, error: scenario === 'material_unavailable' ? 'discussions_unavailable' : 'discussion_post_denied' });
      expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
    });
  });
  it.each([
    { originHome: 'server-1', outcome: 'published' }, { originHome: 'srv_home', outcome: 'published' },
    { originHome: 'foreign-home', outcome: 'published' }, { originHome: 'server-1', outcome: 'post_denied' },
    { originHome: 'server-1', outcome: 'post_unavailable' }, { originHome: 'server-1', outcome: 'lost_ack' },
    { originHome: 'server-1', outcome: 'missing_publisher' }, { originHome: 'server-1', outcome: 'home_unavailable' },
    { originHome: 'server-1', outcome: 'action_disabled' },
  ] as const)('binds accepted Workflow custody through the real return publisher, Action policy and sole resource codec to the Machine transport ($originHome, $outcome)', async ({ originHome, outcome }) => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    axiosGet.mockResolvedValue({ status: 200, data: features.features });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ...features.features,
      capabilities: { ...features.features.capabilities, serverIdentity: { serverIdentityId: 'srv_home' } } }), {
      status: outcome === 'home_unavailable' ? 503 : 200, headers: { 'content-type': 'application/json' },
    }));
    onTestFinished(() => fetch.mockRestore());
    const sent: import('@happier-dev/protocol/discussions/api').DiscussionWorkflowPostPublicationV1[] = [];
    const workflow = { runId: 'run', invocationRecordId: 'invocation', invocationAttempt: '0' };
    const typedContent = projectWorkflowDiscussionResultContentV1({ ...workflow, lifecycle: 'completed', result: { checked: true } });
    const publication = createDiscussionReplyReturnPublisher({ credentials: { token, encryption: null }, machineId: 'machine',
      workflowAuthorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
      serverId: 'server-1', serverHttpBaseUrl: 'https://home.example.test', signal: new AbortController().signal,
      isCurrent: async () => true, actionsSettingsProvider: { getAccountSettings: () => accountSettingsParse({}),
        getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
          ...(outcome === 'action_disabled' ? { actions: { 'discussion.reply': { enabled: false } } } : {}) }) },
      ...(outcome === 'missing_publisher' ? {} : { postWorkflowMessage: async (publication: DiscussionAgentPostPublicationV1 | DiscussionWorkflowPostPublicationV1) => {
        if (!('producer' in publication)) throw new Error('Expected a non-Session Workflow result');
        if (outcome === 'post_denied') return { v: 1 as const, ok: false as const, error: 'discussion_post_denied' as const };
        if (outcome === 'post_unavailable') return { v: 1 as const, ok: false as const, error: 'discussions_unavailable' as const };
        if (outcome === 'lost_ack') throw new Error('committed_reply_ack_lost');
        sent.push(publication);
        return { v: 1 as const, ok: true as const, value: { message: { ...wireMessage(), localId: publication.request.localId,
          producerV1: publication.producer, content: publication.request.content, replyTarget: publication.request.replyTarget }, messageSeq: 1 } };
      } }),
    })({ kind: 'workflow_invocation', serverId: originHome, workflow,
      discussion: { discussion: { serverId: originHome, discussionId: 'discussion-1' }, messageId: 'question', throughSeq: 1 },
      producer: { v: 1, kind: 'workflow', ...workflow, execution: { kind: 'action', actionId: 'plugin:external/check' }, outcome: 'answer' },
      content: typedContent });
    if (outcome === 'lost_ack') {
      await expect(publication).rejects.toThrow('committed_reply_ack_lost');
      expect(sent).toEqual([]);
      return;
    }
    const result = await publication;
    if (outcome !== 'published') {
      expect(result).toMatchObject({ ok: false, error: outcome === 'post_denied' || outcome === 'action_disabled'
        ? 'discussion_post_denied' : 'discussions_unavailable' });
      expect(sent).toEqual([]);
      return;
    }
    if (originHome === 'foreign-home') {
      expect(result).toMatchObject({ ok: false, error: 'discussion_post_denied' });
      expect(sent).toEqual([]);
      return;
    }
    expect(result, JSON.stringify({ reads: axiosRequest.mock.calls.map(([request]) => ({ method: request.method, path: new URL(request.url).pathname })), sent: sent.length })).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.request).toMatchObject({ localId: deriveWorkflowDiscussionReplyLocalIdV1(workflow),
      replyTarget: { kind: 'message', messageId: 'question' }, content: { t: 'plain', v: typedContent } });
    expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
  });
  it('preserves a definite present-user refusal instead of reporting unknown invitation outcome', async () => {
    axiosRequest.mockImplementation(async (request: { method: string }) => request.method === 'GET'
      ? { status: 200, data: { discussion: wireSummary() } }
      : { status: 403, data: { error: 'present_user_required' } });
    expect(await action()({ actionId: 'discussion.invite', input: {
      discussionId: 'discussion-1', participant: { kind: 'account', accountId: 'invited' },
    }, context: { ...context, authority: 'account_automation' } })).toMatchObject({
      ok: false, errorCode: 'present_user_required',
    });
  });

  it('reads the captured Home check-in override without keys and holds unavailable or mismatched results', async () => {
    const read = createDiscussionAutonomousCheckInReader({ credentials: keyless, serverId: 'server-1',
      serverHttpBaseUrl: 'https://home.example.test', resolveServerFeaturesSnapshot: () => features });
    const origin = { serverId: 'server-1', discussionId: 'discussion-1' };
    for (const [settings, expected] of [
      [{}, undefined], [{ coordination: { autonomousCheckIn: { afterTurns: null } } }, { afterTurns: null }],
      [{ coordination: { autonomousCheckIn: { afterTurns: 8 } } }, { afterTurns: 8 }],
      [{ coordination: { autonomousCheckIn: { afterTurns: 0 } } }, null],
    ] as const) {
      axiosRequest.mockResolvedValueOnce({ status: 200, data: { discussionId: origin.discussionId, settings } });
      expect(await read(origin)).toEqual(expected);
    }
    const requestsBefore = axiosRequest.mock.calls.length;
    expect(await read({ ...origin, serverId: 'other-home' })).toBeNull();
    expect(axiosRequest.mock.calls).toHaveLength(requestsBefore);
    axiosRequest.mockResolvedValueOnce({ status: 200, data: { discussionId: 'other-discussion', settings: {} } });
    expect(await read(origin)).toBeNull();
    const aliasRead = createDiscussionAutonomousCheckInReader({ credentials: keyless, serverId: 'profile-1',
      capturedHomeIdentity: Promise.resolve('srv_home'), serverHttpBaseUrl: 'https://home.example.test',
      resolveServerFeaturesSnapshot: () => features });
    axiosRequest.mockResolvedValueOnce({ status: 200, data: { discussionId: origin.discussionId,
      settings: { coordination: { autonomousCheckIn: { afterTurns: null } } } } });
    expect(await aliasRead({ ...origin, serverId: 'srv_home' })).toEqual({ afterTurns: null });
    for (const status of [403, 404, 503]) {
      axiosRequest.mockResolvedValueOnce({ status, data: { error: 'discussion_not_found' } });
      expect(await read(origin)).toBeNull();
    }
    axiosRequest.mockRejectedValueOnce(new Error('Network unavailable'));
    expect(await read(origin)).toBeNull();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    ownerFingerprint = computeContentPublicKeyFingerprint(libsodiumPublicKeyFromSecretKey(
      await deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']),
    ));
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string }) => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness('plain') };
      if (path === '/v1/discussions' && request.method === 'GET') {
        return { status: 200, data: { discussions: [], nextCursor: null } };
      }
      if (path === '/v1/discussions' && request.method === 'POST') {
        const body = DiscussionCreateRequestV1Schema.parse(JSON.parse(request.data!));
        return { status: 200, data: {
          discussion: { ...wireSummary(), titleContent: body.titleContent },
          firstMessage: { ...wireMessage(), content: body.firstMessage.content },
        } };
      }
      if (path === '/v1/discussions/discussion-1') return { status: 200, data: { discussion: wireSummary() } };
      if (path === '/v1/discussions/discussion-1/messages' && request.method === 'GET') {
        return { status: 200, data: { messages: [wireMessage()], hasMoreOlder: false, messageSeq: 1 } };
      }
      if (path === '/v1/discussions/discussion-1/messages' && request.method === 'POST') {
        const body = DiscussionPostRequestV1Schema.parse(JSON.parse(request.data!));
        return { status: 200, data: { message: { ...wireMessage(), content: body.content,
          mentionedAccountIds: body.mentionedAccountIds }, messageSeq: 1 } };
      }
      throw new Error('Unexpected request: ' + request.method + ' ' + path);
    });
  });

  it('feeds admitted executable participants through the SessionTarget front door without starting model slots', async () => {
    // The complete CLI host resolves the bound source through its real reader;
    // only these authenticated Home HTTP responses are substituted.
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness('plain') };
      if (path === '/v2/sessions/origin-session') return { status: 200, data: {
        session: createCurrentSessionProjectionRecordFixture({ id: 'origin-session', encryptionMode: 'plain', metadata: '{}', share: null,
          effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
        }),
      } };
      throw new Error('Unexpected source Session read: ' + path);
    });
    const requests: string[] = [];
    axiosRequest.mockImplementation(async (request: { url: string; method: string }) => {
      requests.push(request.url);
      return { status: 200, data: { discussionId: 'discussion-1', ownerAccountId: 'account-1', access: 'owner',
        grants: [], participants: [{ participant: { kind: 'session', sessionId: 'participant-session' },
          answerPolicy: 'when_addressed', createdAt: 1 }] } };
    });
    const received: string[] = [];
    const executor = discussionExecutor({ discussionAction: action(),
      sessionSendMessage: async ({ sessionId }) => { received.push(sessionId); return { status: 'accepted', localId: 'input-1' }; },
      isActionApprovalRequired: () => false,
    });
    const sent = await executor.execute('session.message.send', { sessionId: { selector: 'discussion', discussionId: 'discussion-1' },
      message: 'Question' }, { ...context, defaultSessionId: 'origin-session' });
    expect(sent, JSON.stringify(sent))
      .toMatchObject({ ok: true, result: { kind: 'fanout', results: [{ target: { serverId: 'server-1', sessionId: 'participant-session' },
        result: { ok: true, result: { status: 'accepted' } } }] } });
    expect(received).toEqual(['participant-session']);
    expect(requests).toEqual(['https://home.example.test/v1/discussions/discussion-1/participants']);
  });

  it('materializes create and invite selectors before the concrete captured-Home HTTP boundary', async () => {
    const original = axiosRequest.getMockImplementation()!;
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string }) => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/discussions/source/participants') return { status: 200, data: {
        discussionId: 'source', ownerAccountId: 'account-1', access: 'owner', grants: [], participants: [
          { participant: { kind: 'session', sessionId: 'chosen' }, answerPolicy: 'when_addressed', createdAt: 1 },
        ],
      } };
      if (path === '/v1/discussions/discussion-1/participants/invite') return { status: 200, data: {
        discussionId: 'discussion-1', ownerAccountId: 'account-1', access: 'owner', grants: [], changed: true,
      } };
      return original(request);
    });
    // This host has no approval transport; the real Action policy must refuse
    // until the caller supplies the persisted surface waiver below.
    const executor = discussionExecutor({ discussionAction: action(), approvalsCreate: undefined });
    const participant = { kind: 'session', sessionId: { selector: 'discussion', discussionId: 'source' } };
    expect(await executor.execute('discussion.create', { ...createInput, participants: [participant] }, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
    // This fixture tests concrete transport after the caller's persisted CLI
    // waiver; UI direct admission must not silently waive the CLI danger floor.
    const transportContext = { ...context, actionsSettings: normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { 'discussion.create': ['cli'], 'discussion.invite': ['cli'] },
    }) };
    const created = await executor.execute('discussion.create', { ...createInput, participants: [participant] }, transportContext);
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created).toMatchObject({ ok: true, result: { discussion: { id: 'discussion-1' } } });
    expect(await executor.execute('discussion.invite', { discussionId: 'discussion-1', participant }, transportContext))
      .toMatchObject({ ok: true, result: { changed: true } });
    const writes = axiosRequest.mock.calls.map(([request]) => request)
      .filter(request => request.method === 'POST').map(request => ({ path: new URL(request.url).pathname, body: JSON.parse(request.data) }));
    expect(writes).toMatchObject([
      { path: '/v1/discussions', body: { participants: [{ kind: 'session', sessionId: 'chosen' }] } },
      { path: '/v1/discussions/discussion-1/participants/invite', body: { participant: { kind: 'session', sessionId: 'chosen' } } },
    ]);
  });

  it('runs the registered people candidate Action through the captured HTTP boundary and native pager', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const profiles = ['account-1', 'candidate'].map(id => ({ id, name: id, username: id, firstName: id,
      lastName: null, avatar: null, bio: null, badges: [], status: 'none', publicKey: null }));
    axiosRequest.mockResolvedValue({ status: 200, data: { users: profiles, nextCursor: 'next-people' } });
    const executor = discussionExecutor({ discussionAction: action({ credentials: { token, encryption: null } }) });
    expect(await executor.execute('discussion.candidates.list', { source: 'people', query: 'candidate', cursor: 'previous' }, context))
      .toMatchObject({ ok: true, result: { source: 'people', serverId: 'server-1',
        candidates: [{ kind: 'account', participant: { kind: 'account', accountId: 'candidate' } }], nextCursor: 'next-people' } });
    expect(axiosRequest.mock.calls[0]?.[0]).toMatchObject({ method: 'GET',
      url: 'https://home.example.test/v1/user/search?query=candidate&purpose=collaboration&cursor=previous' });
    expect(await executor.execute('discussion.candidates.list', { source: 'people', query: 'candidate' },
      { ...context, serverId: 'other-home' })).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(axiosRequest).toHaveBeenCalledTimes(1);
  });

  it.each(['session.status.get', 'session.targets.resolve'] as const)('signs selector participant and uncached feature reads with the original SessionTarget root (%s)', async rootActionId => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authorization = { v: 1, token: 'selector-proof', binding: {
      serverIdentityId: 'server-1', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
      grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine-1', actionId: rootActionId, requestId: 'selector-request',
      custodianAccountId: 'account-1', installationId: 'installation-1', requestEnvelopeDigest: 'd'.repeat(43), target,
    } } satisfies ExternalActionExecutionAuthorizationV1;
    const proofs: { path: string; bearer: string | null; effectActionId: string | null; valid: boolean }[] = [];
    const verify = (headers: Headers, path: string) => {
      proofs.push({ path, bearer: headers.get('authorization'), effectActionId: headers.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER),
        valid: verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
        effectActionId: rootActionId, target, installationId: 'installation-1', requestId: 'selector-request',
        method: 'GET', path, publicKey: keyPair.publicKey,
        signature: headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)! }) });
    };
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      verify(new Headers(init?.headers), '/v1/features');
      return Response.json(features.features);
    });
    axiosRequest.mockImplementation(async (request: { url: string; headers: Record<string, string> }) => {
      verify(new Headers(request.headers), '/v1/discussions/discussion-1/participants');
      return { status: 200, data: { discussionId: 'discussion-1', ownerAccountId: 'account-1', access: 'owner',
        grants: [], participants: [] } };
    });
    try {
      expect(await action({ resolveServerFeaturesSnapshot: undefined,
        credentials: { token: 'daemon-token', encryption: null }, serverIdentityId: 'server-1',
        externalActionMachineRequestPrivateKey: keyPair.secretKey, externalActionMachineInstallationId: 'installation-1',
      })({ actionId: 'discussion.participants.list', input: { discussionId: 'discussion-1' }, context: {
        serverId: 'server-1', surface: 'agent', authority: 'account_automation',
        externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1 },
        externalActionExecutionAuthorization: authorization, externalActionTarget: target,
      } })).toMatchObject({ discussionId: 'discussion-1', participants: [] });
      expect(proofs).toEqual(['/v1/features', '/v1/discussions/discussion-1/participants'].map(path => ({
        path, bearer: null, effectActionId: rootActionId, valid: true,
      })));
    } finally { vi.unstubAllGlobals(); }
  });

  it('uses the signed candidate root for an uncached feature read as well as its directory request', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authorization = { v: 1, token: 'candidate-proof', binding: {
      serverIdentityId: 'server-1', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
      grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine-1', actionId: 'discussion.candidates.list', requestId: 'candidate-request',
      custodianAccountId: 'account-1', installationId: 'installation-1', requestEnvelopeDigest: 'd'.repeat(43), target,
    } } satisfies ExternalActionExecutionAuthorizationV1;
    const featureRequests: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      featureRequests.push(String(url));
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
        effectActionId: 'discussion.candidates.list', target, installationId: 'installation-1',
        requestId: authorization.binding.requestId, method: 'GET', path: '/v1/features',
        publicKey: keyPair.publicKey, signature: headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)! })).toBe(true);
      return Response.json(features.features);
    });
    axiosRequest.mockResolvedValue({ status: 200, data: { users: [], nextCursor: null } });
    try {
      expect(await action({ resolveServerFeaturesSnapshot: undefined,
        credentials: { token: 'daemon-token', encryption: null }, serverIdentityId: 'server-1',
        externalActionMachineRequestPrivateKey: keyPair.secretKey, externalActionMachineInstallationId: 'installation-1',
      })({ actionId: 'discussion.candidates.list', input: { source: 'people', query: 'bob' }, context: {
        serverId: 'server-1', surface: 'agent', authority: 'account_automation',
        externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1 },
        externalActionExecutionAuthorization: authorization, externalActionTarget: target,
      } })).toMatchObject({ source: 'people', candidates: [], nextCursor: null });
      expect(featureRequests).toEqual(['https://home.example.test/v1/features']);
      const request = axiosRequest.mock.calls[0]?.[0];
      expect(request.headers.Authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('discussion.candidates.list');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['plain', 'e2ee'] as const)('opens the latest-message %s envelope through the same resource codec as its title', async mode => {
    const key = await createResourceDataKey({ credentials: mode === 'plain' ? keyless : credentials, mode });
    const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? plain
      : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
    const summary = wireSummary(crypto, key.dataEncryptionKey);
    const stored = DiscussionSummaryV1Schema.parse({ ...summary, latestMessage: {
      ...summary.latestMessage, content: sealSessionStoredContent({ ...crypto, payload: content }),
    } });
    axiosRequest.mockResolvedValue({ status: 200, data: { discussions: [stored], nextCursor: null } });
    const result = await action({ credentials: mode === 'plain' ? keyless : credentials })({ actionId: 'discussion.list', input: {}, context });
    expect(result).toMatchObject({ incomplete: false, discussions: [{ title: 'Title', latestMessage: { content } }] });
    expect(axiosRequest.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(['/v1/discussions']);
  });

  it.each(['plain', 'e2ee'] as const)('opens filtered first-message %s envelopes with the summary key and no per-thread reads', async mode => {
    const key = await createResourceDataKey({ credentials: mode === 'plain' ? keyless : credentials, mode });
    const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? plain
      : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
    const summary = wireSummary(crypto, key.dataEncryptionKey);
    const stored = { ...summary, firstMessage: wireMessage(crypto) };
    const reader = action({ credentials: mode === 'plain' ? keyless : credentials });
    axiosRequest.mockResolvedValue({ status: 200, data: { discussions: [stored], nextCursor: null } });
    expect(await reader({ actionId: 'discussion.list', input: { state: 'active', anchorDocArtifactId: 'doc' }, context }))
      .toMatchObject({ discussions: [{ firstMessage: { content, messageRef: { discussion: { serverId: 'server-1', discussionId: 'discussion-1' } } } }] });
    axiosRequest.mockResolvedValueOnce({ status: 200, data: { discussions: [{ ...summary, firstMessage: null }], nextCursor: null } });
    expect(await reader({ actionId: 'discussion.list', input: { state: 'active', anchorDocArtifactId: 'doc' }, context }))
      .toMatchObject({ discussions: [{ firstMessage: null }] });
    axiosRequest.mockResolvedValueOnce({ status: 200, data: { discussions: [summary], nextCursor: null } });
    expect(await reader({ actionId: 'discussion.list', input: {}, context })).not.toHaveProperty('discussions.0.firstMessage');
    expect(axiosRequest.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(Array(3).fill('/v1/discussions'));
  });

  it('keeps unavailable latest content null and incomplete without treating older omitted content as a failure', async () => {
    const key = await createResourceDataKey({ credentials, mode: 'e2ee' });
    const crypto: SessionStoredContentCryptoContext = { mode: 'e2ee', ctx: { encryptionKey: key.dataKey!, encryptionVariant: 'dataKey' } };
    const summary = wireSummary();
    const mismatch = DiscussionSummaryV1Schema.parse({ ...summary, latestMessage: {
      ...summary.latestMessage, content: sealSessionStoredContent({ ...crypto, payload: content }),
    } });
    axiosRequest.mockResolvedValueOnce({ status: 200, data: { discussions: [mismatch], nextCursor: null } });
    expect(await action()({ actionId: 'discussion.list', input: {}, context }))
      .toMatchObject({ incomplete: true, discussions: [{ title: 'Title', latestMessage: { content: null } }] });
    axiosRequest.mockResolvedValueOnce({ status: 200, data: { discussions: [summary], nextCursor: null } });
    const legacy = await action()({ actionId: 'discussion.list', input: {}, context });
    expect(legacy).toMatchObject({ incomplete: false, discussions: [{ title: 'Title' }] });
    expect(legacy).not.toHaveProperty('discussions.0.latestMessage.content');
  });

  it.each(['plain', 'e2ee'] as const)('does not disclose newer latest-message %s content through an addressed Agent list or get', async mode => {
    const key = await createResourceDataKey({ credentials: mode === 'plain' ? keyless : credentials, mode });
    const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? plain
      : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
    const summary = wireSummary(crypto, key.dataEncryptionKey);
    const newer = DiscussionSummaryV1Schema.parse({ ...summary, messageSeq: 3, latestMessage: {
      ...summary.latestMessage, seq: 3, content: sealSessionStoredContent({ ...crypto, payload: content }),
    } });
    const reader = action({ credentials: mode === 'plain' ? keyless : credentials });
    const protectedContext = { ...context, surface: 'mcp' as const,
      actionCaller: { kind: 'session' as const, sessionId: 'receiver', starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'receiver',
      sessionInputSource: { sourceSessionId: 'receiver', sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' as const,
        discussionAddressing: { discussionId: 'discussion-1', messageId: 'message-1', throughSeq: 2, participantSessionId: 'receiver' } },
    };
    for (const actionId of ['discussion.list', 'discussion.get'] as const) {
      const input = actionId === 'discussion.list' ? {} : { discussionId: 'discussion-1' };
      const response = actionId === 'discussion.list' ? { discussions: [newer], nextCursor: null } : { discussion: newer };
      axiosRequest.mockResolvedValueOnce({ status: 200, data: response });
      const result = await reader({ actionId, input, context: protectedContext });
      expect(result).toMatchObject(actionId === 'discussion.list'
        ? { incomplete: true, discussions: [{ title: 'Title', latestMessage: { seq: 3, content: null } }] }
        : { discussion: { title: 'Title', latestMessage: { seq: 3, content: null } } });
      expect(JSON.stringify(result)).not.toContain('Hello');
      axiosRequest.mockResolvedValueOnce({ status: 200, data: response });
      expect(await reader({ actionId, input, context })).toMatchObject(actionId === 'discussion.list'
        ? { incomplete: false, discussions: [{ latestMessage: { content } }] }
        : { discussion: { latestMessage: { content } } });
      axiosRequest.mockResolvedValueOnce({ status: 200, data: response });
      expect(await reader({ actionId, input, context: { ...protectedContext, sessionInputSource: undefined } })).toMatchObject(actionId === 'discussion.list'
        ? { incomplete: false, discussions: [{ latestMessage: { content } }] }
        : { discussion: { latestMessage: { content } } });
    }
    expect(axiosRequest.mock.calls).toHaveLength(6);
  });

  it.each(['plain', 'e2ee'] as const)('composes Doc comments and proposals through the real %s codec and rejoins an uncertain root', async mode => {
    const passage = { ref: { kind: 'doc' as const, serverId: 'server-1', artifactId: 'doc-1' },
      revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'Secret' };
    const comment = { kind: 'doc_passage_comment', passage, content };
    let saved: { discussion: ReturnType<typeof wireSummary>; firstMessage: ReturnType<typeof wireMessage> } | undefined;
    let rootLost = false;
    const creationIds: string[] = [];
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string }) => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness(mode) };
      if (path === '/v1/discussions' && request.method === 'GET') return { status: 200,
        data: { discussions: saved ? [saved.discussion] : [], nextCursor: null } };
      if (path === '/v1/discussions' && request.method === 'POST') {
        const body = DiscussionCreateRequestV1Schema.parse(JSON.parse(request.data!));
        creationIds.push(body.creationLocalId!);
        const key = await openResourceDataKey({ credentials: mode === 'plain' ? keyless : credentials, mode,
          dataEncryptionKey: body.dataEncryptionKey ?? null });
        const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? plain
          : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
        expect(openSessionStoredContent({ ...crypto, content: body.firstMessage.content })).toEqual(comment);
        expect(body.firstMessage.replyTarget).toEqual({ kind: 'doc_passage', doc: { ref: passage.ref, revision: passage.revision } });
        if (mode === 'e2ee') expect(request.data).not.toContain('Secret');
        saved ??= { discussion: { ...wireSummary(crypto, key.dataEncryptionKey), creationLocalId: body.creationLocalId!, titleContent: body.titleContent },
          firstMessage: { ...wireMessage(crypto), localId: body.firstMessage.localId!, content: body.firstMessage.content,
            ...('replyTarget' in body.firstMessage ? { replyTarget: body.firstMessage.replyTarget } : {}) } };
        if (!rootLost) { rootLost = true; throw new Error('Response lost after commit'); }
        return { status: 200, data: saved };
      }
      if (path === '/v1/discussions/discussion-1') return { status: 200, data: { discussion: saved!.discussion } };
      if (path === '/v1/discussions/discussion-1/messages' && request.method === 'GET') return { status: 200,
        data: { messages: [saved!.firstMessage], hasMoreOlder: false, messageSeq: 1 } };
      if (path === '/v1/discussions/discussion-1/messages' && request.method === 'POST') {
        const body = DiscussionPostRequestV1Schema.parse(JSON.parse(request.data!));
        expect(body.replyTarget).toEqual({ kind: 'message', messageId: 'message-1' });
        expect(body).toMatchObject({ docEditProposal: true });
        if (mode === 'e2ee') expect(request.data).not.toContain('Secret');
        return { status: 200, data: { message: { ...saved!.firstMessage, id: 'proposal-1', seq: 2,
          localId: body.localId, content: body.content, replyTarget: body.replyTarget,
          docEditProposalDispositionV1: { state: 'open' } }, messageSeq: 2 } };
      }
      throw new Error('Unexpected Doc transport request');
    });
    const executor = discussionExecutor({ discussionAction: action({ credentials: mode === 'plain' ? keyless : credentials }) });
    const docContext = { ...context, actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
      'doc.comment.reply': ['cli'], 'doc.edit.propose': ['cli'],
    } }) };
    const input = { target: passage, localId: 'doc-root-retry', content };
    expect(await executor.execute('doc.comment.reply', input, docContext)).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    const result = await executor.execute('doc.comment.reply', input, docContext);
    expect(result).toMatchObject({ ok: true, result: { message: { localId: input.localId, content: comment,
      messageRef: { kind: 'discussion', discussion: { serverId: 'server-1', discussionId: 'discussion-1' }, messageId: 'message-1' } } } });
    expect(new Set(creationIds).size).toBe(1);
    const proposalInput = { discussionRef: { serverId: 'server-1', discussionId: 'discussion-1' }, target: passage,
      replyTo: { kind: 'discussion', discussion: { serverId: 'server-1', discussionId: 'discussion-1' }, messageId: 'message-1' },
      localId: 'doc-proposal-retry', baseRevision: passage.revision, before: 'Secret', after: 'Clear', reason: 'Clarify' };
    expect(await executor.execute('doc.edit.propose', proposalInput, docContext)).toMatchObject({ ok: true,
      result: { message: { docEditProposalDispositionV1: { state: 'open' }, content: { kind: 'doc_edit_proposal', proposal: {
        target: passage, baseRevision: passage.revision, before: 'Secret', after: 'Clear', reason: 'Clarify',
      } }, messageRef: { messageId: 'proposal-1' } } } });
    const postAgentMessage: NonNullable<Parameters<typeof createDiscussionActionDeps>[0]['postAgentMessage']> = async raw => {
      const posted = DiscussionAgentPostRequestV1Schema.parse(raw);
      expect(posted).toMatchObject({ sessionId: 'agent-session', discussionId: 'discussion-1', request: {
        localId: 'agent-proposal', replyTarget: { kind: 'message', messageId: 'message-1' }, docEditProposal: true,
      } });
      return { v: 1, ok: true, value: { message: { ...saved!.firstMessage, id: 'agent-proposal', seq: 3,
        localId: posted.request.localId!, content: posted.request.content, replyTarget: posted.request.replyTarget,
        docEditProposalDispositionV1: { state: 'open' },
        producerV1: { v: 1, kind: 'agent', sessionId: 'agent-session' } }, messageSeq: 3 } };
    };
    const agent = discussionExecutor({ discussionAction: action({ credentials: mode === 'plain' ? keyless : credentials, postAgentMessage }) });
    expect(await agent.execute('doc.edit.propose', { ...proposalInput, localId: 'agent-proposal' }, {
      ...context, surface: 'agent', authority: 'account_automation', defaultSessionId: 'agent-session',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'doc.edit.propose': ['agent'] } }),
    })).toMatchObject({ ok: true, result: { message: { docEditProposalDispositionV1: { state: 'open' }, content: { kind: 'doc_edit_proposal' },
      producerV1: { kind: 'agent', sessionId: 'agent-session' } } } });
  });

  it('clamps an Agent read to its protected question cutoff while ordinary user reads stay current', async () => {
    const reader = action();
    const discussionAddressing = { discussionId: 'discussion-1', messageId: 'message-1', throughSeq: 2, participantSessionId: 'receiver' };
    await reader({ actionId: 'discussion.read', input: { discussionId: 'discussion-1', messageId: 'message-1', throughSeq: 99 },
      context: { ...context, surface: 'agent', defaultSessionId: 'receiver',
        sessionInputSource: { sourceSessionId: 'receiver', sourceTurnId: 'turn', sourceInputId: 'input', via: 'action', discussionAddressing } } });
    const agentRead = axiosRequest.mock.calls.find(([request]) => new URL(request.url).pathname.endsWith('/messages'))![0];
    expect(new URL(agentRead.url).searchParams.get('throughSeq')).toBe('2');
    expect(new URL(agentRead.url).searchParams.get('messageId')).toBe('message-1');
    axiosRequest.mockClear();
    await reader({ actionId: 'discussion.read', input: { discussionId: 'discussion-1' }, context });
    const humanRead = axiosRequest.mock.calls.find(([request]) => new URL(request.url).pathname.endsWith('/messages'))![0];
    expect(new URL(humanRead.url).searchParams.has('throughSeq')).toBe(false);
  });

  it('intersects exact attachment reads with the protected original cutoff', async () => {
    const blobId = '8578de54-3f59-4d6d-8293-ff6e4682fd10';
    const reference = { blobId, mime: 'text/plain', sizeBytes: 5, sha256: createHash('sha256').update('bytes').digest('hex') };
    axiosRequest.mockImplementation(async request => new URL(request.url).pathname.includes('/attachments/')
      ? { status: 200, data: { blobId, content: { t: 'plain', v: 'Ynl0ZXM=' } } }
      : new URL(request.url).pathname.endsWith('/messages') ? { status: 200, data: {
        messages: [{ ...wireMessage(), id: 'ancestor', content: { t: 'plain', v: { v: 1, parts: [
          { t: 'attachment', attachment: { kind: 'file', id: blobId, name: 'notes.txt', file: reference } },
        ] } } }], messageSeq: 2, hasMoreOlder: false,
      } }
      : { status: 200, data: { discussion: wireSummary() } });
    const discussionAddressing = { discussionId: 'discussion-1', messageId: 'message-1', throughSeq: 2, participantSessionId: 'receiver' };
    const result = await action()({ actionId: 'discussion.attachment.read',
      input: { discussionId: 'discussion-1', messageId: 'ancestor', blobId, throughSeq: 99 },
      context: { ...context, surface: 'agent', defaultSessionId: 'receiver',
        sessionInputSource: { sourceSessionId: 'receiver', sourceTurnId: 'turn', sourceInputId: 'input', via: 'action', discussionAddressing } } });
    expect(result).toMatchObject({ ...reference, bytesBase64: 'Ynl0ZXM=' });
    const request = axiosRequest.mock.calls.find(([request]) => new URL(request.url).pathname.includes('/attachments/'))![0];
    expect(new URL(request.url).searchParams.get('throughSeq')).toBe('2');
  });

  it('preserves owned Session archive operands when opening the archived Discussion', async () => {
    const ownedSessions = [{ discussionId: 'discussion-1', participantSlotId: 'model-slot', sessionId: 'owned-reviewer' }];
    axiosRequest.mockResolvedValueOnce({ status: 200, data: {
      discussion: { ...wireSummary(), archivedAt: 2 }, ownedSessions,
    } });
    const result = await action()({ actionId: 'discussion.archive', input: { discussionId: 'discussion-1' }, context });
    expect(result).toMatchObject({ discussion: { id: 'discussion-1', title: 'Title', archivedAt: 2 }, ownedSessions });
    expect(axiosRequest.mock.calls[0]?.[0]).toMatchObject({ method: 'POST', url: 'https://home.example.test/v1/discussions/discussion-1/archive' });
  });

  it('creates a keyless Home discussion without selecting or fetching a Session', async () => {
    const result = await action()({ actionId: 'discussion.create', input: createInput, context });
    expect(result).toMatchObject({ discussion: { title: 'Title', encryptionMode: 'plain' },
      firstMessage: { content, messageRef: { kind: 'discussion', discussion: { serverId: 'server-1', discussionId: 'discussion-1' }, messageId: 'message-1' } } });
    expect(result).not.toHaveProperty('sessionId');
    const write = axiosRequest.mock.calls.find(([request]) => request.method === 'POST')![0];
    expect(write.url).toBe('https://home.example.test/v1/discussions');
    expect(DiscussionCreateRequestV1Schema.parse(JSON.parse(write.data))).toMatchObject({
      creationLocalId: 'creation-1', titleContent: { t: 'plain' }, firstMessage: { localId: 'message-1', content: { t: 'plain' } },
    });
    expect(axiosRequest.mock.calls.some(([request]) => request.url.includes('/sessions/'))).toBe(false);
  });

  it.each(['plain', 'e2ee'] as const)('composes captured %s file bytes with the original atomic create', async mode => {
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const reference = { blobId: '7578de54-3f59-4d6d-8293-ff6e4682fd10', mime: 'application/octet-stream', sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    const attached = { v: 1 as const, parts: [{ t: 'attachment' as const,
      attachment: { kind: 'file' as const, id: reference.blobId, name: 'evidence.bin', file: reference } }] };
    const captured: { key: ResourceDataKey | null; bytes: Uint8Array[] } = { key: null, bytes: [] };
    const caller = mode === 'plain' ? keyless : credentials;
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: unknown; headers?: Record<string, string> }) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/encryption/currentness')) return { status: 200, data: currentness(mode) };
      if (request.method === 'GET') return { status: 200, data: { discussions: [], nextCursor: null } };
      expect(path).toBe(DISCUSSION_UPLOAD_PATH_V1);
      expect(request.headers?.['Content-Type']).toBe(DISCUSSION_UPLOAD_CONTENT_TYPE_V1);
      if (!request.data || typeof request.data !== 'object' || !(Symbol.asyncIterator in request.data)) throw new Error('Expected streamed mutation');
      // Axios stream is the external HTTP boundary; all framing and crypto stay real.
      const metadata = await readBinaryUploadFrameV1(request.data as AsyncIterable<Uint8Array>, {
        metadataMaxBytes: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1, decodeMetadata: decodeDiscussionUploadMetadataV1,
        onMetadata: async metadata => {
          if (metadata.operation !== 'create') throw new Error('Expected create');
          captured.key = await openResourceDataKey({ credentials: caller, mode, dataEncryptionKey: metadata.input.dataEncryptionKey ?? null });
          if (captured.key.mode === 'e2ee') {
            const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: captured.key.dataKey, encryptionVariant: 'dataKey' as const } };
            const opened = openSessionStoredContent({ ...crypto, content: metadata.input.firstMessage.content });
            expect(metadata.input.firstMessage.requestEqualityEvidenceV1).toEqual({ kind: 'e2eeTag',
              tag: deriveDiscussionMutationEqualityTagV1({ dataKey: captured.key.dataKey,
                canonicalIntent: serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content: opened as typeof attached,
                  mentionedAccountIds: metadata.input.firstMessage.mentionedAccountIds,
                  mentionedSessionIds: metadata.input.firstMessage.mentionedSessionIds,
                  attachments: metadata.input.firstMessage.attachments }) }) });
          }
          return metadata.attachments;
        },
        onSegment: async (_index, chunks) => {
          const parts: Uint8Array[] = [];
          for await (const chunk of chunks) parts.push(chunk);
          if (!captured.key) throw new Error('Missing resource key');
          const stored = Buffer.concat(parts);
          captured.bytes.push(await openResourceBinaryContent(captured.key, reference, mode === 'plain'
            ? { t: 'plain', v: stored.toString('base64') } : { t: 'encrypted', c: stored.toString('base64') }));
        },
      });
      if (metadata.operation !== 'create' || !captured.key) throw new Error('Expected admitted create');
      const crypto: SessionStoredContentCryptoContext = captured.key.mode === 'plain' ? plain
        : { mode: 'e2ee', ctx: { encryptionKey: captured.key.dataKey, encryptionVariant: 'dataKey' } };
      return { status: 200, data: {
        discussion: { ...wireSummary(crypto, captured.key.dataEncryptionKey), titleContent: metadata.input.titleContent },
        firstMessage: { ...wireMessage(crypto), content: metadata.input.firstMessage.content },
      } };
    });
    const result = await action({ credentials: caller, readAttachmentSource: async blobId => {
      expect(blobId).toBe(reference.blobId); return bytes;
    } })({ actionId: 'discussion.create', input: { ...createInput, firstMessage: { ...createInput.firstMessage, content: attached } }, context });
    expect(result).toMatchObject({ firstMessage: { content: attached } });
    expect(captured.bytes.map(file => Buffer.from(file))).toEqual([bytes]);
    expect(axiosRequest.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1);
  });

  it('previews only source routing and actual audiences without sending quote or question plaintext', async () => {
    const source = { kind: 'doc_passage' as const, passage: {
      ref: { kind: 'doc' as const, serverId: 'server-1', artifactId: 'doc-1' },
      revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'Secret',
    } };
    const preview = DiscussionSecondOpinionPreviewV1Schema.parse({ source: { kind: 'doc_passage', doc: { ref: source.passage.ref, revision: source.passage.revision } },
      sourceAudienceAccountIds: ['account-1'], sourceContentReady: true, discussionAudienceAccountIds: ['account-1'],
      missingDiscussionSourceAccountIds: [], discussionDisclosure: { ok: true }, canGrantSource: false, reviewers: [] });
    axiosRequest.mockResolvedValueOnce({ status: 200, data: { ok: true, value: preview } });
    const result = await action()({ actionId: 'discussion.second_opinion.start', input: {
      intent: 'preview', source, title: 'Private title', question: 'Private question', reviewers: [],
      retry: { creationLocalId: 'creation', quoteLocalId: 'quote', questionLocalId: 'question' },
    }, context });
    expect(axiosRequest.mock.calls).toHaveLength(1);
    expect(result).toEqual({ ok: true, value: preview });
    const request = axiosRequest.mock.calls[0]![0];
    expect(request).toMatchObject({ method: 'POST', url: 'https://home.example.test/v1/discussions/second-opinion/preview' });
    expect(JSON.parse(request.data)).toEqual({ source: preview.source, reviewers: [] });
    expect(request.data).not.toMatch(/Secret|Private/);
  });

  it.each(['legacy', 'dataKey'] as const)('creates with live Account currentness and reopens an independent Discussion key (%s)', async variant => {
    const keyPair = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9));
    const caller: Credentials = variant === 'legacy' ? credentials : { token: credentials.token,
      encryption: { type: 'dataKey', publicKey: keyPair.publicKey, machineKey: keyPair.secretKey } };
    const publicKey = variant === 'legacy' ? libsodiumPublicKeyFromSecretKey(
      await deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']),
    ) : keyPair.publicKey;
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string }) => {
      if (request.url.endsWith('/encryption/currentness')) return { status: 200, data: {
        ...currentness('e2ee'), contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(publicKey),
      } };
      if (request.method === 'GET') return { status: 200, data: { discussions: [], nextCursor: null } };
      const body = DiscussionCreateRequestV1Schema.parse(JSON.parse(request.data!));
      // The server's recipient admission consumes the resource fingerprint, not Account currentness's encoding.
      expect(body.expectedOwnerContentPublicKeyFingerprint).toBe(computeContentPublicKeyFingerprint(publicKey));
      const resource = await openResourceDataKey({ credentials: caller, mode: 'e2ee', dataEncryptionKey: body.dataEncryptionKey! });
      if (resource.mode !== 'e2ee') throw new Error('Expected encrypted resource');
      const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: resource.dataKey, encryptionVariant: 'dataKey' as const } };
      expect(resource.dataKey).not.toEqual(credentials.encryption.secret);
      expect(openSessionStoredContent({ ...crypto, content: body.firstMessage.content })).toEqual(content);
      return { status: 200, data: { discussion: { ...wireSummary(crypto, body.dataEncryptionKey!), titleContent: body.titleContent },
        firstMessage: { ...wireMessage(crypto), content: body.firstMessage.content } } };
    });
    const result = await action({ credentials: caller })({ actionId: 'discussion.create', input: createInput, context });
    expect(result).toMatchObject({ discussion: { title: 'Title' }, firstMessage: { content } });
  });

  it.each(['keyless', 'stale'] as const)('refuses encrypted creation before publication with %s Account material', async state => {
    axiosRequest.mockImplementation(async (request: { url: string; method: string }) => {
      if (request.url.endsWith('/encryption/currentness')) return { status: 200, data: {
        ...currentness('e2ee'), ...(state === 'stale' ? {
          contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair().publicKey),
        } : {}),
      } };
      return { status: 200, data: { discussions: [], nextCursor: null } };
    });
    expect(await action({ credentials: state === 'keyless' ? keyless : credentials })({
      actionId: 'discussion.create', input: createInput, context,
    })).toMatchObject({ ok: false, errorCode: 'resource_encryption_material_unavailable' });
    expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
  });

  it.each(['active', 'archived'])('recovers the original encrypted create key through authorized %s pages after a lost response', async state => {
    const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
    if (resource.mode !== 'e2ee') throw new Error('Expected encrypted resource');
    const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: resource.dataKey, encryptionVariant: 'dataKey' as const } };
    let submitted: unknown;
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/encryption/currentness')) return { status: 200, data: currentness('e2ee') };
      if (request.method === 'GET') {
        expect(url.searchParams.get('creationLocalId')).toBe('creation-1');
        if (url.searchParams.get('state') !== state) return { status: 200, data: { discussions: [], nextCursor: null } };
        if (!url.searchParams.has('cursor')) return { status: 200, data: { discussions: [], nextCursor: 'next' } };
        return { status: 200, data: { discussions: [wireSummary(crypto, resource.dataEncryptionKey)], nextCursor: null } };
      }
      const body = DiscussionCreateRequestV1Schema.parse(JSON.parse(request.data!));
      submitted = body;
      expect(body.dataEncryptionKey).toBe(resource.dataEncryptionKey);
      expect(openSessionStoredContent({ ...crypto, content: body.firstMessage.content })).toEqual(content);
      return { status: 200, data: { discussion: wireSummary(crypto, resource.dataEncryptionKey), firstMessage: wireMessage(crypto) } };
    });
    await action({ credentials })({ actionId: 'discussion.create', input: createInput, context });
    expect(submitted).toMatchObject({ creationLocalId: 'creation-1', firstMessage: { localId: 'message-1' } });
    expect(axiosRequest.mock.calls.some(([request]) => request.url.includes('cursor=next'))).toBe(true);
  });

  it('opens each list row with its own resource mode/key and keeps locked rows incomplete', async () => {
    const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
    if (resource.mode !== 'e2ee') throw new Error('Expected encrypted resource');
    const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: resource.dataKey, encryptionVariant: 'dataKey' as const } };
    axiosRequest.mockResolvedValueOnce({ status: 200, data: {
      discussions: [wireSummary(), { ...wireSummary(crypto, resource.dataEncryptionKey), id: 'locked', keyReadiness: false, dataEncryptionKey: null }], nextCursor: null,
    } });
    expect(await action()({ actionId: 'discussion.list', input: {}, context })).toMatchObject({
      incomplete: true, discussions: [{ title: 'Title' }, { id: 'locked', title: null }],
    });
  });

  it('commits selected participants with create then delivers the same resource key through the admitted census', async () => {
    const signing = tweetnacl.sign.keyPair();
    const recipient = tweetnacl.box.keyPair();
    const fingerprint = computeContentPublicKeyFingerprint(recipient.publicKey);
    let resourceKey: Uint8Array | null = null;
    let ownerEnvelope = '';
    const steps: string[] = [];
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/encryption/currentness')) return { status: 200, data: currentness('e2ee') };
      if (url.pathname === '/v1/discussions' && request.method === 'GET') return { status: 200, data: { discussions: [], nextCursor: null } };
      if (url.pathname === '/v1/discussions' && request.method === 'POST') {
        steps.push('create');
        const body = DiscussionCreateRequestV1Schema.parse(JSON.parse(request.data!));
        expect(body.participants).toEqual([{ kind: 'account', accountId: 'invited' }]);
        ownerEnvelope = body.dataEncryptionKey!;
        const key = await openResourceDataKey({ credentials, mode: 'e2ee', dataEncryptionKey: ownerEnvelope });
        if (key.mode !== 'e2ee') throw new Error('Expected encrypted resource');
        resourceKey = key.dataKey;
        const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' as const } };
        return { status: 200, data: { discussion: wireSummary(crypto, ownerEnvelope), firstMessage: wireMessage(crypto) } };
      }
      if (url.pathname.endsWith('/data-key/recipients')) {
        steps.push('census');
        return { status: 200, data: { discussionId: 'discussion-1', ownerAccountId: 'account-1', encryptionMode: 'e2ee', access: 'owner',
          dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: ownerEnvelope, recipients: [{
            recipientAccountId: 'invited', contentPublicKeyFingerprint: fingerprint,
            encryptedDataKey: null, recipientContentPublicKeyFingerprint: null,
            contentKey: { status: 'available', accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'),
              contentPublicKey: Buffer.from(recipient.publicKey).toString('base64'),
              contentPublicKeySignature: Buffer.from(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey,
                contentPublicKey: recipient.publicKey })).toString('base64') },
          }] } };
      }
      if (url.pathname.endsWith('/data-key/envelopes')) {
        steps.push('commit');
        const body = JSON.parse(request.data!);
        expect(body.expectedDataEncryptionKey).toBe(ownerEnvelope);
        expect(openEncryptedDataKeyEnvelopeV1({ envelope: Buffer.from(body.recipientKeyEnvelopes[0].encryptedDataKey, 'base64'),
          recipientSecretKeyOrSeed: recipient.secretKey })).toEqual(resourceKey);
        return { status: 200, data: { appliedRecipientAccountIds: ['invited'], skippedRecipientAccountIds: [] } };
      }
      throw new Error('Unexpected request');
    });
    const result = await action({ credentials })({ actionId: 'discussion.create',
      input: { ...createInput, participants: [{ kind: 'account', accountId: 'invited' }] }, context });
    expect(result).toMatchObject({ discussion: { title: 'Title' } });
    expect(steps).toEqual(['create', 'census', 'commit']);
  });

  it('keeps an accepted encrypted create uncertain when post-commit key delivery cannot be confirmed', async () => {
    axiosRequest.mockImplementation(async request => {
      if (request.url.endsWith('/encryption/currentness')) return { status: 200, data: currentness('e2ee') };
      if (request.method === 'GET') return { status: 200, data: { discussions: [], nextCursor: null } };
      const body = DiscussionCreateRequestV1Schema.parse(JSON.parse(request.data!));
      const key = await openResourceDataKey({ credentials, mode: 'e2ee', dataEncryptionKey: body.dataEncryptionKey! });
      if (key.mode !== 'e2ee') throw new Error('Expected encrypted resource');
      const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' as const } };
      return { status: 200, data: { discussion: wireSummary(crypto, key.dataEncryptionKey), firstMessage: wireMessage(crypto) } };
    });
    const result = await action({ credentials })({ actionId: 'discussion.create',
      input: { ...createInput, participants: [{ kind: 'account', accountId: 'invited' }] }, context });
    expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST')).toBe(true);
  });

  it('uses the resource metadata before reading and produces the exact committed Home reference', async () => {
    const result = await action()({ actionId: 'discussion.read', input: { discussionId: 'discussion-1' }, context });
    expect(result).toMatchObject({ messages: [{ content }] });
    const parsed = result as { messages: Array<{ messageRef: unknown }> };
    expect(CoordinationMessageRefV1Schema.parse(parsed.messages[0]!.messageRef)).toEqual({
      kind: 'discussion', discussion: { serverId: 'server-1', discussionId: 'discussion-1' }, messageId: 'message-1',
    });
  });

  it('mutates plain resource grants through the canonical management transport without Account keys', async () => {
    let granted = false;
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string }) => {
      if (request.url.endsWith('/access/grants') && request.method === 'PUT') {
        const body = JSON.parse(request.data!);
        expect(body).toEqual({ principal: { kind: 'account', accountId: 'invited' }, accessLevel: 'edit' });
        granted = true;
        return { status: 200, data: { discussionId: 'discussion-1', ownerAccountId: 'account-1', access: 'owner', changed: true,
          grants: [{ ...body, createdByAccountId: 'account-1', createdAt: 1, display: { name: null } }] } };
      }
      return { status: 200, data: { discussion: wireSummary() } };
    });
    const result = await action()({ actionId: 'discussion.access.grants.set',
      input: { discussionId: 'discussion-1', principal: { kind: 'account', accountId: 'invited' }, accessLevel: 'edit' }, context });
    expect(granted).toBe(true);
    expect(result).toMatchObject({ changed: true, grants: [{ principal: { kind: 'account', accountId: 'invited' } }] });
    expect(result).not.toHaveProperty('cursor');
  });

  it('does not require a removed caller to reopen content for an idempotent leave', async () => {
    axiosRequest.mockResolvedValue({ status: 200, data: { discussionId: 'discussion-1', access: null, changed: false } });
    expect(await action()({ actionId: 'discussion.leave', input: { discussionId: 'discussion-1' }, context }))
      .toEqual({ discussionId: 'discussion-1', access: null, changed: false });
    expect(axiosRequest.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(['/v1/discussions/discussion-1/leave']);
  });

  it.each(['discussion.invite', 'discussion.access.grants.set'] as const)(
    'preserves server-admitted %s when only local decryption material is unavailable', async actionId => {
      const key = await createResourceDataKey({ credentials, mode: 'e2ee' });
      if (key.mode !== 'e2ee') throw new Error('Expected encrypted resource');
      const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' as const } };
      const locked = wireSummary(crypto, key.dataEncryptionKey);
      const effects: string[] = [];
      axiosRequest.mockImplementation(async (request: { url: string; method: string }) => {
        const path = new URL(request.url).pathname;
        if (path === '/v1/discussions/discussion-1' && request.method === 'GET') return { status: 200, data: { discussion: locked } };
        if (path.endsWith('/data-key/recipients')) return { status: 200, data: {
          discussionId: 'discussion-1', ownerAccountId: 'account-1', encryptionMode: 'e2ee', access: 'owner',
          dataEncryptionKey: key.dataEncryptionKey, callerDataEncryptionKey: key.dataEncryptionKey, recipients: [],
        } };
        effects.push(request.method + ' ' + path);
        return { status: 200, data: { discussionId: 'discussion-1', ownerAccountId: 'account-1', access: 'owner', changed: true,
          grants: [{ principal: { kind: 'account', accountId: 'invited' }, accessLevel: 'edit',
            createdByAccountId: 'account-1', createdAt: 1, display: { name: null } }] } };
      });
      const input = actionId === 'discussion.invite'
        ? { discussionId: 'discussion-1', participant: { kind: 'account', accountId: 'invited' } }
        : { discussionId: 'discussion-1', principal: { kind: 'account', accountId: 'invited' }, accessLevel: 'edit' };
      expect(await action()({ actionId, input, context })).toMatchObject({ changed: true, grants: [{ principal: { accountId: 'invited' } }] });
      expect(effects).toEqual([actionId === 'discussion.invite'
        ? 'POST /v1/discussions/discussion-1/participants/invite' : 'PUT /v1/discussions/discussion-1/access/grants']);
      // Server readiness is distinct from this client's absent private key.
      expect(await action()({ actionId: 'discussion.get', input: { discussionId: 'discussion-1' }, context }))
        .toMatchObject({ discussion: { keyReadiness: true, dataEncryptionKey: key.dataEncryptionKey, title: null } });
    },
  );

  it('reports uncertainty after an accepted grant when the real census refuses server-unready encryption', async () => {
    const key = await createResourceDataKey({ credentials, mode: 'e2ee' });
    if (key.mode !== 'e2ee') throw new Error('Expected encrypted resource');
    const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' as const } };
    let changed = false;
    axiosRequest.mockImplementation(async (request: { url: string; method: string }) => {
      if (request.url.endsWith('/data-key/recipients')) return { status: 400, data: { error: 'recipient_key_unavailable' } };
      if (request.method === 'GET') return { status: 200, data: {
        discussion: { ...wireSummary(crypto, key.dataEncryptionKey), keyReadiness: false, dataEncryptionKey: null },
      } };
      changed = true;
      return { status: 200, data: { discussionId: 'discussion-1', ownerAccountId: 'account-1', access: 'owner', changed: true, grants: [] } };
    });
    expect(await action()({ actionId: 'discussion.access.grants.set', input: {
      discussionId: 'discussion-1', principal: { kind: 'account', accountId: 'invited' }, accessLevel: 'edit',
    }, context })).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(changed).toBe(true);
  });

  it('rejects another Home before reading or writing', async () => {
    expect(await action()({ actionId: 'discussion.create', input: createInput, context: { ...context, serverId: 'other-home' } }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('projects typed Account and Session mentions into the same stored post', async () => {
    const addressed = { v: 1 as const, parts: [
      { t: 'mention' as const, participant: { kind: 'account' as const, accountId: 'account-b' } },
      { t: 'mention' as const, participant: { kind: 'session' as const, sessionId: 'participant-session' } },
    ] };
    const result = await action()({ actionId: 'discussion.post', input: { discussionId: 'discussion-1', content: addressed }, context });
    expect(result).toMatchObject({ message: { content: addressed, mentionedAccountIds: ['account-b'] } });
    const write = axiosRequest.mock.calls.find(([request]) => request.method === 'POST')![0];
    expect(DiscussionPostRequestV1Schema.parse(JSON.parse(write.data))).toMatchObject({
      mentionedAccountIds: ['account-b'], mentionedSessionIds: ['participant-session'],
    });
  });

  it('signs exact-Home external reads with the admitted execution proof instead of the daemon bearer', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'executor-session' };
    const authorization = {
      v: 1, token: 'execution-proof', binding: {
        serverIdentityId: 'server-1', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine-1', actionId: 'discussion.list', requestId: 'request-1',
        custodianAccountId: 'account-1', installationId: 'installation-1', requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    } satisfies ExternalActionExecutionAuthorizationV1;
    const result = await action({
      credentials: { token: 'daemon-token', encryption: null }, serverIdentityId: 'server-1',
      externalActionMachineRequestPrivateKey: keyPair.secretKey, externalActionMachineInstallationId: 'installation-1',
    })({ actionId: 'discussion.list', input: {}, context: {
      serverId: 'server-1', surface: 'cli', authority: 'account_automation',
      externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: authorization.binding.grant },
      externalActionExecutionAuthorization: authorization, externalActionTarget: target,
    } });
    expect(result).toMatchObject({ discussions: [] });
    const request = axiosRequest.mock.calls[0]![0];
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('execution-proof');
    expect(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('discussion.list');
    expect(verifyExternalActionMachineRequestV1({
      authorizationToken: authorization.token, effectActionId: 'discussion.list', target, installationId: 'installation-1',
      requestId: authorization.binding.requestId, method: 'GET', path: '/v1/discussions', publicKey: keyPair.publicKey,
      signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
    })).toBe(true);
  });

  it('never publishes an Agent result through a human HTTP fallback', async () => {
    const result = await action()({ actionId: 'discussion.post',
      input: { discussionId: 'discussion-1', localId: 'post-1', content },
      context: { serverId: 'server-1', surface: 'agent', authority: 'account_automation', defaultSessionId: 'participant-session' } });
    expect(result).toMatchObject({ ok: false, errorCode: 'discussion_post_denied' });
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('uses trusted Session caller custody rather than the presentation surface for Agent publication', async () => {
    const result = await action()({ actionId: 'discussion.post', input: { discussionId: 'discussion-1', content },
      context: { ...context, surface: 'mcp', authority: 'present_user', defaultSessionId: 'participant-session',
        actionCaller: { kind: 'session', sessionId: 'participant-session', starterDepth: 0, turnDepth: 0 } } });
    expect(result).toMatchObject({ ok: false, errorCode: 'discussion_post_denied' });
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('refuses an Agent create when no atomic trusted first-message publisher exists', async () => {
    const result = await action()({ actionId: 'discussion.create', input: createInput,
      context: { ...context, surface: 'mcp', authority: 'present_user', defaultSessionId: 'participant-session',
        actionCaller: { kind: 'session', sessionId: 'participant-session', starterDepth: 0, turnDepth: 0 } } });
    expect(result).toMatchObject({ ok: false, errorCode: 'discussion_post_denied' });
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it.each(['plain', 'e2ee'] as const)('atomically seals an admitted MCP Agent create through its sole trusted %s publisher', async mode => {
    axiosRequest.mockImplementation(async (request: { url: string; method: string }) => {
      if (request.url.endsWith('/encryption/currentness')) return { status: 200, data: currentness(mode) };
      if (request.method === 'GET') return { status: 200, data: { discussions: [], nextCursor: null } };
      throw new Error('An Agent create must never fall back to human HTTP');
    });
    const postAgentMessage = vi.fn<NonNullable<Parameters<typeof createDiscussionActionDeps>[0]['postAgentMessage']>>(async raw => {
      const request = DiscussionAgentCreateRequestV1Schema.parse(raw);
      expect(request).toMatchObject({ operation: 'create', sessionId: 'participant-session', toolCallId: 'create-tool',
        request: { creationLocalId: createInput.creationLocalId, firstMessage: { localId: createInput.firstMessage.localId } } });
      const key = await openResourceDataKey({ credentials: mode === 'plain' ? keyless : credentials, mode,
        dataEncryptionKey: request.request.dataEncryptionKey ?? null });
      const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? plain
        : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
      expect(openSessionStoredContent({ ...crypto, content: request.request.firstMessage.content })).toEqual(content);
      return { v: 1, ok: true, value: { discussion: { ...wireSummary(crypto, key.dataEncryptionKey), titleContent: request.request.titleContent },
        firstMessage: { ...wireMessage(crypto), content: request.request.firstMessage.content,
          producerV1: { v: 1, kind: 'agent', sessionId: request.sessionId, toolCallId: request.toolCallId } } } };
    });
    const result = await action({ credentials: mode === 'plain' ? keyless : credentials, postAgentMessage })({
      actionId: 'discussion.create', input: createInput, context: { ...context, surface: 'mcp', authority: 'present_user',
        defaultSessionId: 'participant-session', actionRequestId: 'create-tool',
        actionCaller: { kind: 'session', sessionId: 'participant-session', starterDepth: 0, turnDepth: 0 } },
    });
    expect(result).toMatchObject({ discussion: { title: 'Title' }, firstMessage: { content,
      producerV1: { sessionId: 'participant-session' }, messageRef: { kind: 'discussion', messageId: 'message-1' } } });
    expect(postAgentMessage).toHaveBeenCalledOnce();
    expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
  });

  it('uses admitted participant provenance when its Session is different from the optional anchor', async () => {
    const postAgentMessage = vi.fn<NonNullable<Parameters<typeof createDiscussionActionDeps>[0]['postAgentMessage']>>(async (request) => ({ v: 1 as const, ok: true as const, value: {
      message: { ...wireMessage(), content: DiscussionAgentPostRequestV1Schema.parse(request).request.content,
        producerV1: { v: 1 as const, kind: 'agent' as const, sessionId: 'participant-session', runId: 'run-1', toolCallId: 'tool-1' } }, messageSeq: 1,
    } }));
    const result = await action({ postAgentMessage })({ actionId: 'discussion.post',
      input: { discussionId: 'discussion-1', localId: 'post-1', content },
      context: { serverId: 'server-1', surface: 'agent', authority: 'account_automation', defaultSessionId: 'participant-session',
        runtimeRunId: 'run-1', approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'participant-session', toolCallId: 'tool-1' } } });
    expect(result).toMatchObject({ message: { content, producerV1: { sessionId: 'participant-session', runId: 'run-1', toolCallId: 'tool-1' } } });
    expect(postAgentMessage.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'participant-session', discussionId: 'discussion-1' });
    expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
  });

  it.each([undefined, 'approval'])('publishes a reviewed Discussion with optional Artifact %s', async artifactId => {
    let transportIssues: readonly Readonly<{ code: string; path: readonly PropertyKey[] }>[] = [];
    const postAgentMessage: NonNullable<Parameters<typeof createDiscussionActionDeps>[0]['postAgentMessage']> = async (request, options) => {
      if (artifactId) {
        const wire = DiscussionAgentPublisherRequestV1Schema.safeParse({ request, approvedActionReplay: options?.approvedActionReplay });
        if (!wire.success) { transportIssues = wire.error.issues.map(({ code, path }) => ({ code, path })); throw new Error('Invalid private publication'); }
      } else {
        // Native confirmation keeps the actual Session publisher and its live
        // turn custody; it has no persisted approval to reopen over RPC.
        expect(options?.approvedActionReplay).toBeUndefined();
      }
      return { v: 1, ok: true, value: { message: { ...wireMessage(), content: DiscussionAgentPostRequestV1Schema.parse(request).request.content,
        producerV1: { v: 1, kind: 'agent', sessionId: 'participant-session', runId: 'run-1', toolCallId: 'tool-1' } }, messageSeq: 1 } };
    };
    const result = await action({ postAgentMessage })({ actionId: 'discussion.post',
      input: { discussionId: 'discussion-1', localId: 'post-1', content },
      context: { serverId: 'server-1', surface: 'agent', authority: 'account_automation', defaultSessionId: 'participant-session',
        approvedActionReplay: { ...(artifactId ? { artifactId } : {}), origin: { surface: 'agent',
          caller: { kind: 'session', sessionId: 'participant-session', starterDepth: 0, turnDepth: 0 } } } } });
    expect(transportIssues).toEqual([]);
    expect(result).toMatchObject({ message: { content } });
  });

  it('keys approved retries by the operation rather than an optional Artifact', async () => {
    const localIds: string[] = [];
    axiosRequest.mockImplementation(async request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/discussions/discussion-1') return { status: 200, data: { discussion: wireSummary() } };
      if (path === '/v1/discussions/discussion-1/messages' && request.method === 'POST') {
        const body = DiscussionPostRequestV1Schema.parse(JSON.parse(request.data));
        localIds.push(body.localId!);
        return { status: 200, data: { message: { ...wireMessage(), localId: body.localId!, content: body.content }, messageSeq: 1 } };
      }
      throw new Error('Unexpected retry request');
    });
    const execute = action();
    for (const [actionRequestId, artifactId] of [['operation-1', undefined], ['operation-1', 'artifact-1'],
      ['operation-2', undefined], ['operation-2', 'artifact-2']] as const) {
      expect(await execute({ actionId: 'discussion.post', input: { discussionId: 'discussion-1', content },
        context: { ...context, actionRequestId, approvedActionReplay: artifactId ? { artifactId } : {} } }))
        .toMatchObject({ message: { content } });
    }
    expect(localIds[0]).toBe(localIds[1]);
    expect(localIds[2]).toBe(localIds[3]);
    expect(localIds[0]).not.toBe(localIds[2]);
  });

  it('publishes an explicit MCP reply through the admitted participant transport with its exact parent', async () => {
    const replyTarget = { kind: 'message' as const, messageId: 'original-question' };
    const postAgentMessage = vi.fn<NonNullable<Parameters<typeof createDiscussionActionDeps>[0]['postAgentMessage']>>(
      async request => ({ v: 1, ok: true, value: {
        message: { ...wireMessage(), content: DiscussionAgentPostRequestV1Schema.parse(request).request.content, replyTarget,
          producerV1: { v: 1, kind: 'agent', sessionId: 'participant-session' } },
        messageSeq: 1,
      } }),
    );
    const result = await action({ postAgentMessage })({ actionId: 'discussion.reply',
      input: { discussionId: 'discussion-1', localId: 'explicit-reply', content, replyTarget },
      context: { serverId: 'server-1', surface: 'mcp', authority: 'account_automation',
        actionCaller: { kind: 'session', sessionId: 'participant-session', starterDepth: 0, turnDepth: 0 },
        defaultSessionId: 'participant-session' } });
    expect(result).toMatchObject({ message: { content, replyTarget,
      producerV1: { sessionId: 'participant-session' } } });
    expect(postAgentMessage.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'participant-session', discussionId: 'discussion-1',
      request: expect.objectContaining({ localId: 'explicit-reply', replyTarget }),
    });
    expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
  });

  it('distinguishes preparation read failure and cancellation from an unknown in-flight write', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await action()({ actionId: 'discussion.list', input: {}, context, signal: controller.signal }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(axiosRequest).not.toHaveBeenCalled();
    const original = axiosRequest.getMockImplementation()!;
    axiosRequest.mockRejectedValueOnce(new Error('Disconnected'));
    expect(await action()({ actionId: 'discussion.post', input: { discussionId: 'discussion-1', localId: 'retry', content }, context }))
      .toMatchObject({ ok: false, errorCode: 'discussions_unavailable' });
    expect(axiosRequest.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
    axiosRequest.mockResolvedValueOnce({ status: 500, data: { error: 'Internal server error' } });
    expect(await action()({ actionId: 'discussion.post', input: { discussionId: 'discussion-1', localId: 'retry', content }, context }))
      .toMatchObject({ ok: false, errorCode: 'discussions_unavailable' });
    const duringRead = new AbortController();
    axiosRequest.mockImplementationOnce(async () => { duringRead.abort(); throw new Error('Read cancelled'); });
    expect(await action()({ actionId: 'discussion.post', input: { discussionId: 'discussion-1', localId: 'retry', content },
      context, signal: duringRead.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    axiosRequest.mockImplementation(async (request: { url: string; method: string; data?: string }) => {
      if (request.method === 'POST') throw new Error('Response lost after dispatch');
      return original(request);
    });
    expect(await action()({ actionId: 'discussion.post', input: { discussionId: 'discussion-1', localId: 'retry', content }, context }))
      .toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
  });
});
