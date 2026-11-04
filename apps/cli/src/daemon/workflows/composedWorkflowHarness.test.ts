import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import {
  admitAgentStartV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  AutomationRunCauseSchema,
  AutomationTriggerIdSchema,
  AutomationStoredWorkflowDefinitionV2Schema,
  AutomationDefinitionDetailSchema,
  AutomationV3WorkerClaimResponseSchema,
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
  getActionSpec,
  ActionIdSchema,
  AcpConfigOptionOverridesV1Schema,
  ConnectedServiceBindingsV2IngressSchema,
  deriveAutomationOccurrenceKeyV1,
  WorkflowProgressEnvelopeV1Schema,
  WorkflowRunSummaryV1Schema,
  WorkflowStepSchema,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  openWorkflowCheckpointStoredEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1,
  materializeWorkflowAcceptedSnapshotV1,
  parseWorkflowStoredContentEnvelopeV1,
  prepareWorkflowRunDataKeyV1,
  resolveWorkflowRunDataKeyV1,
  WorkflowRunRecipientCensusResponseV1Schema,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealAccountScopedBlobCiphertext,
  serializeWorkflowStoredContentEnvelopeV1,
  serializeAutomationRunExecutionRecipeV1,
  type WorkflowDefinitionV1,
  type WorkflowRunDataKeyV1,
  type WorkflowRunInvocationIndexV1,
  type WorkflowStep,
} from '@happier-dev/protocol';
import type { WaitForSessionInputReplyResult } from '@/session/services/sendSessionMessage';
import type { ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { AvailableAutomationAccountEncryptionV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { StoredCredentials } from '@/persistence';
import type { AutomationDefinitionDetail, AutomationDefinitionReconcileRequest } from '@happier-dev/protocol';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN } from '../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { projectWorkflowPermissionRequests } from '../../../../../apps/ui/sources/components/workflows/run/workflowPermissionRequests';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { ApiMachineClient } from '@/api/apiMachine';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema,
  SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { buildSessionTurnsProjectionV1, SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SessionMessageReplyCapabilityV1Schema, SessionMessageReplyReadResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { TranscriptRow } from '@/api/session/fetchEncryptedTranscriptWindow';
import type { TranscriptMessageLookupResult } from '@/api/session/transcriptMessageLookup';
import type { SessionTurnV1 } from '@happier-dev/protocol';

const nativeLaunchBoundary = vi.hoisted(() => ({ child: null as ChildProcess | null,
  cancel: null as import('../spawn/startupLaunchCancellation').CancelStartupLaunch | null }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) =>
    nativeLaunchBoundary.child && args[0] === '/bin/sh'
      ? nativeLaunchBoundary.child : actual.spawn(...args) };
});
vi.mock('../platform/windows/spawnHappyCliVisibleConsole', () => ({
  startHappySessionInVisibleWindowsConsole: async () => {
    if (!nativeLaunchBoundary.child?.pid || !nativeLaunchBoundary.cancel) throw new Error('missing_windows_os_boundary');
    return { ok: true, pid: nativeLaunchBoundary.child.pid, processStartTimeMs: 1,
      cancel: nativeLaunchBoundary.cancel };
  },
}));

// Machine RPC is the process-launch boundary. Keep authorization, persisted
// Agent resume selection and readiness-before-input ownership real.
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => {
  const actual = await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>();
  const launch = async ({ method, request }: {
    method: string; request: { sessionId?: string; spawnNonce?: string };
  }) => {
    if (method === RPC_METHODS.SPAWN_HAPPY_SESSION && !request.sessionId && freshSessionBoundary) {
      const response = await freshSessionBoundary(request);
      if (response && typeof response === 'object' && 'sessionId' in response && typeof response.sessionId === 'string') {
        const spawn = SpawnDaemonSessionRequestSchema.parse(request);
        if (spawn.sessionCreationTag) freshSessionCreationTags.set(spawn.sessionCreationTag, response.sessionId);
        const existing = freshSessionRecords.get(response.sessionId);
        const birth = buildCommittedLaunchMetadata({ options: spawn, directory: spawn.directory, accountSettings: {} });
        freshSessionRecords.set(response.sessionId, existing?.metadataLayoutVersion === 1 ? existing : existing ? { ...existing,
          metadata: JSON.stringify({ ...JSON.parse(existing.metadata ?? '{}'), sessionCreationCorrespondenceV1: birth.sessionCreationCorrespondenceV1 }) }
          : createSessionRecordFixture({ id: response.sessionId, encryptionMode: 'plain', metadata: JSON.stringify(birth) }));
      }
      return response;
    }
    if (method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE && freshSessionNonceBoundary) {
      return freshSessionNonceBoundary(request);
    }
    if (method === RPC_METHODS.SPAWN_HAPPY_SESSION && request.sessionId && request.spawnNonce) {
      const { createSpawnNewSessionLifecycleActionHandler } = await import('@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler');
      // Only the native process boundary is substituted. Defer the import
      // until invocation because the lifecycle owner's Account ports use RPC.
      const resume = createSpawnNewSessionLifecycleActionHandler({
        spawnSession: async options => {
          const existing = freshSessionRecords.get(options.existingSessionId!);
          if (existing) freshSessionRecords.set(existing.id, { ...existing, active: true });
          return { type: 'success', sessionId: options.existingSessionId! };
        },
      });
      return await resume(request);
    }
    return { status: 'not_found' };
  };
  return { ...actual, callMachineRpc: launch, callExactMachineRpc: launch };
});

import { executeClaimedRun } from '@/daemon/automation/automationRunExecutor';
import { startAutomationWorker } from '@/daemon/automation/automationWorker';
import { createAutomationClaimClient } from '@/daemon/automation/automationClaimClient';
import { dispatchActionFromRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { createWorkflowActionExecutor } from '@/session/actions/workflowActionExecutor';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createWorkflowDefinitionActions as createCliWorkflowDefinitionActions } from '@/session/actions/workflowDefinitions';
import { createWorkflowRunActionOwner } from '@/session/actions/workflowRunActions';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createExecutionRunRpcActionExecutor } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { workflowInvocationKey, WORKFLOW_CANCEL_REQUESTED_ABORT_REASON, WorkflowRuntimeInterruption } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { createProductionDaemonWorkflowRuntime, createWorkflowInvocationRecoveryObserver, resolveWorkflowSessionConversation } from './daemonRuntime';
import { createWorkflowRunRecoveryReader } from './recovery';
import { createGitWorkflowWorkspaceTestDependencies } from './workflowWorkspace.testkit';

import { createWorkflowProducerBinding } from './workflowScopeBinding';
import { bindAutomationWorkflowInputs, isWorkflowJsonObject } from './input';
import { createProductionWorkflowRunCoordinator } from './production';
import { createWorkflowSessionStepExecutor, type WorkflowSessionStartup } from './sessionStepExecutor';
import { runObservedWorkflowSessionStartup } from './workflowSessionStartup';
import { readExecutionRunWorkflowObservationSink, type ExecutionRunWorkflowObservationSink } from '@/agent/runtime/bridges/executionRun/executionRunWorkflowObservation';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createMachineSessionSpawnRpcHandler } from '@/session/actions/sessionLifecycleActions';
import { awaitTrackedRunnerAgentSessionOpen } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { createWorkflowOriginContextInputPort } from '@/agent/runtime/session/contextOnly/workflowOriginInput';
import * as cliSpawn from '@/utils/spawnHappyCLI';
import { spawnRegularProcessAndWaitForWebhook } from '../spawn/spawnRegularProcessAndWaitForWebhook';
import { waitForTerminalHostedSessionWebhook } from '../spawn/waitForTerminalHostedSessionWebhook';
import { TmuxUtilities } from '@/integrations/tmux/TmuxUtilities';
import { spawnWindowsHostedSessionAndWaitForWebhook } from '../spawn/spawnWindowsHostedSessionAndWaitForWebhook';
import { createExactWindowsProcessCancellation } from '../platform/windows/windowsProcessCustody';
import { hashProcessCommand } from '../sessionRegistry';
import { createSpawnLifecycleCallbacks } from '../spawn/createSpawnLifecycleCallbacks';
import { createOnChildExited } from '../sessions/onChildExited';
import type { TrackedSession } from '../types';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { projectSpawnSessionControlErrorResponse, SpawnSessionControlErrorResponseSchema } from '@/session/shared/spawnSessionContract';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { SessionLaunchRetiredV1Schema } from '@happier-dev/protocol/spawnSession';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { reloadConfiguration } from '@/configuration';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { resolveSpawnChildEnvironment } from '../spawn/resolveSpawnChildEnvironment';
import { buildSpawnChildProcessEnv } from '../spawn/buildSpawnChildProcessEnv';
import {
  createWorkflowRunStorageTestkit,
  type WorkflowRunStorageTestkit,
  type WorkflowRunStorageTestkitOperation,
} from './workflowRunStorage.testkit';
import {
  createCoordinatorWorkspaceResolver,
  normalizeWorkflowProjectTarget,
  prepareWorkflowAcceptedWorkspaceTarget,
  resolveWorkflowWorkspace,
} from './resolveWorkflowWorkspace';

function unexpectedWorkflowDefinitions() {
  const unexpected = (): never => { throw new Error('unexpected_definition_effect'); };
  // Fake only Artifact persistence; definition admission and codecs stay real.
  return createWorkflowDefinitionActions({
    artifactStore: { read: unexpected, list: unexpected, create: unexpected, update: unexpected, delete: unexpected },
    encodeListCursor: unexpected,
    assertDefinitionWriteAllowed: unexpected,
  });
}

const accountId = 'account-1';
const machineId = 'machine-1';
const sessionId = 'session-1';
const currentness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
const authorization = { admittedPermissionCeiling: 'safe-yolo' as const, principal: { kind: 'host' as const } };
const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

const temporaryDirectories: string[] = [];
const authorizedConversations = new Map<string, string>();
const freshSessionRecords = new Map<string, ReturnType<typeof createSessionRecordFixture>>();
const freshSessionCreationTags = new Map<string, string>();
let freshSessionBoundary: ((request: unknown) => unknown) | null = null;
let freshSessionNonceBoundary: ((request: unknown) => unknown) | null = null;
let readinessCurrentness: AvailableAutomationAccountEncryptionV1['witness'] = currentness;

async function readSessionReadiness(url: string) {
  if (url.endsWith('/messages/reply-capability')) return { status: 200,
    data: SessionMessageReplyCapabilityV1Schema.parse({ v: 1, protocolVersions: [1] }) };
  if (/\/messages\/by-local-id\/[^/]+\/reply$/.test(new URL(url, 'http://workflow-home.test').pathname)) return { status: 200,
    data: SessionMessageReplyReadResultV1Schema.parse({ v: 1, status: 'none' }) };
  if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
    data: createAccountEncryptionCurrentnessFixture({ ...readinessCurrentness, updatedAt: 1 }) };
  const id = /\/v2\/sessions\/([^/?]+)/.exec(url)?.[1];
  const fresh = id ? freshSessionRecords.get(id) : undefined;
  if (fresh) return { status: 200, data: { session: fresh } };
  const directory = id ? authorizedConversations.get(id) : undefined;
  if (!id || !directory) throw new Error(`Unexpected Session readiness read: ${url}`);
  return { status: 200, data: { session: createSessionRecordFixture({ id, active: true,
    encryptionMode: 'plain', machineId, metadata: JSON.stringify({ machineId, path: directory,
      claudeSessionId: 'native-session', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
    }),
  }) } };
}

async function writeSessionReadiness(url: string, body: unknown) {
  if (!url.endsWith('/v2/sessions/lookup-by-tags') || !body || typeof body !== 'object'
    || !('tags' in body) || !Array.isArray(body.tags) || typeof body.tags[0] !== 'string') {
    throw new Error(`Unexpected Session readiness write: ${url}`);
  }
  if (body.tags[0].startsWith('create:v1:')) {
    const tags = body.tags;
    return { status: 200, data: { sessions: [...freshSessionCreationTags].flatMap(([tag, id]) => {
      const session = freshSessionRecords.get(id);
      return tags.includes(tag) && session ? [session] : [];
    }) } };
  }
  const response = await readSessionReadiness(`/v2/sessions/${body.tags[0]}`);
  if (!('session' in response.data)) throw new Error('Session readiness response missing record');
  return { status: 200, data: { sessions: [response.data.session] } };
}

beforeEach(() => {
  authorizedConversations.clear();
  freshSessionRecords.clear();
  freshSessionCreationTags.clear();
  freshSessionBoundary = null;
  freshSessionNonceBoundary = null;
  readinessCurrentness = currentness;
  vi.spyOn(axios, 'get').mockImplementation(readSessionReadiness);
  vi.spyOn(axios, 'post').mockImplementation(writeSessionReadiness);
});

afterEach(async () => {
  nativeLaunchBoundary.child = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

/**
 * A real project directory. The production workspace resolver stats and
 * inspects the accepted checkout through the canonical SCM/path owners, so a
 * composed run cannot use an invented `/repo` string.
 */
async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'happier-composed-workflow-'));
  temporaryDirectories.push(directory);
  return directory;
}

function step(id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return WorkflowStepSchema.parse({
    kind: 'step', id, document: { text: id, references: [], attachments: [] },
    input: [], result: { kind: 'text' }, ...overrides,
  });
}

/** Every composed definition reuses one already-open conversation so the leaf never spawns a real Session. */
function retainedConversationDefaults() {
  return { agentTarget, conversation: { kind: 'existing_session' as const, sessionId, machineId } };
}

async function sealDirectAccepted(input: Readonly<{
  runId: string;
  definition: WorkflowDefinitionV1;
  directory: string;
  deliverResult?: boolean;
  runCrypto?: WorkflowRunDataKeyV1;
  actionRequestAttributionV1?: ActionRequestAttributionV1;
}>): Promise<string> {
  const runCrypto = input.runCrypto ?? { mode: 'plain' as const };
  const sealMode = runCrypto.mode === 'e2ee'
    ? { ...runCrypto, randomBytes: (length: number) => new Uint8Array(length).fill(3) } : runCrypto;
  const materialized = await materializeWorkflowAcceptedSnapshotV1({
    definition: input.definition,
    admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true },
    context: {
      source: { kind: 'inline' },
      inputs: {},
      machineId,
      executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId, directory: input.directory, checkoutRootPath: input.directory } },
      origin: { kind: 'direct', ...(input.deliverResult ? { originSessionId: sessionId } : {}),
        ...(input.actionRequestAttributionV1 ? { actionRequestAttributionV1: input.actionRequestAttributionV1 } : {}) },
      authorization,
      ...(input.deliverResult ? { resultDelivery: { kind: 'originating_session' as const, originSessionId: sessionId } } : {}),
    },
  });
  if (!materialized.ok) throw new Error(JSON.stringify(materialized.error));
  return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    ...sealMode,
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: input.runId },
    acceptedSnapshot: { ...materialized.snapshot, authorization },
  }));
}

type LeafOutcome = 'completed' | 'failed' | 'needs_attention';

/** The first prompt line is the authored step document, so it labels the leaf. */
function leafLabel(text: string): string {
  return text.split('\n', 1)[0]!.trim();
}

function sessionInputBoundary(
  outcomes: Readonly<Record<string, LeafOutcome | Extract<WaitForSessionInputReplyResult, { ok: true }>['result']>> = {},
  hooks: Readonly<{ sessionId?: string; onObserve?: (label: string, signal?: AbortSignal) => Promise<void> }> = {},
) {
  const destinationSessionId = hooks.sessionId ?? sessionId;
  const enqueue = vi.fn(async (request: Readonly<{ text: string }>) => ({
    status: 'accepted' as const,
    localId: leafLabel(request.text),
  }));
  const observe = vi.fn(async (request: Parameters<typeof import('./stepExecution').observeWorkflowSessionInputResult>[0]) => {
    // The Session boundary reports the persisted input before its terminal turn.
    await request.onInputMaterialized?.(Date.now());
    await hooks.onObserve?.(request.localId, request.signal);
    const outcome = outcomes[request.localId] ?? 'completed';
    if (typeof outcome !== 'string') {
      return { ok: true as const, sessionId: destinationSessionId, localId: request.localId, result: outcome };
    }
    switch (outcome) {
      case 'needs_attention':
        return { ok: false as const, code: 'workflow_step_timeout' };
      case 'failed':
        return { ok: true as const, sessionId: destinationSessionId, localId: request.localId,
          result: { kind: 'failed' as const, message: 'Provider rejected the required step input' } };
      default:
        return {
          ok: true as const, sessionId: destinationSessionId, localId: request.localId,
          result: { kind: 'final_text' as const, text: request.localId },
        };
    }
  });
  const cancel = vi.fn(async () => ({ kind: 'turn_cancel_requested' as const }));
  return {  enqueue, observe, cancel };
}

/**
 * One production daemon "process". Each call builds a brand new coordinator,
 * conversation owner, workspace resolver and `DurableWorkflowCoordinatorStore`
 * over whatever bytes the storage boundary already holds, so calling it twice
 * is a genuine process replacement rather than a reused in-memory store.
 */
function workflowDaemonProcess(input: Readonly<{
  storage: Readonly<{ execute: WorkflowRunStorageTestkit['execute'] }>;
  sessionInput?: ReturnType<typeof sessionInputBoundary>;
  machineAdmissionTransport?: Parameters<typeof createProductionWorkflowRunCoordinator>[0]['execution']['machineAdmissionTransport'];
  directory: string;
  encryption?: AvailableAutomationAccountEncryptionV1;
  credentials?: StoredCredentials;
  conversationSessionId?: string;
  readActualConversation?: boolean;
  onReviewEntered?: (entry: Readonly<{ runId: string }>) => Promise<void>;
  sessionStartup?: WorkflowSessionStartup;
  detachedRun?: Parameters<typeof createProductionWorkflowRunCoordinator>[0]['execution']['detachedRun'];
}>) {
  authorizedConversations.set(input.conversationSessionId ?? sessionId, input.directory);
  readinessCurrentness = input.encryption?.witness ?? currentness;
  const unusedRunActions = { execute: vi.fn(async () => ({ ok: false as const, errorCode: 'unused' })) };
  const actionContext = () => ({ surface: 'agent' as const, authority: 'account_automation' as const });
  return createProductionWorkflowRunCoordinator({
    resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
    token: 'token',
    accountId,
    machineId,
    resolveAccountEncryption: async () => input.encryption ?? { kind: 'available', witness: currentness },
    isAcceptedAuthorizationCurrent: async () => true,
    // Opened Account policy and exact-Machine availability are host boundaries;
    // the canonical materializer and ORC admission decision remain real.
    resolveMaterializationHost: async ({ runId, workDepth, directory, originSessionId }) => ({
      effects: { resolveTargetAvailability: async () => true,
        readActionContract: async actionId => {
          const parsed = ActionIdSchema.safeParse(actionId);
          if (!parsed.success) return null;
          const spec = getActionSpec(parsed.data);
          return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(spec));
        } },
      admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        { kind: 'workflow_run_leaf', leaf }, {
          caller: { kind: 'originless', runId, runDepth: workDepth,
            ...(originSessionId ? { runOriginSessionId: originSessionId } : {}) },
          baseline: { machineId, directory }, ledSubtreeSessionIds: [],
          roles: facts.role ? { [facts.role.roleId]: facts.role } : {},
          workDepthLimit: 4, callerPermissionCeiling: facts.permissionCeiling,
        }),
    }),
    execution: {
      credentials: input.credentials ?? { token: 'token', encryption: null },
      serverId: 'server-1',
      ...(input.sessionStartup ? { sessionStartup: input.sessionStartup } : {}),

      machineAdmissionTransport: input.machineAdmissionTransport ?? vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' })) as never,
      resolveExistingSessionConversation: input.readActualConversation
        ? async params => await resolveWorkflowSessionConversation({ ...params, credentials: input.credentials ?? { token: 'token', encryption: null } })
        : async () => ({ sessionId: input.conversationSessionId ?? sessionId, machineId, directory: input.directory, agentTarget }),
      ...(input.sessionInput ? { sessionInput: input.sessionInput as never } : {}),
      detachedRun: input.detachedRun ?? { actionExecutor: unusedRunActions as never, buildActionContext: actionContext as never },
    },
    // The daemon-applied plugin process is a real boundary. Exercise its real
    // Git registration and SCM logic through the canonical workspace testkit.
    prepareAcceptedWorkspaceTarget: async () => ({
      ok: true,
      workspaceTarget: { project: { machineId, directory: input.directory, checkoutRootPath: input.directory } },
    }),
    workspaceScm: createGitWorkflowWorkspaceTestDependencies(),
    onCommittedTransition: vi.fn(),
    onReviewEntered: input.onReviewEntered ?? vi.fn(),
    storage: input.storage as never,
  });
}

/** Loses exactly one terminal parent settlement, leaving every durable row intact. */
function storageLosingFirstSettlement(kit: WorkflowRunStorageTestkit) {
  let pending = true;
  return {
    execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
      if (pending && String(operation.operation) === 'transition' && String(operation.state) !== 'running') {
        pending = false;
        throw new Error('simulated_daemon_loss_before_settlement');
      }
      return await kit.execute(operation, options);
    },
    settlementWasLost: () => !pending,
  };
}

function openRowProgress(kit: WorkflowRunStorageTestkit, index: WorkflowRunInvocationIndexV1, runCrypto: WorkflowRunDataKeyV1 = { mode: 'plain' }) {
  const row = kit.rowById(index.id);
  if (!row) throw new Error('missing_row');
  const opened = openWorkflowProgressStoredEnvelopeV1({
    ...runCrypto,
    binding: {
      v: 1, purpose: 'invocation_progress', accountId, runId: index.runId,
      recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
      memberOrdinal: index.memberOrdinal, attempt: index.attempt,
    },
    envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope),
  });
  if (opened.kind !== 'available') throw new Error(opened.kind);
  return WorkflowProgressEnvelopeV1Schema.parse(opened.content);
}

function rowFor(kit: WorkflowRunStorageTestkit, blockId: string, runCrypto: WorkflowRunDataKeyV1 = { mode: 'plain' }): WorkflowRunInvocationIndexV1 | undefined {
  return kit.rows()
    .map((row) => row.index)
    .find((index) => openRowProgress(kit, index, runCrypto).invocationPath.blockId === blockId);
}

function fanOutDefinition(failurePolicy: 'collect_outcomes' | 'fail_stop'): WorkflowDefinitionV1 {
  return {
    version: 1,
    inputs: [],
    defaults: retainedConversationDefaults(),
    blocks: [
      {
        kind: 'parallel',
        id: 'fan',
        failurePolicy,
        branches: [
          { id: 'healthy', blocks: [step('good')] },
          { id: 'broken', blocks: [step('bad'), step('must-not-run')] },
        ],
      },
      step('summary', {
        input: [{ kind: 'result', producer: { blockId: 'fan', scope: { kind: 'current' } }, path: [] }],
      }),
    ],
    finalOutput: { kind: 'result', producer: { blockId: 'summary', scope: { kind: 'current' } }, path: [] },
  };
}

it.each(['ordinary', 'claim-lost-during-startup'] as const)('delivers a saved three-step Test through Session spawn, Machine admission and exact-turn observation (%s)', async mode => {
  const channel = await createRequesterCurrentnessSocketHarness();
  onTestFinished(() => channel.close());
  const runId = '44444444-4444-4444-8444-444444444444';
  const childId = 'c444444444444444444444444';
  const directory = await projectDirectory();
  const credentials = { token: 'token', encryption: null };
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget, connectedServices: {
    v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': { source: 'native' },
      'happier.agent.claude/anthropic': { source: 'native' } },
  } }, blocks: [
    step('first', { document: { text: 'FX44_FIRST', references: [], attachments: [] } }),
    step('producer', { document: { text: 'FX44_PRODUCE', references: [], attachments: [] },
      result: { kind: 'json', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } } }),
    step('consumer', { document: { text: 'FX44_CONSUME', references: [], attachments: [] },
      input: [{ kind: 'result', producer: { blockId: 'producer', scope: { kind: 'current' } }, path: ['name'] }] }),
  ] };
  const definitionId = '44444444-5555-4444-8444-444444444444';
  let artifact: Record<string, unknown> = {};
  const transcripts: TranscriptMessageLookupResult[] = [];
  const turns: SessionTurnV1[] = [];
  const prompts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith(`/v1/artifacts/${definitionId}/access/recipients`)) return { status: 200, data: {
      artifactId: definitionId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] } };
    if (parsed.pathname.endsWith(`/v1/artifacts/${definitionId}`)) return { status: 200, data: artifact };
    if (parsed.pathname.endsWith(`/v1/sessions/${childId}/turns`)) return { status: 200,
      data: SessionTurnsProjectionV1Schema.parse(buildSessionTurnsProjectionV1({ sessionId: childId, updatedAt: Date.now(), turns })) };
    if (parsed.pathname.endsWith('/reply')) return await readSessionReadiness(String(url));
    if (parsed.pathname.includes('/messages/by-local-id/')) return { status: 200, data: { message:
      transcripts.find(row => row.localId === decodeURIComponent(parsed.pathname.split('/').at(-1)!)) } };
    if (parsed.pathname.endsWith(`/v1/sessions/${childId}/messages`)) return { status: 200, data: {
      messages: transcripts.filter(row => row.seq > Number(parsed.searchParams.get('afterSeq') ?? 0)) satisfies TranscriptRow[] } };
    return await readSessionReadiness(String(url));
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (!String(url).endsWith('/v1/artifacts')) return await writeSessionReadiness(String(url), body);
    if (!body || typeof body !== 'object') throw new Error('Invalid Artifact HTTP write');
    artifact = { ...body, id: definitionId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    return { status: 200, data: artifact };
  });
  const artifactStore = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' });
  await artifactStore.create({ artifactId: definitionId, header: { kind: 'workflow-definition.v1', definitionId,
    revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'QA44 Session Test' } },
    savedBy: { kind: 'person', accountId }, body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' } });
  const owner = createWorkflowRunActionOwner({ resolveAccountId: async () => accountId, storage: kit,
    definitions: createCliWorkflowDefinitionActions({ artifactStore }),
    resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
    resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } } }),
  });
  const actions = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: async () => true,
    definitions: createCliWorkflowDefinitionActions({ artifactStore }), runs: owner });
  const admitted = await actions({ actionId: 'workflow.run.start', input: { runId,
    source: { kind: 'saved', definitionId, revision: { headerVersion: 1, bodyVersion: 1 } } },
    context: { surface: 'rpc', authority: 'account_automation', callerPermissionMode: 'safe-yolo',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'safe-yolo' },
      externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory } } } });
  expect(admitted).toMatchObject({ admission: 'created' });
  let launches = 0;
  const workerLifetime = new AbortController();
  const scope = { accountId, machineId };
  const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => accountId,
    generateOperationId: () => 'retained-startup' });
  let interrupted = false;
  const spawnHandler = createMachineSessionSpawnRpcHandler({ handlers: {
    stopSession: async () => { throw new Error('Successful startup must not retire its runner'); },
    spawnSession: async options => {
    launches++;
    const metadata = buildCommittedLaunchMetadata({ options, directory, accountSettings: {} });
    freshSessionRecords.set(childId, createSessionRecordFixture({ id: childId, active: true, encryptionMode: 'plain', machineId,
      metadata: JSON.stringify({ ...metadata, machineId, permissionMode: 'default',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }), origin: { kind: 'run_step', runId }, workDepth: 1 }));
    return { type: 'success', sessionId: childId, sessionCreationOutcome: {
      disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
  } }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ ...input, getTrackedSessions: () => [{
    pid: 101, startedBy: 'daemon', happySessionId: childId,
    agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json',
    agentRuntimeDaemonServiceSessionOpenAttestation: {
      request: { kind: 'create', sessionId: childId, cwd: directory }, providerSessionId: 'native',
    },
  }] }) });
  freshSessionBoundary = async raw => await spawnHandler(raw);
  const sessionStartup: WorkflowSessionStartup = input => runObservedWorkflowSessionStartup({ ...input,
    onObservation: async operation => {
      await input.onObservation?.(operation);
      if (mode === 'claim-lost-during-startup' && !interrupted) {
        interrupted = true;
        // The real executor forwards worker/lease loss with this same bare abort.
        // Losing observation after the durable startup fact cannot abort its owner.
        workerLifetime.abort();
      }
    },
  }, { serverId: 'server-1', machineId, observeExecution: operations.observeExecution, rpcContext: {},
    transport: operation => ({ spawn: (request, options) => spawnHandler(request, { ...options, localActionContext: operation }),
      resolveSpawnSessionByNonce: async () => { throw new Error('No replacement startup'); } }),
    observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
      ...(options.waitForTerminal ? { waitForTerminal: true } : {}) }, options.signal ? { signal: options.signal } : undefined),
    cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
  });
  const machine = new ApiMachineClient('token', { id: machineId, encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: null, daemonStateVersion: 0, dataEncryptionKey: 'plain' });
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1) throw new Error(`Unexpected Machine event: ${event}`);
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(payload);
    expect(request.targetMachineId).toBe(machineId);
    expect(request.sessionId).toBe(childId);
    if (request.content.t !== 'plain') throw new Error('Unexpected encrypted Session input');
    const record = request.content.v;
    expect(record).toMatchObject({ meta: { happierInputRequestV1: { v: 2, producer: 'workflow',
      caller: { kind: 'host' }, workflow: { purpose: 'invocation', runId } },
      happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId } } });
    if (!record || typeof record !== 'object' || Array.isArray(record) || !('content' in record)
      || !record.content || typeof record.content !== 'object' || Array.isArray(record.content)
      || !('text' in record.content) || typeof record.content.text !== 'string') throw new Error('Missing provider input');
    const text = record.content.text;
    prompts.push(text);
    const reply = text.startsWith('FX44_PRODUCE') ? '{"name":"FX44_NAMED_VALUE"}'
      : text.startsWith('FX44_CONSUME') ? text.includes('FX44_NAMED_VALUE') ? 'FX44_CONSUMED' : 'FX44_MISSING_VALUE' : 'FX44_STARTED';
    const now = Date.now();
    const seq = transcripts.length + 1;
    transcripts.push({ id: `message-${seq}`, seq, localId: request.localId, sidechainId: null, createdAt: now, updatedAt: now, content: request.content });
    transcripts.push({ id: `message-${seq + 1}`, seq: seq + 1, localId: null, sidechainId: null, createdAt: now + 1, updatedAt: now + 1,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: {
        role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' } } } } } });
    turns.push({ turnId: `turn-${seq}`, status: 'completed', startedAt: now, updatedAt: now + 1, terminalAt: now + 1,
      transcriptAnchors: { startUserMessageSeq: seq, userMessageSeqs: [seq], finalAssistantMessageSeq: seq + 1, endSeqInclusive: seq + 1 } });
    return SessionPendingEnqueueByMachineResponseV1Schema.parse({ v: 1, result: { status: 'accepted', localId: request.localId } });
  } });
  // Install only the Socket.IO network boundary. ApiMachine admission, the
  // Session sender, exact-input observer and all Workflow owners remain real.
  Reflect.set(machine, 'socket', socket);
  try {
    const coordinate = workflowDaemonProcess({ storage: kit, directory, credentials, readActualConversation: true, sessionStartup,
      machineAdmissionTransport: (request, options) => machine.enqueueSessionPendingByMachine(request, options) });
    if (mode === 'claim-lost-during-startup') {
      await executeClaimedRun({ machineId, heartbeatMs: 5_000, leaseDurationMs: 30_000, signal: workerLifetime.signal,
        claimClient: createAutomationClaimClient({ token: 'token', createPublisherHeader: async () => null }),
        coordinateWorkflowRun: coordinate,
        claimed: { protocol: 'v3', automation: null, accountCurrentness: currentness,
          run: { id: runId, automationId: null, attempt: 0, leaseExpiresAt: Date.now() + 120_000, revision: kit.run().revision,
            origin: { kind: 'direct' }, triggerId: null, workflowAcceptedSnapshotEnvelope: kit.acceptedEnvelope()! } } });
      expect(await operations.handlers.getV2({ operationId: 'retained-startup', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: { sessionId: childId } } });
      expect(prompts).toEqual([]);
    }
    const result = await coordinate({ runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()! });
    expect(result, JSON.stringify(kit.rows().map(row => openRowProgress(kit, row.index)))).toMatchObject({ state: 'succeeded' });
    expect(launches).toBe(1);
    expect(prompts.map(text => text.split('\n')[0])).toEqual(['FX44_FIRST', 'FX44_PRODUCE', 'FX44_CONSUME']);
    expect(prompts[2]).toContain('FX44_NAMED_VALUE');
    expect(openRowProgress(kit, rowFor(kit, 'first')!).result).toBe('FX44_STARTED');
    expect(openRowProgress(kit, rowFor(kit, 'producer')!).result).toEqual({ name: 'FX44_NAMED_VALUE' });
    expect(openRowProgress(kit, rowFor(kit, 'consumer')!).result).toBe('FX44_CONSUMED');
  } finally { await machine.shutdown(); }
}, 30_000);

it.each(['missing', 'materialized'] as const)('surfaces reclaimed admission without an observed input instead of waiting forever (%s)', async evidence => {
  const channel = await createRequesterCurrentnessSocketHarness();
  onTestFinished(() => channel.close());
  const directory = await projectDirectory();
  const runId = '59595959-5959-4595-8595-595959595959';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: retainedConversationDefaults(),
    blocks: [step('first'), ...(evidence === 'missing' ? [step('must-not-admit')] : [])] };
  const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
  let lost = false;
  const coordinate = workflowDaemonProcess({ directory, readActualConversation: true, storage: {
    execute: async (operation, options) => {
      const response = await kit.execute(operation, options);
      if (!lost && operation.operation === 'invocations.fact' && operation.lifecycle === 'admitting') {
        lost = true;
        // The persisted admission is not proof that the following send ran.
        throw new WorkflowRuntimeInterruption();
      }
      return response;
    },
  }, machineAdmissionTransport: async () => { throw new Error('Ambiguous admission must not replay input'); } });
  await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness, acceptedEnvelope }))
    .rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
  expect(rowFor(kit, 'first')?.lifecycle).toBe('admitting');
  expect(openRowProgress(kit, rowFor(kit, 'first')!)).not.toHaveProperty('execution');
  const controller = new AbortController();
  let interruptWait: ReturnType<typeof setImmediate> | undefined;
  let inputReads = 0;
  let observedInputId = '';
  const inputMessage = () => ({ id: 'observed-workflow-input', seq: 1, localId: observedInputId,
    createdAt: 1, updatedAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'first' } } } });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/reply')) return await readSessionReadiness(String(url));
    if (String(url).includes('/messages/by-local-id/')) {
      inputReads++;
      if (evidence === 'materialized') {
        observedInputId = decodeURIComponent(String(url).split('/').at(-1)!);
        return { status: 200, data: { message: inputMessage() } };
      }
      throw Object.assign(new Error('Message not found'), { isAxiosError: true,
        response: { status: 404, data: { error: 'Message not found' } } });
    }
    if (String(url).endsWith('/turns')) return { status: 200, data: buildSessionTurnsProjectionV1({ sessionId, updatedAt: 2,
      turns: [{ turnId: 'observed-workflow-turn', status: inputReads === 1 ? 'in_progress' : 'completed', startedAt: 1, updatedAt: 2,
        ...(inputReads === 1 ? {} : { terminalAt: 2 }),
        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1,
          ...(inputReads === 1 ? {} : { finalAssistantMessageSeq: 2, endSeqInclusive: 2 }) } }] }) };
    if (String(url).includes('/messages?')) return { status: 200, data: { messages: [inputMessage(),
      ...(inputReads === 1 ? [] : [{ id: 'observed-workflow-result', seq: 2, localId: null, createdAt: 2, updatedAt: 2,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'original input completed' } } } }])]
      .filter(row => row.seq > Number(new URL(String(url)).searchParams.get('afterSeq') ?? 0)) } };
    if (String(url).includes('/pending')) {
      // End an incorrect unbounded observer at its first event wait, allowing
      // RED to assert the missing visible result without a test timeout.
      interruptWait = setImmediate(() => controller.abort());
      return { status: 200, data: { pending: [] } };
    }
    return await readSessionReadiness(String(url));
  });
  try {
    const result = coordinate({ runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope, signal: controller.signal });
    await expect(result).resolves.toMatchObject(evidence === 'missing'
      ? { state: 'interrupted', reason: 'workflow_admission_ack_uncertain' } : { state: 'succeeded' });
    expect(inputReads).toBeGreaterThan(0);
    expect(rowFor(kit, 'first')?.lifecycle).toBe(evidence === 'missing' ? 'needs_attention' : 'completed');
    expect(openRowProgress(kit, rowFor(kit, 'first')!)).toMatchObject(evidence === 'missing'
      ? { reason: { code: 'workflow_admission_ack_uncertain' } } : { result: 'original input completed' });
    expect(rowFor(kit, 'must-not-admit')).toBeUndefined();
  } finally { if (interruptWait) clearImmediate(interruptWait); controller.abort(); }
});

it.each(['success', 'failure', 'already-stopped', 'foreign-session', 'success-during-recovery'] as const)('keeps cancelled cold startup custody until its original operation answers (%s)', async outcome => {
  const directory = await projectDirectory();
  const runId = '61616161-6161-4161-8161-616161616161';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget, connectedServices: null },
    blocks: [step('launch'), step('must-not-admit')] };
  const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
  const scope = { accountId, machineId };
  // The installed spawn owner can refuse cancellation while its native launch is pending.
  const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => accountId,
    generateOperationId: () => 'late-start' });
  let release!: () => void;
  const nativeOpen = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const launching = new Promise<void>(resolve => { started = resolve; });
  let launches = 0;
  const handler = createMachineSessionSpawnRpcHandler({ handlers: {
    stopSession: async () => { throw new Error('Cancelled startup retains its existing cleanup owner'); },
    spawnSession: async options => {
    launches++;
    started();
    await nativeOpen;
    if (outcome === 'failure') return { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE', errorMessage: 'native launch refused' };
    if (options.sessionCreationTag) freshSessionCreationTags.set(options.sessionCreationTag, 'late-child');
    freshSessionRecords.set('late-child', createSessionRecordFixture({ id: 'late-child', encryptionMode: 'plain',
      active: outcome !== 'already-stopped',
      metadata: JSON.stringify({ ...buildCommittedLaunchMetadata({ options, directory, accountSettings: {} }),
        machineId: outcome === 'foreign-session' ? 'foreign-machine' : machineId }) }));
    authorizedConversations.set('late-child', directory);
    return { type: 'success', sessionId: 'late-child', sessionCreationOutcome: {
      disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
  } }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [{
    pid: 101, startedBy: 'daemon', happySessionId: 'late-child',
    agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json',
    agentRuntimeDaemonServiceSessionOpenAttestation: {
      request: { kind: 'create', sessionId: 'late-child', cwd: directory }, providerSessionId: 'native',
    },
  }], ...input }) });
  const sessionStartup: WorkflowSessionStartup = input => runObservedWorkflowSessionStartup(input, {
    serverId: 'server-1', machineId, observeExecution: operations.observeExecution, rpcContext: {},
    transport: operation => ({ spawn: async (request, options) => {
      operation.operationAcceptance?.accept({});
      return await handler(request, { ...options, localActionContext: operation });
    }, resolveSpawnSessionByNonce: async () => { throw new Error('must_not_replace_startup'); } }),
    observeOperation: async (target, options) => operations.handlers.getV2({ operationId: target.operationId,
      ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
      ...(options.includeSetupReview ? { includeSetupReview: true } : {}) }, options.signal ? { signal: options.signal } : undefined),
    cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
  });
  const sessionInput = sessionInputBoundary();
  const stops: string[] = [];
  let startupWaitAttached = false;
  const invoke = async (method: string, request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
    if (method.endsWith('actionOperation.list.v2')) return await operations.handlers.listV2(request, options);
    if (method.endsWith('actionOperation.get.v2')) {
      if (request && typeof request === 'object' && 'waitForTerminal' in request && request.waitForTerminal === true) startupWaitAttached = true;
      return await operations.handlers.getV2(request, options);
    }
    if (method.endsWith('actionOperation.cancel.v1')) return await operations.handlers.cancel(request, options);
    throw new Error(`Unexpected retained-operation RPC: ${method}`);
  };
  vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request =>
    await invoke(request.method, request.request, request.signal ? { signal: request.signal } : undefined));
  vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
    if (request.method !== RPC_METHODS.STOP_SESSION || request.machineId !== machineId
      || !request.request || typeof request.request !== 'object' || !('sessionId' in request.request)
      || request.request.sessionId !== 'late-child') throw new Error('Wrong Session Stop wiring');
    const session = freshSessionRecords.get('late-child')!;
    stops.push(session.id);
    if (!session.active) return { status: 'not_found' };
    freshSessionRecords.set(session.id, { ...session, active: false });
    return { status: 'stopped' };
  });
  let claimed = false;
  let staleRecoveryRead = outcome === 'success-during-recovery';
  let releaseRecoveryRead = () => {};
  let recoveryReadStarted = () => {};
  const recoveryReadPending = new Promise<void>(resolve => { releaseRecoveryRead = resolve; });
  const recoveryReading = new Promise<void>(resolve => { recoveryReadStarted = resolve; });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v3/automations/worker/assignments')) return { data: { assignments: [],
      settings: { maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } } };
    if (url.endsWith('/v3/automations/worker/run-lifecycle')) return { data: { sources: [] } };
    return await readSessionReadiness(url);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
    if (url.endsWith('/discard') && url.includes('/v2/sessions/late-child/pending/')) {
      // This startup has not admitted an input. The real Pending owner returns
      // exact absence; physical Stop still has to confirm the child is stopped.
      throw Object.assign(new Error('not-found'), { isAxiosError: true, response: { status: 404, data: { error: 'not-found' } } });
    }
    if (url.endsWith('/v3/automations/runs/workflow-storage') && body && typeof body === 'object' && 'operation' in body) {
      if (body.operation === 'recovery.list' && staleRecoveryRead) {
        staleRecoveryRead = false;
        recoveryReadStarted();
        await recoveryReadPending;
        return { status: 200, data: { candidates: [] } };
      }
      return { status: 200, data: body.operation === 'recovery.list'
        ? { candidates: [{ run: kit.run(), parentAttempt: 1 }] }
        : await kit.execute(body as WorkflowRunStorageTestkitOperation) };
    }
    if (!url.endsWith('/v3/automations/runs/claim')) return await writeSessionReadiness(url, body);
    if (claimed) return { data: { run: null, automation: null, accountCurrentness: null } };
    claimed = true;
    return { data: AutomationV3WorkerClaimResponseSchema.parse({ run: { id: runId, automationId: null, attempt: 1, leaseExpiresAt: Date.now() + 120_000, revision: 0,
      recipeKind: 'workflow-v2', triggerRetired: false,
      origin: { kind: 'direct' }, triggerId: null,
      workflowAcceptedSnapshotEnvelope: acceptedEnvelope }, automation: null, accountCurrentness: currentness }) };
  });
  const recoveryController = new AbortController();
  const recover = createProductionDaemonWorkflowRuntime({ credentials: { token: 'token', encryption: null },
    accountId, serverId: 'server-1' }).createRecoveryForMachine({ machineId,
      machineAdmissionTransport: async () => { throw new Error('No new input'); },
      machineActionDirectTargetTransport: { machineId, invoke } });
  const worker = startAutomationWorker({ token: 'token', credentials: { token: 'token', encryption: null }, machineId,
    coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory, sessionStartup }),
    recoverWorkflowRuns: async () => await recover('control', recoveryController.signal) });
  try {
    const stalePass = outcome === 'success-during-recovery' ? recover('startup', recoveryController.signal) : undefined;
    if (stalePass) await recoveryReading;
    await worker.refreshAssignments();
    worker.handleServerUpdate({ id: 'queued', seq: 1, createdAt: 1, body: {
      t: 'automation-run-updated', runId, automationId: null, state: 'queued', scheduledAt: 1,
      startedAt: null, finishedAt: null, updatedAt: 1, machineId: null, targetMachineId: machineId,
    } });
    await launching;
    kit.requestControl('cancel_requested');
    worker.handleServerUpdate({ id: 'cancel', seq: 2, createdAt: 2, body: {
      t: 'automation-run-updated', runId, automationId: null, state: 'running', scheduledAt: 1,
      startedAt: 1, finishedAt: null, updatedAt: 2, machineId, targetMachineId: machineId,
      attempt: 1, workflowControl: 'cancel_requested',
    } });
    await expect.poll(async () => (await worker.liveWorkProducer.read()).items.length).toBe(0);
    releaseRecoveryRead();
    await stalePass;
    expect(operations.store.list(scope).items[0]).toMatchObject({ state: 'running', cancellation: 'unsupported' });
    expect(rowFor(kit, 'launch')).toMatchObject({ lifecycle: 'cancel_requested' });
    expect(kit.run().workflowCustodyState).toBe('pending');
    expect(sessionInput.enqueue).not.toHaveBeenCalled();
    expect(rowFor(kit, 'must-not-admit')).toBeUndefined();
    expect(launches).toBe(1);
    await expect.poll(() => startupWaitAttached).toBe(true);
    release();
    await operations.handlers.getV2({ operationId: 'late-start', waitForTerminal: true });
    if (outcome === 'foreign-session') {
      await recover('control', recoveryController.signal);
      expect(kit.run().workflowCustodyState).toBe('pending');
      expect(rowFor(kit, 'launch')?.lifecycle).toBe('cancel_requested');
      expect(stops).toEqual([]);
      expect(freshSessionRecords.get('late-child')?.active).toBe(true);
    } else {
      // No second control hint or explicit recovery call after the active claim releases.
      await expect.poll(() => kit.run().workflowCustodyState).toBe('settled');
      expect(kit.run().state).toBe('cancelled');
      expect(rowFor(kit, 'launch')?.lifecycle).toBe(outcome === 'failure' ? 'failed' : 'cancelled');
      expect([...new Set(stops)]).toEqual(outcome === 'failure' ? [] : ['late-child']);
      if (outcome !== 'failure') expect(openRowProgress(kit, rowFor(kit, 'launch')!)).toMatchObject({
        execution: { kind: 'session_ready', sessionId: 'late-child' }, reason: { code: 'workflow_startup_session_stopped' },
      });
    }
    expect(sessionInput.enqueue).not.toHaveBeenCalled();
    expect(rowFor(kit, 'must-not-admit')).toBeUndefined();
    expect(launches).toBe(1);
  } finally {
    worker.stop();
    recoveryController.abort();
    releaseRecoveryRead();
    release();
    await operations.handlers.getV2({ operationId: 'late-start', waitForTerminal: true });
  }
});

it.each(['fresh', 'retained', 'rejoined', 'lost-claim', 'lost-claim-root', 'terminal-write-lost', 'terminal-expired', 'parent-write-lost', 'miswired'] as const)('settles a proven cold startup failure through its original operation (%s)', async mode => {
  const directory = await projectDirectory();
  const runId = '41414141-4141-4141-8141-414141414143';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget, connectedServices: null },
    blocks: [step('launch'), step('must-not-admit')] };
  const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
  const scope = { accountId, machineId };
  const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => accountId,
    generateOperationId: () => 'failed-start' });
  const refusalMessage = 'Request failed with status code 409';
  const refuse = () => { throw Object.assign(new Error(refusalMessage), {
    code: 'ERR_BAD_REQUEST', response: { status: 409, data: { error: 'currentness_conflict' } },
  }); };
  const creationKey = `workflow:${runId}:`;
  let rejoined = false;
  let expired = false;
  let launches = 0;
  // Native launch is the substituted boundary; the operation producer, strict
  // operation reader, Session adapter and parent coordinator remain real.
  const handler = createMachineSessionSpawnRpcHandler({ handlers: {
    stopSession: async () => { throw new Error('Failed pre-launch startup has no runner to retire'); },
    spawnSession: async () => {
    launches++;
    return refuse();
  } }, awaitAgentSessionOpen: async () => { throw new Error('No child was created'); } });
  const sessionStartup: WorkflowSessionStartup = async input => {
    if (mode === 'retained' && !rejoined) {
      rejoined = true;
      await operations.observeExecution({ actionId: 'session.spawn_new', actionRequestId: input.creationKey,
        input: {}, execute: async () => refuse() }).catch(() => undefined);
    }
    return runObservedWorkflowSessionStartup({ ...input,
    ...(mode === 'retained' ? { retainedOperation: { key: 'startup', serverId: 'server-1', machineId, operationId: 'failed-start' } } : {}),
  }, {
    serverId: 'server-1', machineId, observeExecution: async request => {
      expect(request.actionRequestId?.startsWith(creationKey)).toBe(true);
      if (mode === 'rejoined' && !rejoined) {
        rejoined = true;
        await operations.observeExecution({ ...request, execute: async () => refuse() }).catch(() => undefined);
      }
      return operations.observeExecution(request);
    }, rpcContext: {},
    transport: operation => ({ spawn: (request, options) => handler(request, { ...options, localActionContext: operation }),
      resolveSpawnSessionByNonce: async () => { throw new Error('must_not_replace_startup'); } }),
    observeOperation: async (target, options) => expired ? { kind: 'not_found' } : operations.handlers.getV2({
      operationId: mode === 'miswired' ? 'foreign-operation' : target.operationId,
      ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
    }, options.signal ? { signal: options.signal } : undefined),
    cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
    });
  };
  const sessionInput = sessionInputBoundary();
  const interrupted = new AbortController();
  let rejectCorrespondence = mode === 'lost-claim' || mode === 'lost-claim-root';
  let rejectTerminalWrite = mode === 'terminal-write-lost' || mode === 'terminal-expired';
  let rejectParentSettlement = mode === 'parent-write-lost';
  const coordinate = workflowDaemonProcess({ storage: { ...kit, execute: async (operation, options) => {
    if (rejectParentSettlement && operation.operation === 'transition' && operation.state === 'failed') {
      rejectParentSettlement = false;
      throw Object.assign(new Error('storage_unavailable'), { code: 'storage_unavailable' });
    }
    if (rejectTerminalWrite && operation.operation === 'invocations.fact' && operation.lifecycle === 'failed'
      && operation.invocationId === rowFor(kit, 'launch')?.id) {
      rejectTerminalWrite = false;
      throw Object.assign(new Error('storage_unavailable'), { code: 'storage_unavailable' });
    }
    if (rejectCorrespondence && operation.operation === 'invocations.fact' && operation.lifecycle === 'running'
      && (mode === 'lost-claim'
        ? operation.invocationId === rowFor(kit, 'launch')?.id
        : operation.invocationId !== rowFor(kit, 'launch')?.id && rowFor(kit, 'launch')?.lifecycle === 'running')) {
      rejectCorrespondence = false;
      interrupted.abort(new WorkflowRuntimeInterruption());
      return refuse();
    }
    return kit.execute(operation, options);
  } }, sessionInput, directory, sessionStartup });
  if (mode === 'parent-write-lost') {
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness,
      acceptedEnvelope })).rejects.toThrow('storage_unavailable');
    expect(rowFor(kit, 'launch')?.lifecycle).toBe('failed');
    expect(kit.run().workflowCustodyState).toBe('pending');
  }
  if (mode === 'terminal-write-lost' || mode === 'terminal-expired') {
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness,
      acceptedEnvelope })).rejects.toThrow('storage_unavailable');
    expect(rowFor(kit, 'launch')?.lifecycle).toBe('running');
    expired = mode === 'terminal-expired';
  }
  if (mode === 'lost-claim' || mode === 'lost-claim-root') {
    await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness,
      acceptedEnvelope, signal: interrupted.signal })).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
    expect(rowFor(kit, 'launch')?.lifecycle).toBe(mode === 'lost-claim' ? 'pending' : 'running');
    const execution = openRowProgress(kit, rowFor(kit, 'launch')!).execution;
    if (mode === 'lost-claim') expect(execution).toBeUndefined();
    else expect(execution).toMatchObject({ kind: 'action', actionId: 'session.spawn_new', output: { operation: { state: 'running' } } });
    expect(await operations.handlers.getV2({ operationId: 'failed-start' })).toMatchObject({ kind: 'found', operation: {
      state: 'failed', error: { errorCode: 'ERR_BAD_REQUEST', error: refusalMessage },
    } });
  }
  const coordinating = coordinate({
    runId, attempt: 0, expectedRevision: kit.run().revision, accountCurrentness: currentness, acceptedEnvelope });
  if (mode === 'miswired') await expect(coordinating).rejects.toThrow('workflow_invocation_fact_conflict');
  else {
    await expect(coordinating).resolves.toMatchObject({ state: 'failed', reason: 'ERR_BAD_REQUEST' });
    expect(kit.run()).toMatchObject({ state: 'failed', workflowCustodyState: 'settled' });
    const leaf = rowFor(kit, 'launch')!;
    expect(leaf.lifecycle).toBe('failed');
    expect(openRowProgress(kit, leaf)).toMatchObject({ reason: { code: 'ERR_BAD_REQUEST', message: refusalMessage }, execution: {
      kind: 'action', actionId: 'session.spawn_new', awaitedOperations: [{ operationId: 'failed-start', machineId }],
      output: { operation: { state: 'failed', error: { errorCode: 'ERR_BAD_REQUEST' } } },
    } });
  }
  expect(sessionInput.enqueue).not.toHaveBeenCalled();
  expect(rowFor(kit, 'must-not-admit')).toBeUndefined();
  expect(launches).toBe(mode === 'fresh' || mode === 'terminal-write-lost' || mode === 'terminal-expired' || mode === 'parent-write-lost' ? 1 : 0);
});

it('retains the original cold Session setup operation in durable Workflow progress until native open', async () => {
  const directory = await projectDirectory();
  const runId = '41414141-4141-4141-8141-414141414142';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget, connectedServices: null },
    blocks: [step('launch')] };
  const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
  const scope = { accountId, machineId };
  const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => accountId,
    generateOperationId: () => 'original-start', supportsCoreCancellation: () => true });
  const tracked: TrackedSession = { pid: 101, startedBy: 'daemon', happySessionId: 'setup-child',
    agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json' };
  let launches = 0;
  // The native process is the sole substituted boundary. Startup ownership,
  // Project review, native-open observation and durable Workflow storage are real.
  const handler = createMachineSessionSpawnRpcHandler({ handlers: { spawnSession: async options => {
    launches++;
    if (options.sessionCreationTag) freshSessionCreationTags.set(options.sessionCreationTag, 'setup-child');
    freshSessionRecords.set('setup-child', createSessionRecordFixture({ id: 'setup-child', encryptionMode: 'plain',
      metadata: JSON.stringify(buildCommittedLaunchMetadata({ options, directory, accountSettings: {} })) }));
    const operation = options.projectSetupOperation;
    if (!operation?.operationReview) throw new Error('missing_original_startup_operation');
    operation.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'setup',
      serverId: 'server-1', machineId, workspaceRefId: 'workspace', cwd: directory } });
    const review = { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
      reviewedEffectDigest: 'setup', reviewedEffect: { commands: [] } };
    void operation.operationReview.waitForResume(review, {
      review: async decision => decision?.reviewedEffectDigest === 'setup' ? null : review,
    }).then(() => { tracked.agentRuntimeDaemonServiceSessionOpenAttestation = {
      request: { kind: 'create', sessionId: 'setup-child', cwd: directory }, providerSessionId: 'native',
    }; }, () => undefined);
    authorizedConversations.set('setup-child', directory);
    return { type: 'success', sessionId: 'setup-child', sessionCreationOutcome: {
      disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
    } };
  }, stopSession: async () => { throw new Error('Setup success must not retire its runner'); }
  }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }) });
  let notifyHeld!: () => void;
  const heldReady = new Promise<void>(resolve => { notifyHeld = resolve; });
  const sessionStartup: WorkflowSessionStartup = input => runObservedWorkflowSessionStartup({ ...input,
    onObservation: async operation => {
      await input.onObservation?.(operation);
      if (operation.setupReview) notifyHeld();
    },
  }, {
    serverId: 'server-1', machineId, observeExecution: operations.observeExecution, rpcContext: {},
    transport: operation => ({ spawn: (request, options) => handler(request, { ...options, localActionContext: operation }),
      resolveSpawnSessionByNonce: async () => { throw new Error('must_not_replace_startup'); } }),
    observeOperation: async (target, options) => operations.handlers.getV2({ operationId: target.operationId,
      ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
      ...(options.includeSetupReview ? { includeSetupReview: true } : {}) }, options.signal ? { signal: options.signal } : undefined),
    cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
  });
  const sessionInput = sessionInputBoundary({}, { sessionId: 'setup-child' });
  const controller = new AbortController();
  const coordination = workflowDaemonProcess({ storage: kit, sessionInput, directory, sessionStartup })({
    runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness, acceptedEnvelope, signal: controller.signal });
  const settled = coordination.catch(error => error);
  try {
    await Promise.race([heldReady, coordination.then(result => {
      throw new Error(`Workflow settled before setup hold: ${JSON.stringify(result)}`);
    })]);
    const held = rowFor(kit, 'launch')!;
    expect(held.lifecycle).toBe('needs_attention');
    const progress = openRowProgress(kit, held);
    expect(progress).toMatchObject({ reason: { code: 'project_setup_consent_required' }, execution: {
      kind: 'action', actionId: 'session.spawn_new', awaitedOperations: [{ operationId: 'original-start', machineId }],
    } });
    expect(sessionInput.enqueue).not.toHaveBeenCalled();
    expect(operations.store.list(scope).items).toHaveLength(1);
    await operations.runner.decideSetupReview(scope, 'original-start', { serverId: 'server-1', machineId,
      workspaceId: 'workspace', rootPath: directory }, 'setup', { reviewedEffectDigest: 'setup', skipForInvocation: false });
    await expect(coordination).resolves.toMatchObject({ state: 'succeeded' });
    expect(rowFor(kit, 'launch')).toMatchObject({ id: held.id, lifecycle: 'completed' });
    expect(sessionInput.enqueue).toHaveBeenCalledTimes(1);
    expect(launches).toBe(1);
  } finally { controller.abort(new WorkflowRuntimeInterruption()); operations.runner.cancel(scope, 'original-start'); await settled; }
});

it.each(['unavailable', 'missing-inventory', 'valid'] as const)(
  'settles cold Workflow startup from native mode admission (%s)', async mode => {
  const [{ createNativeAgentRuntimeSessionPlanFixture, createExternalContributionFixtures, createLease,
    createSessionHostServiceOwners, createNativeSessionClientTestPort }, { buildPluginSessionBindingInput },
    { PluginError }, { createAgentSessionRunnerFactoryBinding }, { AgentRuntimeDaemonServiceRequestV1Schema },
    { recordTrackedRunnerAgentSessionOpenAttestation }] = await Promise.all([
    import('@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit'),
    import('@/plugins/runtime/runtimeCore/plugin/sessionLaunch'), import('@happier-dev/plugin-sdk'),
    import('@/plugins/runtime/runner/agentSessionRunnerFactoryBinding'),
    import('@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol'),
    import('@/daemon/agentRuntime/runnerAgentSessionOpenAttestation'),
  ]);
  const directory = await projectDirectory();
  const runId = '41414141-4141-4141-8141-414141414143';
  const credentials = { token: 'token', encryption: null };
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget, connectedServices: null },
    blocks: mode === 'valid' ? [step('launch')] : [step('launch'), step('must-not-admit')] };
  const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
  const scope = { accountId, machineId };
  const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => accountId,
    generateOperationId: () => 'native-mode-start', supportsCoreCancellation: () => true });
  const runner = { pid: 101, processStartTimeMs: 1000, processCommandHash: 'a'.repeat(64) };
  const binding = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.agent-plugin', pluginVersion: '1.0.0',
    agentId: 'acme-mode', localAgentId: 'acme-mode', sourceCustody: {
      kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
    locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
    normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js' });
  const tracked: TrackedSession = { ...runner, startedBy: 'daemon', happySessionId: 'native-mode-child',
    runnerAgentSourceCustodyV1: binding.sourceCustody,
    agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json' };
  const attestationPhases: string[] = [];
  const retiredSessions: string[] = [];
  const send = vi.fn(async () => ({ status: 'admitted' as const }));
  let finishOpen!: () => void;
  const nativeFinished = new Promise<void>(resolve => { finishOpen = resolve; });
  let openError: unknown;
  let openedRuntime: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof createNativeAgentRuntimeSessionPlanFixture>>['config']['createSessionRuntime']>>> | undefined;
  const native = await createNativeAgentRuntimeSessionPlanFixture({ ...createExternalContributionFixtures('acme-mode'),
    lease: { ...createLease('acme-mode'), sourceCustody: binding.sourceCustody }, createSessionHostServiceOwners,
    sessionInput: buildPluginSessionBindingInput({ credentials, directory,
      backendTarget: { kind: 'backend', backendId: 'acme-mode' }, sessionModeId: mode === 'valid' ? 'build' : 'default' }),
    attestSessionOpen: async input => {
      // Exact private transport parser and daemon recorder; only the marker-file write is an OS boundary.
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: 'a'.repeat(43), sessionId: tracked.happySessionId },
        operation: { kind: 'session.open.attest', requestId: 'native-mode-open', phase: input.phase,
          request: input.request, providerSessionId: input.providerSessionId } });
      if (request.operation.kind !== 'session.open.attest') throw new Error('wrong_attestation_operation');
      attestationPhases.push(request.operation.phase);
      const recorded = await recordTrackedRunnerAgentSessionOpenAttestation({ tracked, retainedAgent: binding,
        runner: { ...runner, snapshotIdentity: 'fixture-runner' },
        ...request.operation, updateMarker: async () => true });
      if (!recorded) throw new Error('native_mode_attestation_refused');
    },
    runtime: { sessions: { open: async (_request, context) => {
      if (mode !== 'missing-inventory') context.session.services.modes.bind({
        read: () => ({ modes: [{ id: 'build', name: 'Build' }], currentModeId: 'build' }),
        subscribe: () => ({ dispose() {} }) });
      if (mode !== 'valid') throw new PluginError({ code: 'native_agent_session_mode_unavailable', retryable: false });
      return { send, watch: () => ({ dispose() {} }), dispose() {} };
    } } },
  });
  let launches = 0;
  const handler = createMachineSessionSpawnRpcHandler({ handlers: { spawnSession: async options => {
    launches++;
    if (options.sessionCreationTag) freshSessionCreationTags.set(options.sessionCreationTag, 'native-mode-child');
    freshSessionRecords.set('native-mode-child', createSessionRecordFixture({ id: 'native-mode-child', encryptionMode: 'plain',
      metadata: JSON.stringify(buildCommittedLaunchMetadata({ options, directory, accountSettings: {} })) }));
    authorizedConversations.set('native-mode-child', directory);
    // Physical launch/webhook and Stop are OS boundaries. Native admission,
    // attestation and the original startup operation remain composed.
    // This port substitutes the runner's process/Session transport, as in the native owner fixture.
    void native.config.createSessionRuntime({ directory, metadata: {}, machineId,
      session: createNativeSessionClientTestPort('native-mode-child'), transcriptSession: {}, messageBuffer: {}, mcpServers: {},
      permissionHandler: {}, getPermissionMode: () => 'default', setThinking() {}, memoryRecallGuidanceEnabled: false,
    } as never).then(value => { openedRuntime = value; finishOpen(); }, error => { openError = error; finishOpen(); });
    return { type: 'success', sessionId: 'native-mode-child', sessionCreationOutcome: {
      disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
  }, stopSession: async sessionId => {
    retiredSessions.push(sessionId);
    tracked.childProcess = Object.assign(new (await import('node:child_process')).ChildProcess(), { exitCode: 0 });
    return { status: 'stopped' };
  } }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }) });
  const sessionStartup: WorkflowSessionStartup = input => runObservedWorkflowSessionStartup(input, {
    serverId: 'server-1', machineId, observeExecution: operations.observeExecution, rpcContext: {},
    transport: operation => ({ spawn: (request, options) => handler(request, { ...options, localActionContext: operation }),
      resolveSpawnSessionByNonce: async () => { throw new Error('must_not_replace_refused_startup'); } }),
    observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
      ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
      ...(options.includeSetupReview ? { includeSetupReview: true } : {}) }, options.signal ? { signal: options.signal } : undefined),
    cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
  });
  const sessionInput = sessionInputBoundary({}, { sessionId: 'native-mode-child' });
  const controller = new AbortController();
  const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory, sessionStartup });
  const coordinating = coordinate({ runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness,
    acceptedEnvelope, signal: controller.signal });
  const settled = coordinating.catch(error => error);
  try {
    await Promise.race([nativeFinished, coordinating.then(value => {
      throw new Error(`Workflow settled before native open finished: ${JSON.stringify(value)}`);
    })]);
    if (mode === 'missing-inventory') {
      expect(openError).toMatchObject({ code: 'native_agent_session_mode_unavailable' });
      expect(attestationPhases).toEqual(['prepare']);
      expect(operations.store.get(scope, 'native-mode-start')).toMatchObject({ state: 'running' });
      expect(sessionInput.enqueue).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(operations.store.get(scope, 'native-mode-start')?.state)
        .toBe(mode === 'valid' ? 'succeeded' : 'failed'));
      if (mode === 'valid') await expect(coordinating).resolves.toMatchObject({ state: 'succeeded' });
      else {
        await expect(coordinating).resolves.toMatchObject({ state: 'failed', reason: 'native_agent_session_mode_unavailable' });
        expect(kit.run()).toMatchObject({ state: 'failed', workflowCustodyState: 'settled' });
        expect(rowFor(kit, 'launch')).toMatchObject({ lifecycle: 'failed' });
        expect(rowFor(kit, 'must-not-admit')).toBeUndefined();
        expect(sessionInput.enqueue).not.toHaveBeenCalled();
        expect(attestationPhases).toEqual(['prepare', 'refused']);
        expect(retiredSessions).toEqual(['native-mode-child']);
        expect(openRowProgress(kit, rowFor(kit, 'launch')!)).toMatchObject({ execution: {
          kind: 'action', actionId: 'session.spawn_new', output: { operation: { state: 'failed' } } } });
        await expect(coordinate({ runId, attempt: 0, expectedRevision: kit.run().revision,
          accountCurrentness: currentness, acceptedEnvelope })).resolves.toMatchObject({ state: 'failed' });
      }
    }
    expect(launches).toBe(1);
    expect(retiredSessions).toEqual(mode === 'unavailable' ? ['native-mode-child'] : []);
    expect(tracked.childProcess?.exitCode).toBe(mode === 'unavailable' ? 0 : undefined);
    expect(send).not.toHaveBeenCalled();
  } finally {
    controller.abort(new WorkflowRuntimeInterruption());
    operations.runner.cancel(scope, 'native-mode-start');
    await settled;
    await openedRuntime?.operations.resetOrDisposeRuntime();
  }
});

it('retires the old Judge observation writer while reclaim preserves the late resume witness and continuation', async () => {
  const directory = await projectDirectory();
  const runId = '41414141-4141-4141-8141-414141414161';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: retainedConversationDefaults(),
    blocks: [step('stage-one'), step('judge', { execution: { executionTarget: { kind: 'detached_run' },
      conversation: { kind: 'fresh' } } }), step('judge-next', { execution: {
        executionTarget: { kind: 'detached_run' }, conversation: { kind: 'from_step', producer: { blockId: 'judge', scope: { kind: 'current' } } },
      } })] };
  const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed',
    origin: { kind: 'direct' }, acceptedEnvelope });
  const interrupted = new AbortController();
  let currentAttempt = 1;
  const conflict = () => Object.assign(new Error('currentness_conflict'), {
    response: { status: 409, data: { error: 'currentness_conflict' } },
  });
  // The HTTP/database boundary enforces the server's exact claimed-attempt
  // predicate, which the in-memory boundary does not model itself.
  const storage = { execute: async (operation: WorkflowRunStorageTestkitOperation) => {
    if ('parentAttempt' in operation && operation.parentAttempt !== currentAttempt) throw conflict();
    return kit.execute(operation);
  } };
  let sink: ExecutionRunWorkflowObservationSink | null = null;
  let localInputId = '';
  let starts = 0;
  const providerResumeIdentity = { kind: 'provider_session.v1' as const,
    backendTarget: { kind: 'backend' as const, backendId: 'claude', sourceKind: 'built_in' as const },
    providerSessionId: 'late-native-provider-session' };
  let continuedInputId = '';
  let observing!: () => void;
  const entered = new Promise<void>(resolve => { observing = resolve; });
  const sessionInput = sessionInputBoundary();
  const detachedRun: NonNullable<Parameters<typeof workflowDaemonProcess>[0]['detachedRun']> = {
    buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }),
    actionExecutor: { execute: async (actionId, value, context) => {
      if (actionId === 'execution.run.start') {
        starts++;
        if (starts === 2) {
          expect(value).toMatchObject({ resumeHandle: providerResumeIdentity });
          expect(openRowProgress(kit, rowFor(kit, 'judge')!).execution)
            .toMatchObject({ providerResumeIdentity });
          continuedInputId = String((value as { localInputId: string }).localInputId);
          return { ok: true, result: { runId: 'judge-resumed', callId: 'next-call', sidechainId: 'next-side' } };
        }
        expect(rowFor(kit, 'stage-one')?.lifecycle).toBe('completed');
        localInputId = String((value as { localInputId: string }).localInputId);
        sink = readExecutionRunWorkflowObservationSink(context?.executionRunWorkflowObservationSink);
        if (!sink) throw new Error('Missing Judge observation writer');
        await sink.commit({ kind: 'input_accepted', runId: 'judge-native', localInputId, acceptedAtMs: 1 });
        return { ok: true, result: { runId: 'judge-native', callId: 'judge-call', sidechainId: 'judge-side' } };
      }
      if (actionId === 'execution.run.send') {
        expect(value).toMatchObject({ runId: 'judge-native', resume: true });
        return { ok: false, errorCode: 'execution_run_not_found', error: 'Host run is absent' };
      }
      if (actionId !== 'execution.run.get') throw new Error(`Unexpected Judge Action ${actionId}`);
      if (currentAttempt === 1) {
        observing();
        return await new Promise<never>((_resolve, reject) => {
          context?.signal?.addEventListener('abort', () => reject(new WorkflowRuntimeInterruption()), { once: true });
        });
      }
      // Native events outlive the first Workflow claim. A retired observer
      // must not turn a truthful storage refusal into a failed native input.
      await sink!.commit({ kind: 'usage', runId: 'judge-native', localInputId, usage: { outputTokens: 2 } });
      await sink!.commit({ kind: 'provider_resume_identity', runId: 'judge-native', localInputId,
        providerResumeIdentity });
      const resumed = (value as { runId: string }).runId === 'judge-resumed';
      return { ok: true, result: { run: {
        runId: resumed ? 'judge-resumed' : 'judge-native', callId: 'judge-call', sidechainId: 'judge-side', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', status: 'running', startedAtMs: 1,
        resumeHandle: providerResumeIdentity,
        inputTurns: { occurrenceId: 'judge-occurrence', last: { turnId: 'judge-turn', inputIds: [resumed ? continuedInputId : localInputId],
          state: 'completed', result: { kind: 'text', value: 'done' } } },
      } } };
    } },
  };
  const coordinate = workflowDaemonProcess({ directory, storage, sessionInput, detachedRun });
  const claim = { runId, attempt: 1, expectedRevision: 0, accountCurrentness: currentness, acceptedEnvelope };
  const first = coordinate({ ...claim, signal: interrupted.signal });
  void first.catch(() => undefined);
  try {
    await Promise.race([entered, first.then(() => { throw new Error('Judge did not enter native observation'); })]);
    const judge = rowFor(kit, 'judge')!;
    currentAttempt = 2;
    // A live writer's refusal remains visible; no retry or conflict swallowing.
    await expect(sink!.commit({ kind: 'usage', runId: 'judge-native', localInputId, usage: { outputTokens: 2 } }))
      .rejects.toMatchObject({ response: { status: 409, data: { error: 'currentness_conflict' } } });
    interrupted.abort(new WorkflowRuntimeInterruption());
    await expect(first).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
    await expect(sink!.commit({ kind: 'input_accepted', runId: 'judge-native', localInputId: 'foreign', acceptedAtMs: 1 }))
      .rejects.toThrow('workflow_invocation_fact_conflict');
    await expect(workflowDaemonProcess({ directory, storage, sessionInput, detachedRun })({ ...claim,
      attempt: 2, expectedRevision: kit.run().revision })).resolves.toMatchObject({ state: 'succeeded' });
    expect(rowFor(kit, 'judge')).toMatchObject({ id: judge.id, lifecycle: 'completed' });
    expect(openRowProgress(kit, rowFor(kit, 'judge')!).result).toBe('done');
    expect(openRowProgress(kit, rowFor(kit, 'judge')!).execution).toMatchObject({ providerResumeIdentity });
    expect(rowFor(kit, 'judge-next')?.lifecycle).toBe('completed');
    expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
    expect(starts).toBe(2);
    expect(sessionInput.enqueue.mock.calls.map(([request]) => leafLabel(request.text))).toEqual(['stage-one']);
  } finally {
    interrupted.abort(new WorkflowRuntimeInterruption());
    await first.catch(() => undefined);
  }
});

it.each(['before-native-admission', 'active'] as const)('persists a delayed native permission through the reclaimed exact Workflow input (%s)', async phase => {
  const directory = await projectDirectory();
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  reloadConfiguration();
  const runId = '41414141-4141-4141-8141-414141414163';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
    ...retainedConversationDefaults(), permissionMode: 'default',
    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.permission-reclaim', localId: 'default' } } },
    blocks: [step('judge', { execution: { executionTarget: { kind: 'detached_run' }, conversation: { kind: 'fresh' } } })] };
  const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed', origin: { kind: 'direct' }, acceptedEnvelope });
  let currentAttempt = 1;
  let permissionPersisted!: (requestId: string) => void;
  const persistedPermission = new Promise<string>(resolve => { permissionPersisted = resolve; });
  const refusedWrites: Array<Readonly<{ operation: string; parentAttempt: number; currentAttempt: number }>> = [];
  const storage = { execute: async (operation: WorkflowRunStorageTestkitOperation) => {
    if ('parentAttempt' in operation && operation.parentAttempt !== currentAttempt) {
      refusedWrites.push({ operation: String(operation.operation), parentAttempt: Number(operation.parentAttempt), currentAttempt });
      throw Object.assign(new Error('currentness_conflict'), { response: { status: 409, data: { error: 'currentness_conflict' } } });
    }
    const result = await kit.execute(operation);
    const judge = rowFor(kit, 'judge');
    const interaction = judge ? openRowProgress(kit, judge).interaction : undefined;
    if (currentAttempt === 2 && isWorkflowJsonObject(interaction) && isWorkflowJsonObject(interaction.requests)) {
      const requestId = Object.keys(interaction.requests)[0];
      if (requestId) permissionPersisted(requestId);
    }
    return result;
  } };
  let releaseProvision!: () => void;
  const provision = new Promise<void>(resolve => { releaseProvision = resolve; });
  let nativeContext: import('@happier-dev/plugin-sdk/agents/runtime').AgentExecutionRunRuntimeContextV1 | undefined;
  let nativeReady!: () => void;
  const nativeOpened = new Promise<void>(resolve => { nativeReady = resolve; });
  let finishNative!: () => void;
  let nativeOpens = 0;
  const executionRunContextV1 = { async open(request: { runId: string }, context: NonNullable<typeof nativeContext>) {
    nativeOpens++;
    await provision;
    nativeContext = context;
    const events: import('@happier-dev/plugin-sdk/agents/runtime').AgentExecutionRunEvent[] = [];
    let listener: ((event: typeof events[number]) => void) | undefined;
    let sequence = 0;
    const emit = (event: typeof events[number]) => { events.push(event); listener?.(event); };
    emit({ kind: 'run-start', runId: request.runId, sequence: ++sequence, emittedAtMs: sequence });
    finishNative = () => {
      emit({ kind: 'output-delta', runId: request.runId, sequence: ++sequence, emittedAtMs: sequence, channel: 'assistant', text: 'done' });
      emit({ kind: 'run-complete', runId: request.runId, sequence: ++sequence, emittedAtMs: sequence });
    };
    return { async send() { return { status: 'admitted' as const }; }, async stop() {
      emit({ kind: 'run-cancelled', runId: request.runId, sequence: ++sequence, emittedAtMs: sequence });
      return { status: 'requested' as const }; },
      watch(next: NonNullable<typeof listener>) { listener = next; for (const event of events) next(event);
        nativeReady();
        return { dispose() { listener = undefined; } }; }, async dispose() {} };
  } };
  const agentRuntime: import('@happier-dev/plugin-sdk/agents/runtime').AgentRuntime = {
    sessions: { async open() { throw new Error('Unexpected Session open'); }, executionRunContextV1 },
  };
  const plugin = definePlugin({ id: 'acme.permission-reclaim', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, agents: {
    default: { declaration: { title: 'Permission reclaim fixture', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true, workspaceWrites: 'deny', executionRunContext: { versions: [1] } } } },
      factory: async () => agentRuntime,
      sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 } },
  } });
  const { readCurrentContributionRegistry } = await import('@/agent/catalog/snapshot');
  const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
  const baselineContributes = readCurrentContributionRegistry();
  const admitted = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: directory, controller: pluginReloadController,
    plugins: [{ manifest: plugin.manifest,
    files: { 'agent.mjs': 'let create; export function configure(callback) { create = callback; } export function createRuntime() { return create(); }',
      'daemon.mjs': `import * as leaf from './agent.mjs';
        export function configure(callback) { leaf.configure(callback); return { activate }; }
        export function activate(api) { api.agents.register('default', leaf.createRuntime, {
          sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 } }); }` },
    // Physical registration and native factory stay real; only the external
    // public SDK Agent implementation and its loading lifetime are supplied.
    instantiateCommittedModule(module) {
      if (typeof module.configure !== 'function') throw new Error('Missing SDK fixture callback');
      const configured: unknown = module.configure(() => agentRuntime);
      if (!configured || typeof configured !== 'object' || !('activate' in configured) || typeof configured.activate !== 'function') {
        throw new Error('Missing SDK fixture activation');
      }
      return configured as import('@/plugins/runtime/types').PluginDaemonModuleNamespace;
    },
  }] });
  onTestFinished(async () => {
    await admitted.dispose();
    await pluginReloadController.adoptPreparedRuntimeRegistry({
      registry: await resolveExecutablePluginRuntimeRegistry({ contributes: baselineContributes, pluginIds: [] }),
      changedPluginIds: ['acme.permission-reclaim'], runningSessionDisposition: 'retainRunningSessions',
    });
  });
  expect(admitted.registry.pluginDiagnosticsByPluginId['acme.permission-reclaim'] ?? []).toEqual([]);
  const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: admitted.registry });
  const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog();
  const manager = new ExecutionRunHostBridge({ parentProvider: 'claude', cwd: directory, sendAcp: async () => {},
    machineId, happyHomeDir: directory, resolveExecutionRunProfileCatalog: () => ({ engineRegistry, profileCatalog }) });
  let firstWaiting!: () => void;
  let reclaimedWaiting!: () => void;
  const firstObservation = new Promise<void>(resolve => { firstWaiting = resolve; });
  const reclaimedObservation = new Promise<void>(resolve => { reclaimedWaiting = resolve; });
  const waitForInputTurn = manager.waitForInputTurn.bind(manager);
  let waitCount = 0;
  vi.spyOn(manager, 'waitForInputTurn').mockImplementation((...args) => {
    const waiting = waitForInputTurn(...args);
    if (++waitCount === 1) firstWaiting();
    else reclaimedWaiting();
    return waiting;
  });
  const executor = createExecutionRunRpcActionExecutor({ manager, context: { sessionId: null, cwd: directory },
    policy: resolveExecutionRunPolicy({ defaults: { maxConcurrentRuns: null, boundedTimeoutMs: null,
      reviewBoundedTimeoutMs: null, maxTurns: null } }), isExecutionRunsEnabled: () => true });
  let latestContext: Parameters<typeof executor.execute>[2];
  const detachedRun: NonNullable<Parameters<typeof workflowDaemonProcess>[0]['detachedRun']> = {
    buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }),
    actionExecutor: { execute: (actionId, input, context) => {
      latestContext = context;
      return executor.execute(actionId, input, context);
    } },
  };
  const interrupted = new AbortController();
  const claim = { runId, attempt: 1, expectedRevision: 0, accountCurrentness: currentness, acceptedEnvelope };
  const first = workflowDaemonProcess({ directory, storage, detachedRun })({ ...claim, signal: interrupted.signal });
  void first.catch(() => undefined);
  let reclaimed: ReturnType<ReturnType<typeof workflowDaemonProcess>> | undefined;
  const reclaimAbort = new AbortController();
  try {
    if (phase === 'active') releaseProvision();
    await Promise.race([firstObservation, first.then(result => {
      throw new Error(`Workflow settled before exact input observation: ${JSON.stringify(result)}`);
    })]);
    const judge = rowFor(kit, 'judge')!;
    const execution = openRowProgress(kit, judge).execution;
    if (execution?.kind !== 'detached_run') throw new Error('Missing exact detached input');
    const nativeRunId = execution.runId;
    if (phase === 'active') await nativeOpened;
    currentAttempt = 2;
    interrupted.abort(new WorkflowRuntimeInterruption());
    await expect(first).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
    reclaimed = workflowDaemonProcess({ directory, storage, detachedRun })({ ...claim,
      attempt: 2, expectedRevision: kit.run().revision, signal: reclaimAbort.signal });
    void reclaimed.catch(() => undefined);
    await Promise.race([reclaimedObservation, reclaimed.then(result => {
      throw new Error(`Reclaimed Workflow settled before exact input observation: ${JSON.stringify(result)}`);
    })]);
    const context = latestContext;
    if (!context?.actionCaller || context.actionCaller.kind !== 'workflowRun') throw new Error('Missing current Workflow context');
    const { AgentStateRequestStore } = await import('@/agent/permissions/agentStateRequestStore');
    const foreignStore = new AgentStateRequestStore({ logPrefix: '[foreign invocation]', target: {
      scopeId: 'foreign-invocation', readState: () => ({}), updateState: () => { throw new Error('Foreign scope was mutated'); },
    } });
    for (const mismatch of [
      { inputId: 'foreign-input', context },
      { inputId: execution.localInputId, context: { ...context,
        actionCaller: { ...context.actionCaller, runId: 'foreign-workflow' } } },
      { inputId: execution.localInputId, context: { ...context, executionRunPermissionRequestStore: foreignStore } },
    ]) {
      await expect(executor.execute('execution.run.get', { sessionId: null, runId: nativeRunId,
        waitForInputId: mismatch.inputId }, mismatch.context)).resolves.toMatchObject({ ok: false,
        errorCode: 'execution_run_invalid_action_input' });
    }
    releaseProvision();
    await nativeOpened;
    const approval = nativeContext!.services.interactions.requestApproval({ kind: 'approval', title: 'Allow read-only inspection?',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } } });
    void approval.catch(() => undefined);
    const requestId = await Promise.race([persistedPermission, approval.then(result => {
      throw new Error(`Native interaction settled before its prompt persisted: ${JSON.stringify({ result, refusedWrites })}`);
    })]);
    expect(projectWorkflowPermissionRequests(openRowProgress(kit, rowFor(kit, 'judge')!)))
      .toMatchObject([{ requestId, tool: 'Bash' }]);
    await expect(manager.completePermissionRequest(nativeRunId, { requestId, approved: true })).resolves.toEqual({ ok: true });
    await expect(approval).resolves.toMatchObject({ kind: 'approval', status: 'approved' });
    expect(projectWorkflowPermissionRequests(openRowProgress(kit, rowFor(kit, 'judge')!))).toEqual([]);
    finishNative();
    await expect(reclaimed).resolves.toMatchObject({ state: 'succeeded' });
    expect(rowFor(kit, 'judge')).toMatchObject({ id: judge.id, lifecycle: 'completed' });
    expect(nativeOpens).toBe(1);
    expect(refusedWrites).toEqual([]);
  } finally {
    releaseProvision(); interrupted.abort(new WorkflowRuntimeInterruption()); reclaimAbort.abort(new WorkflowRuntimeInterruption());
    await manager.dispose(); await first.catch(() => undefined); await reclaimed?.catch(() => undefined);
    vi.unstubAllEnvs(); reloadConfiguration();
  }
});

it('reclaims a pending Agent leaf after its input persisted but the root projection write rolled back', async () => {
  const directory = await projectDirectory();
  const runId = '41414141-4141-4141-8141-414141414141';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: retainedConversationDefaults(),
    blocks: [step('first'), step('next')] };
  const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed',
    origin: { kind: 'direct' }, acceptedEnvelope });
  const sessionInput = sessionInputBoundary();
  let rejectedProjection = false;
  // Storage HTTP is the system boundary. Match the R41 durable state: the
  // first leaf's authored input is committed, but no workspace/input effect is.
  const storage = { execute: async (operation: WorkflowRunStorageTestkitOperation) => {
    const first = rowFor(kit, 'first');
    const root = rowFor(kit, '$root');
    if (!rejectedProjection && operation.operation === 'invocations.fact'
      && operation.invocationId === root?.id && first
      && openRowProgress(kit, first).input !== undefined) {
      rejectedProjection = true;
      throw Object.assign(new Error('database_transaction_conflict_exhausted'), {
        response: { status: 500, data: { error: 'database_transaction_conflict_exhausted' } },
      });
    }
    return await kit.execute(operation);
  } };
  const claim = { runId, attempt: 1, expectedRevision: 0, accountCurrentness: currentness, acceptedEnvelope };
  await expect(workflowDaemonProcess({ storage, sessionInput, directory })(claim))
    .rejects.toThrow('database_transaction_conflict_exhausted');
  expect(rejectedProjection).toBe(true);
  const pending = rowFor(kit, 'first')!;
  expect(pending.lifecycle).toBe('pending');
  expect(openRowProgress(kit, pending)).toMatchObject({ input: { document: { text: 'first' } } });
  expect(openRowProgress(kit, pending)).not.toHaveProperty('execution');
  expect(sessionInput.enqueue).not.toHaveBeenCalled();

  // The server's existing expired-lease claim preserves sealed rows and
  // advances the parent attempt. Rebuild all daemon owners over those bytes.
  await kit.execute({ operation: 'transition', runId, expectedRevision: kit.run().revision,
    state: 'claimed', checkpointEnvelope: kit.checkpointEnvelope()! });
  await expect(workflowDaemonProcess({ storage: kit, sessionInput, directory })({ ...claim,
    attempt: 2, expectedRevision: kit.run().revision })).resolves.toMatchObject({ state: 'succeeded' });
  expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
  expect(rowFor(kit, 'first')).toMatchObject({ id: pending.id, attempt: '0', lifecycle: 'completed' });
  expect(rowFor(kit, 'next')?.lifecycle).toBe('completed');
  expect(sessionInput.enqueue.mock.calls.map(([request]) => leafLabel(request.text))).toEqual(['first', 'next']);
});

it('preserves JSON and If progress when reclaim finds an admitting reply with no input receipt', async () => {
  const channel = await createRequesterCurrentnessSocketHarness();
  onTestFinished(() => channel.close());
  const directory = await projectDirectory();
  const runId = '59595959-5959-4595-8595-595959595960';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: retainedConversationDefaults(), blocks: [
    step('named-ready', { result: { kind: 'json', schema: { type: 'object', properties: { ready: { type: 'boolean' } },
      required: ['ready'], additionalProperties: false } } }),
    { kind: 'if', id: 'ready-branch', when: { kind: 'compare', operator: 'eq',
      left: { kind: 'result', producer: { blockId: 'named-ready', scope: { kind: 'current' } }, path: ['ready'] },
      right: { kind: 'literal', value: true } }, then: [step('if-reply')], otherwise: [step('wrong-branch')] },
    step('must-not-admit'),
  ] };
  const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
  const firstInput = sessionInputBoundary({ 'named-ready': { kind: 'final_text', text: '{"ready":true}' } });
  const interrupted = new AbortController();
  let lost = false;
  const coordinate = workflowDaemonProcess({ directory, sessionInput: firstInput, storage: {
    execute: async (operation, options) => {
      const response = await kit.execute(operation, options);
      if (!lost && operation.operation === 'invocations.fact' && operation.lifecycle === 'admitting'
        && operation.invocationId === rowFor(kit, 'if-reply')?.id) {
        lost = true;
        interrupted.abort();
        throw new WorkflowRuntimeInterruption();
      }
      return response;
    },
  } });
  await expect(coordinate({ runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness,
    acceptedEnvelope, signal: interrupted.signal })).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
  const completed = rowFor(kit, 'named-ready')!;
  const admitting = rowFor(kit, 'if-reply')!;
  expect(completed.lifecycle).toBe('completed');
  expect(openRowProgress(kit, completed).result).toEqual({ ready: true });
  expect(admitting.lifecycle).toBe('admitting');
  expect(openRowProgress(kit, admitting)).not.toHaveProperty('execution');
  expect(firstInput.enqueue.mock.calls.map(([request]) => leafLabel(request.text))).toEqual(['named-ready']);

  const reclaimed = new AbortController();
  let interruptWait: ReturnType<typeof setImmediate> | undefined;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).includes('/messages/by-local-id/')) return { status: 200, data: { message: null } };
    if (String(url).includes('/pending')) {
      // Only an incorrectly unbounded observer reaches an event wait. Retire
      // that wait without inventing a product deadline or a test sleep.
      interruptWait = setImmediate(() => reclaimed.abort());
      return { status: 200, data: { pending: [] } };
    }
    return await readSessionReadiness(String(url));
  });
  const resumed = workflowDaemonProcess({ storage: kit, directory, readActualConversation: true,
    machineAdmissionTransport: async () => { throw new Error('Reclaim must not dispatch the ambiguous input'); } });
  try {
    await expect(resumed({ runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope, signal: reclaimed.signal }))
      .resolves.toMatchObject({ state: 'interrupted', reason: 'workflow_admission_ack_uncertain' });
    expect(rowFor(kit, 'named-ready')).toMatchObject({ id: completed.id, lifecycle: 'completed', contentRevision: completed.contentRevision });
    expect(rowFor(kit, 'if-reply')).toMatchObject({ id: admitting.id, attempt: '0', lifecycle: 'needs_attention' });
    expect(openRowProgress(kit, rowFor(kit, 'if-reply')!)).toMatchObject({ reason: { code: 'workflow_admission_ack_uncertain' } });
    expect(rowFor(kit, 'wrong-branch')).toBeUndefined();
    expect(rowFor(kit, 'must-not-admit')).toBeUndefined();
  } finally { if (interruptWait) clearImmediate(interruptWait); reclaimed.abort(); }
});

describe('composed Workflow front door and claimed execution', () => {
  it.skipIf(process.platform === 'win32').each(['direct', 'nonce', 'foreign_nonce', 'hosted', 'hosted_incomplete', 'hosted_window_only', 'hosted_runner_alive', 'hosted_foreign_nonce', 'hosted_miswired', 'windows', 'windows_incomplete', 'windows_foreign_nonce', 'windows_miswired'] as const)('requires exact retired launch custody before failing an Agent leaf (%s)', async transport => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const runId = '71717171-7171-4171-8171-717171717171';
    const directory = await projectDirectory();
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    const wrappers = new Map<number, TrackedSession>();
    const awaiters = new Map<number, (session: TrackedSession) => void>();
    const resolvers = new Map<number, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<number, NodeJS.Timeout>();
    const resources = new Map<number, () => void | Promise<void>>();
    const attaches = new Map<number, () => Promise<void>>();
    const onChildExited = createOnChildExited({ pidToTrackedSession: wrappers,
      spawnResourceCleanupByPid: resources, sessionAttachCleanupByPid: attaches,
      getApiMachineForSessions: () => null, removeSessionMarkerFn: async () => {} });
    // Replace only OS launch. The real spawn, retirement, Session creator,
    // coordinator/fact writer, Stop Action and recovery reader stay composed.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: directory,
    });
    const wrapperPid = child.pid!;
    const runner = transport === 'hosted_runner_alive' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore', cwd: directory,
    }) : null;
    nativeLaunchBoundary.child = child;
    nativeLaunchBoundary.cancel = createExactWindowsProcessCancellation({ pid: wrapperPid,
      processStartTimeMs: 1, processCommandHash: hashProcessCommand('scratch-windows-runner'),
      readProcessIdentityByPidFn: async pid => isPidPresent(pid)
        ? { pid, processStartTimeMs: 1, command: 'scratch-windows-runner' } : null,
      isPidAliveFn: isPidPresent,
      terminateProcessTreeFn: async ({ pid }) => {
        if (transport === 'windows_incomplete') return;
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        process.kill(-pid, 'SIGTERM');
        await exited;
      } });
    const entrypoint = join(directory, 'index.mjs');
    await writeFile(entrypoint, 'export {};\n');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', entrypoint);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME', 'node');
    vi.spyOn(cliSpawn, 'spawnHappyCLI').mockReturnValue(child);
    const lifecycle = createSpawnLifecycleCallbacks({ connectedServicesBindingsRaw: null, catalogAgentId: null,
      materializationKey: 'failed-launch', hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByPid: resources,
      getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {}, sessionAttachCleanupByPid: attaches,
      persistAcceptedSpawnMarker: async tracked => {
        // The external marker/readiness callback settles after registration.
        await Promise.resolve();
        tracked.spawnStartupReadinessFailure = { type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'startup rejected' };
        resolvers.get(tracked.pid)!(tracked.spawnStartupReadinessFailure);
      } });
    freshSessionBoundary = async raw => {
      if (!raw || typeof raw !== 'object' || !('spawnNonce' in raw) || typeof raw.spawnNonce !== 'string') throw new Error('missing_launch_identity');
      const result = transport.startsWith('hosted') ? await waitForTerminalHostedSessionWebhook({
        pid: wrapperPid, label: 'tmux', normalizedExistingSessionId: '', effectiveResume: '', directoryCreated: false,
        trackedSpawnOptions: { directory, spawnNonce: raw.spawnNonce }, trackedSessionFields: { tmuxSessionId: 'fixture-owned-host' },
        pidToTrackedSession: wrappers, pidToAwaiter: awaiters, pidToSpawnResultResolver: resolvers,
        pidToSpawnWebhookTimeout: timeouts, onChildExited, spawnLifecycleCallbacks: lifecycle,
        cleanupSpawnResources: async () => {}, bindCanonicalSession: async () => {}, logDebug: () => {}, warn: () => {},
        // The OS/terminal adapter proves physical retirement of this exact
        // scratch host. A refused disposition deliberately leaves it running.
        cancelOwnedHost: async () => {
          if (transport === 'hosted_incomplete') return false;
          if (transport === 'hosted_window_only') {
            const tmux = new TmuxUtilities('scratch-owned-window');
            // Successful terminal disposition is an OS boundary, not process-exit proof.
            vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async argv => {
              if (argv[0] === 'kill-window' || argv[0] === 'list-windows') return { command: argv, returncode: 0, stdout: '', stderr: '' };
              throw new Error('unexpected_os_command');
            });
            return await tmux.killWindow('@777');
          }
          if (runner?.pid) wrappers.get(wrapperPid)!.sessionRunnerPid = runner.pid;
          const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
          process.kill(-wrapperPid, 'SIGTERM');
          await exited;
          return !isPidPresent(wrapperPid);
        },
      }) : transport.startsWith('windows') ? await spawnWindowsHostedSessionAndWaitForWebhook({
        windowsLaunchMode: 'console', args: [], agentCommand: 'fixture', directory,
        options: { directory, spawnNonce: raw.spawnNonce }, trackedSpawnOptions: { directory, spawnNonce: raw.spawnNonce },
        normalizedExistingSessionId: '', effectiveResume: '', directoryCreated: false, extraEnvForChildWithMessage: {},
        processEnv: { NODE_ENV: 'test', PATH: process.env.PATH }, happyHomeDir: directory,
        pidToTrackedSession: wrappers, pidToAwaiter: awaiters, pidToSpawnResultResolver: resolvers,
        pidToSpawnWebhookTimeout: timeouts, resolveCanonicalTrackedSessionId: () => '', onChildExited,
        spawnLifecycleCallbacks: lifecycle, cleanupSpawnResources: async () => {}, logDebug: () => {}, warn: () => {},
      }) : await spawnRegularProcessAndWaitForWebhook({ args: [], directory,
        options: { directory, spawnNonce: raw.spawnNonce }, trackedSpawnOptions: { directory, spawnNonce: raw.spawnNonce },
        normalizedExistingSessionId: '', effectiveResume: '', directoryCreated: false, extraEnvForChildWithMessage: {},
        processEnv: { NODE_ENV: 'test', PATH: process.env.PATH, HAPPIER_DAEMON_STARTUP_SOURCE: 'test' },
        pidToTrackedSession: wrappers, pidToAwaiter: awaiters, pidToSpawnResultResolver: resolvers,
        pidToSpawnWebhookTimeout: timeouts, resolveCanonicalTrackedSessionId: () => '', onChildExited,
        spawnLifecycleCallbacks: lifecycle, cleanupSpawnResources: async () => {}, logDebug: () => {}, warn: () => {} });
      if (result.type !== 'error') throw new Error('expected_startup_failure');
      if (transport === 'hosted_incomplete' || transport === 'hosted_window_only' || transport === 'hosted_runner_alive' || transport === 'windows_incomplete') {
        expect(result.errorDetail).toBeUndefined();
        if (transport !== 'hosted_incomplete') expect(result.errorMessage).toBe('startup_retirement_incomplete:process_still_running');
        return SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(result));
      }
      expect(SessionLaunchRetiredV1Schema.parse(result.errorDetail)).toEqual({ kind: 'launch_retired',
        spawnNonce: raw.spawnNonce, wrapperPid });
      if (transport === 'nonce') {
        freshSessionNonceBoundary = () => normalizeSpawnSessionNonceResolution({ status: 'error', ...result });
        return { type: 'success', spawnNonce: raw.spawnNonce, sessionIdStatus: 'pending' };
      }
      return SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(
        transport === 'foreign_nonce' || transport === 'hosted_foreign_nonce' || transport === 'windows_foreign_nonce'
          ? { ...result, errorDetail: { ...SessionLaunchRetiredV1Schema.parse(result.errorDetail), spawnNonce: 'another-launch' } }
          : transport === 'hosted_miswired' || transport === 'windows_miswired' ? { ...result, errorDetail: undefined } : result));
    };
    try {
      const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget, connectedServices: null }, blocks: [step('launch')] };
      const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
      const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
      const sessionInput = sessionInputBoundary();
      const coordination = workflowDaemonProcess({ storage: kit, sessionInput, directory })({ runId, attempt: 0,
        expectedRevision: 0, accountCurrentness: currentness, acceptedEnvelope });
      if (transport === 'foreign_nonce' || transport === 'hosted_incomplete' || transport === 'hosted_window_only' || transport === 'hosted_runner_alive' || transport === 'hosted_foreign_nonce' || transport === 'hosted_miswired' || transport === 'windows_incomplete' || transport === 'windows_foreign_nonce' || transport === 'windows_miswired') {
        await expect(coordination).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
        const unknown = openRowProgress(kit, rowFor(kit, 'launch')!);
        expect(rowFor(kit, 'launch')!.lifecycle).not.toBe('failed');
        const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
          actionExecutor: { execute: async () => { throw new Error('must_not_launch_or_observe_an_input'); } } });
        expect(await observe({ progress: unknown, terminalParent: true, cancellationRequested: true }))
          .toEqual({ kind: 'unresolved', code: 'workflow_execution_correspondence_missing' });
        const owner = createWorkflowRunActionOwner({ resolveAccountId: async () => accountId, storage: kit,
          definitions: { get: async () => { throw new Error('unexpected_definition_read'); } },
          resolveEncryption: async () => ({ kind: 'available', witness: currentness }) });
        await owner.execute({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: kit.run().revision },
          context: { surface: 'ui', authority: 'present_user' } });
        await createWorkflowRunRecoveryReader({ accountId, machineId,
          storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
            ? { candidates: [{ run: kit.run(), parentAttempt: 0 }] } : kit.execute(operation, options) },
          resolveAccountEncryption: async () => ({ kind: 'available', witness: currentness }), reconcileInvocation: observe })('reconnect');
        expect(kit.run().workflowCustodyState).not.toBe('settled');
        expect(wrappers.size).toBe(transport === 'hosted_incomplete' || transport === 'hosted_window_only' || transport === 'hosted_runner_alive' || transport === 'windows_incomplete' ? 1 : 0);
        expect(isPidPresent(wrapperPid)).toBe(transport === 'hosted_incomplete' || transport === 'hosted_window_only' || transport === 'windows_incomplete');
        if (runner?.pid) expect(isPidPresent(runner.pid)).toBe(true);
        expect(sessionInput.enqueue).not.toHaveBeenCalled();
        return;
      }
      await expect(coordination).resolves.toMatchObject({ state: 'interrupted' });
      const launch = rowFor(kit, 'launch')!;
      expect(launch.lifecycle).toBe('failed');
      expect(openRowProgress(kit, launch)).toMatchObject({ reason: { code: 'SPAWN_FAILED' } });
      expect(wrappers.size).toBe(0);
      expect(isPidPresent(wrapperPid)).toBe(false);
      expect(sessionInput.enqueue).not.toHaveBeenCalled();
      const owner = createWorkflowRunActionOwner({ resolveAccountId: async () => accountId, storage: kit,
        definitions: { get: async () => { throw new Error('unexpected_definition_read'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: currentness }) });
      await owner.execute({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: kit.run().revision },
        context: { surface: 'ui', authority: 'present_user' } });
      const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
        actionExecutor: { execute: async () => { throw new Error('must_not_launch_or_observe_an_input'); } } });
      await createWorkflowRunRecoveryReader({ accountId, machineId,
        storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
          ? { candidates: [{ run: kit.run(), parentAttempt: 0 }] } : kit.execute(operation, options) },
        resolveAccountEncryption: async () => ({ kind: 'available', witness: currentness }), reconcileInvocation: observe })('reconnect');
      expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' });
      expect(wrappers.size).toBe(0);
      const { execution: _execution, ...unknown } = openRowProgress(kit, launch);
      expect(await observe({ progress: unknown, terminalParent: true, cancellationRequested: true }))
        .toEqual({ kind: 'unresolved', code: 'workflow_execution_correspondence_missing' });
    } finally {
      nativeLaunchBoundary.child = null;
      nativeLaunchBoundary.cancel = null;
      if (isPidPresent(wrapperPid)) {
        process.kill(-wrapperPid, 'SIGKILL');
        await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
      if (runner?.pid && isPidPresent(runner.pid)) {
        process.kill(-runner.pid, 'SIGKILL');
        await new Promise<void>(resolve => runner.once('exit', () => resolve()));
      }
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      vi.unstubAllEnvs();
      reloadConfiguration();
    }
  });
  it.each([
    { label: 'R31 authored controls with current owner metadata', freshThird: false, catalog: false, appliedMode: null, succeeds: true, nativeMetadata: true },
    { label: 'R36b explicit effort on all three steps', freshThird: false, catalog: false, appliedMode: null, succeeds: true, nativeMetadata: true, effort: 'low' as const },
    { label: 'R36b incompatible retained effort', freshThird: false, catalog: false, appliedMode: null, succeeds: false, nativeMetadata: true, effort: 'low' as const, retainedEffort: 'high' },
    { label: 'R36b mis-wired retained reader', freshThird: false, catalog: false, appliedMode: null, succeeds: false, nativeMetadata: true, effort: 'low' as const, miswireReader: true },
    { label: 'native fresh third', freshThird: true, catalog: false, appliedMode: null, succeeds: true },
    { label: 'concrete default applied', freshThird: false, catalog: true, appliedMode: 'default', succeeds: true },
    { label: 'concrete default not applied', freshThird: false, catalog: true, appliedMode: null, succeeds: false },
    { label: 'different concrete mode applied', freshThird: false, catalog: true, appliedMode: 'plan', succeeds: false },
  ])('continues three Agent steps only with a compatible default mode ($label)', async ({ freshThird, catalog, appliedMode, succeeds, nativeMetadata, effort, retainedEffort, miswireReader }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const runId = '15151515-1515-4515-8515-151515151515';
    const directory = await projectDirectory();
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected' as const, selection: 'profile' as const,
        profileId: nativeMetadata ? 'beee2181-b6ad-463c-8c96-5922f24555cd' : 'profile-1' },
      'happier.agent.claude/anthropic': { source: 'native' as const },
    } };
    const definition: WorkflowDefinitionV1 = {
      version: 1, inputs: [], defaults: nativeMetadata ? { acpSessionModeId: 'default', engine: {
        agentTarget, modelSelection: { v: 1, ref: {
          agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5',
        }, updatedAt: 1791761380474 },
      } } : { agentTarget, acpSessionModeId: 'default', connectedServices },
      blocks: [step('one', { name: 'One', ...(nativeMetadata ? { execution: { connectedServices,
          ...(effort ? { engine: { agentTarget, effort } } : {}) } } : {}) }),
        step('two', { name: 'Two', ...(nativeMetadata ? { execution: { connectedServices,
          ...(effort ? { engine: { agentTarget, effort } } : {}) } } : {}) }),
        step('three', { name: 'Name', ...(freshThird ? { execution: { conversation: { kind: 'fresh' } } }
          : nativeMetadata ? { execution: { connectedServices,
            ...(effort ? { engine: { agentTarget, effort } } : {}) } } : {}) })],
    };
    // R31's saved-source.json pins the authored Haiku/profile choices above.
    // R37b's private child was deleted before diagnosis. Exercise the actual
    // native metadata producer below rather than reconstructing its controls.
    // Native process launch and Home HTTP are the only substituted boundaries.
    // Native Claude publishes no applied ACP mode. A concrete default in an
    // authenticated Agent mode catalog must instead match applied mode evidence.
    const titles = new Map<string, string>();
    freshSessionBoundary = async raw => {
      const request = raw as { initialTitle?: string; connectedServices?: unknown; sessionConfigOptionOverrides?: unknown };
      const id = `fresh-${freshSessionRecords.size + 1}`;
      titles.set(id, request.initialTitle ?? '');
      const launchConfig = request.sessionConfigOptionOverrides === undefined ? undefined
        : AcpConfigOptionOverridesV1Schema.parse(request.sessionConfigOptionOverrides);
      if (effort) expect(launchConfig?.overrides.reasoning_effort?.value).toBe(effort);
      const retainedConfig = retainedEffort && launchConfig ? { ...launchConfig,
        overrides: { ...launchConfig.overrides, reasoning_effort: { value: retainedEffort, updatedAt: 2 } } } : launchConfig;
      const runtimeDescriptorV1 = { v: 1 as const, agentId: 'claude', agent: {} };
      const launch = nativeMetadata ? await resolveSpawnChildEnvironment({
        options: { directory, runtimeDescriptorV1,
          connectedServices: ConnectedServiceBindingsV2IngressSchema.parse(request.connectedServices),
          ...(retainedConfig ? { sessionConfigOptionOverrides: retainedConfig } : {}) },
        processEnv: { NODE_ENV: 'test' }, profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        logDebug() {}, logInfo() {}, logWarn() {},
      }) : null;
      if (launch && !launch.ok) throw new Error(launch.errorMessage);
      const captured = launch?.ok ? captureSessionLaunchControlMetadata({ processEnvironment: {
        ...buildSpawnChildProcessEnv({ processEnv: { NODE_ENV: 'test' }, extraEnv: launch.extraEnvForChild }),
        NODE_ENV: 'test',
      } }) : null;
      if (nativeMetadata) expect(captured?.sessionConfigOptionOverrides).toEqual(retainedConfig ?? null);
      // Exercise the actual fresh native Session producer, rather than placing
      // the expected retained intent directly into a hand-written HTTP record.
      const produced = captured ? createSessionMetadata({
        flavor: 'claude', machineId, directory, startedBy: 'daemon',
        permissionMode: 'default', runtimeDescriptorV1,
        launchControlMetadata: captured,
      }).metadata : null;
      const published = { ...buildCommittedLaunchMetadata({ options: SpawnDaemonSessionRequestSchema.parse(raw), directory, accountSettings: {} }),
        ...(produced ?? { path: directory, machineId, permissionMode: 'default',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} }, connectedServices: request.connectedServices,
        ...(retainedConfig ? { sessionConfigOptionOverridesV1: retainedConfig } : {}) }),
        ...(catalog ? { sessionModesV2: { v: 2, agentId: 'claude', updatedAt: 1, currentModeId: appliedMode,
          availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
        } } : {}),
      };
      const owner = nativeMetadata ? createSessionOwnerMetadataV1({ metadata: published }) : null;
      if (owner && !owner.ok) throw new Error(`native_metadata_fixture_invalid:${owner.unsupportedFields.join(',')}`);
      freshSessionRecords.set(id, createSessionRecordFixture({ id, active: true, encryptionMode: 'plain', machineId,
        origin: { kind: 'run_step', runId }, workDepth: 1,
        ...(owner?.ok ? { metadataLayoutVersion: 1, share: null,
          ownerMetadata: { t: 'plain' as const, v: owner.ownerMetadata } } : {}),
        metadata: JSON.stringify(nativeMetadata ? projectSessionSharedMetadataV1({ metadata: published }) : published),
      }));
      return { type: 'success', sessionId: id, sessionCreationOutcome: {
        disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
      } };
    };
    const destinations: string[] = [];
    const sessionInput = sessionInputBoundary();
    sessionInput.observe.mockImplementation(async request => {
      await request.onInputMaterialized?.(Date.now());
      destinations.push(request.sessionId);
      return { ok: true, sessionId: request.sessionId, localId: request.localId,
        result: { kind: 'final_text', text: `QA_FIN28_${request.localId.toUpperCase()}` } };
    });
    const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const result = await workflowDaemonProcess({ storage: kit, sessionInput, directory, readActualConversation: !miswireReader })({
      runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness, acceptedEnvelope,
    });
    if (!succeeds) {
      expect(result).toMatchObject({ state: 'interrupted' });
      expect(destinations).toEqual(['fresh-1']);
      expect(rowFor(kit, 'two')?.lifecycle).toBe('failed');
      if (miswireReader) {
        expect(openRowProgress(kit, rowFor(kit, 'two')!)).toMatchObject({ reason: { code: 'workflow_conversation_unavailable' } });
        expect(rowFor(kit, 'three')).toBeUndefined();
        return;
      }
      expect(openRowProgress(kit, rowFor(kit, 'two')!)).toMatchObject({
        reason: { code: 'workflow_conversation_unavailable', details: { reason: retainedEffort ? 'sessionConfigOptionOverrides' : 'acpSessionModeId',
          expected: retainedEffort ? { kind: 'object', ids: ['reasoning_effort'] } : { kind: 'string', ids: ['default'] } } },
      });
      expect(rowFor(kit, 'three')).toBeUndefined();
      return;
    }
    expect(result, JSON.stringify(kit.rows().map(row => openRowProgress(kit, row.index)))).toMatchObject({ state: 'succeeded' });
    expect(destinations).toEqual(freshThird ? ['fresh-1', 'fresh-1', 'fresh-2'] : ['fresh-1', 'fresh-1', 'fresh-1']);
    expect(openRowProgress(kit, rowFor(kit, 'one')!).result).toBe('QA_FIN28_ONE');
    expect(openRowProgress(kit, rowFor(kit, 'two')!).result).toBe('QA_FIN28_TWO');
    expect(openRowProgress(kit, rowFor(kit, 'three')!).result).toBe('QA_FIN28_THREE');
    expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled', attentionRequired: false });
    expect(titles.get(freshThird ? 'fresh-2' : 'fresh-1')).toBe(freshThird ? '3 · Name' : '1 · One');
  });

  it('carries the stored accepted requester through production Workflow wiring to protected machine admission', async () => {
    const runId = '17171717-1717-4717-8717-171717171717';
    const directory = await projectDirectory();
    const attribution = { requestRef: 'accepted-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'release-bot' }, origin: null };
    const acceptedEnvelope = await sealDirectAccepted({ runId, directory, actionRequestAttributionV1: attribution,
      definition: { version: 1, inputs: [], defaults: retainedConversationDefaults(), blocks: [step('work')] } });
    attribution.requester.accountId = 'carol';
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
    const requests: unknown[] = [];
    const result = await workflowDaemonProcess({ storage: kit, directory, readActualConversation: true,
      machineAdmissionTransport: async request => {
        requests.push(SessionPendingEnqueueByMachineRequestV1Schema.parse(request));
        // The authenticated Machine transport is the genuine boundary. Refuse
        // input here so this admission test never needs a synthetic native turn.
        return { status: 'rejected', code: 'session_input_invalid' };
      },
    })({ runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness, acceptedEnvelope });
    expect(result).toMatchObject({ state: 'interrupted' });
    expect(requests).toEqual([expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
      meta: expect.objectContaining({ happierInputRequestV1: expect.objectContaining({
        actionRequestAttributionV1: { ...attribution, requester: { serverId: 'home', accountId: 'bob' } },
      }) }),
    }) } })]);
  });

  it.each(['native', 'legacy', 'selected_profile'] as const)(
    'continues two explicit no-profile Session leaves against %s persisted metadata', async shape => {
      const runId = '15151515-1515-4515-8515-151515151516';
      const directory = await projectDirectory();
      const connectedServices = { v: 2 as const, bindingsByServiceId: {
        'happier.agent.claude/anthropic': { source: 'native' as const },
      } };
      const definition: WorkflowDefinitionV1 = {
        version: 1, inputs: [], defaults: { agentTarget, connectedServices },
        blocks: [step('one', { execution: { profileId: null } }), step('two', { execution: { profileId: null } })],
      };
      freshSessionBoundary = async raw => {
        const spawn = SpawnDaemonSessionRequestSchema.parse(raw);
        const runtimeDescriptorV1 = { v: 1 as const, agentId: 'claude', agent: {} };
        const launch = await resolveSpawnChildEnvironment({
          options: { directory, runtimeDescriptorV1,
            connectedServices: ConnectedServiceBindingsV2IngressSchema.parse(spawn.connectedServices) },
          processEnv: { NODE_ENV: 'test' }, profileEnvironmentVariables: {}, daemonSpawnHooks: null,
          logDebug() {}, logInfo() {}, logWarn() {},
        });
        if (!launch.ok) throw new Error(launch.errorMessage);
        // Native startup actually omits the profile field for no-profile launches.
        const produced = createSessionMetadata({ flavor: 'claude', machineId, directory, startedBy: 'daemon',
          permissionMode: 'default', runtimeDescriptorV1,
          launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment:
            buildSpawnChildProcessEnv({ processEnv: { NODE_ENV: 'test' }, extraEnv: launch.extraEnvForChild }) }),
        }).metadata;
        expect(produced.profileId).toBeUndefined();
        // Historical Sessions predate launch-control/profile fields. Keep the
        // raw stored vector, rather than upgrading it with today's producer.
        const legacy = { path: directory, machineId, flavor: 'claude', permissionMode: 'default', runtimeDescriptorV1, connectedServices };
        const published = { ...buildCommittedLaunchMetadata({ options: spawn, directory, accountSettings: {} }),
          ...(shape === 'legacy' ? legacy : produced),
          ...(shape === 'selected_profile' ? { profileId: 'another-profile' } : {}) };
        const owner = createSessionOwnerMetadataV1({ metadata: published });
        if (!owner.ok) throw new Error(`profile_fixture_invalid:${owner.unsupportedFields.join(',')}`);
        freshSessionRecords.set('fresh-no-profile', createSessionRecordFixture({ id: 'fresh-no-profile', active: true,
          encryptionMode: 'plain', machineId, origin: { kind: 'run_step', runId }, workDepth: 1,
          ...(shape === 'legacy' ? {} : { metadataLayoutVersion: 1, share: null,
            ownerMetadata: { t: 'plain' as const, v: owner.ownerMetadata } }),
          metadata: JSON.stringify(shape === 'legacy' ? published : projectSessionSharedMetadataV1({ metadata: published })),
        }));
        return { type: 'success', sessionId: 'fresh-no-profile', sessionCreationOutcome: {
          disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
        } };
      };
      const destinations: string[] = [];
      const sessionInput = sessionInputBoundary();
      sessionInput.observe.mockImplementation(async request => {
        await request.onInputMaterialized?.(Date.now());
        destinations.push(request.sessionId);
        return { ok: true, sessionId: request.sessionId, localId: request.localId,
          result: { kind: 'final_text', text: request.localId } };
      });
      const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory });
      const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope });
      const result = await workflowDaemonProcess({ storage: kit, sessionInput, directory, readActualConversation: true })({
        runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness, acceptedEnvelope,
      });
      if (shape === 'selected_profile') {
        expect(result).toMatchObject({ state: 'interrupted' });
        expect(destinations).toEqual(['fresh-no-profile']);
        expect(openRowProgress(kit, rowFor(kit, 'two')!)).toMatchObject({ reason: {
          code: 'workflow_conversation_unavailable', details: { reason: 'profileId',
            expected: { kind: 'null' }, observed: { kind: 'string', ids: ['another-profile'] } },
        } });
      } else {
        expect(result, JSON.stringify(kit.rows().map(row => openRowProgress(kit, row.index)))).toMatchObject({ state: 'succeeded' });
        expect(destinations).toEqual(['fresh-no-profile', 'fresh-no-profile']);
        expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
      }
    });

  it('settles a successful Run with no selected final output while origin delivery remains unacknowledged', async () => {
    const runId = '10101010-1010-4010-8010-101010101010';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1, inputs: [], defaults: retainedConversationDefaults(), blocks: [step('work')],
    };
    const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory, deliverResult: true });
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct', originSessionId: sessionId },
      acceptedEnvelope, originDeliveryAckRevision: 0,
    });
    const sessionInput = sessionInputBoundary();
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });

    await expect(coordinate({
      protocol: 'v3', automationId: null, runId, attempt: 0, expectedRevision: 0,
      accountCurrentness: currentness, acceptedSnapshotEnvelope: acceptedEnvelope,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });

    expect(openRowProgress(kit, rowFor(kit, 'work')!).result).toBe('work');
    expect(kit.run()).toMatchObject({
      state: 'succeeded', workflowCustodyState: 'settled',
      originDeliveryAckRevision: 0,
    });
  });

  it.each<{
    expectedState: 'paused' | 'interrupted';
    outcomes: Readonly<Record<string, LeafOutcome>>;
    pauseAfter: string | null;
  }>([
    { expectedState: 'paused', outcomes: {}, pauseAfter: 'first' },
    { expectedState: 'interrupted', outcomes: { first: 'failed' }, pauseAfter: null },
  ])('preserves recoverable custody after a $expectedState parent commit with origin delivery enabled', async ({ expectedState, outcomes, pauseAfter }) => {
    const runId = expectedState === 'paused'
      ? '13131313-1313-4313-8313-131313131313'
      : '14141414-1414-4414-8414-141414141414';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [step('first'), step('must-not-run')],
      finalOutput: { kind: 'result', producer: { blockId: 'must-not-run', scope: { kind: 'current' } }, path: [] },
    };
    const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory, deliverResult: true });
    const kit = createWorkflowRunStorageTestkit({
      runId,
      machineId,
      origin: { kind: 'direct', originSessionId: sessionId },
      acceptedEnvelope,
      originDeliveryAckRevision: 0,
    });
    const sessionInput = sessionInputBoundary(outcomes, {
      onObserve: async (label) => {
        if (label === pauseAfter) kit.requestControl('pause_requested');
      },
    });
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });

    const coordinated = await coordinate({
      runId,
      attempt: 0,
      expectedRevision: 0,
      accountCurrentness: currentness,
      acceptedEnvelope,
    } as never);
    expect(coordinated, JSON.stringify({ observedInputs: sessionInput.observe.mock.calls.map(([request]) => request.localId) }))
      .toMatchObject({ state: expectedState });

    if (expectedState === 'interrupted') {
      expect(openRowProgress(kit, rowFor(kit, 'first')!).reason).toEqual({
        code: 'session_input_failed', message: 'Provider rejected the required step input',
      });
      expect(rowFor(kit, 'must-not-run')).toBeUndefined();
    }
    expect(kit.run()).toMatchObject({
      state: expectedState,
      workflowCustodyState: 'pending',
      originDeliveryAckRevision: 0,
    });
  });

  it('keeps an admitted Session input through a transient heartbeat error and subsequent confirmed renewal', async () => {
    const directory = await projectDirectory();
    vi.useFakeTimers();
    let finish = () => {};
    try {
      const runId = '12121212-1212-4212-8212-121212121212';
      const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: retainedConversationDefaults(), blocks: [step('active')] };
      const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' },
        acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }) });
      let observationStarted = () => {};
      const started = new Promise<void>(resolve => { observationStarted = resolve; });
      const resultReady = new Promise<void>(resolve => { finish = resolve; });
      const sessionInput = sessionInputBoundary();
      let inputSignal: AbortSignal | undefined;
      sessionInput.observe.mockImplementationOnce(async request => {
        inputSignal = request.signal;
        observationStarted();
        await resultReady;
        return { ok: true, sessionId, localId: request.localId, result: { kind: 'final_text', text: 'completed after renewal' } };
      });
      let renewals = 0;
      let renewedAfterFailure = false;
      const running = executeClaimedRun({ machineId, heartbeatMs: 1_000, leaseDurationMs: 30_000,
        claimClient: { heartbeatRun: async () => {
          if (++renewals === 2) throw Object.assign(new Error('lost heartbeat response'), { code: 'ECONNABORTED' });
          if (renewals > 2) renewedAfterFailure = true;
          return Date.now() + 30_000;
        }, failRun: async () => { throw new Error('An admitted direct Run cannot be failed through Automation settlement'); } },
        coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory }),
        claimed: { protocol: 'v3', automation: null, accountCurrentness: currentness,
          run: { id: runId, automationId: null, attempt: 0, leaseExpiresAt: Date.now() + 30_000, revision: kit.run().revision, origin: { kind: 'direct' },
            workflowAcceptedSnapshotEnvelope: kit.acceptedEnvelope()!, triggerId: null } },
      });
      await started;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(inputSignal?.aborted).toBe(false);
      expect(renewedAfterFailure).toBe(true);
      finish();
      await running;
      expect(kit.run().state).toBe('succeeded');
      expect(sessionInput.enqueue).toHaveBeenCalledOnce();
      expect(sessionInput.cancel).not.toHaveBeenCalled();
    } finally { finish(); vi.useRealTimers(); }
  });

  it('propagates persisted live cancellation on the existing heartbeat into the exact Session leaf once', async () => {
    const directory = await projectDirectory();
    vi.useFakeTimers();
    try {
      const runId = '12121212-1212-4212-8212-121212121212';
      const definition: WorkflowDefinitionV1 = {
        version: 1, inputs: [], defaults: retainedConversationDefaults(),
        blocks: [step('active'), step('must-not-admit')],
      };
      const kit = createWorkflowRunStorageTestkit({
        runId, machineId, origin: { kind: 'direct' },
        acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
      });
      let observationStarted!: () => void;
      const started = new Promise<void>((resolve) => { observationStarted = resolve; });
      const sessionInput = sessionInputBoundary();
      sessionInput.cancel.mockImplementationOnce(async () => {
        expect(kit.run()).toMatchObject({ workflowCustodyState: 'pending' });
        return { kind: 'turn_cancel_requested' as const };
      });
      sessionInput.observe.mockImplementationOnce(async (request) => {
        observationStarted();
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return { ok: false as const, code: 'cancelled' };
      });
      // The stop request has no terminal input result yet; retain exact custody.
      sessionInput.observe.mockImplementationOnce(async () => ({ ok: false as const, code: 'session_input_result_read_failed' }));
      const claimClient = {
        startRun: vi.fn(),
        heartbeatRun: vi.fn(async (request: { leaseDurationMs: number }) => {
          if (sessionInput.observe.mock.calls.length > 0) kit.requestControl('cancel_requested');
          return Date.now() + request.leaseDurationMs;
        }),
        succeedRun: vi.fn(), failRun: vi.fn(),
      };
      const running = executeClaimedRun({
        machineId, claimClient,
        heartbeatMs: 1_000, leaseDurationMs: 120_000,
        coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory }) as never,
        claimed: {
          protocol: 'v3', automation: null, accountCurrentness: currentness,
          run: { id: runId, automationId: null, attempt: 0, leaseExpiresAt: Date.now() + 120_000, revision: kit.run().revision, origin: { kind: 'direct' }, workflowAcceptedSnapshotEnvelope: kit.acceptedEnvelope()!, triggerId: null },
        } as never,
      });
      await started;
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(running).resolves.toBeUndefined();

      expect(sessionInput.cancel).toHaveBeenCalledOnce();
      expect(sessionInput.cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId, localId: 'active' }));
      expect(sessionInput.enqueue.mock.calls.map(([request]) => leafLabel(request.text))).toEqual(['active']);
      expect(rowFor(kit, 'active')?.lifecycle).toBe('cancel_requested');
      expect(rowFor(kit, 'must-not-admit')).toBeUndefined();
      // The parent ends authored work while terminal recovery retains the exact
      // unresolved child stop. Ending the Run must not claim physical custody settled.
      const settlements = kit.calls.filter((operation) => operation.operation === 'transition' && operation.state !== 'running');
      expect(settlements).toEqual([expect.objectContaining({ state: 'cancelled',
        invocationTransitions: [expect.objectContaining({ lifecycle: 'cancelled' })],
      })]);
      expect(settlements[0]).not.toHaveProperty('custodyState');
      expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'pending' });
    } finally {
      vi.useRealTimers();
    }
  });

  it(
    'carries a direct RPC-admitted program through one production Run owner and cannot replay a completed invocation',
    async () => {
      const runId = '11111111-1111-4111-8111-111111111111';
      const directory = await projectDirectory();
      const definition: WorkflowDefinitionV1 = {
        version: 1,
        inputs: [],
        defaults: retainedConversationDefaults(),
        blocks: [step('work', { pauseForReview: true })],
        finalOutput: { kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [] },
      };
      const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' } });
      const runOwner = createWorkflowRunActionOwner({
        resolveAccountId: async () => accountId,
        storage: kit,
        definitions: { get: vi.fn() },
        resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
        // The exact Machine's inventory is an external boundary, not a
        // replacement for the admission owner's real materialization path.
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
        prepareWorkspace: async () => ({
          ok: true,
          workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } },
        }),
      });
      const workflowActions = createWorkflowActionExecutor({
        isWorkflowFeatureEnabled: async () => true,
        definitions: unexpectedWorkflowDefinitions(),
        runs: runOwner,
      });
      const actionExecutor = {
        execute: async (
          actionId: Parameters<typeof workflowActions>[0]['actionId'],
          input: unknown,
          context?: Parameters<typeof workflowActions>[0]['context'],
        ) => ({
          ok: true as const,
          // `createCliActionDeps.ts` is the canonical owner that resolves the
          // current Session's machine/directory into the Action context for
          // `workflow.run.start`; this composed executor reproduces only that
          // injection rather than a second target resolver.
          result: await workflowActions({
            actionId,
            input,
            context: { ...context, externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory } } },
          } as never),
        }),
      };

      await expect(dispatchActionFromRpc({
        actionId: 'workflow.run.start',
        input: { runId, source: { kind: 'inline', definition } },
        localActionContext: {
          surface: 'rpc', authority: 'account_automation', callerPermissionMode: 'safe-yolo',
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'safe-yolo' },
        },
        executor: actionExecutor as never,
      })).resolves.toMatchObject({ ok: true, result: { admission: 'created', run: { id: runId } } });
      const acceptedEnvelope = kit.acceptedEnvelope();
      expect(acceptedEnvelope).not.toBeNull();
      expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope!),
      })).toMatchObject({ kind: 'available', content: { origin: { kind: 'direct' }, source: { kind: 'inline' } } });

      const sessionInput = sessionInputBoundary();
      const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });
      const claimed = {
        protocol: 'v3',
        automation: null,
        accountCurrentness: currentness,
        run: {
          id: runId, automationId: null, attempt: 0, leaseExpiresAt: Date.now() + 120_000, revision: kit.run().revision, origin: { kind: 'direct' },
          workflowAcceptedSnapshotEnvelope: acceptedEnvelope!, triggerId: null,
        },
      } as never;
      const claimClient = { startRun: vi.fn(), heartbeatRun: vi.fn(async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs), succeedRun: vi.fn(), failRun: vi.fn() };
      const executeClaim = async () => await executeClaimedRun({
        machineId, claimClient,
        heartbeatMs: 60_000, leaseDurationMs: 120_000, coordinateWorkflowRun: coordinate as never, claimed,
      });
      await executeClaim();
      const held = rowFor(kit, 'work')!;
      expect(WorkflowRunSummaryV1Schema.parse(kit.run())).toMatchObject({
        state: 'waiting_for_review', heldCount: 1, attentionRequired: true,
      });
      expect(WorkflowRunSummaryV1Schema.safeParse({ ...kit.run(), unknown: true }).success).toBe(false);
      await workflowActions({ actionId: 'workflow.run.invocations.complete_review',
        input: { runId, invocation: { recordId: held.id }, expectedContentRevision: held.contentRevision,
          mode: 'use_result', value: 'work' },
        context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'safe-yolo' } });
      expect(WorkflowRunSummaryV1Schema.parse(kit.run())).toMatchObject({ heldCount: 0, attentionRequired: false });
      // A lost claim response reclaims the same Run. The durable completed row
      // is observed, not replayed, so no second Session input is admitted.
      await executeClaim();

      const work = rowFor(kit, 'work');
      expect(work?.lifecycle).toBe('completed');
      expect(openRowProgress(kit, work!).result).toBe('work');
      expect(sessionInput.enqueue).toHaveBeenCalledOnce();
      expect(sessionInput.observe).toHaveBeenCalledOnce();
      expect(claimClient.startRun).not.toHaveBeenCalled();
      expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
    },
  );
});

describe('composed Automation workflow claim and optional receipt', () => {
  it('adds and claims a scheduled Agent workflow with its connected profile intact at native launch', async () => {
    const runId = '34343434-3434-4434-8434-343434343434';
    const directory = await projectDirectory();
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected' as const, selection: 'profile' as const,
        profileId: '00ae5eea-6286-48bc-b82a-30a5f8492864' },
    } };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget, connectedServices },
      blocks: [step('connected-work')] };
    let stored: AutomationDefinitionDetail | undefined;
    let id = 0;
    const unexpected = async (): Promise<never> => { throw new Error('unexpected_automation_effect'); };
    const triggers = createAccountWorkflowTriggerActions({
      automations: { list: async () => ({ automations: [], nextCursor: null }), listDetails: async () => ({ automations: [], nextCursor: null }), get: async () => stored ?? null,
        create: async input => {
          // Opaque Home persistence is the boundary. Preserve the real trigger
          // producer's recipe and validate the stored response with its schema.
          const trigger = input.triggers[0]!;
          if (trigger.trigger.kind !== 'schedule') throw new Error('expected_schedule');
          const { automationId, ...created } = input;
          stored = AutomationDefinitionDetailSchema.parse({ ...created, id: automationId,
            targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
            assignments: input.assignments!.map(assignment => ({ ...assignment, priority: 0, updatedAt: 1 })),
            triggers: [{ ...trigger.trigger, id: trigger.triggerId, revision: 0, nextRunAt: 60_001,
              triggerDefinitionEnvelope: null, createdAt: 1, updatedAt: 1 }],
          });
          return stored;
        }, reconcile: unexpected, delete: unexpected },
      resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
      resolveSession: unexpected, resolveWorkflow: unexpected,
      randomBytes: length => new Uint8Array(length).fill(9), newId: () => `connected-${++id}`,
    });
    const added = await triggers.add({ target: { kind: 'inline', definition }, project: { machineId, directory },
      trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'interval', everyMs: 60_000,
        scheduleExpr: null, timezone: null } } }, { surface: 'ui', authority: 'present_user' });
    expect(WorkflowTriggerWriteResultV1Schema.parse(added)).toMatchObject({ triggerRevision: 0,
      set: { health: 'available', target: { kind: 'inline', definition } } });
    expect(WorkflowTriggerWriteResultV1Schema.safeParse({ ...added, unknown: true }).success).toBe(false);
    if (!stored?.executionRecipe || stored.executionRecipe.v !== 2 || !added.triggerId) throw new Error('missing_trigger_recipe');
    const recipe = stored.executionRecipe;
    const occurrence = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'schedule',
      triggerId: added.triggerId, triggerRevision: 0, occurredAt: 60_001, evidence: { scheduledFor: 60_001 },
      occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: added.triggerId,
        evidence: { v: 1, kind: 'schedule', scheduledFor: 60_001 } }) });
    const row = stored;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => url.endsWith('/v3/automations/runs/claim')
      ? { status: 200, data: { run: { id: runId, automationId: row.id, attempt: 1, leaseExpiresAt: Date.now() + 120_000, revision: 0,
        recipeKind: 'workflow-v2', triggerId: added.triggerId, triggerRetired: false, cause: occurrence, causeWorkDepth: 0,
        executionInputEnvelope: JSON.stringify(recipe.workflow), automationEvidenceEnvelope: null },
        automation: { id: row.id, name: row.name, enabled: true, scopeSessionId: null }, accountCurrentness: currentness } }
      : writeSessionReadiness(url, body));
    const launches: unknown[] = [];
    freshSessionBoundary = raw => {
      launches.push(raw);
      const request = raw as { connectedServices?: unknown };
      freshSessionRecords.set('connected-child', createSessionRecordFixture({ id: 'connected-child', active: true,
        encryptionMode: 'plain', machineId, origin: { kind: 'run_step', runId }, workDepth: 1,
        metadata: JSON.stringify({ path: directory, machineId, connectedServices: request.connectedServices,
          runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }),
      }));
      return { type: 'success', sessionId: 'connected-child', sessionCreationOutcome: {
        disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
      } };
    };
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed',
      origin: { kind: 'automation', automationId: row.id } });
    const client = createAutomationClaimClient({ token: 'token', createPublisherHeader: async () => 'publisher' });
    const claimed = await client.claimRun({ machineId, leaseDurationMs: 120_000 });
    if (!claimed.run) throw new Error('expected_claimed_workflow_run');
    await executeClaimedRun({ machineId, claimClient: client, claimed, heartbeatMs: 60_000, leaseDurationMs: 120_000,
      coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput: sessionInputBoundary({}, { sessionId: 'connected-child' }),
        directory, readActualConversation: true }) });
    expect(launches).toEqual([expect.objectContaining({ connectedServices })]);
    expect(openRowProgress(kit, rowFor(kit, 'connected-work')!).result).toBe('connected-work');
    expect(WorkflowRunSummaryV1Schema.parse(kit.run())).toMatchObject({ state: 'succeeded', heldCount: 0, attentionRequired: false });
  });

  it('executes one scoped manual habit into its already-running destination and suppresses Notify me when reported is false', async () => {
    const directory = await projectDirectory();
    const habitRunId = '31313131-3131-4131-8131-313131313131';
    const kit = createWorkflowRunStorageTestkit({ runId: habitRunId, machineId, state: 'claimed',
      origin: { kind: 'automation', automationId: 'habit' } });
    const sessionInput = sessionInputBoundary({ check: { kind: 'final_text', text: '{"reported":false}' } });
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: retainedConversationDefaults(), blocks: [
      step('check', { result: { kind: 'json', schema: { type: 'object', properties: { reported: { type: 'boolean' } },
        required: ['reported'], additionalProperties: false } } }),
      { kind: 'action', id: 'notice', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Reported' } },
        onlyWhen: { kind: 'compare', operator: 'eq',
          left: { kind: 'result', producer: { blockId: 'check', scope: { kind: 'current' } }, path: ['reported'] },
          right: { kind: 'literal', value: true } } },
    ] };
    const claim = { runId: habitRunId, automationId: 'habit', scopeSessionId: sessionId, attempt: 1,
      expectedRevision: 0, accountCurrentness: currentness, automationCause: { kind: 'manual' as const, invokedAt: 1 },
      causeWorkDepth: 0, definitionEnvelope: JSON.stringify({ t: 'plain', v: { inlineDefinition: definition,
        workspace: { directory }, executionTarget: { kind: 'session' } } }) };
    let claimed = false;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v3/automations/worker/assignments')) return { data: { assignments: [],
        settings: { maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } } };
      if (url.endsWith('/v3/automations/worker/run-lifecycle')) return { data: { sources: [] } };
      return await readSessionReadiness(url);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (!url.endsWith('/v3/automations/runs/claim')) return await writeSessionReadiness(url, body);
      if (claimed) return { data: { run: null, automation: null, accountCurrentness: null } };
      claimed = true;
      return { data: {
        run: { id: habitRunId, automationId: 'habit', attempt: claim.attempt, leaseExpiresAt: Date.now() + 120_000, revision: 0, recipeKind: 'workflow-v2',
          triggerId: null, triggerRetired: false, cause: claim.automationCause, causeWorkDepth: 0,
          executionInputEnvelope: claim.definitionEnvelope, automationEvidenceEnvelope: null },
        automation: { id: 'habit', name: 'Quiet habit', enabled: false, scopeSessionId: sessionId },
        accountCurrentness: currentness,
      } };
    });
    let resolveOutcome!: (result: Awaited<ReturnType<typeof coordinate>>) => void;
    const outcome = new Promise<Awaited<ReturnType<typeof coordinate>>>(resolve => { resolveOutcome = resolve; });
    const worker = startAutomationWorker({ token: 'token', credentials: { token: 'token', encryption: null },
      machineId, coordinateWorkflowRun: async input => {
        const result = await coordinate(input);
        resolveOutcome(result);
        return result;
      } });
    try {
      await worker.refreshAssignments();
      worker.handleServerUpdate({ id: 'habit-wake', seq: 1, createdAt: 1, body: {
        t: 'automation-run-updated', runId: habitRunId, automationId: 'habit', state: 'queued', scheduledAt: 1,
        startedAt: null, finishedAt: null, updatedAt: 1, machineId: null, targetMachineId: machineId,
      } });
      await expect(outcome).resolves.toMatchObject({ state: 'succeeded' });
    } finally {
      worker.stop();
    }
    const acceptedEnvelope = kit.acceptedEnvelope();
    if (!acceptedEnvelope) throw new Error('habit_snapshot_not_admitted');
    expect(await coordinate({ ...claim, expectedRevision: kit.run().revision,
      acceptedEnvelope })).toMatchObject({ state: 'succeeded' });
    expect(sessionInput.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId }));
    expect(openRowProgress(kit, rowFor(kit, 'check')!).result).toEqual({ reported: false });
    expect(rowFor(kit, 'notice')?.lifecycle).toBe('skipped');
    expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
  });

  it.each([false, true])('readies the exact Bot before offering a quiet origin step (already active: %s)', async alreadyActive => {
    const directory = await projectDirectory();
    const habitRunId = '35353535-3535-4535-8535-353535353535';
    freshSessionRecords.set(sessionId, createSessionRecordFixture({ id: sessionId, active: alreadyActive,
      encryptionMode: 'plain', machineId, metadata: JSON.stringify({ machineId, path: directory,
        claudeSessionId: 'native-session', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
      }) }));
    const kit = createWorkflowRunStorageTestkit({ runId: habitRunId, machineId, state: 'claimed',
      origin: { kind: 'automation', automationId: 'habit' } });
    const offered: unknown[] = [];
    const origin = createWorkflowOriginContextInputPort({ accountId, originSessionId: sessionId, machineId,
      resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
      // HTTP persistence is the system boundary. Every sealed snapshot and row
      // is produced by the real coordinator and opened by the real origin reader.
      storage: { execute: async operation => operation.operation === 'delivery.pull'
        ? { runs: [{ run: kit.run(), acceptedEnvelope: kit.acceptedEnvelope(), hasOriginInputCandidates: true }], nextCursor: null }
        : await kit.execute(operation) },
      readDispatchFact: async () => 'not_dispatched', onDispatchedInput: () => {},
      onError: error => { throw error; },
    });
    const sessionInput = sessionInputBoundary();
    sessionInput.observe.mockImplementation(async request => {
      expect(freshSessionRecords.get(sessionId)?.active).toBe(true);
      const input = await origin.take(request.signal ?? new AbortController().signal);
      expect(input).toMatchObject({ kind: 'workflow_step', localInputId: request.localId,
        text: 'Keep the reading notes tidy.', workflowInvocation: { runId: habitRunId } });
      offered.push(input);
      await request.onInputMaterialized?.(Date.now());
      return { ok: true, sessionId, localId: request.localId,
        result: { kind: 'final_text', text: 'Reading notes are up to date.' } };
    });
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory, readActualConversation: true });
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { conversation: { kind: 'origin_session' } },
      blocks: [step('upkeep', { document: { text: 'Keep the reading notes tidy.', references: [], attachments: [] } })],
      finalOutput: { kind: 'result', producer: { blockId: 'upkeep', scope: { kind: 'current' } }, path: [] } };
    const claim = { runId: habitRunId, automationId: 'habit', scopeSessionId: sessionId, attempt: 1,
      expectedRevision: 0, accountCurrentness: currentness, automationCause: { kind: 'manual' as const, invokedAt: 1 },
      causeWorkDepth: 0, definitionEnvelope: JSON.stringify({ t: 'plain', v: { inlineDefinition: definition,
        workspace: { directory }, executionTarget: { kind: 'session' } } }),
      acquireMachineStartCapacity: async () => { throw new Error('An existing Bot input consumes no Agent-start slot'); } };
    expect(await coordinate(claim)).toMatchObject({ state: 'succeeded' });
    expect(offered).toHaveLength(1);
    expect(sessionInput.enqueue).not.toHaveBeenCalled();
    expect(openRowProgress(kit, rowFor(kit, 'upkeep')!).result).toBe('Reading notes are up to date.');
    const acceptedEnvelope = kit.acceptedEnvelope();
    if (!acceptedEnvelope) throw new Error('habit_snapshot_not_admitted');
    expect(await coordinate({ ...claim, expectedRevision: kit.run().revision, acceptedEnvelope })).toMatchObject({ state: 'succeeded' });
    expect(offered).toHaveLength(1);
  });

  it('refuses a V2 lifecycle Workflow whose materialized conversation is its own source', async () => {
    const directory = await projectDirectory();
    const lifecycleRunId = '27272727-2727-4727-8727-272727272727';
    const triggerId = AutomationTriggerIdSchema.parse('lifecycle-trigger');
    const occurrence = { v: 1 as const, kind: 'sessionLifecycle' as const, event: 'parentTurnCompleted' as const,
      sourceSessionId: sessionId, sourceTurnId: 'source-turn', occurredAt: 1 };
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'sessionLifecycle', triggerId,
      triggerRevision: 0, occurredAt: 1, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: occurrence }),
      evidence: { event: occurrence.event, sourceSessionId: sessionId, sourceTurnId: occurrence.sourceTurnId,
        policy: { kind: 'currentTurn' } } });
    const kit = createWorkflowRunStorageTestkit({ runId: lifecycleRunId, machineId, state: 'claimed',
      origin: { kind: 'automation', automationId: 'automation-lifecycle' } });
    const sessionInput = sessionInputBoundary();
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });
    await expect(coordinate({ runId: lifecycleRunId, automationId: 'automation-lifecycle', attempt: 1,
      expectedRevision: 0, accountCurrentness: currentness, automationCause: cause, causeWorkDepth: 0,
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        workspace: { directory }, executionTarget: { kind: 'session' },
        inlineDefinition: { version: 1, defaults: retainedConversationDefaults(), blocks: [step('work')] },
      } }) })).resolves.toEqual({ state: 'failed', reason: 'self_target', blockId: 'work', admission: 'refused' });
    expect(kit.acceptedEnvelope()).toBeNull();
    expect(sessionInput.enqueue).not.toHaveBeenCalled();
  });
  it.each([false, true])('runs exact frozen ordinary predecessor input through the Workflow coordinator without reading the changed Definition (retained extras %s)', async extraStoredFields => {
    const directory = await projectDirectory();
    const runId = '29292929-2929-4929-8929-292929292929';
    const retainedSessionId = 'session-old';
    const frozen = JSON.stringify({ kind: 'happier_automation_run_execution_input_v1', targetType: 'existing_session', templateVersion: 1,
      templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN,
      ...(extraStoredFields ? { retiredFrozenField: true } : {}),
      origin: { kind: 'manual', invokedAt: 1, ...(extraStoredFields ? { retiredOriginField: true } : {}) } });
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed', origin: { kind: 'automation', automationId: 'automation-old' } });
    const sessionInput = sessionInputBoundary({}, { sessionId: retainedSessionId });
    const claimClient = { startRun: vi.fn(), heartbeatRun: async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs, succeedRun: vi.fn(), failRun: vi.fn() };
    await executeClaimedRun({ machineId, claimClient, heartbeatMs: 60_000, leaseDurationMs: 120_000,
      coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory, conversationSessionId: retainedSessionId }),
      claimed: { protocol: 'v3', accountCurrentness: currentness,
        automation: { id: 'automation-old', name: 'Changed', enabled: true, workflowDefinitionId: 'must-not-read', scopeSessionId: 'must-not-use' },
        run: { id: runId, automationId: 'automation-old', attempt: 2, leaseExpiresAt: Date.now() + 120_000, revision: 0, recipeKind: 'legacy', triggerId: null, cause: { kind: 'manual', invokedAt: 1 },
          causeWorkDepth: 0, resultDelivery: { kind: 'none' }, executionInputEnvelope: frozen } },
    });
    expect(kit.run()).toMatchObject({ state: 'succeeded' });
    expect(sessionInput.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: retainedSessionId, text: expect.stringContaining('Review the release') }));
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, envelope: parseWorkflowStoredContentEnvelopeV1(kit.acceptedEnvelope()!) });
    expect(opened).toMatchObject({ kind: 'available', content: { source: { kind: 'automation', automationId: 'automation-old' } } });
    expect(kit.run().origin).toMatchObject({ kind: 'automation', automationId: 'automation-old' });
    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
    expect(kit.calls).toContainEqual(expect.objectContaining({ operation: 'accepted-snapshot.resolve',
      runId, expectedAttempt: 2, definitionEnvelope: frozen }));
  });

  it.each(['retained encrypted', 'strict classic', 'mismatched origin'] as const)('refuses frozen %s bytes at Workflow admission without any Session effect', async (kind) => {
    const directory = await projectDirectory();
    const runId = '30303030-3030-4030-8030-303030303030';
    const classic = serializeAutomationRunExecutionRecipeV1({ v: 1, templateVersion: 1,
      assignmentMachineIds: [machineId], template: { t: 'plain', v: { v: 1, prompt: 'Classic work' } },
      triggerEvidence: null, target: { kind: 'existingSession', sessionId: 'session-old' } });
    if (classic.kind !== 'available') throw new Error('Invalid canonical historical recipe fixture');
    const frozen = kind === 'strict classic' ? classic.serialized : JSON.stringify({
      kind: 'happier_automation_run_execution_input_v1', targetType: 'existing_session', templateVersion: 1,
      templateCiphertext: kind === 'retained encrypted' ? AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED : AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN,
      ...(kind === 'mismatched origin' ? { retiredFrozenField: true } : {}),
      origin: { kind: 'manual', invokedAt: kind === 'mismatched origin' ? 2 : 1,
        ...(kind === 'mismatched origin' ? { retiredOriginField: true } : {}) },
    });
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed', origin: { kind: 'automation', automationId: 'automation-old' } });
    const sessionInput = sessionInputBoundary();
    const failRun = vi.fn();
    await executeClaimedRun({ machineId, claimClient: { heartbeatRun: async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs, failRun },
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: currentness }),
      heartbeatMs: 60_000, leaseDurationMs: 120_000,
      coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory }),
      claimed: { protocol: 'v3', accountCurrentness: currentness,
        automation: { id: 'automation-old', name: 'Already saved as plain', enabled: true },
        run: { id: runId, automationId: 'automation-old', attempt: 1, leaseExpiresAt: Date.now() + 120_000, revision: 0, recipeKind: 'legacy', triggerId: null,
          cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0, resultDelivery: { kind: 'none' }, executionInputEnvelope: frozen } },
    });
    expect(kit.acceptedEnvelope()).toBeNull();
    expect(kit.rows()).toEqual([]);
    expect(sessionInput.enqueue).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: kind === 'strict classic'
      ? 'source_unavailable' : 'content_unavailable' }));
  });

  it('runs a retained encrypted source only after device review and explicit plain Workflow Save', async () => {
    const directory = await projectDirectory();
    const runId = '28282828-2828-4828-8828-282828282828';
    const retainedSessionId = 'session-old';
    let row: AutomationDefinitionDetail = { id: 'automation-retained', name: 'Retained', description: null,
      enabled: true, targetType: 'existingSession', existingSessionId: null, templateVersion: 1, lastRunAt: null,
      createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
      templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
      assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }], triggers: [] };
    const writes: AutomationDefinitionReconcileRequest[] = [];
    let retainedReads = 0;
    // The Account Automation storage and authenticated Session/key read are
    // external boundaries. Conversion, consent, sealing and Run execution are real.
    const actions = createAccountWorkflowTriggerActions({
      automations: { list: async () => ({ automations: [row], nextCursor: null }), listDetails: async () => ({ automations: [row], nextCursor: null }), get: async () => row,
        create: async () => { throw new Error('must_preserve_automation_id'); }, delete: async () => ({ ok: true as const }),
        reconcile: async (_id, input) => {
          if (input.expectedTemplateVersion !== row.templateVersion) throw Object.assign(new Error('currentness_conflict'), { code: 'currentness_conflict' });
          writes.push(input);
          row = { ...row, enabled: input.enabled, templateVersion: row.templateVersion + 1,
            ...(input.executionRecipe === undefined ? {} : { targetType: null, templateCiphertext: undefined, executionRecipe: input.executionRecipe }) };
          return row;
        } },
      resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
      resolveRetainedSession: async () => { retainedReads += 1; return { sessionId: retainedSessionId, encryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }; },
      resolveSession: async () => ({ project: { machineId, directory }, nativeGoalOwner: false, executionSelection: { agentTarget } }),
      resolveWorkflow: async () => { throw new Error('inline_source'); },
      randomBytes: length => new Uint8Array(length).fill(9), newId: () => 'unused',
    });
    expect((await actions.list({ scope: 'account_all' })).sets[0]).toMatchObject({ enabled: false,
      legacy: { lockedReason: 'review_required' } });
    expect(retainedReads).toBe(0);
    expect(writes.every(write => write.executionRecipe === undefined)).toBe(true);
    expect(row.templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
    const caller = { surface: 'cli' as const, authority: 'present_user' as const };
    const reviewed = (await actions.list({ review: true, automationId: row.id }, caller)).sets[0]!;
    if (!reviewed.target || !reviewed.project) throw new Error('review_source_unavailable');
    expect(row.executionRecipe).toBeUndefined();
    await actions.update({ automationId: row.id, expectedRevision: reviewed.revision, confirmLegacyConversion: true,
      patch: { target: reviewed.target, project: reviewed.project, enabled: true } }, caller);
    const saved = row.executionRecipe;
    if (saved?.v !== 2 || saved.workflow.t !== 'plain') throw new Error('explicit_save_did_not_write_plain_workflow');
    expect(row.id).toBe('automation-retained');
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, state: 'claimed',
      origin: { kind: 'automation', automationId: row.id } });
    const sessionInput = sessionInputBoundary({}, { sessionId: retainedSessionId });
    const claimClient = { startRun: vi.fn(), heartbeatRun: async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs, succeedRun: vi.fn(), failRun: vi.fn() };
    await executeClaimedRun({ machineId, claimClient,
      heartbeatMs: 60_000, leaseDurationMs: 120_000,
      coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory, conversationSessionId: retainedSessionId }),
      claimed: { protocol: 'v3', accountCurrentness: currentness,
        automation: { id: row.id, name: row.name, enabled: true, workflowDefinitionId: null, scopeSessionId: null },
        run: { id: runId, automationId: row.id, attempt: 1, leaseExpiresAt: Date.now() + 120_000, revision: 0, recipeKind: 'workflow-v2', triggerId: null,
          cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0, resultDelivery: { kind: 'none' },
          executionInputEnvelope: JSON.stringify(saved.workflow), automationEvidenceEnvelope: null } },
    });
    expect(sessionInput.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: retainedSessionId }));
    expect(kit.run()).toMatchObject({ state: 'succeeded', origin: { kind: 'automation', automationId: 'automation-retained' } });
    expect(claimClient.startRun).not.toHaveBeenCalled();
    expect(claimClient.failRun).not.toHaveBeenCalled();
  });
  it('reaches the same production Run owner from an Automation claim as from a direct start', async () => {
    const runId = '22222222-2222-4222-8222-222222222222';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [{ name: 'request', valueType: 'string', required: true }],
      defaults: retainedConversationDefaults(),
      blocks: [step('work', { input: [{ kind: 'input', name: 'request' }],
        document: { text: 'work', displayText: 'Scheduled check', references: [], attachments: [] } })],
      finalOutput: { kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [] },
    };
    // The Automation evidence opens through the real input binding owner
    // inside the coordinator path: this harness does not reimplement trigger
    // evidence parsing and fails closed on missing required input.
    expect(() => bindAutomationWorkflowInputs({ definition: { inputs: definition.inputs }, evidence: {} }))
      .toThrowError('missing_required_input');
    expect(bindAutomationWorkflowInputs({
      definition: { inputs: definition.inputs },
      evidence: { request: 'ship it' },
    })).toEqual({ request: 'ship it' });

    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'automation', automationId: 'automation-1' },
    });
    const sessionInput = sessionInputBoundary();
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });
    const claimClient = { startRun: vi.fn(), heartbeatRun: vi.fn(async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs), succeedRun: vi.fn(), failRun: vi.fn() };
    await executeClaimedRun({
      machineId, claimClient,
      heartbeatMs: 60_000, leaseDurationMs: 120_000, coordinateWorkflowRun: coordinate as never,
      claimed: {
        protocol: 'v3',
        accountCurrentness: currentness,
        automation: { id: 'automation-1', workflowDefinitionId: null, scopeSessionId: null },
        run: {
          id: runId,
          automationId: 'automation-1',
          attempt: 0, leaseExpiresAt: Date.now() + 120_000,
          revision: 0,
          causeWorkDepth: 0,
          origin: { kind: 'automation', automationId: 'automation-1' },
          recipeKind: 'workflow-v2',
          executionInputEnvelope: JSON.stringify({
            t: 'plain',
            v: AutomationStoredWorkflowDefinitionV2Schema.parse({
              inlineDefinition: definition, workspace: { directory }, executionTarget: { kind: 'session' },
            }),
          }),
          automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: { request: 'ship it' } }),
          cause: { kind: 'conversation', occurrenceKey: 'A'.repeat(43), occurredAt: 1 },
          triggerId: null,
        },
      } as never,
    });

    // Only the pre-root accepted-snapshot resolution distinguishes the two
    // origins; everything after it is the one Run/invocation owner.
    expect(kit.operations()[0]).toBe('accepted-snapshot.resolve');
    expect(kit.operations()).toEqual(expect.arrayContaining(['initialize', 'invocations.admit', 'transition']));
    expect(sessionInput.enqueue).toHaveBeenCalledOnce();
    expect(sessionInput.enqueue).toHaveBeenCalledWith(expect.objectContaining({ displayText: 'Scheduled check' }));
    expect(claimClient.startRun).not.toHaveBeenCalled();
    const work = rowFor(kit, 'work');
    expect(work?.lifecycle).toBe('completed');
    expect(kit.run()).toMatchObject({
      origin: { kind: 'automation', automationId: 'automation-1' },
      state: 'succeeded',
      workflowCustodyState: 'settled',
    });
  });

  it.each([['plain', false], ['e2ee', false], ['plain', true], ['e2ee', true]] as const)(
    'settles a scheduled fieldless Wait across Account cursor writes and a fresh daemon claim (%s; saved=%s)', async (mode, savedSource) => {
    const runId = '98989898-9898-4989-8989-989898989898';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'wait', id: 'approval', execution: {}, document: { text: 'Continue', references: [], attachments: [] } },
    ] };
    const scheduledFor = 1_714_000_000_000;
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerId: 'trigger-1', triggerKind: 'schedule',
      triggerRevision: 4, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: 'trigger-1',
        evidence: { v: 1, kind: 'schedule', scheduledFor } }), occurredAt: scheduledFor, evidence: { scheduledFor } });
    if (cause.kind !== 'trigger') throw new Error('schedule_cause_fixture_invalid');
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    }) : undefined;
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: currentness }
      : { kind: 'available', witness: { mode, version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material!.contentPublicKeyFingerprint) }, material: material! };
    const credentials: StoredCredentials = { token: 'token', encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(7) } };
    const definitionId = '2e17b7b7-1977-4b5b-9957-781ec43c5b54';
    let storedArtifact: Record<string, unknown> = {};
    let readClaimResponse: (() => unknown) | undefined;
    // Only opaque HTTP storage is faked: the real Artifact writer seals the
    // header/body/key, and production's saved-source resolver opens them.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (url.endsWith('/v3/automations/runs/claim')) {
        if (!readClaimResponse) throw new Error('claim_boundary_not_ready');
        return { status: 200, data: readClaimResponse() };
      }
      if (url.endsWith('/v2/sessions/lookup-by-tags')) return writeSessionReadiness(url, body);
      expect(url).toMatch(/\/v1\/artifacts$/);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('artifact_boundary_invalid_write');
      storedArtifact = { ...body, id: definitionId, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: storedArtifact };
    });
    const get = savedSource ? vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/v1/account/encryption/currentness') || /\/v2\/sessions\//.test(url)) return readSessionReadiness(url);
      if (url.endsWith(`/v1/artifacts/${definitionId}/access/recipients`)) return { status: 200,
        data: { artifactId: definitionId, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
          dataEncryptionKey: storedArtifact.dataEncryptionKey, callerDataEncryptionKey: storedArtifact.dataEncryptionKey,
          provenanceDataEncryptionKey: storedArtifact.provenanceDataEncryptionKey ?? null,
          callerProvenanceDataEncryptionKey: storedArtifact.provenanceDataEncryptionKey ?? null,
          recipients: [] } };
      expect(url).toMatch(new RegExp(`/v1/artifacts/${definitionId}$`));
      return { status: 200, data: storedArtifact };
    }) : undefined;
    try {
      if (savedSource) await createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => mode }).create({
        artifactId: definitionId, header: { kind: 'workflow-definition.v1', definitionId,
          revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved scheduled Wait' } },
        savedBy: { kind: 'person', accountId },
        body: JSON.stringify({ kind: 'workflow-definition.v1', definition }),
      });
      const kit = createWorkflowRunStorageTestkit({ runId, machineId,
        origin: { kind: 'automation', automationId: 'automation-1', cause }, state: 'claimed',
        keyCensus: { runId, ownerAccountId: accountId, access: 'owner', visibleTeamId: null, encryptionMode: mode,
          ownerAccountCurrentness: encryption.witness, dataEncryptionKey: null,
          callerDataEncryptionKey: null, recipients: [] },
      });
      const sessionInput = sessionInputBoundary();
      const payload = AutomationStoredWorkflowDefinitionV2Schema.parse({ ...(savedSource ? {} : { inlineDefinition: definition }),
        workspace: { directory }, executionTarget: { kind: 'session' } });
      const definitionEnvelope = JSON.stringify(material
        ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
          material: material.material, payload, randomBytes: (length: number) => new Uint8Array(length).fill(5) }) }
        : { t: 'plain', v: payload });
      let parentAttempt = 1;
      readClaimResponse = () => ({
        run: { id: runId, attempt: parentAttempt, leaseExpiresAt: Date.now() + 120_000, revision: kit.run().revision, automationId: 'automation-1',
          recipeKind: 'workflow-v2', executionInputEnvelope: definitionEnvelope,
          ...(kit.acceptedEnvelope() === null ? {} : { workflowAcceptedSnapshotEnvelope: kit.acceptedEnvelope() }),
          causeWorkDepth: 0, cause, automationEvidenceEnvelope: null, triggerId: cause.triggerId, triggerRetired: false },
        automation: { id: 'automation-1', name: 'Scheduled Wait', enabled: true,
          ...(savedSource ? { workflowDefinitionId: definitionId } : {}) },
        accountCurrentness: encryption.witness,
      });
      const claimClient = createAutomationClaimClient({ token: 'token', createPublisherHeader: async () => null });
      const executeClaim = async () => {
        const claimed = await claimClient.claimRun({ machineId, leaseDurationMs: 120_000 });
        if (claimed.run === null || claimed.automation === null || claimed.accountCurrentness === undefined) {
          throw new Error('claim_boundary_invalid_response');
        }
        // The Home claim response and the subsequent Account read have
        // different seq values when another publisher commits in between.
        const currentEncryption = structuredClone(encryption);
        currentEncryption.witness.version += parentAttempt;
        await executeClaimedRun({ machineId, claimClient,
          heartbeatMs: 60_000, leaseDurationMs: 120_000, claimed,
          coordinateWorkflowRun: workflowDaemonProcess({ storage: kit, sessionInput, directory, credentials, encryption: currentEncryption }),
        });
      };
      await executeClaim();
      expect(kit.run()).toMatchObject({ state: 'waiting_for_review' });
      const admittedEnvelope = kit.acceptedEnvelope();
      const resolved = resolveWorkflowRunDataKeyV1({ encryption, census: WorkflowRunRecipientCensusResponseV1Schema.parse(
        await kit.execute({ operation: 'run-key.census', runId })) });
      if (resolved.kind !== 'available') throw new Error(resolved.reason);
      const runCrypto = resolved.encryption.runCrypto;
      const held = rowFor(kit, 'approval', runCrypto)!;
      const owner = createWorkflowRunActionOwner({ resolveAccountId: async () => accountId, storage: kit,
        definitions: { get: vi.fn() }, resolveEncryption: async () => encryption });
      await owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { runId,
        invocation: { recordId: held.id }, expectedContentRevision: held.contentRevision, mode: 'use_result' },
        context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' } });
      expect(kit.run().state).toBe('queued');
      expect(openRowProgress(kit, kit.rowById(held.id)!.index, runCrypto).result).toBeUndefined();
      // The server's next machine claim changes only public parent state/cursor;
      // the restarted daemon reconstructs the same accepted snapshot and rows.
      parentAttempt += 1;
      await kit.execute({ operation: 'transition', runId, parentAttempt, expectedRevision: kit.run().revision,
        state: 'claimed', checkpointEnvelope: kit.checkpointEnvelope()! });
      await executeClaim();
      expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
      expect(kit.acceptedEnvelope()).toBe(admittedEnvelope);
      expect(kit.operations().filter(operation => operation === 'accepted-snapshot.resolve')).toHaveLength(1);
      expect(kit.rowById(held.id)?.index).toMatchObject({ lifecycle: 'completed', attempt: '0' });
      expect(kit.rows()).toHaveLength(2);
      expect(kit.resultEnvelope()).toBeNull();
      expect(sessionInput.enqueue).not.toHaveBeenCalled();
      if (savedSource) {
        const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...runCrypto,
          binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
          envelope: parseWorkflowStoredContentEnvelopeV1(kit.acceptedEnvelope()) });
        expect(accepted).toMatchObject({ kind: 'available', content: { source: { kind: 'automation', definitionId,
          revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: { kind: 'person', accountId } } } });
      }
    } finally { get?.mockRestore(); post?.mockRestore(); }
  });

  it('admits a scheduled zero-input one-prompt workflow through the canonical binder into its literal child input', async () => {
    const runId = '99999999-9999-4999-8999-999999999999';
    const directory = await projectDirectory();
    const scheduledFor = 1_714_000_000_000;
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [step('work')],
      finalOutput: { kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [] },
    };
    const cause = AutomationRunCauseSchema.parse({
      kind: 'trigger',
      triggerId: 'trigger-1',
      triggerKind: 'schedule',
      triggerRevision: 4,
      occurrenceKey: deriveAutomationOccurrenceKeyV1({
        triggerId: 'trigger-1',
        evidence: { v: 1, kind: 'schedule', scheduledFor },
      }),
      occurredAt: scheduledFor,
      evidence: { scheduledFor },
    });
    if (cause.kind !== 'trigger') throw new Error('Expected scheduled trigger cause');
    // The immutable occurrence cause retains the full schedule evidence while
    // the zero-input definition binds none of it.
    expect(cause.evidence).toEqual({ scheduledFor });

    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'automation', automationId: 'automation-1' },
    });
    const sessionInput = sessionInputBoundary();
    const coordinate = workflowDaemonProcess({ storage: kit, sessionInput, directory });
    const claimClient = { startRun: vi.fn(), heartbeatRun: vi.fn(async (request: { leaseDurationMs: number }) => Date.now() + request.leaseDurationMs), succeedRun: vi.fn(), failRun: vi.fn() };
    await executeClaimedRun({
      machineId, claimClient,
      heartbeatMs: 60_000, leaseDurationMs: 120_000, coordinateWorkflowRun: coordinate as never,
      claimed: {
        protocol: 'v3',
        accountCurrentness: currentness,
        automation: { id: 'automation-1', workflowDefinitionId: null, scopeSessionId: null },
        run: {
          id: runId,
          automationId: 'automation-1',
          attempt: 0, leaseExpiresAt: Date.now() + 120_000,
          revision: 0,
          causeWorkDepth: 0,
          origin: { kind: 'automation', automationId: 'automation-1' },
          recipeKind: 'workflow-v2',
          executionInputEnvelope: JSON.stringify({
            t: 'plain',
            v: AutomationStoredWorkflowDefinitionV2Schema.parse({
              inlineDefinition: definition, workspace: { directory }, executionTarget: { kind: 'session' },
            }),
          }),
          automationEvidenceEnvelope: null,
          cause,
          triggerId: cause.triggerId,
        },
      } as never,
    });

    expect(sessionInput.enqueue).toHaveBeenCalledOnce();
    const sentText = String(sessionInput.enqueue.mock.calls[0]?.[0]?.text ?? '');
    expect(leafLabel(sentText)).toBe('work');
    expect(sentText).not.toContain('**Workflow inputs**');
    expect(sentText).not.toContain('scheduledFor');
    const work = rowFor(kit, 'work');
    expect(work?.lifecycle).toBe('completed');
    expect(kit.run()).toMatchObject({
      origin: { kind: 'automation', automationId: 'automation-1' },
      state: 'succeeded',
      workflowCustodyState: 'settled',
    });
  });
});

describe.each(['plain', 'e2ee'] as const)('composed exact result live/recovery parity (%s)', (mode) => {
  it.each<Readonly<{ name: string; contract: WorkflowStep['result']; observed: Extract<WaitForSessionInputReplyResult, { ok: true }>['result']; valid: boolean }>>([
    { name: 'explicit pass without text', contract: { kind: 'text' }, valid: true,
      observed: { kind: 'fulfilled', outcome: { kind: 'pass' } } },
    { name: 'missing text needs attention', contract: { kind: 'text' }, valid: false,
      observed: { kind: 'terminal_no_result', reason: 'missing_final_assistant_text', usage: { inputTokens: 8 } } },
    { name: 'typed terminal-no-result needs attention', contract: { kind: 'text' }, valid: false,
      observed: { kind: 'fulfilled', outcome: { kind: 'terminal_no_result' } } },
    { name: 'exact whitespace', contract: { kind: 'text' }, valid: true,
      observed: { kind: 'final_text', text: '  answer\n', usage: { inputTokens: 8 } } },
    { name: 'strict JSON', contract: { kind: 'json', schema: { type: 'object', required: ['answer'] } }, valid: true,
      observed: { kind: 'final_text', text: '{"answer":42}', usage: { inputTokens: 8 } } },
    { name: 'invalid JSON', contract: { kind: 'json', schema: {} }, valid: false,
      observed: { kind: 'final_text', text: 'not JSON', usage: { inputTokens: 8 } } },
    { name: 'missing required decision', contract: { kind: 'decision', decisions: ['continue', 'stop'] }, valid: false,
      observed: { kind: 'fulfilled', outcome: { kind: 'pass' } } },
    { name: 'provider rejection', contract: { kind: 'text' }, valid: false,
      observed: { kind: 'failed', message: 'Provider rejected the required step input', usage: { inputTokens: 8 } } },
    ...[1_900_000_000_000, null].map(resetAtMs => ({ name: `usage-limit reset ${resetAtMs}`, contract: { kind: 'text' }, valid: false,
      observed: { kind: 'failed', message: 'Usage limit reached', runtimeIssueV1: {
        v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit', occurredAt: 100,
        usageLimit: { v: 1, resetAtMs, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
      } } } as const)),
  ])('$name commits the same exact fact before the successor can run', async ({ contract, observed, valid }) => {
    const runId = '89898989-8989-4989-8989-898989898989';
    const directory = await projectDirectory();
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    }) : undefined;
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: currentness }
      : { kind: 'available', witness: { mode, version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material!.contentPublicKeyFingerprint) }, material: material! };
    const prepared = prepareWorkflowRunDataKeyV1({ accountId, encryption,
      randomBytes: (length: number) => new Uint8Array(length).fill(3) });
    const runCrypto = prepared.runCrypto;
    const ownerEnvelope = prepared.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
    const definition: WorkflowDefinitionV1 = {
      version: 1, inputs: [], defaults: retainedConversationDefaults(),
      blocks: [step('first', { result: contract }), step('successor', {
        input: [{ kind: 'result', producer: { blockId: 'first', scope: { kind: 'current' } }, path: [] }],
      })],
    };
    const acceptedEnvelope = await sealDirectAccepted({ runId, definition, directory, runCrypto });
    const makeKit = () => createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' }, acceptedEnvelope,
      keyCensus: { runId, ownerAccountId: accountId, access: 'owner', visibleTeamId: null, encryptionMode: mode,
        ownerAccountCurrentness: encryption.witness, dataEncryptionKey: ownerEnvelope,
        callerDataEncryptionKey: ownerEnvelope, recipients: [] },
    });
    const claim = { runId, attempt: 0, expectedRevision: 0, accountCurrentness: encryption.witness, acceptedEnvelope };
    const ordinary = makeKit();
    const ordinaryBoundary = sessionInputBoundary({ first: observed });
    await expect(workflowDaemonProcess({ storage: ordinary, sessionInput: ordinaryBoundary, directory, encryption })(claim))
      .resolves.toMatchObject({ state: valid ? 'succeeded' : 'interrupted' });
    const ordinaryIndex = rowFor(ordinary, 'first', runCrypto)!;
    const ordinaryFact = openRowProgress(ordinary, ordinaryIndex, runCrypto);
    expect(ordinaryFact.replyOutcome).toEqual(observed.kind === 'fulfilled' ? observed.outcome : undefined);
    if (observed.kind === 'failed' && 'runtimeIssueV1' in observed) {
      expect(ordinaryFact.reason).toMatchObject({ code: 'session_input_failed', runtimeIssueV1: observed.runtimeIssueV1 });
    } else {
      expect(ordinaryFact.reason ?? {}).not.toHaveProperty('runtimeIssueV1');
    }
    expect(Boolean(rowFor(ordinary, 'successor', runCrypto))).toBe(valid);

    const restarted = makeKit();
    const interruptedBoundary = sessionInputBoundary({}, {
      onObserve: async () => { throw new Error('simulated_daemon_loss_after_exact_enqueue'); },
    });
    await expect(workflowDaemonProcess({ storage: restarted, sessionInput: interruptedBoundary, directory, encryption })(claim))
      .rejects.toThrow('simulated_daemon_loss_after_exact_enqueue');
    const pendingIndex = rowFor(restarted, 'first', runCrypto)!;
    const pendingFact = openRowProgress(restarted, pendingIndex, runCrypto);
    expect(pendingIndex.lifecycle).toBe('running');
    expect(rowFor(restarted, 'successor', runCrypto)).toBeUndefined();

    const observer = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId,
      observeSession: async (request) => {
        if (pendingFact.execution?.kind !== 'session') throw new Error('missing_exact_session_correspondence');
        expect(request).toMatchObject({ sessionId: pendingFact.execution.sessionId, localId: pendingFact.execution.localInputId });
        return { ok: true, sessionId, localId: request.localId, result: observed };
      },
      cancelSession: async () => { throw new Error('nonterminal_parent_must_not_cancel'); },
      actionExecutor: { execute: async () => { throw new Error('session_correspondence_must_not_use_native'); } },
    });
    await createWorkflowRunRecoveryReader({
      accountId, machineId,
      storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
        ? { candidates: [{ run: restarted.run(), parentAttempt: 0 }] } : restarted.execute(operation, options) },
      resolveAccountEncryption: async () => encryption, reconcileInvocation: observer,
    })('reconnect');
    const recoveredIndex = rowFor(restarted, 'first', runCrypto)!;
    const recoveredFact = openRowProgress(restarted, recoveredIndex, runCrypto);
    expect(recoveredIndex.id).toBe(pendingIndex.id);
    expect(recoveredIndex.lifecycle).toBe(ordinaryIndex.lifecycle);
    expect(recoveredFact.execution).toEqual(pendingFact.execution);
    expect({ result: recoveredFact.result, usage: recoveredFact.usage, reason: recoveredFact.reason, replyOutcome: recoveredFact.replyOutcome })
      .toEqual({ result: ordinaryFact.result, usage: ordinaryFact.usage, reason: ordinaryFact.reason, replyOutcome: ordinaryFact.replyOutcome });
    expect(rowFor(restarted, 'successor', runCrypto)).toBeUndefined();

    const replacementBoundary = sessionInputBoundary({ first: observed });
    await expect(workflowDaemonProcess({ storage: restarted, sessionInput: replacementBoundary, directory, encryption })({
      ...claim, expectedRevision: restarted.run().revision,
    })).resolves.toMatchObject({ state: valid ? 'succeeded' : 'interrupted' });
    expect(replacementBoundary.enqueue.mock.calls.map(([request]) => leafLabel(request.text)))
      .toEqual(valid ? ['successor'] : []);
    expect(Boolean(rowFor(restarted, 'successor', runCrypto))).toBe(valid);
  });
});

describe('composed fresh-process reconstruction over durable rows', () => {
  it.each(['cancelled', 'completed', 'failed'] as const)('answers a hold, admits concurrent holds during confirmation, then Stops and settles running lanes (%s)', async terminal => {
    const runId = '91919191-9191-4191-8191-919191919191';
    const directory = await projectDirectory();
    const wait = (id: string) => ({ kind: 'wait' as const, id,
      document: { text: id, references: [], attachments: [] }, result: { kind: 'text' as const } });
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: retainedConversationDefaults(), blocks: [
      wait('scope'), { kind: 'parallel', id: 'lanes', maxConcurrent: 2, failurePolicy: 'collect_outcomes', branches: [
        { id: 'first', blocks: [wait('first-hold'), step('active')] },
        { id: 'second', blocks: [step('prelude'), wait('late-hold')] },
        { id: 'queued', blocks: [step('queued-must-not-admit')] },
      ] }, step('must-not-admit'),
    ] };
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }) });
    const sessionInput = sessionInputBoundary();
    const claim = { runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness,
      acceptedEnvelope: kit.acceptedEnvelope()! };
    await expect(workflowDaemonProcess({ storage: kit, sessionInput, directory })(claim))
      .resolves.toMatchObject({ state: 'waiting_for_review' });
    const owner = createWorkflowRunActionOwner({ resolveAccountId: async () => accountId, storage: kit,
      definitions: { get: async () => { throw new Error('unexpected_definition_read'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
    });
    const actions = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: async () => true,
      definitions: unexpectedWorkflowDefinitions(), runs: owner });
    const answer = async (id: string) => {
      const held = rowFor(kit, id)!;
      await actions({ actionId: 'workflow.run.invocations.complete_review', input: { runId,
        invocation: { recordId: held.id }, expectedContentRevision: held.contentRevision, mode: 'use_result', value: 'Accepted' },
        context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'safe-yolo' } });
    };
    await answer('scope');
    await kit.execute({ operation: 'transition', runId, parentAttempt: 1, expectedRevision: kit.run().revision,
      state: 'claimed', checkpointEnvelope: kit.checkpointEnvelope()! });
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    };
    const preludeStarted = gate();
    const firstHoldEntered = gate();
    const releasePrelude = gate();
    const lateHoldEntered = gate();
    const confirmationStarted = gate();
    const releaseConfirmation = gate();
    const activeStarted = gate();
    const stopAccepted = gate();
    const physicallyStopped = gate();
    const controller = new AbortController();
    let refresh!: () => Promise<void>;
    let delayConfirmation = false;
    sessionInput.observe.mockImplementation(async request => {
      await request.onInputMaterialized?.(Date.now());
      if (request.localId === 'prelude') {
        preludeStarted.resolve(); await releasePrelude.promise;
        return { ok: true, sessionId, localId: request.localId, result: { kind: 'final_text', text: 'Ready' } };
      }
      activeStarted.resolve();
      if (request.signal) {
        await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
        return { ok: false, code: 'cancelled' };
      }
      await physicallyStopped.promise;
      return { ok: true, sessionId, localId: request.localId, result: terminal === 'completed'
        ? { kind: 'final_text', text: 'Finished before stopping' }
        : terminal === 'failed' ? { kind: 'failed', message: 'Provider failed before stopping' }
          : { kind: 'cancelled', message: 'Provider stopped the turn' } };
    });
    sessionInput.cancel.mockImplementation(async () => { stopAccepted.resolve(); return { kind: 'turn_cancel_requested' }; });
    const coordinate = workflowDaemonProcess({ directory, sessionInput,
      onReviewEntered: async () => {
        if (rowFor(kit, 'first-hold')) firstHoldEntered.resolve();
        if (rowFor(kit, 'late-hold')) lateHoldEntered.resolve();
      },
      storage: { execute: async (operation, options) => {
        if (delayConfirmation && operation.operation === 'invocations.get' && operation.invocationId === rowFor(kit, 'first-hold')?.id) {
          delayConfirmation = false; confirmationStarted.resolve(); await releaseConfirmation.promise;
        }
        return kit.execute(operation, options);
      } },
    });
    const running = coordinate({ ...claim, attempt: 1, expectedRevision: kit.run().revision, signal: controller.signal,
      registerReviewHoldRefresh: callback => { refresh = callback; } });
    // Attach failure observation before opening the delayed network response.
    const settled = running.then(value => ({ value }), error => ({ error }));
    await preludeStarted.promise;
    await firstHoldEntered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    delayConfirmation = true;
    const refreshing = refresh();
    const refreshed = refreshing.then(() => undefined, error => error);
    await confirmationStarted.promise;
    await answer('first-hold');
    releasePrelude.resolve();
    await lateHoldEntered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseConfirmation.resolve();
    expect(await refreshed).toBeUndefined();
    await activeStarted.promise;
    expect(kit.rows().some(row => row.index.lifecycle === 'waiting_for_capacity')).toBe(true);
    await expect(actions({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: kit.run().revision },
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'safe-yolo' } }))
      .resolves.toMatchObject({ intent: 'cancel_requested' });
    controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
    await stopAccepted.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(kit.run()).toMatchObject({ state: 'running', workflowCustodyState: 'pending' });
    physicallyStopped.resolve();
    expect(await settled).toMatchObject({ value: { state: 'cancelled' } });
    expect(kit.rows().filter(row => row.index.lifecycle === 'cancel_requested').map(row => ({
      lifecycle: row.index.lifecycle, blockKind: openRowProgress(kit, row.index).blockKind,
      blockId: openRowProgress(kit, row.index).invocationPath.blockId,
      frame: openRowProgress(kit, row.index).frame,
    }))).toEqual([]);
    expect(WorkflowRunSummaryV1Schema.parse(kit.run())).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled',
      heldCount: 0, attentionRequired: false });
    expect(rowFor(kit, 'scope')?.lifecycle).toBe('completed');
    expect(rowFor(kit, 'first-hold')?.lifecycle).toBe('completed');
    expect(rowFor(kit, 'late-hold')?.lifecycle).toBe('cancelled');
    expect(rowFor(kit, 'active')?.lifecycle).toBe(terminal);
    expect(rowFor(kit, 'must-not-admit')).toBeUndefined();
    expect(rowFor(kit, 'queued-must-not-admit')).toBeUndefined();
  });

  it('advances and settles a claimed Wait parent from its completed human leaf without an Agent input', async () => {
    const runId = '81818181-8181-4181-8181-818181818181';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{
      kind: 'wait', id: 'confirm', document: { text: 'Confirm', references: [], attachments: [] },
      result: { kind: 'json', schema: { type: 'object', properties: { confirmed: { type: 'boolean' } },
        required: ['confirmed'], additionalProperties: false } },
    }] };
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }) });
    const sessionInput = sessionInputBoundary();
    const claim = { runId, attempt: 0, expectedRevision: 0, accountCurrentness: currentness,
      acceptedEnvelope: kit.acceptedEnvelope()! };
    await expect(workflowDaemonProcess({ storage: kit, sessionInput, directory })(claim))
      .resolves.toMatchObject({ state: 'waiting_for_review' });
    const held = rowFor(kit, 'confirm')!;
    const runOwner = createWorkflowRunActionOwner({
      resolveAccountId: async () => accountId, storage: kit, definitions: { get: async () => { throw new Error('unexpected_definition_read'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
    });
    const actions = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: async () => true,
      definitions: unexpectedWorkflowDefinitions(), runs: runOwner });
    await expect(actions({ actionId: 'workflow.run.invocations.complete_review',
      input: { runId, invocation: { recordId: held.id },
        expectedContentRevision: held.contentRevision, mode: 'use_result', value: { confirmed: true } },
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'safe-yolo' },
    })).resolves.toMatchObject({ disposition: 'completed', run: { state: 'queued' },
      invocation: { id: held.id, lifecycle: 'completed' } });
    expect(rowFor(kit, 'confirm')).toMatchObject({ id: held.id, lifecycle: 'completed' });
    expect(openRowProgress(kit, rowFor(kit, 'confirm')!).result).toEqual({ confirmed: true });
    // The claim service changes queued to claimed before handing the same
    // accepted snapshot to a replacement coordinator; this is storage state.
    await kit.execute({ operation: 'transition', runId, parentAttempt: 1,
      expectedRevision: kit.run().revision, state: 'claimed', checkpointEnvelope: kit.checkpointEnvelope()! });
    await expect(workflowDaemonProcess({ storage: kit, sessionInput, directory })({ ...claim,
      attempt: 1, expectedRevision: kit.run().revision })).resolves.toEqual({ state: 'succeeded' });
    expect(kit.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
    expect(openRowProgress(kit, kit.rows().find(row => row.index.parentRecordId === null)!.index).stepProgress)
      .toMatchObject({ completed: 1, total: 1 });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(kit.checkpointEnvelope()!),
    })).toMatchObject({ kind: 'available', content: { frontier: { nextBlockOrdinal: 1 }, nextSequence: '2' } });
    expect(sessionInput.enqueue).not.toHaveBeenCalled();
    expect(sessionInput.observe).not.toHaveBeenCalled();
  });

  it.each([
    {
      failurePolicy: 'collect_outcomes' as const,
      expected: { state: 'succeeded', completedWithFailures: true },
      terminalState: 'succeeded',
    },
    {
      failurePolicy: 'fail_stop' as const,
      expected: { state: 'interrupted', reason: 'session_input_failed' },
      terminalState: 'interrupted',
    },
  ])(
    'recomputes the same $failurePolicy outcome from persisted rows after the daemon is replaced',
    async ({ failurePolicy, expected, terminalState }) => {
      const runId = '33333333-3333-4333-8333-333333333333';
      const directory = await projectDirectory();
      const definition = fanOutDefinition(failurePolicy);
      const kit = createWorkflowRunStorageTestkit({
        runId, machineId, origin: { kind: 'direct' },
        acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
      });

      const first = sessionInputBoundary({ bad: 'failed' });
      const lossy = storageLosingFirstSettlement(kit);
      const claim = {
        runId, attempt: 0, expectedRevision: kit.run().revision,
        accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
      };
      await expect(workflowDaemonProcess({ storage: lossy, sessionInput: first, directory })(claim as never))
        .rejects.toThrowError('simulated_daemon_loss_before_settlement');
      expect(lossy.settlementWasLost()).toBe(true);
      expect(first.enqueue.mock.calls.map(([request]) => leafLabel(request.text)))
        .not.toContain('must-not-run');
      // Nothing about the outcome survives in this process: the parent never
      // settled and the next process starts with no materialized container.
      // Under `collect_outcomes` the container itself is durably settled, so
      // reconstruction must recompute its ordered outcomes without moving a
      // terminal row back to `running` — a transition the server's invocation
      // CAS refuses and the testkit reproduces.
      expect(kit.run().state).toBe('running');
      expect(rowFor(kit, 'fan')?.lifecycle)
        .toBe(failurePolicy === 'collect_outcomes' ? 'completed' : 'needs_attention');

      const second = sessionInputBoundary();
      const replacement = workflowDaemonProcess({ storage: kit, sessionInput: second, directory });
      await expect(replacement({ ...claim, expectedRevision: kit.run().revision } as never))
        .resolves.toMatchObject(expected);
      expect(second.enqueue).not.toHaveBeenCalled();
      expect(second.observe).not.toHaveBeenCalled();
      expect(kit.run().state).toBe(terminalState);
      expect(rowFor(kit, 'bad')?.lifecycle).toBe('failed');
      expect(rowFor(kit, 'must-not-run')).toBeUndefined();
    },
  );

  it('rebinds a loop source and its durable frontier to persisted producer rows in a replacement process', async () => {
    const runId = '44444444-4444-4444-8444-444444444444';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [
        step('seed', { result: { kind: 'json', schema: { type: 'number' } } }),
        {
          kind: 'loop',
          id: 'counted',
          repetition: {
            kind: 'count',
            count: { kind: 'result', producer: { blockId: 'seed', scope: { kind: 'current' } }, path: [] },
          },
          body: [step('work')],
        },
      ],
      finalOutput: { kind: 'result', producer: { blockId: 'counted', scope: { kind: 'current' } }, path: [] },
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });
    const seeded = sessionInputBoundary();
    // `seed` declares a numeric result contract, so the Session leaf must
    // return the exact decodable text the loop count resolves from.
    seeded.observe.mockImplementation(async (request: Readonly<{ localId: string }>) => ({
      ok: true as const, sessionId, localId: request.localId,
      result: { kind: 'final_text' as const, text: request.localId === 'seed' ? '3' : request.localId },
    }));
    // Lose the daemon between the loop's three iterations: `seed` and the first
    // `work` are durable, the loop frontier has advanced, and nothing about
    // the resolved count or the previous iteration survives in memory.
    let settled = 0;
    let crashed = false;
    const lossy = {
      execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
        if (String(operation.operation) === 'invocations.admit' && settled >= 2 && !crashed) {
          crashed = true;
          throw new Error('simulated_daemon_loss_mid_loop');
        }
        const result = await kit.execute(operation, options);
        if (String(operation.operation) === 'invocations.fact' && String(operation.lifecycle) === 'completed') settled += 1;
        return result;
      },
    };
    const claim = {
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    };
    await expect(workflowDaemonProcess({ storage: lossy, sessionInput: seeded, directory })(claim as never))
      .rejects.toThrowError('simulated_daemon_loss_mid_loop');
    expect(seeded.enqueue.mock.calls.map(([request]) => leafLabel(request.text))).toEqual(['seed', 'work']);
    const loopRow = rowFor(kit, 'counted');
    expect(openRowProgress(kit, loopRow!).container).toMatchObject({
      kind: 'loop', mode: 'count', count: '3', nextMemberIndex: '1',
    });

    const replacement = sessionInputBoundary();
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: replacement, directory })({
      ...claim, expectedRevision: kit.run().revision,
    } as never)).resolves.toMatchObject({
      state: 'succeeded',
      finalOutput: [{ work: 'work' }, { work: 'work' }, { work: 'work' }],
    });
    // The replacement resolves the count from the persisted `seed` row rather
    // than a rescanned name, replays nothing, and runs only iteration one.
    expect(replacement.enqueue.mock.calls.map(([request]) => leafLabel(request.text))).toEqual(['work', 'work']);
    expect(kit.run().state).toBe('succeeded');

    const completedRestart = sessionInputBoundary();
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: completedRestart, directory })({
      ...claim, expectedRevision: kit.run().revision,
    } as never)).resolves.toMatchObject({
      state: 'succeeded',
      finalOutput: [{ work: 'work' }, { work: 'work' }, { work: 'work' }],
    });
    expect(completedRestart.enqueue).not.toHaveBeenCalled();
  });

  it('reconstructs all prior evaluator outcomes through the production store without replaying evaluator turns', async () => {
    const runId = '55555555-5555-4555-8555-555555555555';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [{
        kind: 'loop', id: 'judged',
        repetition: {
          kind: 'evaluate', maxIterations: 3, history: 'all',
          evaluator: step('evaluate', {
            result: { kind: 'decision', decisions: ['continue', 'stop'] },
          }),
        },
        body: [step('body')],
      }],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });
    const first = sessionInputBoundary();
    let bodyObservations = 0;
    first.observe.mockImplementation(async (request: Readonly<{ localId: string }>) => {
      if (request.localId === 'body') {
        bodyObservations += 1;
        if (bodyObservations === 3) throw new Error('simulated_daemon_loss_before_third_evaluator');
        return {
          ok: true as const, sessionId, localId: request.localId,
          result: { kind: 'final_text' as const, text: 'body-result' },
        };
      }
      return {
        ok: true as const, sessionId, localId: request.localId,
        result: { kind: 'final_text' as const, text: JSON.stringify('continue') },
      };
    });
    const claim = {
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    };
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: first, directory })(claim as never))
      .rejects.toThrowError('simulated_daemon_loss_before_third_evaluator');

    const replacement = sessionInputBoundary();
    replacement.observe.mockImplementation(async (request: Readonly<{ localId: string }>) => ({
      ok: true as const, sessionId, localId: request.localId,
      result: {
        kind: 'final_text' as const,
        text: request.localId === 'evaluate' ? JSON.stringify('stop') : 'body-result',
      },
    }));
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: replacement, directory })({
      ...claim, expectedRevision: kit.run().revision,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });

    const evaluatorInputs = kit.rows()
      .map(({ index }) => openRowProgress(kit, index))
      .filter((progress) => progress.invocationPath.blockId === 'evaluate')
      .sort((left, right) => {
        const leftIndex = left.invocationPath.scope.find((part) => part.kind === 'iteration')?.index ?? 0;
        const rightIndex = right.invocationPath.scope.find((part) => part.kind === 'iteration')?.index ?? 0;
        return leftIndex - rightIndex;
      })
      .map((progress) => isWorkflowJsonObject(progress.input) && Array.isArray(progress.input.input)
        ? progress.input.input
        : []);
    expect(evaluatorInputs).toEqual([
      [],
      [{ kind: 'evaluation_history', evaluations: ['continue'] }],
      [{ kind: 'evaluation_history', evaluations: ['continue', 'continue'] }],
    ]);

    const completedRestart = sessionInputBoundary();
    await expect(workflowDaemonProcess({ storage: kit, sessionInput: completedRestart, directory })({
      ...claim, expectedRevision: kit.run().revision,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });
    expect(completedRestart.enqueue).not.toHaveBeenCalled();
  });
});

describe('composed boundary pause across admitted siblings', () => {
  it('drains an already admitted fail-stop sibling instead of aborting it when pause closes the next admission', async () => {
    const runId = '55555555-5555-4555-8555-555555555555';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [{
        kind: 'parallel',
        id: 'fan',
        failurePolicy: 'fail_stop',
        branches: [
          { id: 'slow', blocks: [step('slow-1')] },
          { id: 'quick', blocks: [step('quick-1'), step('quick-2')] },
        ],
      }],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });

    let releaseSlow!: () => void;
    const slowSettles = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let markSlowAdmitted!: () => void;
    const slowAdmitted = new Promise<void>((resolve) => { markSlowAdmitted = resolve; });
    let slowAborted = false;
    const sessionInput = sessionInputBoundary({}, {
      onObserve: async (label, signal) => {
        // Pause tests an already admitted sibling, not competing preparation.
        if (label === 'quick-1') await slowAdmitted;
        if (label !== 'slow-1') return;
        markSlowAdmitted();
        signal?.addEventListener('abort', () => { slowAborted = true; });
        await slowSettles;
      },
    });

    let pauseRequested = false;
    const storage = {
      execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
        if (!pauseRequested && String(operation.operation) === 'invocations.fact' && String(operation.lifecycle) === 'completed') {
          // `quick-1` is the only leaf that can settle while `slow-1` is gated.
          pauseRequested = true;
          const committed = await kit.execute(operation, options);
          kit.requestControl('pause_requested');
          return committed;
        }
        const result = await kit.execute(operation, options);
        // Release the admitted sibling only once the coordinator has actually
        // observed the pause at the next admission boundary.
        if (pauseRequested && String(operation.operation) === 'get') setTimeout(releaseSlow, 0);
        return result;
      },
    };

    await expect(workflowDaemonProcess({ storage, sessionInput, directory })({
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    } as never)).resolves.toMatchObject({ state: 'paused' });

    expect(slowAborted).toBe(false);
    expect(rowFor(kit, 'slow-1')?.lifecycle).toBe('completed');
    expect(rowFor(kit, 'quick-1')?.lifecycle).toBe('completed');
    expect(rowFor(kit, 'quick-2')).toBeUndefined();
    expect(kit.run().state).toBe('paused');
  });
});

describe('composed durable rows carry no fabricated defaults', () => {
  it('admits omitted-concurrency siblings together and persists no capacity wait or observation deadline', async () => {
    const runId = '66666666-6666-4666-8666-666666666666';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [{
        kind: 'parallel',
        id: 'fan',
        failurePolicy: 'collect_outcomes',
        branches: [
          { id: 'left', blocks: [step('left-1')] },
          { id: 'right', blocks: [step('right-1')] },
        ],
      }],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });
    // Neither sibling may settle before both are admitted. A fabricated
    // concurrency fallback of one would deadlock this gate rather than merely
    // reordering work.
    let admitted = 0;
    let releaseBoth!: () => void;
    const bothAdmitted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const sessionInput = sessionInputBoundary({}, {
      onObserve: async () => {
        admitted += 1;
        if (admitted >= 2) releaseBoth();
        await bothAdmitted;
      },
    });
    const lifecycles: string[] = [];
    const storage = {
      execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
        if (typeof operation.lifecycle === 'string') lifecycles.push(operation.lifecycle);
        return await kit.execute(operation, options);
      },
    };
    await expect(workflowDaemonProcess({ storage, sessionInput, directory })({
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });
    expect(admitted).toBe(2);
    expect(lifecycles).not.toContain('waiting_for_capacity');
    for (const row of kit.rows()) {
      expect(openRowProgress(kit, row.index).observationDeadline).toBeUndefined();
    }
  }, 20_000);

  it('queues only an authored container limit and persists one absolute deadline only for an authored timeout', async () => {
    const runId = '77777777-7777-4777-8777-777777777777';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [{
        kind: 'parallel',
        id: 'fan',
        failurePolicy: 'collect_outcomes',
        maxConcurrent: 1,
        branches: [
          { id: 'first', blocks: [step('untimed')] },
          { id: 'second', blocks: [step('timed', { timeoutMs: 60_000 })] },
        ],
      }],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
    });
    const lifecycles: string[] = [];
    const storage = {
      execute: async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
        if (typeof operation.lifecycle === 'string') lifecycles.push(operation.lifecycle);
        return await kit.execute(operation, options);
      },
    };
    await expect(workflowDaemonProcess({ storage, sessionInput: sessionInputBoundary(), directory })({
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    } as never)).resolves.toMatchObject({ state: 'succeeded' });
    expect(lifecycles).toContain('waiting_for_capacity');
    expect(openRowProgress(kit, rowFor(kit, 'untimed')!).observationDeadline).toBeUndefined();
    expect(openRowProgress(kit, rowFor(kit, 'timed')!).observationDeadline).toMatchObject({ kind: 'at' });
  });
});

describe('composed off-page child attention discovery', () => {
  it('finds a nested attention row beyond the first page and opens its private progress at the Action host', async () => {
    const runId = '88888888-8888-4888-8888-888888888888';
    const directory = await projectDirectory();
    const definition: WorkflowDefinitionV1 = {
      version: 1,
      inputs: [],
      defaults: retainedConversationDefaults(),
      blocks: [
        step('opening'),
        {
          kind: 'parallel',
          id: 'fan',
          failurePolicy: 'collect_outcomes',
          branches: [{ id: 'stuck', blocks: [step('awaiting-human')] }],
        },
      ],
    };
    const kit = createWorkflowRunStorageTestkit({
      runId, machineId, origin: { kind: 'direct' },
      acceptedEnvelope: await sealDirectAccepted({ runId, definition, directory }),
      // One row per page, so the nested attention row cannot be on page one.
      invocationPageSize: 1,
    });
    const lossy = storageLosingFirstSettlement(kit);
    await expect(workflowDaemonProcess({
      storage: lossy,
      sessionInput: sessionInputBoundary({ 'awaiting-human': 'needs_attention' }),
      directory,
    })({
      runId, attempt: 0, expectedRevision: kit.run().revision,
      accountCurrentness: currentness, acceptedEnvelope: kit.acceptedEnvelope()!,
    } as never)).rejects.toThrowError('simulated_daemon_loss_before_settlement');
    // The parent never settled, so the actionable child row — not a parent
    // state — is the only attention signal available to an observer.
    expect(kit.run().state).toBe('running');

    const runOwner = createWorkflowRunActionOwner({
      resolveAccountId: async () => accountId,
      storage: kit,
      definitions: { get: vi.fn() },
      resolveEncryption: async () => ({ kind: 'available', witness: currentness }),
      prepareWorkspace: async () => ({
        ok: true,
        workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } },
      }),
    });
    const workflowActions = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      definitions: unexpectedWorkflowDefinitions(),
      runs: runOwner,
    });
    const context = { surface: 'rpc' as const, authority: 'account_automation' as const };
    const invoke = async (actionId: string, input: unknown) => await workflowActions({ actionId, input, context } as never);

    type InvocationDetail = Readonly<{
      invocation: Readonly<{ progress: Readonly<{ invocationPath: Readonly<{ blockId: string; scope: readonly unknown[] }> }> }>;
    }>;
    let cursor: string | undefined;
    let pages = 0;
    let attentionPage = 0;
    let attention: InvocationDetail | undefined;
    do {
      const page = await invoke('workflow.run.invocations.list', {
        runId, lifecycles: ['waiting_for_approval', 'needs_attention', 'cancel_requested', 'outcome_uncertain'],
        ...(cursor ? { cursor } : {}),
      }) as Readonly<{ invocations: readonly WorkflowRunInvocationIndexV1[]; nextCursor?: string }>;
      pages += 1;
      for (const index of page.invocations) {
        // Exact private detail is opened only at the authorized Action host;
        // the server page carries structural index columns alone.
        const detail = await invoke('workflow.run.invocations.get', { runId, invocationId: index.id }) as InvocationDetail;
        if (detail.invocation.progress.invocationPath.blockId !== 'awaiting-human') continue;
        attention = detail;
        attentionPage = pages;
      }
      cursor = page.nextCursor;
    } while (cursor && !attention);
    expect(attention).toBeDefined();
    expect(attentionPage).toBeGreaterThan(1);
    expect(attention!.invocation.progress.invocationPath).toMatchObject({
      blockId: 'awaiting-human',
      scope: [{ kind: 'branch', blockId: 'fan', branchId: 'stuck' }],
    });

    // The server's indexed actionable predicate is owned and proven by
    // `workflowRunService.integration.spec.ts`; this asserts the composed CLI
    // path surfaces it instead of waiting out the caller's deadline.
    await expect(invoke('workflow.run.wait', { runId, timeoutSeconds: 1 }))
      .resolves.toMatchObject({ observation: 'needs_attention' });
  });
});

describe('composed Git workspace through the canonical SCM owner', () => {
  it('uses canonical path normalization and exercises shared plus revision-pinned worktree modes without force-removal', async () => {
    // Cross-platform path normalization stays with the canonical owner. No
    // test-only path helper is introduced here.
    await expect(prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId, directory: '~/repo/packages/app' },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [step('only')] },
      env: { NODE_ENV: 'test', HOME: '/Users/alice' },
      platform: 'darwin',
      pathIsDirectory: async (path) => path === '/Users/alice/repo/packages/app',
      inspectLocation: async () => ({ inspection: { rootPath: '/Users/alice/repo' } }),
    })).resolves.toMatchObject({
      ok: true,
      workspaceTarget: { project: { directory: '/Users/alice/repo/packages/app', checkoutRootPath: '/Users/alice/repo' } },
    });
    expect(normalizeWorkflowProjectTarget({
      projectTarget: { machineId, directory: 'C:\\Users\\alice2\\repo' },
      env: { NODE_ENV: 'test', USERPROFILE: 'C:\\Users\\alice' },
      platform: 'win32',
    })).toMatchObject({ directory: 'C:\\Users\\alice2\\repo' });

    const execFileAsync = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), 'happier-composed-workspace-'));
    const git = createGitWorkflowWorkspaceTestDependencies();
    try {
      const directory = join(root, 'packages', 'app');
      await mkdir(directory, { recursive: true });
      await writeFile(join(root, 'README.md'), 'original\n', 'utf8');
      await writeFile(join(directory, 'index.ts'), 'export const fixture = true;\n', 'utf8');
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: root });
      await execFileAsync('git', ['add', 'README.md', 'packages/app/index.ts'], { cwd: root });
      await execFileAsync('git', [
        '-c', 'user.name=Workflow Test',
        '-c', 'user.email=workflow-test@example.invalid',
        'commit', '-m', 'test: seed composed workspace',
      ], { cwd: root });
      const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      await writeFile(join(root, 'README.md'), 'unstaged-after-staged\n', 'utf8');
      await writeFile(join(root, 'untracked.txt'), 'untracked\n', 'utf8');
      const dirtyStatus = (await execFileAsync('git', ['status', '--short'], { cwd: root })).stdout;
      expect(dirtyStatus).not.toBe('');

      const projectWorkspace = { machineId, directory, checkoutRootPath: root };
      // Shared checkout reuses the exact dirty source through the real SCM
      // owner. There is no reset, merge, commit, or force-removal here.
      const shared = await resolveWorkflowWorkspace({
        selection: { kind: 'project_checkout' },
        defaultSelection: { kind: 'project_checkout' },
        projectWorkspace,
        runId: 'run-composed-git',
        logicalInvocationRecordId: 'shared',
        deps: {},
      });
      expect(shared).toEqual({ ok: true, workspace: projectWorkspace });

      const created = await resolveWorkflowWorkspace({
        selection: { kind: 'new_worktree', source: { kind: 'workflow' } },
        defaultSelection: { kind: 'project_checkout' },
        projectWorkspace,
        runId: 'run-composed-git',
        logicalInvocationRecordId: 'isolated',
        deps: git,
      });
      expect(created).toMatchObject({
        ok: true,
        workspace: { machineId, checkout: { kind: 'git_worktree' } },
      });
      if (!created.ok) throw new Error(created.code);
      expect(created.workspace.checkoutRootPath).not.toBe(root);
      expect(created.workspace.directory).toBe(join(created.workspace.checkoutRootPath, 'packages', 'app'));
      // A workflow fork is committed-only: dirty and untracked source state
      // stays at the source and never enters the new worktree.
      expect(await readFile(join(created.workspace.checkoutRootPath, 'README.md'), 'utf8')).toBe('original\n');
      await expect(readFile(join(created.workspace.checkoutRootPath, 'untracked.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: created.workspace.checkoutRootPath })).stdout.trim()).toBe(revision);
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('unstaged-after-staged\n');

      // The coordinator row-local resolver binds from-step scope through the
      // same durable store owner used by execution.
      const store = createInMemoryWorkflowCoordinatorStore();
      const sourceKey = workflowInvocationKey({ runId: 'run-composed-git', blockId: 'a', scope: [], attempt: 0 });
      await store.ensureIntent({ key: sourceKey, recordId: 'inv-a', runId: 'run-composed-git', blockKind: 'step', blockId: 'a', memberOrdinal: '0', path: { blockId: 'a', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'completed', workspace: { descriptor: projectWorkspace } });
      const targetKey = workflowInvocationKey({ runId: 'run-composed-git', blockId: 'b', scope: [], attempt: 0 });
      const target = await store.ensureIntent({ key: targetKey, recordId: 'inv-b', runId: 'run-composed-git', blockKind: 'step', blockId: 'b', memberOrdinal: '1', path: { blockId: 'b', scope: [] }, attempt: 0, acceptedAtMs: 2, lifecycle: 'admitting' });
      const resolver = createCoordinatorWorkspaceResolver({
        store,
        projectWorkspace,
        scm: { verifyRecordedWorkspace: async () => 'available' as const },
      });
      await expect(resolver({
        runId: 'run-composed-git',
        definition: { version: 1, inputs: [], defaults: {}, blocks: [step('b')] },
        step: { id: 'b', execution: { workspace: { kind: 'from_step', producer: { blockId: 'a', scope: { kind: 'current' } } } } },
        invocation: target,
        scope: [],
        producerBinding: createWorkflowProducerBinding({ runId: 'run-composed-git', store,
          frame: { scope: [], blocks: [step('a'), step('b')] } }),
      })).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('composed Session approvals and observation deadlines', () => {
  it('passes permission ceilings and authored timeouts through canonical Session owners', async () => {
    const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' } as const;
    const executionTarget = { kind: 'session' } as const;
    // A broader step permission than the immutable admitted ceiling is
    // rejected by the canonical Session leaf before any Session mutation.
    const deniedPrepare = vi.fn();
    const deniedEnqueue = vi.fn();
    const denied = createWorkflowSessionStepExecutor({
      credentials: { token: 'token' } as never,

      prepareConversation: deniedPrepare,
      materializeConversation: vi.fn(),
      sessionInput: { enqueue: deniedEnqueue, observe: vi.fn(), cancel: vi.fn() },
    });
    await expect(denied({
      runId: 'run-approvals',
      step: {},
      invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { permissionMode: 'safe-yolo' },
      authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } },
      workspace,
      onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'failed', code: 'workflow_permission_escalation_denied' });
    expect(deniedPrepare).not.toHaveBeenCalled();
    expect(deniedEnqueue).not.toHaveBeenCalled();

    // Omitted timeoutMs means no authored observation deadline through the
    // real coordinator plus the real Session leaf. A present timeout persists
    // one absolute deadline. Neither path invents a numeric fallback.
    const store = createInMemoryWorkflowCoordinatorStore();
    const observedDeadlines: Array<unknown> = [];
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const observe = vi.fn(async (input: Parameters<typeof import('./stepExecution').observeWorkflowSessionInputResult>[0]) => {
      const acceptedAtMs = Date.now();
      await input.onInputMaterialized?.(acceptedAtMs);
      // An initial observation derives its deadline from the persisted input;
      // a reobservation receives the already frozen absolute deadline instead.
      observedDeadlines.push(input.deadlineMs ?? (input.timeoutAfterInputMs === undefined
        ? undefined : acceptedAtMs + input.timeoutAfterInputMs));
      return { ok: true as const, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text' as const, text: 'done' } };
    });
    const sessionOwner = createWorkflowSessionStepExecutor({
      credentials: { token: 'token' } as never,

      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue: enqueue as never,
        observe: observe as never,
        cancel: vi.fn() as never,
      },
    });
    const coordinator = createWorkflowCoordinator({
      isAcceptedAuthorizationCurrent: async () => true,
      store,
      executeStep: sessionOwner,
      resolveWorkspace: async () => ({ ok: true as const, workspace }),
    });
    const definition = {
      version: 1 as const,
      inputs: [],
      defaults: { agentTarget },
      blocks: [
        step('no-timeout'),
        step('with-timeout', { timeoutMs: 60_000 }),
      ],
    };
    await expect(coordinator.run({ runId: 'run-deadlines', definition, inputs: {}, executionTarget, authorization }))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observedDeadlines[0]).toBeUndefined();
    expect(typeof observedDeadlines[1]).toBe('number');
  });
});

describe('composed practical large Run without invented limits', () => {
  it('advances 500 ordered duplicate-preserving items through the real coordinator with bounded resources', async () => {
    const runId = '99999999-9999-4999-8999-999999999999';
    const store = createInMemoryWorkflowCoordinatorStore();
    const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' } as const;
    const executionTarget = { kind: 'session' } as const;
    // 50 practical file names repeated 10 times preserve order and
    // duplicates. This fixture proves no item/invocation quota rejects a
    // valid large Run; it does not add a product limit or timeout.
    const files = Array.from({ length: 500 }, (_, index) => `src/file-${index % 50}.ts`);
    const seen: string[] = [];
    const coordinator = createWorkflowCoordinator({
      isAcceptedAuthorizationCurrent: async () => true,
      store,
      executeStep: async ({ step: current, item }) => {
        seen.push(String(item?.value));
        return { kind: 'completed' as const, result: String(item?.value ?? current.id) };
      },
      resolveWorkspace: async () => ({ ok: true as const, workspace }),
    });
    const definition = {
      version: 1 as const,
      inputs: [],
      defaults: { agentTarget },
      blocks: [{
        kind: 'loop' as const,
        id: 'files',
        repetition: {
          kind: 'items' as const,
          items: { kind: 'literal' as const, value: files },
          execution: 'sequential' as const,
          failurePolicy: 'collect_outcomes' as const,
        },
        body: [step('process', { input: [{ kind: 'item', field: 'value' }] })],
      }],
    };
    await expect(coordinator.run({ runId, definition, inputs: {}, executionTarget, authorization }))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(seen).toEqual(files);
    const processed = [...store.records.values()].filter((record) => record.blockId === 'process');
    expect(processed).toHaveLength(500);
    expect(processed.map((record) => record.result)).toEqual(files);
  }, 20_000);
});
