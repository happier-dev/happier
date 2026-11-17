import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunUserTranscriptCommitRequestSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { SessionExecutionRunBrokerAuthorityRequestV1Schema, SessionExecutionRunBrokerAuthorityResponseV1Schema } from '@happier-dev/protocol/daemon/executionRuns';
import type { ExecutionRunPublicState, SessionTranscriptObservationProvenanceV1, ActionExecutorDeps, ReviewCommentPrincipalHeaderV1, ActionId } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExecutionRunFollowFrontierRequestSchema, ExecutionRunFollowFrontierResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';

import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunRequestBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import type { ExecutionRunTranscriptPublisher } from '@/agent/runtime/bridges/executionRun/executionRunTranscriptPublisher';
import type { ExecutionRunSessionStateTarget } from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';
import type {
  ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { acquireExecutionRunRuntimeSnapshot } from './acquireExecutionRunRuntimeSnapshot';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { createExecutionBudgetRegistry } from '@/daemon/executionBudget/createExecutionBudgetRegistry';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { BrowserUiAutomationRouteOwner } from '@/daemon/runtimeActionExecutor';
import type { BrowserDiagnosticsActionRoutes } from '@/daemon/browser/diagnostics/actionRoutes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type {
  BrowserRecordingComposerAttachInput,
  BrowserRecordingComposerAttachResult,
} from '../../../daemon/recording/attachToComposer';
import type { LocalServicesRuntimeActionRoutes } from '@/daemon/local/services/actions/runtimeActionExecutor';
import type { DaemonPeerMediationObservabilityRuntimeActionContext } from '@/daemon/peer/mediation/observability/runtimeActionExecutor';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import { projectRpcRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import type { EphemeralSendResult } from '@/api/session/client/transcript/ephemeralSendOutcome';
import { invalidExecutionRunRpcParams as invalidParams, registerExecutionRunActionRpcHandlers } from './actionRpcRegistration';
import {
  admitExecutionRunCallerTurn,
  createExecutionRunRpcActionExecutor,
  type ExecutionRunRpcApprovalDeps,
  type GrantAttachedRunTeamVisibility,
} from './dispatchExecutionRunRpcAction';
import {
  createReviewCommentHostActionMaterializer,
} from '@/agent/executionRuns/profiles/review/hostActionMaterializer';
import { readCurrentReviewHostPluginAuthority } from '@/agent/executionRuns/profiles/review/pluginAuthority';
import { resolveWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { admitDaemonExecutionRunStart, checkExecutionRunConnectedServicesGenerationCurrent } from '@/daemon/controlClient';
import type { NativeAgentSessionInteractionHostBinding, ExecutionRunProjectLaunchContext } from '@/agent/runtime/registry/engineRegistryTypes';
import type { RpcActionExecutorContext } from '../_actionDispatchAdapter';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { ExecutionRunTeamCredentialProviderBindingPreparer } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import { createReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { registerSessionAgentStartSelectionRpc } from '../../../session/actions/agentStartSelectionRpc';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { ExecutionRunNativeOfferedModelReader } from '@/agent/runtime/bridges/executionRun/executionRunTypes';

export type ExecutionRunRpcHandlerContext = Readonly<{
  attachActionOperationOwner?: import('@/daemon/actionOperations/createHostActionOperationRuntime').HostActionOperationRuntime['attachOwner'];
  /** Fixed handler scope: a concrete Session or the daemon-owned detached scope. */
  sessionId: string | null;
  /** Same SESSION_DELETE registration delegates ordinary Sessions to their native lifecycle owner. */
  sessionDelete?: RpcHandler;
  cwd: string;
  machineId?: string;
  /** Stable qualified Home identity; never the transport URL. */
  serverId?: string;
  /** Authenticated runtime Account identity for strict V2 execution origins. */
  runtimeAccountId?: string;
  /** Accepted Session custody observation, never metadata or public request input. */
  readRequesterWorkAttributionV1?: () => Promise<import('@/daemon/lifecycle/requesterWorkAttribution').RequesterWorkAttributionV1 | null>;
  /** Session-owned Run listing dependency, injected by the runtime principal owner. */
  sessionList?: ActionExecutorDeps['sessionList'];
  resolveAgentStartContext?: ActionExecutorDeps['resolveAgentStartContext'];
  readPromptCredentials?: () => Promise<import('@/persistence').StoredCredentials | null>;
  /** The daemon borrows the admitted Workflow requester for native catalog admission. */
  readRequesterNativeOfferedModel?: (bootstrap: AdmittedRequesterSessionBootstrap,
    ...args: Parameters<ExecutionRunNativeOfferedModelReader>) => ReturnType<ExecutionRunNativeOfferedModelReader>;
  /** Host-private Account read; callers cannot inject this policy in a Run request. */
  resolveRunReportPolicy?: (signal?: AbortSignal) => Promise<import('@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1').FollowPolicyV1>;
  grantAttachedRunTeamVisibility?: GrantAttachedRunTeamVisibility;
  serverUrl?: string;
  parentProvider: ACPProvider;
  /** Actual Agent identity from the live Session owner; not provider/transcript metadata. */
  resolveReviewCommentActor?: () => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null;
  browserControl?: BrowserDaemonControlRoutes | null;
  browserContext?: BrowserContextRoutes | null;
  browserAutomation?: BrowserAutomationRoutes | null;
  getBrowserUiAutomation?: () => BrowserUiAutomationRouteOwner | null;
  browserDiagnostics?: BrowserDiagnosticsActionRoutes | null;
  browserRecording?: BrowserRecordingRoutes | null;
  attachBrowserRecordingToComposer?: (
    input: BrowserRecordingComposerAttachInput,
  ) => Promise<BrowserRecordingComposerAttachResult>;
  localServices?: LocalServicesRuntimeActionRoutes | null;
  simulatorPreview?: SimulatorPreviewRoutes | null;
  peerMediationObservability?: DaemonPeerMediationObservabilityRuntimeActionContext | null;
  sendAcp: ExecutionRunTranscriptPublisher;
  streamedTranscriptSession?: Readonly<{
    sendAgentMessageEphemeral?: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; meta?: Record<string, unknown>; createdAt: number; updatedAt?: number; tick?: number },
    ) => EphemeralSendResult;
    sendAgentMessageEphemeralDelta?: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; tick: number; baseLength: number; meta?: Record<string, unknown>; createdAt: number; updatedAt?: number; snapshotBody?: ACPMessageData },
    ) => EphemeralSendResult;
    getEphemeralStreamConnectionEpoch?: () => number;
    enqueueAgentMessageCommitted?: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  }>;
  transcriptWriter?: Readonly<{
    appendUserTextCommitted?: (
      text: string,
      options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    appendAssistantTextCommitted?: (
      text: string,
      options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    commitVoiceAgentTranscriptTurn: (turn: Readonly<{
      turnId: string;
      user: Readonly<{ text: string; localId: string; meta: Record<string, unknown> }>;
      assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
    }>) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  }>;
  getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  policy?: Readonly<{
    boundedTimeoutMs?: number | null;
    reviewBoundedTimeoutMs?: number | null;
    maxTurns?: number | null;
  }>;
  budgetRegistry?: ExecutionBudgetRegistry;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
  sessionInteractionHost?: NativeAgentSessionInteractionHostBinding;
  prepareRunTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
  onExecutionRunPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
  onExecutionRunVoiceAgentWelcomed?: (run: ExecutionRunPublicState, welcomedEpoch: number) => void | Promise<void>;
  resolveAccountSettings?: (actionId?: ActionId) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  /** Settings snapshot bound to the runtime owner's Account/Home, never ambient active state. */
  resolveAccountSettingsSnapshot?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['resolveAccountSettingsSnapshot'];
  resolveManagedPurposeBindingIntent?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['resolveManagedPurposeBindingIntent'];
  resolveManagedPurposeBindingIntentSelection?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['resolveManagedPurposeBindingIntentSelection'];
  managedProviderAccountAuthority?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['managedProviderAccountAuthority'];
  readModelProjection?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['readModelProjection'];
  prepareManagedEndpoint?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['prepareManagedEndpoint'];
  /** Same invocation holder initialized by the Session owner's Settings admission. */
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  executionRunProfileCatalog?: ExecutionRunProfileContributionCatalog;
  resolveExecutionRunProfileCatalog?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['resolveExecutionRunProfileCatalog'];
  /** Captures actual admitted ingress for this start; never selects ambient daemon credentials. */
  resolveProjectLaunchContext?: (context: RpcActionExecutorContext) => Promise<ExecutionRunProjectLaunchContext | null>;
  actionExecutor?: RpcActionExecutor;
  /** Host-owned runtime Action policy; restricted runtimes must not fall back to ambient env/Account state. */
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  actionApprovalDeps?: Partial<ExecutionRunRpcApprovalDeps>;
  /** Parent Session composition hook; the bridge remains the sole Run registry owner. */
  onManagerCreated?: (manager: ExecutionRunHostBridge) => void;
}>;

export type ExecutionRunRpcHandlerRegistration = Readonly<{
  /** Release this registration's Action Operations attachment. */
  dispose(): void;
}>;

export function registerExecutionRunRpcHandlers(
  rpc: RpcHandlerRegistrar,
  ctx: ExecutionRunRpcHandlerContext,
): ExecutionRunRpcHandlerRegistration {
  const disposeAgentStartSelection = registerSessionAgentStartSelectionRpc(rpc, ctx.sessionId, ctx.sessionInteractionHost);
  const policy = resolveExecutionRunPolicy({
    override: ctx.policy,
  });

  const profileCatalogOptions: Pick<
    ConstructorParameters<typeof ExecutionRunHostBridge>[0],
    'executionRunProfileCatalog' | 'resolveExecutionRunProfileCatalog'
  > = ctx.resolveExecutionRunProfileCatalog
    ? { resolveExecutionRunProfileCatalog: ctx.resolveExecutionRunProfileCatalog }
    : ctx.executionRunProfileCatalog
      ? { executionRunProfileCatalog: ctx.executionRunProfileCatalog }
      : {
          resolveExecutionRunProfileCatalog: async () => {
            return await acquireExecutionRunRuntimeSnapshot(ctx);
          },
        };

  let canonicalActionExecutor: RpcActionExecutor | null = null;
  const reviewCommentAction = ctx.actionApprovalDeps?.reviewCommentAction;
  const reviewComments = reviewCommentAction && ctx.machineId
    ? createReviewRunCommentService({
        cwd: ctx.cwd, scope: { workspace: { machineId: ctx.machineId, path: ctx.cwd } },
        resolveTriageActor: ctx.resolveReviewCommentActor,
        execute: async (actionId, input, options) => await reviewCommentAction({
          actionId, input, ...(options?.principal ? { reviewCommentPrincipal: options.principal } : {}),
          ...(options?.signal ? { signal: options.signal } : {}), ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
        }),
      })
    : undefined;
  const requestCurrentIntent = ctx.actionApprovalDeps?.executionRunHostActionCurrentIntent;
  const materializeReviewHostAction = requestCurrentIntent
    ? async (readCurrentCandidate: Parameters<typeof createReviewCommentHostActionMaterializer>[0]['readCurrentCandidate']) => {
      const materialize = createReviewCommentHostActionMaterializer({
        cwd: ctx.cwd,
        readCurrentCandidate,
        readCurrentPluginAuthority: async pluginId => {
          const current = await (ctx.actionApprovalDeps?.resolveReviewHostPluginAuthority ?? readCurrentReviewHostPluginAuthority)(pluginId);
          return current ? { sourceCustody: current.sourceCustody } : null;
        },
        resolveWorkspace: async () => {
          const machineId = typeof ctx.machineId === 'string' ? ctx.machineId.trim() : '';
          const serverId = ctx.serverId?.trim();
          const serverUrl = ctx.serverUrl?.trim();
          if (!serverId || !serverUrl || !machineId || !ctx.readPromptCredentials) return null;
          const credentials = await ctx.readPromptCredentials();
          if (!credentials) return null;
          const homeServerId = await resolveServerProfileHomeIdentityId(serverId) ?? serverId;
          const rows = await runWithServerHttpBaseUrl(serverUrl, () => readProjectAccountRows({
            credentials, serverId, selection: { kinds: ['workspace-ref'], serverId: homeServerId },
          }));
          const workspace = resolveWorkspaceRefForMachineRoot(rows.workspaceRefs, {
            serverId: homeServerId,
            machineId,
            rootPath: ctx.cwd,
          });
          return workspace
            ? { projectId: workspace.id, workspaceId: workspace.id, serverId: workspace.serverId }
            : null;
        },
        requestCurrentIntent,
        ...(ctx.actionApprovalDeps?.pluginPermissionGrantRequest
          ? { requestDirectWriteGrant: ctx.actionApprovalDeps.pluginPermissionGrantRequest }
          : {}),
        executeHostAction: async (actionId, input, context) => {
          if (!canonicalActionExecutor) {
            return { ok: false, errorCode: 'execution_run_host_action_unavailable', error: 'Canonical action executor is unavailable' };
          }
          return await canonicalActionExecutor.execute(actionId, input, context);
        },
      });
      return await materialize();
    }
    : undefined;

  const budgetRegistry = ctx.budgetRegistry ?? createExecutionBudgetRegistry();
  const host = new ExecutionRunHostBridge({
    resolveVoicePromptPreparation: async ({ sessionId, signal, workingDirectory }) => {
      const credentials = await ctx.readPromptCredentials?.();
      return await resolveCliVoicePromptPreparation({ credentials, sessionId, signal,
        serverId: ctx.serverId, serverUrl: ctx.serverUrl, machineId: ctx.machineId,
        directory: workingDirectory ?? ctx.cwd });
    },
    admitStart: admitDaemonExecutionRunStart,
    ...(ctx.runtimeAccountId ? { runtimeAccountId: ctx.runtimeAccountId } : {}),
    parentProvider: ctx.parentProvider,
    cwd: ctx.cwd,
    sendAcp: ctx.sendAcp,
    streamedTranscriptSession: ctx.streamedTranscriptSession,
    transcriptWriter: ctx.transcriptWriter,
    onPublicStateUpdated: ctx.onExecutionRunPublicStateUpdated,
    onVoiceAgentWelcomed: ctx.onExecutionRunVoiceAgentWelcomed,
    boundedTimeoutMs: policy.boundedTimeoutMs ?? undefined,
    maxTurns: policy.maxTurns ?? undefined,
    budgetRegistry,
    getPermissionRequestStore: ctx.getPermissionRequestStore,
    parentSessionStateTarget: ctx.parentSessionStateTarget ?? null,
    ...(ctx.sessionInteractionHost
      ? { sessionInteractionHost: ctx.sessionInteractionHost }
      : {}),
    ...(ctx.prepareRunTeamCredentialProviderBinding
      ? { prepareRunTeamCredentialProviderBinding: ctx.prepareRunTeamCredentialProviderBinding }
      : {}),
    resolveAccountSettings: ctx.resolveAccountSettings,
    ...(ctx.resolveRunReportPolicy ? { resolveRunReportPolicy: ctx.resolveRunReportPolicy } : {}),
    ...(ctx.resolveAccountSettingsSnapshot
      ? { resolveAccountSettingsSnapshot: ctx.resolveAccountSettingsSnapshot }
      : {}),
    ...(ctx.resolveManagedPurposeBindingIntent ? { resolveManagedPurposeBindingIntent: ctx.resolveManagedPurposeBindingIntent } : {}),
    ...(ctx.resolveManagedPurposeBindingIntentSelection ? { resolveManagedPurposeBindingIntentSelection: ctx.resolveManagedPurposeBindingIntentSelection } : {}),
    managedProviderAccountAuthority: ctx.managedProviderAccountAuthority,
    ...(ctx.readModelProjection ? { readModelProjection: ctx.readModelProjection } : {}),
    ...(ctx.prepareManagedEndpoint ? { prepareManagedEndpoint: ctx.prepareManagedEndpoint } : {}),
    ...(ctx.machineId ? { machineId: ctx.machineId } : {}),
    resolveProvidersFeatureEnabled: () => {
      const serverSnapshot = ctx.getServerFeaturesSnapshot?.();
      return resolveCliFeatureDecision({
        featureId: 'providers',
        ...(serverSnapshot ? { serverSnapshot } : {}),
      }).state === 'enabled';
    },
    ...(materializeReviewHostAction ? { materializeReviewHostAction } : {}),
    ...(reviewComments ? { reviewComments } : {}),
    checkConnectedServicesGenerationCurrent: async ({ runId, registration, signal }) => {
      const result = await checkExecutionRunConnectedServicesGenerationCurrent({
        runId,
        runnerPid: process.pid,
        registration,
      }, { signal });
      return { current: result.ok === true && result.current === true };
    },
    ...profileCatalogOptions,
  });
  ctx.onManagerCreated?.(host);
  const manager: ExecutionRunRequestBridgeContract<ExecutionRunHostBridge> = host;

  function isExecutionRunsEnabled(): boolean {
    return resolveCliFeatureDecision({ featureId: 'execution.runs' }).state === 'enabled';
  }

  const actionExecutor = ctx.actionExecutor ?? createExecutionRunRpcActionExecutor({
    manager,
    context: { ...ctx, budgetRegistry },
    policy,
    isExecutionRunsEnabled,
    ...(ctx.actionsSettingsProvider
      ? { actionsSettingsProvider: ctx.actionsSettingsProvider }
      : {}),
    approvalDeps: ctx.actionApprovalDeps,
  });
  canonicalActionExecutor = actionExecutor;

  if (ctx.sessionId === null) rpc.registerHandler(SESSION_RPC_METHODS.SESSION_DELETE,
    async (request: unknown, rpcContext) => {
      const parsed = getActionSpec('session.delete').inputSchema.safeParse(request);
      if (parsed.success && 'runId' in parsed.data) {
        return manager.deleteForRequest(parsed.data.runId, projectRpcRequesterWorkAttribution(rpcContext, ctx.serverId));
      }
      if (ctx.sessionDelete) return ctx.sessionDelete(request, rpcContext);
      return { ok: false, errorCode: 'invalid_parameters', error: 'Invalid params' };
    });

  // This content-free source read belongs to the daemon's retained owner, not
  // the live Session handler or detached Run GET. The Home checks source grants
  // and exact Machine placement before forwarding this read.
  if (ctx.sessionId === null) rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
    async (request: unknown) => {
      if (!isExecutionRunsEnabled()) return { ok: false, error: 'Execution runs disabled', errorCode: 'execution_run_not_allowed' };
      const parsed = ExecutionRunFollowFrontierRequestSchema.safeParse(request);
      if (!parsed.success) return invalidParams();
      const retained = await readRetainedExecutionRunRecord(parsed.data.runId);
      const run = retained?.state;
      if (!run || ('sessionId' in parsed.data ? run.sessionId !== parsed.data.sessionId
        : ctx.machineId !== parsed.data.machineId || run.sessionId !== null)
        || run.status !== 'running' && !run.terminalOccurrenceId)
        return { ok: false, error: 'Execution run not found', errorCode: 'execution_run_not_found' };
      const output = parsed.data.outputRefs?.length ? createStoredReadSchema(ScmDiffSummaryGenerateOutputSchema).safeParse(
        run.structuredMeta?.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary ? run.structuredMeta.payload : run.latestToolResult) : null;
      const outputs = parsed.data.outputRefs?.flatMap(outputRef => {
        if (!output?.success || output.data.comparison?.id !== outputRef.comparisonId || output.data.resultId !== outputRef.resultId
          || output.data.revision === undefined) return [];
        const progress = output.data.outputs?.[outputRef.kind === 'scm_diff_summary' ? outputRef.output : 'walkthrough'];
        return progress ? [{ outputRef, revision: output.data.revision, state: progress.state }] : [];
      });
      return ExecutionRunFollowFrontierResponseSchema.parse({ ...('sessionId' in parsed.data ? { sessionId: parsed.data.sessionId }
        : { machineId: parsed.data.machineId, sessionId: null }), runId: run.runId,
        status: run.status, terminalEventId: run.status === 'running' ? null : run.terminalOccurrenceId,
        ...((run.status === 'failed' || run.status === 'timeout') && run.error?.runtimeIssueV1
          ? { runtimeIssueV1: run.error.runtimeIssueV1 } : {}),
        ...(outputs ? { outputs } : {}),
        ...(run.status === 'running' && run.attention ? { attention: run.attention } : {}) });
    });

  rpc.registerHandler(
    SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1,
    async (request: unknown) => {
      const parsed = SessionExecutionRunBrokerAuthorityRequestV1Schema.safeParse(request);
      if (!parsed.success) return invalidParams();
      return SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(
        manager.resolveLiveBrokerAuthority(parsed.data),
      );
    },
  );

  registerExecutionRunActionRpcHandlers(rpc, {
      executor: actionExecutor,
      defaultSessionId: ctx.sessionId,
      ...(ctx.machineId ? { machineId: ctx.machineId } : {}),
      ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
      ...(ctx.runtimeAccountId ? { runtimeAccountId: ctx.runtimeAccountId } : {}),
  });

  rpc.registerHandler(
    SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
    async (request: unknown, rpcContext) => {
      if (!isExecutionRunsEnabled()) {
        return { ok: false, error: 'Execution runs disabled', errorCode: 'execution_run_not_allowed' };
      }
      const parsed = ExecutionRunTurnStreamStartV2RequestSchema.safeParse(request);
      if (!parsed.success) return invalidParams();
      await manager.recoverRetainedRuns();
      const run = await manager.getForRequest(parsed.data.runId, ctx.sessionId, projectRpcRequesterWorkAttribution(rpcContext, ctx.serverId));
      if (!run) {
        return { ok: false, error: 'Execution run not found', errorCode: 'execution_run_not_found' };
      }
      const refusal = admitExecutionRunCallerTurn(run, rpcContext?.callerAuthority);
      if (refusal) return refusal;
      const started = await manager.startTurnStream(parsed.data.runId, {
        message: parsed.data.message,
        ...(parsed.data.speechSegmentTargetChars !== undefined
          ? { speechSegmentTargetChars: parsed.data.speechSegmentTargetChars }
          : {}),
        ...(parsed.data.displayMessage ? { displayMessage: parsed.data.displayMessage } : {}),
        ...(parsed.data.resume === true ? { resume: true } : {}),
        userTranscript: parsed.data.userTranscript,
      });
      return started.ok
        ? { streamId: started.streamId }
        : { ok: false, error: started.error, errorCode: started.errorCode };
    },
  );

  rpc.registerHandler(
    SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1,
    async (request: unknown, rpcContext) => {
      if (!isExecutionRunsEnabled()) {
        return { ok: false, error: 'Execution runs disabled', errorCode: 'execution_run_not_allowed' };
      }
      const parsed = ExecutionRunUserTranscriptCommitRequestSchema.safeParse(request);
      if (!parsed.success) return invalidParams();
      await manager.recoverRetainedRuns();
      const run = await manager.getForRequest(parsed.data.runId, ctx.sessionId, projectRpcRequesterWorkAttribution(rpcContext, ctx.serverId));
      if (!run) {
        return { ok: false, error: 'Execution run not found', errorCode: 'execution_run_not_found' };
      }
      const refusal = admitExecutionRunCallerTurn(run, rpcContext?.callerAuthority);
      if (refusal) return refusal;
      if (!manager.commitUserTranscript) {
        return { ok: false, error: 'Transcript commit unavailable', errorCode: 'execution_run_not_allowed' };
      }
      return await manager.commitUserTranscript(parsed.data.runId, {
        text: parsed.data.message,
        ...(typeof parsed.data.displayMessage === 'string'
          ? { displayText: parsed.data.displayMessage }
          : {}),
        localId: parsed.data.localId,
      });
    },
  );

  const detachActionOperationOwner = ctx.attachActionOperationOwner?.(manager.projectSetupOperations);
  return { dispose() { disposeAgentStartSelection(); detachActionOperationOwner?.(); } };
}
