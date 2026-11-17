import axios from 'axios';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ProjectSourcesMoveToTeamOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { AgentRuntimeDaemonServiceRequestV1Schema, type AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import nacl from 'tweetnacl';
import { mintExternalActionExecutionAuthorization, projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionApprovalInputV1,
  verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionRequestEnvelopeV1Schema,
  ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema,
  externalActionExecutionAuthorizationRequestSchemaForActionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { AccountProfileResponseSchema, AccountSettingsSchema, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { prepareExternalActionRequesterAccountAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createDaemonManagedMachineActionAdapter } from '../startup/managedMachineActionAdapter';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { tmpdir } from 'node:os';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { resolveExternalActionMachineTarget } from '../externalActions/reconcileExternalActionTarget';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '../externalActions/daemonExternalActionTargetResolver';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import * as installationStore from '@/daemon/identity/store';
import { RPC_METHODS, UiActionDispatchRequestV1Schema } from '@happier-dev/protocol';
import { resolveApprovalExecutor, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { logger } from '@/ui/logger';
import { REVIEW_COMMENT_PRINCIPAL_HEADER_V1, ReviewCommentPrincipalHeaderV1Schema, createReviewCommentPrincipalSigningInputV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { splitReviewCommentV1, sealReviewCommentSensitiveEnvelopeV1 } from '@happier-dev/protocol/reviews/comments/content';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { readPluginInstallApprovalPendingReview, resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from './sessionBridgeAuthorization';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionAgentCreateRequestV1Schema, DiscussionAgentPostRequestV1Schema,
  type DiscussionAgentPublisherRequestV1 } from '@happier-dev/protocol/discussions/api';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { fetchAccountProfile } from '@/api/accountProfile';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { VoiceRunActionDispatchRequestV1Schema, voiceRunActionClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';

const processIdentityBoundary = vi.hoisted(() => vi.fn());
// Process inspection is the OS boundary. Tests that do not configure the
// override retain the real implementation.
vi.mock('@/daemon/processIdentity', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/daemon/processIdentity')>();
  return { ...original, readProcessIdentityByPid: (...args: Parameters<typeof original.readProcessIdentityByPid>) => {
    const override = processIdentityBoundary.getMockImplementation();
    return override ? override(...args) : original.readProcessIdentityByPid(...args);
  } };
});

type Operation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;
const operation: Operation = {
  kind: 'action.execute', requestId: 'request-1', actionId: 'notifications.notify_me', input: { message: 'Finished' },
  witness: { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 2,
    agentStartCaller: { kind: 'session', sessionId: 'bob-session', starterDepth: 1, turnDepth: 2 } },
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); processIdentityBoundary.mockReset();
  resetActiveAccountSettingsSnapshotForTests(); });

const harnessCredentials = { token: 'alice-daemon-token', encryption: null } as const;

/** Bob's plain Session as Home returns it; its owner metadata carries the approval profile. */
function ownedSessionRecord(owner: Readonly<{ approvalProfileId?: string }> = {}) {
  const fields = buildSessionMetadataEnvelopeCreateFields({ credentials: harnessCredentials, accountEncryptionMode: 'plain',
    storedContentMode: 'plain', metadata: { ...createTestMetadata({ machineId: 'alice-machine' }), ...owner }, agentState: null });
  return { ...createSessionRecordFixture({ id: 'bob-session', share: null }), encryptionMode: 'plain',
    metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata };
}

function createHarness(prepareExternalActionAuthorization?: Parameters<typeof createDaemonSessionAccountActionExecutor>[0]['prepareExternalActionAuthorization']) {
  const delivered: unknown[] = [];
  let current: (() => Promise<boolean>) | undefined;
  const params = {
    serverId: 'alice-home', serverHttpBaseUrl: 'https://alice-home.test', token: 'alice-daemon-token',
    credentials: harnessCredentials, readAccountEncryptionMode: async () => 'plain' as const,
    ...(prepareExternalActionAuthorization ? { prepareExternalActionAuthorization } : {}),
    createExecutor: (_depth: (turnId?: string) => number | undefined, isCallerCurrent: () => Promise<boolean>) => {
      current = isCallerCurrent;
      return createActionExecutor({
        ...createCliActionDeps({ token: 'alice-daemon-token', sessionId: '', mode: 'plain', ctx: null }),
        // Account notification delivery is an external network boundary.
        notificationsNotifyMe: async (input, context) => {
          delivered.push({ input, context });
          return { attemptedChannels: 1, deliveredChannels: 1 };
        },
      });
    },
  };
  return { execute: createDaemonSessionAccountActionExecutor(params), delivered,
    isCallerCurrent: () => current?.() };
}

describe('daemon Session Account authority', () => {
  it('returns the owning Voice client result for an admitted active Run without replacing its admission', async () => {
    const child: Operation = { ...operation, executionRun: { runId: 'voice-run', occurrenceId: 'voice-occurrence' } };
    const execute = createDaemonSessionAccountActionExecutor({
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test', token: 'daemon-token',
      createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()),
      getMachineClient: () => ({ hasConnectedClientRpcHandler: () => true,
        callConnectedClientRpc: async (method, raw, options) => {
          expect(method).toBe(voiceRunActionClientRpcMethod('voice-run'));
          const request = VoiceRunActionDispatchRequestV1Schema.parse(raw);
          expect(request.voiceRun).toEqual({ runId: 'voice-run', sessionId: 'bob-session',
            occurrenceId: 'voice-occurrence', turnId: operation.witness.turnId, actionRequestId: child.requestId });
          options.onIssued();
          // The owning UI has already validated then privacy-projected the Action output.
          return { ok: true, result: { v: 1, execution: { ok: true, result: { deliveredChannels: 1 } } } };
        },
      }),
    });
    const invocation = { caller: { kind: 'host' as const }, surface: 'voice' as const, authority: 'present_user' as const };
    expect(await execute(child, { sessionId: 'bob-session', isCurrent: async () => true, actionInvocation: invocation }))
      .toEqual({ ok: true, result: { deliveredChannels: 1 } });
    expect(await execute(child, { sessionId: 'bob-session', isCurrent: async () => false, actionInvocation: invocation }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  });
  it('projects native input admission into the real Action executor context and preserves its effect currentness', async () => {
    const refusalDiagnostics = vi.spyOn(logger, 'warnLocalFile');
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    const harness = createHarness();
    const admission = { admissionId: 'native-input', occurrenceId: 'realtime-occurrence', attemptId: 'attempt' };
    const nativeOperation: Operation = { ...operation, witness: { ...operation.witness,
      inputId: admission.admissionId, userMessageSeq: null, userMessageSeqs: [], nativeRealtimeAdmission: admission } };
    let live = true;
    expect(await harness.execute(nativeOperation, { sessionId: 'bob-session', isCurrent: async () => live }),
      JSON.stringify(refusalDiagnostics.mock.calls.filter(([message]) => message === '[Session Account Action] Refused')))
      .toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    expect(harness.delivered).toEqual([expect.objectContaining({ context: expect.objectContaining({ nativeRealtimeInput: true }) })]);
    expect(await harness.execute({ ...nativeOperation, actionId: 'approval.request.decide',
      input: { artifactId: 'ordinary-approval', decision: 'approve' } }, { sessionId: 'bob-session', isCurrent: async () => live }))
      .toEqual({ ok: false, errorCode: 'present_user_required', error: 'present_user_required' });
    live = false;
    expect(await harness.isCallerCurrent()).toBe(false);
    expect(await harness.execute(nativeOperation, { sessionId: 'bob-session', isCurrent: async () => live }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(harness.delivered).toHaveLength(1);
  });
  it.each(['caller', 'authorization'] as const)('recovers a retryable %s Home read inside the accepted Action lifetime before delivering once', async phase => {
    if (phase === 'caller') {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
    }
    const lifetime = new AbortController();
    onTestFinished(() => lifetime.abort());
    let failures = 0;
    // Exceed the shared backoff's ordinary eight-attempt ceiling. The accepted
    // Action lifetime, rather than that unrelated default, owns this recovery.
    const failuresBeforeRecovery = phase === 'caller' ? 10 : 1;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (failures < failuresBeforeRecovery && (phase === 'caller' ? path.startsWith('/v2/sessions/') : path === '/v1/account/profile')) {
        failures++;
        throw Object.assign(new Error('Home read timed out'), { code: 'ECONNABORTED', isAxiosError: true });
      }
      if (path.startsWith('/v2/sessions/')) return { status: 200,
        data: { session: ownedSessionRecord() } };
      return { status: 200, data: AccountProfileResponseSchema.parse({ id: 'owner' }) };
    });
    const harness = createHarness(async () => {
      await fetchAccountProfile({ token: 'alice-daemon-token', signal: lifetime.signal });
      return undefined;
    });
    const pending = harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => true, signal: lifetime.signal });
    if (phase === 'caller') {
      await vi.advanceTimersByTimeAsync(0);
      expect(failures).toBe(1);
      expect(harness.delivered).toEqual([]);
      await vi.runAllTimersAsync();
    }
    expect(await pending)
      .toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    expect(failures).toBe(failuresBeforeRecovery);
    expect(harness.delivered).toHaveLength(1);
  });

  it('ends Home read recovery when the accepted Action is cancelled without delivering an effect', async () => {
    const lifetime = new AbortController();
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      lifetime.abort();
      throw Object.assign(new Error('Home read timed out'), { code: 'ECONNABORTED', isAxiosError: true });
    });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => true, signal: lifetime.signal }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(harness.delivered).toEqual([]);
  });

  it('stops preparation recovery when runtime custody retires before the next Home read', async () => {
    let current = true;
    const reads = vi.spyOn(axios, 'get').mockImplementation(async () => {
      if (current) {
        current = false;
        throw new axios.AxiosError('Requester Home read timed out', 'ECONNABORTED');
      }
      return { status: 200, data: { session: ownedSessionRecord() } };
    });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => current,
      signal: new AbortController().signal }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'runtime_authority_unavailable' } });
    // A retired requester must not continue opening Account reads while the
    // accepted transport is still connected.
    expect(reads).toHaveBeenCalledTimes(1);
    expect(harness.delivered).toEqual([]);
  });

  it.each(['doc.comment.reply', 'doc.edit.propose', 'compact-proposal', 'compact-e2ee-proposal', 'compact-reviewed-proposal'] as const)(
    'admits %s through exact Session custody and rejects substituted child metadata', async scenario => {
    const compact = scenario.startsWith('compact-');
    const reviewed = scenario === 'compact-reviewed-proposal';
    const actionId = scenario === 'doc.comment.reply' ? scenario : 'doc.edit.propose';
    const serverId = 'alice-home';
    const serverHttpBaseUrl = 'https://alice-home.test';
    const credentials = { token: 'token', encryption: scenario === 'compact-e2ee-proposal'
      ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } : null };
    const key = await createResourceDataKey({ credentials, mode: credentials.encryption ? 'e2ee' : 'plain' });
    const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? { mode: 'plain', ctx: null }
      : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
    const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Clarify' }] };
    const target = { ref: { kind: 'doc' as const, artifactId: 'doc-1', serverId },
      revision: { headerVersion: 1, bodyVersion: 2 }, range: { start: 0, end: 3 }, quote: 'old' };
    const input = compact
      ? { localId: 'doc-proposal', discussionRef: { serverId: 'srv_home', discussionId: 'discussion-1' }, after: 'new' }
      : actionId === 'doc.comment.reply' ? { target, localId: 'doc-root', content }
      : { target, localId: 'doc-proposal', discussionRef: { serverId, discussionId: 'discussion-1' },
        baseRevision: target.revision, before: 'old', after: 'new', reason: 'Clarify' };
    const docOperation: Operation = { ...operation, actionId, input, witness: { ...operation.witness,
      ...(compact ? { discussionAddressing: { discussionId: 'discussion-1', messageId: 'root-1', throughSeq: 1,
        participantSessionId: 'bob-session' } } : {}) } };
    const summary = DiscussionSummaryV1Schema.parse({ id: 'discussion-1', ownerAccountId: 'owner', encryptionMode: key.mode,
      anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: key.dataEncryptionKey, creationLocalId: 'creation-1',
      titleContent: sealSessionStoredContent({ ...crypto, payload: { v: 1, title: 'Discussion' } }),
      latestMessage: { id: 'root-1', localId: 'root-1', seq: 1, authorAccountId: 'owner',
        accountActor: { v: 1, accountId: 'owner', profile: null }, producerV1: null, createdAt: 1 }, messageSeq: 1,
      lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
      capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
        sendToSession: true, manageAccess: true, leave: false } });
    const encodeArtifact = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
      : encodeBase64(encryptWithDataKey(value, key.dataKey), 'base64');
    const artifact = { id: 'doc-1', header: encodeArtifact({ kind: 'markdown', title: 'Document' }), body: encodeArtifact({ body: 'old' }),
      headerVersion: 1, bodyVersion: 2, seq: 1, createdAt: 1, updatedAt: 1,
      ownerAccountId: 'owner', access: 'owner', encryptionMode: key.mode,
      dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey };
    const artifactReads = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts/doc-1') return { status: 200, data: { publicAudience: 'none', ...artifact } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: key.mode, updatedAt: 1 } };
      if (path === '/v1/artifacts/doc-1/access/recipients') return { status: 200, data: {
        artifactId: artifact.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: key.mode,
        dataEncryptionKey: key.dataEncryptionKey, callerDataEncryptionKey: key.dataEncryptionKey, recipients: [],
      } };
      if (path === '/v1/artifacts/doc-1/access/grants') return { status: 200, data: {
        artifactId: artifact.id, ownerAccountId: 'owner', access: 'owner', grants: [],
      } };
      if (path === '/v2/sessions/bob-session') return { status: 200,
        data: { session: ownedSessionRecord() } };
      throw new Error(`Unexpected Doc custody GET ${path}`);
    });
    const http = vi.spyOn(axios, 'request').mockImplementation(async request => {
      const path = new URL(String(request.url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: { mode: key.mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/discussions/discussion-1') return { status: 200, data: { discussion: summary } };
      if (path === '/v1/discussions/discussion-1/messages') return { status: 200, data: {
        messages: [{ id: 'root-1', discussionId: summary.id, localId: 'root-1', seq: 1,
          authorAccountId: 'owner', accountActor: { v: 1, accountId: 'owner', profile: null }, producerV1: null,
          content: sealSessionStoredContent({ ...crypto, payload: { kind: 'doc_passage_comment', passage: target, content } }),
          replyTarget: { kind: 'doc_passage', doc: { ref: target.ref, revision: target.revision } },
          mentionedAccountIds: [], createdAt: 1 }], messageSeq: 1, hasMoreOlder: false,
      } };
      throw new Error(`Unexpected Doc custody HTTP ${path}`);
    });
    const publications: DiscussionAgentPublisherRequestV1[] = [];
    const denied: unknown[] = [];
    let stored: ApprovalRequest | undefined;
    const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl, token: 'token',
      credentials,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
      }) }),
      postAgentDiscussionMessage: async (raw, witness) => {
        expect(witness).toEqual(docOperation.witness);
        publications.push(raw);
        const created = 'operation' in raw ? DiscussionAgentCreateRequestV1Schema.parse(raw) : null;
        const message = created ? created.request.firstMessage : DiscussionAgentPostRequestV1Schema.parse(raw).request;
        const stored = { id: 'posted-doc', discussionId: summary.id, localId: message.localId, seq: 2,
          authorAccountId: 'owner', accountActor: { v: 1 as const, accountId: 'owner', profile: null },
          producerV1: { v: 1 as const, kind: 'agent' as const, sessionId: 'bob-session' },
          content: message.content, mentionedAccountIds: message.mentionedAccountIds, replyTarget: message.replyTarget, createdAt: 1 };
        return created ? { v: 1, ok: true, value: { discussion: { ...summary, creationLocalId: created.request.creationLocalId,
          titleContent: created.request.titleContent }, firstMessage: stored } }
          : { v: 1, ok: true, value: { message: stored, messageSeq: 2 } };
      },
      createExecutor: (_depth, _current, publisher) => {
        const real = createActionExecutor({ ...createUnavailableActionTransportDeps(),
          artifactAction: createCliActionDeps({ credentials, token: credentials.token,
            serverId, serverHttpBaseUrl, sessionId: '', mode: 'plain', ctx: null }).artifactAction,
          // Approval Artifact persistence and Session notification are boundaries; admission and passage preparation stay real.
          approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'doc-proposal-review' }; },
          sessionSendMessage: async ({ localId }) => ({ status: 'accepted', localId }),
          ...createDiscussionActionDeps({ credentials,
          serverId, serverHttpBaseUrl, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
          }) }), ...(publisher ? { postAgentMessage: async (request, options) => {
            const substituted = 'operation' in request
              ? { ...request, request: { ...request.request, firstMessage: { ...request.request.firstMessage, localId: 'unapproved-child' } } }
              : { ...request, request: { ...request.request, localId: 'unapproved-child' } };
            denied.push(await publisher(substituted, options));
            const wrongTarget = 'operation' in request
              ? { ...request, request: { ...request.request, firstMessage: { ...request.request.firstMessage, replyTarget: undefined } } }
              : { ...request, request: { ...request.request, replyTarget: undefined } };
            denied.push(await publisher(wrongTarget, options));
            const wrongMarker = 'operation' in request
              ? { ...request, request: { ...request.request, firstMessage: { ...request.request.firstMessage, docEditProposal: true as const } } }
              : { ...request, request: { ...request.request, docEditProposal: undefined } };
            denied.push(await publisher(wrongMarker, options));
            return publisher(request, options);
          } } : {}) }) });
        return { execute: (id, args, context) => real.execute(id, args, { ...context,
          runtimeAccountId: 'owner', serverIdentityId: 'srv_home', defaultSessionMachineId: 'machine-1',
          actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: reviewed ? {} : { [actionId]: ['agent'] } }) }) };
      },
    });
    const result = await execute(docOperation, { sessionId: 'bob-session', isCurrent: async () => true });
    if (compact) {
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(http.mock.calls.filter(([request]) => new URL(String(request.url)).pathname.endsWith('/messages'))).toHaveLength(1);
      expect(artifactReads.mock.calls.filter(([url]) => String(url).endsWith('/v1/artifacts/doc-1'))).toHaveLength(1);
    }
    if (reviewed) {
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(stored?.actionArgs).toMatchObject({ target: { ...target, ref: { ...target.ref, serverId: 'srv_home' } },
        baseRevision: target.revision, before: 'old', after: 'new', reason: '' });
      expect(publications).toEqual([]);
      return;
    }
    expect(result)
      .toMatchObject({ ok: true, result: { message: { producerV1: { kind: 'agent', sessionId: 'bob-session' }, content: {
        kind: actionId === 'doc.comment.reply' ? 'doc_passage_comment' : 'doc_edit_proposal',
      } } } });
    expect(denied).toEqual(Array.from({ length: 3 }, () => ({ v: 1, ok: false, error: 'discussion_post_denied' })));
    expect(publications).toHaveLength(1);
  });
  it('retains the host-bound external Agent principal through credentialed comment reads', async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'comment-owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(63));
    await updateSettings(settings => ({ ...settings, machineIdByServerId: {
      ...settings.machineIdByServerId, [configuration.activeServerId]: 'comment-machine',
    } }));
    vi.spyOn(installationStore, 'readOrCreateInstallationIdentity').mockResolvedValue({ version: 1,
      installationId: 'comment-installation', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
      privateKey: Buffer.from(keys.secretKey).toString('base64url') });
    const comment = ReviewCommentV1Schema.parse({ v: 1, id: 'comment-1', accountId: 'comment-owner',
      workspace: { machineId: 'comment-machine', path: '/workspace' }, sessionId: 'bob-session',
      anchor: { kind: 'file', filePath: 'a.ts' }, snapshot: { kind: 'none', capturedAt: 1 }, body: 'Retained finding',
      bodyVersion: 1, edits: [], author: { kind: 'user', userId: 'comment-owner' }, state: 'open', flags: {},
      dispositions: {}, threadId: 'comment-1', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 });
    const split = splitReviewCommentV1(comment);
    const stored = { v: 1, structural: split.structural, sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({
      ...split, mode: 'plain' }) };
    const principal = { actor: { kind: 'agent' as const, agentId: 'acme.external/agent', sessionId: 'bob-session' } };
    const reads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions/bob-session') return { status: 200, data: { session: ownedSessionRecord() } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/reviews/comments/comment-1') {
        const header = ReviewCommentPrincipalHeaderV1Schema.parse(JSON.parse(Buffer.from(String(config?.headers?.[REVIEW_COMMENT_PRINCIPAL_HEADER_V1]), 'base64url').toString()));
        expect(header.actor).toEqual(principal.actor);
        const proof = header.proof!;
        const { signatureBase64Url, ...unsignedProof } = proof;
        expect(nacl.sign.detached.verify(createReviewCommentPrincipalSigningInputV1({ actor: header.actor, proof: unsignedProof }),
          Buffer.from(signatureBase64Url, 'base64url'), keys.publicKey)).toBe(true);
        reads.push(path); return { status: 200, data: { comment: stored } };
      }
      throw new Error(`Unexpected comment read ${path}`);
    });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'comment-home', serverHttpBaseUrl: 'https://comment-home.test', token,
      createExecutor: () => createActionExecutor(createCliActionDeps({ token, credentials, sessionId: '', mode: 'plain', ctx: null })) });
    const request = { ...operation, actionId: 'reviews.comments.get' as const, input: { commentId: comment.id }, reviewCommentPrincipal: principal };
    await expect(runWithServerHttpBaseUrl('https://comment-home.test', () => execute(request,
      { sessionId: 'bob-session', isCurrent: async () => true }))).resolves.toEqual({ ok: true, result: { comment } });
    expect(reads).toEqual(['/v1/reviews/comments/comment-1']);
    await expect(execute({ ...request, reviewCommentPrincipal: { actor: { ...principal.actor, sessionId: 'foreign-session' } } },
      { sessionId: 'bob-session', isCurrent: async () => true })).resolves.toMatchObject({ ok: false, errorCode: 'review_comment_permission_denied' });
    expect(reads).toHaveLength(1);
  });
  it.each(['installed-machine', undefined])('binds start refusal diagnostics to the installed Machine (%s)', async machineId => {
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const execute = createDaemonSessionAccountActionExecutor({
      serverId: 'diagnostic-home', serverHttpBaseUrl: 'https://diagnostic-home.test', token: 'diagnostic-token',
      ...(machineId ? { machineId } : {}),
      initialStartDiagnostic: { phase: 'requester_runtime', refusalReason: 'requester_runtime_unavailable' },
      createExecutor: () => { throw new Error('Retired authority must not construct an executor'); },
    });
    await expect(execute({ ...operation, actionId: 'session.spawn_new',
      requestId: '70cc64d3-0386-4914-b7d8-713b7879e99f' },
    { sessionId: 'bob-session', isCurrent: async () => false })).resolves.toMatchObject({ ok: false });
    const phases = log.mock.calls.filter(([message]) => message === '[external-action-phase]');
    if (machineId) expect(phases).toEqual([
      ['[external-action-phase]', expect.objectContaining({ machineId, phase: 'requester_runtime' })],
    ]);
    else expect(phases).toEqual([]);
  });

  it.each(['session.spawn_new', 'template.instantiate'] as const)(
    'admits inherited %s authoring to original Home proof preparation', async actionId => {
    const serverHttpBaseUrl = 'https://inherited-spawn.test';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    // Home HTTP is the boundary. Keep the real authored-input producer and
    // installation proof; a refused Home must remain an authority refusal.
    let produced: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse> | undefined;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      produced = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 401, data: { error: 'invalid_token' } };
    });
    const creation = { creationKey: 'inherited-child', directory: { kind: 'path', path: '/tmp' } };
    const input = actionId === 'session.spawn_new'
      ? { ...creation, initialInput: { text: 'Reply READY, then idle.' } }
      : { source: { kind: 'artifact', serverId: 'inherited-home', artifactId: '84a6bc9c-0418-44f6-a593-8a751bde13e0' },
        expectedVersion: '1.0.0', creation };
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'inherited-home',
      serverHttpBaseUrl, token, machineId: 'machine',
      prepareExternalActionAuthorization: async ({ operation: action, sessionActionOrigin }) => {
        const selected = resolveActionExecutionPlacementForInput(getActionSpec(action.actionId), action.input, sessionActionOrigin.caller, action.surface ?? 'agent') === 'machine'
          ? resolveExternalActionMachineTarget({ actionId: action.actionId, rawInput: action.input, fallbackMachineId: 'machine' })
          : { kind: 'ready' as const, machineId: 'machine' };
        if (selected.kind === 'rejected') return null;
        const target = { kind: 'machine' as const, machineId: selected.machineId };
        const authorization = await prepareExternalActionRequesterAccountAuthorization({ ...action,
          target, machineId: selected.machineId, sourceMachineId: 'machine', accountId: 'owner',
          accountEncryptionMode: 'plain', tokenEpochHint: 0, token, serverId: 'inherited-home',
          serverIdentityId: 'srv_inherited', serverHttpBaseUrl, installationId: 'installation',
          privateKey: keys.secretKey, sessionActionOrigin });
        return authorization ? { authorization, target } : null;
      },
      createExecutor: () => createActionExecutor(createCliActionDeps({ token, sessionId: '', mode: 'plain', ctx: null })),
    });
    expect(await execute({ ...operation, actionId, input },
      { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'action_forbidden', details: { reason: 'external_authorization_refused',
        phase: 'session.authorization.preparation', requiredFact: 'session_authorization_preparation', remedy: expect.any(String) } });
    expect(produced?.envelope).toMatchObject({ v: 1, input });
  });

  it.each([
    { label: 'legacy fields', input: { machine: 'machine', directory: '/home/happier', model: 'claude-haiku-4-5',
      instructions: 'Reply with exactly the reading check result.', manager: true } },
    { label: 'malformed inherited choice', input: { directory: { kind: 'path', path: '/tmp' }, agentTarget: null } },
    { label: 'unknown field', input: { directory: { kind: 'path', path: '/tmp' }, unknown: true } },
    { label: 'invalid directory discriminator', input: { directory: { kind: 'local', path: '/private/submitted-path' } } },
  ])('reports malformed Session spawn input before attempting external authorization: $label', async ({ input: invalidInput }) => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'alice-home',
      serverHttpBaseUrl: 'https://alice-home.test', token: 'alice-daemon-token', machineId: 'machine',
      prepareExternalActionAuthorization: async ({ operation: action }) => {
        const selected = resolveExternalActionMachineTarget({ actionId: action.actionId,
          rawInput: action.input, fallbackMachineId: 'machine' });
        if (selected.kind === 'rejected') return null;
        throw new Error('Malformed spawn reached external authority preparation');
      },
      createExecutor: () => createActionExecutor(createCliActionDeps({ token: 'alice-daemon-token', sessionId: '', mode: 'plain', ctx: null })),
    });
    const spawn: Operation = { ...operation, actionId: 'session.spawn_new', input: invalidInput };
    const failure = ActionExecuteFailureSchema.parse(await execute(spawn, { sessionId: 'bob-session', isCurrent: async () => true }));
    expect(failure).toMatchObject({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
      details: { issues: expect.arrayContaining([expect.objectContaining({ code: expect.any(String), path: expect.any(Array) })]) } });
    if (invalidInput.directory && typeof invalidInput.directory === 'object' && invalidInput.directory.kind === 'local') {
      expect(failure.details).toEqual({ issues: [{ code: 'invalid_union', path: ['directory', 'kind'], acceptedValues: ['path', 'managed'] }] });
    }
    expect(JSON.stringify(failure)).not.toContain('/private/submitted-path');
    expect(await execute(spawn, { sessionId: 'bob-session', isCurrent: async () => false }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'runtime_authority_unavailable' } });
  });

  it('stores an approvable daemon-evaluated plugin install requested by an Agent without applying during preview', async () => {
    const sessionId = `c${'b'.repeat(24)}`;
    const serverHttpBaseUrl = 'https://plugin-home.test';
    const homeId = 'srv_plugin-home';
    const source = { machineId: 'plugin-machine', installationId: 'plugin-installation' };
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
    const pluginPath = `${process.cwd()}/../../packages/embed/dev/leads-fixture`;
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'plugin-owner', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {
      'plugins.install': { approvalRequiredSurfaces: ['agent'] },
    } } });
    setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const installInput = {
      path: pluginPath, machineId: source.machineId, dev: true,
    };
    const target = { kind: 'machine' as const, machineId: source.machineId };
    const rawSession = createSessionRecordFixture({ id: sessionId, share: null,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId: source.machineId, permissionMode: 'default' }),
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    const rows = new Map<string, Record<string, unknown>>();
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: settings }, version: 1 } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: rawSession } };
      if (path.startsWith('/v1/artifacts/')) return { status: rows.has(path.split('/').at(-1)!) ? 200 : 404,
        data: rows.get(path.split('/').at(-1)!) };
      throw new Error(`Unexpected plugin approval GET path ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected HTTP object body');
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts') {
        const id = String(Reflect.get(body, 'id'));
        rows.set(id, { ...body, ownerAccountId: 'plugin-owner', access: 'owner', encryptionMode: 'plain',
          publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: rows.get(id) };
      }
      if (path.startsWith('/v1/artifacts/')) {
        const id = path.split('/').at(-1)!;
        const row = rows.get(id);
        if (!row) return { status: 404, data: null };
        const headerVersion = Number(row.headerVersion) + 1;
        const bodyVersion = Number(row.bodyVersion) + 1;
        rows.set(id, { ...row, header: Reflect.get(body, 'header'), body: Reflect.get(body, 'body'),
          headerVersion, bodyVersion, updatedAt: Number(row.updatedAt) + 1 });
        return { status: 200, data: { success: true, headerVersion, bodyVersion } };
      }
      throw new Error(`Unexpected plugin approval POST path ${path}`);
    });
    const apply = vi.fn(async () => ({ kind: 'committed' as const, pluginId: 'happier.leads.fixture',
      desiredGeneration: 'generation-1', appliedGeneration: 'generation-1', pendingSurfaces: [] }));
    const pluginChangeService = createDaemonPluginChangeService({
      prepare: async () => ({
        pluginId: 'happier.leads.fixture', requiresReview: false,
        review: createPluginInstallationReviewFixture({ pluginId: 'happier.leads.fixture', displayName: 'Leads Fixture',
          source: { kind: 'path', locator: pluginPath },
          updateChannel: { kind: 'path', locator: pluginPath, development: true } }),
        apply, cleanup: async () => undefined,
      }),
      createPendingChangeId: () => 'pending-agent-install',
    });
    let daemonExecutor!: ReturnType<typeof createCliActionExecutorFromCredentials>;
    const prepareExternalActionAuthorization = vi.fn(async () => null);
    const execute = createDaemonSessionAccountActionExecutor({ serverId: configuration.activeServerId,
      serverHttpBaseUrl, token: credentials.token, credentials, machineId: source.machineId,
      prepareExternalActionAuthorization,
      createExecutor: (getCurrentTurnWorkDepth, isCallerCurrent) => {
        daemonExecutor = createCliActionExecutorFromCredentials({
          credentials, machineId: source.machineId, serverId: configuration.activeServerId, serverApiUrl: serverHttpBaseUrl,
          serverIdentityId: homeId, getCurrentTurnWorkDepth, isApprovalExecutionOriginCurrent: async () => await isCallerCurrent(),
          externalActionMachineRequestPrivateKey: keys.secretKey,
          externalActionMachineInstallationId: source.installationId,
          pluginActionExecutionOwner: 'current_process', pluginChangeService,
        });
        return daemonExecutor;
      },
    });
    const command = 'node /runtime/.runner-snapshots/plugin-install/dist/index.mjs';
    processIdentityBoundary.mockResolvedValue({ pid: process.pid, processStartTimeMs: 23_346, command });
    const processIdentity = await readProcessIdentityByPid(process.pid);
    if (processIdentity?.processStartTimeMs === undefined) throw new Error('Current process generation unavailable');
    const runner = { pid: process.pid, processStartTimeMs: processIdentity.processStartTimeMs,
      processCommandHash: hashProcessCommand(processIdentity.command), snapshotIdentity: 'snapshot:plugin-install' };
    const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
    const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({ v: 1,
        pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
        sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/runtime.mjs', loadMode: 'immutable-js' }) };
    const publication = await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31_003,
      capability: 'P'.repeat(43), expectedPluginHardRevocationRevision: 0,
      readPluginHardRevocationRevision: async () => 0 });
    vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, path);
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === '127.0.0.1' && parsed.port === '31003') {
        const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
        if (request.operation.kind !== 'action.execute') throw new Error('Expected Action execution request');
        const outcome = await execute(request.operation, { sessionId, isCurrent: async () => true });
        return Response.json({ ok: true, result: { kind: 'action.execution',
          requestId: request.operation.requestId, outcome } });
      }
      if (String(url).startsWith(`${serverHttpBaseUrl}/v1/features`) || String(url).startsWith(`${serverHttpBaseUrl}/features`)) {
        return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
          serverIdentity: { serverIdentityId: homeId },
        } }));
      }
      return await nativeFetch(url, init);
    });
    const witness = { ...operation.witness,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
      agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 1, turnDepth: 2 } };
    const runtime = createHappierMcpServer({ sessionId, updateMetadata() {},
      getServerBinding: () => ({ serverId: configuration.activeServerId, serverUrl: serverHttpBaseUrl }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      getMetadataSnapshot: () => createTestMetadata({ machineId: source.machineId }),
      getWorkDepth: () => 2, getHostTurnWorkDepth: () => 2,
      getActiveTurnAdmissionWitness: () => witness,
      getActiveTurnPermissionWitness: () => ({ turnId: witness.turnId,
        causalPermissionAuthority: witness.causalPermissionAuthority }),
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
    }, { authorityScope: 'session', credentials: null,
      sessionCredentials: { token: 'restricted-runner-session-bearer', encryption: null }, accountSettings: settings });
    const mcpClient = new Client({ name: 'plugin-install-agent', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(serverTransport);
      await mcpClient.connect(clientTransport);
      const response = CallToolResultSchema.parse(await mcpClient.callTool({ name: 'action_execute', arguments: {
        actionId: 'plugins.install', input: installInput,
      } }));
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const block = response.content.find(item => item.type === 'text');
      if (!block || block.type !== 'text') throw new Error('Missing MCP plugin install result');
      const result: unknown = JSON.parse(block.text);
      expect(result).toMatchObject({
        kind: 'approval_request_created', artifactId: expect.any(String),
      });
      const artifactId = result && typeof result === 'object' && 'artifactId' in result
        ? String(result.artifactId) : '';
      const stored = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () =>
        createCliApprovalsArtifactStore({ credentials }).approvalsGet({ artifactId, serverId: null }));
      expect(stored).toMatchObject({ preview: { pluginInstall: { permissionsDisclosure: 'daemonEvaluated',
        pendingReview: { pendingChangeId: 'pending-agent-install', review: { pluginId: 'happier.leads.fixture' } } } } });
      if (!stored || stored.v !== 2) throw new Error('Missing plugin install approval');
      expect(resolveApprovalRequestApproveAdmission(stored)).toMatchObject({ status: 'available' });
      expect(prepareExternalActionAuthorization).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();

      const staleRequest = StoredApprovalRequestSchema.parse({
        ...stored,
        createdAtMs: stored.createdAtMs + 1,
        updatedAtMs: stored.updatedAtMs + 1,
        executionOriginV1: { ...stored.executionOriginV1, requestId: 'stale-agent-install' },
        preview: { pluginInstall: { permissionsDisclosure: 'daemonEvaluated',
          pendingReview: { ...readPluginInstallApprovalPendingReview(stored.preview),
            pendingChangeId: 'pending-expired-agent-install' } } },
      });
      const staleStore = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createCliApprovalsArtifactStore({ credentials }));
      const staleArtifact = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () =>
        staleStore.approvalsCreate({ request: staleRequest, serverId: null }));
      expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => staleStore.approvalsUpdate({
        ...staleArtifact,
        serverId: null,
        request: { ...staleRequest, status: 'approved', updatedAtMs: staleRequest.updatedAtMs + 1,
          decision: { kind: 'approve', decidedAtMs: staleRequest.updatedAtMs + 1, authority: 'present_user' } },
      }))).toEqual({ ok: true });

      expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () =>
        createCliApprovalsArtifactStore({ credentials }).approvalsUpdate({ artifactId, serverId: null,
          request: { ...stored, status: 'approved', updatedAtMs: stored.updatedAtMs + 1,
            decision: { kind: 'approve', decidedAtMs: stored.updatedAtMs + 1, authority: 'present_user' } } }))).toEqual({ ok: true });
      const rpc = new RpcHandlerManager({ scopePrefix: source.machineId, localMachineId: source.machineId,
        encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
      registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: daemonExecutor });
      const staleReplay = await rpc.handleRequest({
        method: `${source.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`,
        params: { artifactId: staleArtifact.artifactId }, callerAuthority: 'present_user',
      });
      expect(staleReplay).toMatchObject({ ok: true, result: { status: 'failed', execution: {
        ok: false, errorCode: 'plugin_change_expired',
      } } });
      expect(apply).not.toHaveBeenCalled();

      const replay = await rpc.handleRequest({
        method: `${source.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`,
        params: { artifactId }, callerAuthority: 'present_user',
      });
      expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: {
        kind: 'plugins_install', outcome: 'applied',
      } } } });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(await rpc.handleRequest({
        method: `${source.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`,
        params: { artifactId }, callerAuthority: 'present_user',
      }))
        .toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      await mcpClient.close();
      await runtime.mcp.close();
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority,
        capabilityDigest: publication.capabilityDigest });
    }
  });

  it('requires original Home creator proof before a Session visual can use Account execution', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'alice-home',
      serverHttpBaseUrl: 'https://alice-home.test', token: 'alice-daemon-token',
      createExecutor: () => createActionExecutor(createCliActionDeps({ token: 'alice-daemon-token', sessionId: '', mode: 'plain', ctx: null })),
    });
    const visual: Operation = { ...operation, actionId: 'session.board.item.upsert', input: { itemId: 'visual', expectedItemRevision: null,
      destination: 'transcript', item: { v: 1, title: 'Visual', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'hello' } } } } } };
    expect(await execute(visual, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
        details: { reason: 'external_authorization_missing' } });
  });

  it('refuses a Session visual proof addressed to a Machine instead of its caller Session', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const serverHttpBaseUrl = 'https://visual-home.test';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: { v: 1, token: 'visual-home-proof', binding: {
        serverIdentityId: 'srv_visual', accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', machineId: 'machine', installationId: 'installation', actionId: 'session.board.item.upsert',
        requestId: request.envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        target: request.envelope.target, sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } } };
    });
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'visual-profile', serverHttpBaseUrl, token,
      prepareExternalActionAuthorization: async ({ operation: action, sessionActionOrigin }) => {
        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId: action.actionId, input: action.input,
          requestId: action.requestId, target, machineId: 'machine', sourceMachineId: 'machine', accountId: 'owner',
          accountEncryptionMode: 'plain', tokenEpochHint: 0, token, serverId: 'visual-profile', serverIdentityId: 'srv_visual',
          serverHttpBaseUrl, installationId: 'installation', privateKey: keys.secretKey, sessionActionOrigin });
        return authorization ? { authorization, target } : null;
      },
      createExecutor: () => createActionExecutor(createCliActionDeps({ token, sessionId: '', mode: 'plain', ctx: null })),
    });
    const visual: Operation = { ...operation, actionId: 'session.board.item.upsert', input: { itemId: 'visual', expectedItemRevision: null,
      destination: 'transcript', item: { v: 1, title: 'Visual', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'hello' } } } } } };
    expect(await execute(visual, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
        details: { reason: 'external_authorization_binding_mismatch' } });
  });

  it.each([
    ...(['find', 'settings', 'link', 'client', 'source-move-remote-approval', 'visual', 'relation', 'relation-server-error', 'unsigned-visual', 'unsigned-server-error', 'unsigned-retired', 'unsigned-revoked', 'unsigned-foreign-home', 'unsigned-unavailable'] as const)
      .map(kind => ({ kind, requester: 'owner' as const })),
    ...(['find', 'settings'] as const).map(kind => ({ kind, requester: 'unknown' as const })),
  ])(
    'routes an installed Session $kind Action through its canonical approval replay owner ($requester requester)', async ({ kind, requester }) => {
    const unsigned = kind.startsWith('unsigned-');
    const relation = kind.startsWith('relation');
    const sourceMoveRemote = kind === 'source-move-remote-approval';
    const runnerCarrier = kind === 'find' || kind === 'settings' || kind === 'link';
    const serverHttpBaseUrl = 'https://client-source.test';
    const homeId = 'srv_client-source';
    if (sourceMoveRemote) await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
      [configuration.activeServerId]: { id: configuration.activeServerId, name: configuration.activeServerId,
        serverUrl: serverHttpBaseUrl, webappUrl: serverHttpBaseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId,
          canonicalServerUrl: serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] } },
    } }));
    const source = { machineId: 'source-machine', installationId: 'source-installation' };
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'source-account', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null,
      ...(runnerCarrier || sourceMoveRemote ? { credentialProvenance: 'stored_session' as const } : {}),
    };
    // Installation-file reads and Home HTTP are genuine boundaries; all signing,
    // Session custody, approval policy/currentness and reverse delivery stay real.
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
      version: 1, installationId: source.installationId, createdAt: 1,
      publicKey: Buffer.from(keys.publicKey).toString('base64url'),
      privateKey: Buffer.from(keys.secretKey).toString('base64url'),
    });
    const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {
      'ui.find': { approvalRequiredSurfaces: ['agent'] },
      'session.board.item.upsert': { approvalRequiredSurfaces: ['agent'] },
      'session.manager.set': { approvalRequiredSurfaces: ['agent'] },
      'projects.sources.moveToTeam': { approvalRequiredSurfaces: ['agent'] },
    } } });
    setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const actionId = sourceMoveRemote ? 'projects.sources.moveToTeam' as const
      : kind === 'find' ? 'ui.find' as const
      : kind === 'settings' ? 'settings.set' as const
      : kind === 'link' ? 'sessions.external.link.ensure' as const
      : kind === 'client' ? 'relay.runtime.open_path' as const
      : relation ? 'session.manager.set' as const : 'session.board.item.upsert' as const;
    const input = sourceMoveRemote ? { serverId: homeId, sourceId: 'personal-source', expectedRevision: 1,
      teamId: 'destination-team', requestKey: 'source-move-remote-approval' }
      : kind === 'find' ? { op: 'set', query: 'approval needle' }
      : kind === 'settings' ? { anchor: 'transcript.pinEnabled', value: false }
      : kind === 'link' ? { machineId: source.machineId, agentId: 'codex', remoteSessionId: 'native-link', source: { kind: 'codexHome', home: 'user' } }
      : relation ? { sessionId: 'bob-session', managerSessionId: 'lead-session', expectedManagerSessionId: null }
      : kind === 'client' ? { path: '/home/user/.happier/logs/runtime.log' } : {
      itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item: {
        v: 1, title: 'Visual', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Approved visual' } } },
      },
    };
    const target = runnerCarrier || sourceMoveRemote || kind === 'client' || relation ? { kind: 'machine' as const, machineId: source.machineId }
      : { kind: 'session' as const, sessionId: 'bob-session' };
    const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const mutations: unknown[] = [];
    const rawSession = createSessionRecordFixture({ id: 'bob-session', share: null,
      ...(sourceMoveRemote ? { active: true } : {}),
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId: source.machineId, permissionMode: 'default' }),
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    const rows = new Map<string, Record<string, unknown>>();
    const resultPublications = new Set<string>();
    const mintedRequests: unknown[] = [];
    let currentHomeId = homeId;
    let sessionCurrent = true;
    let accountCurrent = true;
    let accountContent: unknown = settings;
    let invocationRequestId = operation.requestId;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, board: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId: currentHomeId } },
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      expect(new URL(String(url)).origin).toBe(serverHttpBaseUrl);
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return accountCurrent
        ? { status: 200, data: AccountProfileResponseSchema.parse({ id: 'source-account' }) }
        : { status: 403, data: { error: 'forbidden' } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: accountContent }, version: 1 } };
      if (path === `/v1/machines/${source.machineId}`) return { status: 200, data: { machine: {
        ...ExternalActionMachineBootstrapV1Schema.parse({ id: source.machineId, active: true, kind: 'persistent',
          installationId: source.installationId, revokedAt: null, replacedByMachineId: null }),
        installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
      } } };
      if (path.startsWith('/v1/artifacts/')) return { status: rows.has(path.split('/').at(-1)!) ? 200 : 404,
        data: rows.get(path.split('/').at(-1)!) };
      if (path === '/v2/sessions/bob-session') return { status: 200, data: { session: rawSession } };
      if (path === '/v2/sessions/lead-session') return { status: 200, data: { session: { ...rawSession, id: 'lead-session' } } };
      if (path === '/v2/sessions/bob-session/system-records/record') return { status: 200, data: { record: null } };
      throw new Error(`Unexpected client Action GET path ${path}`);
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      expect(new URL(String(config.url)).origin).toBe(serverHttpBaseUrl);
      if (sourceMoveRemote && config.method === 'GET') {
        const path = new URL(String(config.url)).pathname;
        if (path === '/v1/projects/sources/personal-source') return { status: 200, data: { ok: true, canManage: true,
          source: { id: 'personal-source', revision: 1, name: 'Personal source',
            owner: { kind: 'account', accountId: 'source-account' }, audience: [], createdByAccountId: 'source-account' } } };
        if (path === '/v1/projects/personal-source/deployment-defaults') return { status: 200,
          data: { ok: true, projectSourceId: 'personal-source', sourceRevision: 1, revision: 0, content: null } };
        if (path === '/v1/deployments/environments') return { status: 200,
          data: { ok: true, items: [], nextCursor: null } };
      }
      if (config.method === 'POST' && new URL(String(config.url)).pathname === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1)
        return accountCurrent ? { status: 200, data: { tokens: [] } }
          : { status: 403, data: { error: 'forbidden' } };
      if (config.method === 'PUT' && new URL(String(config.url)).pathname === '/v2/sessions/bob-session/board') {
        const body: unknown = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        if (unsigned) {
          expect(config.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
          expect(config.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBeUndefined();
        } else expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'source-home-proof', effectActionId: actionId,
          target, installationId: source.installationId, requestId: operation.requestId, method: 'PUT',
          path: '/v2/sessions/bob-session/board', body,
          signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
        // HTTP is the boundary: the live serialization-aborted transaction
        // publishes a 500 and commits no Session item.
        if (kind === 'unsigned-server-error') return { status: 500, data: {
          error: 'Internal Server Error', message: 'could not serialize access due to concurrent update',
        } };
        mutations.push(body);
        return { status: 200, data: { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: revision } };
      }
      throw new Error(`Unexpected client Action request path ${new URL(String(config.url)).pathname}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected HTTP object body');
      expect(new URL(String(url)).origin).toBe(serverHttpBaseUrl);
      const path = new URL(String(url)).pathname;
      if (sourceMoveRemote && path === '/v2/sessions/bob-session/pending') {
        const localId = Reflect.get(body, 'localId');
        expect(localId).toEqual(expect.stringMatching(/^approval-result:/));
        if (typeof localId !== 'string') throw new Error('Missing approval result input identity');
        expect(Reflect.get(body, 'requestedAction')).toEqual({ v: 1, kind: 'enqueue' });
        const didWrite = !resultPublications.has(localId);
        resultPublications.add(localId);
        return { status: 200, data: { didWrite } };
      }
      if (path === '/v2/account/settings') {
        const content = Reflect.get(body, 'content');
        if (!content || typeof content !== 'object' || Reflect.get(content, 't') !== 'plain') throw new Error('Expected plain settings');
        accountContent = Reflect.get(content, 'v');
        mutations.push(accountContent);
        return { status: 200, data: { success: true, version: 2 } };
      }
      if (path === '/v1/sessions/bob-session/manager') {
        expect(relation).toBe(true);
        expect(body).toEqual({ managerSessionId: 'lead-session', expectedManagerSessionId: null });
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'source-home-proof', effectActionId: actionId,
          target, installationId: source.installationId, requestId: operation.requestId, method: 'POST', path, body,
          signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
        if (kind === 'relation-server-error') return { status: 500, data: {
          error: 'Internal Server Error', message: 'could not serialize access due to concurrent update',
        } };
        mutations.push(body);
        return { status: 200, data: { ok: true, sessionId: 'bob-session', managerSessionId: 'lead-session', attachedAt: 1 } };
      }
      if (path === '/v2/sessions/lookup-by-tags') {
        const tags: unknown = Reflect.get(body, 'tags');
        expect(tags).toEqual([expect.stringMatching(relation ? /^(bob|lead)-session$/ : /^bob-session$/)]);
        if (!Array.isArray(tags) || typeof tags[0] !== 'string') throw new Error('Invalid Session lookup tags');
        return { status: 200, data: { sessions: [{ ...rawSession, id: tags[0] }] } };
      }
      if (path.endsWith('/execution-authorization')) {
        const request = externalActionExecutionAuthorizationRequestSchemaForActionV1(actionId).parse(body);
        mintedRequests.push(request);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
        return { status: 200, data: { v: 1, token: 'source-home-proof', binding: {
          accountId: 'source-account', custodianAccountId: 'source-account', authentication: { kind: 'account', tokenEpoch: 0 },
          serverIdentityId: homeId, ...source, actionId, requestId: request.envelope.requestId, target,
          accountEncryptionMode: 'plain', sessionActionOrigin: request.sessionActionOrigin,
          sessionActionSource: request.sessionActionSource, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } } };
      }
      if (path.endsWith('/verify')) {
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'source-home-proof', effectActionId: actionId,
          target, installationId: source.installationId, requestId: invocationRequestId, method: 'POST', path, body,
          signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
        return { status: 200, data: { ok: true } };
      }
      if (path === '/v1/artifacts') {
        const id = String(Reflect.get(body, 'id'));
        rows.set(id, { ...body, ownerAccountId: 'source-account', access: 'owner', encryptionMode: 'plain',
          publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (path.startsWith('/v1/artifacts/')) {
        const row = rows.get(path.split('/').at(-1)!)!;
        expect(Reflect.get(body, 'expectedHeaderVersion')).toBe(row.headerVersion);
        expect(Reflect.get(body, 'expectedBodyVersion')).toBe(row.bodyVersion);
        const headerVersion = Number(row.headerVersion) + 1;
        const bodyVersion = Number(row.bodyVersion) + 1;
        rows.set(String(row.id), { ...row, header: Reflect.get(body, 'header'), body: Reflect.get(body, 'body'), headerVersion, bodyVersion });
        return { status: 200, data: { success: true, headerVersion, bodyVersion } };
      }
      throw new Error(`Unexpected client Action path ${path}`);
    });
    const deliveries: ReturnType<typeof UiActionDispatchRequestV1Schema.parse>[] = [];
    let completeClient!: () => void;
    const clientCompleted = new Promise<void>(resolve => { completeClient = resolve; });
    const clientMethod = RPC_METHODS.UI_ACTION_EXECUTE;
    const reverse = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === clientMethod,
      // Connected-client RPC is this slice's outer boundary. The paired UI test
      // owns the real receiver/native operation, not an in-process substitute here.
      callConnectedClientRpc: async (method, payload, options) => {
        expect(method).toBe(clientMethod);
        deliveries.push(UiActionDispatchRequestV1Schema.parse(payload));
        options.onIssued();
        await clientCompleted;
        return { ok: true, result: { v: 1, execution: { ok: true, result: kind === 'find'
          ? { status: 'results', current: 1, total: 1, coverage: 'loaded' }
          : sourceMoveRemote ? ProjectSourcesMoveToTeamOutputV1Schema.parse({ kind: 'completed',
            source: { id: 'personal-source', revision: 2, name: 'Personal source',
              owner: { kind: 'team', teamId: 'destination-team' }, audience: [], createdByAccountId: 'source-account' },
            childOperations: [] }) : { status: 'completed' } } } };
      },
    }));
    let executor!: ReturnType<typeof createCliActionExecutorFromCredentials>;
    const createExecutor = (getCurrentTurnWorkDepth: (turnId?: string) => number | undefined,
      isCallerCurrent: () => Promise<boolean>) => {
      const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
        machineId: source.machineId, serverId: configuration.activeServerId, serverApiUrl: serverHttpBaseUrl,
        isSessionCallerCurrent: async ({ caller }) => sessionCurrent && caller.sessionId === 'bob-session' && await isCallerCurrent() });
      if (!currentness) throw new Error('Missing credentialed currentness owner');
      executor = createCliActionExecutorFromCredentials({ credentials, machineId: source.machineId,
        serverId: configuration.activeServerId, serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId,
        externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: source.installationId,
        getCurrentTurnWorkDepth, isApprovalExecutionOriginCurrent: currentness,
        ...(runnerCarrier ? { readCredentials: async () => credentials } : {}),
        clientActionExecute: reverse, pluginActionExecutionOwner: 'current_process' });
      return executor;
    };
    const execute = createDaemonSessionAccountActionExecutor({ serverId: configuration.activeServerId, serverHttpBaseUrl,
      token: credentials.token, machineId: source.machineId,
      prepareExternalActionAuthorization: async admission => {
        invocationRequestId = admission.operation.requestId;
        let authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId, input, requestId: invocationRequestId,
          target, machineId: source.machineId, sourceMachineId: source.machineId, accountId: 'source-account',
          accountEncryptionMode: 'plain', tokenEpochHint: 0, token: credentials.token,
          serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl,
          installationId: source.installationId, privateKey: keys.secretKey, sessionActionOrigin: admission.sessionActionOrigin,
          isCurrent: admission.isCallerCurrent, signal: admission.authority.signal });
        if (authorization && sourceMoveRemote) {
          // The installed Session preparer attaches these exact-Session Account
          // ports after minting; Source review consumes the same real projection.
          authorization = await projectRequesterAccountActionAuthorization({ authorization,
            serverIdentityId: homeId, bootstrap: { credentials, serverHttpBaseUrl,
              attribution: { serverId: configuration.activeServerId, accountId: 'source-account', ...source },
              getBoundSessionId: () => 'bob-session', isCurrent: admission.isCallerCurrent },
            signal: admission.authority.signal });
        }
        return authorization ? { authorization, target } : null;
      },
      createExecutor,
    });
    const linkCalls: unknown[] = [];
    if (kind === 'link') {
      createExecutor(() => 2, async () => true);
      // The link continuation leaves this process through exact-Machine RPC.
      vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        linkCalls.push(request.request);
        return { ok: true, sessionId: 'linked-session', created: true };
      });
    }
    let runnerMcp: ReturnType<typeof createHappierMcpServer> | undefined;
    let runnerClient: Client | undefined;
    if (runnerCarrier) {
      const command = 'node /runtime/.runner-snapshots/approval-origin/dist/index.mjs';
      const runner = { pid: process.pid, processStartTimeMs: 23349, processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:approval-origin' };
      processIdentityBoundary.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
      const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
      const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, sessionId: 'bob-session', runner, retainedAgent: createAgentSessionRunnerFactoryBinding({ v: 1,
          pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
          sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
          locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
          normalizedModulePath: '/immutable/runtime.mjs', loadMode: 'immutable-js' }) };
      await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31004, capability: 'R'.repeat(43) });
      vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, path);
      const fetchFeatures = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (new URL(String(url)).port !== '31004') return await fetchFeatures(url, init);
        const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
        if (request.operation.kind !== 'action.execute') throw new Error('Expected runner Action');
        const outcome = await execute(request.operation, { sessionId: 'bob-session', isCurrent: async () => true });
        return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
      });
      const witness = { ...operation.witness, callerPermissionMode: 'default' as const,
        actionRequestAttributionV1: deriveSessionInputActionRequestAttributionV1({
          requestRef: operation.witness.inputId, persona: { serverId: configuration.activeServerId, sessionId: 'bob-session' },
          // Human ingress retains the authenticated Home receipt; machine input
          // without an original cause remains unknown, even for this owned Session.
          origin: null, messageRole: 'user', inputAdmissionReceipt: requester === 'owner'
            ? { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'source-account', sessionRelationship: 'owner' }
            : { v: 1, issuer: 'authenticatedMachine' },
        }),
      };
      runnerMcp = createHappierMcpServer({ sessionId: 'bob-session', updateMetadata() {},
        getServerBinding: () => ({ serverId: configuration.activeServerId, serverUrl: serverHttpBaseUrl }),
        getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
          features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } },
        }) }),
        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'bob-session', encryptionMode: 'plain' }),
        getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
        getActiveTurnAdmissionWitness: () => witness,
        getActiveTurnPermissionWitness: () => ({ turnId: witness.turnId,
          causalPermissionAuthority: witness.causalPermissionAuthority }),
        getWorkDepth: () => 2, getHostTurnWorkDepth: () => 2,
      }, { authorityScope: kind === 'link' ? 'account' : 'session', accountSettings: settings, ...(kind === 'link' ? { credentials } : {}) });
      runnerClient = new Client({ name: 'approval-origin', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await runnerMcp.mcp.connect(serverTransport); await runnerClient.connect(clientTransport);
      onTestFinished(async () => { await runnerClient?.close(); await runnerMcp?.mcp.close();
        await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('R'.repeat(43)) }); });
    }
    const mcp = unsigned ? createHappierMcpServer({
      sessionId: 'bob-session', getServerBinding: () => ({ serverId: configuration.activeServerId, serverUrl: serverHttpBaseUrl }),
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: { serverIdentity: { serverIdentityId: homeId } },
      }) }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'bob-session', encryptionMode: 'plain' }),
      updateMetadata() {}, getMetadataSnapshot: () => createTestMetadata({ machineId: source.machineId, permissionMode: 'default' }),
      getCurrentSessionLocation: () => ({ machineId: source.machineId, path: '/workspace' }),
      getPermissionMode: () => 'default', getWorkDepth: () => 1,
      getHostTurnWorkDepth: () => kind === 'unsigned-unavailable' ? undefined : 2,
      getActiveTurnPermissionWitness: () => ({ turnId: operation.witness.turnId,
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
    }, { credentials, accountSettings: settings }) : null;
    let mcpClient: Client | null = null;
    if (mcp) onTestFinished(async () => { await mcpClient?.close(); await mcp.mcp.close(); });
    if (mcp) createExecutor(() => 2, async () => true);
    const callMcp = async () => {
      if (!mcp) throw new Error('Missing MCP factory');
      if (kind !== 'unsigned-visual' && kind !== 'unsigned-server-error') {
        return await mcp.executeTool({ toolName: 'session_board_item_upsert', args: input, toolCallId: 'unsigned-visual' });
      }
      mcpClient = new Client({ name: 'daemon-visual-agent', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcp.mcp.connect(serverTransport);
      await mcpClient.connect(clientTransport);
      await mcpClient.listTools();
      const result = await mcpClient.callTool({ name: 'session_board_item_upsert', arguments: input }, CallToolResultSchema);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ kind: 'approval_request_created', artifactId: expect.any(String) });
      return { ok: true as const, result: result.structuredContent };
    };
    let settled = false;
    const pending = (runnerClient ? runnerClient.callTool({ name: 'action_execute', arguments: { actionId, input } }).then(raw => {
      const response = CallToolResultSchema.parse(raw);
      const block = response.content.find(item => item.type === 'text');
      if (block?.type !== 'text') throw new Error('Missing runner result');
      return response.isError ? { ok: false as const, result: JSON.parse(block.text) as unknown }
        : { ok: true as const, result: JSON.parse(block.text) as unknown };
    }) : mcp ? callMcp()
      : execute({ ...operation, actionId, input, surface: 'mcp', witness: { ...operation.witness, callerPermissionMode: 'default' } },
        { sessionId: 'bob-session', isCurrent: async () => true })).then(result => { settled = true; return result; });
    // An assertion may fail while a blocking approval is still pending.
    // Attach its teardown rejection handler before closing the MCP connection.
    void pending.catch(() => undefined);
    if (kind === 'unsigned-unavailable') {
      expect(await pending).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      expect(rows.size).toBe(0);
      expect(mutations).toEqual([]);
      return;
    }
    if (requester === 'unknown') {
      expect(await pending).toMatchObject({ ok: false, result: { errorCode: 'approval_requester_unavailable' } });
      expect(rows.size).toBe(0);
      expect(deliveries).toEqual([]);
      expect(mutations).toEqual([]);
      return;
    }
    await vi.waitFor(async () => {
      if (settled && rows.size === 0) {
        const result = await pending;
        expect(result.ok, JSON.stringify(result)).toBe(true);
      }
      expect(rows.size).toBe(1);
    });
    const artifactId = [...rows.keys()][0]!;
    const store = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createCliApprovalsArtifactStore({ credentials }));
    const open = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null }));
    if (!open || open.v !== 2) throw new Error('Missing Session approval origin');
    expect(open.executionOriginV1).toMatchObject({ serverId: configuration.activeServerId, serverIdentityId: homeId,
      machineId: source.machineId, authority: 'account_automation', surface: 'agent' });
    if (runnerCarrier) {
      expect(open.executionOriginV1.accountId).toBe('source-account');
      expect(open.executionOriginV1.actionRequestAttributionV1?.requester).toEqual({
        serverId: configuration.activeServerId, accountId: 'source-account',
      });
      expect(open).not.toHaveProperty('requesterConfirmation');
    }
    if (mcp || kind === 'link') {
      expect(open.executionOriginV1.externalActionExecutionAuthorization).toBeUndefined();
      expect(open.executionOriginV1.externalActionInputSignature).toBeUndefined();
      expect(resolveApprovalExecutor(open).kind).toBe('daemon');
      expect(mintedRequests).toEqual([]);
    } else {
      if (!runnerCarrier) expect(resolveApprovalExecutor(open).kind).toBe(sourceMoveRemote || kind === 'client' || relation ? 'app' : 'daemon');
      if (!open.executionOriginV1.externalActionInputSignature) throw new Error('Missing signed client approval origin');
      expect(open.executionOriginV1).toMatchObject({ accountId: 'source-account', requestId: invocationRequestId, target });
      expect(verifyExternalActionApprovalInputV1({ authorizationToken: 'source-home-proof', actionId, input: open.actionArgs, target,
        signature: open.executionOriginV1.externalActionInputSignature, publicKey: keys.publicKey })).toBe(true);
      expect(mintedRequests).toEqual([expect.objectContaining({ sessionActionSource: source, installationProof: expect.any(Object) })]);
    }
    expect(deliveries).toEqual([]);
    expect(mutations).toEqual([]);
    if (runnerCarrier) {
      expect(linkCalls).toEqual([]);
      completeClient();
      const approved = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
        surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: configuration.activeServerId,
        serverIdentityId: homeId, runtimeAccountId: 'source-account',
      });
      // Durable requests finish at creation; the approving app owns client
      // execution through its generic UI dispatcher.
      expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true });
      expect(await pending).toMatchObject({ ok: true });
      if (kind === 'find') {
        expect(resolveApprovalExecutor(open)).toEqual({ kind: 'app', placement: 'client' });
        expect(approved).toMatchObject({ ok: true, result: { status: 'executed', execution: {
          ok: true, result: { status: 'results', current: 1, total: 1, coverage: 'loaded' },
        } } });
        expect(deliveries).toMatchObject([{ actionId: 'ui.find', input }]);
      }
      if (kind === 'settings') {
        expect(mutations).toHaveLength(1);
        expect(AccountSettingsSchema.parse(accountContent).transcriptMessagePinActionEnabled).toBe(false);
      }
      if (kind === 'link') expect(linkCalls).toEqual([input]);
      expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null })))
        .toMatchObject({ status: 'executed', execution: { ok: true } });
      return;
    }
    expect(await pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId } });
    if (sourceMoveRemote) {
      // Automatic Session production above minted and signed this target. A
      // contextual Machine on the deciding CLI must not replace that authority.
      expect(resolveApprovalExecutor(open)).toEqual({ kind: 'app', placement: 'client' });
      const originalAuthority = structuredClone(open.executionOriginV1);
      const rpc = new RpcHandlerManager({ scopePrefix: source.machineId, localMachineId: source.machineId,
        encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
      registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor });
      // Machine RPC and connected-client RPC are the genuine process/network
      // boundaries; the credentialed producer, CAS, replay and dispatcher run.
      vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(source.machineId);
        const approved = await runWithServerHttpBaseUrl(serverHttpBaseUrl,
          () => store.approvalsGet({ artifactId, serverId: null }));
        expect(approved).toMatchObject({ status: 'approved', decision: { kind: 'approve', authority: 'present_user' } });
        const replay = await rpc.handleRequest({ method: `${source.machineId}:${request.method}`,
          params: request.request, callerAuthority: 'present_user' });
        expect(replay).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true,
          result: { kind: 'completed', source: { owner: { kind: 'team', teamId: 'destination-team' } } } } } });
        return replay;
      });
      const decider = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        serverId: configuration.activeServerId, serverIdentityId: homeId, serverApiUrl: serverHttpBaseUrl,
        machineId: 'unrelated-context-machine', externalActionClient: true });
      const decide = () => decider.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
        surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: configuration.activeServerId, serverIdentityId: homeId, runtimeAccountId: 'source-account',
      });
      completeClient();
      const decisionResult = await decide();
      expect(decisionResult, JSON.stringify(decisionResult.ok ? { ok: true } : {
        ok: false, errorCode: decisionResult.errorCode, effectAttempted: decisionResult.effectAttempted,
      })).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true,
        result: { kind: 'completed', source: { id: 'personal-source', owner: { kind: 'team', teamId: 'destination-team' } } } } } });
      expect(deliveries).toMatchObject([{ actionId: 'projects.sources.moveToTeam', input }]);
      expect(await decide()).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(deliveries).toHaveLength(1);
      expect([...resultPublications]).toEqual([`approval-result:${artifactId}`]);
      const retained = await runWithServerHttpBaseUrl(serverHttpBaseUrl,
        () => store.approvalsGet({ artifactId, serverId: null }));
      expect(retained).toMatchObject({ status: 'executed', actionArgs: open.actionArgs,
        executionOriginV1: originalAuthority, execution: { ok: true } });
      expect(rows.size).toBe(1);
      return;
    }
    // The approving device writes the strict approved Artifact, then calls the
    // actual public replay RPC with its authenticated human transport authority.
    expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsUpdate({ artifactId, serverId: null,
      request: { ...open, status: 'approved', updatedAtMs: open.updatedAtMs + 1,
        decision: { kind: 'approve', decidedAtMs: open.updatedAtMs + 1 } } }))).toEqual({ ok: true });
    if (resolveApprovalExecutor(open).kind !== 'daemon') {
      expect(deliveries).toEqual([]);
      expect(mutations).toEqual([]);
      return;
    }
    const rpc = new RpcHandlerManager({ scopePrefix: source.machineId, localMachineId: source.machineId,
      encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor });
    if (kind === 'unsigned-retired') sessionCurrent = false;
    if (kind === 'unsigned-revoked') accountCurrent = false;
    if (kind === 'unsigned-foreign-home') currentHomeId = 'srv_foreign-home';
    const replay = await rpc.handleRequest({ method: `${source.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`,
      params: { artifactId }, callerAuthority: 'present_user' });
    if (unsigned && kind !== 'unsigned-visual' && kind !== 'unsigned-server-error') {
      expect(replay).toMatchObject({ ok: false, errorCode: 'approval_stale' });
      expect(mutations).toEqual([]);
      const retained = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null }));
      expect(retained).toMatchObject({ status: 'approved' });
      expect(retained).not.toHaveProperty('execution');
      return;
    }
    expect(replay).toMatchObject({ ok: true });
    if (kind === 'unsigned-server-error' || kind === 'relation-server-error') {
      const errorCode = relation ? 'action_failed' : 'server_error';
      expect(replay).toMatchObject({ result: { status: 'failed', execution: { ok: false, errorCode } } });
      expect(mutations).toEqual([]);
      expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null })))
        .toMatchObject({ status: 'failed', execution: { ok: false, errorCode } });
      return;
    }
    if (kind !== 'client') {
      const outcome = Reflect.get(replay as object, 'result');
      expect(Reflect.get(outcome, 'status'), JSON.stringify(Reflect.get(outcome, 'execution'))).toBe('executed');
      if (relation) {
        expect(replay).toMatchObject({ result: { status: 'executed', execution: { ok: true, result: {
          ok: true, sessionId: 'bob-session', managerSessionId: 'lead-session', attachedAt: 1,
        } } } });
        expect(mutations).toEqual([{ managerSessionId: 'lead-session', expectedManagerSessionId: null }]);
      } else {
        expect(replay).toMatchObject({ result: { status: 'executed', execution: { ok: true, result: {
          sessionId: 'bob-session', result: { itemId: 'visual', itemRevision: revision, outcome: 'created' },
        } } } });
        expect(mutations).toEqual([expect.objectContaining({ itemId: 'visual', itemContent: { t: 'plain', v:
          expect.objectContaining({ destination: 'transcript', source: {
            kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Approved visual' } },
          } }) } })]);
      }
      expect(await rpc.handleRequest({ method: `${source.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`,
        params: { artifactId }, callerAuthority: 'present_user' })).toMatchObject({ ok: true });
      expect(mutations).toHaveLength(1);
      expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null })))
        .toMatchObject({ status: 'executed', execution: { ok: true } });
      expect(open.executionOriginV1.caller).toEqual(operation.witness.agentStartCaller);
      return;
    }
  });

  it('binds a native client Home approval to the authenticated daemon Machine without public API authorization', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    let persisted: ApprovalRequest | undefined;
    let delivered = 0;
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'alice-home', serverHttpBaseUrl: 'https://alice-home.test',
      machineId: 'alice-machine', token: 'alice-daemon-token',
      createExecutor: () => createActionExecutor({
        ...createCliActionDeps({ token: 'alice-daemon-token', sessionId: '', mode: 'plain', ctx: null }),
        // Artifact persistence and reverse socket delivery leave the process.
        approvalsCreate: async ({ request }) => {
          persisted = StoredApprovalRequestSchema.parse(request);
          return { artifactId: 'native-home-approval' };
        },
        clientActionExecute: async () => { delivered += 1; return { ok: true, result: { status: 'completed' } }; },
      }),
    });
    const result = await execute({ ...operation, actionId: 'account.home_continuation.invoke',
      input: { operation: 'refresh', commandId: 'current-ui:home' } }, { sessionId: 'bob-session', isCurrent: async () => true });
    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'native-home-approval' } });
    const stored = StoredApprovalRequestSchema.parse(persisted);
    expect(stored).toMatchObject({ actionId: 'account.home_continuation.invoke',
      actionArgs: { operation: 'refresh', commandId: 'current-ui:home' },
      executionOriginV1: { authority: 'account_automation', machineId: 'alice-machine',
        caller: operation.witness.agentStartCaller } });
    if (stored.v !== 2) throw new Error('Native approval must retain current execution origin');
    expect(stored.executionOriginV1.externalActionExecutionAuthorization).toBeUndefined();
    expect(resolveApprovalExecutor(stored)).toEqual({ kind: 'app', placement: 'client' });
    expect(delivered).toBe(0);
  });
  it('selects the reviewed managed controller before minting rather than the originating Session Machine', () => {
    const controller = { machineId: 'remote-controller', installationId: 'remote-installation' };
    const common = { homeId: 'srv_source', controller, contribution: { pluginId: 'acme.compute', localId: 'vm' } };
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.provisioners.check', rawInput: common,
      fallbackMachineId: 'source-machine' })).toEqual({ kind: 'ready', machineId: controller.machineId });
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.managed.acquire', rawInput: { enrollmentIdentity: { kind: 'existingUser', role: 'personal' }, selection: {
      kind: 'one-off', homeId: common.homeId, controller,
      launch: { provider: common.contribution, schemaVersion: 1, name: 'guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } }, fallbackMachineId: 'source-machine' })).toEqual({ kind: 'ready', machineId: controller.machineId });
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.provisioners.check', rawInput: common,
      target: { kind: 'machine', machineId: 'source-machine' } })).toMatchObject({ kind: 'rejected',
      execution: { errorCode: 'target_not_local' } });
  });

  it.each([
    ['agent', 'machines.provisioners.check', 'local'], ['mcp', 'machines.provisioners.check', 'local'],
    ['agent', 'machines.managed.inspect', 'local'], ['mcp', 'machines.managed.inspect', 'local'],
    ['agent', 'machines.provisioners.check', 'rpc'], ['agent', 'machines.managed.inspect', 'rpc'],
    ['agent', 'machines.managed.acquire', 'rpc'],
    ['agent', 'machines.managed.acquire', 'foreign-custodian-rpc'],
    ['agent', 'machines.provisioners.check', 'foreign-custodian-rpc'], ['agent', 'machines.managed.inspect', 'foreign-custodian-rpc'],
  ] as const)('executes %s %s through the original Home and current native owner over %s', async (surface, actionId, delivery) => {
    const serverHttpBaseUrl = 'https://managed-source.test';
    const homeId = 'srv_source';
    const source = { machineId: 'source-machine', installationId: 'source-installation' };
    const controller = delivery !== 'local' ? { machineId: 'remote-controller', installationId: 'receiver-installation' } : source;
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'source-account', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const sourceKeys = delivery !== 'local' ? nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32)) : keys;
    const custodianAccountId = delivery === 'foreign-custodian-rpc' ? 'custodian-account' : 'source-account';
    const receiverCredentials = delivery === 'foreign-custodian-rpc'
      ? { token: `fixture.${Buffer.from(JSON.stringify({ sub: custodianAccountId, tokenEpoch: 0,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null } : credentials;
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
      [configuration.activeServerId]: { id: configuration.activeServerId, name: 'Source Home', serverUrl: serverHttpBaseUrl,
        webappUrl: serverHttpBaseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId,
          canonicalServerUrl: serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] } },
    } }));
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    if (delivery === 'foreign-custodian-rpc' && actionId === 'machines.managed.acquire') {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: {
        v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.managed.acquire': ['agent'] },
      } }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(receiverCredentials) });
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } },
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const native = nativeFixture({ privateNative: true });
    let machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId, controller,
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
      resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
      allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const input = ManagedMachineActionInputSchemasV1[actionId].parse(actionId === 'machines.provisioners.check'
      ? { homeId, controller, contribution: machine.launch.provider }
      : actionId === 'machines.managed.acquire' ? { enrollmentIdentity: { kind: 'existingUser', role: 'personal' }, selection: { kind: 'one-off', homeId, controller,
        launch: machine.launch, retention: machine.retention, wakeOnAcceptedMessage: false } } : { homeId, managedId: machine.id });
    const target = { kind: 'machine' as const, machineId: controller.machineId };
    const proofRequests: unknown[] = [];
    const paths: string[] = [];
    let storedApproval: Readonly<{ id: string; dataEncryptionKey: string; request: ReturnType<typeof StoredApprovalRequestSchema.parse> }> | undefined;
    // Only Home HTTP is substituted. The source owner, original proof signer,
    // shared Action policy, registry, custody and native invocation remain real.
    const readRejectedApproval = (artifactId: string) => {
      if (storedApproval && artifactId === storedApproval.id) {
        const original = storedApproval.request;
        const rejected = StoredApprovalRequestSchema.parse({ ...original, status: 'rejected', updatedAtMs: original.updatedAtMs + 1,
          decision: { kind: 'reject', decidedAtMs: original.updatedAtMs + 1 } });
        return { id: storedApproval.id, dataEncryptionKey: storedApproval.dataEncryptionKey,
          ownerAccountId: 'source-account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
          headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: original.createdAtMs, updatedAt: rejected.updatedAtMs,
          header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(rejected, { legacyServerId: configuration.activeServerId })),
          body: encodePlainArtifactStoredContent({ body: JSON.stringify(rejected) }) };
      }
      return null;
    };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.startsWith('/v1/artifacts/')) {
        const artifact = readRejectedApproval(path.split('/').at(-1)!);
        return artifact ? { status: 200, data: artifact } : { status: 404, data: { error: 'not_found' } };
      }
      return String(url).endsWith('/v2/account/settings') ? { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } }
        : { status: 200, data: { session: ownedSessionRecord() } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected HTTP object body');
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/v1/artifacts/read') return artifactReadResponse(body, readRejectedApproval);
      if (path.endsWith('/execution-authorization')) {
        expect(config?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
        const request = ExternalActionRequestEnvelopeV1Schema.parse(Reflect.get(body, 'envelope'));
        proofRequests.push(body);
        return { status: 200, data: { v: 1, token: 'source-home-proof', binding: {
          accountId: 'source-account', custodianAccountId, authentication: { kind: 'account', tokenEpoch: 0 },
          serverIdentityId: homeId, ...controller, installationId: controller.installationId,
          actionId, requestId: operation.requestId, target, accountEncryptionMode: 'plain',
          sessionActionOrigin: Reflect.get(body, 'sessionActionOrigin'), sessionActionSource: source,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request),
        } } };
      }
      if (path.endsWith('/verify')) {
        const signature = config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        expect(typeof signature).toBe('string');
        const signed = { authorizationToken: 'source-home-proof', effectActionId: actionId, target,
          installationId: controller.installationId, requestId: operation.requestId, method: 'POST', path, body,
          signature: String(signature) };
        expect(verifyExternalActionMachineRequestV1({ ...signed, publicKey: keys.publicKey })).toBe(true);
        if (delivery !== 'local') expect(verifyExternalActionMachineRequestV1({ ...signed, publicKey: sourceKeys.publicKey })).toBe(false);
        return { status: 200, data: { ok: true } };
      }
      if (path === '/v1/artifacts') {
        const content = decodePlainArtifactStoredContent(String(Reflect.get(body, 'body')));
        const request = StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object' ? Reflect.get(content, 'body') : null)));
        storedApproval = { id: String(Reflect.get(body, 'id')), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, request };
        return { status: 200, data: { id: storedApproval.id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (path.endsWith('/admit')) return { status: 200, data: { machine, replayed: true } };
      if (path.endsWith('/actions/get')) return { status: 200, data: machine };
      if (delivery !== 'local' && /\/(?:context|current|report)$/.test(path)) {
        expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'source-home-proof' });
      }
      if (path.endsWith('/context')) return { status: 200, data: { machine, requestId: operation.requestId } };
      if (path.endsWith('/report')) machine = ManagedMachineV1Schema.parse({ ...machine, observation: Reflect.get(body, 'observation') });
      if (path.endsWith('/current') || path.endsWith('/report')) return { status: 200, data: { machine } };
      throw new Error(`Unexpected family source path ${path}`);
    });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential materialization'); };
    const providerAuthority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
      }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const managedMachineAction = createDaemonManagedMachineActionAdapter({ credentials: receiverCredentials, machineId: controller.machineId,
      serverBaseUrl: serverHttpBaseUrl, serverId: configuration.activeServerId,
      installationIdentity: { installationId: controller.installationId, privateKey: keys.secretKey },
      managedProviderOperationAuthority: providerAuthority,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: serverHttpBaseUrl, resolveCurrentMachineId: () => controller.machineId }),
      acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
    });
    const executor = createCliActionExecutorFromCredentials({ credentials: receiverCredentials, serverId: configuration.activeServerId,
      serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId, externalActionMachineRequestPrivateKey: keys.secretKey,
      externalActionMachineInstallationId: controller.installationId, managedMachineAction, pluginActionExecutionOwner: 'current_process' });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: configuration.activeServerId, serverHttpBaseUrl, token: credentials.token,
      prepareExternalActionAuthorization: async admission => {
        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId, input, requestId: operation.requestId,
          target, machineId: controller.machineId, sourceMachineId: source.machineId, accountId: 'source-account',
          accountEncryptionMode: 'plain', tokenEpochHint: 0, token: credentials.token,
          serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl,
          installationId: source.installationId, privateKey: sourceKeys.secretKey, sessionActionOrigin: admission.sessionActionOrigin,
          isCurrent: admission.isCallerCurrent, signal: admission.authority.signal });
        return authorization ? { authorization, target } : null;
      }, createExecutor: () => delivery === 'local' ? executor : { execute: async (_id, actionInput, context) => {
        const rpc = new RpcHandlerManager({ scopePrefix: controller.machineId, localMachineId: controller.machineId,
          encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
        registerActionSpecRpcHandlers({ rpcHandlerManager: rpc,
          actionIds: [actionId], targetMachineId: controller.machineId, actionExecutor: executor,
          ...(actionId === 'machines.managed.acquire' ? { observeExecution: request =>
            createHostActionOperationRuntime({ machineId: controller.machineId, serverId: configuration.activeServerId,
              custodyBinding: { serverId: configuration.activeServerId, installationId: controller.installationId },
              resolveAccountId: async () => custodianAccountId })
              .observeExecution(request) } : {}) });
        // Private producer callbacks do not ride the existing socket wire.
        const authorization = context?.externalActionExecutionAuthorization;
        if (!authorization) throw new Error('Missing original source proof');
        const wireAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(authorization)));
        const result = await rpc.handleRequest({ method: `${controller.machineId}:${actionId}`,
          params: { v: 1, kind: 'targeted_action_rpc', target, input: actionInput },
          requestId: 'home-relay-correlation', callerAuthority: 'account_automation',
          sessionActionOrigin: authorization.binding.sessionActionOrigin,
          callerInputAuthorization: wireAuthorization,
          machineAdmission: { actorAccountId: 'source-account', custodianAccountId, ...controller,
            role: 'manage', encryptionMode: 'plain' },
        });
        return { ok: true, result };
      } },
    });
    const result = await execute({ ...operation, actionId, input, surface }, { sessionId: 'bob-session', isCurrent: async () => true });
    if (delivery === 'foreign-custodian-rpc' && actionId === 'machines.managed.acquire') {
      expect(result).toEqual({ ok: true, result: { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' } });
      expect(storedApproval).toBeUndefined();
      expect(native.effects()).toBe(0);
      expect(paths.some(path => /\/(?:admit|submit|enrollment-context)$/.test(path))).toBe(false);
      return;
    }
    if (actionId === 'machines.managed.acquire') {
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId,
        artifactId: storedApproval?.id } });
      const approval = storedApproval?.request;
      if (!approval || approval.v !== 2 || !approval.executionOriginV1.externalActionInputSignature) throw new Error('Missing signed receiver approval');
      expect(approval.executionOriginV1).toMatchObject({ accountId: 'source-account', machineId: controller.machineId,
        caller: operation.witness.agentStartCaller, externalActionExecutionAuthorization: { binding: { sessionActionSource: source } } });
      const signed = { authorizationToken: 'source-home-proof', actionId, input: approval.actionArgs, target,
        signature: approval.executionOriginV1.externalActionInputSignature };
      expect(verifyExternalActionApprovalInputV1({ ...signed, publicKey: keys.publicKey })).toBe(true);
      expect(verifyExternalActionApprovalInputV1({ ...signed, publicKey: sourceKeys.publicKey })).toBe(false);
      expect(native.effects()).toBe(0);
      expect(paths.some(path => /\/(?:admit|submit|enrollment-context)$/.test(path))).toBe(false);
      return;
    }
    expect(result, JSON.stringify(result)).toEqual({ ok: true, result: ManagedMachineActionOutputSchemasV1[actionId].parse(
      actionId === 'machines.provisioners.check' ? { available: true } : { machine }) });
    expect(proofRequests).toEqual([expect.objectContaining({ sessionActionOrigin: expect.objectContaining({
      caller: operation.witness.agentStartCaller, sourceTurnId: operation.witness.turnId, requestId: operation.requestId,
    }), installationProof: expect.any(Object) })]);
    expect(native.effects()).toBe(1);
    expect(paths.some(path => /\/(?:admit|submit|enrollment-context)$/.test(path))).toBe(false);
    if (actionId === 'machines.managed.inspect') expect(machine.observation).toEqual({ observedAt: 0, availability: 'present' });
  });

  it('reaches the canonical handoff Action with its actual original Session witness and Home-issued root instead of upgrading to human authority', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const target = { kind: 'machine' as const, machineId: 'source-machine' };
    const handoff: Operation = { ...operation, actionId: 'session.handoff',
      input: { sessionId: 'bob-session', targetMachineId: 'target-machine', targetPath: '/target' } };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    const network = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.envelope.handoffAdmission).toEqual({ sessionId: 'bob-session',
        sourceMachineId: 'source-machine', targetMachineId: 'target-machine' });
      return { status: 200, data: { v: 1, token: 'home-issued-handoff-root', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_home',
        machineId: target.machineId, custodianAccountId: 'alice', installationId: 'source-installation',
        actionId: handoff.actionId, requestId: handoff.requestId, target, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin,
        sessionActionSource: { machineId: target.machineId, installationId: 'source-installation' },
        handoffAdmission: { sessionId: 'bob-session', sourceMachineId: target.machineId, targetMachineId: 'target-machine',
          sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
      } } };
    });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'bob-profile',
      serverHttpBaseUrl: 'https://bob-home.test', token: 'bob-session-token',
      prepareExternalActionAuthorization: async ({ sessionActionOrigin }) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: handoff.requestId,
          target, input: handoff.input, handoffAdmission: { sessionId: 'bob-session', sourceMachineId: target.machineId,
            targetMachineId: 'target-machine' } });
        const minted = await mintExternalActionExecutionAuthorization({ actionId: handoff.actionId, envelope,
          machineId: target.machineId, pat: 'bob-session-token', serverHttpBaseUrl: 'https://bob-home.test',
          sessionActionOrigin, sessionActionSource: { machineId: target.machineId, installationId: 'source-installation' },
          installationProof: signMachineInstallationProof({ privateKey: keys.secretKey, payload: {
            version: 1, accountId: 'bob', machineId: target.machineId, installationId: 'source-installation',
            externalActionOrigin: { homeId: 'srv_home', actionId: handoff.actionId, requestId: handoff.requestId,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: sessionActionOrigin },
          } }) });
        return minted.ok ? { authorization: minted.authorization, target } : null;
      },
      createExecutor: () => createActionExecutor({
        ...createCliActionDeps({ token: 'bob-session-token', sessionId: '', mode: 'plain', ctx: null }),
        // Machine RPC delivery is the genuine effect boundary.
        sessionHandoffStart: async () => ({ ok: false, errorCode: 'handoff_owner_reached', error: 'handoff_owner_reached' }),
      }),
    });
    expect(await execute(handoff, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'handoff_owner_reached' });
    expect(network).toHaveBeenCalled();
  });

  it('refuses the originating Account creation preference before minting its managed Action proof', async () => {
    const serverHttpBaseUrl = 'https://source-home.test';
    const token = 'source-account-token';
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ managedMachineCreationEnabled: false }),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(token)) });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    const network = vi.spyOn(axios, 'post');
    const admitted: string[] = [];
    const acquire: Operation = { ...operation, actionId: 'machines.managed.acquire', input: { enrollmentIdentity: { kind: 'existingUser', role: 'personal' }, selection: {
      kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'source-machine', installationId: 'installation' },
      launch: { provider: { pluginId: 'compute.example', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } } };
    const target = { kind: 'machine' as const, machineId: 'source-machine' };
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'source-profile', serverHttpBaseUrl, token,
      prepareExternalActionAuthorization: async () => {
        const minted = await mintExternalActionExecutionAuthorization({ actionId: acquire.actionId, machineId: target.machineId,
          envelope: ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: acquire.requestId, target, input: acquire.input }),
          pat: token, serverHttpBaseUrl });
        return minted.ok ? { authorization: minted.authorization, target } : null;
      },
      createExecutor: () => createActionExecutor({ ...createCliActionDeps({ token, sessionId: '', mode: 'plain', ctx: null }),
        // Durable acquisition is the effect boundary, not an admission mock.
        managedMachineAction: async ({ actionId }) => { admitted.push(actionId); return { managedId: 'managed' }; },
      }),
    });
    expect(await execute(acquire, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toEqual({ ok: false, errorCode: 'creation_disabled', error: 'creation_disabled' });
    expect(network).not.toHaveBeenCalled();
    expect(admitted).toEqual([]);
  });

  it('carries original requester Home authorization from the admitted Session into Account effects', async () => {
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const target = { kind: 'machine' as const, machineId: 'alice-machine' };
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: operation.requestId, target, input: operation.input });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, _body, config) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      expect(config?.headers).toMatchObject({ Authorization: 'Bearer bob-session-token' });
      return { status: 200, data: { v: 1, token: 'bob-home-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 4 }, serverIdentityId: 'bob-home',
        machineId: target.machineId, custodianAccountId: 'alice', installationId: 'alice-installation',
        actionId: operation.actionId, requestId: operation.requestId, target, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
    });
    let delivered = 0;
    const execute = createDaemonSessionAccountActionExecutor({
      serverId: 'bob-profile', serverHttpBaseUrl: 'https://bob-home.test', token: 'bob-session-token',
      ...{ prepareExternalActionAuthorization: async () => {
        const minted = await mintExternalActionExecutionAuthorization({ actionId: operation.actionId, envelope,
          machineId: target.machineId, pat: 'bob-session-token', serverHttpBaseUrl: 'https://bob-home.test' });
        if (!minted.ok) return null;
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: minted.authorization,
          serverId: 'bob-profile', serverIdentityId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test',
          target, installationId: 'alice-installation', privateKey: installation.secretKey });
        return authorization ? { authorization, target } : null;
      } },
      createExecutor: () => createActionExecutor({
        ...createCliActionDeps({ token: 'bob-session-token', sessionId: '', mode: 'plain', ctx: null }),
        notificationsNotifyMe: async (_input, context) => {
          const headers = await context.externalActionExecutionAuthorization?.requesterHttpProjection?.createRequestHeaders({
            effectActionId: operation.actionId, method: 'POST', path: '/v1/projects/account-rows/list', body: {},
          });
          if (headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'bob-home-proof') delivered += 1;
          return { attemptedChannels: 1, deliveredChannels: delivered };
        },
      }),
    });
    expect(await execute(operation, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    expect(delivered).toBe(1);
    expect(network).toHaveBeenCalled();
  });

  it.each(['recipient', 'missing'] as const)('refuses a %s Session before using the daemon Account', async (kind) => {
    vi.spyOn(axios, 'get').mockResolvedValue(kind === 'missing'
      ? { status: 404, data: {} }
      : { status: 200, data: { session: createSessionRecordFixture({ id: 'bob-session',
          share: { accessLevel: 'admin', canApprovePermissions: true } }) } });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => true, signal: new AbortController().signal }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: {
        reason: kind === 'missing' ? 'session_owner_missing' : 'session_not_owner',
      } });
    expect(harness.delivered).toEqual([]);
  });

  it('diagnoses a refused client Action proof without disclosing its input or credentials', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    // File logging and authenticated Home reads are genuine system boundaries.
    const logged = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: {} });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'alice-home',
      serverHttpBaseUrl: 'https://alice-home.test', token: 'private-daemon-token',
      prepareExternalActionAuthorization: async ({ operation: action, sessionActionOrigin }) => {
        const target = { kind: 'machine' as const, machineId: 'source-machine' };
        const minted = await mintExternalActionExecutionAuthorization({ actionId: action.actionId,
          envelope: ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: action.requestId, target, input: action.input }),
          machineId: target.machineId, pat: 'private-daemon-token', serverHttpBaseUrl: 'https://alice-home.test', sessionActionOrigin });
        return minted.ok ? { authorization: minted.authorization, target } : null;
      },
      createExecutor: () => createActionExecutor(createCliActionDeps({ token: 'private-daemon-token', sessionId: '', mode: 'plain', ctx: null })),
    });
    const search: Operation = { ...operation, actionId: 'search.conversations', input: {
      query: { v: 1, query: 'private-query', scope: { type: 'global' }, mode: 'hints' },
      machineIds: ['source-machine'], mode: 'indexed',
    } };
    expect(await execute(search, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'action_forbidden', details: { reason: 'external_authorization_refused',
        phase: 'session.authorization.preparation', requiredFact: 'session_authorization_preparation', remedy: expect.any(String) } });
    expect(logged.mock.calls.filter(([message]) => message === '[Session Account Action] Refused')).toEqual([[expect.any(String), {
      actionId: search.actionId, sessionId: 'bob-session', requestId: search.requestId,
      turnId: operation.witness.turnId, reason: 'external_authorization_refused', elapsedSubphasesMs: {},
    }]]);
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private-query|private-daemon-token/);
    expect(network).toHaveBeenCalled();
  });

  it('admits the Session owner once per Action and applies a changed owner at the next admission', async () => {
    const read = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    const preparedCurrentness: boolean[] = [];
    // The installed preparer consults caller currentness before and after its
    // Home reads and again at the mint; none of these is a new admission.
    const harness = createHarness(async ({ isCallerCurrent }) => {
      preparedCurrentness.push(await isCallerCurrent(), await isCallerCurrent(), await isCallerCurrent());
      return undefined;
    });
    let live = true;
    const authority = { sessionId: 'bob-session', isCurrent: async () => live };
    expect(await harness.execute(operation, authority))
      .toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('https://alice-home.test/v2/sessions/bob-session',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer alice-daemon-token' }) }));
    expect(preparedCurrentness).toEqual([true, true, true]);
    // Within the admitted Action, currentness is local custody and cancellation.
    read.mockResolvedValue({ status: 404, data: {} });
    expect(await harness.isCallerCurrent()).toBe(true);
    live = false;
    expect(await harness.isCallerCurrent()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    // The withdrawn owner projection is refused at the next Action admission.
    live = true;
    expect(await harness.execute(operation, authority))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'session_owner_missing' } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(harness.delivered).toHaveLength(1);
  });

  it('preserves each admitted requester at the real daemon Action effect while keeping owner credentials', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: ownedSessionRecord() } });
    const harness = createHarness();
    for (const accountId of ['bob', 'carol']) {
      const actionRequestAttributionV1 = { requestRef: `${accountId}-input`,
        requester: { serverId: 'alice-home', accountId },
        persona: { serverId: 'alice-home', sessionId: 'bob-session' }, origin: null };
      const input = { ...operation, requestId: `${accountId}-action`, witness: {
        ...operation.witness, inputId: `${accountId}-input`, actionRequestAttributionV1,
      } };
      expect(await harness.execute(input, { sessionId: 'bob-session', isCurrent: async () => true }))
        .toMatchObject({ ok: true });
    }
    expect(harness.delivered).toMatchObject(['bob', 'carol'].map(accountId => ({ context: {
      authority: 'account_automation', serverId: 'alice-home',
      actionRequestAttributionV1: { requestRef: `${accountId}-input`, requester: { accountId },
        persona: { sessionId: 'bob-session' } },
    } })));
  });

  it('refuses retired runtime custody before reading the Account or delivering', async () => {
    const read = vi.spyOn(axios, 'get');
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => false }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'runtime_authority_unavailable' } });
    expect(read).not.toHaveBeenCalled();
    expect(harness.delivered).toEqual([]);
  });

  it('refuses custody retired while the authenticated owner read is pending', async () => {
    let live = true;
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      live = false;
      return { status: 200, data: { session: ownedSessionRecord() } };
    });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => live }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'runtime_authority_unavailable' } });
    expect(harness.delivered).toEqual([]);
  });

  it('preserves target_unavailable when cancellation arrives during the initial custody check', async () => {
    const controller = new AbortController();
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', signal: controller.signal,
      isCurrent: async () => { controller.abort(); return false; } }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'runtime_authority_unavailable' } });
    expect(harness.delivered).toEqual([]);
  });
});
