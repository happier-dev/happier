import { randomUUID } from 'node:crypto';
import { readExecutionRunOfferedModel } from './structuredOutputAdmission';

import {
  type ExecutionRunHostRuntime,
} from './executionRunHostRuntime';
import type {
  ExecutionRunObservedInputTurn,
  ExecutionRunPermissionResponseBridgeResult,
} from './executionRunBridgeContract';
import type { ACPMessageData, ACPProvider } from '../../../../api/session/sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from '../../../../api/session/streamedTranscriptWriter';
import type { ExecutionBudgetRegistry } from '../../../../daemon/executionBudget/ExecutionBudgetRegistry';
import { buildBackendTargetKey } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AcpConfigOptionOverridesV1, BackendTargetRefV1, ConnectedServiceBindingsV2, ExecutionRunConnectedServicesLaunchV1, ExecutionRunUserTranscriptDirective, ExecutionRunBridgeLifecycleHookEventIdV1, ExecutionRunListRequest, ExecutionRunPublicState, ExecutionRunStartRequest, ExecutionRunResultContractV1, ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1, SessionRunPromptReadActionIdV1, SessionRunPromptContextV1, SessionInputCausalPermissionAuthorityV1, SecretReferenceOverlayV1, StructuredQuestionAnswersV1, ReviewWalkthroughObservation } from '@happier-dev/protocol';
import { SessionRunPromptContextV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { readActionCompletionRunObservationV1, isActionCompletionRunObservationPendingV1 } from '@happier-dev/protocol/actions/actionCompletion';

import { VoiceAgentError, VoiceAgentManager } from '../../../voice/agent/VoiceAgentManager';
import type {
  SessionExecutionRunBrokerAuthorityRequestV1,
  SessionExecutionRunBrokerAuthorityResponseV1,
} from '@happier-dev/protocol';
import { resolveCliVoicePromptPreparation } from '../../../prompts/library/resolveCliVoicePromptStackBlocks';
import type { VoicePromptPreparation } from '../../../voice/agent/voiceAgentTypes';
import { configuration } from '../../../../configuration';
import {
  type ExecutionRunActionParams,
  type ExecutionRunActionResult,
  type ExecutionRunManagerStartParams,
  type RetainedRunSessionInputAttachment,
  type ExecutionRunStartResult,
  type ExecutionRunState,
} from './executionRunTypes';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { ExecutionRunBackendController, ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { readBackendResumableRuntimeId } from '@/agent/executionRuns/controllers/types';
import {
  buildExecutionRunProfileCatalog,
  resolveExecutionRunIntentProfileFromCatalog,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import { createExecutionRunBridgeRuntime } from './createExecutionRunBridgeRuntime';
import type { ExecutionRunTeamCredentialProviderBindingPreparer } from './runtime/providerLaunch';
import type { ExecutionRunConnectedServicesSelectionReport } from './runtime/create';
import { withExecutionRunHostRuntimeCleanup } from './hostRuntime/cleanup';
import {
  createExecutionRunSnapshotLease,
  executionRunContributionSnapshotUnavailable,
} from './contributionSnapshotLease';
import { resolveExecutionRunResumeBackendOptions } from './resolveExecutionRunResumeBackendOptions';
import type { ExecutionRunWorkflowObservationSink } from './executionRunWorkflowObservation';
import {
  cancelVoiceAgentTurnStream,
  commitVoiceAgentUserTranscript,
  readVoiceAgentTurnStream,
  startVoiceAgentTurnStream,
} from './voiceAgentTurnStreams';
import { sendBackendLongLivedRun } from './send/backendLongLivedPrompt';
import { stopExecutionRun } from './executionRunStop';
import { applyExecutionRunAction } from './executionRunApplyAction';
import { getExecutionRunAvailableActionIds } from './availableActionIds';
import { executeBoundedBackendRun } from './bounded/loop';
import { ensureExecutionRun, type ExecutionRunEnsureResult } from './ensureExecutionRun';
import { applyReviewWalkthroughAction, applyReviewExplainFindingsAction } from './reviewNarrationAction';
import { finishExecutionRun } from './finishExecutionRun';
import { isExecutionRunControllerCurrent, settleExecutionRunController } from './settleExecutionRunController';
import {
  createExecutionRunOccurrenceWitnessRegistry,
  projectExecutionRunInputTurns,
  type ExecutionRunOccurrenceWitnessReaderV1,
} from './runOccurrenceWitness';
import { createExecutionRunPendingInputConsumer } from './pending/executionRunPendingInputConsumer';
import { createRetainedExecutionRunInputDelivery } from './pending/retainedExecutionRunInputDelivery';
import { publishExecutionRunTurn } from './publishExecutionRunTurn';
import {
  acknowledgeExecutionRunWorkerUpdate,
  readPendingExecutionRunWorkerUpdates,
  reconcileRetainedExecutionRunRecords,
  retainExecutionRunState,
  type RetainedExecutionRunWorkerUpdate,
} from '@/daemon/executionRunRegistry';
import type {
  HostContextOnlySourceInput,
  PreparedWorkerContextItem,
} from '@/agent/runtime/session/contextOnly/hostContextOnlyInput';
import { omitExecutionRunRoleCompositionContext, startExecutionRun } from './startExecutionRun';
import { cancelCurrentExecutionRunTurn } from './cancelCurrentExecutionRunTurn';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import type { ExecutionRunSessionStateTarget } from './sessionStateDelivery';
import { enqueueExecutionRunMarkerWrite, writeExecutionRunActivityMarker } from './activityMarkers';
import type { ExecutionRunHostBridgeContract } from './executionRunBridgeContract';
import { matchesExecutionRunLegacyBackendId } from './backendTargets';
import {
  readExecutionRunPermissionResponseApprovedFromDispatch,
  observeExecutionRunPermissionStore,
  readExecutionRunPermissionResponseTargetFromDispatch,
  type ExecutionRunParentSessionPermissionResponseTarget,
  type ExecutionRunPermissionRequestStore,
  type ExecutionRunPermissionRequestStoreProvider,
} from './executionRunPermissionResponseTarget';
import type { AgentStateResponseTargetDispatch } from '@/agent/permissions/agentStateRequestStore';
import { readExecutionRunParentSessionPermissionResponseTarget } from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import { buildRunScopedExecutionPermissionRequestId } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import { emitBridgeLifecycleHookEventBestEffort } from '@/agent/runtime/bridges/_shared/emitBridgeLifecycleHookEventBestEffort';
import type {
  ReviewCommentHostActionCandidate,
  ReviewCommentHostActionMaterializationResult,
} from '@/agent/executionRuns/profiles/review/hostActionMaterializer';
import { createExecutionRunCodedError, readExecutionRunErrorCode } from './errors';
import type { ResolvedCliEngineRegistry } from '@/agent/runtime/registry/engineRegistryTypes';
import type {
  ExecutionRunHostRunScopeBinding,
  NativeAgentSessionInteractionHostBinding,
  NativeAgentSessionRunTranscriptTarget,
} from '@/agent/runtime/registry/engineRegistryTypes';
import { createExecutionRunTranscriptProjection } from './messages/sessionStateEmission';
import { createExecutionRunTranscriptCustodyError } from './executionRunTranscriptPublisher';
import { logger } from '@/ui/logger';
import { projectSessionComposerAttachmentDispatchInput } from '@/agent/runtime/runPermissionModePromptLoop';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveExecutionRunLifecycle } from './resolveExecutionRunLifecycle';
import { projectExecutionRunPublicState } from './publicState';
import {
  LaunchSecretReferenceOverlayError,
  readLaunchSecretReferenceOverlayProviderErrorCodeV1,
  resolveSecretReferenceOverlayEnvironment,
} from '@/settings/secrets/secretReferenceOverlay';
import { SavedSecretOperationAdmissionError } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { ReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import { readWorktreeChangeFingerprint } from '@/scm/readWorktreeChangeFingerprint';

type ExecutionRunProfileCatalogResolution = Readonly<{
  profileCatalog: ExecutionRunProfileContributionCatalog;
  engineRegistry: ResolvedCliEngineRegistry;
  release?: () => Promise<void>;
}>;

async function awaitExecutionRunObservation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Execution run wait cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * One host-authored prompt projection for a retained Session-owned Run.
 * Launch provenance and advertised reads are descriptive only; Action calls
 * still re-enter their canonical policy, authority, and currentness owners.
 */
export function buildExecutionRunSessionPromptContext(params: Readonly<{
  sessionId: string;
  launchOrigin?: ExecutionRunStartRequest['launchOrigin'];
  supportedReadActions: readonly SessionRunPromptReadActionIdV1[];
}>): SessionRunPromptContextV1 {
  const origin = params.launchOrigin?.kind === 'session_discussion'
    ? {
        kind: params.launchOrigin.kind,
        discussionId: params.launchOrigin.discussionId,
        messageIds: params.launchOrigin.messageIds,
      }
    : null;
  return SessionRunPromptContextV1Schema.parse({
    kind: 'happier_session_run',
    sessionId: params.sessionId,
    ...(origin ? { origin } : {}),
    supportedReadActions: params.supportedReadActions,
  });
}

type ExecutionRunRuntimeCreateOptions = Readonly<{
  cwd?: string;
  runId?: string;
  controllerOccurrenceId?: string;
  callId?: string;
  sidechainId?: string;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  permissionMode: string;
  workspaceWrites?: 'allow' | 'deny';
  modelId?: string;
  modelSelection?: ProviderBoundModelRef;
  teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  secretReferenceOverlay?: SecretReferenceOverlayV1;
  /** First launch only: materialized before Run creation and retained only in this runtime closure. */
  secretReferenceEnvironment?: Readonly<Record<string, string>>;
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  connectedServices?: ConnectedServiceBindingsV2 | null;
  connectedServicesDefaultServiceIds?: readonly string[];
  start?: ExecutionRunBackendStartContext;
  engineRegistry?: ResolvedCliEngineRegistry;
  onConnectedServicesRegistration?: (registration: ExecutionRunConnectedServicesLaunchV1) => void | Promise<void>;
  machineId?: string;
  resolveProvidersFeatureEnabled?: () => boolean | Promise<boolean>;
  resolveAccountSettingsSnapshot?: (input?: Readonly<{
    secretReferenceOverlay?: SecretReferenceOverlayV1;
    mcpServerCatalog?: boolean;
    signal?: AbortSignal;
  }>) => Promise<ActiveAccountSettingsSnapshot | null>;
}>;

function isExecutionRunProfileCatalogResolution(
  value: unknown,
): value is ExecutionRunProfileCatalogResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const resolution = value as Partial<ExecutionRunProfileCatalogResolution>;
  const engineRegistry = resolution.engineRegistry;
  const contributions = engineRegistry?.contributions;
  return Boolean(
    resolution.profileCatalog
    && engineRegistry
    && typeof engineRegistry.resolveForBackendId === 'function'
    && contributions
    && contributions.agentDefinitionsById instanceof Map,
  );
}

function compareExecutionRunStatesForList(left: ExecutionRunState, right: ExecutionRunState): number {
  if (left.startedAtMs !== right.startedAtMs) {
    return left.startedAtMs - right.startedAtMs;
  }
  return left.runId.localeCompare(right.runId);
}

function normalizeExecutionRunListLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

async function prepareExecutionRunManagerStartParams(
  params: ExecutionRunManagerStartParams,
  cwd: string,
  profileCatalog: ExecutionRunProfileContributionCatalog,
): Promise<ExecutionRunManagerStartParams> {
  const profile = resolveExecutionRunIntentProfileFromCatalog(
    profileCatalog,
    params.intent,
    params.profileId,
    params.profileSourceCustody,
  );
  const input = params.intentInput && typeof params.intentInput === 'object' && !Array.isArray(params.intentInput)
    ? params.intentInput as Readonly<Record<string, unknown>> : {};
  const offeredModel = (params.intent === 'scm_diff_summary'
    || (params.intent === 'review' && Array.isArray(input.outputs) && input.outputs.includes('walkthrough')))
    ? await readExecutionRunOfferedModel({ ...params, cwd }) : undefined;
  const startProfilePatch = await profile.prepareStartParams?.({
    sessionId: params.sessionId,
    request: omitExecutionRunRoleCompositionContext(params) as unknown as ExecutionRunStartRequest,
    cwd,
    ...(offeredModel?.contextWindowTokens ? { contextWindowTokens: offeredModel.contextWindowTokens } : {}),
  });

  const prepared: Record<string, unknown> = {
    ...(params as unknown as Record<string, unknown>),
    ...(startProfilePatch ?? {}),
    requesterWorkAttributionV1: params.requesterWorkAttributionV1,
  };
  delete prepared.replay;

  return prepared as ExecutionRunManagerStartParams;
}

export type ExecutionRunHostBridgeOptions = Readonly<{
  admitStart?: () => Promise<void>;
  parentProvider: ACPProvider;
  cwd: string;
  sendAcp: ExecutionRunTranscriptPublisher;
  streamedTranscriptSession?: StreamedTranscriptWriterSession;
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
  onPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
  onVoiceAgentWelcomed?: (run: ExecutionRunPublicState, welcomedEpoch: number) => void | Promise<void>;
  getNowMs?: () => number;
  boundedTimeoutMs?: number;
  maxTurns?: number;
  budgetRegistry?: ExecutionBudgetRegistry;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  resolveVoicePromptPreparation?: (args: Readonly<{
    settings?: unknown;
    profileId?: string | null;
    sessionId?: string | null;
    workingDirectory?: string | null;
    signal?: AbortSignal;
  }>) => Promise<VoicePromptPreparation>;
  executionRunProfileCatalog?: ExecutionRunProfileContributionCatalog;
  resolveExecutionRunProfileCatalog?: () =>
    | Promise<ExecutionRunProfileCatalogResolution>
    | ExecutionRunProfileCatalogResolution;
  happyHomeDir?: string;
  parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
  sessionInteractionHost?: NativeAgentSessionInteractionHostBinding;
  prepareRunTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
  materializeReviewHostAction?: (
    readCurrentCandidate: () => ReviewCommentHostActionCandidate | null,
  ) => Promise<ReviewCommentHostActionMaterializationResult>;
  reviewComments?: ReviewRunCommentService;
  checkConnectedServicesGenerationCurrent?: (input: Readonly<{
    runId: string;
    registration: ExecutionRunConnectedServicesLaunchV1;
  }>) => Promise<Readonly<{ current: boolean }>>;
  machineId?: string;
  resolveProvidersFeatureEnabled?: () => boolean | Promise<boolean>;
  resolveAccountSettingsSnapshot?: (input?: Readonly<{
    secretReferenceOverlay?: SecretReferenceOverlayV1;
    mcpServerCatalog?: boolean;
    signal?: AbortSignal;
  }>) => Promise<ActiveAccountSettingsSnapshot | null>;
}>;

/**
 * Canonical execution-run host-bridge owner. The older March/plan-only
 * `AgentExecutionRunRuntimeBridge` / `createExecutionRunRuntimeBridge.ts` naming is superseded by
 * this class plus the shared execution-run runtime helpers it composes.
 */
export class ExecutionRunHostBridge implements ExecutionRunHostBridgeContract {
  private readonly admitStart: ExecutionRunHostBridgeOptions['admitStart'];
  private readonly parentProvider: ACPProvider;
  private readonly cwd: string;
  private readonly sendAcp: ExecutionRunTranscriptPublisher;
  private readonly streamedTranscriptSession: StreamedTranscriptWriterSession | null;
  private readonly transcriptWriter:
    | Readonly<{
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
      }>
    | null;
  private readonly getNowMs: () => number;
  private readonly boundedTimeoutMs: number | null;
  private readonly maxTurns: number | null;
  private readonly budgetRegistry: ExecutionBudgetRegistry | null;
  private readonly happyHomeDir: string | null;
  private readonly parentSessionStateTarget: ExecutionRunSessionStateTarget | null;
  private readonly sessionInteractionHost: NativeAgentSessionInteractionHostBinding | null;
  private readonly prepareRunTeamCredentialProviderBinding: ExecutionRunTeamCredentialProviderBindingPreparer | null;
  private readonly materializeReviewHostAction: ExecutionRunHostBridgeOptions['materializeReviewHostAction'];
  private readonly reviewComments: ReviewRunCommentService | undefined;
  private readonly checkConnectedServicesGenerationCurrent: ExecutionRunHostBridgeOptions['checkConnectedServicesGenerationCurrent'];
  private readonly machineId: string | null;
  private readonly resolveProvidersFeatureEnabled: ExecutionRunHostBridgeOptions['resolveProvidersFeatureEnabled'];
  private readonly resolveAccountSettingsSnapshot: ExecutionRunHostBridgeOptions['resolveAccountSettingsSnapshot'];
  private readonly resolveAccountSettings: ExecutionRunHostBridgeOptions['resolveAccountSettings'];
  /** Rebuildable projection of the marker owner's retained terminal completions. Taking never consumes. */
  private readonly workerUpdates = new Map<string, RetainedExecutionRunWorkerUpdate>();
  private readonly workerUpdateWaiters = new Set<(sessionId: string) => void>();
  private workerUpdateRecovery: Promise<void> | null = null;
  private workerUpdateAcknowledgements: Promise<void> = Promise.resolve();
  private readonly getPermissionRequestStore: ExecutionRunPermissionRequestStoreProvider | null;
  private readonly runs = new Map<string, ExecutionRunState>();
  private retainedRunRecovery: Promise<void> | null = null;
  private readonly controllers = new Map<string, ExecutionRunController>();
  private readonly markerWriteChains = new Map<string, Promise<void>>();
  private readonly terminalMarkerWritePromises = new Map<string, Promise<void>>();
  private readonly runStateChangeWaiters = new Set<(runId: string) => void>();
  private readonly voiceAgentManager: VoiceAgentManager;
  private executionRunProfileCatalog: ExecutionRunProfileContributionCatalog;
  private readonly resolveExecutionRunProfileCatalogOption:
    | (() => Promise<ExecutionRunProfileCatalogResolution> | ExecutionRunProfileCatalogResolution)
    | null;
  private readonly onPublicStateUpdated: ((run: ExecutionRunPublicState) => void) | null;
  private readonly onVoiceAgentWelcomed: ((run: ExecutionRunPublicState, welcomedEpoch: number) => void | Promise<void>) | null;
  private permissionResponseTargetStore: ExecutionRunPermissionRequestStore | null = null;
  private unregisterPermissionResponseTargetHandler: (() => void) | null = null;
  private disposePromise: Promise<void> | null = null;

  /**
   * Stable occurrence identities projected from this bridge's canonical
   * controller map. Consumers rebuilt per request hold `.reader` so currentness
   * always resolves through that map and the controller runtime lifetime.
   */
  private readonly runOccurrenceWitnesses = createExecutionRunOccurrenceWitnessRegistry(this.controllers);

  /** The exact Run occurrence/turn witness reader for this bridge's Session. */
  readExecutionRunOccurrenceWitnessReader(): ExecutionRunOccurrenceWitnessReaderV1 {
    return this.runOccurrenceWitnesses.reader;
  }

  /** Resolve broker/Follow authority from the exact live controller owner. */
  resolveLiveBrokerAuthority(
    request: SessionExecutionRunBrokerAuthorityRequestV1,
  ): SessionExecutionRunBrokerAuthorityResponseV1 {
    const deny = (reason: Extract<SessionExecutionRunBrokerAuthorityResponseV1, { status: 'not_current' }>['reason']) => ({
      status: 'not_current' as const,
      reason,
    });
    const run = this.runs.get(request.executionRunId);
    if (!run) return deny('not_found');
    if (request.expectedIntent !== undefined && run.intent !== request.expectedIntent) return deny('identity_mismatch');
    if (run.status !== 'running') return deny('terminal');
    const controller = this.controllers.get(run.runId);
    if (!controller || controller.cancelled) return deny('runtime_unavailable');
    // The Run's own accepted provider-model selection; null when it selected
    // nothing and inherits its parent Session's. One derivation serves the
    // direct-material expectation below and the broker attestation returned.
    const ownTeamCredentialModel = run.launch?.teamCredentialModel
      ? {
        resourceId: run.launch.teamCredentialModel.resourceId,
        deliveryMode: run.launch.teamCredentialModel.deliveryMode,
      }
      : null;
    if (request.expectedDirectMaterialUse) {
      const expectedDirectMaterialUse = request.expectedDirectMaterialUse;
      if (expectedDirectMaterialUse.slot.kind === 'provider_model') {
        if (
          ownTeamCredentialModel?.resourceId !== expectedDirectMaterialUse.resourceId
          || ownTeamCredentialModel.deliveryMode !== 'direct'
        ) {
          return deny('identity_mismatch');
        }
      } else {
        if (!('disclosedMember' in expectedDirectMaterialUse)) return deny('identity_mismatch');
        // The registration once materialization returned; before that, the
        // exact selection this Run reported for the materialization now asking.
        const registration = run.launch?.connectedServicesRegistration;
        const attested = registration
          ? { bindings: registration.connectedServicesBindings, agent: registration.agentContribution ?? null }
          : run.launch?.connectedServicesSelection && run.launch.connectedServicesSelectionAgent
            ? { bindings: run.launch.connectedServicesSelection, agent: run.launch.connectedServicesSelectionAgent }
            : null;
        const serviceId = buildQualifiedPluginContributionKey(
          expectedDirectMaterialUse.disclosedMember.service,
        );
        const selection = attested?.bindings.bindingsByServiceId[serviceId];
        const purpose = expectedDirectMaterialUse.slot.purpose;
        if (
          !attested?.agent
          || attested.agent.pluginId !== purpose.consumer.pluginId
          || attested.agent.localId !== purpose.consumer.localId
          || selection?.source !== 'team_resource'
          || selection.resourceId !== expectedDirectMaterialUse.resourceId
          || selection.deliveryMode !== 'direct'
          || !selection.disclosedMember
          || !sameQualifiedConnectedAccountRef(
            selection.disclosedMember,
            expectedDirectMaterialUse.disclosedMember,
          )
        ) return deny('identity_mismatch');
      }
    }

    let occurrenceId: string;
    let runtimeState: 'active_turn' | 'idle';
    let activeTurnId: string | null;
    if (controller.kind === 'backend') {
      if (controller.backend.getRuntimeLifetimeSignal().aborted) return deny('runtime_unavailable');
      occurrenceId = controller.controllerOccurrenceId;
      try {
        const witness = controller.backend.readActiveTurnAdmissionWitness?.() ?? null;
        runtimeState = witness ? 'active_turn' : 'idle';
        activeTurnId = witness?.turnId ?? null;
      } catch {
        return deny('runtime_unavailable');
      }
    } else {
      const voice = this.voiceAgentManager.readCurrentRuntimeAuthority(controller.voiceAgentId);
      if (!voice) return deny('runtime_unavailable');
      occurrenceId = controller.controllerOccurrenceId;
      runtimeState = voice.runtimeState;
      activeTurnId = voice.activeTurnId;
    }
    if (request.expectedOccurrenceId !== null && occurrenceId !== request.expectedOccurrenceId) {
      return deny('occurrence_mismatch');
    }
    return {
      status: 'current',
      executionRunId: run.runId,
      occurrenceId,
      parentSessionId: run.sessionId,
      intent: run.intent,
      runtimeState,
      activeTurnId,
      teamCredentialProviderModel: ownTeamCredentialModel,
    };
  }

  /**
   * The host-only Run scope one Session-owned Run's runtime composition consumes.
   *
   * It carries no permission decision or Account identity: it exposes this
   * bridge's canonical occurrence owner and re-scopes the parent Session's
   * durable transcript writer onto this Run's sidechain. Detached Runs and Runs
   * without parent Session custody receive no scope at all.
   */
  private createSessionOwnedRunScope(runId: string): ExecutionRunHostRunScopeBinding | null {
    const host = this.sessionInteractionHost;
    const run = this.runs.get(runId);
    if (!host || !run || typeof run.sessionId !== 'string' || run.sessionId.trim().length === 0) {
      return null;
    }
    const sidechainId = run.sidechainId;
    const parentSession = host.session;
    return Object.freeze({
      runId,
      workDepth: run.depth,
      sidechainId,
      readCurrentRunOccurrence: (id: string) => (
        this.runOccurrenceWitnesses.reader.readCurrentRunOccurrence(id)
      ),
      publishSupportedSessionReadActions: (actionIds, runtimeLifetimeSignal) => {
        const controller = this.controllers.get(runId);
        if (
          !controller
          || controller.kind !== 'backend'
          || runtimeLifetimeSignal.aborted
          || controller.backend.getRuntimeLifetimeSignal() !== runtimeLifetimeSignal
        ) return;
        controller.supportedSessionReadActions = Object.freeze([...actionIds]);
      },
      projectRunTranscriptSession: () => {
        const target: NativeAgentSessionRunTranscriptTarget = {
          sessionId: parentSession.sessionId,
          requiresDurableTurnCompletionMarker: true,
          updateMetadata: (updater) => parentSession.updateMetadata(updater),
          enqueueAgentMessageCommitted: async (provider, body, opts) => {
            // Custody is re-read per write: a superseded or settled controller
            // must refuse rather than reach the parent's main transcript.
            const controller = this.controllers.get(runId);
            if (!controller) throw createExecutionRunTranscriptCustodyError();
            if (controller.kind !== 'backend') {
              // Voice and other non-backend controllers own no pending-input
              // acceptance gate, but the sidechain is still theirs.
              return await parentSession.enqueueAgentMessageCommitted(
                provider,
                { ...body, sidechainId },
                opts,
              );
            }
            const runtimeTurnId = typeof opts.meta?.runtimeTurnId === 'string'
              ? opts.meta.runtimeTurnId.trim()
              : '';
            const inputTurn = runtimeTurnId.length > 0
              ? [controller.currentInputTurn, controller.lastInputTurn]
                  .find((candidate) => candidate?.turnId === runtimeTurnId)
              : undefined;
            const runScopedOpts = inputTurn
              ? {
                  ...opts,
                  meta: {
                    ...opts.meta,
                    happierExecutionRunInputTurnV1: {
                      turnId: inputTurn.turnId,
                      inputIds: [...inputTurn.inputIds],
                      state: inputTurn.state,
                    },
                  },
                }
              : opts;
            const projected = createExecutionRunTranscriptProjection({
              controller,
              sidechainId,
              isCurrent: () => isExecutionRunControllerCurrent({
                runId,
                controller,
                controllers: this.controllers,
              }),
              session: parentSession,
            }).enqueueAgentMessageCommitted;
            if (!projected) throw createExecutionRunTranscriptCustodyError();
            return await projected(provider, body, runScopedOpts);
          },
        };
        return Object.freeze(target);
      },
    });
  }

  /**
   * Compose one exact-target pending consumer for a retained Session-owned Run.
   *
   * The parent Session client owns custody, claim ordering and settlement; this
   * only binds the exact target, reads activity from this Run's controller and
   * delivers through the retained runtime's existing operations.
   */
  private attachRetainedRunSessionInput(params: Readonly<{
    runId: string;
    sidechainId: string;
    controller: ExecutionRunBackendController;
  }>): RetainedRunSessionInputAttachment | null {
    const host = this.sessionInteractionHost;
    const bindPendingInput = host?.session.bindExecutionRunPendingInput;
    if (!host || typeof bindPendingInput !== 'function') return null;
    const { controller, runId, sidechainId } = params;
    const supportsSteer = controller.backend.interaction?.capabilities.delivery.includes('steer') === true;
    const isCurrent = (): boolean => isExecutionRunControllerCurrent({
      runId,
      controller,
      controllers: this.controllers,
    });
    const publishTurn = async (turn: Readonly<{ turnId: string; inputIds?: readonly string[]; rawText: string; finishedAtMs: number;
      diagnostic?: Readonly<{ code: string; message?: string }>; admittedInputId?: string }>): Promise<void> => {
      await publishExecutionRunTurn({
        ...turn, runId, controller, runs: this.runs, controllers: this.controllers,
        profileCatalog: this.executionRunProfileCatalog, sendAcp: this.sendAcp, parentProvider: this.parentProvider,
        reviewComments: this.reviewComments,
        onPublicStateUpdated: (id) => this.emitPublicStateUpdated(id),
        admitNextInput: async ({ instructions, localId }) => {
          if (!isCurrent() || controller.cancelled) return { status: 'rejected', code: 'execution_run_not_allowed' };
          const admit = host.session.enqueueSessionUserMessageWithDisposition;
          if (!admit) return { status: 'rejected', code: 'execution_run_not_allowed', message: 'Canonical retained continuation admission is unavailable' };
          const result = await admit.call(host.session, { text: instructions, localId,
            recipient: { kind: 'execution_run', runId }, requestedAction: { v: 1, kind: 'enqueue' } });
          return result.status === 'rejected' || result.status === 'outcomeUnknown'
            ? { status: result.status, code: result.code } : { status: 'accepted' };
        },
      });
    };
    const runInput = createRetainedExecutionRunInputDelivery({
      runId,
      controller,
      onInputTurnUpdated: () => this.emitPublicStateUpdated(params.runId),
      onTurnComplete: publishTurn,
      onTurnFailed: publishTurn,
      beforeProviderInput: async (localId) => {
        // Settle prior output before a new turn can reset its buffer or capture an obsolete saved revision.
        await controller.pendingHostBarrier;
        const start = this.runs.get(runId);
        if (!start || !isCurrent()) throw createExecutionRunTranscriptCustodyError();
        const profile = resolveExecutionRunIntentProfileFromCatalog(this.executionRunProfileCatalog,
          start.intent, start.profileId, start.profileSourceCustody);
        await profile.onBeforeRetainedInput?.({ start, localId });
        // Pending has supplied this exact admitted input for delivery. Deferred
        // provisioning alone is not evidence of an initial part admission.
        await publishTurn({ turnId: '', rawText: '', finishedAtMs: Date.now(), admittedInputId: localId });
      },
      readInitialProfileContext: () => {
        const start = this.runs.get(runId);
        if (!start) return '';
        const profile = resolveExecutionRunIntentProfileFromCatalog(this.executionRunProfileCatalog,
          start.intent, start.profileId, start.profileSourceCustody);
        return profile.buildInitialInputContext?.({ start, structuredMeta: start.structuredMeta }) ?? '';
      },
      sessionRunContext: buildExecutionRunSessionPromptContext({
        sessionId: host.session.sessionId,
        launchOrigin: this.runs.get(runId)?.launch?.launchOrigin,
        supportedReadActions: controller.supportedSessionReadActions ?? [],
      }),
      authorizeProviderEffect: () => this.authorizeConnectedServicesProviderEffect(runId),
      structuredInputContext: {
        catalogs: {
          ...(typeof host.listSkills === 'function' ? { listSkills: host.listSkills } : {}),
          ...(typeof host.listVendorPlugins === 'function'
            ? { listVendorPlugins: host.listVendorPlugins }
            : {}),
        },
        ...(typeof host.resolveComposerReference === 'function'
          ? {
              composerReferences: {
                resolve: host.resolveComposerReference,
                signal: controller.backend.getRuntimeLifetimeSignal(),
              },
            }
          : {}),
        ...(typeof host.resolveComposerAttachmentForDispatch === 'function'
          ? {
              composerAttachments: {
                scope: { kind: 'session' as const, sessionId: host.session.sessionId },
                resolve: async (input) => await host.resolveComposerAttachmentForDispatch!(
                  projectSessionComposerAttachmentDispatchInput(input, host.session.sessionId),
                ),
                signal: controller.backend.getRuntimeLifetimeSignal(),
              },
            }
          : {}),
      },
    });
    const registration = this.runOccurrenceWitnesses.register({
      runId,
      sidechainId,
      controller,
      runtimeLifetimeSignal: controller.backend.getRuntimeLifetimeSignal(),
      // Native disposal starts before controller settlement retires this
      // registration; a cancelled controller must stop supplying authority at once.
      isRuntimeLive: () => !controller.cancelled,
      // The Run's own admitted turn; the parent Session's concurrent turn is
      // never substituted for it.
      readActiveTurnAdmissionWitness: () => (
        isCurrent() ? runInput.readActiveTurnAdmissionWitness() : null
      ),
    });
    const consumer = createExecutionRunPendingInputConsumer({
      recipient: { kind: 'execution_run', runId },
      sidechainId,
      bindPendingInput: (binding) => bindPendingInput.call(host.session, binding),
      getMetadataSnapshot: () => host.session.getMetadataSnapshot(),
      readRuntimeActivity: () => ({
        turnInFlight: controller.turnInFlight,
        supportsSteer,
      }),
      isCurrent,
      delivery: {
        ...runInput.delivery,
        deliver: async (input) => {
          const localId = input.localId;
          if (typeof localId === 'string') {
            controller.pendingInputAcceptance = consumer.awaitAcceptedUserAnchor(localId);
          }
          return await runInput.delivery.deliver(input);
        },
      },
    });
    return Object.freeze({
      awaitInputAdmission: (localId: string) => consumer.awaitAcceptedUserAnchor(localId),
      release: async () => {
        runInput.dispose();
        registration.dispose();
        await consumer.dispose();
      },
    });
  }

  private emitPublicStateUpdated(runId: string): void {
    const state = this.captureRetainedState(runId);
    if (state) {
      void this.enqueueMarkerWrite(runId, () => retainExecutionRunState(state)).catch(() => {
        logger.warn('[EXECUTION RUN] Run checkpoint unavailable', { runId, code: 'execution_run_state_unavailable' });
      });
    }
    for (const waiter of this.runStateChangeWaiters) waiter(runId);
    const callback = this.onPublicStateUpdated;
    if (!callback) return;
    // Session-state projection is not a detached-run registry. Detached runs
    // remain at this bridge/marker owner and must not acquire Session list
    // membership merely because this bridge also serves Session runs.
    if (this.runs.get(runId)?.sessionId === null) return;
    const run = (() => {
      try {
        return this.getPublic(runId);
      } catch {
        return null;
      }
    })();
    if (!run) return;
    try {
      callback(run);
    } catch {
      // Best effort
    }
  }

  async waitForRunStateChange(runId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        this.runStateChangeWaiters.delete(onChange);
        signal?.removeEventListener('abort', onAbort);
        error === undefined ? resolve() : reject(error);
      };
      const onChange = (updatedRunId: string) => {
        if (updatedRunId === runId) finish();
      };
      const onAbort = () => finish(signal?.reason ?? new Error('Execution-run observation aborted'));
      this.runStateChangeWaiters.add(onChange);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private enqueueMarkerWrite(runId: string, write: () => Promise<void>): Promise<void> {
    return enqueueExecutionRunMarkerWrite({ markerWriteChains: this.markerWriteChains, runId, write });
  }

  private async writeActivityMarker(
    runId: string,
    nowMs: number,
    opts?: Readonly<{ force?: boolean }>,
  ): Promise<void> {
    const state = this.captureRetainedState(runId);
    await writeExecutionRunActivityMarker({
      runId,
      nowMs,
      opts,
      runs: this.runs,
      ...(state ? { retainedState: state } : {}),
      controllers: this.controllers,
      enqueueMarkerWrite: this.enqueueMarkerWrite.bind(this),
    });
  }

  private async handleVoiceAgentIdleReaped(voiceAgentId: string): Promise<void> {
    const owned = [...this.controllers.entries()].find(([, controller]) => (
      controller.kind === 'voice_agent' && controller.voiceAgentId === voiceAgentId
    )) ?? null;
    if (!owned) return;

    const [runId, controller] = owned;
    const run = this.runs.get(runId) ?? null;
    if (!run || run.status !== 'running' || controller.cancelled) return;

    controller.cancelled = true;
    const finishedAtMs = this.getNowMs();
    const output = {
      status: 'cancelled',
      summary: 'Cancelled after inactivity',
      runId: run.runId,
      callId: run.callId,
      sidechainId: run.sidechainId,
      backendTarget: run.backendTarget,
      intent: run.intent,
      startedAtMs: run.startedAtMs,
      finishedAtMs,
    };

    try {
      await this.finishRun(
        runId,
        { status: 'cancelled', summary: 'Cancelled after inactivity', finishedAtMs },
        { output },
      );
    } finally {
      await settleExecutionRunController({
        runId,
        controller,
        controllers: this.controllers,
      });
      this.emitPublicStateUpdated(runId);
    }
  }

  private async handleVoiceAgentTerminalFailure(voiceAgentId: string): Promise<void> {
    const owned = [...this.controllers.entries()].find(([, controller]) => (
      controller.kind === 'voice_agent' && controller.voiceAgentId === voiceAgentId
    )) ?? null;
    if (!owned) return;

    const [runId, controller] = owned;
    const run = this.runs.get(runId) ?? null;
    if (!run || run.status !== 'running' || controller.cancelled) return;

    controller.cancelled = true;
    const finishedAtMs = this.getNowMs();
    const summary = 'Voice agent runtime failed';
    const output = {
      status: 'failed',
      summary,
      runId: run.runId,
      callId: run.callId,
      sidechainId: run.sidechainId,
      backendTarget: run.backendTarget,
      intent: run.intent,
      startedAtMs: run.startedAtMs,
      finishedAtMs,
    };

    try {
      await this.finishRun(
        runId,
        { status: 'failed', summary, finishedAtMs },
        { output, isError: true },
      );
    } finally {
      await settleExecutionRunController({
        runId,
        controller,
        controllers: this.controllers,
      });
      this.emitPublicStateUpdated(runId);
    }
  }

  private async resolveExecutionRunProfileCatalog(): Promise<Readonly<{
    profileCatalog: ExecutionRunProfileContributionCatalog;
    engineRegistry?: ResolvedCliEngineRegistry;
    release?: () => Promise<void>;
  }>> {
    const resolver = this.resolveExecutionRunProfileCatalogOption;
    if (!resolver) {
      return { profileCatalog: this.executionRunProfileCatalog };
    }
    const resolved = await resolver();
    if (!isExecutionRunProfileCatalogResolution(resolved)) {
      throw executionRunContributionSnapshotUnavailable();
    }
    this.executionRunProfileCatalog = resolved.profileCatalog;
    return resolved;
  }

  constructor(opts: ExecutionRunHostBridgeOptions) {
    this.admitStart = opts.admitStart;
    this.parentProvider = opts.parentProvider;
    this.cwd = opts.cwd;
    this.sendAcp = opts.sendAcp;
    this.streamedTranscriptSession = opts.streamedTranscriptSession ?? null;
    this.transcriptWriter = opts.transcriptWriter ?? null;
    this.getNowMs = opts.getNowMs ?? (() => Date.now());
    this.boundedTimeoutMs =
      typeof opts.boundedTimeoutMs === 'number' && Number.isFinite(opts.boundedTimeoutMs) && opts.boundedTimeoutMs >= 1
        ? Math.floor(opts.boundedTimeoutMs)
        : null;
    this.maxTurns =
      typeof opts.maxTurns === 'number' && Number.isFinite(opts.maxTurns) && opts.maxTurns >= 1
        ? Math.floor(opts.maxTurns)
        : null;
    this.budgetRegistry = opts.budgetRegistry ?? null;
    this.getPermissionRequestStore = typeof opts.getPermissionRequestStore === 'function'
      ? opts.getPermissionRequestStore
      : null;
    this.happyHomeDir = typeof opts.happyHomeDir === 'string' && opts.happyHomeDir.trim().length > 0
      ? opts.happyHomeDir.trim()
      : configuration.happyHomeDir;
    this.parentSessionStateTarget = opts.parentSessionStateTarget ?? null;
    this.sessionInteractionHost = opts.sessionInteractionHost ?? null;
    this.prepareRunTeamCredentialProviderBinding = opts.prepareRunTeamCredentialProviderBinding ?? null;
    this.materializeReviewHostAction = opts.materializeReviewHostAction;
    this.reviewComments = opts.reviewComments;
    this.checkConnectedServicesGenerationCurrent = opts.checkConnectedServicesGenerationCurrent;
    this.machineId = typeof opts.machineId === 'string' && opts.machineId.trim().length > 0
      ? opts.machineId.trim()
      : null;
    this.resolveProvidersFeatureEnabled = opts.resolveProvidersFeatureEnabled;
    this.resolveAccountSettingsSnapshot = opts.resolveAccountSettingsSnapshot;
    this.resolveAccountSettings = opts.resolveAccountSettings;
    this.onPublicStateUpdated = typeof opts.onPublicStateUpdated === 'function' ? opts.onPublicStateUpdated : null;
    this.onVoiceAgentWelcomed = typeof opts.onVoiceAgentWelcomed === 'function' ? opts.onVoiceAgentWelcomed : null;
    this.executionRunProfileCatalog = opts.executionRunProfileCatalog ?? buildExecutionRunProfileCatalog();
    this.resolveExecutionRunProfileCatalogOption = typeof opts.resolveExecutionRunProfileCatalog === 'function'
      ? opts.resolveExecutionRunProfileCatalog
      : null;
    const resolveAccountSettings = opts.resolveAccountSettings ?? (async () => null);
    const resolveVoicePromptPreparation = opts.resolveVoicePromptPreparation
      ?? (async ({
        settings,
        profileId,
        sessionId,
        workingDirectory,
        signal,
      }: Readonly<{
        settings?: unknown;
        profileId?: string | null;
        sessionId?: string | null;
        workingDirectory?: string | null;
        signal?: AbortSignal;
      }>) => await resolveCliVoicePromptPreparation({ settings, profileId, sessionId, directory: workingDirectory ?? undefined, signal }));

    this.voiceAgentManager = new VoiceAgentManager({
      createRuntime: ({ backendTarget, backendId, modelId, permissionIntent, start, connectedServices }) => {
        try {
          return this.createExecutionRunRuntime({
            backendId,
            backendTarget,
            modelId,
            permissionMode: permissionIntent,
            ...(start ? { start } : {}),
            ...(connectedServices !== undefined ? { connectedServices } : {}),
          });
        } catch (e) {
          // Backend init failures should surface as "unsupported" so callers can fall back to
          // alternate voice engines. If the backend already classified the error, preserve it.
          if (e instanceof VoiceAgentError) throw e;
          const message = e instanceof Error ? e.message : 'unsupported';
          throw new VoiceAgentError('VOICE_AGENT_UNSUPPORTED', message);
        }
      },
      resolvePromptPreparation: async ({ profileId, sessionId, workingDirectory, signal }) => {
        const settings = await resolveAccountSettings();
        return await resolveVoicePromptPreparation({
          settings,
          profileId,
          sessionId,
          workingDirectory: workingDirectory ?? this.cwd,
          ...(signal ? { signal } : {}),
        });
      },
      responseTimeoutMs: configuration.voiceAgentResponseTimeoutMs,
      getNowMs: this.getNowMs,
      onIdleReaped: this.handleVoiceAgentIdleReaped.bind(this),
      onTerminalFailure: this.handleVoiceAgentTerminalFailure.bind(this),
      onActivityChanged: (voiceAgentId) => {
        const run = this.runs.get(voiceAgentId);
        const controller = this.controllers.get(voiceAgentId);
        if (
          run?.status !== 'running'
          || controller?.kind !== 'voice_agent'
          || controller.cancelled
          || controller.voiceAgentId !== voiceAgentId
        ) return;
        this.emitPublicStateUpdated(voiceAgentId);
      },
      onResumeHandleChanged: (voiceAgentId, resumeHandle) => {
        const run = this.runs.get(voiceAgentId);
        const controller = this.controllers.get(voiceAgentId);
        if (
          run?.status !== 'running'
          || controller?.kind !== 'voice_agent'
          || controller.cancelled
          || controller.voiceAgentId !== voiceAgentId
        ) return;
        this.runs.set(voiceAgentId, { ...run, resumeHandle });
        this.emitPublicStateUpdated(voiceAgentId);
      },
      ...(this.sessionInteractionHost?.prepareAccountVoiceFollowContext
        ? { prepareFollowContext: this.sessionInteractionHost.prepareAccountVoiceFollowContext }
        : {}),
    });
  }

  private ensurePermissionResponseTargetHandlerRegistered(): void {
    const store = this.getPermissionRequestStore?.() ?? null;
    if (!store || this.permissionResponseTargetStore === store) return;

    this.unregisterPermissionResponseTargetHandler?.();
    this.permissionResponseTargetStore = null;
    this.unregisterPermissionResponseTargetHandler = null;

    this.unregisterPermissionResponseTargetHandler = store.registerResponseTargetHandler('execution_run_host_bridge', (
      dispatch: AgentStateResponseTargetDispatch,
    ) => {
      return this.handleExecutionRunPermissionResponseTargetDispatch(dispatch);
    });
    this.permissionResponseTargetStore = store;
  }

  private async handleExecutionRunPermissionResponseTargetDispatch(
    dispatch: AgentStateResponseTargetDispatch,
  ): Promise<boolean> {
    const responseTarget = readExecutionRunPermissionResponseTargetFromDispatch(dispatch);
    if (!responseTarget) return false;
    if (!this.isExactExecutionRunPermissionRequestIdentity(dispatch.requestId, responseTarget)) return false;

    const approved = readExecutionRunPermissionResponseApprovedFromDispatch(dispatch);
    if (approved === null) return false;

    const result = await this.respondToPermissionRequest(responseTarget.runId, {
      requestId: responseTarget.providerRequestId,
      approved,
      responseTarget,
    });
    return result.delivery?.delivered === true;
  }

  private isExactExecutionRunPermissionRequestIdentity(
    requestId: string,
    target: ExecutionRunParentSessionPermissionResponseTarget,
  ): boolean {
    if (!target.controllerOccurrenceId) return false;
    return requestId === buildRunScopedExecutionPermissionRequestId({
      runId: target.runId,
      controllerOccurrenceId: target.controllerOccurrenceId,
      providerRequestId: target.providerRequestId,
    });
  }

  private resolvePermissionRequestStore(): ExecutionRunPermissionRequestStore | null {
    this.ensurePermissionResponseTargetHandlerRegistered();
    return this.permissionResponseTargetStore ?? this.getPermissionRequestStore?.() ?? null;
  }

  private createExecutionRunRuntime(opts: ExecutionRunRuntimeCreateOptions): ExecutionRunHostRuntime {
    const runScope = opts.runId ? this.runs.get(opts.runId)?.sessionId : undefined;
    const scope = (
      (typeof runScope === 'string' && runScope.trim().length > 0)
      || (runScope === undefined && opts.start?.intent === 'voice_agent')
    ) ? 'session_owned' as const : 'detached' as const;
    const parentSessionStateTarget = scope === 'session_owned' ? this.parentSessionStateTarget : null;
    const happierSessionId = scope === 'session_owned'
      ? (typeof runScope === 'string' && runScope.trim().length > 0
        ? runScope
        : this.sessionInteractionHost?.session.sessionId)
      : undefined;
    const readPermissionStore = () => {
      const controller = opts.runId ? this.controllers.get(opts.runId) : null;
      if (controller?.kind === 'backend') {
        if (controller.currentInputPermissionRequestStore) return controller.currentInputPermissionRequestStore.store;
        if (controller.currentInputTurn || runScope === null) return null;
      }
      return runScope === null ? opts.getPermissionRequestStore?.() ?? null : this.resolvePermissionRequestStore();
    };
    const runtime = createExecutionRunBridgeRuntime({
      cwd: opts.cwd ?? opts.start?.cwd ?? this.cwd,
      scope,
      runId: opts.runId,
      ...(opts.controllerOccurrenceId ? { controllerOccurrenceId: opts.controllerOccurrenceId } : {}),
      ...(opts.callId ? { callId: opts.callId } : {}),
      ...(opts.sidechainId ? { sidechainId: opts.sidechainId } : {}),
      ...(opts.getPermissionRequestStore || runScope !== undefined ? {
        getPermissionRequestStore: () => {
          const store = readPermissionStore();
          return store && opts.runId ? observeExecutionRunPermissionStore(store, () => this.emitPublicStateUpdated(opts.runId!)) : store;
        },
      } : {}),
      backendId: opts.backendId,
      backendTarget: opts.backendTarget,
      permissionMode: opts.permissionMode,
      workspaceWrites: opts.workspaceWrites,
      ...(opts.causalPermissionAuthority
        ? { causalPermissionAuthority: opts.causalPermissionAuthority }
        : {}),
      modelId: opts.modelId,
      onEffectiveEngine: (engine) => {
        const run = opts.runId ? this.runs.get(opts.runId) : null;
        if (run) this.runs.set(run.runId, { ...run, effectiveEngine: engine });
      },
      ...(opts.modelSelection ? { modelSelection: opts.modelSelection } : {}),
      ...(opts.teamCredentialModel ? { teamCredentialModel: opts.teamCredentialModel } : {}),
      ...(opts.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides }
        : {}),
      ...(opts.secretReferenceOverlay
        ? { secretReferenceOverlay: opts.secretReferenceOverlay }
        : {}),
      ...(opts.secretReferenceEnvironment
        ? { secretReferenceEnvironment: opts.secretReferenceEnvironment }
        : {}),
      accountSettings: opts.accountSettings ?? null,
      ...(happierSessionId ? { happierSessionId } : {}),
      ...(opts.connectedServices !== undefined
        ? { connectedServices: opts.connectedServices }
        : {}),
      ...(opts.connectedServicesDefaultServiceIds && opts.connectedServicesDefaultServiceIds.length > 0
        ? { connectedServicesDefaultServiceIds: opts.connectedServicesDefaultServiceIds }
        : {}),
      start: opts.start ?? null,
      happyHomeDir: this.happyHomeDir,
      ...(opts.engineRegistry ? { engineRegistry: opts.engineRegistry } : {}),
      ...(parentSessionStateTarget ? { parentSessionStateTarget } : {}),
      ...(scope === 'session_owned' && this.sessionInteractionHost
        ? { sessionInteractionHost: this.sessionInteractionHost }
        : {}),
      ...(this.prepareRunTeamCredentialProviderBinding
        ? { prepareRunTeamCredentialProviderBinding: this.prepareRunTeamCredentialProviderBinding }
        : {}),
      ...(() => {
        const sessionOwnedRunScope = scope === 'session_owned' && opts.runId
          ? this.createSessionOwnedRunScope(opts.runId)
          : null;
        return sessionOwnedRunScope ? { sessionOwnedRunScope } : {};
      })(),
      ...(opts.runId
        ? {
            // Recorded before materialization, beside the registration hook
            // below: the Home asks this owner to attest the Run's own direct
            // Team material while that materialization is still running.
            onConnectedServicesSelection: (selection: ExecutionRunConnectedServicesSelectionReport) => {
              const run = this.runs.get(opts.runId!);
              if (!run || run.status !== 'running') {
                throw new Error('Execution-run connected-services selection has no live run owner');
              }
              this.runs.set(run.runId, {
                ...run,
                launch: {
                  ...(run.launch ?? {}),
                  connectedServicesSelection: selection.connectedServicesBindings,
                  ...(selection.agentContribution
                    ? { connectedServicesSelectionAgent: selection.agentContribution }
                    : {}),
                },
              });
            },
          }
        : {}),
      ...(opts.onConnectedServicesRegistration
        ? { onConnectedServicesRegistration: opts.onConnectedServicesRegistration }
        : opts.runId
          ? {
              onConnectedServicesRegistration: async (registration: ExecutionRunConnectedServicesLaunchV1) => {
                if (registration.runKey !== opts.runId) {
                  throw new Error('Execution-run connected-services registration run key mismatch');
                }
                const run = this.runs.get(opts.runId!);
                if (!run || run.status !== 'running') {
                  throw new Error('Execution-run connected-services registration has no live run owner');
                }
                const runWithRegistration = {
                  ...run,
                  launch: {
                    ...(run.launch ?? {}),
                    connectedServicesSelection: registration.connectedServicesBindings,
                    connectedServicesRegistration: registration,
                  },
                };
                this.runs.set(run.runId, runWithRegistration);
                try {
                  await this.writeActivityMarker(run.runId, this.getNowMs(), { force: true });
                  const current = this.runs.get(run.runId);
                  if (
                    current !== runWithRegistration
                    || current.status !== 'running'
                    || current.launch?.connectedServicesRegistration !== registration
                  ) {
                    throw new Error(
                      'Execution-run connected-services registration is no longer current',
                    );
                  }
                } catch (error) {
                  if (this.runs.get(run.runId) === runWithRegistration) {
                    this.runs.set(run.runId, run);
                  }
                  throw error;
                }
              },
            }
          : {}),
      ...(this.machineId ? { machineId: this.machineId } : {}),
      ...(this.resolveProvidersFeatureEnabled
        ? {
            resolveProvidersFeatureEnabled:
              this.resolveProvidersFeatureEnabled,
          }
        : {}),
      ...(this.resolveAccountSettingsSnapshot
        ? { resolveAccountSettingsSnapshot: this.resolveAccountSettingsSnapshot }
        : {}),
    });
    // Preserve runtime accessors (notably dynamic permission capabilities).
    return Object.create(runtime, {
      readPendingPermissionRequestIds: { value: () => {
        const controller = opts.runId ? this.controllers.get(opts.runId) : null;
        if (!controller || controller.kind !== 'backend' || controller.cancelled
          || controller.controllerOccurrenceId !== opts.controllerOccurrenceId) return [];
        return (readPermissionStore()?.listOutstandingRequests?.() ?? []).filter((request) => {
          const target = readExecutionRunParentSessionPermissionResponseTarget(request.responseTarget);
          return target !== null && target.runId === opts.runId && target.controllerOccurrenceId === controller.controllerOccurrenceId;
        }).map((request) => request.requestId);
      } },
    }) as ExecutionRunHostRuntime;
  }

  /**
   * ONE resume backend factory (LC-F2): every recreation path rehydrates the run's immutable launch
   * record so the recreated backend re-applies the SAME model, config overrides, connected-service
   * selection, and admitted start intent (daemon re-materializes the selection, fail-closed) instead
   * of falling back to a bare backend on ambient/native auth. Keeps resume symmetric with start.
   */
  private createResumeExecutionRunRuntime(opts: Readonly<{
    runId?: string;
    controllerOccurrenceId?: string;
    backendId: string;
    backendTarget?: BackendTargetRefV1;
    permissionMode: string;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    engineRegistry?: ResolvedCliEngineRegistry;
  }>): ExecutionRunHostRuntime {
    const run = opts.runId ? this.runs.get(opts.runId) ?? null : null;
    const resumeOptions = resolveExecutionRunResumeBackendOptions({ run });
    return this.createExecutionRunRuntime({
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.controllerOccurrenceId ? { controllerOccurrenceId: opts.controllerOccurrenceId } : {}),
      backendId: opts.backendId,
      ...(opts.backendTarget ? { backendTarget: opts.backendTarget } : {}),
      permissionMode: opts.permissionMode,
      workspaceWrites: resumeOptions.workspaceWrites,
      ...(opts.causalPermissionAuthority
        ? { causalPermissionAuthority: opts.causalPermissionAuthority }
        : {}),
      accountSettings: opts.accountSettings ?? null,
      ...(opts.engineRegistry ? { engineRegistry: opts.engineRegistry } : {}),
      ...(opts.modelId !== undefined
        ? { modelId: opts.modelId }
        : resumeOptions.modelId
          ? { modelId: resumeOptions.modelId }
          : {}),
      ...(resumeOptions.modelSelection
        ? { modelSelection: resumeOptions.modelSelection }
        : {}),
      ...(resumeOptions.teamCredentialModel
        ? { teamCredentialModel: resumeOptions.teamCredentialModel }
        : {}),
      ...(resumeOptions.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: resumeOptions.sessionConfigOptionOverrides }
        : {}),
      ...(resumeOptions.secretReferenceOverlay
        ? { secretReferenceOverlay: resumeOptions.secretReferenceOverlay }
        : {}),
      ...(resumeOptions.connectedServices !== undefined
        ? { connectedServices: resumeOptions.connectedServices }
        : {}),
      ...(resumeOptions.start ? { start: resumeOptions.start } : {}),
    });
  }

  private bindExecutionRunRuntimeSnapshot(
    resolution: Readonly<{
      engineRegistry?: ResolvedCliEngineRegistry;
      release?: () => Promise<void>;
    }>,
    createRuntime: (opts: ExecutionRunRuntimeCreateOptions) => ExecutionRunHostRuntime = (
      opts,
    ) => this.createExecutionRunRuntime(opts),
  ): Readonly<{
    createRuntime: (opts: ExecutionRunRuntimeCreateOptions) => ExecutionRunHostRuntime;
    releaseOwner: () => Promise<void>;
  }> {
    if (!resolution.engineRegistry) {
      return {
        createRuntime,
        releaseOwner: async () => {},
      };
    }

    const snapshotLease = createExecutionRunSnapshotLease(resolution.release);
    return {
      createRuntime: (opts) => {
        const releaseRuntime = snapshotLease.retain();
        try {
          const runtime = createRuntime({
            ...opts,
            engineRegistry: resolution.engineRegistry,
          });
          return withExecutionRunHostRuntimeCleanup(runtime, releaseRuntime);
        } catch (error) {
          void releaseRuntime();
          throw error;
        }
      },
      releaseOwner: snapshotLease.releaseOwner,
    };
  }

  get(runId: string): ExecutionRunState | null {
    return this.runs.get(runId) ?? null;
  }

  private captureRetainedState(runId: string): ExecutionRunState | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const controller = this.controllers.get(runId);
    const runtimeId = run.retentionPolicy === 'resumable' ? readBackendResumableRuntimeId(controller ?? null, run.resumeHandle) : null;
    const inputTurns = this.projectInputTurns(run, controller);
    return {
      ...run, ...(inputTurns ? { inputTurns } : {}),
      ...(runtimeId ? { resumeHandle: { kind: 'provider_session.v1' as const, backendTarget: readBackendTargetRefV2(run.backendTarget), providerSessionId: runtimeId } } : {}),
    };
  }

  /** Baseline recovery at the existing owner, before reads, waits or resume admission. */
  async recoverRetainedRuns(): Promise<void> {
    if (!this.retainedRunRecovery) {
      this.retainedRunRecovery = (async () => {
        const records = await reconcileRetainedExecutionRunRecords({ nowMs: this.getNowMs() });
        for (const record of records) {
          // An alive different host retains control. Its record is not a local
          // controller and must never authorize this bridge to resume it.
          if (this.controllers.has(record.state.runId)) continue;
          if (record.state.status === 'running') {
            // A different live host may have resumed a previously recovered
            // terminal run. Its persisted record cannot grant local control.
            if (record.ownerPid !== process.pid) this.runs.delete(record.state.runId);
            continue;
          }
          this.runs.set(record.state.runId, { ...record.state,
            ...(record.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: record.requesterWorkAttributionV1 } : {}),
          });
        }
      })().finally(() => { this.retainedRunRecovery = null; });
    }
    await this.retainedRunRecovery;
  }

  getRunningCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.status === 'running') count += 1;
    }
    return count;
  }

  getStructuredMeta(runId: string): { kind: string; payload: unknown } | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return run.structuredMeta ?? null;
  }

  getLatestToolResult(runId: string): unknown | null {
    return this.runs.get(runId)?.latestToolResult ?? null;
  }

  async waitForTerminal(
    runId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<void> {
    await this.recoverRetainedRuns();
    while (this.runs.get(runId)?.status === 'running') {
      const wait = this.waitForRunStateChange(runId, options?.signal);
      // Close the lost-wakeup window between reading state and registering.
      if (this.runs.get(runId)?.status !== 'running') this.emitPublicStateUpdated(runId);
      await wait;
    }
    const ctrl = this.controllers.get(runId);
    if (ctrl) {
      await awaitExecutionRunObservation(ctrl.terminalPromise, options?.signal);
      await awaitExecutionRunObservation(
        ctrl.terminalMarkerWritePromise?.catch(() => {}) ?? Promise.resolve(),
        options?.signal,
      );
      await awaitExecutionRunObservation(
        this.terminalMarkerWritePromises.get(runId)?.catch(() => {}) ?? Promise.resolve(),
        options?.signal,
      );
      return;
    }
    await awaitExecutionRunObservation(
      this.terminalMarkerWritePromises.get(runId)?.catch(() => {}) ?? Promise.resolve(),
      options?.signal,
    );
    // If there's no controller, the run is either unknown or already terminal.
    return;
  }

  async waitForOutput(runId: string, observation: ReviewWalkthroughObservation, signal?: AbortSignal): Promise<void> {
    await this.recoverRetainedRuns();
    const settled = (): boolean => {
      const run = this.runs.get(runId);
      if (!run || run.status !== 'running') return true;
      return !isActionCompletionRunObservationPendingV1(readActionCompletionRunObservationV1({
        run, structuredMeta: run.structuredMeta, latestToolResult: run.latestToolResult,
      }, observation));
    };
    while (!settled()) {
      const waiting = this.waitForRunStateChange(runId, signal);
      if (settled()) this.emitPublicStateUpdated(runId);
      await waiting;
    }
    const controller = this.controllers.get(runId);
    if (controller?.kind === 'backend') await awaitExecutionRunObservation(controller.pendingHostBarrier ?? Promise.resolve(), signal);
    if (this.runs.get(runId)?.status !== 'running') await this.waitForTerminal(runId, { signal });
  }

  async waitForInputTurn(
    runId: string,
    localInputId: string,
    signal?: AbortSignal,
  ): Promise<ExecutionRunObservedInputTurn | null> {
    await this.recoverRetainedRuns();
    const readSettledOrUnobservable = (): Readonly<{
      settled: boolean;
      observation: ExecutionRunObservedInputTurn | null;
    }> => {
      const run = this.runs.get(runId);
      if (!run) return { settled: true, observation: null };
      const controller = this.controllers.get(runId);
      // The same projection public state exposes, so a blocking exact wait can
      // never disagree with `getPublic` over one live controller.
      const inputTurns = this.projectInputTurns(run, controller);
      const turn = [inputTurns?.current, inputTurns?.last]
        .find((candidate) => candidate?.inputIds.includes(localInputId));
      if (turn !== undefined && turn.state !== 'active' && inputTurns) {
        return { settled: true, observation: { occurrenceId: inputTurns.occurrenceId, turn } };
      }
      if (run.status !== 'running') return { settled: true, observation: null };
      // A live exact-turn result can only be observed from the current backend
      // controller. A running marker/state without that process-local owner is
      // recovery evidence, not a reason to wait forever or to replay input.
      if (!controller || controller.kind !== 'backend') return { settled: true, observation: null };
      return { settled: false, observation: null };
    };
    while (true) {
      const current = readSettledOrUnobservable();
      if (current.settled) return current.observation;
      const wait = this.waitForRunStateChange(runId, signal);
      const afterRegistration = readSettledOrUnobservable();
      if (afterRegistration.settled) this.emitPublicStateUpdated(runId);
      await wait;
    }
  }

  private projectInputTurns(
    run: ExecutionRunState,
    controller: ExecutionRunController | undefined,
  ): ExecutionRunState['inputTurns'] {
    return projectExecutionRunInputTurns({
      runId: run.runId,
      retained: run.inputTurns,
      controller,
      reader: this.runOccurrenceWitnesses.reader,
    });
  }

  private buildPublicState(run: ExecutionRunState): ExecutionRunPublicState {
    const ctrl = this.controllers.get(run.runId) ?? null;
    const inputTurns = this.projectInputTurns(run, ctrl ?? undefined);
    const availableActionIds = getExecutionRunAvailableActionIds(run, ctrl, this.executionRunProfileCatalog);
    const requestIds = run.status === 'running' && ctrl?.kind === 'backend'
      ? ctrl.backend.readPendingPermissionRequestIds?.() ?? [] : [];
    return {
      ...projectExecutionRunPublicState(
        { ...run, ...(inputTurns ? { inputTurns } : {}) },
        ctrl,
        ctrl?.kind === 'voice_agent' ? this.voiceAgentManager.isTurnInFlight(ctrl.voiceAgentId) : undefined,
      ),
      ...(availableActionIds.length > 0 ? { availableActionIds: [...availableActionIds] } : {}),
      ...(requestIds.length > 0 ? { attention: { kind: 'permission_required' as const, requestIds: [...requestIds] } } : {}),
    };
  }

  getPublic(runId: string): ExecutionRunPublicState | null {
    const run = this.runs.get(runId);
    return run ? this.buildPublicState(run) : null;
  }

  listPublic(): readonly ExecutionRunPublicState[] {
    const out: ExecutionRunPublicState[] = [];
    for (const run of this.runs.values()) {
      out.push(this.buildPublicState(run));
    }
    return out;
  }

  listPublicForRequest(
    request: ExecutionRunListRequest,
    scopeSessionId?: string | null,
  ): readonly ExecutionRunPublicState[] {
    const requestedBackendId =
      typeof request.backendId === 'string' && request.backendId.trim().length > 0 ? request.backendId.trim() : null;
    const requestedBackendTargetKey =
      request.backendTarget ? buildBackendTargetKeyV2(readBackendTargetRefV2(request.backendTarget)) : null;
    const requestedStatus =
      typeof request.status === 'string' && request.status.trim().length > 0 ? request.status.trim() : null;
    const requestedLimit = normalizeExecutionRunListLimit(request.limit);

    const selected: ExecutionRunState[] = [];
    for (const run of this.runs.values()) {
      if (scopeSessionId !== undefined && run.sessionId !== scopeSessionId) {
        continue;
      }
      if (requestedBackendTargetKey && buildBackendTargetKeyV2(readBackendTargetRefV2(run.backendTarget)) !== requestedBackendTargetKey) {
        continue;
      }
      if (!requestedBackendTargetKey && requestedBackendId && !matchesExecutionRunLegacyBackendId(run.backendTarget, requestedBackendId)) {
        continue;
      }
      if (requestedStatus && run.status !== requestedStatus) {
        continue;
      }
      selected.push(run);
    }

    const sorted = selected.sort(compareExecutionRunStatesForList);
    const bounded = requestedLimit === null ? sorted : sorted.slice(0, requestedLimit);
    return bounded.map((run) => this.buildPublicState(run));
  }

  getDepthByRunId(runId: string): number | null {
    const run = this.runs.get(runId);
    return run ? run.depth : null;
  }

  getDepthByCallId(callId: string, scopeSessionId?: string | null): number | null {
    for (const run of this.runs.values()) {
      if (scopeSessionId !== undefined && run.sessionId !== scopeSessionId) continue;
      if (run.callId === callId) return run.depth;
    }
    return null;
  }

  private async finishRun(
    runId: string,
    next: Omit<
      ExecutionRunState,
      | 'runId'
      | 'callId'
      | 'sidechainId'
      | 'sessionId'
      | 'depth'
      | 'intent'
      | 'backendTarget'
      | 'backendId'
      | 'instructions'
      | 'permissionMode'
      | 'retentionPolicy'
      | 'runClass'
      | 'ioMode'
      | 'startedAtMs'
      | 'resumeHandle'
    > & {
      status: ExecutionRunState['status'];
      finishedAtMs: number;
    },
    toolResult: { output: any; isError?: boolean; meta?: Record<string, unknown> },
    structuredMeta?: ExecutionRunStructuredMeta,
  ): Promise<void> {
    let terminalTransitionClaimed = false;
    try {
      terminalTransitionClaimed = await finishExecutionRun({
        runId,
        next,
        toolResult,
        structuredMeta,
        runs: this.runs,
        controllers: this.controllers,
        budgetRegistry: this.budgetRegistry,
        parentProvider: this.parentProvider,
        sendAcp: this.sendAcp,
        enqueueMarkerWrite: this.enqueueMarkerWrite.bind(this),
        terminalMarkerWritePromises: this.terminalMarkerWritePromises,
        onWorkerUpdateRetained: (input) => {
          this.workerUpdates.set(input.localId, input);
          for (const wake of this.workerUpdateWaiters) wake(input.sessionId);
        },
        profileCatalog: this.executionRunProfileCatalog,
        ...(this.reviewComments ? { reviewComments: this.reviewComments } : {}),
      });
    } catch (error) {
      terminalTransitionClaimed = this.runs.get(runId)?.status !== 'running';
      throw error;
    } finally {
      this.emitPublicStateUpdated(runId);
      const completedRun = this.runs.get(runId);
      if (terminalTransitionClaimed && completedRun && completedRun.status !== 'running') {
        void this.emitLifecycleHookEvent({
          eventId: 'executionRun.completed',
          runId,
          payload: {
            sessionId: completedRun.sessionId,
            runId,
            status: completedRun.status === 'succeeded'
              ? 'succeeded'
              : completedRun.status === 'cancelled'
                ? 'canceled'
                : 'failed',
            ...(completedRun.error ? { error: completedRun.error } : {}),
          },
        });
      }
    }
  }

  private async recoverWorkerUpdates(): Promise<void> {
    await this.workerUpdateAcknowledgements;
    await this.recoverRetainedRuns();
    if (!this.workerUpdateRecovery) {
      this.workerUpdateRecovery = readPendingExecutionRunWorkerUpdates().then((updates) => {
        const retainedIds = new Set(updates.map((update) => update.localId));
        for (const id of this.workerUpdates.keys()) {
          if (!retainedIds.has(id)) this.workerUpdates.delete(id);
        }
        for (const update of updates) {
          if (!this.workerUpdates.has(update.localId)) this.workerUpdates.set(update.localId, update);
        }
      }).finally(() => {
        this.workerUpdateRecovery = null;
      });
    }
    await this.workerUpdateRecovery;
    await this.workerUpdateAcknowledgements;
  }

  private projectWorkerUpdate(input: RetainedExecutionRunWorkerUpdate): Extract<HostContextOnlySourceInput, { kind: 'worker_update' }> {
    return {
      kind: 'worker_update', localId: input.localId, update: input.update,
      recheckAdmission: async (signal) => !signal.aborted && this.workerUpdates.get(input.localId) === input,
      acknowledgeAccepted: () => {
        this.workerUpdateAcknowledgements = this.workerUpdateAcknowledgements.then(async () => {
          if (this.workerUpdates.get(input.localId) !== input) return;
          if (await acknowledgeExecutionRunWorkerUpdate(input)) this.workerUpdates.delete(input.localId);
        }).catch((error: unknown) => {
          logger.warn('[EXECUTION RUN] Failed to acknowledge parent worker update', {
            runId: input.update.workerId, error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    };
  }

  async takeWorkerUpdate(sessionId: string, signal: AbortSignal): Promise<Extract<HostContextOnlySourceInput, { kind: 'worker_update' }> | null> {
    await this.recoverWorkerUpdates();
    if (signal.aborted) return null;
    const pending = [...this.workerUpdates.values()].find((input) => input.sessionId === sessionId);
    return pending ? this.projectWorkerUpdate(pending) : null;
  }

  async prepareWorkerUpdates(sessionId: string, input: Readonly<{ signal: AbortSignal }>): Promise<readonly PreparedWorkerContextItem[]> {
    await this.recoverWorkerUpdates();
    if (input.signal.aborted) return [];
    const prepared: PreparedWorkerContextItem[] = [];
    for (const pending of this.workerUpdates.values()) {
      if (pending.sessionId !== sessionId) continue;
      const source = this.projectWorkerUpdate(pending);
      prepared.push({ localId: pending.localId, update: pending.update, recheckAdmission: source.recheckAdmission, acknowledgeAccepted: source.acknowledgeAccepted });
    }
    return prepared;
  }

  async waitForWorkerUpdateChange(sessionId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    return new Promise<boolean>((resolve, reject) => {
      const finish = (changed: boolean) => {
        this.workerUpdateWaiters.delete(onChange);
        signal.removeEventListener('abort', onAbort);
        resolve(changed);
      };
      const onChange = (changedSessionId: string) => { if (changedSessionId === sessionId) finish(true); };
      const onAbort = () => finish(false);
      this.workerUpdateWaiters.add(onChange);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) finish(false);
      void this.recoverWorkerUpdates().then(() => {
        if ([...this.workerUpdates.values()].some((pending) => pending.sessionId === sessionId)) finish(true);
      }, (error: unknown) => {
        this.workerUpdateWaiters.delete(onChange);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  private async emitLifecycleHookEvent(params: Readonly<{
    eventId: ExecutionRunBridgeLifecycleHookEventIdV1;
    runId: string;
    payload: Record<string, unknown>;
  }>): Promise<void> {
    if (!this.happyHomeDir) return;

    const run = this.runs.get(params.runId);
    if (!run) return;
    if (run.sessionId === null) return;

    await emitBridgeLifecycleHookEventBestEffort({
      happyHomeDir: this.happyHomeDir,
      event: {
        eventId: params.eventId,
        scope: 'session',
        happySessionId: run.sessionId,
        backendTarget: buildBackendTargetKey(run.backendTarget),
        payload: params.payload,
      },
    });
  }

  async start(params: ExecutionRunManagerStartParams): Promise<ExecutionRunStartResult> {
    await this.recoverRetainedRuns();
    this.ensurePermissionResponseTargetHandlerRegistered();
    const resolution = await this.resolveExecutionRunProfileCatalog();
    const runtimeSnapshot = this.bindExecutionRunRuntimeSnapshot(resolution);
    try {
      params = { ...params, roleSessionMetadata: this.sessionInteractionHost?.session.getMetadataSnapshot() };
      if (params.intent === 'review') {
        const accountSettings = params.accountSettings ?? await this.resolveAccountSettings?.() ?? undefined;
        const fingerprint = await readWorktreeChangeFingerprint(params.cwd ?? this.cwd);
        const intentInput = params.intentInput && typeof params.intentInput === 'object' && !Array.isArray(params.intentInput)
          ? params.intentInput as Readonly<Record<string, unknown>> : {};
        params = {
          ...params, ...(accountSettings ? { accountSettings } : {}),
          intentInput: { ...intentInput, reviewedFingerprint: fingerprint.kind === 'available' ? fingerprint.fingerprint : null },
        };
      }
      let preparedParams = await prepareExecutionRunManagerStartParams(
        params,
        params.cwd ?? this.cwd,
        resolution.profileCatalog,
      );
      if (params.reviewNarration) {
        const input = preparedParams.intentInput && typeof preparedParams.intentInput === 'object' && !Array.isArray(preparedParams.intentInput)
          ? preparedParams.intentInput as Readonly<Record<string, unknown>> : {};
        preparedParams = { ...preparedParams, intentInput: { ...input, reviewNarration: params.reviewNarration } };
      }
      const secretReferenceOverlay = preparedParams.secretReferenceOverlay;
      const runInteractionStore = preparedParams.getPermissionRequestStore?.() ?? null;
      const started = await startExecutionRun({
        admitStart: this.admitStart,
        params: preparedParams,
        profileCatalog: resolution.profileCatalog,
        ...(resolution.engineRegistry
          ? { contributions: resolution.engineRegistry.contributions }
          : {}),
        parentProvider: this.parentProvider,
        sendAcp: this.sendAcp,
        streamedTranscriptSession: this.streamedTranscriptSession,
        createRuntime: runtimeSnapshot.createRuntime,
        ...(secretReferenceOverlay
          ? {
              admitSecretReferenceOverlay: async () => {
                let snapshot: ActiveAccountSettingsSnapshot | null;
                try {
                  snapshot = await this.resolveAccountSettingsSnapshot?.({
                    secretReferenceOverlay,
                  }) ?? null;
                } catch (error) {
                  if (error instanceof SavedSecretOperationAdmissionError) {
                    Object.assign(error, {
                      code: readLaunchSecretReferenceOverlayProviderErrorCodeV1(
                        error.reason,
                      ),
                    });
                  }
                  throw error;
                }
                if (!snapshot) {
                  throw Object.assign(
                    new LaunchSecretReferenceOverlayError(
                      'reference_unavailable',
                      'launch',
                    ),
                    { code: 'provider_secret_unavailable' },
                  );
                }
                try {
                  return resolveSecretReferenceOverlayEnvironment({
                    accountSettings: snapshot.settings,
                    settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
                    ...(snapshot.savedSecretResources
                      ? { savedSecretResources: snapshot.savedSecretResources }
                      : {}),
                    secretReferenceOverlay,
                  });
                } catch (error) {
                  if (error instanceof LaunchSecretReferenceOverlayError) {
                    Object.assign(error, {
                      code: readLaunchSecretReferenceOverlayProviderErrorCodeV1(
                        error.reason,
                      ),
                    });
                  }
                  throw error;
                }
              },
            }
          : {}),
        getNowMs: this.getNowMs,
        budgetRegistry: this.budgetRegistry,
        getPermissionRequestStore: runInteractionStore
          ? () => runInteractionStore
          : this.resolvePermissionRequestStore.bind(this),
        runs: this.runs,
        controllers: this.controllers,
        enqueueMarkerWrite: this.enqueueMarkerWrite.bind(this),
        writeActivityMarker: this.writeActivityMarker.bind(this),
        finishRun: this.finishRun.bind(this),
        executeBoundedRun: this.executeBoundedRun.bind(this),
        send: (runId, sendParams) => this.send(runId, {
          ...sendParams,
          ...(runInteractionStore ? { permissionRequestStore: runInteractionStore } : {}),
        }),
        ...(this.sessionInteractionHost?.session.enqueueSessionUserMessageWithDisposition
          ? {
              enqueueRetainedRunInitialInput: async ({ runId, text, localId, requestedAction }) => {
                return await this.sessionInteractionHost!.session.enqueueSessionUserMessageWithDisposition!({
                  text,
                  localId,
                  recipient: { kind: 'execution_run', runId },
                  requestedAction,
                });
              },
            }
          : {}),
        voiceAgentManager: this.voiceAgentManager,
        onPublicStateUpdated: (runId) => this.emitPublicStateUpdated(runId),
        attachRetainedRunSessionInput: (attachParams) => this.attachRetainedRunSessionInput(attachParams),
      });
      this.emitPublicStateUpdated(started.runId);
      await this.emitLifecycleHookEvent({
        eventId: 'executionRun.started',
        runId: started.runId,
        payload: {
          sessionId: preparedParams.sessionId,
          runId: started.runId,
          intent: preparedParams.intent,
          runtimeTargetKeys: [buildBackendTargetKey(preparedParams.backendTarget)],
          runClass: preparedParams.runClass,
          ioMode: preparedParams.ioMode,
          retentionPolicy: preparedParams.retentionPolicy,
          permissionMode: preparedParams.permissionMode,
        },
      });
      return started;
    } finally {
      await runtimeSnapshot.releaseOwner();
    }
  }

  private resolveBoundedTimeoutMs(params: ExecutionRunManagerStartParams): number | null {
    if (typeof params.boundedTimeoutMs === 'number' && Number.isFinite(params.boundedTimeoutMs) && params.boundedTimeoutMs >= 1) {
      return Math.floor(params.boundedTimeoutMs);
    }
    return this.boundedTimeoutMs;
  }

  private async authorizeConnectedServicesProviderEffect(runId: string): Promise<{
    ok: boolean;
    errorCode?: string;
    error?: string;
  }> {
    const run = this.runs.get(runId);
    const registration = run?.launch?.connectedServicesRegistration;
    if (!registration) return { ok: true };
    const checker = this.checkConnectedServicesGenerationCurrent;
    if (checker) {
      try {
        if ((await checker({ runId, registration })).current) {
          const current = this.runs.get(runId);
          if (
            current === run
            && current.status === 'running'
            && current.launch?.connectedServicesRegistration === registration
          ) {
            return { ok: true };
          }
        }
      } catch {
        // Generation admission fails closed when daemon truth is unavailable.
      }
    }
    return {
      ok: false,
      errorCode: 'execution_run_connected_service_generation_refresh_required',
      error: 'Connected-service credentials changed. Restart or resume this execution run before sending.',
    };
  }

  private async executeBoundedRun(args: {
    runId: string;
    callId: string;
    sidechainId: string;
    startedAtMs: number;
    params: ExecutionRunManagerStartParams;
    initialInputAdmission?: Readonly<{
      resolve: () => void;
      reject: (error: Error) => void;
    }>;
  }): Promise<void> {
    return executeBoundedBackendRun({
      ...args,
      profileCatalog: this.executionRunProfileCatalog,
      controllers: this.controllers,
      runs: this.runs,
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      getNowMs: this.getNowMs,
      boundedTimeoutMs: this.resolveBoundedTimeoutMs(args.params),
      finishRun: this.finishRun.bind(this),
      onPublicStateUpdated: (runId) => this.emitPublicStateUpdated(runId),
    });
  }

  async send(
    runId: string,
    params: Readonly<{
      message: string;
      resume?: boolean;
      delivery?: unknown;
      localInputId?: string;
      resultContract?: ExecutionRunResultContractV1;
      structuredInput?: import('@happier-dev/protocol').HappierStructuredInputV1;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
      signal?: AbortSignal;
      permissionRequestStore?: ExecutionRunPermissionRequestStore;
      workflowObservationSink?: ExecutionRunWorkflowObservationSink;
    }>,
  ): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    await this.recoverRetainedRuns();
    this.ensurePermissionResponseTargetHandlerRegistered();
    const run = this.runs.get(runId) ?? null;
    if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
    if ((params.permissionRequestStore || params.workflowObservationSink) && !params.localInputId?.trim()) {
      return {
        ok: false,
        errorCode: 'execution_run_invalid_action_input',
        error: 'A detached invocation binding requires an exact local input id',
      };
    }
    const turnInteraction = params.permissionRequestStore
      ? {
          permissionRequestStore: params.permissionRequestStore,
          handlePermissionResponseTarget: (dispatch: AgentStateResponseTargetDispatch) => (
            this.handleExecutionRunPermissionResponseTargetDispatch(dispatch)
          ),
        }
      : {};

    let result: { ok: boolean; errorCode?: string; error?: string };

    if (params.resume === true && run.runClass === 'bounded') {
      const lifecycle = resolveExecutionRunLifecycle(run, this.controllers.get(runId) ?? null);
      if (lifecycle.projection.state === 'recoverable_with_input') {
        const ensured = await this.ensure(runId, {
          resume: true,
          inputFollowsResume: true,
          ...(params.causalPermissionAuthority
            ? { causalPermissionAuthority: params.causalPermissionAuthority }
            : {}),
        });
        if (!ensured.ok) return ensured;

        const resumedRun = this.runs.get(runId);
        if (!resumedRun || resumedRun.status !== 'running') {
          return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
        }
        const resumeOptions = resolveExecutionRunResumeBackendOptions({ run: resumedRun });
        let resolveAdmission!: () => void;
        let rejectAdmission!: (error: Error) => void;
        const admission = new Promise<void>((resolve, reject) => {
          resolveAdmission = resolve;
          rejectAdmission = reject;
        });
        void this.executeBoundedRun({
          runId,
          callId: resumedRun.callId,
          sidechainId: resumedRun.sidechainId,
          startedAtMs: resumedRun.startedAtMs,
          params: {
            sessionId: resumedRun.sessionId,
            intent: resumedRun.intent,
            backendTarget: resumedRun.backendTarget,
            accountSettings: resumedRun.runtimeSettings?.accountSettings ?? null,
            instructions: params.message,
            ...(resumeOptions.start?.intentInput !== undefined
              ? { intentInput: resumeOptions.start.intentInput }
              : {}),
            ...(params.localInputId ? { localInputId: params.localInputId } : {}),
            ...(params.resultContract ? { resultContract: params.resultContract } : {}),
            ...(params.structuredInput ? { structuredInput: params.structuredInput } : {}),
            ...(params.workflowObservationSink
              ? { workflowObservationSink: params.workflowObservationSink }
              : {}),
            ...(resumeOptions.start?.cwd ? { cwd: resumeOptions.start.cwd } : {}),
            ...(resumeOptions.start?.mcpSelection ? { mcpSelection: resumeOptions.start.mcpSelection } : {}),
            ...(resumedRun.display ? { display: resumedRun.display } : {}),
            ...(resumedRun.launch?.launchOrigin ? { launchOrigin: resumedRun.launch.launchOrigin } : {}),
            ...(resumeOptions.modelId ? { modelId: resumeOptions.modelId } : {}),
            ...(resumeOptions.modelSelection ? { modelSelection: resumeOptions.modelSelection } : {}),
            ...(resumeOptions.teamCredentialModel ? { teamCredentialModel: resumeOptions.teamCredentialModel } : {}),
            ...(resumeOptions.sessionConfigOptionOverrides
              ? { sessionConfigOptionOverrides: resumeOptions.sessionConfigOptionOverrides }
              : {}),
            ...(resumeOptions.connectedServices !== undefined
              ? { connectedServices: resumeOptions.connectedServices }
              : {}),
            ...(params.causalPermissionAuthority
              ? { causalPermissionAuthority: params.causalPermissionAuthority }
              : {}),
            permissionMode: resumedRun.permissionMode,
            workspaceWrites: resumeOptions.workspaceWrites,
            retentionPolicy: resumedRun.retentionPolicy,
            runClass: resumedRun.runClass,
            ioMode: resumedRun.ioMode,
            ...(resumedRun.notifyParentOnCompletion === true ? { notifyParentOnCompletion: true } : {}),
            ...(resumeOptions.start?.profileId ? { profileId: resumeOptions.start.profileId } : {}),
            resumeHandle: resumedRun.resumeHandle,
          },
          initialInputAdmission: {
            resolve: resolveAdmission,
            reject: rejectAdmission,
          },
        });
        try {
          await admission;
        } catch (error) {
          return {
            ok: false,
            errorCode: readExecutionRunErrorCode(error) ?? 'execution_run_failed',
            error: error instanceof Error ? error.message : 'Execution failed',
          };
        }
        await this.emitLifecycleHookEvent({
          eventId: 'executionRun.messageSent',
          runId,
          payload: {
            sessionId: run.sessionId,
            runId,
            message: params.message,
            resume: true,
          },
        });
        return { ok: true };
      }
    }

    if (params.resume === true && run.runClass !== 'bounded') {
      // Long-lived recovery remains centralized in the retained sender. Bounded
      // recovery above couples controller creation to its terminalizing input.
      const resolution = await this.resolveExecutionRunProfileCatalog();
      const runtimeSnapshot = this.bindExecutionRunRuntimeSnapshot(
        resolution,
        (opts) => this.createResumeExecutionRunRuntime(opts),
      );
      try {
        result = await sendBackendLongLivedRun({
          runId,
          reviewComments: this.reviewComments,
          params,
          runs: this.runs,
          controllers: this.controllers,
          budgetRegistry: this.budgetRegistry,
          createRuntime: runtimeSnapshot.createRuntime,
          maxTurns: this.maxTurns,
          getNowMs: this.getNowMs,
          finishRun: this.finishRun.bind(this),
          sendAcp: this.sendAcp,
          parentProvider: this.parentProvider,
          streamedTranscriptSession: this.streamedTranscriptSession,
          getPermissionRequestStore: this.resolvePermissionRequestStore.bind(this),
          writeActivityMarker: this.writeActivityMarker.bind(this),
          onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
          profileCatalog: resolution.profileCatalog,
          authorizeProviderEffect: () => this.authorizeConnectedServicesProviderEffect(runId),
          ...turnInteraction,
        });
        if (result.ok) {
          await this.emitLifecycleHookEvent({
            eventId: 'executionRun.messageSent',
            runId,
            payload: {
              sessionId: run.sessionId,
              runId,
              message: params.message,
              resume: true,
            },
          });
        }
        return result;
      } finally {
        await runtimeSnapshot.releaseOwner();
      }
    }

    if (run.runClass === 'bounded') {
      const ctrl = this.controllers.get(runId) ?? null;
      if (!ctrl || ctrl.kind !== 'backend' || !ctrl.runtimeId) {
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
      }
      if (ctrl.cancelled) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
      if (!ctrl.turnInFlight) return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not in flight' };
      if (
        ctrl.turnCancelReason === 'outcome_unknown'
        && ctrl.turnCancelEpoch === ctrl.turnEpoch
      ) {
        return { ok: false, errorCode: 'execution_run_busy', error: 'Run is busy' };
      }

      const delivery = params.delivery;
      const normalized = delivery === undefined ? 'prompt' : delivery;
      if (normalized === 'prompt') {
        return { ok: false, errorCode: 'execution_run_busy', error: 'Run is busy' };
      }
      if (params.signal?.aborted) {
        return { ok: false, errorCode: 'cancelled', error: 'Execution run send cancelled' };
      }
      // enqueue: bounded runner will implement delivery semantics while the turn is running
      result = await new Promise((resolve) => {
        let settled = false;
        let onAbort: (() => void) | null = null;
        const finish = (result: { ok: boolean; errorCode?: string; error?: string }) => {
          if (settled) return;
          settled = true;
          if (onAbort) params.signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const queuedMessage = {
          message: params.message,
          delivery: (normalized === 'prompt' || normalized === 'steer_if_supported' || normalized === 'interrupt')
            ? normalized
            : 'prompt',
          ...(params.causalPermissionAuthority
            ? { causalPermissionAuthority: params.causalPermissionAuthority }
            : {}),
          authorizeProviderEffect: async () => {
            const admission = await this.authorizeConnectedServicesProviderEffect(runId);
            if (!admission.ok) {
              throw createExecutionRunCodedError(
                admission.errorCode ?? 'execution_run_connected_service_generation_refresh_required',
                admission.error ?? 'Connected-service credentials changed. Restart or resume this execution run before sending.',
              );
            }
          },
          resolve: () => finish({ ok: true }),
          reject: (e: Error) => finish({
            ok: false,
            errorCode: readExecutionRunErrorCode(e) ?? 'execution_run_failed',
            error: e.message,
          }),
        } as const;
        onAbort = () => {
          const index = ctrl.admittedLiveInterventions.indexOf(queuedMessage);
          if (index >= 0) ctrl.admittedLiveInterventions.splice(index, 1);
          finish({
            ok: false,
            errorCode: 'cancelled',
            error: 'Execution run send cancelled',
          });
        };
        ctrl.admittedLiveInterventions.push(queuedMessage);
        if (ctrl.admittedLiveInterventionsSignal) {
          ctrl.admittedLiveInterventionsSignal.resolve();
          ctrl.admittedLiveInterventionsSignal = null;
        }
        params.signal?.addEventListener('abort', onAbort, { once: true });
        if (params.signal?.aborted) onAbort();
      });
      if (result.ok) {
        await this.emitLifecycleHookEvent({
          eventId: 'executionRun.messageSent',
          runId,
          payload: {
            sessionId: run.sessionId,
            runId,
            message: params.message,
            resume: false,
          },
        });
      }
      return result;
    }

    result = await sendBackendLongLivedRun({
      runId,
      reviewComments: this.reviewComments,
      params,
      runs: this.runs,
      controllers: this.controllers,
      budgetRegistry: this.budgetRegistry,
      createRuntime: ({ runId: resumedRunId, controllerOccurrenceId, backendId, backendTarget, permissionMode, causalPermissionAuthority, accountSettings }) =>
        this.createResumeExecutionRunRuntime({
          runId: resumedRunId,
          controllerOccurrenceId,
          backendId,
          backendTarget,
          permissionMode,
          ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
          accountSettings,
        }),
      maxTurns: this.maxTurns,
      getNowMs: this.getNowMs,
      finishRun: this.finishRun.bind(this),
      sendAcp: this.sendAcp,
      parentProvider: this.parentProvider,
      streamedTranscriptSession: this.streamedTranscriptSession,
      getPermissionRequestStore: this.resolvePermissionRequestStore.bind(this),
      writeActivityMarker: this.writeActivityMarker.bind(this),
      onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
      profileCatalog: this.executionRunProfileCatalog,
      authorizeProviderEffect: () => this.authorizeConnectedServicesProviderEffect(runId),
      ...turnInteraction,
    });
    if (result.ok) {
      await this.emitLifecycleHookEvent({
        eventId: 'executionRun.messageSent',
        runId,
        payload: {
          sessionId: run.sessionId,
          runId,
          message: params.message,
          resume: false,
        },
      });
    }
    return result;
  }

  async ensure(
    runId: string,
    params: Readonly<{
      resume?: boolean;
      /** Host-only coupling used by bounded `send({ resume: true })`. */
      inputFollowsResume?: boolean;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    }>,
  ): Promise<ExecutionRunEnsureResult> {
    await this.recoverRetainedRuns();
    this.ensurePermissionResponseTargetHandlerRegistered();
    const resolution = await this.resolveExecutionRunProfileCatalog();
    const runtimeSnapshot = this.bindExecutionRunRuntimeSnapshot(
      resolution,
      (opts) => this.createResumeExecutionRunRuntime(opts),
    );
    try {
      return await ensureExecutionRun({
        runId,
        params,
        runs: this.runs,
        controllers: this.controllers,
        budgetRegistry: this.budgetRegistry,
        createRuntime: runtimeSnapshot.createRuntime,
        sendAcp: this.sendAcp,
        parentProvider: this.parentProvider,
        streamedTranscriptSession: this.streamedTranscriptSession,
        getPermissionRequestStore: this.resolvePermissionRequestStore.bind(this),
        getNowMs: this.getNowMs,
        writeActivityMarker: this.writeActivityMarker.bind(this),
        voiceAgentManager: this.voiceAgentManager,
        onPublicStateUpdated: (runId2) => this.emitPublicStateUpdated(runId2),
        profileCatalog: resolution.profileCatalog,
        attachRetainedRunSessionInput: (attachParams) => this.attachRetainedRunSessionInput(attachParams),
      });
    } finally {
      await runtimeSnapshot.releaseOwner();
    }
  }

  /**
   * Reconciles one exact Pending target named by the parent Session's durable
   * pending-version update. The Run registry is the only classification
   * authority: absence or a transient resume failure leaves the rows queued.
   */
  async reconcilePendingExecutionRunTarget(runId: string): Promise<void> {
    await this.recoverRetainedRuns();
    const host = this.sessionInteractionHost?.session;
    if (
      !host?.listExecutionRunPendingDeliveryStatuses
      || !host.blockExecutionRunPendingDelivery
    ) return;

    const statuses = await host.listExecutionRunPendingDeliveryStatuses(runId);
    const queuedLocalIds = statuses
      .filter((entry) => entry.status === 'queued')
      .map((entry) => entry.localId);
    if (queuedLocalIds.length === 0) return;

    const isPositivelyUnavailable = (): boolean => {
      const run = this.runs.get(runId);
      if (!run) return false;
      if (run.sessionId !== host.sessionId) return true;
      if (
        run.runClass !== 'long_lived'
        || run.retentionPolicy !== 'resumable'
        || run.ioMode !== 'streaming'
      ) return true;
      const controller = this.controllers.get(runId);
      // A newly queued input may reopen this exact retained provider session after terminalization.
      // Lifecycle owns resume eligibility; a historical status is not a second decision-maker.
      if (!controller) return resolveExecutionRunLifecycle(run, null).projection.state === 'unavailable';
      return controller.cancelled
        || controller.kind !== 'backend'
        || controller.backend.interaction == null;
    };

    let shouldBlock = isPositivelyUnavailable();
    const run = this.runs.get(runId);
    if (
      !shouldBlock
      && run
      && run.sessionId === host.sessionId
      && !this.controllers.has(runId)
    ) {
      const ensureResult = await this.ensure(runId, { resume: true });
      // The existing backend ensure owner may positively prove that this
      // retained occurrence cannot resume. Guard that result with the same Run
      // object and the absence of a controller so a concurrent/superseding
      // resume never turns into a false terminal classification. Unknown and
      // transport failures remain queued for the ordinary recovery path.
      const retainedRunStillCurrent = this.runs.get(runId) === run;
      shouldBlock = isPositivelyUnavailable()
        || (
          !ensureResult.ok
          && ensureResult.resumeFailureKind === 'permanent'
          && retainedRunStillCurrent
          && !this.controllers.has(runId)
        );
    }

    if (!shouldBlock) return;
    for (const localId of queuedLocalIds) {
      await host.blockExecutionRunPendingDelivery(runId, localId);
    }
  }


  async ensureOrStart(params: Readonly<{
    runId?: string | null;
    start?: ExecutionRunManagerStartParams;
    resume?: boolean;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  }>): Promise<
    | { ok: true; runId: string; created: boolean }
    | { ok: false; errorCode?: string; error: string }
  > {
    const runId = typeof params.runId === 'string' ? params.runId.trim() : '';
    if (runId) {
      const ensured = await this.ensure(runId, {
        resume: params.resume,
        ...(params.causalPermissionAuthority
          ? { causalPermissionAuthority: params.causalPermissionAuthority }
          : {}),
      });
      if (!ensured.ok) return { ok: false, error: ensured.error ?? 'Ensure failed', ...(ensured.errorCode ? { errorCode: ensured.errorCode } : {}) };
      return { ok: true, runId, created: false };
    }

    if (!params.start) return { ok: false, error: 'Missing start params', errorCode: 'execution_run_invalid_action_input' };
    const started = await this.start(params.start);
    return { ok: true, runId: started.runId, created: true };
  }

  async startTurnStream(
    runId: string,
    params: Readonly<{
      message: string;
      displayMessage?: string;
      speechSegmentTargetChars?: number;
      resume?: boolean;
      userTranscript?: ExecutionRunUserTranscriptDirective;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    }>,
  ): Promise<{ ok: true; streamId: string } | { ok: false; errorCode: string; error: string }> {
    await this.recoverRetainedRuns();
    if (params.resume === true) {
      const ensured = await this.ensure(runId, {
        resume: true,
        ...(params.causalPermissionAuthority
          ? { causalPermissionAuthority: params.causalPermissionAuthority }
          : {}),
      });
      if (!ensured.ok) return { ok: false, errorCode: ensured.errorCode ?? 'execution_run_failed', error: ensured.error ?? 'Ensure failed' };
    }
    return startVoiceAgentTurnStream({
      runId,
      params: {
        message: params.message,
        ...(params.speechSegmentTargetChars !== undefined
          ? { speechSegmentTargetChars: params.speechSegmentTargetChars }
          : {}),
        ...(typeof params.displayMessage === 'string' ? { displayMessage: params.displayMessage } : {}),
        ...(params.userTranscript ? { userTranscript: params.userTranscript } : {}),
        ...(params.causalPermissionAuthority
          ? { causalPermissionAuthority: params.causalPermissionAuthority }
          : {}),
      },
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      transcriptWriter: this.transcriptWriter
        ? {
            ...(this.transcriptWriter.appendUserTextCommitted
              ? { appendUserTextCommitted: this.transcriptWriter.appendUserTextCommitted }
              : {}),
            ...(this.transcriptWriter.appendAssistantTextCommitted
              ? { appendAssistantTextCommitted: this.transcriptWriter.appendAssistantTextCommitted }
              : {}),
            commitVoiceAgentTranscriptTurn: this.transcriptWriter.commitVoiceAgentTranscriptTurn,
          }
        : null,
    });
  }

  async readTurnStream(
    runId: string,
    params: Readonly<{ streamId: string; cursor: number; maxEvents?: number; waitForEvents?: boolean; signal?: AbortSignal }>,
  ): Promise<
    | { ok: true; streamId: string; events: any[]; nextCursor: number; done: boolean }
    | { ok: false; errorCode: string; error: string }
  > {
    return readVoiceAgentTurnStream({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      transcriptWriter: this.transcriptWriter
        ? {
            ...(this.transcriptWriter.appendUserTextCommitted
              ? { appendUserTextCommitted: this.transcriptWriter.appendUserTextCommitted }
              : {}),
            ...(this.transcriptWriter.appendAssistantTextCommitted
              ? { appendAssistantTextCommitted: this.transcriptWriter.appendAssistantTextCommitted }
              : {}),
            commitVoiceAgentTranscriptTurn: this.transcriptWriter.commitVoiceAgentTranscriptTurn,
          }
        : null,
      writeActivityMarker: this.writeActivityMarker.bind(this),
      getNowMs: this.getNowMs,
    });
  }

  async commitUserTranscript(
    runId: string,
    params: Readonly<{ text: string; displayText?: string; localId: string }>,
  ): Promise<{ ok: true } | { ok: false; errorCode: string; error: string }> {
    return await commitVoiceAgentUserTranscript({
      runId,
      text: params.text,
      ...(typeof params.displayText === 'string' ? { displayText: params.displayText } : {}),
      localId: params.localId,
      runs: this.runs,
      controllers: this.controllers,
      transcriptWriter: this.transcriptWriter
        ? {
            ...(this.transcriptWriter.appendUserTextCommitted
              ? { appendUserTextCommitted: this.transcriptWriter.appendUserTextCommitted }
              : {}),
            ...(this.transcriptWriter.appendAssistantTextCommitted
              ? { appendAssistantTextCommitted: this.transcriptWriter.appendAssistantTextCommitted }
              : {}),
            commitVoiceAgentTranscriptTurn: this.transcriptWriter.commitVoiceAgentTranscriptTurn,
          }
        : null,
    });
  }

  async cancelTurnStream(
    runId: string,
    params: Readonly<{ streamId: string }>,
  ): Promise<{ ok: true } | { ok: false; errorCode: string; error: string }> {
    return cancelVoiceAgentTurnStream({
      runId,
      params,
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
    });
  }

  async cancelCurrentTurn(
    runId: string,
    params: Readonly<{ occurrenceId: string; turnId: string }>,
  ): Promise<import('@happier-dev/protocol').ExecutionRunCancelTurnResponse> {
    await this.recoverRetainedRuns();
    return await cancelCurrentExecutionRunTurn({
      runId,
      ...params,
      runs: this.runs,
      controllers: this.controllers,
      occurrenceReader: this.runOccurrenceWitnesses.reader,
    });
  }

  async stop(runId: string): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    await this.recoverRetainedRuns();
    const run = this.runs.get(runId) ?? null;
    const result = await stopExecutionRun({
      runId,
      runs: this.runs,
      controllers: this.controllers,
      voiceAgentManager: this.voiceAgentManager,
      getNowMs: this.getNowMs,
      finishRun: this.finishRun.bind(this),
      onPublicStateUpdated: (updatedRunId) => this.emitPublicStateUpdated(updatedRunId),
    });
    if (result.ok && run) {
      await this.emitLifecycleHookEvent({
        eventId: 'executionRun.stopped',
        runId,
        payload: {
          sessionId: run.sessionId,
          runId,
          reason: 'user',
        },
      });
    }
    return result;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }

    this.disposePromise = (async () => {
      const runningRunIds = [...this.runs.values()]
        .filter((run) => run.status === 'running')
        .map((run) => run.runId);

      await Promise.allSettled(runningRunIds.map(async (runId) => {
        await this.stop(runId);
      }));

      const remainingControllers = [...this.controllers.entries()];
      await Promise.allSettled(remainingControllers.map(async ([runId, ctrl]) => {
        if (this.controllers.get(runId) !== ctrl) return;
        ctrl.cancelled = true;
        this.budgetRegistry?.releaseExecutionRun(runId);
        if (ctrl.kind === 'voice_agent') {
          try {
            await this.voiceAgentManager.stop({ voiceAgentId: ctrl.voiceAgentId });
          } catch {
            // best effort
          }
        }
        await settleExecutionRunController({
          runId,
          controller: ctrl,
          controllers: this.controllers,
        });
      }));

      try {
        await this.voiceAgentManager.dispose();
      } catch {
        // best effort
      }

      this.unregisterPermissionResponseTargetHandler?.();
      this.unregisterPermissionResponseTargetHandler = null;
      this.permissionResponseTargetStore = null;
      await Promise.all(this.markerWriteChains.values());
      await this.workerUpdateAcknowledgements;
    })();

    return await this.disposePromise;
  }

  async respondToPermissionRequest(
    runId: string,
    params: Readonly<{
      requestId: string;
      approved: boolean;
      responseTarget?: ExecutionRunParentSessionPermissionResponseTarget | null;
    }>,
  ): Promise<ExecutionRunPermissionResponseBridgeResult> {
    const run = this.runs.get(runId) ?? null;
    if (!run) {
      return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
    }
    if (run.status !== 'running') {
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
    }

    const ctrl = this.controllers.get(runId) ?? null;
    if (!ctrl || ctrl.kind !== 'backend' || ctrl.cancelled) {
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
    }

    const target = params.responseTarget ?? null;
    if (
      !target
      || target.runId !== run.runId
      || target.sessionId !== run.sessionId
      || target.callId !== run.callId
      || target.sidechainId !== run.sidechainId
      || target.backendId !== run.backendId
      || !target.controllerOccurrenceId
      || target.controllerOccurrenceId !== ctrl.controllerOccurrenceId
    ) {
      return {
        ok: false,
        errorCode: 'execution_run_invalid_action_input',
        error: 'Permission response target does not match the active execution run',
      };
    }
    if (target.providerRequestId !== params.requestId) {
      return {
        ok: false,
        errorCode: 'execution_run_invalid_action_input',
        error: 'Permission response request id does not match the response target',
      };
    }

    const respondToPermission = ctrl.backend.permissionCapability === 'responds'
      ? ctrl.backend.respondToPermission
      : undefined;
    if (!respondToPermission) {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Unsupported action' };
    }

    const delivery = await respondToPermission(params.requestId, params.approved);
    if (delivery.delivered !== true) {
      return {
        ok: false,
        errorCode: 'execution_run_permission_not_delivered',
        error: 'Permission response was not delivered',
        delivery,
      };
    }
    try {
      await this.sendAcp(this.parentProvider, {
        type: 'permission-response',
        permissionId: params.requestId,
        approved: params.approved,
        decision: params.approved ? 'approved' : 'denied',
        sidechainId: run.sidechainId,
      });
    } catch {
      const custodyError = createExecutionRunTranscriptCustodyError();
      const finishedAtMs = this.getNowMs();
      ctrl.cancelled = true;
      try {
        await this.finishRun(
          runId,
          {
            status: 'failed',
            summary: custodyError.message,
            finishedAtMs,
            error: { code: custodyError.code, message: custodyError.message },
          },
          {
            output: {
              status: 'failed',
              summary: custodyError.message,
              runId: run.runId,
              callId: run.callId,
              sidechainId: run.sidechainId,
              backendTarget: run.backendTarget,
              intent: run.intent,
              startedAtMs: run.startedAtMs,
              finishedAtMs,
              error: { code: custodyError.code, message: custodyError.message },
            },
            isError: true,
          },
        );
      } catch {
        // finishRun claims terminal state before publishing the terminal fact.
        // A second transcript failure therefore remains the same typed custody
        // failure and must not keep the provider occurrence alive for replay.
      } finally {
        await settleExecutionRunController({
          runId,
          controller: ctrl,
          controllers: this.controllers,
        });
        this.emitPublicStateUpdated(runId);
      }
      return {
        ok: false,
        errorCode: 'execution_run_transcript_custody_unavailable',
        error: 'Permission response was delivered but its transcript fact was not admitted to durable custody',
        delivery,
      };
    }
    await this.writeActivityMarker(runId, this.getNowMs(), { force: true });
    this.emitPublicStateUpdated(runId);
    return { ok: true, delivery };
  }

  async completePermissionRequest(
    runId: string,
    params:
      | Readonly<{ requestId: string; approved: boolean }>
      | Readonly<{ requestId: string; answers: StructuredQuestionAnswersV1 }>,
  ): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>> {
    const run = this.runs.get(runId) ?? null;
    if (!run || run.status !== 'running') {
      return { ok: false, errorCode: run ? 'execution_run_not_allowed' : 'execution_run_not_found', error: 'Not running' };
    }
    const controller = this.controllers.get(runId) ?? null;
    if (controller?.kind !== 'backend') {
      return { ok: false, errorCode: 'permission_request_not_found', error: 'Permission request not found' };
    }
    const interaction = controller.currentInputPermissionRequestStore ?? null;
    const store = interaction?.store ?? null;
    const outstanding = store?.readOutstandingRequest?.(params.requestId) ?? null;
    const target = readExecutionRunParentSessionPermissionResponseTarget(outstanding?.responseTarget);
    if (
      !store?.completeRequest
      || !target
      || target.sessionId !== null
      || target.runId !== runId
      || target.callId !== run.callId
      || target.sidechainId !== run.sidechainId
      || target.backendId !== run.backendId
      || target.controllerOccurrenceId !== controller.controllerOccurrenceId
      || !this.isExactExecutionRunPermissionRequestIdentity(params.requestId, target)
      || !interaction
      || !controller.currentInputTurn
      || interaction.turnId !== controller.currentInputTurn.turnId
      || !controller.currentInputTurn.inputIds.includes(interaction.localInputId)
    ) {
      return { ok: false, errorCode: 'permission_request_not_found', error: 'Permission request not found' };
    }
    const completed = await store.completeRequest({
      requestId: params.requestId,
      status: 'answers' in params || params.approved ? 'approved' : 'denied',
      decision: 'answers' in params || params.approved ? 'approved' : 'denied',
      ...('answers' in params ? { answers: params.answers } : {}),
    });
    this.emitPublicStateUpdated(runId);
    return completed
      ? { ok: true }
      : { ok: false, errorCode: 'permission_request_not_found', error: 'Permission request not found' };
  }

  async applyAction(
    runId: string,
    params: ExecutionRunActionParams,
    opts?: Readonly<{
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
      effectiveCallerPermissionMode?: string;
    }>,
  ): Promise<ExecutionRunActionResult> {
    await this.recoverRetainedRuns();
    const run = this.runs.get(runId) ?? null;
    if (!run && params.actionId !== 'review.triage') {
      return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
    }
    if (!run && params.actionId === 'review.triage') {
      return this.reviewComments ? await this.reviewComments.triage(runId, params.input)
        : { ok: false, errorCode: 'review_comment_persistence_unavailable', error: 'ReviewComment persistence is unavailable' };
    }
    const resolution = await this.resolveExecutionRunProfileCatalog();
    try {
      return await applyExecutionRunAction({
        runId,
        params,
        runs: this.runs,
        controllers: this.controllers,
        voiceAgentManager: this.voiceAgentManager,
        startRun: this.start.bind(this),
        ...(run && run.sessionId !== null
          ? { enqueueCommittedAcp: this.streamedTranscriptSession?.enqueueAgentMessageCommitted }
          : {}),
        parentProvider: this.parentProvider,
        profileCatalog: resolution.profileCatalog,
        ...(opts?.causalPermissionAuthority
          ? { causalPermissionAuthority: opts.causalPermissionAuthority }
          : {}),
        ...(opts?.effectiveCallerPermissionMode
          ? { effectiveCallerPermissionMode: opts.effectiveCallerPermissionMode }
          : {}),
        ...(this.materializeReviewHostAction ? { materializeReviewHostAction: this.materializeReviewHostAction } : {}),
        ...(this.reviewComments ? { reviewComments: this.reviewComments } : {}),
        applyReviewNarrationAction: async (actionId, input) => {
          const enqueue = this.sessionInteractionHost?.session.enqueueSessionUserMessageWithDisposition;
          if (!enqueue) return { ok: false, errorCode: 'execution_run_host_action_unavailable', error: 'Canonical Session Pending admission is unavailable' };
          const host = {
            runId, input, cwd: this.cwd, runs: this.runs, controllers: this.controllers,
            startRun: this.start.bind(this),
            ensureRun: (id: string) => this.ensure(id, { resume: true, ...(opts?.causalPermissionAuthority ? { causalPermissionAuthority: opts.causalPermissionAuthority } : {}) }),
            waitForTerminal: (id: string, signal: AbortSignal) => this.waitForTerminal(id, { signal }),
            enqueueInput: ({ runId: id, text, localId }: Readonly<{ runId: string; text: string; localId: string }>) => enqueue.call(this.sessionInteractionHost!.session,
              { text, localId, recipient: { kind: 'execution_run' as const, runId: id }, requestedAction: { v: 1 as const, kind: 'enqueue' as const } }),
            onStateUpdated: (id: string) => this.emitPublicStateUpdated(id),
            failNarration: async (id: string, inputId: string | undefined, code: string, message: string) => {
              const controller = this.controllers.get(id);
              if (controller?.kind !== 'backend' || controller.cancelled) return;
              const publication = await this.resolveExecutionRunProfileCatalog();
              try { await publishExecutionRunTurn({ runId: id, turnId: inputId ?? `review-narration-failed:${id}`, ...(inputId ? { inputIds: [inputId] } : {}),
                rawText: '', finishedAtMs: this.getNowMs(), diagnostic: { code, message }, controller,
                controllers: this.controllers, runs: this.runs, profileCatalog: publication.profileCatalog,
                sendAcp: this.sendAcp, parentProvider: this.parentProvider,
                reviewComments: this.reviewComments,
                onPublicStateUpdated: (updatedId) => this.emitPublicStateUpdated(updatedId) });
              } finally { await publication.release?.(); }
            },
          };
          return actionId === 'review.walkthrough' ? await applyReviewWalkthroughAction(host) : await applyReviewExplainFindingsAction(host);
        },
        onVoiceAgentWelcomed: async (welcomedRunId, welcomedEpoch) => {
          if (this.runs.get(welcomedRunId)?.sessionId === null) return;
          const callback = this.onVoiceAgentWelcomed;
          if (!callback) return;
          const publicRun = this.getPublic(welcomedRunId);
          if (!publicRun) return;
          await callback(publicRun, welcomedEpoch);
        },
      });
    } finally {
      await resolution.release?.();
    }
  }
}
