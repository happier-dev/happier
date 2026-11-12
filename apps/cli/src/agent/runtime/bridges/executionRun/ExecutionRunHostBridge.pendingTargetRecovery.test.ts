import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { z } from 'zod/mini';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { signExternalActionApprovalInputV1, verifyScmRefineSavedSessionV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import fastify from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, reloadConfiguration } from '@/configuration';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { updateSettings, type StoredCredentials } from '@/persistence';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

import type { ExecutionRunState } from './executionRunTypes';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { projectExecutionRunSessionUpdateState } from './publicState';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createEmptyBackendExecutionSurfaces, type EngineAdapterResolution } from '@/agent/runtime/registry/engineRegistryTypes';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { projectEngineRuntimeContributionFromAgent } from '@/agent/runtime/registry/engineRegistry/contributions';
import { createNativeAgentSessionInteractionHostRuntime } from './nativeAgentExecutionRun';
import { createLazyExecutionRunHostRuntime } from './hostRuntime/lazy';
import { createNativeSessionBoundary, createVoiceSessionContextLease, createVoiceSessionRuntimeThroughNativeFactory } from './testkit/nativeSessionContext';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildReviewEngineInventoryItems } from '@/session/actions/inventory/buildReviewEngineInventoryItems';
import type { ExecutionRunAdmittedPendingInputV1, ExecutionRunPendingInputBinding } from '@/api/session/client/transport/sessionClientInteractionApi';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import { ScmComparisonSchema, SessionInputAdmissionResultV1Schema, ScmDiffSummaryRefineInputSchema, ExecutionRunGetResponseSchema,
  type SessionInputAdmissionResultV1, type ScmActionExecute } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';
import { readMessageDisplayText } from '@happier-dev/session-core/messages';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { EphemeralUpdateSchema } from '@happier-dev/protocol/updates';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { ReviewProfile } from '@/agent/executionRuns/profiles/review/ReviewProfile';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutionRunRoleV1 } from '@/agent/executionRuns/profiles/review/reviewRole';
import { createExecutionRunRpcActionDeps } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createRetainedPendingHome } from './testkit/retainedPendingHome';
import type { SessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { decodeBase64, decrypt, encodeBase64, encryptLegacy } from '@/api/encryption';
import { UserMessageSchema } from '@/api/types';
import { createActionExecutor, ExternalActionRequestEnvelopeV2Schema, openExternalActionRequestV2, prepareExternalActionResponseV2,
  type ActionExecutorContext } from '@happier-dev/protocol';
import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeExternalActionRequestEnvelopeDigestV1, decodeExternalActionResolvedTargetV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions';
import { encryptSessionPayload, decryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { ReviewWalkthroughResponseSchema } from '@happier-dev/protocol/reviews/reviewNarration';
import { readRetainedExecutionRunRecords, reconcileRetainedExecutionRunRecords } from '@/daemon/executionRunRegistry';
import { restartSessionRunnerOnCurrentRuntime } from '@/daemon/plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import { requestConnectedServiceSessionRestartSignal } from '@/daemon/connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import type { TrackedSession } from '@/daemon/types';
import { runSessionLoopLifecycle } from '@/agent/runtime/session/loop/lifecycle';
import { createLifecycleParams } from '@/agent/runtime/session/loop/lifecycle.testkit';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import { commitRuntimeSessionEvent } from '@/agent/runtime/session/transcripts/publishRuntimeSessionEvent';
import { createHostWorkerUpdatePublication } from '@/agent/runtime/session/contextOnly/hostWorkerUpdatePublication';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { ApiMachineClient } from '@/api/apiMachine';
import * as installationIdentity from '@/daemon/identity/store';
import { createPlainSessionFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createSocketTransportAdapter, socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import * as sessionSockets from '@/api/session/sockets';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { SessionMessageContent } from '@/api/types';
import { SessionPendingExecutionRunEnqueueByMachineRequestV2Schema, SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2,
} from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';

const nativeOpen = vi.hoisted(() => vi.fn<(request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>>());
const nativeModule = vi.hoisted(() => ({ ready: undefined as Promise<void> | undefined }));
const retainedReadFailure = vi.hoisted(() => ({ armed: false, failed: false }));
const requestRunMaterialization = vi.hoisted(() => vi.fn<typeof import('@/daemon/controlClient')['requestExecutionRunConnectedServicesMaterialization']>());
let nativeComposedSession: ApiSessionClient | undefined;

// The runner-to-daemon transport is the boundary; selection and resume stay real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestExecutionRunConnectedServicesMaterialization: requestRunMaterialization,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: async (...args: Parameters<typeof actual.readdir>) => {
    if (retainedReadFailure.armed && !retainedReadFailure.failed
      && String(args[0]).endsWith('daemon-execution-runs')) {
      retainedReadFailure.failed = true;
      throw Object.assign(new Error('Transient retained-state read failure'), { code: 'EIO' });
    }
    return actual.readdir(...args);
  } };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

vi.mock('./createExecutionRunBridgeRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./createExecutionRunBridgeRuntime')>();
  return {
    createExecutionRunBridgeRuntime: (options: Parameters<typeof actual.createExecutionRunBridgeRuntime>[0]) => createLazyExecutionRunHostRuntime({
      resolveRuntime: async () => {
        await nativeModule.ready;
        const registry = options.engineRegistry ?? await resolveCliEngineRegistry();
        // The external Agent factory supplies native open/send. Keep the real
        // launch owner, including model/configuration and credential assembly.
        const agent: EngineAdapterResolution['agent'] = {
          id: options.backendId, provenance: 'external', source: { kind: 'path' },
          definition: { kindVersion: 1, id: options.backendId, ownedBackendIds: [] },
        };
        const resolveNativeEngine = async (): Promise<EngineAdapterResolution> => ({
          backendId: options.backendId, agentId: options.backendId, provenance: 'external',
          runtimeOwner: { backendId: options.backendId, selected: {
            kind: 'plugin_engine', ownerId: 'test.agent', provenance: 'external',
          }, candidates: [] },
          backend: projectEngineRuntimeContributionFromAgent(agent, agent.id),
          agent,
          engineAdapter: { runtimeCore: {
            createSessionRuntime: () => { throw new Error('Unexpected parent Session runtime in native child-Run fixture'); },
            createExecutionRunBackend: nativeOptions => nativeComposedSession
              ? createVoiceSessionRuntimeThroughNativeFactory({
                runtime: { sessions: { open: nativeOpen } },
                capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
                modelId: nativeOptions.modelId ?? 'native-default',
                session: nativeComposedSession, runtimeOptions: nativeOptions,
              })
              : createNativeAgentSessionInteractionHostRuntime({
            runtime: { sessions: { open: nativeOpen } }, options: nativeOptions,
            lease: { pluginId: 'test.agent', pluginVersion: '1.0.0', agentId: 'test.agent', localAgentId: 'agent',
              occurrenceId: 'native-test-occurrence', isCurrent: () => true },
            sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
            createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
          }) } },
          executionSurfaces: createEmptyBackendExecutionSurfaces(), diagnostics: [],
        });
        return actual.createExecutionRunBridgeRuntime({ ...options, engineRegistry: {
          ...registry, resolveForBackendId: resolveNativeEngine, resolveForAgentTarget: resolveNativeEngine,
        } });
      },
    }),
  };
});

const TEST_BACKEND_ID = `${'test'}.${'agent'}` as never;
let directory: string;
const bridges: ExecutionRunHostBridge[] = [];
let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtimeFixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
});
afterAll(async () => { await runtimeFixture?.dispose(); });
beforeEach(() => {
  nativeOpen.mockReset();
  requestRunMaterialization.mockReset();
  requestRunMaterialization.mockResolvedValue({ ok: false, error: 'No daemon materialization in this fixture' });
  nativeModule.ready = undefined;
  nativeComposedSession = undefined;
  retainedReadFailure.armed = false;
  retainedReadFailure.failed = false;
  directory = mkdtempSync(join(tmpdir(), 'happier-pending-target-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  // Native startup is the mocked boundary; model admission uses the real offered catalog.
  vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
  vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
  reloadConfiguration();
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((manager) => manager.dispose()));
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});


function runState(overrides: Partial<ExecutionRunState> = {}): ExecutionRunState {
  return {
    runId: 'run-1',
    callId: 'call-1',
    sidechainId: 'sidechain-1',
    sessionId: 'session-1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
    backendId: TEST_BACKEND_ID,
    instructions: 'Continue.',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'streaming',
    status: 'running',
    startedAtMs: 1,
    resumeHandle: {
      kind: 'provider_session.v1',
      backendTarget: { kind: 'backend', backendId: TEST_BACKEND_ID, sourceKind: 'built_in' },
      providerSessionId: 'provider-session-1',
    },
    ...overrides,
  };
}

function createHarness(detached = false, reviewerRole = false, sendAcp: ExecutionRunTranscriptPublisher = async () => {}, sessionId = 'session-1',
  parentSession?: ApiSessionClient,
  onPublicStateUpdated?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['onPublicStateUpdated'],
  parentPermissionHandler?: ProviderEnforcedPermissionHandler) {
  const reviewer = reviewerRole ? resolveExecutionRunRoleV1({ roleId: 'reviewer',
    accountRoleOverrides: { status: 'ready', overrides: {} } }) : undefined;
  if (reviewerRole && !reviewer) throw new Error('Expected the reviewer role');
  // A bound, admitted Session has readable metadata. Missing metadata cannot
  // prove that the Session is free of an explicit Stop hold.
  const metadata = createTestMetadata(reviewer ? { work: { sessionRolesV1: {
    overrides: {}, notes: '', sessionRoles: { reviewer },
  } } } : {});
  let consume: ExecutionRunPendingInputBinding['consume'] | undefined;
  let wakePendingInput: (() => void) | undefined;
  const acceptedInputs = new Set<string>();
  const inputOutcomes: SessionProviderInputOutcome[] = [];
  const pendingInputs: ExecutionRunAdmittedPendingInputV1[] = [];
  const enqueueSessionUserMessageWithDisposition = vi.fn<(input: { text: string; localId: string }) => Promise<SessionInputAdmissionResultV1>>(
    async (input) => ({ status: 'accepted', localId: input.localId }));
  let observeFirstEnqueuedInput: () => void = () => undefined;
  const firstEnqueuedInput = new Promise<void>(resolve => { observeFirstEnqueuedInput = resolve; });
  const listExecutionRunPendingDeliveryStatuses = vi.fn(async () => [
    { localId: 'queued-1', status: 'queued' as const, deliveryStatus: { status: 'queued' as const } },
    { localId: 'blocked-1', status: 'blocked' as const, deliveryStatus: { status: 'blocked' as const, reason: 'session_input_target_unavailable' as const } },
  ]);
  const blockExecutionRunPendingDelivery = vi.fn(async () => true);
  // This online Session boundary acknowledges the publication before the host
  // admits another input; use the same publisher for held-publication scenarios.
  const enqueueAgentMessageCommitted = vi.fn(async (...args: Parameters<ExecutionRunTranscriptPublisher>) => {
    await sendAcp(...args);
    return { persisted: true, delivered: true };
  });
  const manager = new ExecutionRunHostBridge({
    ...(onPublicStateUpdated ? { onPublicStateUpdated } : {}),
    // External Account preference input for this recovery fixture.
    resolveRunReportPolicy: async () => ({ preset: 'important' }),
    parentProvider: TEST_BACKEND_ID,
    resolveAccountSettings: async () => ({}),
    cwd: detached || reviewerRole ? directory : process.cwd(),
    sendAcp,
    ...(!detached ? { sessionInteractionHost: {
      // Parent Agent configuration is an external runtime observation; child selection stays real.
      readAppliedChildSelection: async () => ({ status: 'applied' as const, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
        modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id, connectedServices: null }),
      session: parentSession ?? {
        sessionId,
        getMetadataSnapshot: () => metadata,
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(),
        enqueueAgentMessageCommitted,
        enqueueSessionUserMessageWithDisposition: async input => {
          const disposition = await enqueueSessionUserMessageWithDisposition(input);
          observeFirstEnqueuedInput();
          return disposition;
        },
        bindExecutionRunPendingInput: (binding: ExecutionRunPendingInputBinding) => {
          wakePendingInput = () => { if (binding.isCurrent()) binding.wake?.(); };
          consume = input => {
            const admitted = binding.consume(input);
            binding.wake?.();
            return admitted;
          };
          return { getMetadataSnapshot: () => metadata, waitForMetadataUpdate: async () => await new Promise<boolean>(() => undefined),
            shouldAttemptPendingMaterialization: () => pendingInputs.length > 0, reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
            materializeNextPendingMessageSafely: async () => {
              const input = pendingInputs.shift();
              if (!input) return { type: 'no_pending' as const };
              binding.consume(input);
              return { type: 'materialized' as const, localId: input.localId!, seq: null, content: null };
            },
            observeProviderInputSettlement: async (outcome: SessionProviderInputOutcome) => {
              inputOutcomes.push(outcome);
              if (outcome.kind === 'accepted') acceptedInputs.add(outcome.localId);
              return true;
            },
            readDurableProviderInputAcceptanceV1: async (localId: string) => acceptedInputs.has(localId) ? 'accepted' as const : 'unknown' as const,
            dispose() {} };
        },
        listExecutionRunPendingDeliveryStatuses,
        blockExecutionRunPendingDelivery,
      },
      machineId: 'machine-1',
      permissionHandler: parentSession
        ? parentPermissionHandler ?? new ProviderEnforcedPermissionHandler(parentSession, { logPrefix: '[Waiter fixture]' })
        : { handleToolCall: vi.fn() },
    } } : {}),
  });
  bridges.push(manager);
  const runs = (manager as unknown as { runs: Map<string, ExecutionRunState> }).runs;
  const controllers = (manager as unknown as { controllers: Map<string, unknown> }).controllers;
  return {
    manager,
    runs,
    controllers,
    listExecutionRunPendingDeliveryStatuses,
    blockExecutionRunPendingDelivery,
    enqueueAgentMessageCommitted,
    enqueueSessionUserMessageWithDisposition,
    firstEnqueuedInput,
    inputOutcomes,
    pendingInputs,
    notifyPendingTarget: async (runId: string) => {
      // SessionClient.notifyExecutionRunPendingTarget wakes a live binding before
      // notifying the bridge's target-reconciliation listener.
      wakePendingInput?.();
      await manager.reconcilePendingExecutionRunTarget(runId);
    },
    consume: (input: ExecutionRunAdmittedPendingInputV1) => consume?.(input),
  };
}

describe('ExecutionRunHostBridge pending target recovery', () => {
  it('retains a typed pre-effect refusal for explicit recovery of an unavailable bounded Run', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState({ runClass: 'bounded', status: 'failed', resumeHandle: null,
      error: { code: 'agent_isolation_unavailable', message: 'Agent placement unavailable' } }));
    const recoveryStatus = {
      localId: 'recovery-input', status: 'queued' as const, deliveryStatus: { status: 'queued' as const },
      requestedAction: { v: 2 as const, kind: 'recover_execution_run' as const },
    };
    harness.listExecutionRunPendingDeliveryStatuses.mockResolvedValue([recoveryStatus]);
    expect(harness.manager.getPublic('run-1')).toMatchObject({ lifecycle: { state: 'unavailable' } });
    await harness.notifyPendingTarget('run-1');
    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledExactlyOnceWith('run-1', 'recovery-input');
    expect(nativeOpen).not.toHaveBeenCalled();
    expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'failed', error: { code: 'agent_isolation_unavailable' } });
  });

  it.each(['service', 'bound_action', 'external_cli', 'external_cli_revoked', 'cli_entry', 'attached_bounded_recovery', 'attached_bounded_launch_failure', 'attached_bounded_turn_failure'] as const)('settles a fresh input after Ensure through real materialization via %s', async entryPoint => {
    const launchFailure = entryPoint === 'attached_bounded_launch_failure';
    const turnFailure = entryPoint === 'attached_bounded_turn_failure';
    const boundedRecovery = entryPoint === 'attached_bounded_recovery' || launchFailure || turnFailure;
    const completionIds: string[] = [];
    let replayInitialFailure: (() => void) | undefined;
    const parentNotificationAbort = new AbortController();
    let secondCompletionWake: Promise<boolean> | undefined;
    const cliEntry = entryPoint === 'cli_entry';
    const external = entryPoint === 'external_cli' || entryPoint === 'external_cli_revoked' || cliEntry;
    let requesterCurrent = true;
    const sessionId = 'c123456789012345678901234';
    const origin = 'http://waiter-home.test';
    const serverIdentityId = cliEntry ? 'srv_waiter' : 'waiter-home';
    if (cliEntry) {
      vi.stubEnv('HAPPIER_SERVER_URL', origin);
      reloadConfiguration();
    }
    const legacySecret = new Uint8Array(32).fill(27);
    const ctx = { encryptionKey: legacySecret, encryptionVariant: 'legacy' as const };
    const mode = cliEntry ? 'e2ee' : 'plain';
    const recipient = { kind: 'execution_run' as const, runId: 'run-1' };
    let sidechainId = 'sidechain-1';
    let initialOccurrence = 'pre-ensure';
    const localId = 'fresh-after-ensure';
    // Home's network response follows buildSessionInputAdmissionReceipt:
    // Machine-authored protected attribution retains its Machine issuer.
    const inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1,
      ...(external ? { issuer: 'authenticatedMachine' }
        : { issuer: 'authenticatedAccount', actorAccountId: 'account-1', sessionRelationship: 'owner' }),
      admittedTarget: { homeId: serverIdentityId, accountId: 'account-1', sessionId,
        machineId: 'machine-1', installationId: 'waiter-installation' } });
    const credentials = { token: 'fixture', encryption: null };
    const jwt = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const runtimeCredentials: StoredCredentials = cliEntry ? {
      token: `${jwt({ alg: 'none' })}.${jwt({ sub: 'account-1', tokenEpoch: 0, provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`,
      encryption: { type: 'legacy', secret: legacySecret }, credentialProvenance: 'stored_session',
    } : credentials;
    type Row = { id: string; seq: number; localId: string | null; sidechainId?: string;
      content: SessionMessageContent; deliveryResolution?: SessionMessageDeliveryResolutionV1; createdAt: number; updatedAt: number };
    const rows: Row[] = [];
    let nativeSequence = 0;
    const nativeInputs: string[][] = [];
    let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const observedPaths: string[] = [];
    const observedRuns: string[] = [];
    let finishNativeTurn: (() => void) | undefined;
    let failNativeTurn: (() => void) | undefined;
    const boundaryFailures: unknown[] = [];
    const installation = nacl.sign.keyPair();
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: randomUUID(), binding: {
      serverIdentityId, accountId: 'account-1', custodianAccountId: 'account-1',
      authentication: { kind: 'terminal', tokenEpoch: 1 }, machineId: 'machine-1',
      accountEncryptionMode: 'plain',
      installationId: 'waiter-installation', actionId: 'session.message.send',
      requestId: 'waiter-request', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'session', sessionId },
    } });
    const observers: ReturnType<typeof createApiSessionSocketStub>[] = [];
    // Socket.IO is the boundary; the canonical stub implements the surface used here.
    const asSessionSocket = (stub: ReturnType<typeof createApiSessionSocketStub>) =>
      stub as unknown as ReturnType<typeof sessionSockets.createSessionScopedSocketConnection>['socket'];
    const notify = () => observers.forEach(socket => socket.trigger('ephemeral', {
      type: 'activity', id: sessionId, active: true, activeAt: Date.now(), thinking: false,
    }));
    const pendingHome = createRetainedPendingHome({ sessionId, authorAccountId: external ? null : 'account-1',
      inputAdmissionReceipt,
      onMaterialize: request => expect(request).toMatchObject({ recipient, sidechainId }),
      onRejected: code => boundaryFailures.push({ decision: 'reject', code }),
      onEnqueued: (_runId, pendingVersion) => socket.trigger('update', { id: 'fresh-pending', seq: 1, createdAt: 1,
        body: { t: 'pending-changed', sid: sessionId, recipient,
          pendingCount: 1, pendingBlockedCount: 0, pendingVersion } }),
      commit: input => {
        const message = { id: 'committed-fresh-input', seq: rows.length + 1, localId: input.localId,
          content: input.content, ...(input.deliveryResolution ? { deliveryResolution: input.deliveryResolution } : {}), createdAt: 1, updatedAt: 1 };
        rows.push({ ...message, sidechainId: input.sidechainId });
        return message;
      },
      onAccepted: notify,
    });
    const socket = createApiSessionSocketStub({ emit: (event, args) => {
      if (!boundedRecovery || event !== 'execution-run-updated') return;
      const packet = z.object({ sid: z.string(), run: z.unknown() }).parse(args[0]);
      const update = EphemeralUpdateSchema.parse({ type: 'execution-run-updated', sessionId: packet.sid, run: packet.run });
      observers.forEach(observer => observer.trigger('ephemeral', update));
    }, emitWithAck: (event, raw) => {
      const pendingAnswer = pendingHome.answer(event, raw);
      if (pendingAnswer !== null) return pendingAnswer;
      return resolveApiSessionSocketDefaultAck(event, raw);
    } });
    const connection = () => {
      const observer = createApiSessionSocketStub();
      observers.push(observer);
      return { socket: asSessionSocket(observer), transport: createSocketTransportAdapter(observer) };
    };
    const observe = vi.spyOn(sessionSockets, 'createSessionScopedSocketConnection').mockImplementation(connection);
    let observeRun: ((request: Readonly<{ sessionId: string; runId: string; signal?: AbortSignal }>) => Promise<unknown>) | undefined;
    const rpcObservation = vi.spyOn(sessionSockets, 'createUserScopedSocketConnection').mockImplementation(options => {
      expect(options.token).toBe(runtimeCredentials.token);
      const boundary = createApiSessionSocketStub({ emitWithAck: async (event, raw) => {
        if (event !== 'rpc-call') return resolveApiSessionSocketDefaultAck(event, raw);
        const packet = z.object({ method: z.string(), requestId: z.string(), params: z.unknown() }).parse(raw);
        expect(packet.method).toBe(`${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`);
        const content: SocketRpcContent = cliEntry ? { mode: 'e2ee', cipher: {
          decryptRaw: async data => decryptSessionPayload({ ciphertextBase64: data, ctx }),
          encryptRaw: async data => encryptSessionPayload({ payload: data, ctx }),
        } } : { mode: 'plain' };
        const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
        const input = z.object({ runId: z.string() }).parse(decoded.params);
        if (!observeRun) throw new Error('Run observer is not ready');
        const result = await observeRun({ sessionId, runId: input.runId });
        if (entryPoint === 'external_cli_revoked') requesterCurrent = false;
        return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
      } });
      return { socket: asSessionSocket(boundary), transport: createSocketTransportAdapter(boundary) };
    });
    const app = fastify();
    app.setErrorHandler((error, _request, reply) => {
      const failure = error instanceof Error ? error : new Error('Fixture boundary failure');
      boundaryFailures.push({ name: failure.name,
        refusal: /^CLI ingress refused: ([a-z_]+)$/.exec(failure.message)?.[1],
        at: failure.stack?.split('\n').slice(1, 4).filter(line => !/token|secret|key|bearer|password|credential/i.test(line)),
      });
      return reply.code(500).send({ error: 'fixture_boundary_failure' });
    });
    const homePaths: string[] = [];
    const homeStatuses: { path: string; status: number }[] = [];
    app.addHook('onRequest', async request => { homePaths.push(new URL(request.url, origin).pathname); });
    app.addHook('onResponse', async (request, reply) => { homeStatuses.push({ path: new URL(request.url, origin).pathname, status: reply.statusCode }); });
    const metadata = createTestMetadata({ machineId: 'machine-1', path: directory });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode }));
    app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 0 }));
    app.get('/v1/account/profile', async () => ({ id: 'account-1' }));
    app.get('/v1/auth/ping', async () => ({}));
    app.get('/v2/account/settings', async () => ({ content: cliEntry ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
      kind: 'account_settings', material: { type: 'legacy', secret: legacySecret }, payload: {}, randomBytes: size => new Uint8Array(size).fill(7),
    }) } : { t: 'plain', v: {} }, version: 1 }));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: createSessionRecordFixture({ id: sessionId,
      active: true, encryptionMode: mode, metadata: cliEntry ? encryptSessionPayload({ payload: metadata, ctx }) : JSON.stringify(metadata) }) }));
    let runCliIngress: ((body: unknown) => Promise<unknown>) | undefined;
    app.post('/v1/actions/session.message.send', async request => {
      if (!runCliIngress) throw new Error('CLI ingress is not ready');
      homePaths.push('fixture_ingress_handler');
      return await runCliIngress(request.body);
    });
    app.post('/v1/actions/session.message.send/execution-authorization/verify', async (request, reply) => {
      expect(request.body).toEqual({ v: 1 });
      return requesterCurrent ? { ok: true } : reply.code(403).send({ error: 'not_authenticated' });
    });
    app.get(`/v2/sessions/${sessionId}/messages/by-local-id/:localId`, async (request, reply) => {
      const id = (request.params as { localId: string }).localId;
      const message = rows.find(row => row.localId === id);
      return message ? { message } : reply.code(404).send({ error: 'Message not found' });
    });
    app.get(`/v2/sessions/${sessionId}/execution-runs/:runId/pending`, async () => ({ recipient,
      pending: boundedRecovery && pendingHome.readPending(recipient.runId) ? [{ ...pendingHome.readPending(recipient.runId), status: 'queued', deliveryStatus: { status: 'queued' } }] : [] }));
    app.get(`/v1/sessions/${sessionId}/messages`, async request => {
      observedPaths.push(request.url);
      const query = new URL(request.url, origin).searchParams;
      return { messages: rows.filter(row => row.seq > Number(query.get('afterSeq') ?? 0)
        && (query.get('scope') === 'sidechain'
          ? row.sidechainId === query.get('sidechainId') : row.sidechainId === undefined)) };
    });
    let session: ApiSessionClient | undefined;
    let manager: ExecutionRunHostBridge | undefined;
    let recoveryPhase = 'session_setup';
    onTestFailed(() => {
      const pending = pendingHome.readPending(recipient.runId);
      console.info(JSON.stringify({ recoveryPhase, nativeOpens: nativeOpen.mock.calls.length,
        nativeInputCount: nativeInputs.length, claimCount: pendingHome.readClaimCount(recipient.runId), pending: Boolean(pendingHome.readPending(recipient.runId)),
        pendingEnvelopeValid: pending?.content.t === 'plain' && UserMessageSchema.safeParse(pending.content.v).success,
        runStatus: manager?.getPublic(recipient.runId)?.status, observedRunCount: observedRuns.length }));
    });
    let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
    let restoreIdentity: (() => void) | undefined;
    let retirePendingTarget: (() => void) | undefined;
    let retireWorkerPublication: (() => void) | undefined;
    const admitPending = (input: Parameters<typeof pendingHome.admit>[1]) => pendingHome.admit(recipient.runId, input);
    app.post(`/v2/sessions/${sessionId}/execution-runs/:runId/pending`, async request =>
      pendingHome.enqueue(recipient.runId, request.body));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId }, session: {
      pendingInput: { protocolVersion: 3 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 },
    } } }), { status: 200 })));
    nativeOpen.mockImplementation(async request => {
      if (launchFailure && request.kind === 'resume') {
        throw Object.assign(new Error('Provider connection is unavailable'), { code: 'provider_connection_not_found' });
      }
      return {
      watch(next) { emit = next; next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1',
        sessionId: request.sessionId, sequence: ++nativeSequence, emittedAtMs: nativeSequence }); return { dispose() { emit = undefined; } }; },
      async send(input) {
        nativeInputs.push([...input.inputIds]);
        const base = () => ({ sessionId: request.sessionId, sequence: ++nativeSequence, emittedAtMs: nativeSequence });
        emit?.({ ...base(), kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
        emit?.({ ...base(), kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
        emit?.({ ...base(), kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant',
          text: boundedRecovery ? JSON.stringify({ summary: 'Recovered reply', deliverables: [] }) : 'Recovered reply' });
        finishNativeTurn = () => emit?.({ ...base(), kind: 'turn-complete', turnId: input.delivery.turnId });
        failNativeTurn = () => emit?.({ ...base(), kind: 'turn-failed', turnId: input.delivery.turnId,
          diagnostic: { code: 'native_process_exited', severity: 'error' } });
        if (turnFailure && input.inputIds.includes(localId)) {
          replayInitialFailure!();
          expect(manager?.getPublic(recipient.runId)).toMatchObject({ status: 'running' });
          queueMicrotask(() => {
            failNativeTurn?.();
            failNativeTurn?.();
          });
        }
        if (external || boundedRecovery && !turnFailure && input.inputIds.includes(localId)) queueMicrotask(() => finishNativeTurn?.());
        return { status: 'admitted' };
      },
      async dispose() {},
      };
    });
    try {
      const targetSubscriptions = boundedRecovery ? vi.spyOn(ApiSessionClient.prototype, 'subscribeExecutionRunPendingTarget') : null;
      const nativeSession = createPlainSessionFixture({ id: sessionId, metadata });
      session = new ApiSessionClient(runtimeCredentials.token, cliEntry ? { ...nativeSession,
        encryptionMode: 'e2ee', encryptionKey: legacySecret, encryptionVariant: 'legacy',
      } : nativeSession, {
        ...(boundedRecovery ? { localMachineId: 'machine-1' } : {}),
        metadataAuthority: { kind: 'owner', credentials: runtimeCredentials }, localMachineId: 'machine-1',
        durableMutationDeliveryInitiallyActive: false,
        transport: { serverId: 'waiter-home', serverUrl: origin,
          createSessionSocketTransport: () => ({ socket: asSessionSocket(socket), transport: createSocketTransportAdapter(socket) }),
          createAccountUpdatesSocket: () => asSessionSocket(createApiSessionSocketStub()),
        },
      });
      const sessionContractReady = new Promise<void>(resolve => session!.once('session-sync-server-contract', resolve));
      nativeComposedSession = session;
      // Home publication is a network boundary. Keep the host transcript producer,
      // envelopes, exact-turn metadata and real Pending materializer beneath it.
      vi.spyOn(session, 'enqueueAgentMessageCommitted').mockImplementation(async (provider, body, options) => {
        rows.push({ id: `reply-${rows.length}`, seq: rows.length + 1, localId: options?.localId ?? null,
          sidechainId: body.sidechainId, createdAt: 2, updatedAt: 2,
          content: cliEntry ? { t: 'encrypted', c: encryptSessionPayload({ payload: buildAcpAgentMessageEnvelope({ provider, body, meta: options?.meta }), ctx }) }
            : { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider, body, meta: options?.meta }) } });
        notify();
        return { persisted: true, delivered: true };
      });
      const parentPermissionHandler = boundedRecovery
        ? new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Recovery fixture]' }) : undefined;
      const recoveryBindings = boundedRecovery ? vi.spyOn(session, 'bindExecutionRunPendingInput') : null;
      if (parentPermissionHandler) {
        // This in-process host has no daemon snapshot IPC. Retire the Session's
        // dormant default owner before constructing the fixture's single host.
        await session.disposeExecutionRuns();
        for (const result of targetSubscriptions?.mock.results ?? []) {
          if (result.type === 'return' && typeof result.value === 'function') result.value();
        }
        parentPermissionHandler.setPermissionMode('read-only');
        session.setSessionRuntimeControls({ readPermissionHandler: () => parentPermissionHandler,
          readAppliedChildSelection: async () => ({ status: 'applied',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id, connectedServices: null }),
        });
      }
      const harness = createHarness(false, false, async () => {}, sessionId, session, run => {
        // Home is the network boundary: mirror the existing Session runtime
        // publisher and sessionUpdateHandler's schema-validated Run hint.
        const update = EphemeralUpdateSchema.parse({ type: 'execution-run-updated', sessionId, run: projectExecutionRunSessionUpdateState(run) });
        observers.forEach(observer => observer.trigger('ephemeral', update));
      }, parentPermissionHandler);
      manager = harness.manager;
      if (boundedRecovery) {
        // Same public composition as registerSessionClientRuntimeHandlers:
        // mount the sole host owner and retain its subscription's cleanup.
        session.setExecutionRunWorkerUpdateSource(manager);
        if (turnFailure) {
          const publication = createHostWorkerUpdatePublication({ getSession: () => session!, agentId: TEST_BACKEND_ID });
          publication.bind(session);
          retireWorkerPublication = publication.dispose;
        }
        retirePendingTarget = session.subscribeExecutionRunPendingTarget(runId => harness.manager.reconcilePendingExecutionRunTarget(runId));
      }
      await sessionContractReady;
      recoveryPhase = 'session_contract_ready';
      if (boundedRecovery) {
        recoveryPhase = 'initial_start';
        const started = await manager.start({ sessionId, cwd: directory, intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Initial input',
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response', localInputId: 'initial-input' });
        recipient.runId = started.runId;
        sidechainId = started.sidechainId;
        recoveryPhase = 'initial_input';
        await vi.waitFor(() => expect(nativeInputs).toEqual([['initial-input']]));
        expect(nativeOpen).toHaveBeenCalledOnce();
        initialOccurrence = manager.getPublic(recipient.runId)!.inputTurns!.occurrenceId;
        // The sole external provider exits. Host failure/custody and retained
        // checkpoint classification are production logic, not seeded state.
        // Native process adapters fail the active turn before ending the runtime
        // (Codex appServer/runtime.ts attachClientHandlers is one producer).
        replayInitialFailure = failNativeTurn;
        failNativeTurn!();
        if (!turnFailure) {
          emit!({ kind: 'runtime-ended', sessionId, sequence: ++nativeSequence, emittedAtMs: nativeSequence,
            cause: 'processExited', retryable: true, diagnostic: { code: 'native_process_exited', severity: 'error' } });
        }
        recoveryPhase = 'native_exit_settlement';
        await manager.waitForTerminal(recipient.runId);
        await vi.waitFor(() => expect(harness.controllers.has(recipient.runId)).toBe(false));
        if (launchFailure || turnFailure) {
          const reports = await manager.prepareWorkerUpdates(sessionId, { signal: new AbortController().signal });
          expect(reports).toHaveLength(1);
          expect(reports[0]!.update).toMatchObject({ ownerState: 'failed', workerId: recipient.runId });
          completionIds.push(reports[0]!.localId);
          if (turnFailure) {
            await vi.waitFor(() => expect(rows.filter(row => completionIds.includes(row.localId ?? ''))).toHaveLength(1));
          }
          await reports[0]!.acknowledgeAccepted();
          expect(await manager.prepareWorkerUpdates(sessionId, { signal: new AbortController().signal })).toEqual([]);
          if (turnFailure) secondCompletionWake = manager.waitForWorkerUpdateChange(sessionId, parentNotificationAbort.signal);
        }
        expect(await manager.send(recipient.runId, { message: 'Ordinary input', localInputId: 'ordinary-input' }))
          .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
        expect(await manager.send(recipient.runId, { message: 'Duplicate recovery', localInputId: 'initial-input', resume: true }))
          .toMatchObject({ ok: false, errorCode: 'execution_run_invalid_action_input' });
        const failed = harness.runs.get(recipient.runId)!;
        harness.runs.set('unrecoverable', { ...failed, runId: 'unrecoverable', retentionPolicy: 'ephemeral' });
        expect(await manager.send('unrecoverable', { message: 'Cannot recover', localInputId: 'fresh-unrecoverable', resume: true }))
          .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
        expect(nativeOpen).toHaveBeenCalledOnce();
        expect(requestRunMaterialization).not.toHaveBeenCalled();
        recoveryPhase = 'refusal_controls_complete';
      } else {
        harness.runs.set('run-1', runState({ sessionId, status: 'failed', finishedAtMs: 2,
          inputTurns: { occurrenceId: 'pre-ensure', last: { turnId: 'initial-turn', inputIds: ['initial-input'], state: 'completed' } },
          launch: { cwd: directory }, error: { code: 'codex_runtime_ended', message: 'Native process ended' } }));
      }
      expect(manager.getPublic(recipient.runId)).toMatchObject({ lifecycle: { state: boundedRecovery ? 'recoverable_with_input' : 'recoverable' } });
      if (!boundedRecovery) expect(await manager.ensure(recipient.runId, { resume: true })).toEqual({ ok: true });
      const rpc = createExecutionRunRpcActionDeps({ manager, context: { sessionId, cwd: directory },
        isExecutionRunsEnabled: () => true, policy: { boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
      const readExecutionRun = async (request: Readonly<{ sessionId: string; runId: string; signal?: AbortSignal }>) => {
        observedRuns.push(request.runId);
        const result = await rpc.executionRunGet!(request.sessionId, { runId: request.runId }, { signal: request.signal });
        if (observedRuns.length === 1 && !external && !boundedRecovery) {
          expect(manager?.getPublic(request.runId)?.inputTurns?.current?.state).toBe('active');
          finishNativeTurn?.();
        }
        return result;
      };
      observeRun = readExecutionRun;
      requester = external && !cliEntry ? await runWithServerHttpBaseUrl(origin, () => admitRequesterAccountActionContext({
        authorization, credentials, serverId: 'waiter-home', serverIdentityId: 'waiter-home', serverHttpBaseUrl: origin,
        isCurrent: async () => requesterCurrent,
      })).catch(() => { throw new Error(`Requester admission failed at Home paths: ${JSON.stringify(homePaths)}`); }) : null;
      if (external && !cliEntry) expect(requester).not.toBeNull();
      const identity = vi.spyOn(installationIdentity, 'readInstallationIdentityIfExistsSync').mockReturnValue({
        version: 1, installationId: 'waiter-installation', createdAt: 1,
        publicKey: encodeBase64(installation.publicKey, 'base64url'), privateKey: encodeBase64(installation.secretKey, 'base64url'),
      });
      const machine = new ApiMachineClient(runtimeCredentials.token, { id: 'machine-1', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      Reflect.set(machine, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: (event, raw) => {
        expect(event).toBe(SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2);
        const input = SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.parse(raw);
        expect(input).toMatchObject({ sessionId, recipient, targetMachineId: 'machine-1' });
        expect(input.externalAction?.authorization.binding).toMatchObject(cliEntry
          ? { actionId: 'session.message.send', accountId: 'account-1', target: { kind: 'session', sessionId } }
          : authorization.binding);
        admitPending(input);
        return { v: 2, result: { status: 'accepted', localId: input.localId } };
      } }));
      restoreIdentity = () => identity.mockRestore();
      if (cliEntry) {
        const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
        const { createActionSettingsProvider } = await import('@/settings/actionsSettingsProvider');
        const { executeExternalAction } = await import('@/daemon/externalActions/executeExternalAction');
        const { prepareInstalledRequesterAccountActionContext } = await import('@/daemon/sessionEncryption/requesterAccountActionProjection');
        const createReceiver = (receiverCredentials: StoredCredentials) => createCliActionExecutorFromCredentials({
          credentials: receiverCredentials, readCredentials: async () => receiverCredentials,
          serverId: configuration.activeServerId, serverApiUrl: origin, serverIdentityId,
          pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: createActionSettingsProvider(),
          machineAdmissionTransport: (request, options) => machine.enqueueSessionPendingByMachine(request, options),
          externalActionMachineInstallationId: 'waiter-installation', externalActionMachineRequestPrivateKey: installation.secretKey,
        });
        // Home minting/verification and installed Session placement are boundaries;
        // ingress, credentialed executors and original-requester admission stay real.
        runCliIngress = async body => {
          const envelope = ExternalActionRequestEnvelopeV2Schema.parse(body);
          const opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: { serverIdentityId, accountId: 'account-1',
            authentication: { kind: 'account', tokenEpoch: 0 }, actionId: 'session.message.send', requestId: envelope.requestId,
            target: { kind: 'session', sessionId } }, material: {
              type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(legacySecret),
            } });
          expect(opened?.input).toMatchObject({ sessionId, recipient, localId, wait: true, timeoutSeconds: 1 });
          const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: randomUUID(), binding: {
            ...authorization.binding, authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'e2ee',
            requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
          } });
          const response = await executeExternalAction({ actionId: 'session.message.send', envelope, executionAuthorization: root,
            principal: { accountId: 'account-1', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
            currentMachineId: 'machine-1', currentServerId: configuration.activeServerId, currentAccountId: 'account-1',
            currentServerHttpBaseUrl: origin, currentInstallationId: 'waiter-installation',
            externalActionMachineRequestPrivateKey: installation.secretKey, isInstallationCurrent: () => true,
            surface: 'cli', executor: createReceiver(runtimeCredentials),
            resolveEncryption: async () => ({ serverIdentityId, material: {
              type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(legacySecret),
            } }),
            resolveTarget: async request => request.target?.kind === 'session' && request.target.sessionId === sessionId ? request.target : null,
            verifyExecutionAuthorization: async request => request.authorization.token === root.token && requesterCurrent,
            prepareRequesterAccountContext: async request => {
              homePaths.push('fixture_requester_prepare');
              try {
                const prepared = await prepareInstalledRequesterAccountActionContext({ ...request, purpose: { kind: 'external_action' },
                  machineId: 'machine-1', serverId: configuration.activeServerId, serverHttpBaseUrl: origin, ownCredentials: runtimeCredentials,
                  resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine-1', serverIdentityId }),
                  resolveRequesterSessionBootstrap: async (id, attribution) => id === sessionId ? {
                    credentials: runtimeCredentials, attribution, serverHttpBaseUrl: origin, getBoundSessionId: () => sessionId,
                    isCurrent: async () => requesterCurrent, release: async () => {},
                  } : null,
                  createExecutor: context => createReceiver(context.credentials),
                });
                homePaths.push(prepared ? 'fixture_requester_ready' : 'fixture_requester_refused');
                return prepared;
              } catch (error) {
                const failure = error instanceof Error ? error : new Error('Requester boundary failure');
                boundaryFailures.push({ stage: 'requester_prepare', name: failure.name,
                  at: failure.stack?.split('\n').slice(1, 5).filter(line => !/token|secret|key|bearer|password|credential/i.test(line)) });
                throw error;
              }
            },
          });
          if (response.kind !== 'response') throw new Error(`CLI ingress refused: ${response.errorCode}`);
          return response.prepared.response;
        };
      }
      const sendingCredentials = external ? { ...credentials, token: randomUUID() } : credentials;
      const result = await runWithServerHttpBaseUrl<unknown>(origin, async () => {
        if (boundedRecovery) {
          recoveryPhase = 'recovery_action';
          const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
            serverId: 'waiter-home', serverIdentityId: 'waiter-home', serverHttpBaseUrl: origin,
            resolveServerFeaturesSnapshot: () => undefined,
            invokeBoundSessionRpc: async (method, input, signal) => {
              expect(method).toBe(SESSION_RPC_METHODS.EXECUTION_RUN_GET);
              expect(input).toEqual({ runId: recipient.runId });
              return readExecutionRun({ sessionId, runId: recipient.runId, signal });
            },
          });
          const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), sessionSendMessage: deps.sessionSendMessage });
          return executor.execute('session.message.send', { sessionId, recipient, localId, message: 'Fresh input',
            wait: true, timeoutSeconds: 1, requestedAction: { v: 2, kind: 'recover_execution_run' } },
          { surface: 'cli', authority: 'present_user' });
        }
        if (cliEntry) {
          const { handleSessionCommand } = await import('@/cli/commands/session');
          const output = captureConsoleJsonOutput();
          const previousExitCode = process.exitCode;
          try {
            await handleSessionCommand(['send', sessionId, 'Fresh input', '--run', recipient.runId,
              '--local-id', localId, '--wait', '--timeout', '1', '--json'], { readCredentialsFn: async () => runtimeCredentials });
            return output.json<unknown>();
          } finally {
            output.restore();
            process.exitCode = previousExitCode;
          }
        }
        return entryPoint === 'service' ? sendSessionMessage({ credentials,
        idOrPrefix: sessionId, recipient, localId, message: 'Fresh input', wait: true, timeoutMs: 1_000,
        resolveAuthorizationHeaders: () => ({ 'x-fixture-authority': 'original-requester' }),
        readExecutionRun,
      }) : createCliActionDeps({ token: sendingCredentials.token, credentials: sendingCredentials,
        sessionId: external ? 'cli-global' : sessionId, mode: 'plain', ctx: null,
        serverId: 'waiter-home', serverIdentityId: 'waiter-home', serverHttpBaseUrl: origin,
        externalActionMachineInstallationId: 'waiter-installation',
        externalActionMachineRequestPrivateKey: installation.secretKey,
        machineAdmissionTransport: (request, options) => machine.enqueueSessionPendingByMachine(request, options),
        resolveServerFeaturesSnapshot: () => undefined,
        invokeBoundSessionRpc: async (method, input, signal) => {
          expect(external).toBe(false);
          expect(method).toBe(SESSION_RPC_METHODS.EXECUTION_RUN_GET);
          expect(input).toEqual({ runId: recipient.runId });
          return readExecutionRun({ sessionId, runId: recipient.runId, signal });
        },
      }).sessionSendMessage!({ sessionId, recipient, localId, message: 'Fresh input', wait: true, timeoutSeconds: 1,
        callerSurface: 'cli', actionCaller: { kind: 'host' },
        requestedAction: { v: 1, kind: 'enqueue' },
        context: { surface: 'cli', authority: 'present_user', ...(external
          ? { externalActionExecutionAuthorization: requester!.authorization, externalActionTarget: { kind: 'session' as const, sessionId } } : {}) },
        });
      });
      const diagnostic = JSON.stringify({ result,
        claimCount: pendingHome.readClaimCount(recipient.runId), pending: Boolean(pendingHome.readPending(recipient.runId)), claimed: Boolean(pendingHome.readClaimed(recipient.runId)), boundaryFailures, observedRuns, observedPaths, homePaths, homeStatuses,
        socketEvents: socket.emitWithAck.mock.calls.map(([event]) => event), rows: rows.map(row => ({ seq: row.seq, localId: row.localId })) });
      if (turnFailure) {
        expect(nativeInputs).toEqual([['initial-input'], [localId]]);
        expect(rows.filter(row => row.localId === localId)).toHaveLength(1);
        const replayRecoveredFailure = failNativeTurn!;
        await manager.waitForTerminal(recipient.runId);
        await vi.waitFor(() => expect(harness.controllers.has(recipient.runId)).toBe(false));
        expect(await secondCompletionWake).toBe(true);
        expect(manager.getPublic(recipient.runId)).toMatchObject({ status: 'failed',
          error: { code: 'native_process_exited' }, inputTurns: { last: { state: 'failed', inputIds: [localId] } } });
        const reports = await manager.prepareWorkerUpdates(sessionId, { signal: new AbortController().signal });
        expect(reports).toHaveLength(1);
        expect((await session.takeExecutionRunWorkerUpdate(parentNotificationAbort.signal))?.localId).toBe(reports[0]!.localId);
        expect(reports[0]!.update).toMatchObject({ ownerState: 'failed', workerId: recipient.runId,
          runtimeIssueV1: { code: 'native_process_exited' } });
        completionIds.push(reports[0]!.localId);
        expect(new Set(completionIds).size).toBe(2);
        await vi.waitFor(() => expect(rows.filter(row => completionIds.includes(row.localId ?? ''))).toHaveLength(2));
        const completionRows = rows.filter(row => completionIds.includes(row.localId ?? ''));
        expect(completionRows).toHaveLength(2);
        expect(completionRows[1]!.seq).toBeGreaterThan(completionRows[0]!.seq);
        replayRecoveredFailure();
        replayInitialFailure!();
        expect((await manager.prepareWorkerUpdates(sessionId, { signal: new AbortController().signal }))
          .map(item => item.localId)).toEqual([completionIds[1]]);
        // A replaced host recovers the sealed attempt identity; reconnecting
        // the parent source cannot publish another row or consume its wake.
        const replayed = new ExecutionRunHostBridge({ parentProvider: TEST_BACKEND_ID,
          cwd: directory, happyHomeDir: directory, sendAcp: async () => {} });
        session.setExecutionRunWorkerUpdateSource(replayed);
        expect((await replayed.prepareWorkerUpdates(sessionId, { signal: parentNotificationAbort.signal }))
          .map(item => item.localId)).toEqual([completionIds[1]]);
        expect(rows.filter(row => completionIds.includes(row.localId ?? ''))).toHaveLength(2);
        session.setExecutionRunWorkerUpdateSource(manager);
        await reports[0]!.acknowledgeAccepted();
        expect(await manager.prepareWorkerUpdates(sessionId, { signal: new AbortController().signal })).toEqual([]);
        return;
      }
      if (launchFailure) {
        expect(nativeOpen.mock.calls.map(([request]) => request.kind)).toEqual(['create', 'resume']);
        expect(manager.getPublic(recipient.runId), diagnostic).toMatchObject({ status: 'failed',
          error: { code: 'provider_connection_not_found' } });
        await vi.waitFor(() => expect(harness.controllers.has(recipient.runId)).toBe(false));
        const reports = await manager.prepareWorkerUpdates(sessionId, { signal: new AbortController().signal });
        expect(reports).toHaveLength(1);
        expect(reports[0]!.update).toMatchObject({ ownerState: 'failed', workerId: recipient.runId,
          result: expect.stringContaining('Provider connection is unavailable') });
        expect(nativeInputs).toEqual([['initial-input']]);
        return;
      }
      expect(boundaryFailures, diagnostic).toEqual([]);
      if (boundedRecovery) expect(recoveryBindings).toHaveBeenCalledOnce();
      expect(manager.getPublic(recipient.runId), diagnostic).toMatchObject({ inputTurns: { last: { state: 'completed', inputIds: [localId] } } });
      expect(manager.getPublic(recipient.runId)?.inputTurns?.occurrenceId).not.toBe(initialOccurrence);
      expect(result, diagnostic).toMatchObject(boundedRecovery ? { ok: true, result: { status: 'accepted', localId } } : cliEntry ? { ok: true, data: { localId } } : entryPoint === 'external_cli_revoked'
        ? { status: 'outcomeUnknown', localId, code: 'session_input_turn_outcome_unknown' }
        : entryPoint === 'service'
        ? { ok: true, waited: true, localId }
        : { status: 'accepted', localId });
      expect(nativeInputs).toEqual(boundedRecovery ? [['initial-input'], [localId]] : [[localId]]);
      if (boundedRecovery) {
        expect(manager.getPublic(recipient.runId)).toMatchObject({ status: 'succeeded' });
      }
      expect(pendingHome.readClaimCount(recipient.runId)).toBe(1);
      expect(rows.filter(row => row.localId === localId)).toHaveLength(1);
      expect(observedRuns.length).toBeGreaterThan(external || boundedRecovery ? 0 : 1);
      expect(observedRuns.every(runId => runId === recipient.runId)).toBe(true);
      expect(observedPaths).toEqual([]);
      const settledReads = observedRuns.length;
      for (let index = 0; index < 100; index += 1) notify();
      await Promise.resolve();
      expect(observedRuns).toHaveLength(settledReads);
      expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject(boundedRecovery
        ? [{ kind: 'create' }, { kind: 'resume', providerSessionId: 'provider-session-1' }]
        : [{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
    } finally {
      parentNotificationAbort.abort();
      retireWorkerPublication?.();
      retirePendingTarget?.();
      await requester?.dispose();
      restoreIdentity?.();
      await manager?.dispose();
      await session?.close();
      nativeComposedSession = undefined;
      restore();
      observe.mockRestore();
      rpcObservation.mockRestore();
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it.each([
    { ioMode: 'request_response', continuation: 'pending' },
    { ioMode: 'streaming', continuation: 'direct' },
    { ioMode: 'request_response', continuation: 'direct_unkeyed' },
  ] as const)('publishes initial and continued retained Agent answers once ($ioMode, $continuation)', async ({ ioMode, continuation }) => {
    const native = createNativeSessionBoundary();
    nativeOpen.mockImplementation(native.open);
    const publications: Parameters<ExecutionRunTranscriptPublisher>[1][] = [];
    const harness = createHarness(false, false, async (_provider, body) => { publications.push(body); });
    const started = await harness.manager.start({ sessionId: 'session-1', intent: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelSelection: null,
      instructions: 'Answer the first question.', permissionMode: 'read_only',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode, localInputId: 'agent-initial' });
    await vi.waitFor(() => expect(harness.enqueueSessionUserMessageWithDisposition).toHaveBeenCalled());
    const controller = harness.controllers.get(started.runId) as ExecutionRunBackendController;
    await controller.provisioningPromise;
    try {
      for (const [index, localId, prompt, answer] of [
        [0, 'agent-initial', 'Answer the first question.', 'First answer.'],
        [1, 'agent-continuation', 'Answer the follow-up.', 'Continued answer.'],
      ] as const) {
        if (index > 0 && continuation !== 'pending') {
          expect(await harness.manager.send(started.runId, { message: prompt,
            ...(continuation === 'direct' ? { localInputId: localId } : {}),
          })).toMatchObject({ ok: true });
        } else {
          if (index > 0) expect(await harness.enqueueSessionUserMessageWithDisposition({ text: prompt, localId }))
            .toMatchObject({ status: 'accepted' });
          await vi.waitFor(() => expect(harness.consume({ role: 'user', content: { type: 'text', text: prompt },
            localId, authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true));
        }
        await vi.waitFor(() => expect(native.inputs).toHaveLength(index + 1));
        native.complete(answer);
        await vi.waitFor(() => expect(harness.manager.getPublic(started.runId)).toMatchObject({
          status: 'running', turnInFlight: false,
          inputTurns: { last: { inputIds: native.inputs[index]!.inputIds, state: 'completed' } },
        }));
        await controller.pendingHostBarrier;
        expect.soft(publications.filter(body => body.type === 'message')).toEqual(
          ['First answer.', ...(index > 0 ? ['Continued answer.'] : [])].map(message => ({
            type: 'message', message, sidechainId: started.sidechainId,
          })),
        );
        expect.soft(harness.enqueueAgentMessageCommitted.mock.calls).toContainEqual([
          expect.any(String), { type: 'message', message: answer, sidechainId: started.sidechainId },
          expect.objectContaining({ localId: expect.any(String), admission: expect.objectContaining({ requireDelivery: true }),
            meta: expect.objectContaining({ runtimeTurnId: native.inputs[index]!.delivery.turnId }) }),
        ]);
      }
      expect(native.opens).toHaveLength(1);
      expect(native.inputs).toHaveLength(2);
      expect(harness.manager.get(started.runId)?.summary).toBe('Continued answer.');
    } finally { await harness.manager.dispose(); }
  });

  it.each([
    { outcome: 'complete', operation: 'retire', holdPublication: false, narration: false },
    { outcome: 'complete', operation: 'retire', holdPublication: true, narration: false },
    { outcome: 'complete', operation: 'stop', holdPublication: false, narration: false },
    { outcome: 'failed', operation: 'retire', holdPublication: false, narration: false },
    { outcome: 'complete', operation: 'retire', holdPublication: false, narration: true },
    { outcome: 'complete', operation: 'restart', holdPublication: false, narration: true },
  ] as const)('resumes a completed idle retained review after runner disposal and replacement ($outcome, $operation, publication held=$holdPublication, narration=$narration)', async ({ outcome, operation, holdPublication, narration }) => {
    execFileSync('git', ['init', directory], { stdio: 'ignore' });
    writeFileSync(join(directory, 'code.ts'), 'export const enabled = true;\n');
    const comparison = narration ? await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' } }) : null;
    let sequence = 0;
    const requests: AgentSessionOpenRequest[] = [];
    const disposedThreads: AgentSessionOpenRequest[] = [];
    nativeOpen.mockImplementation(async request => {
      requests.push(request);
      let nativeTurns = 0;
      let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      const base = () => ({ sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence });
      return {
        watch(listener) {
          emit = listener;
          emit({ ...base(), kind: 'provider-session-id', providerSessionId: 'retained-review-thread' });
          return { dispose() { emit = undefined; } };
        },
        async send(input) {
          const turnId = input.delivery.turnId;
          emit?.({ ...base(), kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
          emit?.({ ...base(), kind: 'turn-start', turnId, startedBy: 'host' });
          emit?.({ ...base(), kind: 'message-delta', turnId, channel: 'assistant', text: JSON.stringify(
            request.kind === 'resume' ? { answerMarkdown: 'The condition controls authorization.', updatedFindings: [], questions: [], assumptions: [] }
              : ++nativeTurns === 1 ? { summary: 'Reviewed the changes.', reviewOutcome: outcome, findings: [] }
                : { walkthrough: { title: 'Condition update', intro: 'One changed condition',
                  stops: [{ id: 'condition', title: 'Condition', explanationMarkdown: 'The flag changed', changeRefs: ['c1'] }], otherChangeRefs: [] } },
          ) });
          emit?.({ ...base(), kind: 'turn-complete', turnId });
          return { status: 'admitted' as const };
        },
        async dispose() { disposedThreads.push(request); emit = undefined; },
      };
    });
    let releasePublication!: () => void;
    const publication = new Promise<void>(resolve => { releasePublication = resolve; });
    let publicationEntered!: () => void;
    const publishing = new Promise<void>(resolve => { publicationEntered = resolve; });
    let retiringCallId: string | undefined;
    const original = createHarness(false, true, async (_provider, body, options) => {
      if (operation === 'restart' && body.type === 'tool-result' && body.callId === retiringCallId) {
        publicationEntered();
        await publication;
      }
      const meta = options?.meta?.happier;
      if (holdPublication && meta && typeof meta === 'object' && 'kind' in meta && meta.kind === 'review_findings.v2') {
        publicationEntered();
        await publication;
      }
    });
    const started = await original.manager.start({ sessionId: 'session-1', cwd: directory, intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelSelection: null,
      instructions: 'Review.', permissionMode: 'read_only',
      ...(comparison ? { intentInput: { comparisonId: comparison.comparison.id, outputs: ['walkthrough'] } } : {}),
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', localInputId: 'review-initial' });
    await original.firstEnqueuedInput;
    const initialController = original.controllers.get(started.runId) as ExecutionRunBackendController;
    await initialController.provisioningPromise;
    expect(original.manager.getPublic(started.runId)).toMatchObject({ turnInFlight: true });
    await vi.waitFor(() => expect(original.consume({ role: 'user', content: { type: 'text', text: 'Review.' },
      localId: 'review-initial', authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true));
    if (narration) {
      await vi.waitFor(() => expect(original.enqueueSessionUserMessageWithDisposition.mock.calls).toHaveLength(2));
      await initialController.pendingHostBarrier;
      // Native findings have finished, but their admitted walkthrough has not
      // reached the provider. A capability refresh must retain this host.
      expect.soft(original.manager.getPublic(started.runId)).toMatchObject({ turnInFlight: true });
      const input = original.enqueueSessionUserMessageWithDisposition.mock.calls[1]![0];
      expect(original.consume({ role: 'user', content: { type: 'text', text: input.text }, localId: input.localId,
        authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
    }
    let retiring: Promise<void> | undefined;
    if (holdPublication) {
      await publishing;
      // Host publication is part of the admitted work, including the gap after
      // native turn-complete. It must hold the same canonical restart gate.
      expect.soft(original.manager.getPublic(started.runId)).toMatchObject({ turnInFlight: true });
      retiring = original.manager.dispose();
      releasePublication();
    }
    await vi.waitFor(() => {
      expect(original.manager.getStructuredMeta(started.runId)?.kind).toBe(narration ? 'scm_diff_summary.v1' : 'review_findings.v2');
      if (!holdPublication) expect(original.manager.getPublic(started.runId)).toMatchObject({ status: 'running', turnInFlight: false,
        inputTurns: { last: { state: 'completed' } } });
    });
    const findings = original.manager.getStructuredMeta(started.runId);
    if (operation === 'stop') expect(await original.manager.stop(started.runId)).toMatchObject({ ok: true });
    if (operation === 'restart') {
      retiringCallId = started.callId;
      // The daemon signals a real runner lifecycle, whose process boundary is
      // in-process here. A non-replying Home publisher is the network boundary.
      const processEvents = new EventEmitter();
      let runnerReady!: () => void;
      const ready = new Promise<void>(resolve => { runnerReady = resolve; });
      let runnerExited!: () => void;
      const exited = new Promise<void>(resolve => { runnerExited = resolve; });
      let releaseLoop!: () => void;
      const promptLoop = new Promise<void>(resolve => { releaseLoop = resolve; });
      let childrenDisposed!: () => void;
      const disposed = new Promise<void>(resolve => { childrenDisposed = resolve; });
      const base = createLifecycleParams();
      const session = Object.assign(base.session, {
        disposeExecutionRuns: async () => { await original.manager.dispose(); childrenDisposed(); },
      });
      const running = runSessionLoopLifecycle({ ...base, session,
        runtimeDirectory: directory,
        deps: { ...base.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
          runPermissionModePromptLoopFn: async () => { await promptLoop; },
          registerRunnerTerminationHandlersFn: input => {
            const handlers = registerRunnerTerminationHandlers({ ...input, process: processEvents,
              sessionExitReport: null, exit: () => { runnerExited(); releaseLoop(); } });
            runnerReady();
            return handlers;
          },
        },
      });
      const tracked: TrackedSession = { startedBy: 'daemon', pid: 4242, happySessionId: 'session-1',
        processStartTimeMs: 1, processCommandHash: 'runner-hash', vendorResumeId: 'parent-native-thread',
        processCommand: '/runtime/cli-dev/versions/0.3.0/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
        spawnOptions: { directory, backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, resume: 'parent-native-thread' },
      };
      const realKill = process.kill.bind(process);
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid !== tracked.pid) return realKill(pid, signal);
        expect(signal).toBe('SIGTERM');
        processEvents.emit('SIGTERM');
        return true;
      });
      try {
        await ready;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        expect(await restartSessionRunnerOnCurrentRuntime({
          request: { sessionId: 'session-1', mode: 'force_current_cli', reason: 'ui_stale_runner_banner' },
          tracked, currentIdentity: { status: 'known', source: 'launch_spec', comparableId: 'version:0.3.0', entrypointVersion: '0.3.0' },
          requestRestart: async input => await requestPlannedRunnerRestart({
            sessionId: input.sessionId, tracked, reason: input.reason, canSignal: input.canSignal,
            deferral: { kind: 'none' }, restartRequestedPids: new Set(), pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            isProcessSafeToSignal: async () => true,
            requestSignal: request => requestConnectedServiceSessionRestartSignal({ pid: tracked.pid, delayMs: 0,
              shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure,
              onProcessAlreadyMissing: request.onProcessAlreadyMissing }),
          }),
        })).toMatchObject({ ok: true, status: 'restarted' });
        const publicationBlocked = await Promise.race([publishing.then(() => true), disposed.then(() => false)]);
        // Exercise the runner's own existing termination budget only when the
        // network stalls disposal. Do not invent another completion timeout.
        if (publicationBlocked) await vi.runOnlyPendingTimersAsync();
        await exited;
        vi.useRealTimers();
        await reconcileRetainedExecutionRunRecords({ nowMs: Date.now(), isPidAlive: () => false });
        const record = (await readRetainedExecutionRunRecords()).find(record => record.state.runId === started.runId);
        expect(record, 'Completed narrated Review must survive runner exit and host-loss reconciliation').toMatchObject({ state: { status: 'succeeded' } });
        expect(disposedThreads).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        releasePublication();
        releaseLoop();
        kill.mockRestore();
        await original.manager.dispose();
        await running;
      }
    } else await (retiring ?? original.manager.dispose());
    const replacement = createHarness(false, true);
    const followUp = await replacement.manager.applyAction(started.runId, {
      actionId: 'review.follow_up', input: { findingIds: [], messageMarkdown: 'Why does this matter?' },
    });
    if (operation === 'stop' || outcome === 'failed') {
      expect(followUp, JSON.stringify(followUp)).toMatchObject({ ok: false, errorCode: 'review_follow_up_ended' });
      expect(requests.map(request => request.kind)).toEqual(['create']);
      return;
    }
    expect(followUp, JSON.stringify(followUp)).toMatchObject({ ok: true });
    expect(replacement.manager.getStructuredMeta(started.runId)).toEqual(findings);
    if (!followUp.ok || !followUp.result || typeof followUp.result !== 'object' || !('runId' in followUp.result)
      || typeof followUp.result.runId !== 'string') throw new Error('Expected follow-up Run identity');
    await replacement.manager.waitForTerminal(followUp.result.runId);
    expect(requests).toMatchObject([{ kind: 'create' }, { kind: 'resume', providerSessionId: 'retained-review-thread' }]);
    expect(replacement.manager.getStructuredMeta(followUp.result.runId)?.kind).toBe('review_follow_up.v1');
  });

  it.each([
    { recovered: false, settlement: 'complete' },
    { recovered: false, settlement: 'stop-child' },
    { recovered: true, settlement: 'stop-parent' },
    { recovered: false, settlement: 'complete', readFailure: true },
    { recovered: false, settlement: 'fail-child', readFailure: true },
    { recovered: true, settlement: 'stop-parent', readFailure: true },
    { recovered: false, settlement: 'complete', missingHandle: true },
  ])('keeps follow-up, ordinary recipient and narration input in the retained reviewer turn custody (recovered=$recovered, $settlement, readFailure=$readFailure, missingHandle=$missingHandle)', async ({ recovered, settlement, readFailure, missingHandle }) => {
    let releasePublication!: () => void;
    const publication = new Promise<void>(resolve => { releasePublication = resolve; });
    let publicationStarted = false;
    let followUpCallId: string | undefined;
    let verified = false;
    try {
      execFileSync('git', ['init', directory], { stdio: 'ignore' });
      const emitters: ((event: AgentSessionRuntimeEvent) => void)[] = [];
      const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
      nativeOpen.mockImplementation(async () => ({
        watch(next) { emitters.push(next); next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1', sequence: 1,
          sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
        send: sent, async dispose() {},
      }));
      const harness = createHarness(false, true, async (_provider, body) => {
        if (readFailure && body.type === 'tool-call') retainedReadFailure.armed = true;
        if (body.type === 'tool-result' && body.callId === followUpCallId) {
          publicationStarted = true;
          await publication;
        }
      });
      const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
      const findings = { runRef: { runId: 'run-1', callId: 'call-1', backendId: 'claude' },
        summary: 'Retained review', overviewMarkdown: '', findings: [], questions: [], assumptions: [], generatedAtMs: 2 };
      harness.runs.set('run-1', runState({ intent: 'review', status: 'succeeded', finishedAtMs: 2,
        ...(recovered ? { runClass: 'bounded' as const } : {}),
        backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        intentInput: { cwd: directory, comparisonId: captured.comparison.id },
        resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          providerSessionId: 'provider-session-1' }, structuredMeta: { kind: 'review_findings.v2', payload: findings },
      }));
      if (!recovered) {
        expect(await harness.manager.ensure('run-1', { resume: true })).toMatchObject({ ok: true });
        expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: false, lifecycle: { state: 'current' } });
        if (missingHandle) harness.runs.set('run-1', { ...harness.runs.get('run-1')!, resumeHandle: null });
      }
      const input = { messageMarkdown: 'First?', findingIds: [], threadId: 'finding-thread' };
      const first = await harness.manager.applyAction('run-1', { actionId: 'review.follow_up', input });
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { threadId: input.threadId } });
      if (!first.ok) throw new Error('Follow-up was refused');
      const childId = (first.result as { runId: string }).runId;
      followUpCallId = (first.result as { callId: string }).callId;
      await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
      // The child uses the incumbent native conversation, including when no
      // provider resume identity was published. Reopening it is a different path.
      expect(nativeOpen).toHaveBeenCalledOnce();
      if (readFailure) {
        // Local terminal observation must not depend on this global discovery.
        // The old observer consumes the EIO itself; a local join leaves it for
        // this independent discovery, which still reports the real read failure.
        if (!retainedReadFailure.failed) {
          await expect(harness.manager.recoverRetainedRuns()).rejects.toMatchObject({ code: 'EIO' });
        }
        expect(retainedReadFailure.failed).toBe(true);
      }
      expect(await harness.manager.applyAction('run-1', { actionId: 'review.follow_up', input: { ...input, messageMarkdown: 'Second?' } }))
        .toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: true });
      expect(await harness.manager.send('run-1', { message: 'Ordinary prompt' })).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(await harness.manager.send('run-1', { message: 'Intervention', delivery: 'interrupt' })).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(harness.consume({ role: 'user', content: { type: 'text', text: 'Ordinary recipient' }, localId: 'ordinary-during-follow-up',
        authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
      await vi.waitFor(() => expect(harness.inputOutcomes).toContainEqual(expect.objectContaining({
        kind: 'rejected_before_effect', localId: 'ordinary-during-follow-up', diagnostic: expect.objectContaining({ code: 'execution_run_busy' }),
      })));
      expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
        reviewRunIds: ['run-1'], comparisonId: captured.comparison.id,
      } })).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(sent).toHaveBeenCalledOnce();
      let stopping: ReturnType<ExecutionRunHostBridge['stop']> | undefined;
      if (settlement === 'complete' || settlement === 'fail-child') {
        const delivery = sent.mock.calls[0]![0];
        if (delivery.delivery.kind !== 'newTurn') throw new Error('Follow-up must be a native turn');
        const emit = emitters.at(-1)!;
        const turnId = delivery.delivery.turnId;
        emit({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 2, emittedAtMs: 2, inputIds: delivery.inputIds, delivery: delivery.delivery });
        emit({ kind: 'turn-start', sessionId: 'session-parent', sequence: 3, emittedAtMs: 3, turnId, startedBy: 'host' });
        if (settlement === 'fail-child') {
          emit({ kind: 'turn-failed', sessionId: 'session-parent', sequence: 4, emittedAtMs: 4, turnId,
            diagnostic: { code: 'native_turn_failed', message: 'Native turn failed', severity: 'error' } });
        } else {
          emit({ kind: 'message-delta', sessionId: 'session-parent', sequence: 4, emittedAtMs: 4, turnId, channel: 'assistant', text: JSON.stringify({ answerMarkdown: 'Answer.' }) });
          emit({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 5, emittedAtMs: 5, turnId });
        }
      } else {
        stopping = harness.manager.stop(settlement === 'stop-parent' ? 'run-1' : childId);
      }
      let parentStopped = false;
      if (stopping) void stopping.then(() => { parentStopped = true; });
      await vi.waitFor(() => expect(publicationStarted).toBe(true));
      // Terminal projection precedes durable transcript settlement. Custody is still exclusive.
      expect(await harness.manager.applyAction('run-1', { actionId: 'review.follow_up', input }))
        .toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: true });
      expect(parentStopped).toBe(false);
      releasePublication();
      if (stopping) expect(await stopping).toMatchObject({ ok: true });
      await harness.manager.waitForTerminal(childId);
      if (settlement === 'complete') {
        expect(harness.runs.get(childId)).toMatchObject({ status: 'succeeded', structuredMeta: { kind: 'review_follow_up.v1',
          payload: { parentRunRef: findings.runRef, threadId: input.threadId, answerMarkdown: 'Answer.' } } });
        const signal = new AbortController().signal;
        // Important keeps successful reports for a natural parent turn. The
        // same inbox retains the full Run pointer without waking the parent.
        expect(await harness.manager.takeWorkerUpdate('session-1', signal)).toBeNull();
        const reports = await harness.manager.prepareWorkerUpdates('session-1', { signal });
        const report = reports.find(({ update }) => update.workerId === childId);
        expect(report?.update).toMatchObject({
          ownerState: 'succeeded', result: 'Answer.', canInspect: true,
          transcriptPointer: { kind: 'execution_run', sessionId: 'session-1', runId: childId },
        });
        expect(await harness.manager.prepareWorkerUpdates('foreign-session', { signal })).toEqual([]);
        report!.acknowledgeAccepted();
        expect((await harness.manager.prepareWorkerUpdates('session-1', { signal }))
          .some(({ update }) => update.workerId === childId)).toBe(false);
      } else expect(harness.runs.get(childId)).toMatchObject({ status: settlement === 'fail-child' ? 'failed' : 'cancelled' });
      expect(harness.runs.get('run-1')?.structuredMeta).toEqual({ kind: 'review_findings.v2', payload: findings });
      if (settlement === 'stop-parent') {
        expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'cancelled' });
      } else {
        await vi.waitFor(() => expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: false }));
        expect(await harness.manager.applyAction('run-1', { actionId: 'review.follow_up', input: { ...input, messageMarkdown: 'After settlement?' } }))
          .toMatchObject({ ok: true });
        await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
        expect(nativeOpen).toHaveBeenCalledOnce();
      }
      verified = true;
    } finally {
      releasePublication();
      if (!verified) {
        // A failed custody assertion must not strand teardown of this disposable fixture.
        for (const manager of bridges) {
          const controller = (manager as unknown as { controllers: Map<string, ExecutionRunBackendController> }).controllers.get('run-1');
          if (controller) controller.delegatedTurn = undefined;
        }
      }
    }
  });
  it.each([
    ...([
      { surface: 'cli', authority: 'present_user', ioMode: 'streaming', completed: false, restricted: false },
      { surface: 'cli', authority: 'account_automation', ioMode: 'streaming', completed: false, restricted: false },
      { surface: 'cli', authority: 'present_user', ioMode: 'request_response', completed: false, restricted: false },
      { surface: 'cli', authority: 'present_user', ioMode: 'streaming', completed: true, restricted: false },
      { surface: 'cli', authority: 'account_automation', ioMode: 'streaming', completed: true, restricted: true },
      { surface: 'ui', authority: 'present_user', ioMode: 'streaming', completed: true, restricted: false },
    ] as const).map(row => ({ ...row, actionId: 'scm.diffSummary.refine' as const })),
    ...(['scm.diffSummary.addOutputs', 'scm.diffSummary.discuss'] as const).flatMap(actionId =>
      (['cli', 'ui'] as const).map(surface => ({ actionId, surface, authority: 'present_user' as const,
        ioMode: 'streaming' as const, completed: true, restricted: false }))),
  ])('admits $actionId through $surface credentials ($authority, $ioMode, completed=$completed, restricted=$restricted)', async ({ surface, authority, ioMode, completed, restricted, actionId }) => {
    const instructions = actionId === 'scm.diffSummary.addOutputs'
      ? 'Add the requested outputs: summary. Use the saved comparison and existing outputs. Publish the requested structured outputs.'
      : 'Shorten it.';
    const sessionId = 'c123456789012345678901234';
    const origin = 'http://refinement-home.test';
    const secret = new Uint8Array(32).fill(21);
    const tokenPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${tokenPart({ alg: 'none' })}.${tokenPart({ sub: 'account-1', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
    const credentials = { token, credentialProvenance: 'stored_session' as const, encryption: { type: 'legacy' as const, secret } };
    const rawSession = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'e2ee',
      metadata: encodeBase64(encryptLegacy({ machineId: 'machine-1', path: directory }, secret)) });
    let releaseNative!: () => void;
    nativeModule.ready = new Promise<void>(resolve => { releaseNative = resolve; });
    const nativeSend = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
    nativeOpen.mockImplementation(async () => ({
      watch(next) { next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1', sequence: 1,
        sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      send: nativeSend, async dispose() {},
    }));
    const harness = createHarness(false, false, async () => {}, sessionId);
    const comparison = ScmComparisonSchema.parse({ id: 'recovered-comparison', source: { kind: 'workingTree' },
      repository: { rootPath: directory }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
    const saved = await scmDiffSummaryResultStore.create({ cwd: directory, sessionId, output: {
      success: true, sourceKey: comparison.id, comparison, runId: 'run-1', requestedOutputs: ['walkthrough'],
      metadata: { source: comparison.source, sourceKey: comparison.id },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
      outputs: { walkthrough: { state: 'complete', value: { title: 'Saved', intro: '', stops: [], otherChangeRefs: [] } } },
    } });
    harness.runs.set('run-1', runState({ sessionId, status: 'failed', finishedAtMs: 2, intent: 'scm_diff_summary', ioMode,
      error: { code: 'execution_run_host_lost', message: 'Host lost' },
      launch: { cwd: directory }, intentInput: { cwd: directory, comparisonId: comparison.id, resultId: saved.resultId,
        comparison, metadata: saved.output.metadata, sourceKey: comparison.id, outputs: ['walkthrough'] },
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: saved.output },
    }));
    const installation = nacl.sign.keyPair();
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [
      actionId, 'execution.run.get', 'execution.run.ensure',
    ] }, targets: { sessions: [sessionId], machines: ['machine-1'] } };
    const externalActionCredential = { accountId: 'account-1', principalId: 'refine-principal', credentialId: 'refine-pat', grant };
    const authorization = completed ? ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: randomUUID(), binding: {
      serverIdentityId: 'srv_refinement', accountId: 'account-1', custodianAccountId: 'account-1',
      ...(restricted ? externalActionCredential : { authentication: { kind: surface === 'ui' ? 'account' : 'terminal', tokenEpoch: 1 } }),
      machineId: 'machine-1', accountEncryptionMode: 'e2ee',
      installationId: 'refine-installation', actionId, requestId: 'refine-request',
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine-1' },
    } }) : undefined;
    const app = fastify();
    const admitted: string[] = [];
    const boundaryFailures: unknown[] = [];
    const receivedAuthorities: ActionExecutorContext['authority'][] = [];
    let standaloneSessionDispatches = 0;
    let recovery: Promise<void> | undefined;
    harness.listExecutionRunPendingDeliveryStatuses.mockImplementation(async () => harness.pendingInputs.map(input => ({
      localId: input.localId!, status: 'queued' as const, deliveryStatus: { status: 'queued' as const },
    })));
    const deps = (machineAdmissionTransport?: Parameters<typeof createCliActionDeps>[0]['machineAdmissionTransport']) => createCliActionDeps({
      token, credentials, sessionId, mode: 'e2ee', ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, rawSession,
      serverId: 'cloud', serverHttpBaseUrl: origin, serverIdentityId: 'srv_refinement',
      ...(authorization ? { externalActionMachineInstallationId: 'refine-installation',
        externalActionMachineRequestPrivateKey: installation.secretKey,
        invokeBoundSessionRpc: async (method, input) => method === SESSION_RPC_METHODS.EXECUTION_RUN_GET
          ? { run: harness.manager.getPublic((input as { runId: string }).runId) }
          : { ok: false, errorCode: 'unsupported_method' } } : {}),
      resolveServerFeaturesSnapshot: () => undefined,
      ...(machineAdmissionTransport ? { machineAdmissionTransport } : {}),
    });
    // HTTP is the boundary. Home's signed-root contract rejects a substituted
    // child effect; verify actual producer signatures, not a canned header.
    app.addHook('preHandler', async (request, reply) => {
      if (!authorization) return;
      const effect = request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
      const encodedTarget = request.headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER];
      const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
      const target = typeof encodedTarget === 'string' ? decodeExternalActionResolvedTargetV1(encodedTarget) : null;
      if (effect !== authorization.binding.actionId || target?.kind !== 'machine' || target.machineId !== 'machine-1' || typeof signature !== 'string'
        || request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== authorization.token
        || !verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: effect,
          target, installationId: 'refine-installation', requestId: authorization.binding.requestId,
          method: request.method, path: request.url, signature, publicKey: installation.publicKey })) {
        return reply.code(401).send({ error: 'invalid_token' });
      }
    });
    const daemonDeps = deps(async (request, options) => {
      try {
        if (authorization) {
          expect(options?.callerInputAuthorization?.token).toBe(authorization.token);
          expect(options?.callerInputAuthorization?.binding).toBe(authorization.binding);
          expect(options?.callerInputAuthorization?.scmRefineSession?.sessionId).toBe(sessionId);
          expect(verifyScmRefineSavedSessionV1(options!.callerInputAuthorization!, installation.publicKey)).toBe(true);
        }
        expect(request).toMatchObject({ v: 2, sessionId, targetMachineId: 'machine-1', recipient: { kind: 'execution_run', runId: 'run-1' },
          requestedAction: { v: 1, kind: actionId === 'scm.diffSummary.refine' ? 'send_now' : 'steer_if_active' } });
        if (request.content.t !== 'encrypted') throw new Error('Expected encrypted Pending input');
        const message = UserMessageSchema.parse(decrypt(secret, 'legacy', decodeBase64(request.content.c)));
        expect(message.meta).toMatchObject(surface === 'ui'
          ? { happierProvenanceV1: { kind: 'host', producer: 'happierApp' },
            happierInputRequestV1: { producer: 'happierApp', caller: { kind: 'host' } } }
          : { happierProvenanceV1: { kind: 'cli' },
            happierInputRequestV1: { producer: 'cli', caller: { kind: 'host' } } });
        // The admitted receiver carries the host-only presentation fact in the
        // encrypted Pending record, never as a public Session-send input field.
        expect(readMessageDisplayText({ text: message.content.text, displayText: message.meta?.displayText }) === instructions).toBe(true);
        expect(message.content.text.includes(saved.resultId)).toBe(true);
        expect(message.content.text.includes(instructions)).toBe(true);
        harness.pendingInputs.push({ ...message, localId: request.localId, authorAccountId: 'account-1', inputAdmissionReceipt: null,
          pendingProviderAction: 'send' });
        admitted.push(request.localId);
        // The Session pending-change boundary schedules reconciliation after durable admission.
        recovery = harness.notifyPendingTarget('run-1');
        return { status: 'accepted', localId: request.localId };
      } catch (error) { boundaryFailures.push(error); throw error; }
    });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'e2ee', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/encryption', async () => ({ mode: 'e2ee', updatedAt: 1 }));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: rawSession }));
    app.post('/v1/actions/session.message.send', async () => {
      standaloneSessionDispatches++;
      throw new Error('An admitted SCM receiver must use its Machine input transport');
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    let response: unknown;
    let settled = false;
    let action: Promise<void> | undefined;
    try {
      const caller = deps(); // Standalone caller retained for the wrong-target refusal below.
      if (completed) {
        // Install the real retained controller, rather than labelling an orphaned
        // Run "running" with no interaction capabilities.
        releaseNative();
        expect(await harness.manager.ensure('run-1', { resume: true })).toMatchObject({ ok: true });
        const controller = harness.controllers.get('run-1') as ExecutionRunBackendController | undefined;
        if (controller?.kind !== 'backend') throw new Error('Expected the retained backend controller');
        // A live controller, not the persisted Run snapshot, owns its last turn.
        controller.lastInputTurn = { turnId: 'original-turn', inputIds: ['original-input'], state: 'completed' };
        expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'running', turnInFlight: false,
          inputTurns: { last: { state: 'completed', inputIds: ['original-input'] } },
          interaction: { kind: 'retained_agent_session.v1' } });
      }
      // createCliActionExecutorFromCredentials routes the original Refine Action
      // to its Machine before this owner runs. That admitted receiver has the
      // installed Machine transport; running this host expansion on a standalone
      // caller invented a second public Session-send hop with private fields.
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), sessionSendMessage: async input => {
        receivedAuthorities.push(input.context?.authority);
        return daemonDeps.sessionSendMessage(input);
      },
        executionRunGet: async () => ({ run: harness.manager.getPublic('run-1') }),
        executionRunEnsure: async () => await harness.manager.ensure('run-1', { resume: true }),
        scmActionExecute: async ({ actionId, input, context, executeCanonicalAction }) => executeScmActionOperation({ actionId, input,
          workingDirectory: directory, sessionId, authorizeSession: async id => id === sessionId, actionContext: context, executeCanonicalAction }),
      });
      action = runWithServerHttpBaseUrl(origin, () => executor.execute(actionId, {
        cwd: directory, resultId: saved.resultId, expectedRevision: saved.revision,
        ...(actionId === 'scm.diffSummary.refine' ? { output: 'walkthrough', instructions }
          : actionId === 'scm.diffSummary.addOutputs' ? { outputs: ['summary'] } : { message: instructions }),
      }, { surface, authority, serverIdentityId: 'srv_refinement',
        ...(restricted ? { externalActionCredential } : {}),
        ...(authorization ? { externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
          signExternalActionApprovalInput: (args: Parameters<NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>>[0]) => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
            actionId: args.actionId, target: args.target, input: args.input, privateKey: installation.secretKey }) } : {}) })).then(result => {
        response = result;
        settled = true;
      });
      if (completed) {
        await action;
        expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { success: true, runId: 'run-1', inputId: expect.any(String) } });
      } else {
        await vi.waitFor(() => expect(harness.controllers.has('run-1')).toBe(true));
        expect(settled).toBe(false);
        expect(admitted).toHaveLength(0);
        expect(nativeOpen).not.toHaveBeenCalled();
        expect(nativeSend).not.toHaveBeenCalled();
      }
      releaseNative();
      await action;
      expect(boundaryFailures).toEqual([]);
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { success: true, runId: 'run-1' } });
      expect(admitted).toHaveLength(1);
      expect(response).toMatchObject({ result: { inputId: admitted[0] } });
      expect(receivedAuthorities).toEqual([authority]);
      expect(standaloneSessionDispatches).toBe(0);
      if (restricted) {
        expect(await executor.execute('session.message.send', { sessionId, message: 'Direct send is not Refine',
          localId: 'direct', recipient: { kind: 'execution_run', runId: 'run-1' }, requestedAction: { v: 1, kind: 'send_now' } },
        { surface: 'api', authority, externalActionCredential,
          externalActionExecutionAuthorization: authorization, externalActionTarget: authorization!.binding.target }))
          .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      }
      // The original credential rows also exercise standalone wrong-target
      // refusal; the signed-root Home fixture deliberately rejects bearer reads.
      if (!completed) {
        const refused = await runWithServerHttpBaseUrl(origin, () => caller.sessionSendMessage({
          sessionId, message: 'Wrong target', recipient: { kind: 'execution_run', runId: 'run-1' }, localId: 'wrong-target',
          requestedAction: { v: 1, kind: 'send_now' },
          callerSurface: 'cli', actionCaller: { kind: 'host' }, context: { surface: 'cli', authority,
            externalActionTarget: { kind: 'machine', machineId: 'other-machine' } },
        }));
        expect(refused).toEqual({ status: 'rejected', code: 'session_input_target_unavailable' });
      }
      expect(admitted).toHaveLength(1);
      await recovery;
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(nativeSend, JSON.stringify({ run: harness.manager.getPublic('run-1'),
        outcomes: harness.inputOutcomes })).toHaveBeenCalledOnce());
      expect(nativeSend.mock.calls[0]![0].inputIds).toEqual(admitted);
      expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
      expect(harness.runs.size).toBe(1);
      expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'running', lifecycle: { state: 'current' } });
    } finally {
      releaseNative();
      await action;
      await recovery;
      restore();
      await app.close();
    }
  });

  it.each([false, true])('reads retained original review findings after narration without disclosing them across Run scope (detached=%s)', async detached => {
    const harness = createHarness(detached);
    const sessionId = detached ? null : 'session-1';
    const finding = { runRef: { runId: 'run-1', callId: 'call-1', backendId: TEST_BACKEND_ID },
      generatedAtMs: 2, summary: 'Original review', overviewMarkdown: 'Original review', findings: [{ id: 'f1', title: 'Original finding',
        category: 'correctness', severity: 'high', summary: 'Original diagnosis' }] };
    harness.runs.set('run-1', runState({ sessionId, intent: 'review', status: 'succeeded',
      launch: { cwd: directory }, intentInput: { reviewNarration: { reviewFindings: [finding] } },
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: {} } }));
    const rpc = createExecutionRunRpcActionDeps({ manager: harness.manager, context: { sessionId, cwd: directory },
      isExecutionRunsEnabled: () => true, policy: { boundedTimeoutMs: null,
        reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
    const observed = ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!(sessionId, { runId: 'run-1', includeStructured: true }));
    expect(observed).toMatchObject({ structuredMeta: { kind: 'scm_diff_summary.v1' },
      reviewFindings: { runRef: finding.runRef, findings: [{ id: 'f1' }] } });
    expect(await rpc.executionRunGet!(sessionId, { runId: 'run-1' })).not.toHaveProperty('reviewFindings');
    expect(await rpc.executionRunGet!(detached ? 'private-session' : null, { runId: 'run-1', includeStructured: true }))
      .toMatchObject({ ok: false, errorCode: 'execution_run_scope_mismatch' });
    harness.runs.set('run-1', { ...harness.runs.get('run-1')!, intentInput: {
      reviewNarration: { reviewFindings: [{ ...finding, runRef: { ...finding.runRef, runId: 'other-run' } }] } } });
    expect(await rpc.executionRunGet!(sessionId, { runId: 'run-1', includeStructured: true })).not.toHaveProperty('reviewFindings');
  });
  it.each([
    { walkthrough: false }, { walkthrough: true }, { walkthrough: true, modelId: 'claude-haiku-5-5' },
  ])('admits a Review with its native default or explicit model through composed Action admission (walkthrough=$walkthrough, model=$modelId)', async ({ walkthrough, modelId }) => {
    execFileSync('git', ['init', directory], { stdio: 'ignore' });
    writeFileSync(join(directory, 'code.ts'), 'export const enabled = false;\n');
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
    const nativeSend = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
    nativeOpen.mockImplementation(async () => ({ watch() { return { dispose() {} }; }, send: nativeSend, async dispose() {} }));
    const harness = createHarness(false, true);
    const rpc = createExecutionRunRpcActionDeps({ manager: harness.manager, context: { sessionId: 'session-1', cwd: directory },
      isExecutionRunsEnabled: () => true, policy: { boundedTimeoutMs: null,
        reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...rpc,
      reviewEnginesList: async () => ({ items: await buildReviewEngineInventoryItems({}) }),
    });
    const input = ReviewStartInputSchema.parse({ sessionId: 'session-1', engineIds: ['claude'], instructions: 'Review these changes.',
      comparisonId: captured.comparison.id,
      ...(modelId ? { modelId } : {}), ...(walkthrough ? { outputs: ['walkthrough'] } : {}),
    });
    const result = await executor.execute('review.start', input, { surface: 'cli', authority: 'present_user' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { results: [{ ok: true }] } });
    await vi.waitFor(() => expect(harness.runs.size).toBe(1));
    const run = [...harness.runs.values()][0]!;
    expect(run.backendId).toBe('claude');
    expect(run.launch?.modelId).toBe(modelId);
    await vi.waitFor(() => expect(nativeOpen).toHaveBeenCalledOnce());
    expect(nativeOpen.mock.calls[0]![0].configuration?.model?.value ?? null).toBe(modelId ?? null);
    if (walkthrough) expect(harness.enqueueSessionUserMessageWithDisposition).toHaveBeenCalledOnce();
    else await vi.waitFor(() => expect(nativeSend).toHaveBeenCalledOnce());
  });

  it('delivers attached Review JSON guidance and prepares a findings-first detached review using the same runtime fixture', async () => {
    {
      execFileSync('git', ['init', directory], { stdio: 'ignore' });
      execFileSync('git', ['-C', directory, 'config', 'user.name', 'Review fixture']);
      execFileSync('git', ['-C', directory, 'config', 'user.email', 'review@example.invalid']);
      writeFileSync(join(directory, 'code.ts'), 'export const enabled = false;\n');
      execFileSync('git', ['-C', directory, 'add', 'code.ts']);
      execFileSync('git', ['-C', directory, 'commit', '-m', 'fixture'], { stdio: 'ignore' });
      // An added line has an unambiguous after-side location. A replacement
      // at line one would correctly remain unmapped without a side anchor.
      writeFileSync(join(directory, 'code.ts'), 'export const enabled = false;\nexport const additional = true;\n');
      const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' } });
      const prepared = await ReviewProfile.prepareStartParams!({ cwd: directory, sessionId: null, request: {
        intent: 'review', instructions: 'Review.', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        intentInput: { cwd: '/untrusted-root', comparisonId: captured.comparison.id, outputs: ['walkthrough'] },
      } });
      expect(prepared).toMatchObject({ intentInput: { cwd: directory, comparison: captured.comparison, outputs: ['walkthrough'] } });
      let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
      nativeOpen.mockImplementation(async () => ({
        watch(next) { emit = next; next({ kind: 'provider-session-id', providerSessionId: 'provider-review', sequence: 1,
          sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; }, send: sent, async dispose() {},
      }));
      const harness = createHarness(true);
      const started = await harness.manager.start({ sessionId: null, cwd: directory, intent: 'review',
        resolvedRole: resolveExecutionRunRoleV1({ roleId: 'reviewer', accountRoleOverrides: { status: 'ready', overrides: {} } }),
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id,
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', instructions: 'Review.',
        intentInput: { comparisonId: captured.comparison.id, outputs: ['walkthrough'] } });
      await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
      let sequence = 1;
      const finishTurn = (request: Parameters<AgentSessionRuntime['send']>[0], text: string) => {
        if (request.delivery.kind !== 'newTurn') throw new Error('Expected native review turn');
        const turnId = request.delivery.turnId;
        emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence, inputIds: request.inputIds, delivery: request.delivery });
        emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence, turnId, startedBy: 'host' });
        emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence, turnId, channel: 'assistant', text });
        emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: sequence, turnId });
      };
      finishTurn(sent.mock.calls[0]![0], JSON.stringify({ summary: 'A changed condition', findings: [
        { id: 'f1', title: 'Changed condition', category: 'correctness', severity: 'high', summary: 'Check the changed condition', filePath: 'code.ts', startLine: 2 },
      ] }));
      await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
      finishTurn(sent.mock.calls[1]![0], JSON.stringify({ walkthrough: { title: 'Condition update', intro: 'One changed condition',
        stops: [{ id: 'condition', title: 'Condition', explanationMarkdown: 'The flag changed', changeRefs: ['c1'] }], otherChangeRefs: [] } }));
      const input = harness.runs.get(started.runId)!.intentInput as { resultId: string };
      await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: directory, resultId: input.resultId })).toMatchObject({ success: true,
        result: { output: { runId: started.runId, producer: { kind: 'review' }, outputs: { walkthrough: { value: { title: 'Condition update' } } } } } }));
      const saved = await scmDiffSummaryResultStore.read({ cwd: directory, resultId: input.resultId });
      if (!saved.success) throw new Error('Detached review result was not saved');
      // Detached turn completion publishes outside pendingHostBarrier. The
      // saved artifact can become readable before that completion loop projects
      // the Run, so wait at the public observation boundary itself.
      const rpc = createExecutionRunRpcActionDeps({ manager: harness.manager, context: { sessionId: null, cwd: directory },
        isExecutionRunsEnabled: () => true, policy: { boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
      await vi.waitFor(async () => {
        const observed = ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!(null, { runId: started.runId, includeStructured: true }));
        expect(observed).toMatchObject({ structuredMeta: { kind: 'scm_diff_summary.v1' },
          reviewFindings: { runRef: { runId: started.runId }, findings: [{ id: 'f1' }] } });
      });
      const explanation = await harness.manager.applyAction(started.runId, { actionId: 'review.explain_findings', input: {
        reviewRunIds: [started.runId], cwd: directory, resultId: input.resultId, expectedRevision: saved.result.revision,
        findingIds: [{ runId: started.runId, findingId: 'f1' }],
      } });
      expect(explanation, JSON.stringify(explanation)).toMatchObject({ ok: true, result: { refinement: { input: { stopIds: ['condition'] } } } });
      expect(harness.runs.size).toBe(1);
      expect(harness.runs.get(started.runId)?.sessionId).toBeNull();
      expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
      // Exercise attached Pending after the exact repository comparison has
      // published, so the attached Run's activity files cannot enter that diff.
      const attachedSent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
      nativeOpen.mockImplementation(async () => ({ watch() { return { dispose() {} }; }, send: attachedSent, async dispose() {} }));
      const attached = createHarness();
      await attached.manager.start({ sessionId: 'session-1', cwd: directory, intent: 'review',
        resolvedRole: resolveExecutionRunRoleV1({ roleId: 'reviewer', accountRoleOverrides: { status: 'ready', overrides: {} } }),
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        instructions: 'Inspect the changed condition.' });
      await attached.firstEnqueuedInput;
      const pending = attached.enqueueSessionUserMessageWithDisposition.mock.calls[0]![0];
      await vi.waitFor(() => expect(attached.consume({ role: 'user', content: { type: 'text', text: pending.text },
        localId: pending.localId, authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true));
      await vi.waitFor(() => expect(attachedSent).toHaveBeenCalledOnce());
      const text = attachedSent.mock.calls[0]![0].input.text;
      expect(text).toContain('Inspect the changed condition.');
      expect(text).toContain('"findings": Array<');
      expect(text).toContain('"overviewMarkdown": string');
    }
  });
  it.each(['continued_review', 'seeded_narrator'] as const)('admits a detached %s walkthrough from exact captured evidence through native Run input custody', async mode => {
    let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
    nativeOpen.mockImplementation(async () => ({
      watch(next) { emit = next; next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1', sequence: 1,
        sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      send: sent, async dispose() {},
    }));
    const harness = createHarness(true);
    const narrator = (await buildReviewEngineInventoryItems({})).find(item => item.backendId === 'claude' && item.enabled && item.capabilities.structuredNarration)!;
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]!.id;
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' } });
    const review = runState({ sessionId: null, intent: 'review', status: 'succeeded', runClass: 'bounded', finishedAtMs: 2,
      requesterWorkAttributionV1: { serverId: 'home-1', accountId: 'account-1', machineId: 'machine-1', installationId: 'installation-1' },
      resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: narrator.backendId, sourceKind: 'built_in' }, providerSessionId: 'provider-session-1' },
      ...(mode === 'seeded_narrator' ? { retentionPolicy: 'ephemeral' as const, resumeHandle: undefined } : {}),
      backendId: narrator.backendId, backendTarget: { kind: 'builtInAgent', agentId: narrator.backendId },
      launch: { cwd: directory, modelId }, intentInput: { cwd: directory, comparisonId: captured.comparison.id },
      structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'run-1', callId: 'call-1', backendId: narrator.backendId },
        summary: 'Findings', overviewMarkdown: 'Completed review', findings: [], questions: [], assumptions: [], generatedAtMs: 2 } } });
    harness.runs.set('run-1', review);
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id, narrator: { engineId: narrator.engineId },
    } });
    expect(acted, JSON.stringify(acted)).toMatchObject({ ok: true });
    if (!acted.ok) throw new Error('Detached narration was refused');
    const response = ReviewWalkthroughResponseSchema.parse(acted.result);
    expect(response).toMatchObject({ mode, comparison: captured.comparison });
    const runId = response.runId;
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
    expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
    expect(harness.runs.get(runId)).toMatchObject({ sessionId: null, launch: { cwd: directory },
      requesterWorkAttributionV1: review.requesterWorkAttributionV1 });
    const delivery = sent.mock.calls[0]![0];
    expect(JSON.stringify(delivery)).toContain(mode === 'continued_review' ? 'Do not repeat the review' : 'reading the diffs, not reviewing them');
    if (delivery.delivery.kind !== 'newTurn') throw new Error('Detached narration must be a native turn');
    const turnId = delivery.delivery.turnId;
    emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 2, emittedAtMs: 2, inputIds: delivery.inputIds, delivery: delivery.delivery });
    emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: 3, emittedAtMs: 3, turnId, startedBy: 'host' });
    emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: 4, emittedAtMs: 4, turnId, channel: 'assistant',
      text: JSON.stringify({ walkthrough: { title: 'Detached narration', intro: '', stops: [], otherChangeRefs: [] } }) });
    emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 5, emittedAtMs: 5, turnId });
    const input = harness.runs.get(runId)!.intentInput as { resultId: string };
    await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: directory, resultId: input.resultId })).toMatchObject({ success: true,
      result: { output: { runId, producer: { kind: 'review' }, outputs: { walkthrough: { value: { title: 'Detached narration' } } } } } }));
    const savedScope = await scmDiffSummaryResultStore.readStoredScope({ cwd: directory, resultId: input.resultId });
    expect(savedScope).toMatchObject({ cwd: directory });
    expect(savedScope?.sessionId).toBeUndefined();
    const privateCapture = await captureScmComparison({ cwd: directory, source: { kind: 'session', sessionId: 'private-session' }, sessionId: 'private-session' });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: privateCapture.comparison.id,
    } })).toMatchObject({ ok: false, errorCode: 'comparison_unavailable' });
    harness.runs.set('foreign-root', { ...review, runId: 'foreign-root', launch: { cwd: join(directory, 'other') }, intentInput: { cwd: join(directory, 'other') } });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1', 'foreign-root'], comparisonId: captured.comparison.id,
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
    harness.runs.set('foreign-home', { ...review, runId: 'foreign-home', requesterWorkAttributionV1: { ...review.requesterWorkAttributionV1!, serverId: 'home-2' } });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1', 'foreign-home'], comparisonId: captured.comparison.id,
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
    harness.runs.set('legacy-owner', { ...review, runId: 'legacy-owner', requesterWorkAttributionV1: undefined });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1', 'legacy-owner'], comparisonId: captured.comparison.id,
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
    const privateResult = await scmDiffSummaryResultStore.create({ cwd: directory, sessionId: 'private-session', output: {
      success: true, sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
      requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'pending' } },
      analysis: { suppliedChangeRefs: captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id)),
        analysedChangeRefs: [], remainingChangeRefs: captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id)) },
    } });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input: {
      reviewRunIds: ['run-1'], cwd: directory, resultId: privateResult.resultId, expectedRevision: privateResult.revision,
      findingIds: [{ runId: 'run-1', findingId: 'finding-1' }],
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
  });
  it.each([false, true])('explains only exact current host findings in their matching saved stops (detached=%s)', async detached => {
    const harness = createHarness(detached);
    const sessionScope = detached ? {} : { sessionId: 'session-1' };
    const comparison = ScmComparisonSchema.parse({ id: 'captured', source: { kind: 'workingTree' }, repository: { rootPath: directory },
      endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{ path: 'new.ts', previousPath: 'old.ts', changeKind: 'renamed',
        binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: '@@ -20,2 +10,2 @@' },
        occurrences: [{ id: 'change-1', alias: 'c1', path: 'new.ts', position: 0, before: { startLine: 20, lineCount: 2 }, after: { startLine: 10, lineCount: 2 } },
          { id: 'change-2', alias: 'c2', path: 'new.ts', position: 1, before: { startLine: 40, lineCount: 2 }, after: { startLine: 30, lineCount: 2 } }] }] } });
    const saved = await scmDiffSummaryResultStore.create({ cwd: directory, ...sessionScope, output: { success: true,
      sourceKey: comparison.id, comparison, runId: 'run-1', metadata: { source: comparison.source, sourceKey: comparison.id }, requestedOutputs: ['walkthrough'],
      analysis: { suppliedChangeRefs: ['change-1', 'change-2'], analysedChangeRefs: ['change-1', 'change-2'], remainingChangeRefs: [] },
      outputs: { walkthrough: { state: 'complete', value: { title: 'Changes', intro: '', stops: [
        { id: 'target', title: 'Target', explanationMarkdown: 'Original', changeRefs: ['change-1'], findingRefs: ['run-1:f1'] },
        { id: 'unrelated', title: 'Keep me', explanationMarkdown: 'Unrelated prose', changeRefs: ['change-2'] }], otherChangeRefs: [] } } } } });
    const runRef = { runId: 'run-1', callId: 'call-1', backendId: TEST_BACKEND_ID };
    await scmDiffSummaryResultStore.beginInput({ cwd: directory, ...sessionScope, resultId: saved.resultId,
      inputId: 'published-narration', outputs: ['walkthrough'], reviewFindingCitations: [{ alias: 'F1', runId: 'run-1', findingId: 'f1' }] });
    await scmDiffSummaryResultStore.abandonInput({ cwd: directory, ...sessionScope, resultId: saved.resultId, inputId: 'published-narration' });
    const finding = { id: 'f1', title: 'Issue', category: 'correctness', severity: 'high', summary: 'Old diagnosis', filePath: 'new.ts', startLine: 10 };
    const review = runState({ sessionId: detached ? null : 'session-1', intent: 'review', launch: { cwd: directory },
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: saved.output },
      intentInput: { cwd: directory, comparisonId: comparison.id, reviewNarration: { reviewStatus: 'succeeded', reviewFindings: [{ runRef,
        summary: 'Findings', overviewMarkdown: 'Findings', findings: [finding], questions: [], assumptions: [], generatedAtMs: 1 }] } } });
    harness.runs.set('run-1', review);
    harness.runs.set('follow-up', { ...review, runId: 'follow-up', callId: 'follow-up-call', status: 'succeeded', structuredMeta: {
      kind: 'review_follow_up.v1', payload: { parentRunRef: runRef, threadId: 'thread', findingIds: ['f1'], requestMarkdown: 'Clarify',
        answerMarkdown: 'Clarified', generatedAtMs: 2, updatedFindings: [{ ...finding, summary: 'Current diagnosis' }] } } });
    const input = { reviewRunIds: ['run-1'], cwd: directory, resultId: saved.resultId, expectedRevision: saved.revision,
      findingIds: [{ runId: 'run-1', findingId: 'f1' }], instructions: 'Keep this human request unchanged.' };
    const privateSource = await scmDiffSummaryResultStore.create({ cwd: directory, ...sessionScope, output: {
      ...saved.output,
      success: true, sourceKey: comparison.id, comparison: { ...comparison, source: { kind: 'session', sessionId: 'private-session' } },
      metadata: { source: { kind: 'session', sessionId: 'private-session' }, sourceKey: comparison.id },
    } });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input: {
      ...input, resultId: privateSource.resultId, expectedRevision: privateSource.revision,
    } })).toMatchObject({ ok: false, errorCode: 'review_context_unavailable' });
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input });
    expect(acted).toMatchObject({ ok: true, result: { refinement: { actionId: 'scm.diffSummary.refine', input: { output: 'walkthrough', stopIds: ['target'] } } } });
    expect(JSON.stringify(acted)).toContain('Current diagnosis');
    expect(JSON.stringify(acted)).not.toContain('Old diagnosis');
    if (!acted.ok) throw new Error('Finding explanation preparation failed');
    const refinement = ScmDiffSummaryRefineInputSchema.parse((acted.result as { refinement: { input: unknown } }).refinement.input);
    expect(refinement.instructions).toContain('"id":"F1"');
    expect(refinement.instructions).not.toContain('"id":"f1"');
    expect(refinement.instructions).toContain(input.instructions);
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input: { ...input,
      findingIds: [{ runId: 'foreign-run', findingId: 'f1' }] } })).toMatchObject({ ok: false, errorCode: 'review_finding_unmapped' });
    expect(await scmDiffSummaryResultStore.read({ cwd: directory, ...sessionScope, resultId: saved.resultId })).toMatchObject({ success: true,
      result: { revision: saved.revision, output: { outputs: { walkthrough: { value: { stops: [{ id: 'target', explanationMarkdown: 'Original' },
        { id: 'unrelated', explanationMarkdown: 'Unrelated prose' }] } } } } } });
    let sent: { message: string; localId: string } | undefined;
    // RPC transport is the boundary; the generic Action's prompt, admission and saved writer remain real.
    const executeCanonicalAction: Parameters<ScmActionExecute>[0]['executeCanonicalAction'] = async (actionId, actionInput) => {
      if (actionId === 'execution.run.get') return { ok: true, result: ExecutionRunGetResponseSchema.parse({ run: {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'review', status: 'running', startedAtMs: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
        runClass: 'long_lived', ioMode: 'streaming', lifecycle: { v: 1, state: 'current' },
        interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
      } }) };
      if (actionId !== (detached ? 'execution.run.send' : 'session.message.send')) throw new Error('Explanation must target the saved generator');
      const message = actionInput as { message: string; localId?: string; localInputId?: string };
      sent = { message: message.message, localId: (message.localId ?? message.localInputId)! };
      if (detached) return { ok: true, result: { ok: true } };
      return { ok: true, result: { status: 'accepted', localId: sent.localId } };
    };
    await updateSettings(settings => ({ ...settings, machineIdByServerId: {
      ...settings.machineIdByServerId, [configuration.activeServerId]: 'machine-1',
    } }));
    // review.explain_findings returns a request, not authority. Its host child
    // retains the person/agent caller (protocol actionExecutor.ts). The real SCM
    // receiver consumes signed requester custody or the admitted Machine stamp
    // projected by registerActionSpecRpcHandlers.ts. Exercise that owner rather
    // than an authorizeSession callback that always denies detached provenance.
    const scm = createCliActionDeps({ token: 'finding-explanation-requester',
      credentials: { token: 'finding-explanation-requester', encryption: null },
      sessionId: '', mode: 'plain', ctx: null,
      scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [directory] },
    }).scmActionExecute;
    if (!scm) throw new Error('Canonical SCM Action owner unavailable');
    const context: RpcActionExecutorContext = { surface: 'rpc', authority: 'present_user',
      serverId: configuration.activeServerId,
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory } },
      ...(detached ? {
        machineAdmission: { actorAccountId: 'account-1', custodianAccountId: 'account-1', machineId: 'machine-1',
          installationId: 'installation-1', role: 'manage', encryptionMode: 'plain' },
        // Home currentness is the transport boundary, not a replacement domain decision.
        verifyMachineAdmissionCurrent: async () => true,
      } : { defaultSessionId: 'session-1', rpcSessionAuthorization: { kind: 'session.write', sessionId: 'session-1' } }),
    };
    const refine = (caller: RpcActionExecutorContext) => scm({
      actionId: 'scm.diffSummary.refine', input: refinement, context: caller, executeCanonicalAction,
    });
    if (detached) {
      for (const denied of [
        { ...context, machineAdmission: undefined },
        { ...context, verifyMachineAdmissionCurrent: async () => false },
        { ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'shared-member', role: 'use' as const } },
        { ...context, rpcSessionAuthorization: { kind: 'session.write' as const, sessionId: 'unrelated-session' } },
      ]) {
        expect(await refine(denied)).toMatchObject({ success: false, errorCode: 'result_unavailable' });
      }
      expect(sent).toBeUndefined();
    }
    expect(await refine(context)).toMatchObject({ success: true, runId: 'run-1' });
    expect(sent?.message).toContain('"id":"F1"');
    expect(sent?.message).not.toContain('"id":"f1"');
    expect(await scmDiffSummaryResultStore.publish({ cwd: directory, ...sessionScope, resultId: saved.resultId, inputId: sent!.localId,
      modelOutput: { reviewExplanations: [{ stopId: 'target', markdown: '[current](finding:F1)' }] } }))
      .toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
        { explanationMarkdown: 'Original', reviewExplanations: [{ markdown: '[current](finding:run-1:f1)' }] },
        { id: 'unrelated', explanationMarkdown: 'Unrelated prose' },
      ] } } } } } });
  });
  it.each(['collect', 'cancel', 'rejected', 'outcomeUnknown'] as const)('returns one deferred narrator identity immediately and owns %s through its existing lifetime', async (outcome) => {
    nativeOpen.mockImplementation(async () => ({
      watch(next) { next({ kind: 'provider-session-id', providerSessionId: 'narrator-session', sequence: 1, sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      async send() { return { status: 'admitted' as const }; }, async dispose() {},
    }));
    const harness = createHarness();
    const narrator = (await buildReviewEngineInventoryItems({})).find(item => item.backendId === 'claude' && item.enabled && item.capabilities.structuredNarration);
    expect(narrator).toBeDefined();
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]?.id;
    expect(modelId).toBeDefined();
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
    const finding = { id: 'finding-1', title: 'Original', severity: 'high', category: 'correctness', summary: 'Original diagnosis' };
    const review = runState({ intent: 'review', status: 'succeeded', runClass: 'bounded', retentionPolicy: 'ephemeral', finishedAtMs: 2,
      backendId: narrator!.backendId, backendTarget: { kind: 'builtInAgent', agentId: narrator!.backendId },
      launch: { cwd: directory, modelId },
      intentInput: { cwd: directory, comparisonId: captured.comparison.id },
      structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId },
        summary: 'One finding', overviewMarkdown: 'Review completed.', findings: [finding], questions: [], assumptions: [], generatedAtMs: 2,
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'], materialization: { kind: 'complete' } } } });
    harness.runs.set('run-1', review);
    harness.runs.set('run-2', { ...review, runId: 'run-2', callId: 'call-2', sidechainId: 'sidechain-2', status: 'running', structuredMeta: undefined });
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1', 'run-2'], comparisonId: captured.comparison.id, narrator: { engineId: narrator!.engineId },
      launchFailures: [{ engineId: 'failed-engine', errorCode: 'engine_unavailable', error: 'Engine never started' }],
    } });
    expect(acted, JSON.stringify(acted)).toMatchObject({ ok: true, result: { mode: 'seeded_narrator', state: 'collecting' } });
    if (!acted.ok) throw new Error('Narrator admission failed');
    const result = acted.result as { runId: string };
    await vi.waitFor(() => expect(nativeOpen).toHaveBeenCalledOnce());
    expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
    if (outcome === 'cancel') {
      await harness.manager.stop(result.runId);
      await harness.manager.stop('run-2');
      expect(harness.manager.get(result.runId)).toMatchObject({ status: 'cancelled' });
      expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
      expect(harness.manager.get('run-1')?.structuredMeta).toEqual(review.structuredMeta);
      return;
    }
    if (outcome === 'rejected' || outcome === 'outcomeUnknown') harness.enqueueSessionUserMessageWithDisposition.mockImplementation(async ({ localId }) => (
      SessionInputAdmissionResultV1Schema.parse(outcome === 'rejected'
        ? { status: 'rejected', code: 'session_input_target_unavailable' }
        : { status: 'outcomeUnknown', localId, code: 'narrator_transport_failure' })
    ));
    harness.runs.set('follow-up', { ...review, runId: 'follow-up', callId: 'follow-up-call', structuredMeta: {
      kind: 'review_follow_up.v1', payload: { parentRunRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId }, threadId: 'thread-1',
        findingIds: ['finding-1'], requestMarkdown: 'Clarify', answerMarkdown: 'Latest answer', generatedAtMs: 3,
        updatedFindings: [{ ...finding, title: 'Current', summary: 'Current diagnosis' }] },
    } });
    await harness.manager.stop('run-2');
    await harness.firstEnqueuedInput;
    expect(harness.enqueueSessionUserMessageWithDisposition).toHaveBeenCalledOnce();
    if (outcome === 'rejected' || outcome === 'outcomeUnknown') {
      await vi.waitFor(() => expect(harness.manager.get(result.runId)).toMatchObject({ error: {
        code: outcome === 'outcomeUnknown' ? 'execution_run_send_outcome_unknown' : 'admission_failed' } }));
      if (outcome === 'rejected') await vi.waitFor(() => expect(harness.manager.get(result.runId)?.structuredMeta).toMatchObject({
        kind: 'scm_diff_summary.v1', payload: { outputs: { walkthrough: { state: 'failed' } } } }));
      await harness.manager.waitForOutput(result.runId, { kind: 'review_walkthrough', comparisonId: captured.comparison.id });
      expect(harness.manager.get('run-1')?.structuredMeta).toEqual(review.structuredMeta);
      expect(nativeOpen.mock.calls.map(([request]) => request.kind)).toEqual(['create']);
      return;
    }
    const input = harness.enqueueSessionUserMessageWithDisposition.mock.calls[0]![0];
    expect(input).toMatchObject({ recipient: { kind: 'execution_run', runId: result.runId } });
    expect(input.text).toContain('reading the diffs, not reviewing them');
    expect(input.text).toContain('Current diagnosis');
    expect(input.text).not.toContain('Original diagnosis');
    expect(nativeOpen.mock.calls.map(([request]) => request.kind)).toEqual(['create']);
    expect(harness.manager.get(result.runId)?.intentInput).toMatchObject({ reviewNarration: { provenance: {
      narrationMode: 'seeded_narrator', reviewedRuns: [{ runId: 'run-1', status: 'succeeded',
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'], materialization: { kind: 'complete' } },
        { runId: 'run-2', status: 'cancelled', hasOutput: false }],
      launchFailures: [{ engineId: 'failed-engine', errorCode: 'engine_unavailable', error: 'Engine never started' }],
    } } });
    expect(acted).toMatchObject({ result: { comparison: captured.comparison } });
  });

  it.each(['succeeded', 'failed'] as const)('continues a finished %s bounded review with an explicitly requested walkthrough and keeps later chat from rewriting it', async (reviewStatus) => {
    let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
    nativeOpen.mockImplementation(async () => ({
      watch(next) { emit = next; next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1', sequence: 1, sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      send: sent, async dispose() {},
    }));
    const harness = createHarness();
    const narrator = (await buildReviewEngineInventoryItems({})).find(item => item.backendId === 'claude' && item.enabled && item.capabilities.structuredNarration);
    expect(narrator).toBeDefined();
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]?.id;
    expect(modelId).toBeDefined();
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
    const review = runState({ intent: 'review', status: reviewStatus, runClass: 'bounded', finishedAtMs: 2,
      ...(reviewStatus === 'failed' ? { error: { code: 'review_comment_materialization_failed', message: 'Finding retained despite materialization failure' } } : {}),
      backendId: narrator!.backendId, backendTarget: { kind: 'builtInAgent', agentId: narrator!.backendId },
      launch: { cwd: directory, modelId },
      resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: narrator!.backendId, sourceKind: 'built_in' }, providerSessionId: 'provider-session-1' },
      intentInput: { cwd: directory, comparisonId: captured.comparison.id },
      structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId },
        summary: 'One finding', overviewMarkdown: 'Review completed.', findings: [{ id: 'finding-1', title: 'Original finding', severity: 'high', category: 'correctness', summary: 'Original diagnosis' }],
        questions: [], assumptions: [], generatedAtMs: 2, reviewOutcome: reviewStatus === 'failed' ? 'partial' : 'complete',
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'],
        materialization: reviewStatus === 'failed' ? { kind: 'partial', errorCode: 'review_comment_materialization_failed' } : { kind: 'complete' } } } });
    harness.runs.set('run-1', review);
    harness.runs.set('follow-up', { ...review, runId: 'follow-up', callId: 'follow-up-call', status: 'succeeded', structuredMeta: {
      kind: 'review_follow_up.v1', payload: { parentRunRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId },
        threadId: 'thread-1', findingIds: ['finding-1'], requestMarkdown: 'Clarify', answerMarkdown: 'Latest answer', generatedAtMs: 3,
        updatedFindings: [{ id: 'finding-1', title: 'Current finding', severity: 'high', category: 'correctness', summary: 'Current diagnosis' }] },
    } });
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id,
    } });
    expect(acted, JSON.stringify(acted)).toMatchObject({ ok: true, result: { runId: 'run-1', mode: 'continued_review', state: 'writing' } });
    expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
    expect(harness.runs.size).toBe(2);
    expect(harness.runs.get('run-1')).toMatchObject({ runClass: 'long_lived', intent: 'review', intentInput: { reviewNarration: { phase: 'writing' } } });
    const pending = harness.enqueueSessionUserMessageWithDisposition.mock.calls[0]?.[0];
    expect(pending).toMatchObject({ recipient: { kind: 'execution_run', runId: 'run-1' }, requestedAction: { kind: 'enqueue' } });
    expect(pending?.text).toContain('Do not repeat the review');
    expect(pending?.text).toContain('Current diagnosis');
    expect(pending?.text).not.toContain('Original diagnosis');
    expect(pending?.text).toContain('"id":"F1"');
    expect(pending?.text).not.toContain('finding-1');
    const input = harness.runs.get('run-1')?.intentInput as { resultId: string };
    expect(await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: input.resultId })).toMatchObject({ success: true, result: { output: { runId: 'run-1' } } });
    expect(harness.consume({ role: 'user', content: { type: 'text', text: pending!.text }, localId: pending!.localId,
      authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
    expect(JSON.stringify(sent.mock.calls)).toContain('Current diagnosis');
    expect(JSON.stringify(sent.mock.calls)).not.toContain('Original diagnosis');
    expect(JSON.stringify(sent.mock.calls)).not.toContain('finding-1');
    expect(harness.runs.get('run-1')?.intentInput).toMatchObject({ reviewNarration: { reviewStatus, provenance: { reviewedRuns: [
      { runId: 'run-1', status: reviewStatus, reviewOutcome: reviewStatus === 'failed' ? 'partial' : 'complete',
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'],
        materialization: reviewStatus === 'failed' ? { kind: 'partial', errorCode: 'review_comment_materialization_failed' } : { kind: 'complete' } }] } } });
    expect(acted).toMatchObject({ result: { comparison: captured.comparison } });
    const delivery = sent.mock.calls[0]![0].delivery;
    if (delivery.kind !== 'newTurn') throw new Error('The narration was not admitted as a new native turn');
    emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 2, emittedAtMs: 2,
      inputIds: sent.mock.calls[0]![0].inputIds, delivery });
    emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: 3, emittedAtMs: 3, turnId: delivery.turnId, startedBy: 'host' });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id } })).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    const controller = harness.controllers.get('run-1') as ExecutionRunBackendController;
    emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: 4, emittedAtMs: 4, turnId: delivery.turnId,
      channel: 'assistant', text: JSON.stringify({ walkthrough: { title: 'Saved narration', intro: 'No captured readable changes', stops: [], otherChangeRefs: [] } }) });
    emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 5, emittedAtMs: 5, turnId: delivery.turnId });
    let publicationBeforeNextDelivery: unknown;
    sent.mockImplementationOnce(async request => {
      publicationBeforeNextDelivery = await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: input.resultId });
      if (request.delivery.kind !== 'newTurn') throw new Error('The next narration was not a new native turn');
      emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 6, emittedAtMs: 6,
        inputIds: request.inputIds, delivery: request.delivery });
      emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: 7, emittedAtMs: 7, turnId: request.delivery.turnId, startedBy: 'host' });
      emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: 8, emittedAtMs: 8, turnId: request.delivery.turnId,
        channel: 'assistant', text: JSON.stringify({ walkthrough: { title: 'Next narration', intro: '', stops: [], otherChangeRefs: [] } }) });
      emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 9, emittedAtMs: 9, turnId: request.delivery.turnId });
      return { status: 'admitted' };
    });
    expect(harness.consume({ role: 'user', content: { type: 'text', text: 'Why keep these findings?' }, localId: 'next-narration',
      authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(publicationBeforeNextDelivery).toMatchObject({ success: true,
      result: { output: { outputs: { walkthrough: { value: { title: 'Saved narration' } } } } } }));
    await controller.pendingHostBarrier;
    await vi.waitFor(() => expect(harness.manager.getPublic('run-1')).toMatchObject({ turnInFlight: false }));
    // Chat has no admitted output scope. Even unsolicited structured model output
    // cannot grant itself permission to replace the saved walkthrough.
    expect(await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: input.resultId }))
      .toEqual(publicationBeforeNextDelivery);
    expect(harness.manager.get('run-1')).toMatchObject({ status: 'running' });
    const again = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id } });
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true, result: { runId: 'run-1', mode: 'continued_review' } });
    expect(nativeOpen).toHaveBeenCalledOnce();
    expect(harness.runs.size).toBe(2);
  });
  it.each(['failed', 'succeeded', 'cancelled', 'timeout'] as const)('requires explicit recovery before ordinary input to a %s exact target', async status => {
    nativeOpen.mockReset();
    let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const deliveredInputs: string[] = [];
    nativeOpen.mockImplementation(async () => {
      let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      let sequence = 1;
      return { watch(next) { emit = listener = next; listener({ kind: 'provider-session-id', providerSessionId: 'provider-session-1',
        sequence: 1, sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() { listener = undefined; } }; },
        async send(input) {
          deliveredInputs.push(...input.inputIds);
          listener!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: 2,
            inputIds: input.inputIds, delivery: input.delivery });
          listener!({ kind: 'turn-start', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: 2,
            turnId: input.delivery.turnId, startedBy: 'host' });
          listener!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: ++sequence, emittedAtMs: 3,
            turnId: input.delivery.turnId });
          return { status: 'admitted' as const };
        }, async dispose() {} };
    });
    const harness = createHarness();
    harness.runs.set('run-1', runState({ status: status === 'failed' ? 'running' : status, finishedAtMs: 2 }));
    try {
      if (status === 'failed') {
        expect(await harness.manager.ensure('run-1', { resume: true })).toMatchObject({ ok: true });
        emit!({ kind: 'runtime-ended', sessionId: 'session-parent', sequence: 2, emittedAtMs: 2,
          cause: 'processExited', retryable: true, diagnostic: { code: 'native_process_exited', severity: 'error' } });
        await harness.manager.waitForTerminal('run-1');
        await vi.waitFor(() => expect(harness.controllers.has('run-1')).toBe(false));
        nativeOpen.mockClear();
      }
      await harness.manager.reconcilePendingExecutionRunTarget('run-1');
      expect(nativeOpen).not.toHaveBeenCalled();
      expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
      expect(await harness.manager.send('run-1', { message: 'Ordinary input', localInputId: 'before-recovery' }))
        .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
      expect(harness.manager.getPublic('run-1')).toMatchObject({ status, lifecycle: { state: 'recoverable' } });
      expect(await harness.manager.ensure('run-1', { resume: 'if_running' }))
        .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed', resumeFailureKind: 'permanent' });
      harness.blockExecutionRunPendingDelivery.mockClear();
      expect(await harness.manager.ensure('run-1', { resume: true })).toMatchObject({ ok: true });
      expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
      expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'running', lifecycle: { state: 'current' } });
      await harness.manager.reconcilePendingExecutionRunTarget('run-1');
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
      expect(harness.consume({ role: 'user', content: { type: 'text', text: 'Fresh input' }, localId: 'after-recovery',
        authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
      await vi.waitFor(() => expect(deliveredInputs).toContain('after-recovery'));
      await vi.waitFor(() => expect(harness.manager.getPublic('run-1')).toMatchObject({
        inputTurns: { last: { state: 'completed', inputIds: ['after-recovery'] } },
      }));
    } finally { await harness.manager.dispose(); }
  });

  it.each(['failed', 'cancelled'] as const)('refuses %s Run ordinary input before any connected-service materialization request', async status => {
    const harness = createHarness();
    harness.runs.set('run-1', runState({ status, finishedAtMs: 2, backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        providerSessionId: 'provider-session-1' },
      launch: { connectedServicesSelection: { v: 2, bindingsByServiceId: {
        'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'profile-1' },
      } } },
      inputTurns: { occurrenceId: 'original-occurrence', last: { turnId: 'completed-turn', inputIds: ['completed-input'],
        state: 'completed', result: { kind: 'text', value: 'Saved result' } } },
    }));
    await harness.manager.reconcilePendingExecutionRunTarget('run-1');
    expect(requestRunMaterialization).not.toHaveBeenCalled();
    expect(nativeOpen).not.toHaveBeenCalled();
    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    expect(harness.controllers.has('run-1')).toBe(false);
    expect(harness.manager.getPublic('run-1')).toMatchObject({ status, lifecycle: { state: 'recoverable' },
      inputTurns: { occurrenceId: 'original-occurrence', last: { state: 'completed', inputIds: ['completed-input'] } } });
    // Prove the same real selection reaches the transport when recovery is explicit.
    expect(await harness.manager.ensure('run-1', { resume: true })).toMatchObject({ ok: false, errorCode: 'connected_service_run_materialization_failed' });
    expect(requestRunMaterialization).toHaveBeenCalledOnce();
    expect(requestRunMaterialization.mock.calls[0]![0]).toMatchObject({ runId: 'run-1', controllerOccurrenceId: expect.any(String) });
  });
  it('leaves an unknown target queued without ensure or block', async () => {
    const harness = createHarness();
    const ensure = vi.spyOn(harness.manager, 'ensure');

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(ensure).not.toHaveBeenCalled();
    expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
  });

  it.each([
    { ioMode: 'streaming', retentionPolicy: 'resumable' },
    { ioMode: 'request_response', retentionPolicy: 'resumable' },
    { ioMode: 'request_response', retentionPolicy: 'ephemeral' },
  ] as const)('keeps the accepted target queued while its native module is still loading ($ioMode, $retentionPolicy)', async ({ ioMode, retentionPolicy }) => {
    let releaseModule!: () => void;
    nativeModule.ready = new Promise<void>(resolve => { releaseModule = resolve; });
    nativeOpen.mockImplementation(async () => ({
      watch(next) { next({ kind: 'provider-session-id', providerSessionId: 'new-provider-session', sequence: 1,
        sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      async send() { return { status: 'admitted' as const }; }, async dispose() {},
    }));
    const harness = createHarness();
    try {
      const started = await harness.manager.start({ sessionId: 'session-1', cwd: directory, intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy, runClass: 'long_lived', ioMode, instructions: '',
        initialInput: { kind: 'deferred_session_pending' } });
      expect(nativeOpen).not.toHaveBeenCalled();
      await harness.manager.reconcilePendingExecutionRunTarget(started.runId);
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
      releaseModule();
      await (harness.controllers.get(started.runId) as ExecutionRunBackendController).provisioningPromise;
      expect(nativeOpen).toHaveBeenCalledOnce();
      expect(harness.manager.getPublic(started.runId)).toMatchObject({ lifecycle: { state: 'current' } });
      await harness.manager.reconcilePendingExecutionRunTarget(started.runId);
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    } finally {
      releaseModule();
      await harness.manager.dispose();
    }
  });

  it.each(['indeterminate', 'permanent'] as const)('classifies a native %s resume failure through real ensure', async (failureKind) => {
    const error = new Error('Native provider cannot currently resume this exact session');
    if (failureKind === 'permanent') Object.assign(error, { code: 'AGENT_RESUME_PROVIDER_STATE_MISSING' });
    nativeOpen.mockRejectedValue(error);
    const harness = createHarness();
    harness.runs.set('run-1', runState());

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
    expect(harness.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    if (failureKind === 'permanent') {
      expect(harness.manager.getPublic('run-1')).toMatchObject({ lifecycle: { state: 'unavailable' }, error: { code: 'execution_run_provider_state_missing' } });
      expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledOnce();
      expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    } else {
      expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'failed',
        lifecycle: { state: 'recoverable' }, error: { code: 'execution_run_failed' } });
      expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledOnce();
      expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    }
  });

  it('does not block when a concurrent resume installs the target controller', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState());
    vi.spyOn(harness.manager, 'ensure').mockImplementation(async () => {
      harness.controllers.set('run-1', {
        kind: 'backend',
        cancelled: false,
        backend: { interaction: {} },
      });
      return {
        ok: false,
        errorCode: 'execution_run_not_allowed',
        error: 'Resume already in progress',
        resumeFailureKind: 'indeterminate',
      };
    });

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    harness.controllers.clear();
    harness.runs.clear();
  });

  it('keeps a superseded resume queued after its provisional controller has retired', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState());
    vi.spyOn(harness.manager, 'ensure').mockResolvedValue({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Resume was superseded',
      resumeFailureKind: 'indeterminate',
    });

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(harness.controllers.has('run-1')).toBe(false);
    expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    harness.runs.clear();
  });

  it('blocks a Voice target whose canonical lifecycle has no retained Voice configuration', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState({ intent: 'voice_agent' }));

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    harness.runs.clear();
  });

  it.each([
    ['permanently failed', { status: 'failed' as const, error: { code: 'execution_run_provider_state_missing', message: 'Native provider state is missing' } }],
    ['wrong Session', { sessionId: 'session-2' }],
    ['noninteractive', { runClass: 'bounded' as const, retentionPolicy: 'ephemeral' as const }],
    ['permanently unavailable', { resumeHandle: null }],
  ])('blocks only the queued exact row for a proven %s target', async (_label, overrides) => {
    const harness = createHarness();
    harness.runs.set('run-1', runState(overrides));
    if (_label === 'noninteractive') {
      // Bounded execution owns a separate queue and never binds target Pending.
      harness.controllers.set('run-1', { kind: 'backend', cancelled: false,
        runtimeId: 'bounded-runtime', backend: { interaction: {} } });
    }
    const ensure = vi.spyOn(harness.manager, 'ensure');

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(ensure).not.toHaveBeenCalled();
    expect(harness.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledTimes(1);
    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    harness.controllers.clear();
    harness.runs.clear();
  });
});
