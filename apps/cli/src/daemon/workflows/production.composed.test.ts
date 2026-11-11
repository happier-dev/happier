import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { SessionInputWorkflowV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1, SessionMessageReplyAccountMutationV1Schema,
  SessionMessageReplyReadResultV1Schema, type SessionMessageReplyPublicationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createSocketTransportAdapter, socketRpcCodec } from '@happier-dev/sync-client';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot } from '@/testkit/backends/apiSessionSocketHarness';

const readinessMachineRpc = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
const readinessSockets = vi.hoisted(() => ({ connect: vi.fn() }));
const observationSockets = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('@/api/session/sockets', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/session/sockets')>(),
  createUserScopedSocketConnection: readinessSockets.connect,
  createSessionScopedSocketConnection: observationSockets.connect,
}));
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  API_TOKEN_FULL_GRANT_V1,
  encodePlainArtifactStoredContent,
  AutomationStoredWorkflowDefinitionV2Schema,
  admitAgentStartV1,
  materializeWorkflowAcceptedSnapshotV1,
  formatWorkflowDefinitionRefV1,
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  WORKFLOW_UNSETTLED_INVOCATION_LIFECYCLES_V1,
  openWorkflowProgressStoredEnvelopeV1,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  type WorkflowExecutionCorrespondenceV1,
  type WorkflowProgressEnvelopeV1,
  type WorkflowDefinitionV1,
  type WorkflowMaterializedLeafV1,
  type WorkflowWorkspaceProgressV1,
  type WorkflowWorkspaceCreationIntentV1,
  type WorkflowRunEncryptionV1,
  type WorkflowActionLeafV1,
  deriveWorkflowSessionInputLocalIdV2,
  accountSettingsParse,
  createActionExecutor,
  AutomationRunCauseSchema,
  AutomationTriggerIdSchema,
  deriveAutomationOccurrenceKeyV1,
  deriveWorkflowDestinationsV1,
  ActionIdSchema,
  ActionDefinitionV1Schema,
  createWorkflowAccountRunActionOwner,
  createWorkflowActionExecutor,
  StrictJsonValueSchema,
  getActionSpec,
  FeaturesResponseSchema,
  zodSchemaToJsonSchemaObject,
  SessionInputAuthorityV2Schema,
  WorkflowDiscussionRoundProjectResultV1Schema,
  resolveBuiltinWorkflowDefinitionV1,
  buildBackendTargetKeyV2,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import type { DiscussionPromptContextEntryV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { WorkflowPromptContext } from './workflowPromptContext';
import { observeWorkflowSessionInputResult } from './stepExecution';
import { MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { WorkflowMachineCommandOutputV1Schema } from '@happier-dev/protocol/workflows/stepActionsV1';
import { bindAutomationWorkflowInputs, isWorkflowJsonObject, WorkflowInputResolutionError } from './input';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createStablePluginNotificationsOwner } from '@/plugins/runtime/invocation/services/notifications';
import { resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';

import {
  createProductionWorkflowRunCoordinator,
  createWorkflowRunPushNotificationClient,
  DurableWorkflowCoordinatorStore,
  projectWorkflowTerminalCustodySettlement,
  projectWorkflowRootSettlementLifecycle,
  resolveWorkflowTriggerClaimSource,
  type WorkflowProductionExecutionDeps,
} from './production';
import { executeClaimedRun } from '@/daemon/automation/automationRunExecutor';
import { createAutomationClaimClient } from '@/daemon/automation/automationClaimClient';
import { AutomationV3WorkerFailRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createCredentialedWorkflowMaterializationHostV1 } from '@/session/actions/workflowMaterializationHost';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { resolveAutomationPollingConfig } from '@/daemon/automation/automationScheduler';
import { WORKFLOW_CANCEL_REQUESTED_ABORT_REASON, workflowInvocationKey } from './coordinator';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { createCoordinatorWorkspaceResolver, prepareWorkflowAcceptedWorkspaceTarget } from './resolveWorkflowWorkspace';
import { createProductionWorkflowConversationOwner, createProductionWorkflowSessionStepExecutor, createWorkflowSessionStepExecutor } from './sessionStepExecutor';
import type { WorkflowRunStorageOperation } from './workflowRunStorageClient';
import { createWorkflowRunStorageClient } from './workflowRunStorageClient';
import { createWorkflowOriginContextInputPort } from '@/agent/runtime/session/contextOnly/workflowOriginInput';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createHostApprovalOriginCurrentness } from '@/session/actions/approvals/hostOriginCurrentness';

import { buildWorkflowActionContext, resolveWorkflowSessionConversation, createWorkflowAcceptedAuthorizationCurrentness } from './daemonRuntime';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { DiscussionAgentPostResponseV1Schema } from '@happier-dev/protocol/discussions/api';

const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const accountId = 'account-1';
const machineId = 'machine-1';
// These custom HTTP boundaries never publish asynchronous changes. Control
// journeys use the shared storage testkit's notifying subscription instead.
const quietStorageChanges = () => ({ dispose: async () => {} });
const now = '2026-01-01T00:00:00.000Z';
beforeEach(() => {
  // Only network and process launch are faked; the new existing-Session
  // readiness owner executes beneath these boundaries before input admission.
  let readySessionId = '';
  readinessSockets.connect.mockImplementation(() => {
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      // The receiver is the Socket.IO boundary; exact target/currentness and
      // wire correlation remain owned by the real Machine RPC client.
      const call = payload as { method: string; params: unknown };
      const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, call.params, call.method);
      const result = await readinessMachineRpc.callMachineRpc({
        method: call.method.slice(`${machineId}:`.length), request: decoded.params,
      });
      return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId) };
    } });
    return { socket, transport: createSocketTransportAdapter(socket) };
  });
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    } };
    if (url.endsWith(`/v1/machines/${machineId}`)) return { status: 200, data: {
      machine: { ...createAvailableSessionSpawnMachineSnapshot(machineId), storageMode: 'plain' },
    } };
    const id = /\/v2\/sessions\/([^/?]+)/.exec(url)?.[1];
    if (!id) throw new Error(`Unexpected readiness read: ${url}`);
    return { status: 200, data: { session: createSessionRecordFixture({ id, active: true,
      encryptionMode: 'plain', machineId, metadata: JSON.stringify({ machineId, path: '/repo',
        claudeSessionId: 'native-session', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
      }) }) } };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
    if (!url.endsWith('/v2/sessions/lookup-by-tags')) throw new Error(`Unexpected readiness write: ${url}`);
    const request = body as { tags: string[] };
    const response = await axios.get(`/v2/sessions/${request.tags[0]}`);
    return { status: 200, data: { sessions: [response.data.session] } };
  });
  readinessMachineRpc.callMachineRpc.mockImplementation(async ({ method, request }: { method: string; request: { sessionId?: string } }) => {
    if (method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
      readySessionId = request.sessionId!;
      return { type: 'success', sessionId: readySessionId };
    }
    return { status: 'success', sessionId: readySessionId };
  });
});
afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.unstubAllGlobals(); });
const availability = { pause: true, resumeBoundary: false,
    restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] };
/** The canonical definition requires at least one block, so fixtures cannot use an empty program. */
const onlyStep = {
  kind: 'step' as const, id: 'work', document: { text: 'work', references: [], attachments: [] },
  input: [], result: { kind: 'text' as const },
};

it.each(['manual', 'schedule', 'event', 'channel'] as const)('retains the trigger requester through contained approval and Resume (%s)', async cause => {
  const directory = process.cwd();
  let approval: ApprovalRequestV2 | undefined;
  let effects = 0;
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    isApprovalExecutionOriginCurrent: createHostApprovalOriginCurrentness({
      credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null },
      serverId: 'server-1', serverApiUrl: 'https://home.example.test',
      resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } }) }),
    }),
    machinesList: async () => { effects++; return { items: [] }; },
    approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'contained-approval' }; },
    approvalsGet: async () => approval ?? null,
    approvalsUpdate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
  });
  const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId,
    origin: { kind: 'automation', automationId: 'automation-1' } });
  const coordinate = () => createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId,
    workspaceScm: { inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation' }),
    resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    isAcceptedAuthorizationCurrent: async () => true, onCommittedTransition: () => {}, storage,
    resolveMaterializationHost: async input => ({ ...await productionMaterializationHost(input), effects: {
      resolveTargetAvailability: async () => true,
      readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))),
    } }),
    prepareAcceptedWorkspaceTarget: async () => ({ ok: true, workspaceTarget: {
      project: { machineId, directory, checkoutRootPath: directory } } }),
    execution: { ...productionExecution(), serverIdentityId: 'srv_home', action: { executor,
      buildContext: async input => ({ ...buildWorkflowActionContext(input), serverId: 'server-1', serverIdentityId: 'srv_home',
        runtimeAccountId: accountId, sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 }),
      observeRun: async () => { throw new Error('Listing has no execution Run'); } } },
  });
  const triggerId = AutomationTriggerIdSchema.parse('11111111-1111-4111-8111-111111111111');
  const occurrenceKey = deriveAutomationOccurrenceKeyV1({ triggerId, evidence: { v: 1, kind: 'sessionLifecycle',
    event: 'parentTurnCompleted', sourceSessionId: 'source-session', sourceTurnId: 'turn-1', occurredAt: 1 } });
  const automationCause = AutomationRunCauseSchema.parse(cause === 'manual' ? { kind: 'manual', invokedAt: 1 }
    : cause === 'channel' ? { kind: 'conversation', occurrenceKey, occurredAt: 1 }
    : cause === 'schedule' ? { kind: 'trigger', triggerKind: 'schedule', triggerId: '11111111-1111-4111-8111-111111111111',
      triggerRevision: 1, occurredAt: 1, evidence: { scheduledFor: 1 }, occurrenceKey }
    : { kind: 'trigger', triggerKind: 'sessionLifecycle', triggerId: '11111111-1111-4111-8111-111111111111',
      triggerRevision: 1, occurrenceKey, occurredAt: 1, evidence: { sourceSessionId: 'source-session',
        sourceTurnId: 'turn-1', event: 'parentTurnCompleted', policy: { kind: 'currentTurn' } } });
  const claim = { runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1', automationCause,
    ...(cause === 'channel' ? { automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: {} }) } : {}),
    causeWorkDepth: 0, accountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
    definitionEnvelope: JSON.stringify({ t: 'plain', v: { inlineDefinition: { version: 1, inputs: [], defaults: {},
      blocks: [{ kind: 'action', id: 'list', actionId: 'machines.list', input: {} }] },
      approvalProfileId: 'builtin:read-propose', workspace: { directory }, executionTarget: { kind: 'session' } } }) };
  expect(await coordinate()(claim)).toMatchObject({ state: 'paused', reason: 'approval_required' });
  expect(storage.rows().some(row => row.index.lifecycle === 'waiting_for_approval')).toBe(true);
  expect(approval).toMatchObject({ status: 'open', executionOriginV1: { caller: { kind: 'workflowRun', authenticatedStarterV1: {
    requestRef: runId, requester: { serverId: 'srv_home', accountId } } } } });
  expect(effects).toBe(0);
  const decision = await executor.execute('approval.request.decide', { artifactId: 'contained-approval', decision: 'approve' }, {
    surface: 'ui', authority: 'present_user', runtimeAccountId: accountId, serverId: 'server-1', serverIdentityId: 'srv_home',
  });
  expect(decision.ok, JSON.stringify(decision)).toBe(true);
  expect(approval?.status).toBe('executed');
  expect(await coordinate()({ runId, attempt: 0, expectedRevision: storage.run().revision,
    accountCurrentness: claim.accountCurrentness, acceptedEnvelope: storage.acceptedEnvelope()! })).toMatchObject({ state: 'succeeded' });
  expect(effects).toBe(1);
});

function readPromptContext(text: string): WorkflowPromptContext[] {
  const entries: DiscussionPromptContextEntryV1[] = text.split('\n')
    .filter(line => line.startsWith('{"author":') || line.startsWith('{"kind":"host_reference_metadata"'))
    .map(line => JSON.parse(line.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')));
  return entries.flatMap((entry, index) => {
    if (!('author' in entry)) return [];
    const metadata = entries[index - 1];
    expect(metadata).toMatchObject({ kind: 'host_reference_metadata' });
    return [{ ...JSON.parse(metadata!.text), author: entry.author, value: JSON.parse(entry.text) }];
  });
}

function productionExecution(
  sessionInput?: NonNullable<WorkflowProductionExecutionDeps['sessionInput']>,
): WorkflowProductionExecutionDeps {
  const actionExecutor = { execute: vi.fn(async () => ({ ok: false as const, errorCode: 'unused' })) };
  return {
    credentials: { token: 'token', encryption: null },
    serverId: 'server-1',

    machineAdmissionTransport: vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' })),
    resolveExistingSessionConversation: async () => ({ sessionId: 'session-1', machineId, directory: '/repo' }),
    ...(sessionInput ? { sessionInput } : {}),
    detachedRun: {
      actionExecutor: actionExecutor as never,
      buildActionContext: () => ({ surface: 'agent' as const, authority: 'account_automation' as const }),
    },
  };
}

// Opened Account policy and exact-Machine availability are external boundaries;
// both admission owners and ORC policy remain real underneath this fixture.
const productionMaterializationHost: NonNullable<Parameters<typeof createProductionWorkflowRunCoordinator>[0]['resolveMaterializationHost']> = async ({ runId, workDepth, directory }) => ({
  effects: { resolveTargetAvailability: async () => true },
  admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, {
    caller: { kind: 'originless', runId, runDepth: workDepth }, baseline: { machineId, directory },
    ledSubtreeSessionIds: [], roles: facts.role ? { [facts.role.roleId]: facts.role } : {},
    workDepthLimit: 4, callerPermissionCeiling: facts.permissionCeiling,
  }),
});

async function commandOutputAdmissionFixture(mode: 'plain' | 'e2ee', fault?: 'result_ack_lost' | 'admission_ack_lost', memberOrdinal = '0',
  actionId: 'machines.command.run' | 'machines.services.exec' = 'machines.command.run') {
  const rootId = 'root-command-output';
  const runDataKey = new Uint8Array(32).fill(7);
  const encryption: WorkflowRunEncryptionV1 = { witness: { mode, version: 1,
    contentKeyFingerprint: mode === 'plain' ? null : 'a'.repeat(64) },
    runCrypto: mode === 'plain' ? { mode } : { mode, runDataKey } };
  const sealMode = mode === 'plain' ? { mode: 'plain' as const }
    : { mode: 'e2ee' as const, runDataKey, randomBytes: (length: number) => new Uint8Array(length).fill(3) };
  const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...sealMode,
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
      sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
      blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } }));
  const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
  await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
    rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
  let lostAck = false;
  const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
    rootRecordId: rootId, revision: boundary.run().revision, encryption,
    checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
    storage: { execute: async operation => {
      const result = await boundary.execute(operation);
      // A real storage write followed by a lost HTTP response is a system boundary fault.
      if (fault === 'result_ack_lost' && !lostAck && operation.operation === 'invocations.fact' && operation.lifecycle === 'completed') {
        lostAck = true;
        throw new Error('result_ack_lost');
      }
      if (fault === 'admission_ack_lost' && operation.operation === 'invocations.fact' && operation.lifecycle === 'admitting') {
        throw new WorkflowInputResolutionError('workflow_input_too_large');
      }
      return result;
    } } });
  const key = workflowInvocationKey({ runId, blockId: 'command', scope: [], attempt: 0 });
  const intent = await store.ensureIntent({ key, recordId: 'command-leaf', runId, blockId: 'command', path: { blockId: 'command', scope: [] },
    blockKind: 'action', memberOrdinal, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
  const row = boundary.rowById(intent.recordId)!;
  const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId,
    recordId: row.index.id, sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
    memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt };
  const input = actionId === 'machines.command.run' ? { command: 'fixed command' }
    : { serverId: 'home', machineId, target: { kind: 'current', serviceId: 'service', expectedGeneration: 'generation' },
      mode: 'exec', argv: ['tool', 'fixed-argument'] };
  const execution = { kind: 'action' as const, actionId, actionRequestId: 'command-request',
    localInputId: 'command-request', input };
  return { store, boundary, key, intent, binding, execution, sealMode, rootId, encryption,
    open: () => openWorkflowProgressStoredEnvelopeV1({ ...encryption.runCrypto, binding,
      envelope: parseWorkflowStoredContentEnvelopeV1(boundary.rowById(intent.recordId)!.contentEnvelope) }) };
}

describe('production workflow coordinator', () => {
  it('materializes an explicitly selected model worktree before fresh Session creation', async () => {
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const authored: WorkflowDefinitionV1 = { version: 1, defaults: {}, inputs: [{ name: 'chosen', valueType: 'json', required: true,
      inputType: { hostType: 'agentParticipant' } }], blocks: [{ ...onlyStep, execution: {
        participant: { kind: 'input', name: 'chosen' }, workspace: { kind: 'new_worktree', source: { kind: 'original' } },
      } }] };
    const { projectDiscussionModelParticipantLaunchV1 } = await import('@happier-dev/protocol/discussions/participants');
    const launch = projectDiscussionModelParticipantLaunchV1({ executionTarget: { serverId: 'server-1', machineId },
      directory: { kind: 'path', path: '/repo' }, agentTarget });
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored, context: {
      source: { kind: 'inline' }, inputs: { chosen: { kind: 'model', launch } }, machineId, executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' }, originalCommittedRevision: 'a'.repeat(40) },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } },
    }, admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const scmBoundary = new Error('worktree_materialization_reached');
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary,
      execution: productionExecution(),
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      // Stop at the OS SCM boundary: this regression concerns production preparation,
      // before the separately tested Git materialization and Session launch owners.
      workspaceScm: { realizeWorktree: async intent => {
        expect(intent).toMatchObject({ sourceDirectory: '/repo', baseRef: 'a'.repeat(40) });
        throw scmBoundary;
      }, inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).rejects.toBe(scmBoundary);
  });
  it('projects progress from admitted slots without reading future authored slots on startup or facts', async () => {
    const fixture = await commandOutputAdmissionFixture('plain');
    let futureSlotVisits = 0;
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { ...onlyStep, id: 'command' }, ...Array.from({ length: 79 }, (_, i) => ({ ...onlyStep,
        get id() { futureSlotVisits++; return `future-${i}`; } })),
    ] };
    const operations: WorkflowRunStorageOperation[] = [];
    const load = () => DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: fixture.rootId, revision: fixture.boundary.run().revision, encryption: fixture.encryption,
      authoredDefinition: authored, definition: authored,
      destinations: deriveWorkflowDestinationsV1({ definition: authored }).leaves,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: fixture.rootId, nextSequence: '2',
        frontier: { nextBlockOrdinal: 0, paused: false } },
      storage: { execute: async operation => { operations.push(operation); return fixture.boundary.execute(operation); } } });
    const store = await load();
    await store.refreshStepProgress();
    expect(operations.filter(op => op.operation === 'invocations.current')).toHaveLength(0);
    const command = await store.readByLogicalInvocation(fixture.intent.recordId);
    if (!command) throw new Error('missing_command');
    operations.length = 0;
    futureSlotVisits = 0;
    await store.commitFact({ key: command.key, lifecycle: 'completed', result: 'done' });
    expect(operations.filter(op => op.operation === 'invocations.current' || op.operation === 'invocations.list'
      || op.operation === 'invocations.get')).toHaveLength(0);
    expect(futureSlotVisits).toBe(0);
    const progress = () => {
      const row = fixture.boundary.rowById(fixture.rootId)!;
      return openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: fixture.rootId,
          sequence: row.index.sequence, parentRecordId: null, memberOrdinal: '0', attempt: row.index.attempt } });
    };
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 1, skipped: 0, total: 80 } } });
    operations.length = 0;
    const restored = await load();
    await restored.refreshStepProgress();
    expect(operations.filter(op => op.operation === 'invocations.current')).toHaveLength(0);
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 1, skipped: 0, total: 80 } } });
  });

  it.each(['plain', 'e2ee'] as const)('retains the Action failure cause through persisted progress and store reload (%s)', async mode => {
    const fixture = await commandOutputAdmissionFixture(mode);
    const failureCause = { phase: 'machines.command.run', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    const result = { exitCode: -1, stdout: '', stderr: '' };
    await fixture.store.commitFact({ key: fixture.key, lifecycle: 'failed', reason: 'outcome_unknown', failureCause, result });
    expect(fixture.open()).toMatchObject({ kind: 'available', content: { reason: { code: 'outcome_unknown', failureCause }, result } });
    const reloaded = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: fixture.rootId, revision: fixture.boundary.run().revision, encryption: fixture.encryption,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: fixture.rootId, nextSequence: '2',
        frontier: { nextBlockOrdinal: 0, paused: false } }, storage: fixture.boundary });
    expect(await reloaded.readByLogicalInvocation(fixture.intent.recordId)).toMatchObject({ reason: 'outcome_unknown', failureCause, result });
  });
  it.each(['complete', 'boundary_resume', 'boundary_resume_denied', 'stop_during_preparation', 'pause_during_preparation', 'capacity', 'pause_after_first_input'] as const)('releases multiple already-admitted inputs without re-listing their accepted API authority (%s)', async outcome => {
    const controller = new AbortController();
    if (outcome === 'stop_during_preparation' || outcome === 'pause_during_preparation') {
      const read = vi.mocked(axios.get).getMockImplementation()!;
      vi.mocked(axios.get).mockImplementation(async (...args) => {
        const result = await read(...args);
        // Native Session readiness is an HTTP boundary beneath real preparation.
        if (args[0].includes('/v2/sessions/')) {
          if (outcome === 'pause_during_preparation') boundary.requestControl('pause_requested');
          else controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
        }
        return result;
      });
    }
    const credentialId = '8f250f0e-4f31-4f7d-8f68-61638b73b526';
    const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
    const leaves = [{ ...onlyStep, id: 'first' }, { ...onlyStep, id: 'second' }];
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: { kind: 'existing_session', sessionId: 'session-1', machineId },
    }, blocks: outcome === 'capacity' || outcome === 'pause_after_first_input'
      ? [{ kind: 'parallel', id: 'parallel', maxConcurrent: 1, failurePolicy: 'collect_outcomes',
        branches: leaves.map(leaf => ({ id: `branch-${leaf.id}`, blocks: [leaf] })) }] : leaves };
    const admitted = await materializeWorkflowAcceptedSnapshotV1({ definition, context: {
      source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'api', accountId,
        principalId: accountId, credentialId } },
    }, admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!admitted.ok) throw new Error(admitted.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: admitted.snapshot,
    }));
    const resuming = outcome === 'boundary_resume' || outcome === 'boundary_resume_denied';
    const boundary = createWorkflowRunStorageTestkit({ runId, accountId, machineId,
      origin: { kind: 'direct' }, acceptedEnvelope, ...(resuming ? { state: 'paused' } : {}) });
    if (resuming) await boundary.execute({ operation: 'resume', runId, expectedRevision: boundary.run().revision });
    let authorityReads = 0;
    let credentialRevoked = outcome === 'boundary_resume_denied';
    const isAcceptedAuthorizationCurrent = createWorkflowAcceptedAuthorizationCurrentness({ accountId,
      // Account API-token storage is an external service boundary. The real
      // currentness reader and production coordinator remain beneath it.
      listAccountApiTokens: async () => {
        authorityReads += 1;
        if (credentialRevoked) return { tokens: [] };
        return { tokens: [{ tokenId: credentialId, label: 'automation', displayPrefix: 'hap_v1_8f250f0e',
          createdAt: now, lastUsedAt: null, expiresAt: null, hasEncryptionAccess: false,
          hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
          parentTokenId: null, activeChildCount: 0, embedConfig: null }] };
      },
      resolveCurrentPluginOccurrenceId: async () => null,
      isMediatedSourceCurrent: async () => false,
    });
    const inputs: string[] = [];
    const inputControlReads: number[] = [];
    const snapshotReadsAtInput: number[] = [];
    let snapshotReads = 0;
    let pendingInputControlReads: number | null = null;
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: {
      observeChanges: boundary.observeChanges,
      execute: async (operation, options) => {
        const result = await boundary.execute(operation, options);
        if (operation.operation === 'get') snapshotReads++;
        if (operation.operation === 'invocations.fact' && operation.lifecycle === 'admitting') pendingInputControlReads = 0;
        else if (operation.operation === 'get' && pendingInputControlReads !== null) pendingInputControlReads += 1;
        return result;
      },
    },
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'present_user', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness }),
      isAcceptedAuthorizationCurrent,
      execution: productionExecution({ enqueue: async request => {
        inputs.push(request.workflow.invocationRecordId);
        // Revocation affects the next admission; both inputs in this admitted
        // Run retain their frozen principal and finish unless explicitly stopped.
        credentialRevoked = true;
        if (pendingInputControlReads === null) throw new Error('Input bypassed the durable admission boundary');
        inputControlReads.push(pendingInputControlReads);
        snapshotReadsAtInput.push(snapshotReads);
        pendingInputControlReads = null;
        if (outcome === 'pause_after_first_input') boundary.requestControl('pause_requested');
        return { status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) };
      }, observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId,
        result: { kind: 'final_text', text: 'done' } }) }),
      workspaceScm: { inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
      ...(resuming ? { workflowResumeRequestedRevision: boundary.run().revision } : {}),
      acceptedEnvelope, accountCurrentness: witness, signal: controller.signal })).resolves.toMatchObject({
        state: outcome === 'stop_during_preparation' ? 'cancelled'
          : outcome === 'pause_during_preparation' || outcome === 'pause_after_first_input' || outcome === 'boundary_resume_denied' ? 'paused' : 'succeeded',
        ...(outcome === 'boundary_resume_denied' ? { reason: 'run_access_denied' } : {}) });
    expect(inputs).toHaveLength(outcome === 'stop_during_preparation' || outcome === 'pause_during_preparation' || outcome === 'boundary_resume_denied'
      ? 0 : outcome === 'pause_after_first_input' ? 1 : 2);
    expect(new Set(inputs).size).toBe(inputs.length);
    expect.soft(authorityReads).toBe(resuming ? 1 : 0);
    expect.soft(inputControlReads).toEqual(inputs.map(() => 0));
    // Only the initial Run snapshot is needed before releasing the first input;
    // authored capacity visibility is not another control/permission owner.
    if (outcome === 'capacity') expect(snapshotReadsAtInput[0]).toBe(1);
    if (outcome === 'pause_after_first_input') expect(boundary.rowById(inputs[0])?.index.lifecycle).toBe('completed');
  });

  it.each(['healthy', 'network_failure', 'never_answers'] as const)('keeps renewing a claimed Workflow during slow native admission (%s)', async scenario => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(0);
    const leaseLog = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    let releaseNative!: () => void;
    const nativeOpen = new Promise<void>(resolve => { releaseNative = resolve; });
    let nativeEntered = false;
    let currentnessEntered = false;
    const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: { kind: 'existing_session', sessionId: 'session-1', machineId },
    }, blocks: [onlyStep] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const enqueue = vi.fn(async (request: Parameters<NonNullable<WorkflowProductionExecutionDeps['sessionInput']>['enqueue']>[0]) => {
      nativeEntered = true;
      await nativeOpen;
      return { status: 'accepted' as const, localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) };
    });
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => {
        if (nativeEntered) currentnessEntered = true;
        return { kind: 'available', witness };
      },
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution({ enqueue, observe: async ({ sessionId, localId }) => ({
        ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' },
      }) }),
      workspaceScm: { inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    const polling = resolveAutomationPollingConfig(scenario === 'healthy' ? {} : { HAPPIER_AUTOMATION_HEARTBEAT_MS: '5000' });
    let failHeartbeat = false;
    const renewalStarts: number[] = [];
    const renewalBudgets: number[] = [];
    const readinessPost = vi.mocked(axios.post).getMockImplementation()!;
    const heartbeatHttp = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (!url.endsWith('/heartbeat')) return await readinessPost(url, body, config);
      renewalStarts.push(Date.now());
      renewalBudgets.push(config?.timeout ?? 0);
      if (scenario === 'never_answers' || (scenario === 'network_failure' && renewalStarts.length === 1)) {
        // Axios/HTTP is the boundary: a silent server consumes the actual
        // timeout supplied by the real ClaimClient, never a fixture deadline.
        await new Promise((_resolve, reject) => setTimeout(() => reject(
          Object.assign(new Error('HTTP response deadline'), { code: 'ECONNABORTED' }),
        ), scenario === 'network_failure' ? polling.heartbeatMs * 2 : config?.timeout));
      }
      if (failHeartbeat) throw { response: { status: 503, data: { token: 'private-response-token' } } };
      return { status: 200, data: { ok: true, leaseExpiresAt: Date.now() + polling.leaseDurationMs } };
    });
    const claimClient = createAutomationClaimClient({ token: 'private-account-token',
      createPublisherHeader: async () => 'private-publisher-proof' });
    const heartbeatRun = vi.fn(claimClient.heartbeatRun);
    const running = executeClaimedRun({ machineId, coordinateWorkflowRun: coordinate,
      ...polling,
      claimClient: { heartbeatRun, failRun: async () => { throw new Error('unexpected refusal'); } },
      claimed: { protocol: 'v3', automation: null, accountCurrentness: witness,
        run: { id: runId, automationId: null, attempt: 0, revision: 0, leaseExpiresAt: polling.leaseDurationMs,
          origin: { kind: 'direct' }, triggerId: null, workflowAcceptedSnapshotEnvelope: acceptedEnvelope } },
    });
    try {
      // The actual coordinator reaches the machine input boundary before time advances.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(nativeEntered).toBe(true);
      if (scenario !== 'healthy') {
        await vi.advanceTimersByTimeAsync(polling.leaseDurationMs);
        const observations = leaseLog.mock.calls.filter(([message]) => message === '[DAEMON AUTOMATION] Claim lease observation')
          .map(([, observation]) => observation);
        expect(renewalStarts[0]).toBe(5_000);
        expect(renewalBudgets[0]).toBe(polling.leaseDurationMs - renewalStarts[0]);
        if (scenario === 'never_answers') {
          expect(observations).toContainEqual(expect.objectContaining({ event: 'expired', observedAtMs: 30_000,
            leaseExpiresAtMs: 30_000 }));
          expect(renewalStarts.every(start => start < 30_000)).toBe(true);
        } else {
          expect(observations).not.toContainEqual(expect.objectContaining({ event: 'expired' }));
          expect(renewalStarts[1]).toBe(20_000);
        }
        expect(currentnessEntered).toBe(false);
        releaseNative();
        await running;
        // An expired claimant has no authority to publish a parent transition;
        // the server's ordinary reclaim owns the still-running row.
        expect(boundary.run().state).toBe(scenario === 'never_answers' ? 'running' : 'succeeded');
        return;
      }
      const elapsed = polling.leaseDurationMs * 6;
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(currentnessEntered).toBe(false);
      expect(heartbeatRun).toHaveBeenCalledTimes(elapsed / polling.heartbeatMs);
      const leaseRecords = () => leaseLog.mock.calls.filter(([message]) =>
        message === '[DAEMON AUTOMATION] Claim lease observation' || message === '[DAEMON AUTOMATION] Lease renewal transport');
      expect(leaseRecords()).toEqual([]);
      failHeartbeat = true;
      await vi.advanceTimersByTimeAsync(polling.heartbeatMs);
      expect(leaseLog).toHaveBeenCalledWith('[DAEMON AUTOMATION] Claim lease observation',
        expect.objectContaining({ runId, machineId, attempt: 0, event: 'transient_failure',
          renewalTransport: expect.objectContaining({ stage: 'http', publisherProofDurationMs: 0 }) }));
      expect(leaseLog).toHaveBeenCalledWith('[DAEMON AUTOMATION] Lease renewal transport',
        expect.objectContaining({ runId, machineId, attempt: 0, event: 'failure', stage: 'http', status: 503 }));
      expect(JSON.stringify(leaseRecords())).not.toMatch(/private-account-token|private-publisher-proof|private-response-token/);
      failHeartbeat = false;
      await vi.advanceTimersByTimeAsync(polling.heartbeatMs / 2);
      releaseNative();
      await running;
      expect(boundary.run().state).toBe('succeeded');
      expect(enqueue).toHaveBeenCalledOnce();
      expect(leaseLog).toHaveBeenCalledWith('[DAEMON AUTOMATION] Claim lease observation',
        expect.objectContaining({ event: 'stopped', runId, machineId, attempt: 0 }));
    } finally {
      releaseNative();
      await running;
      leaseLog.mockRestore();
      heartbeatHttp.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['none', 'lost_ack', 'denied', 'round_denied_active', 'cancelled_publication_pending', 'cancelled_publication_miswired', 'cancelled_root_publication_pending', 'cancelled_publication_race', 'review', 'review_stable_home', 'round_native_no_outcome', 'round_already_returned', 'round_concurrent', 'round_reclaimed_published'] as const)('materializes authorized Discussion history and repairs lost publication acknowledgements (publication=%s)', async scenario => {
    const publication = scenario !== 'none';
    let publicationAuthorityReads = 0;
    const cancelledPublication = scenario === 'cancelled_publication_pending' || scenario === 'cancelled_publication_miswired'
      || scenario === 'cancelled_root_publication_pending' || scenario === 'cancelled_publication_race';
    const hasReview = scenario === 'review' || scenario === 'review_stable_home';
    const deniedActive = scenario === 'round_denied_active';
    const concurrentRound = scenario === 'round_concurrent' || deniedActive;
    const reclaimedPublished = scenario === 'round_reclaimed_published';
    const expiredClaim = new AbortController();
    const projectsRound = scenario === 'round_native_no_outcome' || scenario === 'round_already_returned' || concurrentRound || reclaimedPublished;
    const participants = (concurrentRound ? ['session-1', 'session-2'] : ['session-1'])
      .map(sessionId => ({ kind: 'session' as const, session: { serverId: 'server-1', sessionId } }));
    const discussion = { serverId: scenario === 'review_stable_home' ? 'srv_workflow_home' : 'server-1', discussionId: 'discussion-1' };
    const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null } as const;
    const step: WorkflowDefinitionV1['blocks'][number] = { ...onlyStep, input: [{ kind: 'discussion_context', scope: 'addressing_message' },
      { kind: 'discussion_context', scope: 'so_far' }] };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: projectsRound ? [{ name: 'participants', valueType: 'json',
      multiple: true, inputType: { hostType: 'agentParticipant' }, required: true }] : [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: { kind: 'existing_session', sessionId: 'session-1', machineId },
    }, blocks: projectsRound ? [{ kind: 'loop', id: 'opinions', repetition: { kind: 'items',
      items: { kind: 'input', name: 'participants', path: [] }, execution: 'parallel', failurePolicy: 'collect_outcomes' },
      body: [{ ...step, execution: { participant: { kind: 'item', field: 'value' } } }] },
      { kind: 'action', id: 'outcomes', actionId: 'workflow.discussion.round.project',
        input: { collections: { kind: 'literal', value: ['opinions'] } } }]
      : [step, ...(hasReview ? [{ ...onlyStep, id: 'review',
        discussionReplyTo: { blockId: 'work', scope: { kind: 'current' as const } },
        input: [{ kind: 'result' as const, producer: { blockId: 'work', scope: { kind: 'current' as const } }, path: [] }] }] : [])] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: projectsRound ? { participants } : {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', discussion: { discussion, messageId: 'question', throughSeq: 2 } },
        ...(publication ? { resultDelivery: { kind: 'originating_discussion' as const, discussion, messageId: 'question', throughSeq: 2 } } : {}),
        authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
      effects: { resolveTargetAvailability: async () => true,
        resolveSessionTarget: async value => {
          const participant = participants.find(candidate => JSON.stringify(candidate.session) === JSON.stringify(value));
          return participant ? { address: participant.session, machineId }
            : projectsRound ? null : { address: participants[0]!.session, machineId };
        },
        readActionContract: async actionId => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(actionId)))),
      } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const reads: { throughSeq?: number; beforeSeq?: number }[] = [];
    const transportRequests: string[] = [];
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true,
      conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId: 'srv_workflow_home' } } });
    vi.stubGlobal('fetch', async () => Response.json(features));
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const wireMessage = (seq: number) => ({ id: seq === 2 ? 'question' : seq === 4 ? 'published-answer' : `message-${seq}`,
      discussionId: discussion.discussionId, localId: `local-${seq}`, seq, authorAccountId: accountId,
      accountActor: { v: 1, accountId, profile: null }, producerV1: seq === 4 ? { v: 1, kind: 'agent', sessionId: 'session-1', runId,
        replyReturn: { serverId: discussion.serverId, requestLocalId: [...admittedInputs.keys()][0], acceptedTurnId: 'accepted-turn',
          workflow: { runId, invocationRecordId: [...admittedInputs.values()][0]!.workflow.invocationRecordId, invocationAttempt: '0' }, outcome: 'answer' } } : null, createdAt: seq,
      content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: seq === 3 ? 'peer sentinel' : `message ${seq}` }] } },
      mentionedAccountIds: [] });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      const url = new URL(String(request.url));
      transportRequests.push(`request ${url.pathname}`);
      if (url.pathname === '/v1/features') return { status: 200, data: features };
      if (url.pathname === '/v1/discussions/discussion-1/participants') return { status: 200, data: {
        discussionId: discussion.discussionId, ownerAccountId: accountId, access: 'owner', grants: [],
        participants: [{ participant: { kind: 'session', sessionId: 'session-1' }, answerPolicy: 'when_addressed', createdAt: 1 }],
      } };
      if (url.pathname === '/v1/discussions/discussion-1') return { status: 200, data: { discussion: {
        id: discussion.discussionId, ownerAccountId: accountId, encryptionMode: 'plain', anchor: null,
        access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'creation',
        titleContent: { t: 'plain', v: { v: 1, title: 'Discussion' } }, messageSeq: 3,
        lastReadSeq: 0, unreadCount: 3, unreadMentionCount: 0, recentAuthorAccountIds: [accountId],
        latestMessage: { id: 'message-3', localId: 'local-3', seq: 3, authorAccountId: accountId,
          accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 3 },
        archivedAt: null, capabilities: { postMessages: true, rename: true,
          archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
      } } };
      if (url.pathname.endsWith('/messages')) {
        const throughSeq = Number(url.searchParams.get('throughSeq') ?? (publishedInputs.size ? 4 : 3));
        const beforeSeq = url.searchParams.has('beforeSeq') ? Number(url.searchParams.get('beforeSeq')) : undefined;
        reads.push({ throughSeq, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
        const seq = Math.min(throughSeq, (beforeSeq ?? throughSeq + 1) - 1);
        return { status: 200, data: { messages: [wireMessage(seq)], messageSeq: throughSeq, hasMoreOlder: seq > 1 } };
      }
      throw new Error(`Unexpected Discussion request: ${url.pathname}`);
    });
    const inputs: string[] = [];
    let workflow: SessionInputWorkflowV2 | undefined;
    let inputLocalId = '';
    const committedPosts = new Map<string, string>();
    const publishedInputs = new Map<string, string>();
    const publicationStates = new Map<string, SessionMessageReplyPublicationV1>();
    const admittedInputs = new Map<string, { workflow: SessionInputWorkflowV2;
      discussion: NonNullable<Parameters<NonNullable<WorkflowProductionExecutionDeps['sessionInput']>['enqueue']>[0]['discussionAddressing']> }>();
    const parents: string[] = [];
    const pendingC2 = new Set(concurrentRound ? ['session-2'] : scenario === 'round_native_no_outcome' || reclaimedPublished ? ['session-1'] : []);
    const observedNative = new Set<string>();
    const observationConnections = new Map<string, ReturnType<typeof createApiSessionSocketStub>[]>();
    observationSockets.connect.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const socket = createApiSessionSocketStub({ connected: true });
      observationConnections.set(sessionId, [...(observationConnections.get(sessionId) ?? []), socket]);
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    const publicationDiagnostics: unknown[] = [];
    vi.spyOn(logger, 'warnLocalFile').mockImplementation((...args) => { publicationDiagnostics.push(args); });
    let denied = false;
    let releaseDeniedSibling = () => {};
    const denialObserved = new Promise<void>(resolve => { releaseDeniedSibling = resolve; });
    const previousGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      transportRequests.push(`get ${url}`);
      if (url.includes('/by-local-id/') && url.endsWith('/reply')) {
        const localId = decodeURIComponent(/\/by-local-id\/([^/]+)\/reply$/.exec(url)![1]!);
        const admitted = admittedInputs.get(localId)!;
        const publicationId = publishedInputs.get(localId) ?? (scenario === 'round_already_returned'
          && observedNative.has(admitted.discussion.participantSessionId) ? 'published-answer' : undefined);
        return { status: 200, data: { v: 1, status: 'available', progress: {
        v: 1, mode: 'wait', workflow: admitted.workflow, acceptedTurnId: 'accepted-turn', disposition: publicationId ? 'returned' : 'observing',
        discussion: admitted.discussion,
        ...(publicationStates.has(localId) ? { returnPublication: publicationStates.get(localId) } : {}),
        ...(!pendingC2.has(admitted.discussion.participantSessionId) ? { outcome: publicationId
          ? { kind: 'answer', publicationRef: { kind: 'discussion', discussion, messageId: publicationId } }
          : { kind: 'answer', result: { sessionId: admitted.discussion.participantSessionId, messageId: 'exact-result' } } } : {}),
      } } };
      }
      if (projectsRound && (url.includes('/messages?') || url.includes('/messages/by-local-id/') || url.endsWith('/turns'))) {
        const sessionId = /\/v[12]\/sessions\/([^/?]+)/.exec(url)?.[1];
        const admitted = [...admittedInputs.entries()].find(([, value]) => value.discussion.participantSessionId === sessionId);
        if (!sessionId || !admitted) throw new Error('Unbound native observation');
        const [localId, source] = admitted;
        const input = { id: `input-${sessionId}`, localId, seq: 1, createdAt: 1, updatedAt: 1,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' }, meta: {
            happierInputAuthorityV1: SessionInputAuthorityV2Schema.parse({ v: 2, producer: 'workflow', caller: { kind: 'host' },
              permission: { admittedPermissionCeiling: 'default', requestedPermissionCeiling: 'default' }, workflow: source.workflow }),
          } } } };
        if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 2, turns: [{
          turnId: 'accepted-turn', status: 'completed', startedAt: 1, updatedAt: 2, initiator: 'workflow', workDepth: 1,
          workflowInvocation: { runId, invocationRecordId: source.workflow.invocationRecordId },
          transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], finalAssistantMessageSeq: 2 },
        }] } };
        if (url.includes('/by-local-id/')) return { status: 200, data: { message: input } };
        const answer = { id: 'exact-result', seq: 2, createdAt: 2, updatedAt: 2, content: { t: 'plain',
          v: buildAcpAgentMessageEnvelope({ provider: 'external-agent', body: { type: 'message', message: 'answer' },
            meta: { runtimeTurnId: 'accepted-turn', runtimeEventKind: 'transcript-message-committed' } }) } };
        // Native completion and original-input C2 settlement are separate
        // committed facts. Deliver the canonical custody wake during this read.
        if (pendingC2.delete(sessionId)) {
          if (reclaimedPublished) {
            // C3 committed the answer while attempt 1 was observing native
            // completion; its lease expires before any terminal Workflow fact.
            publishedInputs.set(localId, 'published-answer');
            committedPosts.set(deriveSessionMessageReplyReturnLocalIdV1({ sessionId, localId, acceptedTurnId: 'accepted-turn' }), 'published-answer');
            expiredClaim.abort(new Error('automation_claim_lease_expired'));
          }
          for (const socket of observationConnections.get(sessionId) ?? []) {
            socket.trigger('ephemeral', { type: 'session-message-reply-pending-v1', v: 1, sessionId, requestLocalId: localId });
          }
        }
        return { status: 200, data: { hasMore: false, messages: [input, answer] } };
      }
      return previousGet(url, config);
    });
    const previousPost = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      if (!url.includes('/by-local-id/') || !url.endsWith('/reply')) return previousPost(url, body, config);
      const mutation = SessionMessageReplyAccountMutationV1Schema.parse(body);
      if (mutation.kind !== 'discussion_publication') throw new Error('Unexpected original return mutation');
      const localId = decodeURIComponent(/\/by-local-id\/([^/]+)\/reply$/.exec(url)![1]!);
      const original = SessionMessageReplyReadResultV1Schema.parse((await axios.get(url)).data);
      if (original.status !== 'available') throw new Error('Missing original return');
      if (original.progress.disposition === 'returned') return { status: 200, data: { v: 1, ok: true, progress: original.progress } };
      publicationStates.set(localId, mutation.publication);
      return { status: 200, data: { v: 1, ok: true, progress: { ...original.progress,
        returnPublication: mutation.publication,
        disposition: mutation.publication.kind === 'failed' && !mutation.publication.failure.retryable ? 'released' : 'return_pending' } } };
    });
    const publishNativeReturn = async (request: import('@happier-dev/protocol/discussions/api').DiscussionAgentPostPublicationV1) => {
      const replyReturn = request.replyReturn;
      if (!replyReturn?.workflow) throw new Error('Expected an accepted Workflow return');
      const publicationInputId = concurrentRound ? replyReturn.requestLocalId : inputLocalId;
      const publicationWorkflow = admittedInputs.get(publicationInputId)!.workflow;
      const publicationSessionId = concurrentRound ? request.sessionId : 'session-1';
      const isReview = hasReview && publicationWorkflow.invocationRecordId !== [...admittedInputs.values()][0]!.workflow.invocationRecordId;
      const expectedParent = isReview ? 'published-answer' : 'question';
      const expectedLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: publicationSessionId, localId: publicationInputId,
        acceptedTurnId: 'accepted-turn' });
      expect(request).toMatchObject({ sessionId: publicationSessionId, discussionId: discussion.discussionId,
        replyReturn: { requestLocalId: publicationInputId, acceptedTurnId: 'accepted-turn', workflow: {
          runId, invocationRecordId: publicationWorkflow.invocationRecordId, invocationAttempt: '0',
        } }, request: { localId: expectedLocalId, replyTarget: { kind: 'message', messageId: expectedParent },
          content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: isReview ? 'reviewed' : 'answer' }] } } } });
      if ((scenario === 'denied' || deniedActive) && !denied) {
        denied = true;
        releaseDeniedSibling();
        return { v: 1, ok: false, error: 'discussion_post_denied' };
      }
      // This is the installed Machine network boundary: the real append owner commits
      // one reply and C2 publicationRef, then its acknowledgement is lost.
      const publicationId = concurrentRound ? `published-${publicationSessionId}` : isReview ? 'published-review' : 'published-answer';
      committedPosts.set(expectedLocalId, publicationId);
      publishedInputs.set(publicationInputId, publicationId);
      parents.push(expectedParent);
      const publicationSeq = concurrentRound ? parents.length + 3 : 4;
      if (scenario === 'denied' || hasReview || projectsRound) return { v: 1, ok: true, value: {
        message: { ...wireMessage(publicationSeq), id: publicationId, localId: expectedLocalId, content: request.request.content,
          producerV1: { v: 1, kind: 'agent', sessionId: publicationSessionId, runId,
            replyReturn: { ...request.replyReturn, outcome: 'answer' } } }, messageSeq: publicationSeq,
      } };
      throw new Error('committed_reply_ack_lost');
    };
    const runOwner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId,
      storage: boundary, definitions: { get: async () => { throw new Error('No mutable definition read'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('Plain keys are absent'); },
    });
    let observing = 0;
    let releaseObservations = () => {};
    const bothObserving = new Promise<void>(resolve => { releaseObservations = resolve; });
    let cancellationRaced = false;
    const coordinate = createProductionWorkflowRunCoordinator({ token: credentials.token, accountId, machineId,
      storage: { ...boundary, execute: async (operation, options) => {
        if (deniedActive && operation.operation === 'transition' && operation.custodyState === 'settled') {
          // Match workflowRunService's real unsettled-index guard. An accepted
          // sibling whose observation failed still owns native input custody.
          const terminal = new Set(['completed', 'failed', 'skipped', 'cancelled', 'outcome_uncertain', 'superseded']);
          const unsettled = new Set<string>(WORKFLOW_UNSETTLED_INVOCATION_LIFECYCLES_V1);
          // This opaque storage boundary receives the public transition packet.
          const transitions = (operation.invocationTransitions ?? []) as ReadonlyArray<Readonly<{ id: string; lifecycle: string }>>;
          const closing = new Set(transitions.filter(row => terminal.has(row.lifecycle)).map(row => row.id));
          if (boundary.rows().some(row => unsettled.has(row.index.lifecycle) && !closing.has(row.index.id))) {
            throw Object.assign(new Error('currentness_conflict'), { response: { status: 409, data: { error: 'currentness_conflict' } } });
          }
        }
        if (scenario === 'cancelled_publication_race' && !cancellationRaced
          && operation.operation === 'invocations.fact' && operation.lifecycle === 'needs_attention') {
          cancellationRaced = true;
          boundary.requestControl('cancel_requested');
        }
        return await boundary.execute(operation, options);
      } },
      execution: { ...productionExecution({ enqueue: async request => {
        inputs.push(request.text);
        workflow = request.workflow;
        inputLocalId = deriveWorkflowSessionInputLocalIdV2(request.workflow);
        admittedInputs.set(inputLocalId, { workflow: request.workflow, discussion: request.discussionAddressing! });
        return { status: 'accepted', localId: inputLocalId };
      }, observe: async ({ sessionId, localId, signal }) => {
        if (concurrentRound) {
          if (++observing === participants.length) releaseObservations();
          await bothObserving;
        }
        if (deniedActive && sessionId === 'session-2') {
          await denialObserved;
          // Let the refused publication finish its already-resolved HTTP
          // settlement before the independent native observation responds.
          await new Promise(resolve => setImmediate(resolve));
          return { ok: false, code: 'session_not_found' };
        }
        if (projectsRound) {
          const observed = await observeWorkflowSessionInputResult({ credentials, sessionId, localId, ...(signal ? { signal } : {}) });
          observedNative.add(sessionId);
          return observed;
        }
        if (cancelledPublication && scenario !== 'cancelled_publication_race') {
          boundary.requestControl('cancel_requested');
          if (scenario === 'cancelled_root_publication_pending') {
            const root = boundary.rows().find(row => row.index.parentRecordId === null)!;
            await boundary.execute({ operation: 'invocations.fact', runId, parentAttempt: 0,
              invocationId: root.index.id, invocationAttempt: root.index.attempt,
              expectedLifecycle: root.index.lifecycle, expectedContentRevision: root.index.contentRevision,
              lifecycle: 'cancelled', contentEnvelope: root.contentEnvelope });
          }
        }
        return { ok: true, sessionId, localId,
          result: { kind: 'final_text', text: hasReview && admittedInputs.size > 1 ? 'reviewed' : 'answer' },
          ...(projectsRound && !(concurrentRound && sessionId === 'session-1') ? {}
            : { replyOutcome: { kind: 'answer' as const, result: { sessionId, messageId: 'exact-result' } } }) };
      } }), credentials,
        ...(concurrentRound ? { resolveExistingSessionConversation: async ({ sessionId }) => ({ sessionId, machineId, directory: '/repo' }) } : {}),
        // Round projection reaches only the Run-scoped Workflow Actions this owner serves.
        ...(projectsRound ? { action: { executor: createActionExecutor({ workflowAction: args =>
          runOwner.execute(args as Parameters<typeof runOwner.execute>[0]) } as ActionExecutorDeps),
          buildContext: async execution => buildWorkflowActionContext(execution),
          observeRun: async () => { throw new Error('Round projection does not launch a Run'); } },
        } : {}),
        ...(scenario === 'cancelled_publication_miswired' ? {} : { postWorkflowMessage: async (publication: Parameters<NonNullable<WorkflowProductionExecutionDeps['postWorkflowMessage']>>[0]) => cancelledPublication
          ? DiscussionAgentPostResponseV1Schema.parse({ v: 1, ok: false, error: 'discussions_unavailable' })
          : 'producer' in publication
          ? DiscussionAgentPostResponseV1Schema.parse({ v: 1, ok: true,
            value: { message: { ...wireMessage(5), content: publication.request.content, producerV1: publication.producer }, messageSeq: 5 } })
          : DiscussionAgentPostResponseV1Schema.parse(await publishNativeReturn(publication)) }),
        ...(scenario === 'review_stable_home' ? { serverIdentityId: 'srv_workflow_home' } : {}) },
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      // Delivering to the frozen origin Discussion is admitted work: no principal re-read.
      isAcceptedAuthorizationCurrent: async () => { publicationAuthorityReads++; return true; },
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      onCommittedTransition: async () => {},
    });
    const claim = { runId, attempt: 0, expectedRevision: 0,
      accountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null }, acceptedEnvelope };
    if (cancelledPublication) {
      await expect(coordinate(claim)).resolves.toMatchObject({ state: 'cancelled' });
      expect(boundary.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'pending' });
      expect(boundary.rows().find(row => row.index.parentRecordId === null)?.index.lifecycle).toBe('cancelled');
      expect(boundary.rows().filter(row => row.index.parentRecordId !== null).map(row => row.index.lifecycle)).toEqual(['completed']);
      expect(inputs).toHaveLength(1);
      expect(committedPosts.size).toBe(0);
      if (scenario === 'cancelled_root_publication_pending') {
        const root = boundary.rows().find(row => row.index.parentRecordId === null)!;
        const terminalContent = root.contentEnvelope;
        const beforeReclaim = boundary.calls.length;
        await expect(coordinate({ ...claim, attempt: 1, expectedRevision: boundary.run().revision }))
          .resolves.toMatchObject({ state: 'cancelled' });
        expect(boundary.rowById(root.index.id)?.contentEnvelope).toBe(terminalContent);
        expect(boundary.calls.slice(beforeReclaim).filter(operation => operation.operation === 'invocations.fact'
          && operation.invocationId === root.index.id)).toEqual([]);
        expect(boundary.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'pending' });
        expect(inputs).toHaveLength(1);
      }
      return;
    } else if (deniedActive) {
      expect(await coordinate(claim)).toMatchObject({ state: 'failed', reason: 'discussion_post_denied' });
      expect(denied).toBe(true);
      expect(boundary.run()).toMatchObject({ state: 'failed', workflowCustodyState: 'pending' });
      expect(boundary.rows().find(row => row.index.parentRecordId === null)?.index.lifecycle).toBe('failed');
      expect(boundary.rows().filter(row => row.index.lifecycle === 'completed')).toHaveLength(1);
      const sibling = [...admittedInputs.values()].find(value => value.discussion.participantSessionId === 'session-2');
      if (!sibling) throw new Error('Missing accepted sibling input');
      const active = boundary.rowById(sibling.workflow.invocationRecordId);
      expect(active).toBeDefined();
      if (!active) throw new Error('Missing retained accepted sibling');
      expect(active.index.lifecycle).toBe('needs_attention');
      expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'invocation_progress',
        accountId, runId, recordId: active.index.id, sequence: active.index.sequence, parentRecordId: active.index.parentRecordId,
        memberOrdinal: active.index.memberOrdinal, attempt: active.index.attempt },
        envelope: parseWorkflowStoredContentEnvelopeV1(active.contentEnvelope) })).toMatchObject({ kind: 'available',
        content: { execution: { kind: 'session', sessionId: 'session-2', localInputId: expect.any(String) } } });
      expect(inputs).toHaveLength(2);
      expect(committedPosts.size).toBe(0);
      return;
    } else if (scenario === 'denied') {
      expect(await coordinate(claim)).toMatchObject({ state: 'failed', reason: 'discussion_post_denied' });
      expect(boundary.run()).toMatchObject({ state: 'failed', workflowCustodyState: 'settled' });
      expect(boundary.rows().some(row => row.index.lifecycle === 'completed')).toBe(true);
      expect(boundary.rows().find(row => row.index.parentRecordId === null)?.index.lifecycle).toBe('failed');
      expect(publicationStates.get(inputLocalId)).toMatchObject({ kind: 'failed',
        failure: { code: 'discussion_post_denied', retryable: false } });
      expect(committedPosts.size).toBe(0);
    } else if (projectsRound) {
      if (reclaimedPublished) {
        await expect(coordinate({ ...claim, attempt: 1, signal: expiredClaim.signal })).rejects.toThrow('runtime_interrupted');
        const leaf = boundary.rows().find(row => row.index.parentRecordId !== null && row.index.lifecycle === 'running');
        expect(leaf).toBeDefined();
        expect(committedPosts.size).toBe(1);
        expect(boundary.rows().filter(row => row.index.lifecycle === 'completed')).toEqual([]);
      }
      const result = await coordinate({ ...claim, ...(reclaimedPublished ? { attempt: 2, expectedRevision: boundary.run().revision } : {}) });
      const opened = await runOwner.execute({ actionId: 'workflow.run.invocations.list',
        input: { runId, includeContent: true }, context: { surface: 'cli' } });
      const details = WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].parse(opened).invocationDetails;
      const answers = details?.filter(row => row.progress.invocationPath.blockId === 'work') ?? [];
      const answer = answers[0];
      expect(answers).toHaveLength(participants.length);
      for (const participant of participants) {
        expect(answers.find(row => row.progress.execution?.kind === 'session'
          && row.progress.execution.sessionId === participant.session.sessionId)?.progress.replyOutcome)
          .toMatchObject({ kind: 'answer' });
      }
      const reply = reclaimedPublished ? { kind: 'answer' as const,
        publicationRef: { kind: 'discussion' as const, discussion, messageId: 'published-answer' } }
        : { kind: 'answer' as const, result: { sessionId: 'session-1', messageId: 'exact-result' } };
      expect(answer?.progress.replyOutcome).toEqual(reply);
      expect(answer?.index.lifecycle).toBe('completed');
      expect(answer?.progress.result).toBe('answer');
      expect(result).toMatchObject({ state: 'succeeded' });
      const projection = WorkflowDiscussionRoundProjectResultV1Schema.parse(details?.find(row => row.progress.invocationPath.blockId === 'outcomes')?.progress.result);
      expect(projection).toMatchObject({ allPassed: false, nextParticipants: expect.arrayContaining(participants),
        outcomeReferences: expect.arrayContaining(participants.map(participant => ({ runId,
          invocationRecordId: answers.find(row => row.progress.execution?.kind === 'session'
            && row.progress.execution.sessionId === participant.session.sessionId)!.index.id,
          participant, kind: 'answer', executionSessionId: participant.session.sessionId, result: 'answer',
          reply: reclaimedPublished ? reply : { kind: 'answer', result: { sessionId: participant.session.sessionId, messageId: 'exact-result' } },
        }))) });
      expect(projection.nextParticipants).toHaveLength(participants.length);
      expect(projection.outcomeReferences).toHaveLength(participants.length);
      expect(parents).toEqual(scenario === 'round_already_returned' || reclaimedPublished ? [] : participants.map(() => 'question'));
    } else if (hasReview) {
      expect(await coordinate(claim)).toMatchObject({ state: 'succeeded' });
      expect(parents).toEqual(['question', 'published-answer']);
      expect(committedPosts.size).toBe(2);
      const openedRows = boundary.rows().map(row => openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
          sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
          memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt },
        envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) }));
      const review = openedRows.find(row => row.kind === 'available' && row.content.invocationPath.blockId === 'review');
      expect(review).toMatchObject({ kind: 'available', content: { discussionReplyTo: {
        discussion, messageId: 'published-answer', throughSeq: 4,
      } } });
      if (review?.kind !== 'available') throw new Error('review_progress_unavailable');
      expect(review.content.input).not.toHaveProperty('discussionReplyTo');
    } else if (publication) {
      expect(await coordinate(claim)).toMatchObject({ state: 'succeeded' });
      expect(boundary.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
      expect(boundary.rows().some(row => row.index.lifecycle === 'completed')).toBe(true);
      expect(committedPosts.size, JSON.stringify({ publicationDiagnostics, transportRequests })).toBe(1);
    } else expect(await coordinate(claim)).toMatchObject({ state: 'succeeded' });
    expect(inputs).toHaveLength(hasReview ? 2 : participants.length);
    const values = readPromptContext(inputs[0]!);
    const fixed = values.filter(value => value.reference.kind === 'discussion_context' && value.reference.scope === 'addressing_message');
    const current = values.filter(value => value.reference.kind === 'discussion_context' && value.reference.scope === 'so_far');
    expect(fixed.map(value => isWorkflowJsonObject(value.value) ? value.value.id : undefined)).toEqual(['message-1', 'question']);
    expect(fixed.every(value => value.source && isWorkflowJsonObject(value.source) && value.source.throughSeq === 2)).toBe(true);
    expect(JSON.stringify(fixed)).not.toContain('peer sentinel');
    expect(current.map(value => isWorkflowJsonObject(value.value) ? value.value.id : undefined)).toEqual(['message-1', 'question', 'message-3']);
    const previousReads = reads.length;
    if (scenario === 'denied') {
      const root = boundary.rows().find(row => row.index.parentRecordId === null)!;
      const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId,
        storage: boundary, definitions: { get: async () => { throw new Error('No mutable definition read'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('Plain keys are absent'); },
        isAcceptedAuthorizationCurrent: async () => true,
      });
      await expect(owner.execute({
        actionId: 'workflow.run.invocations.retry', context: { surface: 'cli', authority: 'present_user',
          callerPermissionMode: 'yolo', actionCaller: { kind: 'host' }, actionRequestId: 'retry-publication' },
        input: { runId, expectedRevision: boundary.run().revision, invocation: { recordId: root.index.id },
          causalInvocationIds: [root.index.id], conversation: 'fresh_agent',
          input: { kind: 'original' } },
      })).rejects.toMatchObject({ code: 'ineligible_state' });
      expect(boundary.rows().find(row => row.index.id === workflow!.invocationRecordId)?.index).toMatchObject({
        attempt: '0', lifecycle: 'completed',
      });
      expect(inputs).toHaveLength(1);
      expect(reads).toHaveLength(previousReads);
      return;
    }
    expect(await coordinate({ ...claim, expectedRevision: boundary.run().revision })).toMatchObject({ state: 'succeeded' });
    expect(inputs).toHaveLength(hasReview ? 2 : participants.length);
    expect(reads).toHaveLength(previousReads);
    expect(publicationAuthorityReads).toBe(0);
  });
  it.each([
    { status: 500, committed: false, recordingAvailable: true, settlement: false },
    { status: 500, committed: true, recordingAvailable: true, settlement: false },
    { status: 503, committed: false, recordingAvailable: true, settlement: false },
    { status: 503, committed: false, recordingAvailable: true, settlement: false, debate: true },
    { status: 503, committed: false, recordingAvailable: true, settlement: false, cancelAtAttention: true },
    { status: 500, committed: false, recordingAvailable: false, settlement: false },
    { status: 500, committed: true, recordingAvailable: true, settlement: true },
  ])('retains a readable recoverable storage cause after HTTP $status (committed=$committed, recording=$recordingAvailable, settlement=$settlement, cancel=$cancelAtAttention, debate=$debate)', async ({ status, committed, recordingAvailable, settlement, cancelAtAttention = false, debate = false }) => {
    const definition: WorkflowDefinitionV1 = debate ? resolveBuiltinWorkflowDefinitionV1('debate')!.definition : { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.external-test', localId: 'external' } },
      conversation: { kind: 'existing_session', sessionId: 'session-1', machineId },
    }, blocks: [onlyStep, { kind: 'parallel', id: 'together', failurePolicy: 'fail_stop', branches: [
      { id: 'first', blocks: [{ ...onlyStep, id: 'alpha' }] },
      { id: 'second', blocks: [{ ...onlyStep, id: 'beta' }] },
    ] }] };
    const inputsForAdmission = debate ? bindAutomationWorkflowInputs({ definition, evidence: { question: 'Prefer tea or coffee?', rounds: 1,
      participants: [{ kind: 'model', launch: { executionTarget: { serverId: 'server-1', machineId },
        directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        modelSelection: { v: 1, updatedAt: 0, ref: { agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }), providerConnectionId: null, modelId: 'gpt-6-luna' } },
        configuration: { options: { reasoning_effort: { value: 'low', updatedAtMs: 0 } } },
      } }],
    } }) : {};
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: inputsForAdmission, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => {
          const parsed = ActionIdSchema.safeParse(id);
          return parsed.success ? freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(parsed.data))) : null;
        },
      } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const openProgress = (row: ReturnType<typeof boundary.rows>[number]) => openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
        sequence: row.index.sequence, parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
    let faulted = false;
    const storageFailure = Object.assign(new Error('Request failed with status code ' + status), {
      isAxiosError: true, code: 'ERR_BAD_RESPONSE', response: { status, data: { error: status === 503 ? 'database_transaction_timeout' : 'Internal Server Error' } },
    });
    const originalPost = vi.mocked(axios.post).getMockImplementation()!;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown, config) => {
      if (!url.endsWith('/v3/automations/runs/workflow-storage')) return await originalPost(url, body, config);
      if (faulted && !recordingAvailable) throw storageFailure;
      const operation = body as WorkflowRunStorageOperation;
      if (faulted && cancelAtAttention && operation.operation === 'invocations.fact' && operation.lifecycle === 'needs_attention') {
        boundary.requestControl('cancel_requested');
      }
      const candidates = operation.operation === 'invocations.admit'
        ? operation.invocations as readonly { id: string; sequence: string; parentRecordId: string; memberOrdinal: string; contentEnvelope: string }[] : [];
      const beta = candidates.some(candidate => {
        const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(candidate.contentEnvelope),
          binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: candidate.id, sequence: candidate.sequence,
            parentRecordId: candidate.parentRecordId, memberOrdinal: candidate.memberOrdinal, attempt: '0' } });
        return opened.kind === 'available' && opened.content.invocationPath.blockId === (debate ? 'context' : 'beta');
      });
      if (!faulted && (settlement ? operation.operation === 'transition' && operation.state === 'succeeded' : beta)) {
        faulted = true;
        if (committed) await boundary.execute(operation);
        throw storageFailure;
      }
      return { status: 200, data: await boundary.execute(operation) };
    });
    const storage = createWorkflowRunStorageClient({ token: 'token', machineId, serverHttpBaseUrl: 'https://home.test',
      createPublisherHeader: async () => 'signed-publisher' });
    const inputs: string[] = [];
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage,
      execution: productionExecution({
        enqueue: async request => {
          const localId = deriveWorkflowSessionInputLocalIdV2(request.workflow);
          inputs.push(localId);
          return { status: 'accepted', localId };
        },
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }),
      }),
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    const outcome = coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    if (cancelAtAttention) await expect(outcome).resolves.toMatchObject({ state: 'cancelled' });
    else if (settlement) await expect(outcome).resolves.toMatchObject({ state: 'succeeded' });
    else if (recordingAvailable) await expect(outcome).resolves.toMatchObject({ state: 'interrupted', reason: 'storage_unavailable' });
    else await expect(outcome).rejects.toBe(storageFailure);
    expect(faulted).toBe(true);
    expect(boundary.run()).toMatchObject({ state: cancelAtAttention ? 'cancelled' : settlement ? 'succeeded' : recordingAvailable ? 'interrupted' : 'running',
      workflowCustodyState: settlement ? 'settled' : 'pending' });
    if (cancelAtAttention) expect(boundary.rows().some(row => row.index.parentRecordId !== null
      && (row.index.lifecycle === 'cancel_requested' || row.index.lifecycle === 'outcome_uncertain'))).toBe(true);
    const root = boundary.rows().find(row => row.index.parentRecordId === null)!;
    expect(root.index.lifecycle).toBe(cancelAtAttention ? 'cancelled' : settlement ? 'completed' : recordingAvailable ? 'needs_attention' : 'running');
    const opened = openProgress(root);
    if (recordingAvailable && !settlement && !cancelAtAttention) expect(opened).toMatchObject({ kind: 'available', content: { reason: {
      code: 'storage_unavailable', message: expect.any(String),
    } } });
    else expect(opened).toMatchObject({ kind: 'available', content: expect.not.objectContaining({ reason: expect.anything() }) });
    if (recordingAvailable && !settlement && !cancelAtAttention) {
      const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId,
        storage: boundary, definitions: { get: async () => { throw new Error('must_not_read_mutable_definition'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
        randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
      });
      const readable = WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(await reader.execute({
        actionId: 'workflow.run.invocations.get', input: { runId, invocationId: root.index.id }, context: {},
      }));
      expect(readable.invocation.progress.reason).toMatchObject({ code: 'storage_unavailable', message: expect.any(String) });
      if (status === 503) {
        expect(readable.invocation.progress.reason).toMatchObject({ failureCause: {
          phase: 'workflow.storage.invocations.admit', errorCode: 'database_transaction_timeout', httpStatus: 503,
        }, message: expect.stringContaining('database_transaction_timeout') });
      }
    }
    expect(new Set(inputs).size).toBe(inputs.length);
    const completedPredecessor = boundary.rows().filter(row => {
      const progress = openProgress(row);
      return row.index.lifecycle === 'completed' && progress.kind === 'available' && progress.content.invocationPath.blockId === 'work';
    });
    expect(completedPredecessor).toHaveLength(debate ? 0 : 1);
    const betaRows = boundary.rows().filter(row => {
      const progress = openProgress(row);
      return progress.kind === 'available' && progress.content.invocationPath.blockId === 'beta';
    });
    expect(betaRows).toHaveLength(Number(committed));
  });

  it.each([{ mode: 'plain', pending: undefined }, { mode: 'e2ee', pending: undefined },
    { mode: 'plain', pending: true }, { mode: 'plain', pending: false }] as const)(
    'retains evaluated quiet provenance on the real durable root ($mode, pending=$pending)', async ({ mode, pending }) => {
    const rootId = 'condition-root';
    const runDataKey = new Uint8Array(32).fill(7);
    const encryption: WorkflowRunEncryptionV1 = { witness: { mode, version: 1,
      contentKeyFingerprint: mode === 'plain' ? null : 'a'.repeat(64) },
      runCrypto: mode === 'plain' ? { mode } : { mode, runDataKey } };
    const sealMode = mode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const, runDataKey, randomBytes: (length: number) => new Uint8Array(length).fill(3) };
    const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId: rootId,
      sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        ...sealMode, binding, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root',
          invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId },
      })) } });
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
    let holdControlRead = false;
    let releaseControl = () => {};
    const controlGate = new Promise<void>(resolve => { releaseControl = resolve; });
    let controlReadStarted = () => {};
    const controlStarted = new Promise<void>(resolve => { controlReadStarted = resolve; });
    let sourceCompleted = () => {};
    const sourceCommitted = new Promise<void>(resolve => { sourceCompleted = resolve; });
    // Delay only the real storage boundary. Notification evaluation, root
    // capture, the root queue and membership projection remain production code.
    const storage = { execute: async (request: Parameters<typeof boundary.execute>[0]) => {
      const response = await boundary.execute(request);
      if (holdControlRead && request.operation === 'get') {
        holdControlRead = false;
        controlReadStarted();
        await controlGate;
      }
      if (request.operation === 'invocations.fact' && request.invocationId !== rootId
        && request.lifecycle === 'completed') sourceCompleted();
      return response;
    } };
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, encryption,
      rootRecordId: rootId, revision: boundary.run().revision, checkpoint, storage });
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    await store.commitFact({ key: rootKey, lifecycle: 'running' });
    if (pending === false) await store.reconcilePublicationApprovalAttention(() => true);
    holdControlRead = pending !== undefined;
    const attention = pending === undefined ? undefined : store.reconcilePublicationApprovalAttention(() => pending);
    if (attention) await controlStarted;
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget: {
      kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: [
      { kind: 'step', id: 'report', document: { text: 'Report', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      { kind: 'action', id: 'notice', actionId: 'notifications.notify_me',
        input: { message: { kind: 'result', producer: { blockId: 'report', scope: { kind: 'current' } }, path: [] } },
        onlyWhen: { kind: 'compare', operator: 'neq',
          left: { kind: 'result', producer: { blockId: 'report', scope: { kind: 'current' } }, path: [] },
          right: { kind: 'literal', value: '' } } },
    ] };
    const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId,
      resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }),
      executeStep: async () => ({ kind: 'completed', result: '' }) });
    const coordination = coordinator.run({ runId, definition, inputs: {}, executionTarget: { kind: 'session' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } });
    if (attention) {
      await sourceCommitted;
      // Let the real false-condition branch queue its provenance behind the
      // held root mutation, preserving the caller's now-stale lifecycle.
      await new Promise<void>(resolve => setImmediate(resolve));
      releaseControl();
      await attention;
    }
    expect(await coordination).toMatchObject({ state: 'succeeded' });
    if (pending !== undefined) {
      expect(boundary.rowById(rootId)?.index.lifecycle).toBe(pending ? 'needs_attention' : 'running');
      expect(store.read(rootKey)?.reason).toBe(pending ? 'approval_required' : undefined);
    }
    const source = boundary.rows().find(row => row.index.id !== rootId && row.index.lifecycle === 'completed')!;
    const opened = openWorkflowProgressStoredEnvelopeV1({ ...encryption.runCrypto, binding,
      envelope: parseWorkflowStoredContentEnvelopeV1(boundary.rowById(rootId)!.contentEnvelope) });
    expect(opened).toMatchObject({ kind: 'available', content: { resultProvenance: {
      [source.index.id]: { notificationCondition: 'suppressed' },
    } } });
    const rejoined = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, encryption,
      rootRecordId: rootId, revision: boundary.run().revision, checkpoint: store.checkpoint, storage: boundary });
    expect(rejoined.read(rootKey)?.resultProvenance).toEqual({ [source.index.id]: { notificationCondition: 'suppressed' } });
  });
  it('recovers inputless Session creation from sealed rows after losing the leaf completion write', async () => {
    const rootId = 'inputless-root';
    const encryption = { witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' as const } };
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } }));
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    let lossPending = true;
    let creations = 0;
    const runProcess = async () => {
      const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
        rootRecordId: rootId, revision: boundary.run().revision, encryption, checkpoint,
        storage: { execute: async operation => {
          if (lossPending && operation.operation === 'invocations.fact' && operation.invocationId !== rootId && operation.lifecycle === 'completed') {
            lossPending = false;
            throw new Error('inputless_completion_write_lost');
          }
          return boundary.execute(operation);
        } } });
      const executeStep = createProductionWorkflowSessionStepExecutor({
        credentials: { token: 'token', encryption: null }, machineId, machineAdmissionTransport: vi.fn(),
        createFreshConversation: async ({ workspace }) => { creations++; return { sessionId: 'created-session', machineId, directory: workspace.directory }; },
        resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
        resolveExistingSessionConversation: async () => { throw new Error('Durable creation needs no runtime input'); },
        sessionInput: { enqueue: async () => { throw new Error('Inputless creation has no input'); }, observe: async () => { throw new Error('Inputless creation has no turn'); } },
      });
      const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId, executeStep,
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }),
      });
      return coordinator.run({ runId, inputs: {}, executionTarget: { kind: 'session' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        definition: { version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, conversation: { kind: 'fresh' } },
          blocks: [{ ...onlyStep, inputMode: 'none', document: { text: '', references: [], attachments: [] } }] },
      });
    };
    await expect(runProcess()).rejects.toThrow('inputless_completion_write_lost');
    const leaf = boundary.rows().find(row => row.index.id !== rootId)!;
    expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: leaf.index.id,
        sequence: leaf.index.sequence, parentRecordId: leaf.index.parentRecordId, memberOrdinal: leaf.index.memberOrdinal, attempt: leaf.index.attempt },
      envelope: parseWorkflowStoredContentEnvelopeV1(leaf.contentEnvelope),
    })).toMatchObject({ kind: 'available', content: { execution: { kind: 'session_ready', sessionId: 'created-session' } } });
    await expect(runProcess()).resolves.toMatchObject({ state: 'succeeded' });
    expect(creations).toBe(1);
  });

  it.each([
    ['plain', 'machines.command.run'], ['e2ee', 'machines.command.run'],
    ['plain', 'machines.services.exec'], ['e2ee', 'machines.services.exec'],
  ] as const)('persists complete command output independently of the Automation envelope budget (%s, %s)', async (mode, actionId) => {
    const fixture = await commandOutputAdmissionFixture(mode, 'result_ack_lost', '0', actionId);
    await fixture.store.commitFact({ key: fixture.key, lifecycle: 'admitting', execution: fixture.execution });
    const raw = { exitCode: 7, stdout: `old-out:${'😀\n"'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES / 4)}:stdout-end😀`,
      stderr: `old-error:${'é\\'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES / 2)}:stderr-end😀` };
    const fact = { key: fixture.key, lifecycle: 'completed' as const, result: raw };
    const committed = await fixture.store.commitFact(fact);
    const output = WorkflowMachineCommandOutputV1Schema.parse(committed.result);
    expect(output.exitCode).toBe(7);
    expect(output).toEqual(raw);
    expect(fixture.open()).toMatchObject({ kind: 'available', content: { result: committed.result, execution: fixture.execution } });
    // A duplicate caller rejoins the exact committed fact after the lost acknowledgement.
    await expect(fixture.store.commitFact(fact)).resolves.toMatchObject({ lifecycle: 'completed', result: committed.result });
  });

  it.each([
    ['plain', 'machines.command.run'], ['e2ee', 'machines.command.run'],
    ['plain', 'machines.services.exec'], ['e2ee', 'machines.services.exec'],
  ] as const)('keeps cancelled command result and execution output coherent after the Stop CAS (%s, %s)', async (mode, actionId) => {
    const fixture = await commandOutputAdmissionFixture(mode, undefined, '0', actionId);
    await fixture.store.commitFact({ key: fixture.key, lifecycle: 'admitting', execution: fixture.execution });
    fixture.boundary.requestControl('cancel_requested');
    const swept = fixture.boundary.rowById(fixture.intent.recordId)!;
    const current = fixture.open();
    if (current.kind !== 'available') throw new Error('expected stopped command row');
    const concurrentInteraction = { message: 'concurrent row data😀'.repeat(128) };
    await fixture.boundary.execute({ operation: 'invocations.fact', runId, parentAttempt: 0,
      accountCurrentness: { mode, version: 1, contentKeyFingerprint: mode === 'plain' ? null : 'a'.repeat(64) },
      invocationId: swept.index.id, invocationAttempt: swept.index.attempt, expectedContentRevision: swept.index.contentRevision,
      expectedLifecycle: 'cancel_requested', lifecycle: 'cancel_requested',
      contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        ...fixture.sealMode, binding: fixture.binding, progress: { ...current.content, interaction: concurrentInteraction } })) });
    const raw = { exitCode: -1, stdout: `${'😀'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES)}:stdout-end😀`, stderr: 'short stderr' };
    const committed = await fixture.store.commitFact({ key: fixture.key, lifecycle: 'cancelled', result: raw,
      execution: { ...fixture.execution, output: raw }, reason: 'command_cancelled' });
    const output = WorkflowMachineCommandOutputV1Schema.parse(committed.result);
    expect(committed).toMatchObject({ lifecycle: 'cancelled', execution: { ...fixture.execution, output: committed.result } });
    expect(output).toEqual(raw);
    expect(fixture.open()).toMatchObject({ kind: 'available', content: { result: committed.result, interaction: concurrentInteraction,
      execution: { ...fixture.execution, output: committed.result } } });
  });

  it.each(['finite', 'outcome_unknown'] as const)('settles only finite service command output after the Stop CAS (%s)', async outcome => {
    const fixture = await commandOutputAdmissionFixture('plain', undefined, '0', 'machines.services.exec');
    await fixture.store.commitFact({ key: fixture.key, lifecycle: 'admitting', execution: fixture.execution });
    fixture.boundary.requestControl('cancel_requested');
    const result = outcome === 'finite' ? { exitCode: -1, stdout: 'before Stop', stderr: '' } : { kind: 'outcome_unknown' };
    const settlement = fixture.store.commitFact({ key: fixture.key, lifecycle: 'cancelled', reason: 'command_cancelled', result });
    if (outcome === 'finite') {
      await expect(settlement).resolves.toMatchObject({ lifecycle: 'cancelled', result });
      expect(fixture.open()).toMatchObject({ kind: 'available', content: { result } });
    } else {
      await expect(settlement).rejects.toThrow();
      expect(fixture.store.read(fixture.key)?.lifecycle).toBe('cancel_requested');
      expect(fixture.store.read(fixture.key)?.result).toBeUndefined();
    }
  });

  it('leaves a small command result unchanged', async () => {
    const fixture = await commandOutputAdmissionFixture('plain');
    await fixture.store.commitFact({ key: fixture.key, lifecycle: 'admitting', execution: fixture.execution });
    const output = { exitCode: 0, stdout: 'whole stdout😀', stderr: 'whole stderr' };
    await expect(fixture.store.commitFact({ key: fixture.key, lifecycle: 'completed', result: output }))
      .resolves.toMatchObject({ result: output });
    expect(fixture.open()).toMatchObject({ kind: 'available', content: { result: output } });
  });

  it.each([
    ['plain', 'machines.command.run'], ['e2ee', 'machines.command.run'],
    ['plain', 'machines.services.exec'], ['e2ee', 'machines.services.exec'],
  ] as const)('persists complete command input independently of the Automation envelope budget (%s, %s)', async (mode, actionId) => {
    const fixture = await commandOutputAdmissionFixture(mode, undefined, '0', actionId);
    const value = 'x'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES + 1);
    const execution = { ...fixture.execution,
      input: actionId === 'machines.command.run' ? { ...fixture.execution.input, env: { VALUE: value } }
        : { ...fixture.execution.input, argv: ['tool', value] } };
    await expect(fixture.store.commitFact({ key: fixture.key, lifecycle: 'admitting', execution }))
      .resolves.toMatchObject({ lifecycle: 'admitting', execution });
    expect(fixture.open()).toMatchObject({ kind: 'available', content: { execution } });
  });

  it('does not repeat command admission after losing its persisted acknowledgement', async () => {
    const fixture = await commandOutputAdmissionFixture('plain', 'admission_ack_lost', '1');
    const producerKey = workflowInvocationKey({ runId, blockId: 'producer', scope: [], attempt: 0 });
    await fixture.store.ensureIntent({ key: producerKey, recordId: 'producer-leaf', runId,
      blockId: 'producer', path: { blockId: 'producer', scope: [] }, blockKind: 'step', memberOrdinal: '0', attempt: 0,
      acceptedAtMs: 1, lifecycle: 'pending' });
    await fixture.store.commitFact({ key: producerKey, lifecycle: 'completed', result: { VALUE: 'producer value' } });
    let effects = 0;
    const executor = createActionExecutor(createCliActionDeps({ token: 'token', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test', machineActionDirectTargetTransport: { machineId,
        invoke: async () => { effects++; return { success: true, exitCode: 0, stdout: '', stderr: '' }; } } }));
    const command: WorkflowActionLeafV1 = { kind: 'action', id: 'command', actionId: 'machines.command.run', input: {
      command: { kind: 'literal', value: 'fixed command' }, env: { kind: 'result', producer: { blockId: 'producer', scope: { kind: 'current' } }, path: [] },
    } };
    const spec = getActionSpec('machines.command.run');
    const frozen: WorkflowMaterializedLeafV1 = { kind: 'action', authoredWorkspace: { kind: 'inherit' }, sourceKey: '$root',
      blockId: 'command', selection: {}, executionTarget: { kind: 'session' }, actionId: command.actionId,
      actionContract: { inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
        outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.outputSchema!, { target: 'draft-7' })) } };
    const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
    const coordinator = createWorkflowCoordinator({ store: fixture.store, rootInvocationRecordId: fixture.rootId,
      executeStep: async () => { throw new Error('producer is already completed'); }, resolveWorkspace: async () => ({ ok: true, workspace }), action: { executor, buildContext: async () => ({ surface: 'cli',
        authority: 'account_automation', bypassApprovals: true, serverId: 'home',
        externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory: '/repo' } } }),
        observeRun: async () => { throw new Error('immediate Action has no child Runs'); } } });
    const outcome = await coordinator.run({ runId, definition: { version: 1, inputs: [], defaults: {},
      blocks: [{ ...onlyStep, id: 'producer', result: { kind: 'json', schema: { type: 'object',
        properties: { VALUE: { type: 'string' } }, required: ['VALUE'], additionalProperties: false } } }, command] },
      inputs: {}, executionTarget: { kind: 'session' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, materializedLeaves: [
        { kind: 'step', authoredWorkspace: { kind: 'inherit' }, sourceKey: '$root', blockId: 'producer',
          selection: {}, executionTarget: { kind: 'session' } }, frozen] });
    expect(effects).toBe(0);
    expect(outcome).toEqual({ state: 'outcome_uncertain', reason: 'outcome_uncertain' });
  });
  it('executes an admitted Run lifecycle Notify me through the real worker and notification Action once', async () => {
    // The registered plugin sender is an external delivery boundary. Workflow,
    // Action, Activity policy and plugin-notification ownership stay real.
    const deliveries: unknown[] = [];
    const pluginEvents: string[] = [];
    const workflowReads: unknown[] = [];
    const actionObservations: unknown[] = [];
    const pluginNotifications = createStablePluginNotificationsOwner({ categories: [],
      channels: [{ provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.delivery',
        definition: { id: 'digest', kind: 'plugin', title: 'Digest', configurable: true, defaultEnabled: true } }],
      activateChannel: async () => { pluginEvents.push('activate'); }, readChannel: () => {
        pluginEvents.push('read');
        return { occurrenceId: 'current', isCurrent: () => true,
        send: async request => { pluginEvents.push('send'); deliveries.push(request); return { deliveryId: request.deliveryId,
          channelId: request.channelId, status: 'accepted', evidence: 'provider' }; } };
      },
    });
    const settings = accountSettingsParse({ attentionDeliveryPolicyV1: { v: 1 } });
    const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null } as const;
    // Plugin contributions are executable channels, but notification dispatch
    // still requires a complete Account channel catalog. Install the exact
    // authenticated Account lifetime this production fixture represents.
    setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
      notificationChannelCatalog: notificationCatalogFixture(settings).notificationChannelCatalog });
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId,
      origin: { kind: 'automation', automationId: 'automation-1' } });
    const runOwner = createWorkflowAccountRunActionOwner({
      resolveAccountId: async () => accountId,
      storage: boundary,
      definitions: { get: async () => { throw new Error('must_not_read_mutable_definition'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: {
        mode: 'plain', version: 1, contentKeyFingerprint: null,
      } }),
      normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
      randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
    });
    const unexpectedDefinitionRead = async () => { throw new Error('Notification observes the accepted Run, not mutable definitions'); };
    const executeWorkflowAction = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, runs: runOwner,
      // Only Artifact persistence is unavailable; run the real definition owner.
      definitions: createWorkflowDefinitionActions({
        artifactStore: { read: unexpectedDefinitionRead, list: unexpectedDefinitionRead, create: unexpectedDefinitionRead,
          update: unexpectedDefinitionRead, delete: unexpectedDefinitionRead },
        encodeListCursor: () => { throw new Error('unexpected_definition_cursor'); },
        assertDefinitionWriteAllowed: unexpectedDefinitionRead,
      }) });
    const actionDeps = createCliActionDeps({ token: credentials.token, sessionId: '',
      mode: 'plain', ctx: null,
      credentials, serverId: 'server-1', serverHttpBaseUrl: 'https://home.example.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }),
      resolvePluginNotifications: () => pluginNotifications,
      workflowAction: async args => {
        try {
          const result = await executeWorkflowAction(args);
          workflowReads.push({ actionId: args.actionId, result });
          return result;
        } catch (error) {
          workflowReads.push({ actionId: args.actionId, thrown: error instanceof Error ? {
            name: error.name, message: error.message,
            ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
          } : String(error) });
          throw error;
        }
      },
    });
    const executor = createActionExecutor({ ...actionDeps,
      observeActionExecution: async observation => { actionObservations.push({
        actionId: observation.actionId, result: observation.result,
      }); },
    });
    const definitionEnvelope = JSON.stringify({ t: 'plain', v: {
      inlineDefinition: { version: 1, blocks: [{ kind: 'action', id: 'notice', actionId: 'notifications.notify_me',
        input: { message: { kind: 'literal', value: 'Source Run finished' },
          channels: { kind: 'literal', value: ['acme.delivery/digest'] } } }] },
      workspace: { directory: process.cwd() }, executionTarget: { kind: 'session' },
    } });
    const coordinate = createProductionWorkflowRunCoordinator({ token: credentials.token, accountId, machineId, storage: boundary,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      resolveMaterializationHost: async target => {
        const host = await productionMaterializationHost(target);
        return { ...host, effects: { ...host.effects, readActionContract: async actionId => {
          const spec = await executor.execute('action.spec.get', { id: actionId }, { surface: 'cli', authority: 'account_automation' });
          if (!spec.ok || typeof spec.result !== 'object' || spec.result === null) return null;
          const action = ActionDefinitionV1Schema.parse(Reflect.get(spec.result, 'actionSpec'));
          if (action.id !== 'notifications.notify_me') return null;
          const hostSpec = getActionSpec('notifications.notify_me');
          return { inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(hostSpec.inputSchema, { target: 'draft-7' })),
            outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(hostSpec.outputSchema!, { target: 'draft-7' })) };
        } } };
      },
      prepareAcceptedWorkspaceTarget: input => prepareWorkflowAcceptedWorkspaceTarget({ ...input,
        inspectLocation: async () => null }),
      onCommittedTransition: async () => {},
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      execution: { ...productionExecution(), detachedRun: { actionExecutor: executor,
        buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) }, action: { executor,
        buildContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
        observeRun: async () => { throw new Error('Notify me has no launched Run'); } } },
    });
    const settlements: string[] = [];
    const coordinationErrors: unknown[] = [];
    const occurrence = { v: 1 as const, kind: 'runLifecycle' as const,
      source: { kind: 'workflow_run' as const, runId: 'source-run' }, condition: 'terminal' as const,
      sourceRevision: 4, occurredAt: 200 };
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'runLifecycle',
      triggerId: 'source-trigger', triggerRevision: 0, occurredAt: occurrence.occurredAt,
      occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: 'source-trigger', evidence: occurrence }),
      evidence: { source: occurrence.source, condition: occurrence.condition, sourceRevision: occurrence.sourceRevision } });
    const claimed = { protocol: 'v3' as const,
      accountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
      automation: { id: 'automation-1', name: 'Notify me', enabled: true },
      run: { id: runId, automationId: 'automation-1', attempt: 0, leaseExpiresAt: Date.now() + 120_000, revision: 0, recipeKind: 'workflow-v2' as const,
        triggerId: AutomationTriggerIdSchema.parse('source-trigger'), cause,
        causeWorkDepth: 0, resultDelivery: { kind: 'none' as const }, executionInputEnvelope: definitionEnvelope },
    };
    await executeClaimedRun({ machineId, claimed,
      coordinateWorkflowRun: async claim => {
        try { return await coordinate(claim); }
        catch (error) { coordinationErrors.push(error); throw error; }
      },
      heartbeatMs: 60_000, leaseDurationMs: 120_000,
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: claimed.accountCurrentness }),
      claimClient: { heartbeatRun: async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs, failRun: async failure => { settlements.push(failure.errorCode); } },
    });
    expect(coordinationErrors).toEqual([]);
    // The Workflow coordinator owns durable terminal settlement; the ordinary
    // Automation claim settlement API is used only for pre-start refusal here.
    expect(settlements).toEqual([]);
    expect(boundary.run().state, JSON.stringify({ run: boundary.run(), progress: boundary.rows(),
      workflowReads, actionObservations, pluginEvents })).toBe('succeeded');
    expect(deliveries).toEqual([expect.objectContaining({ body: 'Source Run finished' })]);
    // Resume reads the retained completed Action row; it cannot repeat delivery.
    await coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision,
      accountCurrentness: claimed.accountCurrentness, acceptedEnvelope: boundary.acceptedEnvelope()! });
    expect(deliveries).toHaveLength(1);
  });

  it('publishes distinct accepted destination writers during parallel nested execution', async () => {
    const writer = (id: string, name: string, sessionId: string) => ({ ...onlyStep, id, name,
      execution: { conversation: { kind: 'existing_session' as const, sessionId, machineId } } });
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: { kind: 'existing_session', sessionId: 'session-1', machineId },
    }, blocks: [{ kind: 'parallel', id: 'together', failurePolicy: 'collect_outcomes', branches: [
      { id: 'first', blocks: [writer('check', 'Check', 'session-1')] },
      { id: 'second', blocks: [{ kind: 'if', id: 'nested',
        when: { kind: 'exists', value: { kind: 'literal', value: true } }, otherwise: [],
        then: [writer('report', 'Report', 'session-2'), { kind: 'workflow', id: 'child', name: 'Child', workflowRef: 'builtin:child',
          input: {}, execution: { conversation: { kind: 'existing_session', sessionId: 'session-2', machineId } } }] }] },
    ] }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
        readWorkflowDefinition: async () => ({ sourceKey: 'builtin:child', definition: { version: 1, inputs: [],
          defaults: { ...authored.defaults, conversation: { kind: 'existing_session', sessionId: 'session-2', machineId } },
          blocks: [{ kind: 'loop', id: 'repeated', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
            body: [writer('follow-up', 'Follow up', 'session-2')] }] } }) } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const rootProgress = () => {
      const row = boundary.rows().find(row => row.index.parentRecordId === null)!;
      const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
          sequence: row.index.sequence, parentRecordId: null, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
      if (opened.kind !== 'available') throw new Error('root_unavailable');
      return opened.content.stepProgress;
    };
    const runningProgress: unknown[] = [];
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary,
      execution: productionExecution({
        enqueue: async request => ({ status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) }),
        observe: async ({ sessionId, localId }) => {
          runningProgress.push(rootProgress());
          return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } };
        },
      }),
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).resolves.toMatchObject({ state: 'succeeded' });
    expect(runningProgress).toContainEqual(expect.objectContaining({ destinations: expect.arrayContaining([
      expect.objectContaining({ blockId: 'check', name: 'Check', ordinal: 1, sessionIds: ['session-1'] }),
      expect.objectContaining({ blockId: 'report', name: 'Report', ordinal: 2, sessionIds: ['session-2'],
        observation: expect.objectContaining({ lifecycle: 'running' }) }),
    ]) }));
    expect(rootProgress()).toMatchObject({ destinations: expect.arrayContaining([
      expect.objectContaining({ blockId: 'check', observation: expect.objectContaining({ lifecycle: 'completed' }) }),
      expect.objectContaining({ blockId: 'report', observation: expect.objectContaining({ lifecycle: 'completed' }) }),
      expect.objectContaining({ sourceKey: 'builtin:child', blockId: 'follow-up', ordinal: 1, name: 'Follow up', sessionIds: ['session-2'],
        observation: expect.objectContaining({ lifecycle: 'completed' }) }),
    ]) });
    expect(rootProgress()).toMatchObject({ completed: 3, skipped: 0, total: 3 });
    const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId,
      storage: boundary, definitions: { get: async () => { throw new Error('must_not_read_mutable_definition'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
      randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
    });
    const beforeList = boundary.calls.length;
    const listed = WorkflowActionOutputSchemasV1['workflow.run.list'].parse(
      await owner.execute({ actionId: 'workflow.run.list', input: { targetSessionId: 'session-2' }, context: {} }),
    );
    expect(listed.runs[0]?.stepProgress).toEqual(rootProgress());
    expect(boundary.calls.slice(beforeList).map(call => call.operation)).toEqual(['list']);
    const root = boundary.rows().find(row => row.index.parentRecordId === null)!;
    const beforeReload = rootProgress();
    const restored = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: root.index.id, revision: boundary.run().revision, storage: boundary,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: root.index.id, nextSequence: '20',
        frontier: { nextBlockOrdinal: 1, paused: false } },
      authoredDefinition: accepted.snapshot.authoredDefinition, definition: accepted.snapshot.definition,
      frozenChildren: accepted.snapshot.frozenChildren,
      destinations: deriveWorkflowDestinationsV1({ definition: accepted.snapshot.authoredDefinition,
        children: accepted.snapshot.frozenChildren, materializedLeaves: accepted.snapshot.materializedLeaves }).leaves,
    });
    await restored.refreshStepProgress();
    expect(rootProgress()?.destinations).toEqual(beforeReload?.destinations);
    const newestFollowUp = beforeReload?.destinations?.find(leaf => leaf.blockId === 'follow-up')?.observation;
    if (!newestFollowUp) throw new Error('expected observed follow-up');
    const earlierFollowUps = boundary.rows().filter(row => {
      const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
          sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
          memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
      return opened.kind === 'available' && opened.content.invocationPath.blockId === 'follow-up'
        && BigInt(row.index.sequence) < BigInt(newestFollowUp.sequence);
    });
    expect(earlierFollowUps).toHaveLength(1);
    await restored.readByLogicalInvocation(earlierFollowUps[0]!.index.id);
    await restored.refreshStepProgress();
    expect(rootProgress()?.destinations).toEqual(beforeReload?.destinations);
  });

  it.each(['then', 'otherwise', 'all_taken'] as const)('projects finished and skipped Action steps through the Run presenter (%s)', async branch => {
    const action = (id: string): WorkflowActionLeafV1 => ({ kind: 'action', id, actionId: 'machines.list', input: {} });
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: branch === 'all_taken'
      ? [action('first'), action('second')]
      : [{ kind: 'if', id: 'choose', when: { kind: 'exists', value: { kind: 'literal', value: branch === 'then' ? true : null } },
        then: [action('taken')], otherwise: [action('alternative')] }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    // Only the Account inventory transport is replaced; Action dispatch, admission,
    // coordinator execution, durable projection and both presenters stay real.
    const executor = createActionExecutor({ machinesList: async () => ({ items: [] }) });
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary,
      execution: { ...productionExecution(), action: { executor,
        buildContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
        observeRun: async () => { throw new Error('machines.list does not launch work'); } } },
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).resolves.toMatchObject({ state: 'succeeded' });
    const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId,
      storage: boundary, definitions: { get: async () => { throw new Error('must_not_read_mutable_definition'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
      randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
    });
    const beforeList = boundary.calls.length;
    const listed = WorkflowActionOutputSchemasV1['workflow.run.list'].parse(
      await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }));
    expect(boundary.calls.slice(beforeList).map(call => call.operation)).toEqual(['list']);
    const run = listed.runs[0]!;
    const expected = branch === 'all_taken' ? { completed: 2, skipped: 0, total: 2 } : { completed: 1, skipped: 1, total: 2 };
    expect(run.stepProgress).toMatchObject(expected);
    const { formatWorkflowRunOutcomeSentence } = await import('../../../../ui/sources/components/workflows/run/workflowRunDetailPresentation');
    const { describeWorkflowRunProgress } = await import('../../../../ui/sources/components/workflows/presentation/workflowRunProgress');
    const { t } = await import('../../../../ui/sources/text');
    const coverage = { observedLeafCounts: { completed: expected.completed, failed: 0, attention: 0 },
      coverage: 'complete' as const, knownFailure: false };
    expect(formatWorkflowRunOutcomeSentence({ run, coverage, historyComplete: true })).toBe(branch === 'all_taken'
      ? t('workflows.run.completedCount', { count: 2 })
      : t('workflows.run.completedWithSkipped', { completed: 1, skipped: 1 }));
    expect(formatWorkflowRunOutcomeSentence({ run, coverage: { ...coverage, knownFailure: true }, historyComplete: true }))
      .toBe(t('workflows.runState.completed_with_failures'));
    expect(describeWorkflowRunProgress(run.stepProgress)).toBe(branch === 'all_taken'
      ? t('workflows.list.stepsProgress', expected)
      : t('workflows.run.completedWithSkipped', { completed: 1, skipped: 1 }));
    const get = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(
      await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: {} }));
    expect(get.run.stepProgress).toEqual(run.stepProgress);
  });

  it('settles and starts the next durable Session invocation without firing an interval or deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const fakeTimeout = globalThis.setTimeout;
    let timerFires = 0;
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
      fakeTimeout(() => { timerFires += 1; callback(...args); }, delay));
    const interval = vi.spyOn(globalThis, 'setInterval');
    try {
      const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        conversation: { kind: 'existing_session', sessionId: 'session-1', machineId },
      }, blocks: [onlyStep, { ...onlyStep, id: 'next' }] };
      const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
        context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
          origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
      if (!accepted.ok) throw new Error(accepted.error.code);
      const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
      }));
      const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
      let firstSettled = false;
      let readsAtSettlement = 0;
      let operationsBeforeNextInput: readonly string[] = [];
      const admitted: string[] = [];
      const execution = productionExecution({
        enqueue: async request => {
          if (admitted.length === 1) {
            expect(firstSettled).toBe(true);
            expect(boundary.rows().filter(row => row.index.lifecycle === 'completed')).toHaveLength(1);
            operationsBeforeNextInput = boundary.operations().slice(readsAtSettlement);
          }
          const localId = deriveWorkflowSessionInputLocalIdV2(request.workflow);
          admitted.push(localId);
          return { status: 'accepted', localId };
        },
        observe: async ({ sessionId, localId }) => {
          if (admitted.length === 1) {
            firstSettled = true;
            readsAtSettlement = boundary.calls.length;
          }
          return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } };
        },
      });
      const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary, execution,
        resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
        resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        isAcceptedAuthorizationCurrent: async () => true,
        workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
          inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      });
      const startedAt = Date.now();
      // Never advance the fake clock: any interval-dependent handoff cannot complete.
      await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
        accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).resolves.toMatchObject({ state: 'succeeded' });
      expect(new Set(admitted).size).toBe(2);
      expect(boundary.rows().filter(row => row.index.lifecycle === 'completed')).toHaveLength(3);
      expect(Date.now()).toBe(startedAt);
      expect(timerFires).toBe(0);
      expect(interval).not.toHaveBeenCalled();
      // The next intent carries its resolved input; no separate input fact and
      // corresponding root projection round trips precede Session admission.
      // Its slot is first read when demanded: progress no longer prefetches
      // every future authored slot during startup.
      expect(operationsBeforeNextInput.filter(operation => operation === 'invocations.current')).toHaveLength(1);
      expect(operationsBeforeNextInput.filter(operation => operation !== 'invocations.current')).toHaveLength(11);
      console.info('FIN-HANDOFF-COST', JSON.stringify({ timerFires, intervalInstalls: interval.mock.calls.length, invocationsStarted: admitted.length,
        deadlineDelaysMs: timeout.mock.calls.map(([, delay]) => delay),
        storageOperations: boundary.calls.length, operationsFromFirstResultToNextInput: operationsBeforeNextInput }));
    } finally {
      timeout.mockRestore();
      interval.mockRestore();
      vi.useRealTimers();
    }
  });

  it('publishes authored step counts and completed parallel items rather than admission cursors', async () => {
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: { kind: 'existing_session', sessionId: 'session-1', machineId },
    }, blocks: [onlyStep, { kind: 'if', id: 'conditional',
      when: { kind: 'exists', value: { kind: 'literal', value: true } }, otherwise: [],
      then: [{ kind: 'loop', id: 'empty', repetition: { kind: 'count', count: { kind: 'literal', value: 0 } }, body: [{ ...onlyStep, id: 'unused' }, { ...onlyStep, id: 'also-unused' }] }] },
      { kind: 'loop', id: 'batch', repetition: { kind: 'items', items: { kind: 'literal', value: ['slow', 'fast', 'third'] },
        execution: 'parallel', maxConcurrent: 2, failurePolicy: 'collect_outcomes' }, body: [{ ...onlyStep, id: 'item' }] }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const openedRoot = () => {
      const row = boundary.rows().find((row) => row.index.parentRecordId === null);
      if (!row) throw new Error('root_missing');
      return openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
          sequence: row.index.sequence, parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
    };
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const observed: unknown[] = [];
    let item = 0;
    const execution = productionExecution({
      enqueue: async request => ({ status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) }),
      observe: async ({ sessionId, localId }) => {
        const opened = openedRoot();
        observed.push(opened.kind === 'available' ? Reflect.get(opened.content, 'stepProgress') : opened.kind);
        const ordinal = item++;
        if (ordinal === 1) await slow;
        if (ordinal === 3) releaseSlow?.();
        return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } };
      },
    });
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary, execution,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).resolves.toMatchObject({ state: 'succeeded' });
    expect(observed[0]).toMatchObject({ completed: 0, total: 4 });
    expect(observed[3]).toMatchObject({ completed: 1, skipped: 2, total: 4, currentLoop: { completed: 1, total: 3 } });
    expect(openedRoot()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 2, skipped: 2, total: 4 } } });
  });

  it.each(['item', 'aggregate'] as const)('retains completed loop progress when Stop races the %s publication', async stopAt => {
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'loop', id: 'batch',
      repetition: { kind: 'items', items: { kind: 'literal', value: ['first', 'second'] },
        execution: 'sequential', failurePolicy: 'collect_outcomes' },
      body: [{ kind: 'action', id: 'inventory', actionId: 'machines.list', input: {} }] }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const open = (row: NonNullable<ReturnType<typeof boundary.rowById>>) => openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id, sequence: row.index.sequence,
        parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt },
    });
    let stopped = false;
    const storage: typeof boundary = { ...boundary, execute: async (operation, options) => {
      const result = await boundary.execute(operation, options);
      if (!stopped && operation.operation === 'invocations.fact') {
        const opened = open(boundary.rowById(operation.invocationId)!);
        if (opened.kind === 'available' && (stopAt === 'item'
          ? operation.lifecycle === 'completed' && opened.content.frame?.source.kind === 'item'
          : opened.content.stepProgress?.currentLoop?.completed === 1)) {
          stopped = true;
          boundary.requestControl('cancel_requested');
        }
      }
      return result;
    } };
    const executor = createActionExecutor({ machinesList: async () => ({ items: [] }) });
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage,
      execution: { ...productionExecution(), action: { executor,
        buildContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
        observeRun: async () => { throw new Error('unexpected run observation'); } } },
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).resolves.toMatchObject({ state: 'cancelled' });
    expect(stopped).toBe(true);
    const items = boundary.rows().filter(row => {
      const opened = open(row);
      return opened.kind === 'available' && opened.content.frame?.source.kind === 'item';
    });
    expect(items.filter(row => row.index.lifecycle === 'completed')).toHaveLength(1);
    const root = boundary.rows().find(row => row.index.parentRecordId === null)!;
    expect(root.index.lifecycle).toBe('cancelled');
    expect(open(root)).toMatchObject({ kind: 'available', content: { stepProgress: {
      completed: 0, total: 1, currentLoop: { completed: 1, total: 2 },
    } } });
    const loop = boundary.rows().find(row => row.index.parentRecordId === root.index.id)!;
    expect(loop.index.lifecycle).toBe('cancelled');
    expect(open(loop)).toMatchObject({ kind: 'available', content: { loopProgress: { completed: 1, total: 2 } } });
    const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId,
      storage: boundary, definitions: { get: async () => { throw new Error('unexpected definition read'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
      randomBytes: () => { throw new Error('unexpected key creation'); },
    });
    const listed = WorkflowActionOutputSchemasV1['workflow.run.list'].parse(
      await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }));
    expect(listed.runs[0]).toMatchObject({ state: 'cancelled', stepProgress: {
      completed: 0, total: 1, currentLoop: { completed: 1, total: 2 },
    } });
  });

  it('settles a late child without republishing immutable cancelled root and loop aggregates', async () => {
    const rootId = 'cancelled-projection-root';
    const loopId = 'cancelled-projection-loop';
    const childId = 'late-cancelled-item';
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'loop', id: 'batch',
      repetition: { kind: 'items', items: { kind: 'literal', value: [1] }, execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [onlyStep] }] };
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
      nextSequence: '3', frontier: { nextBlockOrdinal: 0, paused: false } };
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint }));
    const seal = (id: string, sequence: string, parentRecordId: string | null, progress: WorkflowProgressEnvelopeV1) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence, parentRecordId, memberOrdinal: '0', attempt: '0' }, progress }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'opaque-accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
      rootInvocation: { id: rootId, contentEnvelope: seal(rootId, '0', null, { kind: 'happier.workflow-progress.v1', blockKind: 'root',
        invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId }) } });
    await boundary.execute({ operation: 'invocations.admit', runId, expectedRevision: boundary.run().revision, checkpointEnvelope, invocations: [
      { id: loopId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal(loopId, '1', rootId, { kind: 'happier.workflow-progress.v1', blockKind: 'loop',
          invocationPath: { blockId: 'batch', scope: [] }, attempt: '0', logicalInvocationRecordId: loopId,
          container: { kind: 'loop', mode: 'items', source: { kind: 'definition', reference: { kind: 'literal', value: [1] } }, itemCount: '1', nextMemberIndex: '1', nextBodyBlockOrdinal: '0' } }) },
      { id: childId, sequence: '2', parentRecordId: loopId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal(childId, '2', loopId, { kind: 'happier.workflow-progress.v1', blockKind: 'loop',
          invocationPath: { blockId: 'batch', scope: [{ kind: 'iteration', blockId: 'batch', index: 0 }] }, attempt: '0', logicalInvocationRecordId: childId,
          frame: { ownerBlockId: 'batch', source: { kind: 'item', index: '0' } }, container: { kind: 'body', nextBlockOrdinal: '0' } }) },
    ] });
    boundary.requestControl('cancel_requested');
    for (const id of [rootId, loopId]) {
      const row = boundary.rowById(id)!;
      await boundary.execute({ operation: 'invocations.fact', runId, parentAttempt: 0, invocationId: id, invocationAttempt: '0',
        expectedLifecycle: row.index.lifecycle, expectedContentRevision: row.index.contentRevision, lifecycle: 'cancelled', contentEnvelope: row.contentEnvelope });
    }
    const terminalContent = [rootId, loopId].map(id => boundary.rowById(id)!.contentEnvelope);
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, storage: boundary, checkpoint,
      revision: boundary.run().revision, rootRecordId: rootId, authoredDefinition: authored,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
    await store.readByLogicalInvocation(loopId);
    const child = await store.readByLogicalInvocation(childId);
    if (!child) throw new Error('late_child_missing');
    const beforeSettlement = boundary.calls.length;
    await expect(store.commitFact({ key: child.key, lifecycle: 'cancelled' })).resolves.toMatchObject({ lifecycle: 'cancelled' });
    await store.refreshStepProgress();
    expect(boundary.rowById(childId)?.index.lifecycle).toBe('cancelled');
    expect([rootId, loopId].map(id => boundary.rowById(id)!.contentEnvelope)).toEqual(terminalContent);
    expect(boundary.calls.slice(beforeSettlement).filter(operation => operation.operation === 'invocations.fact')
      .map(operation => operation.invocationId)).toEqual([childId]);
  });

  it('counts only current loop-item attempts after reload and replacement', async () => {
    const rootId = 'projection-root';
    const loopId = 'projection-loop';
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'loop', id: 'batch',
      repetition: { kind: 'items', items: { kind: 'literal', value: [1, 2] }, execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [onlyStep] }] };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'opaque-accepted' });
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
      nextSequence: '5', frontier: { nextBlockOrdinal: 0, paused: false } };
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint }));
    const seal = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string,
      progress: WorkflowProgressEnvelopeV1) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence, parentRecordId, memberOrdinal, attempt: progress.attempt }, progress }));
    const rootEnvelope = seal(rootId, '0', null, '0', { kind: 'happier.workflow-progress.v1', blockKind: 'root',
      invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const frame = (id: string, index: number, attempt = '0'): WorkflowProgressEnvelopeV1 => ({
      kind: 'happier.workflow-progress.v1', blockKind: 'loop', invocationPath: { blockId: 'batch', scope: [{ kind: 'iteration', blockId: 'batch', index }] },
      attempt, logicalInvocationRecordId: attempt === '0' ? id : 'item-old',
      ...(attempt === '0' ? {} : { previousAttemptRecordId: 'item-old' }),
      frame: { ownerBlockId: 'batch', source: { kind: 'item', index: String(index) } },
      container: { kind: 'body', nextBlockOrdinal: '1' },
    });
    await boundary.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope, invocations: [
      { id: loopId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal(loopId, '1', rootId, '0', { kind: 'happier.workflow-progress.v1', blockKind: 'loop',
          invocationPath: { blockId: 'batch', scope: [] }, attempt: '0', logicalInvocationRecordId: loopId,
          container: { kind: 'loop', mode: 'items', source: { kind: 'definition', reference: { kind: 'literal', value: [1, 2] } }, itemCount: '2', nextMemberIndex: '2', nextBodyBlockOrdinal: '0' } }) },
      { id: 'item-old', sequence: '2', parentRecordId: loopId, memberOrdinal: '0', lifecycle: 'completed', contentEnvelope: seal('item-old', '2', loopId, '0', frame('item-old', 0)) },
      { id: 'item-other', sequence: '3', parentRecordId: loopId, memberOrdinal: '1', lifecycle: 'pending', contentEnvelope: seal('item-other', '3', loopId, '1', frame('item-other', 1)) },
    ] });
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, storage: boundary, checkpoint,
      revision: boundary.run().revision, rootRecordId: rootId, authoredDefinition: authored,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
    const progress = () => openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(boundary.rowById(rootId)?.contentEnvelope),
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' } });
    await store.refreshStepProgress();
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 0, total: 1, currentLoop: { completed: 1, total: 2 } } } });
    await boundary.execute({ operation: 'invocations.admit', runId, expectedRevision: boundary.run().revision, checkpointEnvelope,
      invocations: [{ id: 'item-new', sequence: '4', parentRecordId: loopId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal('item-new', '4', loopId, '0', frame('item-new', 0, '1')) }] });
    // Seed a persisted newer attempt at the HTTP/database boundary, not inside the projector.
    boundary.rowById('item-new')!.index.attempt = '1';
    const replacement = await store.readByLogicalInvocation('item-new');
    if (!replacement) throw new Error('replacement_missing');
    await store.refreshStepProgress();
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 0, total: 1, currentLoop: { completed: 0, total: 2 } } } });
    await store.commitFact({ key: replacement.key, lifecycle: 'completed' });
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 0, total: 1, currentLoop: { completed: 1, total: 2 } } } });
    const openRow = (id: string) => {
      const row = boundary.rowById(id)!;
      return openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence: row.index.sequence,
          parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
    };
    const openedLoop = openRow(loopId);
    expect(openedLoop).toMatchObject({ kind: 'available', content: { loopProgress: { completed: 1, total: 2 } } });
    if (openedLoop.kind !== 'available') throw new Error('loop_progress_missing');
    // Reloading an already-running older occurrence does not invent its original start.
    expect(openedLoop.content.timing).toBeUndefined();
    // Terminal bookkeeping must not make a completed occurrence's duration grow.
    const running = await store.readByLogicalInvocation('item-other');
    if (!running) throw new Error('item_missing');
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(Date.parse('2026-10-11T10:00:00.000Z'));
      await store.commitFact({ key: running.key, lifecycle: 'running' });
      clock.mockReturnValue(Date.parse('2026-10-11T10:01:00.000Z'));
      await store.commitFact({ key: running.key, lifecycle: 'waiting_for_review' });
      const held = openRow('item-other');
      expect(held).toMatchObject({ kind: 'available', content: { timing: { startedAt: '2026-10-11T10:00:00.000Z' } } });
      if (held.kind !== 'available') throw new Error('held_timing_missing');
      expect(held.content.timing).not.toHaveProperty('finishedAt');
      clock.mockReturnValue(Date.parse('2026-10-11T10:02:00.000Z'));
      await store.commitFact({ key: running.key, lifecycle: 'completed' });
      clock.mockReturnValue(Date.parse('2026-10-11T11:00:00.000Z'));
      await store.commitFact({ key: running.key, lifecycle: 'completed', interaction: {} });
      expect(openRow('item-other')).toMatchObject({ kind: 'available', content: { timing: {
        startedAt: '2026-10-11T10:00:00.000Z', finishedAt: '2026-10-11T10:02:00.000Z',
      } } });
    } finally { clock.mockRestore(); }
    await boundary.execute({ operation: 'invocations.admit', runId, expectedRevision: boundary.run().revision, checkpointEnvelope,
      invocations: [{ id: 'loop-recovered', sequence: '5', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal('loop-recovered', '5', rootId, '0', { kind: 'happier.workflow-progress.v1', blockKind: 'loop',
          invocationPath: { blockId: 'batch', scope: [] }, attempt: '1', logicalInvocationRecordId: loopId, previousAttemptRecordId: loopId,
          container: { kind: 'loop', mode: 'items', source: { kind: 'definition', reference: { kind: 'literal', value: [1, 2] } }, itemCount: '2', nextMemberIndex: '2', nextBodyBlockOrdinal: '0' } }) }] });
    boundary.rowById('loop-recovered')!.index.attempt = '1';
    await store.readByLogicalInvocation('loop-recovered');
    await store.refreshStepProgress();
    const inherited = await store.readByLogicalInvocation('item-other');
    if (!inherited) throw new Error('inherited_item_missing');
    await store.commitFact({ key: inherited.key, lifecycle: 'completed' });
    expect(progress()).toMatchObject({ kind: 'available', content: { stepProgress: { completed: 0, total: 1, currentLoop: { completed: 2, total: 2 } } } });
  });
  it('renders each nested Session leaf with its frozen source-qualified role, not a same-id root role', async () => {
    const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.test', localId: 'test' } };
    const retained = { kind: 'existing_session' as const, sessionId: 'session-1', machineId };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget: target, conversation: retained },
      blocks: [onlyStep, { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} }] };
    const child: WorkflowDefinitionV1 = { ...definition, blocks: [onlyStep] };
    const role = (instructions: string): NonNullable<WorkflowMaterializedLeafV1['role']> => ({
      roleId: instructions, name: instructions, instructions, runsAs: { kind: 'session' },
      workspaceWrites: 'allow', secondOpinion: 'off', enabled: true,
    });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        startedBy: 'user', definition, authoredDefinition: definition, inputs: {}, workDepth: 0, metadata: null, machineId,
        executionTarget: { kind: 'session' }, source: { kind: 'inline' }, origin: { kind: 'direct' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        frozenChildren: { 'builtin:child': child }, materializedLeaves: [
          { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: 'work', kind: 'step', selection: definition.defaults,
            executionTarget: { kind: 'session' }, role: role('Root role only') },
          { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: 'nested', kind: 'workflow', selection: definition.defaults,
            executionTarget: { kind: 'session' }, childRef: 'builtin:child' },
          { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: 'builtin:child', blockId: 'work', kind: 'step', selection: child.defaults,
            executionTarget: { kind: 'session' }, role: role('Child role only') },
        ],
      },
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const sent: string[] = [];
    const execution = productionExecution({
      enqueue: async request => { sent.push(request.text); return { status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) }; },
      observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }),
    });
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true, storage: boundary, onCommittedTransition: vi.fn(), execution,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } })).resolves.toMatchObject({ state: 'succeeded' });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('Root role only');
    expect(sent[1]).toContain('Child role only');
    expect(sent[1]).not.toContain('Root role only');
  });
  it('accepts the same origin input after sealed durable reload regardless of correspondence field order', async () => {
    const rootId = 'root-origin-reload';
    const storage = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct', originSessionId: 'origin' }, acceptedEnvelope: 'accepted' });
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } }));
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const load = () => DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId: rootId,
      revision: storage.run().revision, storage,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } },
    });
    const first = await load();
    const key = workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 });
    await first.ensureIntent({ blockKind: 'step', key, recordId: 'origin-reload-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      memberOrdinal: '0', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    const correspondence = { kind: 'session' as const, sessionId: 'origin', localInputId: 'same-origin-input' };
    await first.commitFact({ key, lifecycle: 'admitting', execution: correspondence, input: { document: onlyStep.document, input: [] }, resultContract: onlyStep.result });
    const restored = await load();
    const executeStep = createWorkflowSessionStepExecutor({ credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('must retain conversation'); },
      materializeConversation: async () => { throw new Error('must not create conversation'); },

      sessionInput: { enqueue: async () => { throw new Error('must not enqueue'); },
        observe: async ({ sessionId, localId, onInputMaterialized }) => {
          await onInputMaterialized?.(2_000);
          return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'rejoined origin result' } };
        } },
    });
    const coordinator = createWorkflowCoordinator({ store: restored, rootInvocationRecordId: rootId, executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }) });
    await expect(coordinator.run({ runId, inputs: {}, originSessionId: 'origin', executionTarget: { kind: 'session' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [{ ...onlyStep, execution: { conversation: { kind: 'origin_session' } } }] } }))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(restored.read(key)).toMatchObject({ lifecycle: 'completed', result: 'rejoined origin result', execution: correspondence });
  });

  it.each(['acknowledged', 'delayed_response', 'lost_response'] as const)('adopts attention revisions so approval, sibling allocation and frontier completion keep the same claim (%s)', async (responseKind) => {
    const rootId = 'root-attention-claim';
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const storage = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    let releaseResponse = () => {};
    let reportApplied = () => {};
    const applied = new Promise<void>(resolve => { reportApplied = resolve; });
    const responseReleased = new Promise<void>(resolve => { releaseResponse = resolve; });
    // The HTTP boundary can apply an attention fact before its response reaches the worker.
    const delayedStorage = { execute: async (operation: WorkflowRunStorageOperation) => {
      const result = await storage.execute(operation);
      if (operation.operation === 'invocations.fact' && operation.lifecycle === 'waiting_for_approval') {
        reportApplied();
        if (responseKind === 'delayed_response') await responseReleased;
        if (responseKind === 'lost_response') throw new Error('lost_attention_response');
      }
      return result;
    } };
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: rootId, revision: storage.run().revision, storage: delayedStorage,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1',
        frontier: { nextBlockOrdinal: 0, paused: false } },
    });
    const key = workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 });
    await store.ensureIntent({ blockKind: 'step', key, recordId: 'approval-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      memberOrdinal: '0', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    await store.readCurrent({ runId, blockId: 'sibling', scope: [], memberOrdinal: '1' });
    const attention = store.commitFact({ key, lifecycle: 'waiting_for_approval' });
    await applied;
    if (responseKind !== 'delayed_response') await attention;
    try {
      await store.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId: 'sibling', scope: [], attempt: 0 }),
        recordId: 'sibling-leaf', runId, blockId: 'sibling', path: { blockId: 'sibling', scope: [] },
        memberOrdinal: '1', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    } finally {
      releaseResponse();
      await attention;
    }
    expect(store.revision).toBe(storage.run().revision);
    await store.commitFact({ key, lifecycle: 'running' });
    await store.commitFact({ key, lifecycle: 'completed', result: 'approved result' });
    await expect(store.commitFrontier({ nextBlockOrdinal: 1 })).resolves.toBeUndefined();
    expect(store.readFrontier().nextBlockOrdinal).toBe(1);
    expect(store.revision).toBe(storage.run().revision);
  });

  it('refreshes input and numeric conditions from the frozen origin through nested loop frames', async () => {
    const frozenOriginId = 'c123456789012345678901234';
    const continuedSessionId = 'c987654321098765432109876';
    const callerOriginId = 'c111111111111111111111111';
    const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: { kind: 'existing_session', sessionId: continuedSessionId, machineId },
    }, blocks: [{ kind: 'loop', id: 'rounds', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
      body: [{ kind: 'if', id: 'budget',
        when: { kind: 'compare', operator: 'lt',
          left: { kind: 'session_context_field', field: 'usage.tokensUsed' },
          right: { kind: 'session_context_field', field: 'goal.tokenBudget' },
        },
        then: [{ ...onlyStep, input: [{ kind: 'session_context', recentTurns: 0 }] }], otherwise: [],
      }],
    }] };
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
      context: { source: { kind: 'inline' }, origin: { kind: 'direct', originSessionId: frozenOriginId },
        inputs: {}, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' } },
      },
    });
    if (!materialized.ok) throw new Error(materialized.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: materialized.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId,
      origin: { kind: 'direct', originSessionId: frozenOriginId }, acceptedEnvelope });
    const credentials = { token: 'token', encryption: null } as const;
    let accountedTokens = 3;
    const sentInputs: string[] = [];
    const metadataReads: string[] = [];
    const readinessGet = vi.mocked(axios.get).getMockImplementation()!;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith(`/v1/machines/${machineId}`)) return readinessGet(url);
      if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      const sessionId = path.includes(`/v2/sessions/${frozenOriginId}`) ? frozenOriginId
        : path.includes(`/v2/sessions/${continuedSessionId}`) ? continuedSessionId : undefined;
      if (!sessionId) throw new Error(`unexpected Session metadata lookup: ${path}`);
      metadataReads.push(sessionId);
      return { status: 200, data: { session: { id: sessionId, seq: 0, createdAt: 0, updatedAt: 0,
        active: true, activeAt: 0, metadataVersion: 0, agentStateVersion: 0, agentState: null,
        dataEncryptionKey: null, encryptionMode: 'plain', metadata: JSON.stringify({ machineId, path: '/repo',
          claudeSessionId: 'native-session', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
          sessionWorkStateV1: { v: 1, backendId: 'test', updatedAt: 10, primaryItemId: 'goal', items: [{
            id: 'goal', kind: 'goal', origin: 'happier', status: 'active', title: 'Frozen origin goal',
            updatedAt: 10, tokenBudget: 50, tokensUsed: 9999, startedAt: 5, createdAt: 1,
          }] },
        }),
      } } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(String(url)).toMatch(/\/v2\/usage\/query$/u);
      expect(body).toMatchObject({ filters: { sessionIds: [frozenOriginId] }, dateRange: { startMs: 5 } });
      return { status: 200, data: { v: 1, totals: { eventCount: 1,
        tokens: { input: accountedTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: accountedTokens },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
      } } };
    });
    try {
      const execution = productionExecution({
        enqueue: async (request) => {
          expect(request.sessionId).toBe(continuedSessionId);
          sentInputs.push(request.text);
          accountedTokens = 10;
          return { status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) };
        },
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }),
      });
      const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId,
        resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
        resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        isAcceptedAuthorizationCurrent: async () => true, storage: boundary, onCommittedTransition: vi.fn(),
        execution: { ...execution, resolveExistingSessionConversation: async (identity) =>
          await resolveWorkflowSessionConversation({ credentials, ...identity }) },
        workspaceScm: { realizeWorktree: async () => { throw new Error('context does not create a worktree'); },
          inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      });
      await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, acceptedEnvelope,
        scopeSessionId: callerOriginId, accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      })).resolves.toEqual({ state: 'succeeded' });
      expect(sentInputs).toHaveLength(2);
      const capturedContexts = sentInputs.map(readPromptContext);
      expect(capturedContexts).toMatchObject([
        [{ reference: { kind: 'session_context' }, value: { usage: { kind: 'accounted', tokensUsed: 3 } } }],
        [{ reference: { kind: 'session_context' }, value: { usage: { kind: 'accounted', tokensUsed: 10 } } }],
      ]);
      for (const text of sentInputs) {
        expect(text).toContain('Frozen origin goal');
        expect(text).not.toContain('9999');
      }
      expect(metadataReads).toContain(frozenOriginId);
      expect(metadataReads).not.toContain(callerOriginId);
    } finally {
      get.mockRestore();
      post.mockRestore();
    }
  });

  it.each(['native_shared', 'retained_session'] as const)('preserves frozen authored omission for the root default worktree and nearest shared conversation owner with %s', async (scenario) => {
    const retainedSession = scenario === 'retained_session';
    const rootId = 'root-materialized-default';
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const authored = { version: 1 as const, inputs: [], defaults: {
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      conversation: retainedSession
        ? { kind: 'existing_session' as const, sessionId: 'retained-session', machineId }
        : { kind: 'shared_run' as const },
      workspace: { kind: 'new_worktree' as const, source: { kind: 'original' as const } },
    }, blocks: [{ kind: 'parallel' as const, id: 'parallel', maxConcurrent: 1, failurePolicy: 'fail_stop' as const, branches: [
      { id: 'inherited-branch', blocks: [{ ...onlyStep, id: 'inherited' }] },
      { id: 'explicit-branch', blocks: [{ ...onlyStep, id: 'explicit',
        ...(retainedSession ? {} : { execution: { conversation: { kind: 'shared_run' as const } } }) }] },
    ] }] };
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'automation', automationId: 'automation-1' }, inputs: {}, machineId,
        executionTarget: { kind: retainedSession ? 'session' : 'detached_run' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' }, originalCommittedRevision: 'a'.repeat(40) },
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
    });
    expect(materialized).toMatchObject({ ok: true });
    if (!materialized.ok) throw new Error(materialized.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: materialized.snapshot,
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'automation', automationId: 'automation-1' }, acceptedEnvelope });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
          sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
          blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
      })) } });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(boundary.acceptedEnvelope()),
    });
    if (opened.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
    const accepted = opened.content;
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: rootId, revision: boundary.run().revision,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
       storage: boundary,
    });
    await store.commitFact({ key: rootKey, lifecycle: 'running' });
    // Only SCM materialization/verification and agent execution cross external boundaries.
    const realizeWorktree = vi.fn(async (intent: WorkflowWorkspaceCreationIntentV1) => ({
      directory: `/worktrees/${intent.displayName}`, checkoutRootPath: `/worktrees/${intent.displayName}`, branchName: intent.displayName,
    }));
    const resolveWorkspace = createCoordinatorWorkspaceResolver({ store, projectWorkspace: accepted.workspaceTarget.project,
      originalCommittedRevision: accepted.workspaceTarget.originalCommittedRevision,
      scm: { realizeWorktree, inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    });
    const conversations = createProductionWorkflowConversationOwner({ machineId,
      createFreshConversation: async () => { throw new Error('unexpected_fresh_session'); },
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
      // Session metadata is reached over the authenticated server boundary.
      resolveExistingSessionConversation: async () => ({ sessionId: 'retained-session', machineId,
        directory: '/retained', agentTarget: authored.defaults.agentTarget }),
    });
    const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId,
      resolveWorkspace: async (params) => await resolveWorkspace(params),
      ...(retainedSession ? { prepareStep: async (params: Parameters<typeof conversations.prepare>[0]) => {
        const prepared = await conversations.prepare(params);
        return { ...(prepared.existing ? { conversationWorkspace: prepared.existing } : {}) };
      } } : {}),
      executeStep: async (params) => {
        const binding = params.conversationBinding;
        await params.beforeInputAdmission();
        if (retainedSession) await params.onInputAccepted({ kind: 'session', sessionId: 'retained-session', localInputId: params.step.id });
        else {
          if (binding?.kind !== 'shared') throw new Error('shared_binding_expected');
          await params.onInputAccepted({ kind: 'detached_run', runId: `native-${binding.scopeOwnerKey}`,
            localInputId: params.step.id, runtimeSelection: {} });
        }
        return { kind: 'completed', result: params.step.id };
      },
    });
    await expect(coordinator.run({ runId, definition: accepted.definition, inputs: accepted.inputs,
      executionTarget: accepted.executionTarget, authorization: accepted.authorization,
      materializedLeaves: accepted.materializedLeaves,
      authoredDefinition: accepted.authoredDefinition,
    })).resolves.toEqual({ state: 'succeeded' });
    const records = await Promise.all(boundary.rows().map(async (row) => await store.readByLogicalInvocation(row.index.id)));
    const inherited = records.find((record) => record?.blockId === 'inherited');
    const explicit = records.find((record) => record?.blockId === 'explicit');
    const inheritedBody = records.find((record) => record?.frame?.source.kind === 'branch' && record.frame.source.branchId === 'inherited-branch');
    const root = await store.readByLogicalInvocation(rootId);
    if (retainedSession) {
      expect(realizeWorktree).not.toHaveBeenCalled();
      expect(root?.workspace).toBeUndefined();
      for (const record of [inherited, explicit]) expect(record?.workspace).toEqual({ descriptor: {
        machineId, directory: '/retained', checkoutRootPath: '/retained',
      } });
      return;
    }
    expect(inheritedBody?.sharedConversationInvocationRecordId?.detached_run).toBe(inherited?.recordId);
    expect(root?.sharedConversationInvocationRecordId?.detached_run).toBe(explicit?.recordId);
    expect(realizeWorktree).toHaveBeenCalledOnce();
    expect(root?.workspace?.descriptor).toBeDefined();
    expect(inherited?.workspace).toEqual(root?.workspace);
    expect(explicit?.workspace).toEqual(root?.workspace);
  });

  it.each(['lost_response', 'pause_before_repeat'] as const)('never treats an admitting reload as release authority after %s', async (failure) => {
    const rootId = 'root-admission';
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const lostResponse = new Error('admission_acknowledgement_lost');
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: 1,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
       storage: { execute: async (operation: WorkflowRunStorageOperation) => {
        const result = await boundary.execute(operation);
        if (failure === 'lost_response' && operation.operation === 'invocations.fact' && operation.lifecycle === 'admitting') throw lostResponse;
        return result;
      } },
    });
    const key = workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 });
    await store.ensureIntent({ blockKind: 'step', key, recordId: 'pending-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      memberOrdinal: '0', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    if (failure === 'pause_before_repeat') {
      await store.commitFact({ key, lifecycle: 'admitting' });
      boundary.requestControl('pause_requested');
    }
    await expect(store.commitFact({ key, lifecycle: 'admitting' })).rejects.toThrow();
    expect(store.read(key)?.lifecycle).toBe('admitting');
  });

  it.each(['session', 'action', 'immediate_action', 'unrelated_immediate_action', 'command', 'foreign_command', 'terminal_command', 'different_attempt'] as const)('merges only exact late %s acceptance into refreshed cancellation custody without losing row content', async (kind) => {
    const command = kind === 'command' || kind === 'foreign_command' || kind === 'terminal_command' || kind === 'different_attempt';
    const rootId = 'root-origin-cancel-race';
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct', originSessionId: 'origin' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: boundary.run().revision,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
       storage: boundary,
    });
    const key = workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 });
    const immediate = kind === 'immediate_action' || kind === 'unrelated_immediate_action';
    const commandOutput = { exitCode: -1, stdout: 'partial stdout', stderr: 'partial stderr' };
    const correspondence: WorkflowExecutionCorrespondenceV1 = kind === 'session'
      ? { kind: 'session', sessionId: 'origin', localInputId: 'origin-input' }
      : { kind: 'action', actionId: (immediate || command) ? 'machines.command.run' : 'review.start', actionRequestId: 'action-request', localInputId: 'action-request', input: {} };
    const acknowledgement: WorkflowExecutionCorrespondenceV1 = correspondence.kind === 'action'
      ? immediate
        ? { ...correspondence, ...(kind === 'unrelated_immediate_action' ? { actionRequestId: 'unrelated-request' } : {}), output: commandOutput }
        : { ...correspondence, output: { results: [{ key: 'codex', ok: true, result: { runId: 'native-review' } }] },
          awaitedRuns: [{ key: 'codex', runId: 'native-review' }] } : correspondence;
    const intent = await store.ensureIntent({ key, recordId: 'origin-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      blockKind: kind === 'session' ? 'step' : 'action', memberOrdinal: '0', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'admitting', execution: correspondence,
      input: { document: onlyStep.document, input: [] }, resultContract: onlyStep.result });
    boundary.requestControl('cancel_requested');
    const swept = boundary.rowById(intent.recordId)!;
    const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId: swept.index.id,
      sequence: swept.index.sequence, parentRecordId: swept.index.parentRecordId, memberOrdinal: swept.index.memberOrdinal, attempt: swept.index.attempt };
    const current = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
      envelope: parseWorkflowStoredContentEnvelopeV1(swept.contentEnvelope) });
    if (current.kind !== 'available') throw new Error('expected readable current row');
    // A concurrent owner may publish into the same opaque row before this
    // host acceptance reaches the daemon; the merge must use current bytes.
    await boundary.execute({ operation: 'invocations.fact', runId, parentAttempt: 0,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      invocationId: swept.index.id, invocationAttempt: swept.index.attempt,
      expectedContentRevision: swept.index.contentRevision, expectedLifecycle: 'cancel_requested', lifecycle: 'cancel_requested',
      contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding, progress: { ...current.content,
          ...(!immediate && !command ? { result: 'published before acknowledgement' } : {}),
          interaction: command ? { permission: 'published before acknowledgement' } : { message: 'concurrent row content' },
          ...(kind === 'foreign_command' && correspondence.kind === 'action'
            ? { execution: { ...correspondence, actionRequestId: 'another-action-request' } } : {}) },
      })),
    });
    if (command) {
      if (kind === 'terminal_command') {
        const row = boundary.rowById(intent.recordId)!;
        await boundary.execute({ operation: 'invocations.fact', runId, parentAttempt: 0,
          accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
          invocationId: row.index.id, invocationAttempt: row.index.attempt,
          expectedContentRevision: row.index.contentRevision, expectedLifecycle: 'cancel_requested', lifecycle: 'cancelled',
          contentEnvelope: row.contentEnvelope });
      }
      if (kind === 'different_attempt') {
        // Seed a newer stored attempt at the opaque HTTP/database boundary.
        // Its content binding no longer grants the old attempt write authority.
        const row = boundary.rowById(intent.recordId)!;
        row.index.attempt = '1';
        row.contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
          mode: 'plain', binding: { ...binding, attempt: '1' }, progress: { ...current.content, attempt: '1', previousAttemptRecordId: 'prior-command-attempt' },
        }));
      }
      const result = { exitCode: -1, stdout: 'printed before Stop', stderr: '' };
      const retained = store.commitFact({ key, lifecycle: 'cancelled', reason: 'command_cancelled', result });
      if (kind !== 'command') {
        await expect(retained).rejects.toThrow();
        expect(boundary.rowById(intent.recordId)!.index.lifecycle).toBe(kind === 'terminal_command' ? 'cancelled' : 'cancel_requested');
        expect(store.read(key)?.result).not.toEqual(result);
        return;
      }
      await expect(retained).resolves.toMatchObject({ lifecycle: 'cancelled', reason: 'command_cancelled', result });
      const committed = boundary.rowById(intent.recordId)!;
      expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
        envelope: parseWorkflowStoredContentEnvelopeV1(committed.contentEnvelope) }))
        .toMatchObject({ kind: 'available', content: { execution: correspondence, result,
          reason: { code: 'command_cancelled' }, input: { document: onlyStep.document, input: [] }, resultContract: onlyStep.result,
          interaction: { permission: 'published before acknowledgement' } } });
      return;
    }
    const observationDeadline = { kind: 'at' as const, expiresAt: '2026-01-01T00:00:10.000Z' };
    const commit = store.commitFact({ key, lifecycle: immediate ? 'cancelled' : 'running', execution: acknowledgement,
      ...(immediate ? { result: commandOutput, reason: 'command_cancelled' } : { observationDeadline }) });
    if (kind === 'unrelated_immediate_action') {
      await expect(commit).rejects.toThrow('cancelled');
      expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
        envelope: parseWorkflowStoredContentEnvelopeV1(boundary.rowById(intent.recordId)!.contentEnvelope) }))
        .toMatchObject({ kind: 'available', content: { execution: correspondence, interaction: { message: 'concurrent row content' } } });
      return;
    }
    const expectedResult = immediate ? commandOutput : 'published before acknowledgement';
    await expect(commit)
      .resolves.toMatchObject({ lifecycle: immediate ? 'cancelled' : 'cancel_requested', execution: acknowledgement,
        ...(immediate ? { reason: 'command_cancelled' } : { observationDeadline }), result: expectedResult });
    const committed = boundary.rowById(intent.recordId)!;
    expect(committed.index.lifecycle).toBe(immediate ? 'cancelled' : 'cancel_requested');
    expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
      envelope: parseWorkflowStoredContentEnvelopeV1(committed.contentEnvelope) }))
      .toMatchObject({ kind: 'available', content: { execution: acknowledgement, ...(immediate ? {} : { observationDeadline }),
        input: { document: onlyStep.document, input: [] }, resultContract: onlyStep.result,
        interaction: { message: 'concurrent row content' }, result: expectedResult } });
  });

  it('binds the default Workflow push client to the active Home', async () => {
    const release = publishServerHttpRuntimeOrigin('https://active-home.example.test/', 'https');
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { tokens: [] } });
    try {
      const client = createWorkflowRunPushNotificationClient('token-1');
      await expect(client.fetchPushTokens()).resolves.toEqual([]);
      expect(get).toHaveBeenCalledWith(
        'https://active-home.example.test/v1/push-tokens',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-1' }) }),
      );
    } finally {
      get.mockRestore();
      release();
    }
  });

  it('persists independent class pointers beside the default workspace and replays a fresh rebind without writes', async () => {
    const rootId = 'root-class-pointers';
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const workspace = {
      creationIntent: { kind: 'git_worktree', sourceDirectory: '/repo', baseRef: 'a'.repeat(40),
        displayName: 'workflow-default', branchMode: 'new' },
      descriptor: { machineId, directory: '/worktrees/default/packages/app', checkoutRootPath: '/worktrees/default',
        checkout: { kind: 'git_worktree', branchName: 'workflow-default' } },
    } satisfies WorkflowWorkspaceProgressV1;
    const rootBinding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId,
      recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: rootBinding,
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
          blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId, workspace },
      })) } });
    const load = (checkpoint: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]['checkpoint']) =>
      DurableWorkflowCoordinatorStore.load({
        accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: boundary.run().revision,
        encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
        checkpoint,
        storage: boundary,
      });
    const store = await load({ kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId,
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } });
    await store.commitFact({ key: rootKey, lifecycle: 'running' });
    const admit = async (blockId: string, ordinal: string, execution?: WorkflowExecutionCorrespondenceV1) =>
      store.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId, scope: [], attempt: 0 }),
        recordId: `inv-${blockId}`, runId, blockId, path: { blockId, scope: [] }, attempt: 0,
        memberOrdinal: ordinal, parentKey: rootKey, acceptedAtMs: 1, lifecycle: execution ? 'running' : 'pending', ...(execution ? { execution } : {}) });
    const originalExecution = { kind: 'session', sessionId: 'session-original', localInputId: 'input-original' } satisfies WorkflowExecutionCorrespondenceV1;
    const detachedExecution = { kind: 'detached_run', runId: 'native-detached', localInputId: 'input-detached', runtimeSelection: {} } satisfies WorkflowExecutionCorrespondenceV1;
    const replacementExecution = { kind: 'session', sessionId: 'session-replacement', localInputId: 'input-replacement' } satisfies WorkflowExecutionCorrespondenceV1;
    const original = await admit('session-first', '0', originalExecution);
    const detached = await admit('detached', '1', detachedExecution);
    const replacement = await admit('session-replacement', '2', replacementExecution);
    const unexecuted = await admit('not-started', '3');
    await expect(store.commitSharedConversation({ scopeOwnerKey: rootId, targetClass: 'session', invocationRecordId: detached.recordId }))
      .rejects.toMatchObject({ message: 'workflow_conversation_unavailable', details: { reason: 'target_kind_mismatch',
        expected: { kind: 'session' }, observed: { kind: 'detached_run' } } });
    await store.commitFact({ key: rootKey, lifecycle: 'running', sharedConversationInvocationRecordId: { session: unexecuted.recordId } });
    await expect(store.resolveSharedInvocation({ kind: 'shared', scopeOwnerKey: rootId, targetClass: 'session' }))
      .rejects.toMatchObject({ message: 'workflow_conversation_unavailable', details: { reason: 'session_unavailable' } });
    await expect(store.commitSharedConversation({ scopeOwnerKey: rootId, targetClass: 'session', invocationRecordId: original.recordId }))
      .rejects.toMatchObject({ message: 'workflow_conversation_unavailable', details: { reason: 'recovery_execution_missing' } });
    await store.commitFact({ key: rootKey, lifecycle: 'running', sharedConversationInvocationRecordId: { session: original.recordId } });
    await store.commitSharedConversation({ scopeOwnerKey: rootId, targetClass: 'session', invocationRecordId: original.recordId });
    await store.commitSharedConversation({ scopeOwnerKey: rootId, targetClass: 'detached_run', invocationRecordId: detached.recordId });

    const reopened = await load({ ...store.checkpoint });
    const shared = (targetClass: 'session' | 'detached_run') => ({ kind: 'shared' as const, scopeOwnerKey: rootId, targetClass });
    await expect(reopened.resolveSharedInvocation(shared('session'))).resolves.toMatchObject({ recordId: original.recordId, execution: originalExecution });
    await expect(reopened.resolveSharedInvocation(shared('detached_run'))).resolves.toMatchObject({ recordId: detached.recordId, execution: detachedExecution });
    expect(reopened.read(rootKey)).toMatchObject({ workspace, sharedConversationInvocationRecordId: {
      session: original.recordId, detached_run: detached.recordId,
    } });
    expect(reopened.read(rootKey)?.execution).toBeUndefined();

    // The recovery admitter supplies the new exact leaf and the previous
    // target; the pointer owner changes only this class's future binding.
    const rebind = { scopeOwnerKey: rootId, targetClass: 'session' as const,
      invocationRecordId: replacement.recordId, replacesExecution: originalExecution };
    const beforeRebind = boundary.calls.length;
    await Promise.all([reopened.commitSharedConversation(rebind), reopened.commitSharedConversation(rebind)]);
    expect(boundary.calls.slice(beforeRebind).filter((operation) => operation.operation === 'invocations.fact')).toHaveLength(1);
    await expect(reopened.resolveSharedInvocation(shared('session'))).resolves.toMatchObject({ recordId: replacement.recordId, execution: replacementExecution });
    await expect(reopened.resolveSharedInvocation(shared('detached_run'))).resolves.toMatchObject({ recordId: detached.recordId, execution: detachedExecution });
    await expect(reopened.readByLogicalInvocation(original.recordId)).resolves.toMatchObject({ execution: originalExecution });

    const sealedRoot = boundary.rowById(rootId)?.contentEnvelope;
    if (!sealedRoot) throw new Error('Missing sealed scope owner');
    const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: rootBinding,
      envelope: parseWorkflowStoredContentEnvelopeV1(sealedRoot) });
    expect(opened).toMatchObject({ kind: 'available', content: { workspace,
      sharedConversationInvocationRecordId: { session: replacement.recordId, detached_run: detached.recordId } } });
    const replayed = await load({ ...reopened.checkpoint });
    const beforeReplay = boundary.calls.length;
    await replayed.commitSharedConversation(rebind);
    await replayed.commitSharedConversation(rebind);
    await expect(replayed.resolveSharedInvocation(shared('session'))).resolves.toMatchObject({ recordId: replacement.recordId, execution: replacementExecution });
    await expect(replayed.resolveSharedInvocation(shared('detached_run'))).resolves.toMatchObject({ recordId: detached.recordId, execution: detachedExecution });
    expect(boundary.calls.slice(beforeReplay).filter((operation) => (
      operation.operation === 'invocations.fact' || operation.operation === 'invocations.admit' || operation.operation === 'transition'
    ))).toEqual([]);
    expect(boundary.rowById(rootId)?.contentEnvelope).toBe(sealedRoot);
    expect(boundary.rows()).toHaveLength(5);
  });

  it.each(['before_mutation', 'after_mutation'] as const)('acknowledges a pointer-only fact only when its sealed mutation applied after %s', async (failure) => {
    const rootId = 'root-pointer-ack';
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    const storageFailure = new Error('pointer_storage_response_lost');
    let failNextPointerWrite = true;
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: boundary.run().revision,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
       storage: { execute: async (operation: WorkflowRunStorageOperation) => {
        // Fault only the transport boundary; real sealing, store publication,
        // and the server-shaped durable row owner remain in the path.
        if (failNextPointerWrite && operation.operation === 'invocations.fact' && operation.invocationId === rootId) {
          failNextPointerWrite = false;
          if (failure === 'after_mutation') await boundary.execute(operation);
          throw storageFailure;
        }
        return await boundary.execute(operation);
      } },
    });
    const execution = { kind: 'session', sessionId: 'pointer-session', localInputId: 'pointer-input' } satisfies WorkflowExecutionCorrespondenceV1;
    const leaf = await store.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 }),
      recordId: 'pointer-leaf', runId, blockId: 'work', path: { blockId: 'work', scope: [] },
      memberOrdinal: '0', parentKey: rootKey, attempt: 0, acceptedAtMs: 1, lifecycle: 'running', execution });
    const publication = { scopeOwnerKey: rootId, targetClass: 'session' as const, invocationRecordId: leaf.recordId };
    const binding = { kind: 'shared' as const, scopeOwnerKey: rootId, targetClass: 'session' as const };
    if (failure === 'before_mutation') {
      await expect(store.commitSharedConversation(publication)).rejects.toBe(storageFailure);
      expect(boundary.rowById(rootId)?.contentEnvelope).toBe(rootEnvelope);
      await expect(store.resolveSharedInvocation(binding)).resolves.toBeNull();
    } else {
      await expect(store.commitSharedConversation(publication)).resolves.toBeUndefined();
      await expect(store.resolveSharedInvocation(binding)).resolves.toMatchObject({ recordId: leaf.recordId, execution });
    }
    await store.commitSharedConversation(publication);
    await expect(store.resolveSharedInvocation(binding)).resolves.toMatchObject({ recordId: leaf.recordId, execution });
    const sealedRoot = boundary.rowById(rootId)?.contentEnvelope;
    const beforeReplay = boundary.calls.length;
    await store.commitSharedConversation(publication);
    expect(boundary.calls.slice(beforeReplay).filter((operation) => operation.operation === 'invocations.fact')).toEqual([]);
    expect(boundary.rowById(rootId)?.contentEnvelope).toBe(sealedRoot);
    expect(store.read(rootKey)?.lifecycle).toBe('pending');
  });

  it.each([
    { pointer: 'present', defaultTarget: 'detached_run' },
    { pointer: 'absent', defaultTarget: 'detached_run' },
    { pointer: 'present', defaultTarget: 'session' },
  ] as const)('reserves recovered native input before a fresh earlier branch with a $pointer pointer under a $defaultTarget default', async ({ pointer, defaultTarget }) => {
    const rootId = 'root-native-restart';
    const parallelId = 'parallel-native-restart';
    const bodyId = 'body-native-restart';
    const recoveredId = 'leaf-native-restart';
    const producerId = 'producer-native-restart';
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const parallelKey = workflowInvocationKey({ runId, blockId: 'parallel', scope: [], attempt: 0 });
    const scope = [{ kind: 'branch' as const, blockId: 'parallel', branchId: 'recovered' }];
    const bodyKey = workflowInvocationKey({ runId, blockId: 'parallel', scope, attempt: 0 });
    const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
    const retainedAgentTarget = { kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const execution = { kind: 'detached_run', runId: 'native-owned', localInputId: 'input-owned',
      runtimeSelection: { agentTarget: retainedAgentTarget } } satisfies WorkflowExecutionCorrespondenceV1;
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint',
      rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
          sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
          blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId, workspace: { descriptor: workspace } },
      })) } });
    const load = (checkpoint: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]['checkpoint'],
      storage: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]['storage']) => DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, rootRecordId: rootId, revision: boundary.run().revision,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } }, checkpoint, storage,
    });
    const seed = await load({ kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId,
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } }, boundary);
    await seed.commitFact({ key: rootKey, lifecycle: 'running' });
    if (defaultTarget === 'session') {
      const producerKey = workflowInvocationKey({ runId, blockId: 'producer', scope: [], attempt: 0 });
      await seed.ensureIntent({ blockKind: 'step', key: producerKey, recordId: producerId, runId, blockId: 'producer',
        path: { blockId: 'producer', scope: [] }, parentKey: rootKey, memberOrdinal: '0', attempt: 0, acceptedAtMs: 1,
        lifecycle: 'running', execution, input: { document: onlyStep.document, input: [] }, workspace: { descriptor: workspace } });
      await seed.commitFact({ key: producerKey, lifecycle: 'completed', result: 'producer' });
    }
    await seed.ensureIntent({ blockKind: 'parallel', key: parallelKey, recordId: parallelId, runId, blockId: 'parallel',
      path: { blockId: 'parallel', scope: [] }, parentKey: rootKey, memberOrdinal: defaultTarget === 'session' ? '1' : '0', attempt: 0, acceptedAtMs: 1,
      lifecycle: 'running', container: { kind: 'parallel', nextBranchOrdinal: '2' } });
    await seed.ensureIntent({ blockKind: 'parallel', key: bodyKey, recordId: bodyId, runId, blockId: 'parallel',
      path: { blockId: 'parallel', scope }, parentKey: parallelKey, memberOrdinal: '1', attempt: 0, acceptedAtMs: 1,
      lifecycle: 'running', frame: { ownerBlockId: 'parallel', source: { kind: 'branch', branchId: 'recovered' } },
      container: { kind: 'body', nextBlockOrdinal: '0' } });
    await seed.ensureIntent({ blockKind: 'step', key: workflowInvocationKey({ runId, blockId: 'owned', scope, attempt: 0 }),
      recordId: recoveredId, runId, blockId: 'owned', path: { blockId: 'owned', scope }, parentKey: bodyKey,
      memberOrdinal: '0', attempt: 0, acceptedAtMs: 1, lifecycle: 'running', execution,
      input: { document: onlyStep.document, input: [] }, workspace: { descriptor: workspace } });
    if (pointer === 'present') await seed.commitSharedConversation({ scopeOwnerKey: rootId,
      targetClass: 'detached_run', invocationRecordId: defaultTarget === 'session' ? producerId : recoveredId });

    let releaseLookup!: () => void;
    const lookupHeld = new Promise<void>((resolve) => { releaseLookup = resolve; });
    let notifyLookup!: () => void;
    const lookupEntered = new Promise<void>((resolve) => { notifyLookup = resolve; });
    let releaseNative!: () => void;
    const nativeHeld = new Promise<void>((resolve) => { releaseNative = resolve; });
    let notifyObserved!: () => void;
    const recoveredObserved = new Promise<void>((resolve) => { notifyObserved = resolve; });
    const store = await load({ ...seed.checkpoint }, { execute: async (operation: WorkflowRunStorageOperation) => {
      // Slow the genuine exact DB lookup, not the internal binder or store.
      if (operation.operation === 'invocations.current' && operation.parentRecordId === bodyId && operation.memberOrdinal === '0') {
        notifyLookup();
        await lookupHeld;
      }
      return await boundary.execute(operation);
    } });
    const events: string[] = [];
    const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId,
      allocateInvocationRecordId: (() => { let ordinal = 0; return () => `new-restart-${ordinal++}`; })(),
      resolveWorkspace: async () => ({ ok: true, workspace }),
      prepareStep: async ({ step }) => { events.push(`prepare:${step.id}`); return {}; },
      executeStep: async (params) => {
        if (params.step.id === 'owned') {
          expect(params.invocation.execution).toEqual(execution);
          events.push('observe:owned');
          notifyObserved();
          await nativeHeld;
          events.push('settle:owned');
        } else {
          await params.beforeInputAdmission();
          events.push('admit:new');
          const binding = params.conversationBinding;
          const retained = binding?.kind === 'shared' ? await store.resolveSharedInvocation(binding)
            : binding?.kind === 'from_step' ? await params.producerBinding?.resolve(binding.producer) : undefined;
          if (!retained && binding?.kind !== 'shared') throw new Error('Missing retained binding');
          await params.onInputAccepted({ ...execution, runId: retained?.execution?.kind === 'detached_run'
            ? retained.execution.runId : 'incorrect-fresh-native', localInputId: 'input-new' });
        }
        return { kind: 'completed', result: params.step.id };
      },
    });
    const conversation = defaultTarget === 'session'
      ? { kind: 'from_step' as const, producer: { blockId: 'producer', scope: { kind: 'outer' as const, levels: 1 } } }
      : { kind: 'shared_run' as const };
    const freshStep = { ...onlyStep, id: 'new', execution: { conversation } };
    const recoveredStep = { ...onlyStep, id: 'owned', execution: { conversation } };
    const definition = { version: 1, inputs: [], defaults: { agentTarget: retainedAgentTarget }, blocks: [
      ...(defaultTarget === 'session' ? [{ ...onlyStep, id: 'producer' }] : []),
      { kind: 'parallel', id: 'parallel', failurePolicy: 'fail_stop',
        branches: [{ id: 'fresh', blocks: [freshStep] }, { id: 'recovered', blocks: [recoveredStep] }] },
    ] } satisfies WorkflowDefinitionV1;
    const materializedLeaves = ['producer', 'owned', 'new'].map((blockId) => ({ authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId,
      kind: 'step' as const, selection: { agentTarget: retainedAgentTarget,
        ...(blockId === 'producer' ? {} : { conversation }) },
      executionTarget: { kind: 'detached_run' as const } })) satisfies WorkflowMaterializedLeafV1[];
    const run = { runId, definition, inputs: {}, executionTarget: { kind: defaultTarget },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
      ...(defaultTarget === 'session' ? { materializedLeaves } : {}) };
    const running = coordinator.run(run);
    const until = (event: Promise<void>) => Promise.race([event, running.then(() => {
      throw new Error('Workflow settled before the restart handshake');
    })]);
    try {
      await until(lookupEntered);
      // Every unblocked boundary above resolves synchronously. One event-loop
      // turn drains that work without a timing budget or a negative waitFor.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const duringLookup = [...events];
      releaseLookup();
      await until(recoveredObserved);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const duringNative = [...events];
      releaseNative();
      await expect(running).resolves.toMatchObject({ state: 'succeeded' });
      expect(duringLookup).toEqual([]);
      expect(duringNative).toEqual(['observe:owned']);
      expect(events).toEqual(['observe:owned', 'settle:owned', 'prepare:new', 'admit:new']);
      await expect(store.resolveSharedInvocation({ kind: 'shared', scopeOwnerKey: rootId, targetClass: 'detached_run' }))
        .resolves.toMatchObject({ recordId: defaultTarget === 'session' ? producerId : recoveredId, execution });
    } finally {
      releaseLookup();
      releaseNative();
      await running;
    }
  });

  it('loads one exact greatest-attempt parent slot without paging preceding siblings again', async () => {
    const rootId = 'root-current-slot';
    const currentId = 'attempt-current-slot';
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const currentIndex = {
      id: currentId, runId, sequence: '501', parentRecordId: rootId, memberOrdinal: '499', attempt: '3',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const decoyIndex = { ...currentIndex, id: 'other-slot-attempt', memberOrdinal: '500', attempt: '4' };
    const sealProgress = (
      index: typeof rootIndex | typeof currentIndex,
      blockId: '$root' | 'work',
    ) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1, purpose: 'invocation_progress', accountId, runId,
        recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
        memberOrdinal: index.memberOrdinal, attempt: index.attempt,
      },
      progress: {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId, scope: index.id === currentId
          ? [{ kind: 'branch', blockId: 'parallel-owner', branchId: 'selected-branch' }] : [] },
        blockKind: blockId === '$root' ? 'root' : 'step', attempt: index.attempt,
        logicalInvocationRecordId: blockId === '$root' ? rootId : 'attempt-original-slot',
        ...(blockId === '$root' ? {} : { previousAttemptRecordId: 'attempt-previous-slot' }),
      },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') {
        if (operation.invocationId === decoyIndex.id) {
          return { invocation: { index: decoyIndex, contentEnvelope: sealProgress(decoyIndex, 'work') } };
        }
        return { invocation: { index: rootIndex, contentEnvelope: sealProgress(rootIndex, '$root') } };
      }
      if (operation.operation === 'invocations.current') {
        return { invocation: { index: currentIndex, contentEnvelope: sealProgress(currentIndex, 'work') } };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '502', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 3,
    });

    const lookup = { runId, blockId: 'work', scope: [], parentKey: workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }), memberOrdinal: '499' };
    await store.readByLogicalInvocation(decoyIndex.id);
    await expect(store.readCurrent(lookup)).resolves.toMatchObject({ recordId: currentId, attempt: 3 });
    await expect(store.readCurrent(lookup)).resolves.toMatchObject({ recordId: currentId, attempt: 3 });
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.current')).toHaveLength(1);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.list')).toBe(false);
  });

  it.each(['inherited', 'replacement', 'skipped'] as const)('selects the nearest child slot through successive recovered structural parents after restart (%s)', async selection => {
    const rootId = 'root-structural-recovery';
    const oldParentId = 'parallel-old';
    const middleParentId = 'parallel-middle';
    const newParentId = 'parallel-new';
    const childId = 'successful-child';
    const makeIndex = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string, attempt: string, lifecycle: 'running' | 'pending' | 'completed' | 'superseded' | 'skipped') => ({
      id, runId, sequence, parentRecordId, memberOrdinal, attempt, contentRevision: '0', lifecycle, createdAt: now, updatedAt: now,
    });
    const rootIndex = makeIndex(rootId, '0', null, '0', '0', 'running');
    const oldParentIndex = makeIndex(oldParentId, '1', rootId, '0', '0', 'superseded');
    const middleParentIndex = makeIndex(middleParentId, '2', rootId, '0', '1', 'superseded');
    const newParentIndex = makeIndex(newParentId, '3', rootId, '0', '2', 'pending');
    const childIndex = makeIndex(childId, '4', oldParentId, '0', '0', 'completed');
    const replacement = makeIndex('replacement-child', '5', newParentId, '0', '1', selection === 'skipped' ? 'skipped' : 'completed');
    const selectedChild = selection === 'inherited' ? childIndex : replacement;
    const progress = (index: ReturnType<typeof makeIndex>, blockId: string, blockKind: 'root' | 'parallel' | 'step', previousAttemptRecordId?: string) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: {
          v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id,
          sequence: index.sequence, parentRecordId: index.parentRecordId,
          memberOrdinal: index.memberOrdinal, attempt: index.attempt,
        },
        progress: {
          kind: 'happier.workflow-progress.v1', invocationPath: { blockId, scope: [] }, blockKind,
          attempt: index.attempt, logicalInvocationRecordId: blockId === 'parallel-1' ? oldParentId : blockKind === 'step' ? childId : index.id,
          ...(previousAttemptRecordId ? { previousAttemptRecordId } : {}),
          ...(blockKind === 'parallel' ? { container: { kind: 'parallel' as const, nextBranchOrdinal: '0' } } : {}),
          ...(blockKind === 'step' ? { result: 'kept', replyOutcome: { kind: 'answer' as const,
            result: { sessionId: 'reviewer-session', messageId: 'committed-answer' } } } : {}),
        },
      }));
    const details = new Map([
      [rootId, { index: rootIndex, contentEnvelope: progress(rootIndex, '$root', 'root') }],
      [oldParentId, { index: oldParentIndex, contentEnvelope: progress(oldParentIndex, 'parallel-1', 'parallel') }],
      [middleParentId, { index: middleParentIndex, contentEnvelope: progress(middleParentIndex, 'parallel-1', 'parallel', oldParentId) }],
      [newParentId, { index: newParentIndex, contentEnvelope: progress(newParentIndex, 'parallel-1', 'parallel', middleParentId) }],
    ]);
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') return { invocation: details.get(String(operation.invocationId)) };
      if (operation.operation === 'invocations.list') return { invocations: operation.parentRecordId === oldParentId ? [childIndex]
        : operation.parentRecordId === newParentId && selection !== 'inherited' ? [replacement] : [] };
      if (operation.operation === 'invocations.current') {
        if (operation.parentRecordId === newParentId && selection !== 'inherited') return { invocation: {
          index: replacement, contentEnvelope: progress(replacement, 'successful-step', 'step', childId) } };
        if (operation.parentRecordId === newParentId || operation.parentRecordId === middleParentId) return { invocation: null };
        if (operation.parentRecordId === oldParentId) return { invocation: { index: childIndex, contentEnvelope: progress(childIndex, 'successful-step', 'step') } };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '5', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 2,
    });
    await store.readByLogicalInvocation(newParentId);
    await expect(store.readCurrent({
      runId, blockId: 'successful-step', scope: [],
      parentKey: workflowInvocationKey({ runId, blockId: 'parallel-1', scope: [], attempt: 2 }),
      memberOrdinal: '0',
    })).resolves.toMatchObject({ recordId: selectedChild.id, lifecycle: selectedChild.lifecycle, result: 'kept',
      replyOutcome: { kind: 'answer', result: { sessionId: 'reviewer-session', messageId: 'committed-answer' } } });
    await expect(store.listCurrentMembers(workflowInvocationKey({ runId, blockId: 'parallel-1', scope: [], attempt: 2 })))
      .resolves.toEqual([selectedChild]);
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.current')
      .map(([operation]) => operation.parentRecordId)).toEqual(selection === 'inherited' ? [newParentId, middleParentId, oldParentId] : [newParentId]);
  });

  it('reads user cancellation only from the root control fact, not a descendant fail-stop request', async () => {
    const rootId = 'root-control';
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') {
        return { invocation: { index: rootIndex, contentEnvelope: rootEnvelope } };
      }
      if (operation.operation === 'get') return {
        run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'running', revision: 3, machineId: 'machine-1',
          attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
          workflowCustodyState: 'pending', originDeliveryAckRevision: null, availability,
          createdAt: now, updatedAt: now },
        acceptedEnvelope: '{}', checkpointEnvelope: null, resultEnvelope: null,
        keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId, accountId }),
      };
      if (operation.operation === 'invocations.list') return {
        invocations: [{ ...rootIndex, id: 'descendant-stop', parentRecordId: rootId, lifecycle: 'cancel_requested' }],
      };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 3,
    });

    await expect(store.readControl()).resolves.toBe('running');
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.list')).toBe(false);
  });

  it('reloads the exact previous attempt for same-conversation retry preparation after restart', async () => {
    const rootId = 'root-retry';
    const previousId = 'attempt-0';
    const retryId = 'attempt-1';
    const workspace = { machineId, directory: '/repo/retry', checkoutRootPath: '/repo/retry' };
    const execution = { kind: 'session' as const, sessionId: 'session-previous', localInputId: 'input-previous' };
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const previousIndex = {
      id: previousId, runId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0',
      // Retry storage atomically supersedes the failed row when creating its replacement.
      contentRevision: '1', lifecycle: 'superseded' as const, createdAt: now, updatedAt: now,
    };
    let retryIndex = {
      id: retryId, runId, sequence: '2', parentRecordId: rootId, memberOrdinal: '0', attempt: '1',
      contentRevision: '0', lifecycle: 'admitting' as const, createdAt: now, updatedAt: now,
    };
    const sealProgress = (
      index: typeof rootIndex | typeof previousIndex | typeof retryIndex,
      progress: import('@happier-dev/protocol').WorkflowProgressEnvelopeV1,
    ) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1, purpose: 'invocation_progress', accountId, runId,
        recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
        memberOrdinal: index.memberOrdinal, attempt: index.attempt,
      },
      progress,
    }));
    const rows = new Map([
      [rootId, { index: rootIndex, contentEnvelope: sealProgress(rootIndex, {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId,
      }) }],
      [previousId, { index: previousIndex, contentEnvelope: sealProgress(previousIndex, {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '0', logicalInvocationRecordId: previousId,
        execution, workspace: { descriptor: workspace },
        usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.04 },
      }) }],
      [retryId, { index: retryIndex, contentEnvelope: sealProgress(retryIndex, {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '1', logicalInvocationRecordId: previousId,
        previousAttemptRecordId: previousId,
        recovery: { conversation: 'same_conversation', input: { kind: 'original' } },
      }) }],
    ]);
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.list') {
        // The parent-slot projection intentionally contains only the newest attempt.
        return { invocations: [retryIndex], parentRevision: 3 };
      }
      if (operation.operation === 'invocations.current') {
        return { invocation: rows.get(retryId), parentRevision: 3 };
      }
      if (operation.operation === 'invocations.get') {
        const row = rows.get(operation.invocationId as string);
        if (!row) throw new Error('unexpected_invocation');
        return { invocation: row, parentRevision: 3 };
      }
      if (operation.operation === 'invocations.fact') {
        const row = rows.get(retryId)!;
        retryIndex = { ...retryIndex, lifecycle: operation.lifecycle as typeof retryIndex.lifecycle };
        row.index = retryIndex;
        row.contentEnvelope = operation.contentEnvelope as string;
        return { ...retryIndex, parentRevision: 3 };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '3', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 3,
    });
    const prepareStep = vi.fn(async () => ({ failure: { kind: 'needs_attention' as const, code: 'stop_after_prepare' } }));
    const executeStep = vi.fn(async () => ({ kind: 'completed' as const, result: 'must-not-replay' }));
    const coordinator = createWorkflowCoordinator({
      store,
      prepareStep,
      executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace }),
    });

    await expect(coordinator.run({
      runId,
      definition: {
        version: 1, inputs: [],
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
        blocks: [onlyStep],
      },
      inputs: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
    })).resolves.toEqual({ state: 'interrupted', reason: 'stop_after_prepare' });
    expect(prepareStep).toHaveBeenCalledWith(expect.objectContaining({
      invocationRecordId: retryId,
      recoveryPreviousExecution: execution,
      recoveryPreviousWorkspace: workspace,
    }));
    expect(executeStep).not.toHaveBeenCalled();
    expect(execute.mock.calls
      .map(([operation]) => operation)
      .filter((operation) => operation.operation === 'invocations.get')
      .map((operation) => operation.invocationId)).toEqual([rootId, previousId]);
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.current')).toHaveLength(1);
    await expect(store.readByLogicalInvocation(previousId)).resolves.toMatchObject({
      usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.04 },
    });
  });

  it('keeps exact prior-attempt Account and row binding validation on cache-miss reload', async () => {
    const rootId = 'root-binding';
    const previousId = 'attempt-binding';
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const previousIndex = {
      id: previousId, runId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'failed' as const, createdAt: now, updatedAt: now,
    };
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    }));
    const wronglyBoundPreviousEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-other', runId,
        recordId: previousId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'work', scope: [] },
        blockKind: 'step', attempt: '0', logicalInvocationRecordId: previousId },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation !== 'invocations.get') throw new Error(`unexpected:${String(operation.operation)}`);
      return operation.invocationId === rootId
        ? { invocation: { index: rootIndex, contentEnvelope: rootEnvelope }, parentRevision: 0 }
        : { invocation: { index: previousIndex, contentEnvelope: wronglyBoundPreviousEnvelope }, parentRevision: 0 };
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 0,
    });

    await expect(store.readByLogicalInvocation(previousId)).rejects.toThrow('workflow_invocation_content_unavailable');
  });

  it('persists an exact invocation permission request without replacing its result', async () => {
    const rootId = 'root-interaction';
    const rootIndex = {
      id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const, createdAt: now, updatedAt: now,
    };
    const binding = {
      v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId,
      recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0',
    };
    let persistedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding, progress: {
        kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId, result: { changed: true },
      },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') {
        return { invocation: { index: rootIndex, contentEnvelope: persistedEnvelope }, parentRevision: 0 };
      }
      if (operation.operation === 'invocations.fact') {
        persistedEnvelope = operation.contentEnvelope as string;
        return { ...rootIndex, lifecycle: operation.lifecycle, parentRevision: 1 };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId, runId, parentAttempt: 0, storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } },
      revision: 0,
    });
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const requestStore = new AgentStateRequestStore({
      target: store.createInteractionPersistenceTarget(rootKey),
      logPrefix: '[WORKFLOW TEST]',
    });

    const toolInput = { path: '/repo/file.txt', content: 'x'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES + 1) };
    await requestStore.publishRequestAndWait({
      requestId: 'permission-1', toolName: 'Write', toolInput, createdAt: 1,
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'invocations.fact',
      lifecycle: 'waiting_for_approval',
    }));

    const opened = openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding, envelope: parseWorkflowStoredContentEnvelopeV1(persistedEnvelope),
    });
    expect(opened).toMatchObject({
      kind: 'available',
      content: {
        result: { changed: true },
        interaction: { requests: { 'permission-1': { tool: 'Write', arguments: toolInput } } },
      },
    });

    await expect(requestStore.completeRequest({
      requestId: 'permission-1',
      status: 'approved',
      decision: 'approved',
    })).resolves.toBe(true);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: 'invocations.fact',
      lifecycle: 'running',
    }));

    await store.commitFact({ key: rootKey, lifecycle: 'completed' });
    await requestStore.publishRequestAndWait({
      requestId: 'permission-late', toolName: 'Write', toolInput: { path: '/repo/late.txt' }, createdAt: 3,
    });
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: 'invocations.fact',
      lifecycle: 'completed',
    }));
  });

  it.each([false, true])('acknowledges a competing terminal fact only when its reply custody matches (matching=%s)', async matching => {
    const rootId = 'root-reply-conflict';
    const encryption: WorkflowRunEncryptionV1 = { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } };
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
      nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope: 'accepted' });
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'checkpoint', rootInvocation: {
      id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } })),
    } });
    const load = () => DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId: rootId,
      checkpoint, revision: boundary.run().revision, encryption, storage: boundary });
    const coordinator = await load();
    const key = workflowInvocationKey({ runId, blockId: 'work', scope: [], attempt: 0 });
    const leaf = await coordinator.ensureIntent({ key, recordId: 'reply-conflict-leaf', runId, blockId: 'work', blockKind: 'step',
      path: { blockId: 'work', scope: [] }, memberOrdinal: '0', attempt: 0, acceptedAtMs: 1, lifecycle: 'running' });
    const replyOutcome = { kind: 'answer' as const, result: { sessionId: 'session-1', messageId: 'exact-result' } };
    // A second real durable owner represents recovery observing the same
    // ordinary retained turn before or after its independent C2 settlement.
    const recovery = await load();
    await recovery.readByLogicalInvocation(leaf.recordId);
    await recovery.commitFact({ key, lifecycle: 'completed', result: 'answer', ...(matching ? { replyOutcome } : {}) });
    const completion = coordinator.commitFact({ key, lifecycle: 'completed', result: 'answer', replyOutcome });
    if (matching) await expect(completion).resolves.toMatchObject({ lifecycle: 'completed', replyOutcome });
    else await expect(completion).rejects.toThrow('currentness_conflict');
    expect((await recovery.read(key))?.replyOutcome).toEqual(matching ? replyOutcome : undefined);
  });

  it('serializes facts for one invocation row so concurrent workspace commits cannot erase each other', async () => {
    const rootId = 'root-1';
    const rootIndex = {
      id: rootId,
      runId,
      sequence: '0',
      parentRecordId: null,
      memberOrdinal: '0',
      attempt: '0',
      contentRevision: '0', lifecycle: 'running' as const,
      createdAt: now,
      updatedAt: now,
    };
    const rootProgress = {
      kind: 'happier.workflow-progress.v1' as const,
      invocationPath: { blockId: '$root', scope: [] },
      blockKind: 'root' as const,
      attempt: '0',
      logicalInvocationRecordId: rootId,
    };
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1,
        purpose: 'invocation_progress',
        accountId,
        runId,
        recordId: rootId,
        sequence: '0',
        parentRecordId: null,
        memberOrdinal: '0',
        attempt: '0',
      },
      progress: rootProgress,
    }));
    let persistedEnvelope = rootEnvelope;
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let factCalls = 0;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'invocations.get') {
        return { invocation: { index: rootIndex, contentEnvelope: persistedEnvelope }, parentRevision: 0 };
      }
      if (operation.operation === 'invocations.fact') {
        factCalls += 1;
        if (factCalls === 1) await firstRelease;
        persistedEnvelope = operation.contentEnvelope as string;
        return { ...rootIndex, parentRevision: 0 };
      }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const store = await DurableWorkflowCoordinatorStore.load({
      accountId,
      runId,
      parentAttempt: 0,
      storage: { execute },
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
      rootRecordId: rootId,
      checkpoint: {
        kind: 'happier.workflow-checkpoint.v1',
        rootRecordId: rootId,
        nextSequence: '1',
        frontier: { nextBlockOrdinal: 0, paused: false },
      },
      revision: 0,
    });
    const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
    const creationIntent = {
      kind: 'git_worktree' as const,
      sourceDirectory: '/repo',
      baseRef: 'a'.repeat(40),
      displayName: 'workflow-root',
      branchMode: 'new' as const,
    };
    const descriptor = { machineId, directory: '/worktree', checkoutRootPath: '/worktree' };

    const first = store.commitFact({ key: rootKey, lifecycle: 'running', workspace: { creationIntent },
      resultProvenance: { report: { notificationCondition: 'suppressed' } } });
    await Promise.resolve();
    const second = store.commitFact({ key: rootKey, lifecycle: 'running', workspace: { descriptor },
      resultProvenance: { report: { notificationCondition: 'matched' }, other: { notificationCondition: 'suppressed' } } });
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);
    expect(await store.read(rootKey)).toMatchObject({ resultProvenance: {
      report: { notificationCondition: 'matched' }, other: { notificationCondition: 'suppressed' },
    } });

    const opened = openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1,
        purpose: 'invocation_progress',
        accountId,
        runId,
        recordId: rootId,
        sequence: '0',
        parentRecordId: null,
        memberOrdinal: '0',
        attempt: '0',
      },
      envelope: parseWorkflowStoredContentEnvelopeV1(persistedEnvelope),
    });
    expect(opened).toMatchObject({
      kind: 'available',
      content: { workspace: { creationIntent, descriptor } },
    });
  });

  it('derives Automation host authority only from the normalized frozen program', () => {
    // The definition itself is valid, so the rejection isolates the caller
    // supplied `authorization` rather than an empty block list.
    const stored = {
      inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
      workspace: { directory: '/repo' },
      executionTarget: { kind: 'session' },
    };
    expect(AutomationStoredWorkflowDefinitionV2Schema.safeParse(stored).success).toBe(true);
    expect(AutomationStoredWorkflowDefinitionV2Schema.safeParse({
      ...stored,
      authorization: { admittedPermissionCeiling: 'yolo', principal: { kind: 'host' } },
    }).success).toBe(false);
  });

  it('keeps the structural root running when the parent is recoverably interrupted', () => {
    expect(projectWorkflowRootSettlementLifecycle('interrupted', 'running')).toBe('running');
    expect(projectWorkflowRootSettlementLifecycle('failed', 'running')).toBe('failed');
  });


  it('requests same-transition custody settlement for every terminal result', () => {
    expect(projectWorkflowTerminalCustodySettlement('succeeded')).toBe('settled');
    expect(projectWorkflowTerminalCustodySettlement('failed')).toBe('settled');
    expect(projectWorkflowTerminalCustodySettlement('cancelled')).toBe('settled');
    expect(projectWorkflowTerminalCustodySettlement('outcome_uncertain')).toBe('settled');
    expect(projectWorkflowTerminalCustodySettlement('interrupted')).toBeUndefined();
    expect(projectWorkflowTerminalCustodySettlement('paused')).toBeUndefined();
  });

  it('rejects a Run admitted for another Machine before initializing workflow progress', async () => {
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
      acceptedSnapshot: {
        startedBy: 'trigger',
        definition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
        authoredDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
        workDepth: 0, metadata: null, materializedLeaves: [], frozenChildren: {},
        inputs: {},
        machineId: 'machine-other',
        executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-other', directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        source: { kind: 'automation', automationId: 'automation-1' },
      },
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation !== 'get') throw new Error(`unexpected:${String(operation.operation)}`);
      return {
        run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
          attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
          id: runId, origin: { kind: 'automation', automationId: 'automation-1' }, state: 'queued', revision: 0,
          machineId: 'machine-other', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
          availability, createdAt: now, updatedAt: now,
        },
        acceptedEnvelope,
        checkpointEnvelope: null,
        resultEnvelope: null,
        keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId, accountId }),
      };
    });
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(),
      onCommittedTransition: vi.fn(),
      storage: { observeChanges: quietStorageChanges, execute },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, acceptedEnvelope,
      automationEvidenceEnvelope: null })).resolves.toEqual({ state: 'failed', reason: 'workspace_conflict' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('resolves an Automation workspace reference from current settings at claim admission', async () => {
    const oldRef: import('@happier-dev/protocol').WorkspaceRefV1 = {
      id: 'workspace-1', serverId: 'server-1', machineId,
      rootPath: '/old-root', createdAtMs: 1,
    };
    const currentRef: import('@happier-dev/protocol').WorkspaceRefV1 = {
      id: 'workspace-1', serverId: 'srv_home', machineId,
      rootPath: '/current-root', createdAtMs: 2,
    };
    let currentWorkspaceRefs: readonly import('@happier-dev/protocol').WorkspaceRefV1[] = [oldRef];
    let resolvedRef: import('@happier-dev/protocol').WorkspaceRefV1 | null = null;
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: { ...productionExecution(), serverId: 'local-profile', serverIdentityId: 'srv_home' },
      resolveCurrentWorkspaceRefs: async () => currentWorkspaceRefs,
      prepareAcceptedWorkspaceTarget: async ({ projectTarget, resolveWorkspaceRef }) => {
        expect(projectTarget).toEqual({ machineId, directory: '/old-root', workspaceRefId: 'workspace-1' });
        resolvedRef = resolveWorkspaceRef?.('workspace-1') ?? null;
        return { ok: false as const, code: 'workspace_unavailable' as const };
      },
      onCommittedTransition: vi.fn(),
      storage: { observeChanges: quietStorageChanges, execute: vi.fn() },
    });
    currentWorkspaceRefs = [currentRef];

    await expect(coordinate({
      runId,
      attempt: 0,
      expectedRevision: 0,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationId: 'automation-1',
      automationCause: { kind: 'manual', invokedAt: 1 },
      causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({
        t: 'plain',
        v: {
          inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
          workspace: { directory: '/old-root', workspaceRefId: 'workspace-1' },
          executionTarget: { kind: 'session' },
        },
      }),
      automationEvidenceEnvelope: null,
    })).resolves.toEqual({ state: 'failed', reason: 'workspace_unavailable', admission: 'refused' });
    expect(resolvedRef).toEqual(currentRef);

    currentWorkspaceRefs = [];
    resolvedRef = oldRef;
    await expect(coordinate({
      runId: '1d4dd16c-d69b-4115-a3b0-e3c92f47f3bd',
      attempt: 0,
      expectedRevision: 0,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationId: 'automation-1',
      automationCause: { kind: 'manual', invokedAt: 2 },
      causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({
        t: 'plain',
        v: {
          inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
          workspace: { directory: '/old-root', workspaceRefId: 'workspace-1' },
          executionTarget: { kind: 'session' },
        },
      }),
      automationEvidenceEnvelope: null,
    })).resolves.toEqual({ state: 'failed', reason: 'workspace_unavailable', admission: 'refused' });
    expect(resolvedRef).toBeNull();
  });

  it('resolves a missing live Artifact through the Account owner and refuses it before effects', async () => {
    const release = publishServerHttpRuntimeOrigin('https://claim-home.example.test/', 'https');
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
    const execute = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
    });
    try {
      await expect(coordinate({
        runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
        accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        workflowDefinitionId: runId, causeWorkDepth: 0,
        automationCause: { kind: 'manual', invokedAt: 1 },
        definitionEnvelope: JSON.stringify({ t: 'plain', v: {
          workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
        } }),
      })).resolves.toEqual({ state: 'failed', reason: 'source_unavailable', admission: 'refused' });
      expect(get).toHaveBeenCalledWith(`https://claim-home.example.test/v1/artifacts/${runId}`, expect.any(Object));
      expect(execute).not.toHaveBeenCalled();
      get.mockClear();
      const failRun = vi.fn(async () => {});
      await executeClaimedRun({
        machineId, coordinateWorkflowRun: coordinate,
        heartbeatMs: 60_000, leaseDurationMs: 120_000,
        claimClient: { heartbeatRun: vi.fn(async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs), failRun },
        resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        claimed: { protocol: 'v3', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
          automation: { id: 'automation-1', name: 'missing source', enabled: true, workflowDefinitionId: runId },
          run: { id: runId, automationId: 'automation-1', attempt: 0, leaseExpiresAt: Date.now() + 120_000, revision: 0, recipeKind: 'workflow-v2',
            triggerId: null, cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
            resultDelivery: { kind: 'none' }, executionInputEnvelope: JSON.stringify({ t: 'plain', v: {
              workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
            } }),
          },
        },
      });
      expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'source_unavailable' }));
      expect(get).toHaveBeenCalledWith(`https://claim-home.example.test/v1/artifacts/${runId}`, expect.any(Object));
    } finally {
      get.mockRestore(); release();
    }
  });

  it('reads a saved trigger source again after an edit through the real definition and Artifact owners', async () => {
    const release = publishServerHttpRuntimeOrigin('https://claim-home.example.test/', 'https');
    let version = 2;
    let prompt = 'Before edit';
    const get = vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: {
      id: runId, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version,
      provenance: encodePlainArtifactStoredContent({ v: 1, artifactId: runId, bodyVersion: version,
        provenance: { savedBy: { kind: 'person', accountId } },
      }),
      header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId: runId,
        revision: { headerVersion: version, bodyVersion: version }, metadata: { title: 'Live source' },
      }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1',
        definition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [{ ...onlyStep, document: { text: prompt, references: [], attachments: [] } }] },
      }) }),
    } }));
    const params = {
      target: { kind: 'workflow' as const, ref: runId }, credentials: { token: 'token', encryption: null },
      encryption: { kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } },
    };
    try {
      const first = await resolveWorkflowTriggerClaimSource(params);
      expect(first).toMatchObject({ kind: 'saved', revision: { headerVersion: 2, bodyVersion: 2 } });
      version = 3; prompt = 'After edit';
      const next = await resolveWorkflowTriggerClaimSource(params);
      expect(next).toMatchObject({ kind: 'saved', revision: { headerVersion: 3, bodyVersion: 3 }, savedBy: { kind: 'person', accountId },
        definition: { blocks: [{ document: { text: 'After edit' } }] },
      });
      expect(first).toMatchObject({ definition: { blocks: [{ document: { text: 'Before edit' } }] } });
      const captured = new Error('saved_snapshot_captured');
      const accepted: unknown[] = [];
      const coordinate = createProductionWorkflowRunCoordinator({
        resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
        token: 'token', accountId, machineId,
        resolveAccountEncryption: async () => params.encryption,
        isAcceptedAuthorizationCurrent: async () => true,
        execution: productionExecution(), onCommittedTransition: vi.fn(),
        resolveMaterializationHost: productionMaterializationHost,
        prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
          workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        }),
        storage: { observeChanges: quietStorageChanges, execute: async (operation) => {
          if (operation.operation !== 'accepted-snapshot.resolve') throw new Error('unexpected_storage_effect');
          expect(operation.visibleTeamId).toBe('team-chosen');
          const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope),
          });
          if (opened.kind !== 'available') throw new Error('snapshot_unavailable');
          accepted.push(opened.content);
          throw captured;
        } },
      });
      const claim = { runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
        accountCurrentness: params.encryption.witness, workflowDefinitionId: runId, causeWorkDepth: 3,
        automationCause: { kind: 'manual' as const, invokedAt: 1 },
        definitionEnvelope: JSON.stringify({ t: 'plain', v: {
          visibleTeamId: 'team-chosen',
          workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
        } }),
      };
      await expect(coordinate(claim)).rejects.toBe(captured);
      expect(accepted[0]).toMatchObject({ source: { kind: 'automation', automationId: 'automation-1',
        definitionId: runId, revision: { headerVersion: 3, bodyVersion: 3 }, savedBy: { kind: 'person', accountId } },
        workDepth: 3, metadata: { title: 'Live source' },
        definition: { blocks: [{ document: { text: 'After edit' } }] },
      });
      version = 4; prompt = 'Next firing';
      await expect(coordinate(claim)).rejects.toBe(captured);
      expect(accepted[1]).toMatchObject({ source: { revision: { headerVersion: 4, bodyVersion: 4 } },
        definition: { blocks: [{ document: { text: 'Next firing' } }] },
      });
      expect(accepted[0]).toMatchObject({ source: { revision: { headerVersion: 3, bodyVersion: 3 } },
        definition: { blocks: [{ document: { text: 'After edit' } }] },
      });
    } finally {
      get.mockRestore(); release();
    }
  });

  it('preserves cancellation from the Artifact boundary instead of classifying it as a missing source', async () => {
    const controller = new AbortController();
    const reason = new Error('claim_cancelled');
    controller.abort(reason);
    const get = vi.spyOn(axios, 'get');
    try {
      await expect(resolveWorkflowTriggerClaimSource({
        target: { kind: 'workflow', ref: runId }, credentials: { token: 'token', encryption: null },
        encryption: { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
        signal: controller.signal,
      })).rejects.toBe(reason);
      expect(get).not.toHaveBeenCalled();
    } finally { get.mockRestore(); }
  });

  it('preserves transient Artifact errors instead of classifying them as missing trigger sources', async () => {
    const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const get = vi.spyOn(axios, 'get').mockRejectedValue(failure);
    try {
      await expect(resolveWorkflowTriggerClaimSource({
        target: { kind: 'workflow', ref: runId }, credentials: { token: 'token', encryption: null },
        encryption: { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
      })).rejects.toBe(failure);
    } finally { get.mockRestore(); }
  });

  it('refuses an unavailable claim leaf with its block identity before snapshot effects', async () => {
    const execute = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      resolveMaterializationHost: async (input) => ({ ...await productionMaterializationHost(input),
        effects: { resolveTargetAvailability: async () => false },
      }),
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      }),
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: { engine: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        } }, blocks: [onlyStep] },
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      } }),
    })).resolves.toEqual({ state: 'failed', reason: 'target_unavailable', blockId: 'work', admission: 'refused',
      targetUnavailableReason: 'selection_unavailable' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { deliver: false, policy: { preset: 'important' }, selected: true, wake: true },
    { deliver: true, policy: { preset: 'important' }, selected: true, wake: true },
    { deliver: true, policy: { preset: 'quiet' }, selected: true, wake: false },
    { deliver: true, policy: { preset: 'custom', events: {} }, selected: false, wake: false },
    { deliver: true, policy: { preset: 'custom', events: { failed_or_stopped: { delivery: 'interrupt' } } }, selected: true, wake: true },
  ] satisfies Array<{ deliver: boolean; policy: FollowPolicyV1; selected: boolean; wake: boolean }>)('freezes trigger Run report policy $policy.preset into selected delivery ($deliver/$selected/$wake)', async ({ deliver, policy, selected, wake }) => {
    const captured = new Error('snapshot_captured');
    const preferenceRead = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1, runReportPolicy: policy,
    } });
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      expect(operation.operation).toBe('accepted-snapshot.resolve');
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope),
      });
      expect(opened).toMatchObject({ kind: 'available', content: { executionTarget: { kind: 'detached_run' }, machineId } });
      if (opened.kind !== 'available') throw new Error('snapshot_unavailable');
      expect(opened.content.source).toEqual({ kind: 'automation', automationId: 'automation-1' });
      expect(opened.content.origin).toEqual({ kind: 'direct', originSessionId: 'origin-session',
        authenticatedStarterV1: { requestRef: runId, requester: { serverId: 'server-1', accountId } } });
      expect(opened.content.resultDelivery).toEqual(deliver
        ? { kind: 'originating_session', originSessionId: 'origin-session', reportPolicy: policy } : undefined);
      // Opaque accepted bytes cannot establish the server's origin lookup or ack request.
      expect(operation.originSessionId).toBe('origin-session');
      expect(operation.resultDelivery).toEqual(deliver ? { kind: 'originating_session' } : undefined);
      if (deliver) {
        // Run storage is the boundary. The real producer, strict sealed snapshot,
        // source classification and origin input port remain composed beneath it.
        const failedRun = { ...createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct', originSessionId: 'origin-session' }, acceptedEnvelope: String(operation.acceptedEnvelope) }).run(),
          state: 'failed', revision: 1, originDeliveryAckRevision: 0 };
        const port = createWorkflowOriginContextInputPort({ accountId, originSessionId: 'origin-session', machineId,
          resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
          readDispatchFact: async () => 'not_dispatched', onDispatchedInput: () => {}, onError: error => { throw error; },
          storage: { execute: async request => {
            if (request.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
            if (request.operation === 'delivery.pull') return { runs: [{ run: failedRun, acceptedEnvelope: operation.acceptedEnvelope }] };
            if (request.operation === 'invocations.list') return { invocations: [], progressEnvelopesByInvocationId: {} };
            throw new Error('unexpected_report_effect');
          } },
        });
        const signal = new AbortController().signal;
        expect((await port.prepareWorkerUpdates!({ signal, maxUtf8Bytes: 65536 })).length).toBe(selected ? 1 : 0);
        const taken = await port.take(signal);
        if (wake) expect(taken).toMatchObject({ kind: 'worker_update' });
        else expect(taken).toBeNull();
      }
      throw captured;
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, session: 'terminal' })).toString('base64url')}.signature`;
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token, accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: { ...productionExecution(), credentials: { token, encryption: null } }, onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      resolveMaterializationHost: productionMaterializationHost,
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      }),
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, scopeSessionId: 'origin-session',
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [onlyStep] },
        workspace: { directory: '/repo' }, executionTarget: { kind: 'detached_run' },
        ...(deliver ? { onComplete: { kind: 'originating_session' } } : {}),
      } }),
    })).rejects.toBe(captured);
    expect(preferenceRead).toHaveBeenCalledTimes(deliver ? 1 : 0);
    preferenceRead.mockRestore();
  });

  it.each(['artifact_http_500', 'workflow_http_500', 'nested_workflow_http_500', 'nested_workflow_typed', 'nested_workflow_cancelled',
    'external_plugin', 'external_plugin_typed', 'retired_account', 'cancelled_claim'] as const)(
    'settles unavailable required admission sources through the real claim failure transport (%s)', async fault => {
    const release = publishServerHttpRuntimeOrigin('https://role-claim.example.test/', 'https');
    const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null } as const;
    const worker = new AbortController();
    const nested = fault.startsWith('nested_workflow');
    const pluginRole = fault.startsWith('external_plugin');
    const roleId = pluginRole ? 'plugin:external.roles/scout' : 'required-role';
    const reads: string[] = [];
    const childReads: string[] = [];
    const pluginReads: string[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (path === `/v1/artifacts/${runId}` && (fault === 'workflow_http_500' || nested)) {
        if (fault === 'nested_workflow_cancelled') worker.abort(new Error('claim_retired'));
        return { status: 500, data: { code: 'internal_error' } };
      }
      if (path === `/v1/artifacts/${roleId}`) {
        if (fault === 'cancelled_claim') worker.abort(new Error('claim_retired'));
        return { status: 500, data: { code: 'internal_error' } };
      }
      throw new Error(`unexpected_role_admission_read:${path}`);
    });
    const failures: ReturnType<typeof AutomationV3WorkerFailRequestSchema.parse>[] = [];
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      expect(url).toBe(`https://role-claim.example.test/v3/automations/runs/${runId}/fail`);
      // The real transport producer must be accepted by the server's exact strict consumer.
      failures.push(AutomationV3WorkerFailRequestSchema.parse(body));
      return { status: 200, data: {} };
    });
    const nativeStart = vi.fn(async () => { throw new Error('must_not_start_native_work'); });
    const execute = vi.fn(async () => { throw new Error('must_not_create_accepted_workflow'); });
    const readWorkflowDefinition: Parameters<typeof createCredentialedWorkflowMaterializationHostV1>[0]['readWorkflowDefinition'] = async (ref, signal) => {
      const key = formatWorkflowDefinitionRefV1(ref);
      childReads.push(key);
      // Definition acquisition is the external source boundary; materialization
      // and the refusal classifier remain real for typed plugin read errors.
      if (fault === 'nested_workflow_typed') throw Object.assign(new Error('child_target_unavailable'), { code: 'target_unavailable' });
      const source = await resolveWorkflowTriggerClaimSource({ target: { kind: 'workflow', ref: key }, credentials,
        encryption: { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
        ...(signal ? { signal } : {}),
      });
      return source ? { ...source, sourceKey: key } : null;
    };
    const resolveMaterializer = createCredentialedWorkflowMaterializationHostV1({ credentials, accountId,
      callMachineAction: nativeStart, readWorkflowDefinition,
      readRoleSources: createRoleSourceReader({ artifactStore: createCredentialedAccountArtifactStore(credentials),
        accountId, readRawAccountSettings: async () => ({}), readPluginRoles: () => {
          pluginReads.push(roleId);
          if (fault === 'external_plugin') throw new Error('external_role_projection_unavailable');
          if (fault === 'external_plugin_typed') throw Object.assign(new Error('external_role_content_unavailable'), { code: 'content_unavailable' });
          return [];
        } }),
    });
    const coordinate = createProductionWorkflowRunCoordinator({
      token: credentials.token, accountId, machineId,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: { ...productionExecution(), credentials, machineAdmissionTransport: nativeStart },
      onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationHost: async target => {
        if (nested) {
          const host = await productionMaterializationHost(target);
          return { ...host, effects: { ...host.effects,
            readWorkflowDefinition: ref => readWorkflowDefinition(ref, target.signal) } };
        }
        const host = await resolveMaterializer({ machineId, directory: target.directory, signal: target.signal });
        return { ...host, admitLeaf: (await productionMaterializationHost(target)).admitLeaf };
      },
    });
    try {
      await executeClaimedRun({ machineId, coordinateWorkflowRun: coordinate, signal: worker.signal,
        heartbeatMs: 60_000, leaseDurationMs: 120_000,
        claimClient: createAutomationClaimClient({ token: credentials.token, createPublisherHeader: async () => null }),
        resolveAutomationAccountEncryption: async () => {
          if (fault === 'retired_account') throw new Error('account_currentness_unavailable');
          return { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } };
        },
        claimed: { protocol: 'v3', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
          automation: { id: 'automation-1', name: 'Role source outage', enabled: true,
            ...(fault === 'workflow_http_500' ? { workflowDefinitionId: runId } : {}) },
          run: { id: runId, automationId: 'automation-1', attempt: 3, leaseExpiresAt: Date.now() + 120_000,
            revision: 4, recipeKind: 'workflow-v2', triggerId: null, cause: { kind: 'manual', invokedAt: 1 },
            causeWorkDepth: 0, resultDelivery: { kind: 'none' }, executionInputEnvelope: JSON.stringify({ t: 'plain', v: {
              ...(fault === 'workflow_http_500' ? {} : { inlineDefinition: { version: 1, inputs: [],
                defaults: nested ? {} : { engine: { role: roleId } },
                blocks: nested ? [{ kind: 'workflow', id: 'nested', workflowRef: runId, input: {} }] : [onlyStep] } }),
              workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
            } }),
          },
        },
      });
      if (nested) expect(childReads).toEqual([runId]);
      if (pluginRole) expect(pluginReads).toEqual([roleId]);
      else if (fault !== 'nested_workflow_typed') expect(reads).toContain(nested || fault === 'workflow_http_500'
        ? `/v1/artifacts/${runId}` : `/v1/artifacts/${roleId}`);
      expect(reads).not.toContain('/v1/artifacts');
      expect(execute).not.toHaveBeenCalled();
      expect(nativeStart).not.toHaveBeenCalled();
      expect(failures).toEqual(fault === 'retired_account' || fault === 'cancelled_claim' || fault === 'nested_workflow_cancelled' ? []
        : [expect.objectContaining({ machineId, attempt: 3,
          accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
          errorCode: fault === 'nested_workflow_typed' ? 'target_unavailable'
            : fault === 'external_plugin_typed' ? 'content_unavailable' : 'source_unavailable',
          errorDetailEnvelope: expect.any(String) })]);
    } finally { get.mockRestore(); post.mockRestore(); release(); }
  });

  it('avoids Artifact inventory walks across repeated pre-acceptance claim attempts', async () => {
    const release = publishServerHttpRuntimeOrigin('https://role-claim.example.test/', 'https');
    const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null } as const;
    const currentness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
    const reads: string[] = [];
    const attempts: number[] = [];
    const policyDepthLimits: number[] = [];
    let attempt = 0;
    const unrelated = Array.from({ length: 501 }, (_, index) => ({ id: `unrelated-${index}`,
      ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      header: encodePlainArtifactStoredContent({ kind: 'document.v1', title: 'Unrelated document' }),
      body: encodePlainArtifactStoredContent({ body: 'Unrelated document' }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
      seq: index + 1, createdAt: 1, updatedAt: 1 }));
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://role-claim.example.test');
      reads.push(url.pathname);
      if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        ...currentness, signingKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: attempt + 1,
        content: { t: 'plain', v: { workDepthLimit: attempt + 1 } } } };
      if (url.pathname === '/v1/account/entity-rows/prompt-library') return { status: 200,
        data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows:
          PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
            content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) }) };
      if (url.pathname === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (url.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (url.pathname === '/v1/artifacts') {
        const items = url.searchParams.has('cursor') ? unrelated.slice(500) : unrelated.slice(0, 500);
        return { status: 200, data: url.searchParams.has('kind') ? { items, hasUnclassified: false } : items };
      }
      throw new Error(`unexpected_no_role_claim_read:${url.pathname}`);
    });
    const failures: ReturnType<typeof AutomationV3WorkerFailRequestSchema.parse>[] = [];
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      expect(url).toBe(`https://role-claim.example.test/v3/automations/runs/${runId}/fail`);
      failures.push(AutomationV3WorkerFailRequestSchema.parse(body));
      return { status: 200, data: {} };
    });
    const nativeStart = vi.fn(async () => { throw new Error('must_not_start_native_work'); });
    const storageUnavailable = new Error('accepted_snapshot_storage_unavailable');
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      expect(operation.operation).toBe('accepted-snapshot.resolve');
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope),
      });
      expect(opened).toMatchObject({ kind: 'available', content: { materializedLeaves: [{ kind: 'wait' }] } });
      attempts.push(attempt);
      // A pre-acceptance storage outage leaves no accepted envelope for the
      // next server-granted attempt; the incumbent claim path must re-admit.
      throw storageUnavailable;
    });
    const resolveMaterializer = createCredentialedWorkflowMaterializationHostV1({ credentials, accountId,
      callMachineAction: nativeStart, readWorkflowDefinition: async () => null });
    const coordinate = createProductionWorkflowRunCoordinator({
      token: credentials.token, accountId, machineId,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: currentness }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: { ...productionExecution(), credentials, machineAdmissionTransport: nativeStart },
      onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } } }),
      resolveMaterializationHost: async target => {
        const host = await resolveMaterializer({ machineId, directory: target.directory, signal: target.signal });
        policyDepthLimits.push(host.agentStartPolicySnapshot.workDepthLimit);
        return { ...host, admitLeaf: (await productionMaterializationHost(target)).admitLeaf };
      },
    });
    try {
      for (attempt of [0, 1, 2]) await executeClaimedRun({ machineId, coordinateWorkflowRun: coordinate,
        heartbeatMs: 60_000, leaseDurationMs: 120_000,
        claimClient: createAutomationClaimClient({ token: credentials.token, createPublisherHeader: async () => null }),
        resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: currentness }),
        claimed: { protocol: 'v3', accountCurrentness: currentness,
          automation: { id: 'automation-1', name: 'No Role claim', enabled: true },
          run: { id: runId, automationId: 'automation-1', attempt, leaseExpiresAt: Date.now() + 120_000,
            revision: 0, recipeKind: 'workflow-v2', triggerId: null, cause: { kind: 'manual', invokedAt: 1 },
            causeWorkDepth: 0, resultDelivery: { kind: 'none' }, executionInputEnvelope: JSON.stringify({ t: 'plain', v: {
              inlineDefinition: { version: 1, defaults: {}, blocks: [{ kind: 'wait', id: 'review',
                document: { text: 'Review', references: [], attachments: [] } }] },
              workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
            } }),
          },
        },
      });
      expect(attempts).toEqual([0, 1, 2]);
      expect(policyDepthLimits).toEqual([1, 2, 3]);
      expect(reads.filter(path => path.startsWith('/v1/artifacts'))).toEqual([]);
      expect(nativeStart).not.toHaveBeenCalled();
      expect(failures).toEqual([]);
    } finally { get.mockRestore(); post.mockRestore(); release(); }
  });

  it('settles invalid trigger constants as a typed pre-start refusal without row or Session effects', async () => {
    const execute = vi.fn();
    const failRun = vi.fn(async () => {});
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
    });
    const definitionEnvelope = JSON.stringify({ t: 'plain', v: {
      inlineDefinition: { version: 1, inputs: [{ name: 'repository', valueType: 'string', required: true }], defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
      }, blocks: [onlyStep] },
      workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inputs: { repository: 123 },
    } });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0, definitionEnvelope,
    })).resolves.toEqual({ state: 'failed', reason: 'invalid_input', admission: 'refused' });
    await executeClaimedRun({
      machineId, coordinateWorkflowRun: coordinate,
      heartbeatMs: 60_000, leaseDurationMs: 120_000,
      claimClient: { heartbeatRun: vi.fn(async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs), failRun },
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      claimed: { protocol: 'v3', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        automation: { id: 'automation-1', name: 'invalid input', enabled: true },
        run: { id: runId, automationId: 'automation-1', attempt: 0, leaseExpiresAt: Date.now() + 120_000, revision: 0, recipeKind: 'workflow-v2',
          triggerId: null, cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
          resultDelivery: { kind: 'none' }, executionInputEnvelope: definitionEnvelope,
        },
      },
    });
    expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'invalid_input' }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves cancellation while reading current workspace settings before trigger admission', async () => {
    const execute = vi.fn();
    const abort = new AbortController();
    const cancelled = new Error('claim cancelled');
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      // Account settings are a network boundary, not a second workspace resolver.
      resolveCurrentWorkspaceRefs: async () => { abort.abort(cancelled); throw cancelled; },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0, signal: abort.signal,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [onlyStep] },
        workspace: { directory: '/repo', workspaceRefId: 'workspace-ref-1' }, executionTarget: { kind: 'session' },
      } }),
    })).rejects.toBe(cancelled);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { definition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] }, project: { machineId, directory: '/repo' } },
    { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } },
  ])('refuses an invalid trigger target before workspace or row effects', async (payload) => {
    const execute = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: payload }),
    })).resolves.toEqual({ state: 'failed', reason: 'source_unavailable', admission: 'refused' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses missing occurrence depth before effects', async () => {
    const execute = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: undefined,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [onlyStep] },
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      } }),
    })).resolves.toEqual({ state: 'failed', reason: 'source_unavailable', admission: 'refused' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([3, 4])('materializes an inline claim at its frozen firing depth %s before any row effect', async (causeWorkDepth) => {
    const captured = new Error('accepted_snapshot_captured');
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      expect(operation.operation).toBe('accepted-snapshot.resolve');
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope),
      });
      expect(opened).toMatchObject({ kind: 'available', content: { workDepth: causeWorkDepth, startedBy: 'user' } });
      throw captured;
    });
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(), storage: { observeChanges: quietStorageChanges, execute },
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true, workspaceTarget: {
        project: { machineId, directory: '/repo', checkoutRootPath: '/repo' },
      } }),
      // Account policy and run-machine catalogs are genuine external boundaries.
      // The actual Protocol policy and materializer remain in the tested path.
      resolveMaterializationHost: async ({ runId: admittedRunId, workDepth, directory }) => ({
        effects: {
          readWorkflowDefinition: async () => null,
          readLaunchProfile: async () => null,
          readActionContract: async () => null,
          resolveTargetAvailability: async () => true,
        },
        admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
          { kind: 'workflow_run_leaf', leaf }, {
            caller: { kind: 'originless', runId: admittedRunId, runDepth: workDepth },
            baseline: { machineId, directory }, ledSubtreeSessionIds: [], roles: {},
            workDepthLimit: 4, callerPermissionCeiling: 'default',
          }),
      }),
    });
    const claim = { runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual' as const, invokedAt: 1 }, causeWorkDepth,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [onlyStep] },
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      } }),
    };
    if (causeWorkDepth === 3) await expect(coordinate(claim)).rejects.toBe(captured);
    else {
      await expect(coordinate(claim)).resolves.toEqual({ state: 'failed', reason: 'work_depth_exceeded', admission: 'refused', blockId: 'work' });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it.each(['profile:trigger', null] as const)('carries a stored trigger approval reference into accepted child Action context (%s)', async approvalProfileId => {
    const captured = new Error('accepted_snapshot_captured');
    let childContext: ReturnType<typeof buildWorkflowActionContext> | undefined;
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(),
      resolveMaterializationHost: productionMaterializationHost,
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      }),
      storage: { observeChanges: quietStorageChanges, execute: async operation => {
        if (operation.operation !== 'accepted-snapshot.resolve') throw new Error('unexpected_storage_effect');
        const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
          envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope),
        });
        if (opened.kind !== 'available') throw new Error('snapshot_unavailable');
        childContext = buildWorkflowActionContext({ ...opened.content, runId });
        throw captured;
      } },
    });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: { approvalProfileId,
        inlineDefinition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [onlyStep] }, workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      } }),
    })).rejects.toBe(captured);
    expect(childContext).toHaveProperty('approvalProfileId', approvalProfileId);
  });

  it.each([
    { automationName: 'Library memory upkeep', stepName: undefined, title: 'Library memory upkeep' },
    { automationName: 'Workflow triggers', stepName: undefined, title: 'Send a prompt' },
    { automationName: 'Workflow triggers', stepName: 'Review the garden', title: 'Review the garden' },
  ])('names an inline trigger Run by its Library display name: $title', async ({ automationName, stepName, title }) => {
    const captured = new Error('accepted_snapshot_captured');
    const accepted: unknown[] = [];
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution(), onCommittedTransition: vi.fn(),
      resolveMaterializationHost: productionMaterializationHost,
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      }),
      storage: { observeChanges: quietStorageChanges, execute: async (operation) => {
        if (operation.operation !== 'accepted-snapshot.resolve') throw new Error('unexpected_storage_effect');
        const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
          mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
          envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope),
        });
        if (opened.kind !== 'available') throw new Error('snapshot_unavailable');
        accepted.push(opened.content);
        throw captured;
      } },
    });
    const claim = { runId, attempt: 0, expectedRevision: 0, automationId: 'automation-1',
      accountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
      automationCause: { kind: 'manual' as const, invokedAt: 1 }, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        inlineDefinition: { version: 1, inputs: [], defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        }, blocks: [{ ...onlyStep, ...(stepName ? { name: stepName } : {}) }] },
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      } }),
    };
    await expect(coordinate({ ...claim, automationName })).rejects.toBe(captured);
    expect(accepted[0]).toMatchObject({ source: { kind: 'automation' }, metadata: { title } });
    await expect(coordinate(claim)).rejects.toBe(captured);
    expect((accepted[1] as { metadata?: unknown }).metadata ?? null).toBeNull();
  });

  it('freezes an Automation definition and evidence before durable row admission, Session execution, and parent settlement', async () => {
    const definition = {
      version: 1 as const,
      inputs: [
        { name: 'request', valueType: 'string' as const, required: true },
        { name: 'repository', valueType: 'string' as const, required: true },
        { name: 'permissionMode', valueType: 'string' as const, required: false },
        { name: 'authorization', valueType: 'json' as const, required: false },
      ],
      defaults: {
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.test', localId: 'test' } },
        conversation: { kind: 'existing_session' as const, sessionId: 'session-1', machineId },
      },
      blocks: [{ kind: 'step' as const, id: 'work', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }],
      finalOutput: { kind: 'result' as const, producer: { blockId: 'work', scope: { kind: 'current' as const } }, path: [] },
    };
    const definitionEnvelope = JSON.stringify({ t: 'plain', v: {
      inlineDefinition: definition,
      workspace: { directory: '/repo' },
      executionTarget: { kind: 'session' },
      inputs: { repository: '/repo', request: 'constant loses to occurrence' },
    } });
    const automationEvidenceEnvelope = JSON.stringify({
      t: 'plain',
      v: { request: 'ship it', permissionMode: 'yolo', authorization: { admittedPermissionCeiling: 'yolo' } },
    });
    let acceptedEnvelope: string | null = null;
    let revision = 0;
    let checkpointEnvelope: string | null = null;
    let persistedResultEnvelope: string | null = null;
    let durableState = 'queued';
    let durableCustody: 'pending' | 'settled' = 'pending';
    let lostFinalTransitionResponse = false;
    const rows = new Map<string, { index: Record<string, unknown>; contentEnvelope: string }>();
    const summary = (state: string) => ({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'automation', automationId: 'automation-1' }, state,
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      revision, machineId, workflowCustodyState: durableCustody, originDeliveryAckRevision: null,
      availability, createdAt: now, updatedAt: now });
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      switch (operation.operation) {
        case 'accepted-snapshot.resolve': {
          expect(operation).toMatchObject({
            automationId: 'automation-1', expectedAttempt: 0, expectedRevision: 0, definitionEnvelope,
          });
          const candidate = operation.acceptedEnvelope;
          expect(typeof candidate).toBe('string');
          const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(candidate),
          });
          expect(opened).toMatchObject({ kind: 'available', content: {
            definition,
            inputs: {
              request: 'ship it',
              repository: '/repo',
              permissionMode: 'yolo',
              authorization: { admittedPermissionCeiling: 'yolo' },
            },
            machineId,
            executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
            source: { kind: 'automation', automationId: 'automation-1' },
          } });
          acceptedEnvelope = candidate as string;
          revision = 1;
          return { disposition: 'created', acceptedEnvelope, run: summary('queued') };
        }
        case 'get': return { run: summary(durableState), acceptedEnvelope, checkpointEnvelope, resultEnvelope: persistedResultEnvelope,
          keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId, accountId }) };
        case 'initialize': {
          revision = 1;
          durableState = 'running';
          checkpointEnvelope = operation.checkpointEnvelope as string;
          const root = operation.rootInvocation as { id: string; contentEnvelope: string };
          rows.set(root.id, { index: { id: root.id, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'pending', createdAt: now, updatedAt: now }, contentEnvelope: root.contentEnvelope });
          return { initialization: 'created', run: summary('running') };
        }
        case 'invocations.list': return { invocations: [...rows.values()].map((row) => row.index).filter((index) => {
          if (operation.parentRecordId !== undefined && index.parentRecordId !== operation.parentRecordId) return false;
          const lifecycles = operation.lifecycles;
          return !Array.isArray(lifecycles) || lifecycles.includes(index.lifecycle);
        }), parentRevision: revision };
        case 'invocations.current': {
          const current = [...rows.values()]
            .filter((row) => row.index.parentRecordId === operation.parentRecordId
              && row.index.memberOrdinal === operation.memberOrdinal)
            .sort((left, right) => Number(right.index.attempt) - Number(left.index.attempt))[0];
          return { invocation: current ?? null, parentRevision: revision };
        }
        case 'invocations.get': return { invocation: { index: rows.get(operation.invocationId as string)!.index,
          contentEnvelope: rows.get(operation.invocationId as string)!.contentEnvelope, parentRevision: revision } };
        case 'invocations.admit': {
          const item = (operation.invocations as Array<Record<string, unknown>>)[0]!;
          expect(item.sequence).toBe('1');
          revision += 1;
          checkpointEnvelope = operation.checkpointEnvelope as string;
          const index = { id: item.id, runId, sequence: item.sequence, parentRecordId: item.parentRecordId,
            memberOrdinal: item.memberOrdinal, attempt: '0', contentRevision: '0', lifecycle: 'pending', createdAt: now, updatedAt: now };
          rows.set(item.id as string, { index, contentEnvelope: item.contentEnvelope as string });
          return { disposition: 'created', parentRevision: revision, invocations: [index] };
        }
        case 'invocations.fact': {
          const row = rows.get(operation.invocationId as string)!;
          expect(operation.expectedContentRevision).toBe(row.index.contentRevision);
          row.index = { ...row.index, lifecycle: operation.lifecycle,
            contentRevision: (BigInt(String(row.index.contentRevision)) + 1n).toString() };
          row.contentEnvelope = operation.contentEnvelope as string;
          return { ...row.index, parentRevision: revision };
        }
        case 'transition': {
          expect(operation.expectedRevision).toBe(revision);
          revision += 1;
          durableState = operation.state as string;
          checkpointEnvelope = operation.checkpointEnvelope as string;
          if (typeof operation.resultEnvelope === 'string') persistedResultEnvelope = operation.resultEnvelope;
          if (operation.custodyState === 'settled') durableCustody = 'settled';
          for (const item of (operation.invocationTransitions ?? []) as Array<Record<string, unknown>>) {
            const row = rows.get(item.id as string)!;
            expect(item.expectedContentRevision).toBe(row.index.contentRevision);
            row.index = { ...row.index, lifecycle: item.lifecycle,
              contentRevision: (BigInt(String(row.index.contentRevision)) + 1n).toString() };
          }
          if (typeof operation.resultEnvelope === 'string' && !lostFinalTransitionResponse) {
            lostFinalTransitionResponse = true;
            throw new Error('simulated_lost_transition_response');
          }
          return summary(durableState);
        }
        default: throw new Error(`unexpected:${String(operation.operation)}`);
      }
    });
    const enqueue = vi.fn(async (input: Readonly<Record<string, unknown>>) => {
      expect(input).toMatchObject({
        sessionId: 'session-1',
        workflow: { purpose: 'invocation', runId, invocationRecordId: expect.any(String) },
      });
      return { status: 'accepted' as const, localId: 'local-1' };
    });
    const observe = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: 'local-1',
      result: { kind: 'final_text' as const, text: 'done' },
    }));
    const onCommittedTransition = vi.fn();
    const coordinate = createProductionWorkflowRunCoordinator({
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      token: 'token', accountId, machineId,
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      isAcceptedAuthorizationCurrent: async () => true,
      execution: productionExecution({  enqueue, observe }),
      resolveMaterializationHost: productionMaterializationHost,
      prepareAcceptedWorkspaceTarget: async () => ({
        ok: true,
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      }),
      // Recorded-workspace verification reaches the SCM owner through the
      // daemon-applied plugin runtime, which no unit process provides.
      workspaceScm: {
        inspectLocation: async () => null,
        verifyRecordedWorkspace: async () => 'available' as const,
      },
      onCommittedTransition,
      storage: { observeChanges: quietStorageChanges, execute },
    });
    const claimClient = {
      startRun: vi.fn(), heartbeatRun: vi.fn(async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs), succeedRun: vi.fn(), failRun: vi.fn(),
    };
    let coordinationFailure: unknown;
    await executeClaimedRun({
      machineId, claimClient,
      heartbeatMs: 60_000, leaseDurationMs: 120_000, coordinateWorkflowRun: async (claim) => {
        try { return await coordinate(claim); } catch (error) { coordinationFailure = error; throw error; }
      },
      claimed: {
        protocol: 'v3', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        automation: { id: 'automation-1' },
        run: {
          id: runId, automationId: 'automation-1', attempt: 0, leaseExpiresAt: Date.now() + 120_000, revision: 0,
          origin: { kind: 'automation', automationId: 'automation-1' }, recipeKind: 'workflow-v2',
          executionInputEnvelope: definitionEnvelope, automationEvidenceEnvelope,
          causeWorkDepth: 0,
          cause: { kind: 'conversation', occurrenceKey: 'A'.repeat(43), occurredAt: 1 }, triggerId: null,
        },
      } as never,
    });
    if (coordinationFailure) throw coordinationFailure;
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ operation: 'accepted-snapshot.resolve' });
    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.admit')).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'transition')).toBe(true);
    for (const [operation] of execute.mock.calls) {
      if (['accepted-snapshot.resolve', 'initialize', 'invocations.admit', 'invocations.fact', 'transition']
        .includes(String(operation.operation))) {
        expect(operation.accountCurrentness).toEqual({ mode: 'plain', version: 1, contentKeyFingerprint: null });
      }
    }
    const transitions = execute.mock.calls.map(([operation]) => operation).filter((operation) => operation.operation === 'transition');
    expect(transitions.at(-1)).toMatchObject({
      resultEnvelope: expect.any(String),
      invocationTransitions: [expect.objectContaining({ expectedLifecycle: 'running', lifecycle: 'completed' })],
    });
    expect(onCommittedTransition).toHaveBeenCalledOnce();
    expect(lostFinalTransitionResponse).toBe(true);
  });
});
