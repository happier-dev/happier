import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { buildBackendTargetKeyV2, FeaturesResponseSchema, SessionUsageLimitRecoveryV1Schema, SessionRuntimeIssueV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { DISCUSSION_AGENT_POST_EVENT_V1, DiscussionAgentPostResponseV1Schema, DiscussionDetailsResponseV1Schema } from '@happier-dev/protocol/discussions/api';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ApiMachineClient } from '@/api/apiMachine';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { createWorkspaceWritesPolicyPreparation } from '@/session/roles/workspaceWritesPolicyPreparation';
import { RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { configuration } from '@/configuration';
import * as persistence from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readPluginRoleSources } from '@/plugins/projection/registry/roles';
import { createSessionRoleContext } from '@/session/roles/sessionRoleContext';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  readAccountRoleOverridesFromSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withTempDir } from '@/testkit/fs/tempDir';
import { registerSessionClientRuntimeHandlers } from './registerSessionClientRuntimeHandlers';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { logger } from '@/ui/logger';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { DurableWorkflowCoordinatorStore } from '@/daemon/workflows/production';
import { workflowInvocationKey } from '@/daemon/workflows/coordinator';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

const homes: Server[] = [];

// Same decoder-valid Account token vector as the Session runtime-catalog suite.
// Home authentication is the genuine loopback HTTP boundary in this test.
function accountToken(sub: string): string {
  return `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.`;
}

afterEach(async () => {
  resetInMemoryAccountSettingsContextForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map(home => new Promise<void>((resolve, reject) => {
    home.close(error => error ? reject(error) : resolve());
  })));
});

async function home(settingsVersion: number, rawSettings: Readonly<Record<string, unknown>>, roleCatalog = false, usageLimitRecovery?: boolean,
  onStalledMutation?: () => void, handleRequest?: (request: IncomingMessage, response: ServerResponse) => boolean) {
  let usageLimitIssue: SessionRuntimeIssueV1 | null = null;
  const settingsResponse = AccountSettingsV2GetResponseSchema.parse({
    version: settingsVersion, content: { t: 'plain', v: rawSettings },
  });
  const requests: Array<Readonly<{ method: string | undefined; path: string | undefined;
    authorization: string | undefined; settingsResponse?: typeof settingsResponse }>> = [];
  const server = createServer((request, response) => {
    if (onStalledMutation && request.method === 'POST' && request.url === '/v2/sessions/access-grants/set') {
      request.resume();
      request.on('end', onStalledMutation);
      return;
    }
    const isSettingsRead = request.method === 'GET' && request.url === '/v2/account/settings';
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization,
      ...(isSettingsRead ? { settingsResponse } : {}) });
    response.setHeader('Content-Type', 'application/json');
    if (handleRequest?.(request, response)) return;
    if (usageLimitRecovery !== undefined && request.url === '/v1/features') {
      response.end(JSON.stringify(FeaturesResponseSchema.parse({ features: { sessions: {
        enabled: true, usageLimitRecovery: { enabled: usageLimitRecovery },
      } } })));
    } else if (usageLimitRecovery !== undefined && request.method === 'GET' && request.url?.startsWith('/v2/sessions/')) {
      const sessionId = decodeURIComponent(new URL(request.url, 'http://fixture.local').pathname.slice('/v2/sessions/'.length));
      response.end(JSON.stringify({ session: createSessionRecordFixture({ id: sessionId,
        latestTurnStatus: usageLimitIssue ? 'failed' : null, lastRuntimeIssue: usageLimitIssue,
      }) }));
    } else if (isSettingsRead) {
      response.once('finish', () => server.emit('settings-read'));
      response.end(JSON.stringify(settingsResponse));
    }
    else if (roleCatalog && request.method === 'GET' && request.url === '/v1/account/encryption/currentness') {
      response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    } else if (roleCatalog && request.method === 'GET' && request.url === '/v1/account/entity-rows/prompt-library') {
      response.end(JSON.stringify(PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
          content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) })));
    } else if (roleCatalog && request.method === 'GET' && request.url === '/v1/account/entity-rows/profiles/transfer') {
      response.end(JSON.stringify({ status: 'absent' }));
    } else if (roleCatalog && request.method === 'GET' && request.url === '/v2/account/settings/history') {
      response.end(JSON.stringify({ snapshots: [] }));
    } else if (roleCatalog && request.method === 'GET' && request.url?.startsWith('/v1/artifacts?')) {
      response.end(JSON.stringify(artifactListResponse(request.url, [])));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  const settingsRead = once(server, 'settings-read');
  homes.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home loopback address');
  return { url: `http://127.0.0.1:${address.port}`, requests, settingsResponse, settingsRead, server,
    setUsageLimitIssue: (issue: SessionRuntimeIssueV1 | null) => { usageLimitIssue = issue; },
  };
}

describe('Session RPC owner Home Settings custody', () => {
  it.each(['enabled', 'disabled', 'unknown', 'storage_unavailable', 'run_access_denied'] as const)(
    'publishes an accepted Workflow return through the captured Home Action owner (%s)', async scenario => {
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'automations,workflows');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    const diagnostics = vi.spyOn(logger, 'infoFile');
    const accountId = 'workflow-owner';
    const serverId = 'srv_workflow_owner_home';
    const sessionId = 'workflow-receiver';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const recordId = 'invocation';
    const workflow = { purpose: 'invocation' as const, runId, invocationRecordId: recordId };
    const localId = deriveWorkflowSessionInputLocalIdV2(workflow);
    const discussion = { serverId, discussionId: 'discussion' };
    const addressing = { discussionId: discussion.discussionId, messageId: 'question', throughSeq: 2, participantSessionId: sessionId };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
    }, blocks: [{ kind: 'step', id: 'answer', document: { text: 'Answer', references: [], attachments: [] },
      input: [], result: { kind: 'text' }, execution: { conversation: { kind: 'fresh' } } }] },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', discussion: { discussion, messageId: 'question', throughSeq: 2 } },
        resultDelivery: { kind: 'originating_discussion', discussion, messageId: 'question', throughSeq: 2 },
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error('Workflow fixture admission failed');
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot }));
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', accountId,
      origin: { kind: 'direct' }, acceptedEnvelope });
    const root = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: 'root', sequence: '0',
        parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress: { kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0', logicalInvocationRecordId: 'root' } }));
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'unused',
      rootInvocation: { id: 'root', contentEnvelope: root } });
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId: 'root',
      revision: storage.run().revision, checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: 'root', nextSequence: '1',
        frontier: { nextBlockOrdinal: 0, paused: false } }, storage,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
    const key = workflowInvocationKey({ runId, blockId: 'answer', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId, runId, blockId: 'answer', path: { blockId: 'answer', scope: [] },
      blockKind: 'step', memberOrdinal: '0', attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'completed', result: 'Accepted answer',
      execution: { kind: 'session', sessionId, localInputId: localId } });
    const ownerCredentials = { token: accountToken(accountId), encryption: null } as const;
    const owner = await home(11, { schemaVersion: 6 }, true, undefined, undefined, (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/features') {
        response.end(JSON.stringify(identitySnapshot.features));
        return true;
      }
      if (request.method === 'GET' && request.url === '/v1/auth/ping') {
        response.end('{}');
        return true;
      }
      if (request.method === 'GET' && request.url?.endsWith('/reply')) {
        response.end(JSON.stringify({ v: 1, status: 'available', progress: { v: 1, mode: 'wait', workflow,
          discussion: addressing, acceptedTurnId: 'turn', disposition: 'inline',
          outcome: { kind: 'answer', result: { sessionId, messageId: 'native-final' } } } }));
        return true;
      }
      if (request.method === 'GET' && request.url === '/v1/discussions/discussion') {
        response.end(JSON.stringify(DiscussionDetailsResponseV1Schema.parse({ discussion: {
          id: discussion.discussionId, ownerAccountId: accountId, encryptionMode: 'plain',
          anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'created',
          titleContent: { t: 'plain', v: { v: 1, title: 'Question' } }, messageSeq: 2, lastReadSeq: 0,
          unreadCount: 2, unreadMentionCount: 0, recentAuthorAccountIds: [accountId], archivedAt: null,
          latestMessage: { id: 'question', localId: 'question-local', seq: 2, authorAccountId: accountId,
            accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 2 },
          capabilities: { postMessages: true, rename: true, archive: true, restore: false,
            askAgent: true, sendToSession: true, manageAccess: true, leave: false },
        } })));
        return true;
      }
      if (request.method !== 'POST' || request.url !== WORKFLOW_RUN_STORAGE_HTTP_PATH) return false;
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => { void (async () => {
        if (scenario === 'storage_unavailable' || scenario === 'run_access_denied') {
          response.statusCode = scenario === 'storage_unavailable' ? 503 : 403;
          response.end(JSON.stringify({ error: scenario }));
          return;
        }
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (!raw || typeof raw !== 'object' || !('operation' in raw) || !('runId' in raw) || raw.runId !== runId) {
          throw new Error('Unexpected Workflow storage request');
        }
        const result = raw.operation === 'get' ? await storage.execute({ operation: 'get', runId })
          : raw.operation === 'invocations.get' && 'invocationId' in raw && raw.invocationId === recordId
            ? await storage.execute({ operation: 'invocations.get', runId, invocationId: recordId }) : null;
        if (!result) throw new Error('Unexpected Workflow storage operation');
        response.end(JSON.stringify(result));
      })().catch(error => { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }); });
      return true;
    });
    const focused = await home(99, { schemaVersion: 6 });
    const identitySnapshot = { status: 'ready' as const, provenance: 'authenticated' as const, features: FeaturesResponseSchema.parse({ features: {
      automations: { enabled: true }, workflows: { enabled: true },
    }, capabilities: { serverIdentity: { serverIdentityId: serverId } } }) };
    let snapshot: CliServerFeaturesSnapshot | undefined = { ...identitySnapshot,
      features: FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: false } } }) };
    const posts: unknown[] = [];
    let observeConnected!: () => void;
    const connectionReady = new Promise<void>(resolve => { observeConnected = resolve; });
    const socket = createApiSessionSocketStub({ onConnect: observeConnected, emitWithAck: (event, payload) => {
      if (event === DISCUSSION_AGENT_POST_EVENT_V1) {
        posts.push(payload);
        return DiscussionAgentPostResponseV1Schema.parse({ v: 1, ok: true, value: { messageSeq: 3, message: {
          id: 'published', discussionId: discussion.discussionId,
          localId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId, localId, acceptedTurnId: 'turn' }),
          seq: 3, authorAccountId: null, accountActor: null, producerV1: null,
          content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Accepted answer' }] } },
          mentionedAccountIds: [], replyTarget: { kind: 'message', messageId: 'question' }, createdAt: 3,
        } } });
      }
      return { ok: true };
    } });
    const metadata = createTestMetadata({ path: '/repo', machineId: 'machine' });
    const parent = new ApiSessionClient(ownerCredentials.token, createPlainSessionFixture({ id: sessionId, metadata }), {
      metadataAuthority: { kind: 'owner', credentials: ownerCredentials }, getServerFeaturesSnapshot: () => identitySnapshot,
      transport: { serverId, serverUrl: owner.url, createSessionSocketTransport: () => ({ socket: socket as never,
        transport: createSocketTransportAdapter(socket as never) }) },
    });
    const rpcLog = vi.fn();
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: rpcLog });
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const pluginRegistry = createResolvedContributionRegistry({});
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager: rpc, token: ownerCredentials.token, serverId, serverUrl: owner.url,
      readOwnerAccountCredentials: async () => ownerCredentials, getServerFeaturesSnapshot: () => snapshot,
      readRoleSources: createRoleSourceReader({ accountId, artifactStore: createCredentialedAccountArtifactStore(ownerCredentials),
        readPluginRoles: () => readPluginRoleSources(pluginRegistry), readRawAccountSettings: async () => ({ schemaVersion: 6 }) }),
      metadataPath: metadata.path, metadata, sessionId, getSessionMetadata: () => metadata, session: parent,
      enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
      enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    try {
      await connectionReady;
      // The callback must observe the current captured Home, not freeze registration's disabled bit.
      if (scenario !== 'disabled') snapshot = scenario === 'unknown' ? undefined : identitySnapshot;
      const result = await runWithServerHttpBaseUrl(focused.url, () => rpc.invokeLocal(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1,
        { request: { v: 1, sessionId, discussionId: discussion.discussionId,
          replyReturn: { serverId, requestLocalId: localId, acceptedTurnId: 'turn',
            workflow: { runId, invocationRecordId: recordId, invocationAttempt: '0' } },
          request: { localId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId, localId, acceptedTurnId: 'turn' }),
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Accepted answer' }] } },
            mentionedAccountIds: [], mentionedSessionIds: [], replyTarget: { kind: 'message', messageId: 'question' } } } }));
      const enabled = scenario === 'enabled';
      expect(posts, JSON.stringify({ result, requests: owner.requests.map(({ method, path }) => ({ method, path })),
        rpc: rpcLog.mock.calls.filter(([message]) => message === '[RPC] Request completed'),
        diagnostics: diagnostics.mock.calls.filter(([message]) => typeof message === 'string'
          && (message.includes('workflow_action_failure') || message === '[Session] Role Action refused')) }))
        .toHaveLength(enabled ? 1 : 0);
      expect(result).toMatchObject(enabled ? { v: 1, ok: true }
        : scenario === 'disabled' ? { v: 1, ok: false }
          : { v: 1, ok: false, error: scenario === 'run_access_denied' ? 'discussion_post_denied' : 'discussions_unavailable' });
      expect(owner.requests.some(request => request.path === WORKFLOW_RUN_STORAGE_HTTP_PATH))
        .toBe(scenario !== 'disabled' && scenario !== 'unknown');
      expect(owner.requests.filter(request => request.path === WORKFLOW_RUN_STORAGE_HTTP_PATH)
        .every(request => request.authorization === `Bearer ${ownerCredentials.token}`)).toBe(true);
      expect(focused.requests).toEqual([]);
    } finally { await registration.dispose(); await parent.close(); }
  });
  it.each(['invocation', 'retirement'] as const)('cancels an issued Team visibility mutation on %s and preserves uncertainty', async lifetime => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    let accepted!: () => void;
    const mutationAccepted = new Promise<void>(resolve => { accepted = resolve; });
    let mutationIssued = false;
    const credentials = { token: accountToken('team-owner'), encryption: null } as const;
    const owner = await home(11, {}, false, undefined, () => { mutationIssued = true; accepted(); });
    const sessionId = 'team-owner-session';
    const metadata = createTestMetadata({});
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager: rpc, token: credentials.token, serverId: 'team-home', serverUrl: owner.url,
      readOwnerAccountCredentials: async () => credentials,
      metadataPath: metadata.path, metadata, sessionId, getSessionMetadata: () => metadata,
      enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
      enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    const controller = new AbortController();
    const selection = { kind: 'team_credential_provider_model' as const, resourceId: 'resource', teamId: 'team',
      expectedResourceRevision: 7, agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }),
      modelId: 'team-model', deliveryMode: 'brokered' };
    const pending = rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      sessionId,
      intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Delegate.',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      modelId: selection.modelId, teamCredentialModel: selection,
      teamCredentialSessionBindingConsent: { v: 1, sessionId, teamId: selection.teamId,
        resourceId: selection.resourceId, expectedResourceRevision: selection.expectedResourceRevision },
    }, { signal: controller.signal, verifiedPeerAuthority: 'present_user' });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending, mutationAccepted.then(async () => {
        if (lifetime === 'invocation') controller.abort();
        else void registration.dispose();
        return await pending;
      }), new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('Team visibility cancellation did not settle HTTP')), 2000);
      })]);
      expect(mutationIssued).toBe(true);
      expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
    } finally {
      clearTimeout(watchdog);
      owner.server.closeAllConnections();
      await pending;
      await registration.dispose();
    }
  });
  it.each([true, false])('uses the captured Home usage-limit feature decision when the focused Home disagrees (owner enabled=%s)', async ownerEnabled => {
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'sessions,sessions.usageLimitRecovery');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    const ownerCredentials = { token: accountToken('usage-feature-owner'), encryption: null } as const;
    const owner = await home(11, {}, false, ownerEnabled);
    const focused = await home(99, {}, false, !ownerEnabled);
    const sessionId = 'usage-feature-owner-session';
    const metadata = createTestMetadata({ machineId: 'usage-feature-owner-machine',
      sessionUsageLimitRecoveryV1: SessionUsageLimitRecoveryV1Schema.parse({
        v: 1, status: 'waiting', resumePromptMode: 'standard', issueFingerprint: 'usage-limit:feature-owner',
        armedAtMs: 1_000, resetAtMs: 5_000, nextCheckAtMs: 5_000, attemptCount: 0,
        maxAttempts: 3, lastProbeError: null, selectedAuth: { kind: 'native' },
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:feature-owner',
      }),
    });
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager: rpc, token: ownerCredentials.token, serverId: 'usage-feature-owner-home', serverUrl: owner.url,
      readOwnerAccountCredentials: async () => ownerCredentials,
      metadataPath: metadata.path, metadata, sessionId, getSessionMetadata: () => metadata,
      enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
      enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    try {
      await runWithServerHttpBaseUrl(focused.url, async () => {
        await expect(rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, { sessionId }))
          .resolves.toMatchObject({ ok: false, errorCode: ownerEnabled
            ? 'session_usage_limit_recovery_control_target_machine_unavailable' : 'feature_disabled' });
        expect(owner.requests).toContainEqual({ method: 'GET', path: '/v1/features', authorization: undefined });
        const machineRequests = owner.requests.filter(request => request.path?.startsWith('/v1/machines/'));
        expect(machineRequests).toEqual(ownerEnabled ? [{ method: 'GET', path: '/v1/machines/usage-feature-owner-machine',
          authorization: `Bearer ${ownerCredentials.token}` }] : []);
        expect(focused.requests).toEqual([]);
      });
    } finally { await registration.dispose(); }
  });
  it('routes a live usage-limit check with current owner credentials to its captured Home', async () => {
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'sessions,sessions.usageLimitRecovery');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    const ownerCredentials = { token: accountToken('usage-owner'), encryption: null } as const;
    const owner = await home(11, {}, false, true);
    const focused = await home(99, {}, false, true);
    const sessionId = 'usage-owner-session';
    const metadata = createTestMetadata({ machineId: 'usage-owner-machine',
      sessionUsageLimitRecoveryV1: SessionUsageLimitRecoveryV1Schema.parse({
        v: 1, status: 'waiting', resumePromptMode: 'standard', issueFingerprint: 'usage-limit:owner',
        armedAtMs: 1_000, resetAtMs: 5_000, nextCheckAtMs: 5_000, attemptCount: 0,
        maxAttempts: 3, lastProbeError: null, selectedAuth: { kind: 'native' },
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:owner',
      }),
    });
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    let credentialsCurrent = true;
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager: rpc, token: ownerCredentials.token, serverId: 'usage-owner-home', serverUrl: owner.url,
      readOwnerAccountCredentials: async () => credentialsCurrent ? ownerCredentials : null,
      metadataPath: metadata.path, metadata, sessionId, getSessionMetadata: () => metadata,
      enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
      enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    const check = () => rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, { sessionId });
    try {
      await runWithServerHttpBaseUrl(focused.url, async () => {
        // The genuine HTTP boundary refuses the unavailable Machine. Its request
        // still proves the registered route retained the Session's Home and owner.
        await expect(check()).resolves.toMatchObject({ ok: false,
          errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable' });
        expect(owner.requests).toContainEqual({ method: 'GET', path: '/v1/machines/usage-owner-machine',
          authorization: `Bearer ${ownerCredentials.token}` });
        expect(focused.requests.filter(request => request.path?.startsWith('/v1/machines/'))).toEqual([]);
        owner.setUsageLimitIssue(SessionRuntimeIssueV1Schema.parse({
          v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
          agentId: 'claude', agentTurnId: 'new-turn', occurredAt: 2_000,
          usageLimit: { v: 1, resetAtMs: 8_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
        }));
        await expect(check()).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_session_runtime_method' });
        expect(owner.requests.filter(request => request.path?.startsWith('/v1/machines/'))).toHaveLength(1);
        expect(owner.requests).toContainEqual({ method: 'GET', path: `/v2/sessions/${sessionId}`,
          authorization: `Bearer ${ownerCredentials.token}` });
        expect(focused.requests.filter(request => request.path?.startsWith('/v2/sessions/'))).toEqual([]);
        const ownerRequestCount = owner.requests.length;
        credentialsCurrent = false;
        await expect(check()).resolves.toMatchObject({ ok: false,
          errorCode: 'session_usage_limit_recovery_control_session_unavailable' });
        expect(owner.requests).toHaveLength(ownerRequestCount);
      });
    } finally { await registration.dispose(); }
  });
  it('keeps an attached agentDefault start Account refusal typed without caller Machine context', async () => {
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    const sessionId = 'default-child-owner-session';
    const metadata = createTestMetadata({});
    delete metadata.machineId;
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
    const registration = registerSessionClientRuntimeHandlers({
      rpcHandlerManager: rpc, token: accountToken('unavailable-owner'), serverId: 'session-owner-home', serverUrl: 'http://owner.invalid',
      readOwnerAccountCredentials: async () => null,
      metadataPath: metadata.path, metadata, sessionId, getSessionMetadata: () => metadata,
      enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
      enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
      sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
    });
    try {
      const result = await rpc.handleRequest({ method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`,
        params: ExecutionRunStartRequestSchema.parse({ intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Delegate with the Agent default.', childSelection: 'agentDefault', permissionMode: 'read_only',
          retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' }), callerAuthority: 'present_user' });
      expect(result).toMatchObject({ ok: false, errorCode: 'provider_authorization_changed',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
    } finally { await registration.dispose(); }
  });
  it('admits a signed Workflow Role write through a native root Session prepared Account context', async () => {
    const credentials = { token: accountToken('workflow-root-role-owner'), encryption: null } as const;
    const owner = await home(11, { schemaVersion: 6, actionsSettingsV1: { v: 1, actions: {},
      approvalWaivedSurfaces: { 'session.role.set': ['agent'] } } }, true);
    await withTempDir('happier-workflow-root-role-', async directory => {
      await runWithServerHttpBaseUrl(owner.url, async () => {
        const sessionId = 'workflow-root-role-lead';
        const machineId = 'workflow-root-role-machine';
        const serverId = 'workflow-root-role-home';
        const backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;
        const metadata = createTestMetadata({ path: directory, machineId, flavor: 'codex' });
        const bootstrap = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking',
          publication: 'invocation', honorAccountSettingsModeEnv: false });
        const scopeKey = bootstrap.scopeKey;
        if (!scopeKey) throw new Error('Missing prepared root Account scope');
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: { ...bootstrap, scopeKey },
          serverHttpBaseUrl: owner.url, isCurrent: async () => true });
        const pluginRegistry = createResolvedContributionRegistry({});
        const readRoleSources = createRoleSourceReader({ accountId: 'workflow-root-role-owner',
          artifactStore: createCredentialedAccountArtifactStore(credentials),
          readPluginRoles: () => readPluginRoleSources(pluginRegistry),
          readRawAccountSettings: async () => operation.readSnapshot()?.rawSettings ?? {} });
        const nativeSelection = { status: 'applied', backendTarget, modelId: 'gpt-6.1-terra', connectedServices: null } as const;
        // Native Agent readback and Socket.IO are system boundaries; Account,
        // Role preparation, receiving registration and Workflow admission stay real.
        const controls = { readAppliedChildSelection: async () => nativeSelection };
        const roleContext = createSessionRoleContext({ readMetadata: () => metadata,
          readOrganization: async () => ({}), readRoleSources,
          readOperationContext: () => operation,
          readAccountRoleOverrides: () => {
            const snapshot = operation.readSnapshot();
            return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot)
              : { status: 'unavailable', reason: 'scope-retired' };
          },
          prepareAccountRoleOverrides: async signal => { await prepareActiveAccountRoleOverrides({ credentials,
            scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
            operationContext: operation, signal }); },
          readDefaultEngine: () => ({ agentTargetKey: buildBackendTargetKeyV2(backendTarget) }),
          readAppliedChildSelection: controls.readAppliedChildSelection,
        });
        await roleContext.prepare();
        expect(await roleContext.readAccountOverrides()).toMatchObject({ status: 'ready' });
        expect(await roleContext.readAppliedChildSelection?.()).toMatchObject({ status: 'applied', modelId: 'gpt-6.1-terra' });
        expect(operation.readSnapshot()).toMatchObject({ source: 'network', settingsVersion: 11,
          scopeKey, settings: bootstrap.settings });
        const settingsReads = owner.requests.filter(request => request.method === 'GET' && request.path === '/v2/account/settings').length;
        expect(settingsReads).toBeGreaterThan(0);
        const socket = createApiSessionSocketStub();
        const parent = new ApiSessionClient(credentials.token, createPlainSessionFixture({ id: sessionId, metadata }), {
          metadataAuthority: { kind: 'owner', credentials },
          transport: { serverId, serverUrl: owner.url,
            createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
        });
        const runtimeSession = applyRunnerMcpSessionContext(parent, { getSessionRoleContext: () => roleContext,
          getBackendTarget: () => backendTarget, readRoleSources });
        parent.setSessionRuntimeControls(controls);
        const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
        const mutations: RegisteredSessionStateFieldMutationV1[] = [];
        const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
        const registration = registerSessionClientRuntimeHandlers({ rpcHandlerManager: rpc, sessionId,
          token: credentials.token, serverId, serverUrl: owner.url, localMachineId: machineId,
          readOwnerAccountCredentials: async () => credentials, session: runtimeSession,
          metadataPath: directory, metadata, getSessionMetadata: () => metadata, sessionRuntimeControls: controls,
          enqueueRegisteredSessionStateFieldMutation: async mutation => { mutations.push(mutation); },
          enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
          enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
          sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
          getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
          persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
        });
        const input = { sessionId, roleId: 'builder' };
        const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'workflow-root-role-write',
          target: { kind: 'session', sessionId }, input });
        // Home's signature/relay verification is the external authentication
        // boundary, matching the signed Workflow packets delivered to a runner.
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-workflow-role',
          binding: { accountId: 'workflow-root-role-owner', custodianAccountId: 'workflow-root-role-owner',
            authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', serverIdentityId: serverId,
            machineId, installationId: 'installed-root-runner', actionId: 'session.role.set',
            requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            target: envelope.target, workflowActionOrigin: { runId: 'workflow-root-run', requestId: envelope.requestId,
              sessionAuthority: { authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
                runDepth: 0, runOriginSessionId: sessionId, directory, workspaceWrites: 'allow' } } } });
        try {
          const result = await rpc.handleRequest({ method: `${sessionId}:session.role.set`, params: input,
            callerAuthority: 'account_automation', callerInputAuthorization: authorization });
          expect(owner.requests.filter(request => request.method === 'GET' && request.path === '/v2/account/settings')).toHaveLength(settingsReads);
          expect(result).toEqual({ updated: true });
          expect(mutations).toContainEqual(expect.objectContaining({ sessionId, fieldId: 'intent.role',
            op: { kind: 'set', value: 'builder' } }));
        } finally { await registration.dispose(); await parent.close(); }
      });
    });
  });
  it('sets a live Session role from its private owner without borrowing the focused Account catalog', async () => {
    const diagnostics = vi.spyOn(logger, 'infoFile');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_TTL_MS', '0');
    const ownerCredentials = { token: accountToken('role-owner-account'), encryption: null } as const;
    let ownerCurrent = true;
    const focusedCredentials = { token: accountToken('role-focused-account'), encryption: null } as const;
    const owner = await home(11, { schemaVersion: 6 }, true);
    const focused = await home(99, { schemaVersion: 6 });
    await withTempDir('happier-session-role-owner-', async directory => {
      await runWithServerHttpBaseUrl(focused.url, async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(focusedCredentials),
          promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
        const incumbent = getActiveAccountSettingsSnapshot();
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const sessionId = 'role-owner-session';
        const metadata = createTestMetadata({ path: directory, machineId: 'role-owner-machine' });
        const socket = createApiSessionSocketStub();
        const parent = new ApiSessionClient(ownerCredentials.token, createPlainSessionFixture({ id: sessionId, metadata }), {
          metadataAuthority: { kind: 'owner', credentials: ownerCredentials },
          transport: { serverId: 'role-owner-home', serverUrl: owner.url,
            // Socket.IO is the external transport boundary; the Session and Role registration remain real.
            createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
        });
        const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
        const queued: RegisteredSessionStateFieldMutationV1[] = [];
        const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
        // An explicitly empty plugin fixture, projected by the real registry;
        // Role source resolution stays real and does not discover unrelated bundled Agent manifests.
        const pluginRegistry = createResolvedContributionRegistry({});
        const registration = registerSessionClientRuntimeHandlers({
          rpcHandlerManager: rpc, token: ownerCredentials.token, serverId: 'role-owner-home', serverUrl: owner.url,
          readOwnerAccountCredentials: async () => ownerCurrent ? ownerCredentials : null,
          readRoleSources: createRoleSourceReader({ accountId: 'role-owner-account',
            artifactStore: createCredentialedAccountArtifactStore(ownerCredentials),
            readPluginRoles: () => readPluginRoleSources(pluginRegistry),
            readRawAccountSettings: async () => {
              const context = await bootstrapAccountSettingsContext({ credentials: ownerCredentials,
                mode: 'blocking', publication: 'invocation', honorAccountSettingsModeEnv: false });
              if (!context.rawSettings) throw new Error('Missing loopback owner Settings');
              return context.rawSettings;
            },
          }),
          metadataPath: directory, metadata, sessionId, getSessionMetadata: () => metadata,
          session: parent,
          enqueueRegisteredSessionStateFieldMutation: async mutation => { queued.push(mutation); },
          enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
          enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
          sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
          getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
          persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
        });
        try {
          const result = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'builder' }, callerAuthority: 'present_user' });
          expect(result).toEqual({ updated: true });
          expect(queued).toEqual([expect.objectContaining({ sessionId, fieldId: 'intent.role', op: { kind: 'set', value: 'builder' } })]);
          expect(focused.requests).toEqual([]);
          expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
          expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(lifetime);
          let nativeWorkspaceWrites: 'allow' | 'deny' = 'allow';
          const runtimeSession = applyRunnerMcpSessionContext(parent, {
            prepareWorkspaceWritesPolicy: createWorkspaceWritesPolicyPreparation({
              // Native Agent configuration is the external boundary installed after Session RPC registration.
              update: async workspaceWrites => {
                nativeWorkspaceWrites = workspaceWrites;
                return { status: 'applied', timing: 'current_window' };
              },
            }),
          });
          const tightened = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'scout' }, callerAuthority: 'present_user' });
          expect(tightened).toEqual({ updated: true });
          expect(RoleActionOutputSchemasV1['session.role.set'].parse(tightened)).toEqual({ updated: true });
          expect(nativeWorkspaceWrites).toBe('deny');
          expect(queued.at(-1)).toMatchObject({ sessionId, fieldId: 'intent.role', op: { kind: 'set', value: 'scout' } });
          runtimeSession.prepareWorkspaceWritesPolicy = undefined;
          const missingRuntime = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'scout' }, callerAuthority: 'present_user' });
          expect(missingRuntime).toMatchObject({ ok: false, errorCode: 'role_policy_unenforceable' });
          expect(queued).toHaveLength(2);
          const unavailableRole = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'missing-role' }, callerAuthority: 'present_user' });
          expect(unavailableRole).toEqual({ ok: false, errorCode: 'role_target_unavailable',
            error: 'role_target_unavailable' });
          expect(queued).toHaveLength(2);
          ownerCurrent = false;
          const retired = await rpc.handleRequest({ method: `${sessionId}:session.role.set`,
            params: { sessionId, roleId: 'scout' }, callerAuthority: 'present_user' });
          expect(retired).toEqual({ ok: false, errorCode: 'account_role_overrides_unavailable',
            error: 'account_role_overrides_unavailable' });
          expect(diagnostics.mock.calls.filter(([message]) => message === '[Session] Role Action refused')).toContainEqual([
            '[Session] Role Action refused', { originalCode: 'account_role_overrides_unavailable', reason: 'credentials-unavailable', contextSource: 'account_lifetime' },
          ]);
          expect(queued).toHaveLength(2);
          expect(focused.requests).toEqual([]);
          expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        } finally { await registration.dispose(); await parent.close(); }
      });
    });
  });
  it('admits detached Run policy from the authenticated daemon Account without borrowing focused Settings', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_TTL_MS', '0');
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'execution.runs');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    const ownerCredentials = { token: accountToken('daemon-owner-account'), encryption: null } as const;
    const focusedCredentials = { token: accountToken('unrelated-focused-account'), encryption: null } as const;
    const owner = await home(11, { schemaVersion: 6,
      actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: false } } } });
    const focused = await home(99, { schemaVersion: 6,
      actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: true } } } });
    const ownerServerId = configuration.activeServerId;
    let credentialsCurrent = true;
    // This is the qualified on-disk credential boundary, not an alternate Account owner.
    vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockImplementation(async serverId =>
      serverId === ownerServerId && credentialsCurrent ? ownerCredentials : null);
    await runWithServerHttpBaseUrl(owner.url, async () => {
      const client = new ApiMachineClient(ownerCredentials.token, { id: 'daemon-owner-machine', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      const registration = client.setRPCHandlers({
        spawnSession: async () => { throw new Error('Unexpected Session spawn'); },
        stopSession: async () => { throw new Error('Unexpected Session stop'); },
        requestShutdown: () => { throw new Error('Unexpected daemon shutdown'); },
      });
      const rpc: unknown = Reflect.get(client, 'rpcHandlerManager');
      if (!(rpc instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
      try {
        await runWithServerHttpBaseUrl(focused.url, async () => {
          setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
            settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(focusedCredentials),
            acpCatalog: { status: 'ready', revision: 99, record: { v: 1, definitions: [] } } });
          const incumbent = getActiveAccountSettingsSnapshot();
          const incumbentLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
          const request = ExecutionRunStartRequestSchema.parse({
            intent: 'plan', backendTarget: { kind: 'backend', backendId: 'not-installed-owner-agent',
              configuredBackendId: 'not-installed-owner-agent', sourceKind: 'configured' },
            instructions: 'Read the project and return a plan.', permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
          });
          // Trusted daemon-local dispatch enters the same registered Action owner;
          // a wire Machine call additionally requires Home machine admission.
          const result = await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, request,
            { verifiedPeerAuthority: 'account_automation' });
          expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
          expect(owner.requests).toEqual(expect.arrayContaining([{ method: 'GET', path: '/v2/account/settings',
            authorization: `Bearer ${ownerCredentials.token}`, settingsResponse: owner.settingsResponse }]));
          expect(focused.requests).toEqual([]);
          expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
          expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(incumbentLifetime);
          credentialsCurrent = false;
          const ownerRequestCount = owner.requests.length;
          await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, request,
            { verifiedPeerAuthority: 'account_automation' })).resolves.toMatchObject({ ok: false,
              errorCode: 'provider_authorization_changed', details: { executionRunStart: { runCreation: 'noRunCreated' } } });
          expect(owner.requests).toHaveLength(ownerRequestCount);
          expect(focused.requests).toEqual([]);
        });
      } finally {
        await registration.dispose();
        await client.shutdown();
      }
    });
  });

  it.each([false, true])('reads the captured owner Home and its policy for a public plan start without publishing into the focused Account (disabled=%s)', async disabled => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_TTL_MS', '0');
    vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'execution.runs');
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
    expect(resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state).toBe('enabled');
    const ownerCredentials = { token: accountToken('session-owner-account'), encryption: null } as const;
    const focusedCredentials = { token: accountToken('unrelated-focused-account'), encryption: null } as const;
    expect(readAccountIdFromToken(ownerCredentials.token)).toBe('session-owner-account');
    expect(readAccountIdFromToken(focusedCredentials.token)).toBe('unrelated-focused-account');
    const owner = await home(11, { schemaVersion: 6, mcpServersStrictMode: true,
      actionsSettingsV1: { v: 1, actions: { 'execution.run.start': { enabled: !disabled } } } });
    if (owner.settingsResponse.content?.t !== 'plain') throw new Error('Expected plain owner Settings');
    expect(accountSettingsParse(owner.settingsResponse.content.v).actionsSettingsV1.actions['execution.run.start']?.enabled).toBe(!disabled);
    const focused = await home(99, { schemaVersion: 6, mcpServersStrictMode: false });
    await withTempDir('happier-session-owner-home-', async directory => {
      await runWithServerHttpBaseUrl(focused.url, async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ mcpServersStrictMode: false }),
          rawSettings: { mcpServersStrictMode: false }, settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
          scopeKey: resolveAccountSettingsScopeKey(focusedCredentials),
          acpCatalog: { status: 'ready', revision: 99, record: { v: 1, definitions: [] } } });
        const incumbent = getActiveAccountSettingsSnapshot();
        const incumbentLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const sessionId = 'foreign-home-session';
        const metadata = createTestMetadata({ path: directory, machineId: 'session-machine' });
        const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
        // These are the Session's durable transcript/network ports, not replacements
        // for its Settings getter, RPC dispatcher, engine registry or catalog services.
        const unexpectedTranscriptWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
        const registration = registerSessionClientRuntimeHandlers({
          rpcHandlerManager: rpc, token: ownerCredentials.token,
          serverId: 'session-owner-home', serverUrl: owner.url,
          readOwnerAccountCredentials: async () => ownerCredentials,
          metadataPath: directory, metadata, sessionId, getSessionMetadata: () => metadata,
          enqueueSessionUserMessage: unexpectedTranscriptWrite,
          enqueueUserTextMessageCommitted: unexpectedTranscriptWrite,
          enqueueAgentMessageCommitted: unexpectedTranscriptWrite,
          enqueueVoiceAgentTranscriptTurnCommitted: unexpectedTranscriptWrite,
          sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
          getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
          persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
        });
        try {
          expect(rpc.hasHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START)).toBe(true);
          const request = ExecutionRunStartRequestSchema.parse({
            intent: 'plan', backendTarget: { kind: 'backend', backendId: 'not-installed-owner-agent',
              configuredBackendId: 'not-installed-owner-agent', sourceKind: 'configured' },
            instructions: 'Read the project and return a plan.', permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
          });
          // The transported request supplies no private Action context or Settings.
          // The real handler reads its owner before the later unavailable runtime refuses.
          const result: unknown = await rpc.handleRequest({
            method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`, params: request,
            callerAuthority: 'account_automation',
          });
          // Observe the actual boundary response rather than guessing a delay
          // or accepting a missing owner-route witness.
          const expectedErrorCode = disabled ? 'action_disabled' : 'execution_run_contribution_snapshot_unavailable';
          expect(result).toMatchObject({ ok: false, errorCode: expectedErrorCode });
          await Promise.race([owner.settingsRead, focused.settingsRead]);
          expect({ result, ownerRequests: owner.requests, focusedRequests: focused.requests,
            focusedSnapshotUnchanged: getActiveAccountSettingsSnapshot() === incumbent,
            focusedLifetimeUnchanged: getActiveAccountSettingsSnapshotLifetimeToken() === incumbentLifetime,
          }).toMatchObject({
            result: { ok: false, errorCode: expectedErrorCode },
            ownerRequests: expect.arrayContaining([{ method: 'GET', path: '/v2/account/settings',
              authorization: `Bearer ${ownerCredentials.token}`, settingsResponse: owner.settingsResponse }]),
            focusedRequests: [], focusedSnapshotUnchanged: true, focusedLifetimeUnchanged: true,
          });
          expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(99);
        } finally { await registration.dispose(); }
      });
    });
  });
});
