import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { isForegroundTurnRuntimeTranscriptEvent, isSessionScopedRuntimeTranscriptEvent } from '../events/runtimeTranscriptScope';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { resolveRuntimeCheckpointToolProtocol } from '@happier-dev/agents/session/controls/checkpoints';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { isRecord } from '@happier-dev/plugin-sdk';
import { validatePluginHookPayloadV1 } from '@happier-dev/protocol/plugins/hooks';
import type { AgentSessionRuntimeEvent, ProviderBoundModelRef, SessionModelTransitionResultV1, SessionTurnFactsV1, SessionRolePromptContextV1, SessionRuntimeTeamCredentialDenialDetailsV1 } from '@happier-dev/protocol';
import type { render } from 'ink';
import type React from 'react';

import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { RuntimeSessionTurnMutationV1 } from '@/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { RegisterProviderAcceptedEffect } from '@/agent/runtime/session/input/providerInputOutcome';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { isTerminalSessionTurnMutationAction } from '@/api/session/sessionTurnStatusSnapshot';
import type { Metadata, PermissionMode } from '@/api/types';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import {
  createRuntimeOverrideSynchronizers,
  createRuntimeOverrideTarget,
  type RuntimeOverrideSynchronizers,
  type RuntimeOverrideTarget,
} from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import type { CapabilitySelectionSynchronizerInput } from '@/agent/runtime/capabilitySelectionSynchronizer';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import {
  runPermissionModePromptLoop,
  projectSessionComposerAttachmentDispatchInput,
  type PromptLoopPermissionHandler,
  type PermissionModePromptLoopTurnOperations,
  type PromptLoopOverrideSynchronizer,
  type PromptLoopBoundaryReason,
  type PromptLoopResetReason,
} from '@/agent/runtime/runPermissionModePromptLoop';
import { createReadyNotificationDispatcher, type ReadyNotificationTurnContext } from '@/agent/runtime/notifications/createReadyNotificationDispatcher';
import { sendReadyWithPushNotification } from '@/agent/runtime/notifications/sendReadyWithPushNotification';
import { resetAssistantTextSnapshotTurnScope, type AssistantTextSnapshotTurnScope } from '@/agent/runtime/turns/assistantTextSnapshotTurnScope';
import {
  resolveAgentCompositionPromptText,
} from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { createSessionPromptPlanResolver, type SessionPromptPlanResolver } from '@/agent/prompting/coding/sessionPromptPlan';
import type { InFlightSteerController } from '@/agent/runtime/permissions/bindModeQueue';
import type { UnsettledReplaySeedRetirement } from '@/agent/runtime/replaySeed/unsettledReplaySeedRetirement';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  resolveRemoteModeControlSurface,
  startRemoteModeStaticControl,
  type RemoteModeStaticControl,
} from '@/ui/remoteControl/remoteModeControl';
import { logger } from '@/ui/logger';
import type { StructuredInputCatalogReaders } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { NormalizedToolTurnChangeTracker } from '@/agent/tools/diff/normalizedToolTurnChangeTracker';
import { createRepositoryCheckpointPromptLifecycle } from '@/agent/runtime/checkpoints/repositoryCheckpointPromptLifecycle';
import { notifyDaemonConnectedServiceTurnLifecycle } from '@/daemon/controlClient';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import {
  resolveSessionPendingQueueDeliveryTiming,
  resolveSessionPendingQueueMaxPopPerWake,
} from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import { resolvePendingQueueHandoff } from '@/agent/runtime/mode/switching/pendingQueueHandoffOrchestrator';
import { createTerminalTurnStateMachine } from '@/agent/runtime/terminal/turnStateMachine';
import { mapRuntimeMessageToTerminalLifecycleObservation } from '@/agent/runtime/terminal/runtimeMessageObservationAdapter';
import {
  abortAndDisposeRunnerRuntime,
  requestExplicitRunnerStop,
  resolveRunnerRuntimeDisposalReason,
} from './runnerRuntimeDisposal';
import {
  createSessionTurnLifecycle,
  observeRuntimeMessageForSessionTurnLifecycle,
} from '@/agent/runtime/session/turn/lifecycle';
import {
  createRuntimeTranscriptProjector,
  RuntimeTranscriptRequiredAdmissionError,
  type RuntimeTranscriptProjectionResult,
} from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import {
  observeAgentStreamTokenThroughPluginHooks,
  resolveAgentCompositionThroughPluginHooks,
  transformAgentContextThroughPluginHooks,
  type AgentCompositionToolSelection,
} from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import type {
  DaemonAgentRuntimeTurnContributionsBridge,
} from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';
import type {
  HostSessionRuntimeConfig,
  HostSessionRuntimeDeps,
  HostSessionKeepAliveMode,
  HostSessionRuntimeHookRuntime,
  HostSessionRuntimeLoopApi,
  CanonicalHostSessionRuntimeRunOptions,
  HostSessionRuntimeRunOptions,
  HostSessionRuntimeSessionSwapStrategy,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type {
  RuntimeTurnDisposeReason,
  RuntimeTurnOperations,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import type { RemoteOnlyTerminalDisplayProps } from './display/types';
import { resolveStartingMode } from './resolveStartingMode';
import { runTerminalRemoteSessionModeLoop, type TerminalRemoteSessionMode } from './runTerminalRemoteSessionModeLoop';
import type {
  HostSessionTerminalRemoteHandoffReason,
  HostSessionTerminalRemoteHandoffResult,
  HostSessionTerminalRemoteModeLoop,
} from './terminalRemoteModeRuntime';
import { stampTurnFacts } from '@/agent/runtime/session/turn/stampTurnFacts';
import { createRuntimeFailureTranscriptProjector } from '@/agent/runtime/session/transcripts/runtimeFailureTranscript';

export const HOST_SESSION_RUNTIME_PLAN_KIND = 'hostSessionRuntimePlan' as const;

const KEEP_ALIVE_DUPLICATE_SUPPRESSION_MS = 100;

function normalizeAcpProvider(value: string | null | undefined, fallback: string): ACPProvider {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length > 0) return normalized as ACPProvider;
  const fallbackNormalized = fallback.trim();
  return (fallbackNormalized.length > 0 ? fallbackNormalized : 'agent') as ACPProvider;
}

export type HostSessionRuntimePlan = Readonly<{
  kind: typeof HOST_SESSION_RUNTIME_PLAN_KIND;
  agentId: string;
  opts: HostSessionRuntimeRunOptions;
  config: HostSessionRuntimeConfig;
  deps?: HostSessionRuntimeDeps;
}>;

export function isHostSessionRuntimePlan(value: unknown): value is HostSessionRuntimePlan {
  if (!value || typeof value !== 'object') return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.kind === HOST_SESSION_RUNTIME_PLAN_KIND
    && typeof record.agentId === 'string'
    && Boolean(record.opts)
    && Boolean(record.config);
}

export async function runHostSessionRuntimePlan(plan: HostSessionRuntimePlan): Promise<void> {
  const { runHostSessionRuntime } = await import('@/agent/runtime/session/loop/runHostSessionRuntime');
  await runHostSessionRuntime(plan.opts, plan.config, plan.deps);
}

export type SessionLoopLifecycleDeps = Readonly<{
  daemonTurnContributionsBridge?: DaemonAgentRuntimeTurnContributionsBridge;
  readTeamCredentialDenial?: (turnId: string) => Promise<SessionRuntimeTeamCredentialDenialDetailsV1 | null>;
  cleanupBackendRunResourcesFn?: typeof cleanupBackendRunResources;
  createRuntimeOverrideSynchronizersFn?: typeof createRuntimeOverrideSynchronizers;
  runPermissionModePromptLoopFn?: typeof runPermissionModePromptLoop;
  observeAgentStreamToken?: (payload: Record<string, unknown>) => void | Promise<void>;
  notifyDaemonConnectedServiceTurnLifecycleFn?: typeof notifyDaemonConnectedServiceTurnLifecycle;
  registerRunnerTerminationHandlersFn?: typeof registerRunnerTerminationHandlers;
  sendReadyWithPushNotificationFn?: typeof sendReadyWithPushNotification;
  registerKillSessionHandlerFn?: typeof registerKillSessionHandler;
  renderFn?: typeof render;
  startRemoteModeStaticControlFn?: typeof startRemoteModeStaticControl;
  runTerminalRemoteSessionModeLoopFn?: typeof runTerminalRemoteSessionModeLoop;
  onBeforeSessionClose?: (params: Readonly<{
    session: ApiSessionClient;
    runtime: HostSessionRuntimeHookRuntime;
  }>) => void | Promise<void>;
  remoteOnlyTerminalDisplayComponent?: React.ComponentType<RemoteOnlyTerminalDisplayProps>;
}>;

async function observeAgentStreamTokenEvent(params: Readonly<{
  event: AgentSessionRuntimeEvent;
  agentId: string;
  observeAgentStreamToken?: (payload: Record<string, unknown>) => void | Promise<void>;
  uiLogPrefix: string;
}>): Promise<void> {
  if (!params.observeAgentStreamToken || params.event.kind !== 'message-delta'
    || !isForegroundTurnRuntimeTranscriptEvent(params.event)) {
    return;
  }
  const tokenText = params.event.text;
  const payload = {
    sessionId: params.event.sessionId,
    agentId: params.agentId,
    runtimeFamily: 'hostSession',
    turnId: params.event.turnId,
    tokenText,
    streamKind: params.event.channel === 'reasoning' ? 'thinking' : 'assistant',
    timestampMs: params.event.emittedAtMs,
  };
  const validation = validatePluginHookPayloadV1({
    hookId: 'agent.stream.token',
    payload,
  });
  if (!validation.success) {
    logger.debug(`${params.uiLogPrefix} agent.stream.token payload validation failed (non-fatal)`, {
      error: validation.message,
    });
    return;
  }
  try {
    await params.observeAgentStreamToken(validation.payload as Record<string, unknown>);
  } catch {
    logger.debug(`${params.uiLogPrefix} agent.stream.token observer failed (non-fatal)`);
  }
}

export type SessionLoopLifecycleParams = Readonly<{
  readReferenceAction?: StructuredInputCatalogReaders['readReferenceAction'];
  opts: CanonicalHostSessionRuntimeRunOptions;
  config: HostSessionRuntimeConfig;
  api: HostSessionRuntimeLoopApi;
  session: ApiSessionClient;
  sessionIsNew?: boolean;
  runtime: RuntimeTurnOperations;
  hookRuntime: HostSessionRuntimeHookRuntime;
  capabilitySelection?: Pick<CapabilitySelectionSynchronizerInput, 'agent' | 'skillsRunner' | 'readSkillRules' | 'initialSkillRules' | 'readMcpRules' | 'initialMcpRules' | 'subscribeAccountSettings'>;
  registerProviderAcceptedEffect: RegisterProviderAcceptedEffect;
  terminalRemoteModeLoop?: HostSessionTerminalRemoteModeLoop | null;
  messageBuffer: MessageBuffer;
  permissionHandler: PromptLoopPermissionHandler;
  permissionModeState: Readonly<{
    rebindSession: (session: ApiSessionClient) => void;
    releaseRejectedBeforeProviderPromptIdentity: (
      session: ApiSessionClient,
      message: PermissionModeQueuedPrompt,
    ) => void;
    getCurrentPermissionMode: () => PermissionMode | undefined;
    getCurrentPermissionModeUpdatedAt: () => number;
    setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
    setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
    messageQueue: MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
    replaySeedRetirement: UnsettledReplaySeedRetirement;
  }>;
  sessionSwapStrategy: HostSessionRuntimeSessionSwapStrategy;
  runtimeDirectory: string;
  runtimeMetadata: Metadata;
  machineId: string;
  memoryRecallGuidanceEnabled: boolean;
  policyAgentId: string;
  setActiveAgentCompositionToolSelection: (
    selection: AgentCompositionToolSelection | null,
  ) => void;
  happyMcpServerStop: () => void;
  reconnectionHandle: { cancel: () => void } | null;
  startupCoordinator: Readonly<{
    start?: (() => void | Promise<void>) | null;
    cancel?: (() => void) | null;
    cleanup?: (() => void | Promise<void>) | null;
  }> | null;
  runtimeState: {
    thinking: boolean;
  };
  setAbortRequestedCallback: (callback: (() => void | Promise<void>) | null, readSignal?: () => AbortSignal) => void;
  transitionModelSelection: (
    selection: ProviderBoundModelRef,
    source: 'metadata' | 'prompt',
    runWithActiveSelection?: (
      transferPromptAdmission: (opts: Readonly<{
        abortSignal: AbortSignal;
        dispatch: () => Promise<void>;
      }>) => Promise<
        | Readonly<{ status: 'dispatched'; value: void }>
        | Readonly<{ status: 'cancelled' }>
      >,
    ) => Promise<void>,
  ) => Promise<SessionModelTransitionResultV1>;
  readActiveModelSelection?: () => ProviderBoundModelRef;
  resolveSessionRolePromptContext?: (signal?: AbortSignal) => Promise<SessionRolePromptContextV1 | null>;
  resolveFreshSessionSystemPrompt?: SessionPromptPlanResolver;
  prepareSessionRolePromptPolicy?: () => Promise<void>;
  onProviderPromptDispatchPrepared?: (input: Readonly<{
    localIds: readonly string[];
    selection: ProviderBoundModelRef;
  }>) => void;
  deps: SessionLoopLifecycleDeps;
  initialResumeId: string;
  onStrictInitialResumeFailure?: ((params: Readonly<{
    resumeId: string;
    error: unknown;
  }>) => void | Promise<void>) | null;
}>;

export type RuntimeEventSubscriptionRequiredFailureReason =
  | 'subscription_failed'
  | 'invalid_unsubscribe';

export class RuntimeEventSubscriptionRequiredError extends Error {
  readonly code = 'runtime_event_subscription_required' as const;

  constructor(readonly reason: RuntimeEventSubscriptionRequiredFailureReason) {
    super(`Required runtime event subscription failed: ${reason}`);
    this.name = 'RuntimeEventSubscriptionRequiredError';
  }
}

export async function runSessionLoopLifecycle(params: SessionLoopLifecycleParams): Promise<void> {
  const cleanupBackendRunResourcesFn = params.deps.cleanupBackendRunResourcesFn ?? cleanupBackendRunResources;
  const createRuntimeOverrideSynchronizersFn = params.deps.createRuntimeOverrideSynchronizersFn ?? createRuntimeOverrideSynchronizers;
  const runPermissionModePromptLoopFn = params.deps.runPermissionModePromptLoopFn ?? runPermissionModePromptLoop;
  const registerRunnerTerminationHandlersFn = params.deps.registerRunnerTerminationHandlersFn ?? registerRunnerTerminationHandlers;
  const sendReadyWithPushNotificationFn = params.deps.sendReadyWithPushNotificationFn;
  const registerKillSessionHandlerFn = params.deps.registerKillSessionHandlerFn ?? registerKillSessionHandler;
  const startRemoteModeStaticControlFn = params.deps.startRemoteModeStaticControlFn ?? startRemoteModeStaticControl;
  const runTerminalRemoteSessionModeLoopFn = params.deps.runTerminalRemoteSessionModeLoopFn ?? runTerminalRemoteSessionModeLoop;
  const onBeforeSessionClose = params.deps.onBeforeSessionClose;
  const notifyDaemonConnectedServiceTurnLifecycleFn =
    params.deps.notifyDaemonConnectedServiceTurnLifecycleFn ?? notifyDaemonConnectedServiceTurnLifecycle;
  const daemonTurnContributionsBridge =
    params.deps.daemonTurnContributionsBridge;
  const observeAgentStreamToken = params.deps.observeAgentStreamToken
    ?? (daemonTurnContributionsBridge
      ? undefined
      : observeAgentStreamTokenThroughPluginHooks);

  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  const shouldRenderTerminalDisplay = params.config.shouldRenderTerminalDisplay?.({ opts: params.opts, session: params.session, metadata: params.runtimeMetadata }) ?? true;
  const remoteControlSurface = resolveRemoteModeControlSurface({
    stdoutIsTTY: process.stdout.isTTY,
    stdinIsTTY: process.stdin.isTTY,
    startedBy: params.opts.startedBy,
    terminalMode: params.opts.terminalRuntime?.mode ?? null,
  });
  const hookRuntime = params.hookRuntime;
  const hookRuntimeForCallbacks = hookRuntime;
  let preparedTurnFacts: SessionTurnFactsV1 | null = null;
  type HostReadyCapture = {
    turnId: string | null;
    snapshotScope: AssistantTextSnapshotTurnScope | null;
    context?: ReadyNotificationTurnContext;
  };
  let hostReadyCapture: HostReadyCapture | null = null;
  // The foreground Runner owns current-generation Composer callbacks through its authenticated
  // daemon bridge. The prompt loop only receives these narrow dispatch operations; it never
  // gains registry or PluginInvocationContext authority of its own.
  const runtimeForPromptLoop: PermissionModePromptLoopTurnOperations =
    Object.freeze({
      ...hookRuntimeForCallbacks,
      beginTurnLifecycle: hookRuntimeForCallbacks.beginTurnLifecycle.bind(hookRuntimeForCallbacks),
      waitForTurnCompletion: hookRuntimeForCallbacks.waitForTurnCompletion.bind(hookRuntimeForCallbacks),
      // The decorated operations own event normalization; native hooks retain controls.
      subscribeRuntimeEvents: params.runtime.subscribeRuntimeEvents.bind(params.runtime),
      cancelTurn: hookRuntimeForCallbacks.cancelTurn.bind(hookRuntimeForCallbacks),
      readSessionIdentity: hookRuntimeForCallbacks.readSessionIdentity.bind(hookRuntimeForCallbacks),
      updateSessionRuntimeConfig: hookRuntimeForCallbacks.updateSessionRuntimeConfig.bind(hookRuntimeForCallbacks),
      resetOrDisposeRuntime: hookRuntimeForCallbacks.resetOrDisposeRuntime.bind(hookRuntimeForCallbacks),
      sendTurnPrompt: (prompt, meta) => {
        const starterDepth = params.session.getWorkDepth?.();
        const turnDepth = preparedTurnFacts?.workDepth;
        return hookRuntimeForCallbacks.sendTurnPrompt(prompt, {
          ...meta,
          agentStartCaller: starterDepth !== undefined && turnDepth !== undefined
            ? { kind: 'session', sessionId: params.session.sessionId, starterDepth, turnDepth }
            : undefined,
        });
      },
      steerInFlightTurn: (prompt, meta) => hookRuntimeForCallbacks.steerInFlightTurn(prompt, {
        ...meta,
        agentStartCaller: hookRuntimeForCallbacks.readActiveTurnAdmissionWitness?.()?.agentStartCaller,
      }),
      ...(daemonTurnContributionsBridge ? {
          resolveComposerReference: async (input: Parameters<NonNullable<PermissionModePromptLoopTurnOperations['resolveComposerReference']>>[0]) =>
            await daemonTurnContributionsBridge.resolveComposerReference({
              sessionId: params.session.sessionId,
              reference: input.reference,
              candidateId: input.candidateId,
              signal: input.signal,
            }),
      } : {}),
    });
  const toolNormalizationProtocol = resolveRuntimeCheckpointToolProtocol(params.config.checkpointToolProtocol);
  const configuredCheckpointLifecycle = await params.config.lifecycleHooks?.createCheckpointLifecycle?.({
    session: params.session,
    runtime: hookRuntimeForCallbacks,
    runtimeDirectory: params.runtimeDirectory,
    policyAgentId: params.policyAgentId,
  }) ?? null;
  const repositoryCheckpointLifecycle = configuredCheckpointLifecycle ? null : createRepositoryCheckpointPromptLifecycle({
    session: params.session,
    sessionIsNew: params.sessionIsNew,
    runtimeDirectory: params.runtimeDirectory,
    provider: params.config.agentMessageType,
    protocol: toolNormalizationProtocol,
  });
  const checkpointLifecycle = configuredCheckpointLifecycle ?? repositoryCheckpointLifecycle;
  const terminalRemoteModeLoop = params.terminalRemoteModeLoop ?? null;
  const resolvedStartingMode = resolveStartingMode({
    terminalCapable: terminalRemoteModeLoop !== null,
    userIntent: (params.opts as Readonly<{ startingMode?: unknown }>).startingMode,
    providerHint:
      terminalRemoteModeLoop?.ownsCurrentTerminalDisplay === true && !hasTTY
        ? 'remote'
        : terminalRemoteModeLoop?.startingMode,
  });
  const terminalTurnStateMachine = createTerminalTurnStateMachine();
  const pendingRuntimeTranscriptProjections = new Set<Promise<void>>();
  const runtimeTranscriptStateByTurnId = new Map<string, {
    failure?: RuntimeTranscriptRequiredAdmissionError;
    userLocalIds: Set<string>;
    hasAssistantText?: true;
    finalAssistantMessageSeq?: number;
    failureMessageSeq?: number;
    startSeqExclusive?: number;
  }>();
  const pendingInputSettlementsByLocalId = new Map<string, Promise<void>>();
  const retireTurnTranscriptState = (turnId: string): void => {
    for (const localId of runtimeTranscriptStateByTurnId.get(turnId)?.userLocalIds ?? []) {
      pendingInputSettlementsByLocalId.delete(localId);
    }
    runtimeTranscriptStateByTurnId.delete(turnId);
    if (activeRuntimeTranscriptTurnId === turnId) activeRuntimeTranscriptTurnId = null;
  };
  const registerProviderAcceptedEffect: RegisterProviderAcceptedEffect = (localId, onAccepted, representedInputs) => {
    // This prompt-loop registration also owns anchor ordering when the prompt
    // has no optional accepted effect. Canonical rejection retires its entry.
    if (!onAccepted) params.registerProviderAcceptedEffect(localId, null, representedInputs);
    params.registerProviderAcceptedEffect(localId, pendingSettlement => {
      if (pendingSettlement) pendingInputSettlementsByLocalId.set(localId, pendingSettlement);
      onAccepted?.(pendingSettlement);
    }, representedInputs);
  };
  const readTurnTranscriptState = (turnId: string) => {
    let state = runtimeTranscriptStateByTurnId.get(turnId);
    if (!state) {
      state = { userLocalIds: new Set<string>() };
      runtimeTranscriptStateByTurnId.set(turnId, state);
    }
    return state;
  };
  let activeRuntimeTranscriptTurnId: string | null = null;
  const trackRuntimeTranscriptProjection = (projection: Promise<void>): void => {
    pendingRuntimeTranscriptProjections.add(projection);
    const removeSettledProjection = (): void => {
      pendingRuntimeTranscriptProjections.delete(projection);
    };
    void projection.then(removeSettledProjection, removeSettledProjection);
  };
  // Delivery and runner termination own their budgets. A shorter projection
  // deadline would release ordering and fail valid output still awaiting its ACK.
  const drainRuntimeTranscriptProjections = async (): Promise<void> => {
    while (pendingRuntimeTranscriptProjections.size > 0) {
      await Promise.allSettled([...pendingRuntimeTranscriptProjections]);
    }
  };
  const enqueueSessionTurnMutation = (
    mutation: RuntimeSessionTurnMutationV1,
  ): void | Promise<void | Readonly<{ terminalStatusOverride: 'failed' }>> => {
    if (!isTerminalSessionTurnMutationAction(mutation.action)) {
      return params.session.enqueueSessionTurnMutation?.(mutation);
    }
    const projectionsBeforeTerminalMutation = [...pendingRuntimeTranscriptProjections];
    const cancellationAdmission = mutation.action === 'cancel' ? (async () => {
      if (!params.session.enqueueSessionTurnMutation) {
        throw new RuntimeTranscriptRequiredAdmissionError('durable_enqueue_unavailable', mutation.action);
      }
      await params.session.enqueueSessionTurnMutation(mutation);
    })() : null;
    void cancellationAdmission?.catch(() => undefined);
    const terminalMutation = (async () => {
      const enqueueTerminalMutation = params.session.enqueueSessionTurnMutation?.bind(params.session);
      if (!enqueueTerminalMutation) {
        throw new RuntimeTranscriptRequiredAdmissionError(
          'durable_enqueue_unavailable',
          mutation.action,
        );
      }
      await cancellationAdmission;
      let transcriptAdmissionFailure: RuntimeTranscriptRequiredAdmissionError | null = null;
      try {
        await Promise.all(projectionsBeforeTerminalMutation);
        if ('turnId' in mutation) {
          const earlierFailure = runtimeTranscriptStateByTurnId.get(mutation.turnId)?.failure;
          if (earlierFailure) throw earlierFailure;
        }
      } catch (error) {
        transcriptAdmissionFailure = error instanceof RuntimeTranscriptRequiredAdmissionError
          ? error
          : new RuntimeTranscriptRequiredAdmissionError(
              'durable_enqueue_failed',
              mutation.action,
            );
      }

      let terminalStatusOverride: 'failed' | undefined;
      if (transcriptAdmissionFailure && mutation.action === 'complete') {
        const { transcriptAnchors: _uncommittedAnchors, ...base } = mutation;
        mutation = { ...base, mutationId: `${mutation.mutationId}:transcript-custody-failed`, action: 'fail',
          issue: { v: 1, scope: 'primary_session', status: 'failed',
            code: 'runtime_transcript_required_admission_failed', source: 'stream_error', occurredAt: mutation.observedAt,
            ...(mutation.agentId ? { agentId: mutation.agentId } : {}),
            ...(mutation.agentTurnId ? { agentTurnId: mutation.agentTurnId } : {}),
            sanitizedPreview: 'Required transcript output could not be stored durably' } };
        terminalStatusOverride = 'failed';
        transcriptAdmissionFailure = null;
      }
      try {
        const turnState = 'turnId' in mutation ? readTurnTranscriptState(mutation.turnId) : null;
        if (mutation.action === 'fail' && turnState?.failureMessageSeq === undefined) {
          // Prompt dispatch and strict-resume failures can enter the lifecycle
          // directly, without a native transcript event. They use the same
          // diagnostic/terminal writer and exact committed marker receipt.
          const marker = await runtimeFailureTranscriptProjector({
            kind: 'turn-failed', sessionId: mutation.sessionId, turnId: mutation.turnId,
            sequence: 0, emittedAtMs: mutation.observedAt,
            ...(mutation.agentTurnId ? { agentTurnId: mutation.agentTurnId } : {}),
            diagnostic: { code: mutation.issue.code, severity: 'error',
              ...(mutation.issue.sanitizedPreview ? { message: mutation.issue.sanitizedPreview } : {}),
              details: { v: 1, source: mutation.issue.source, occurredAt: mutation.issue.occurredAt } },
          });
          if (turnState && marker?.committedSequence !== undefined) turnState.failureMessageSeq = marker.committedSequence;
        }
        // Join the existing Pending write before reading its acknowledged-row
        // projection. A settled attempt is ordering, not invented commit evidence.
        await Promise.all([...turnState?.userLocalIds ?? []]
          .map(localId => pendingInputSettlementsByLocalId.get(localId)));
        // Resolve only acknowledged rows after prior transcript projections.
        // Native acceptance can precede both begin-marker admission and HTTP ACKs.
        const userMessageSeqs = 'turnId' in mutation
          ? [...new Set([...readTurnTranscriptState(mutation.turnId).userLocalIds]
              .map(localId => params.session.getCommittedUserMessageSeq?.(localId))
              .filter((seq): seq is number => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0))]
              .sort((left, right) => left - right)
          : [];
        const startUserMessageSeq = userMessageSeqs[0];
        const finalAssistantMessageSeq = turnState?.finalAssistantMessageSeq ?? null;
        const failureMessageSeq = mutation.action === 'fail' ? turnState?.failureMessageSeq : undefined;
        // Context-only turns have no user row. Their turn-start frontier
        // still bounds the reply; a non-null final anchor requires that range.
        const startSeqInclusive = startUserMessageSeq ?? (finalAssistantMessageSeq === null
          ? failureMessageSeq
          : turnState?.startSeqExclusive != null
            ? turnState.startSeqExclusive + 1
            : finalAssistantMessageSeq);
        const observedSeq = mutation.action === 'fail' ? failureMessageSeq : params.session.getLastObservedMessageSeq?.();
        const endSeqs = [...userMessageSeqs,
          ...(typeof observedSeq === 'number' && Number.isSafeInteger(observedSeq) && observedSeq >= 0 ? [observedSeq] : []),
          ...(finalAssistantMessageSeq === null ? [] : [finalAssistantMessageSeq])];
        // Terminal mutations are turn-scoped; Session-scoped session_opened never anchors a turn.
        if ('turnId' in mutation
          && (transcriptAdmissionFailure || mutation.action === 'fail' || mutation.action === 'cancel' || mutation.action === 'wait')
          && (mutation.action === 'fail' || startSeqInclusive !== undefined || finalAssistantMessageSeq !== null)) {
          await enqueueTerminalMutation({
            v: mutation.v, sessionId: mutation.sessionId,
            mutationId: `${mutation.mutationId}:input-anchors`, observedAt: mutation.observedAt,
            ...(mutation.agentId ? { agentId: mutation.agentId } : {}),
            action: 'append_transcript_anchors', turnId: mutation.turnId,
            transcriptAnchors: {
              ...(startUserMessageSeq !== undefined ? { startUserMessageSeq, userMessageSeqs } : {}),
              ...(startSeqInclusive !== undefined ? { startSeqInclusive } : {}),
              endSeqInclusive: mutation.action === 'fail' ? failureMessageSeq ?? null : Math.max(...endSeqs),
              finalAssistantMessageSeq,
            },
          });
        }
        if (transcriptAdmissionFailure) throw transcriptAdmissionFailure;
        const settledMutation: RuntimeSessionTurnMutationV1 =
          mutation.action === 'complete'
            ? {
                ...mutation,
                transcriptAnchors: {
                  ...mutation.transcriptAnchors,
                  ...(startUserMessageSeq !== undefined ? { startUserMessageSeq, userMessageSeqs } : {}),
                  ...(startSeqInclusive !== undefined ? {
                    startSeqInclusive, endSeqInclusive: Math.max(...endSeqs),
                  } : {}),
                  finalAssistantMessageSeq,
                },
              }
            : mutation;
        if (mutation.action !== 'cancel') await enqueueTerminalMutation(settledMutation);
        if ('turnId' in mutation) {
          retireTurnTranscriptState(mutation.turnId);
        }
        if (terminalStatusOverride) return { terminalStatusOverride };
      } catch (error) {
        logger.debug(`${params.config.uiLogPrefix} Runtime terminal turn mutation failed`, {
          error: 'runtime_terminal_turn_mutation_failed',
          action: mutation.action,
        });
        throw error;
      }
      return undefined;
    })();
    trackRuntimeTranscriptProjection(terminalMutation.then(() => undefined));
    // Cancellation status is independent of reply custody. The tracked work
    // still joins every transcript write and publishes its exact anchors.
    return cancellationAdmission ?? terminalMutation;
  };
  let capabilityOverrideSync: RuntimeOverrideSynchronizers | null = null;
  const readCapabilityOverrideSync = (): RuntimeOverrideSynchronizers | null => capabilityOverrideSync;
  let lastCapabilitySettledTurnId: string | undefined;
  const sessionTurnLifecycle = createSessionTurnLifecycle({
    session: {
      get sessionId() {
        return params.session.sessionId;
      },
      enqueueSessionTurnMutation,
      readQuestionWaitTurnId: () => params.session.readQuestionWaitTurnId?.() ?? null,
    },
    agentId: params.policyAgentId,
    ...(params.deps.readTeamCredentialDenial || daemonTurnContributionsBridge?.readTeamCredentialDenial ? {
      readTeamCredentialDenial: params.deps.readTeamCredentialDenial ?? (async (turnId: string) =>
        await daemonTurnContributionsBridge?.readTeamCredentialDenial?.({ sessionId: params.session.sessionId, turnId }) ?? null),
    } : {}),
    readTurnFacts: () => preparedTurnFacts ?? stampTurnFacts({
      sessionWorkDepth: params.session.getWorkDepth?.() ?? 0, hostContextOnly: true,
    }),
    readStartingInput: (turnId) => {
      const snapshot = params.session.getServerFeaturesSnapshot();
      if (snapshot?.status !== 'ready'
        || readServerEnabledBit(snapshot.features, 'sessions.autonomousExchange') !== true) return null;
      const inputId = runtimeForPromptLoop.readTurnStartingInputId?.(turnId);
      return inputId ? { turnId, inputId } : null;
    },
    onTurnFactsChanged: (input) => {
      params.session.observeHostTurnFacts?.(input);
      if (input.facts === null) {
        preparedTurnFacts = null;
        lastCapabilitySettledTurnId = input.turnId;
        // Do not join this wake to transcript/marker custody: a restart waits
        // for this runner to exit, whose cleanup drains those same owners.
        void flushCapabilitiesAfterSettlement(input.turnId).catch(() => {
          logger.debug('[CapabilitySelection] Settled-turn apply unavailable; selection remains pending');
        });
      }
    },
    onAcceptedTurnFailure: async (event, issue) => {
      const details = event.diagnostic.details;
      const parsed = sanitizeConnectedServiceRuntimeFailureClassification(
        isRecord(details) ? details.runtimeAuthClassification : undefined,
      );
      if (!parsed || parsed.connectedServiceRecovery === 'unavailable') return;
      const classification = { ...parsed, runtimeIssueFingerprint: buildUsageLimitIssueFingerprint(issue) };
      try {
        const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
          sessionId: params.session.sessionId,
          classification,
        });
        if (report.report === null) {
          logger.warn('[connected-services] Failed-turn recovery report was not accepted by the daemon');
        }
        const projection = projectConnectedServiceRuntimeAuthRecoveryReport({ report, classification });
        if (projection.requiresFallback && report.statusMessage) {
          await params.session.enqueueSessionEventCommitted({ type: 'message', message: report.statusMessage });
        }
      } catch {
        logger.warn('[connected-services] Failed-turn recovery reporting could not complete');
      }
    },
    ...(params.opts.startedBy === 'daemon'
      ? {
          onAcceptedTurnLifecycle: async (input) => {
            const result = await notifyDaemonConnectedServiceTurnLifecycleFn({
              sessionId: params.session.sessionId,
              ...input,
              ...(process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]
                ? {
                    connectedServiceSelectionsEnvRaw:
                      process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY],
                  }
                : {}),
            });
            const response = result && typeof result === 'object'
              ? result as Readonly<Record<string, unknown>>
              : null;
            const turnCustody = response?.turnCustody && typeof response.turnCustody === 'object'
              ? response.turnCustody as Readonly<Record<string, unknown>>
              : null;
            if (response?.status !== 'continue' || turnCustody?.status !== 'recorded') {
              throw new Error('Daemon did not record exact turn marker custody');
            }
          },
        }
      : {}),
  });
  async function flushCapabilitiesAfterSettlement(turnId?: string): Promise<void> {
    await drainRuntimeTranscriptProjections();
    await sessionTurnLifecycle.drainAcceptedLifecycle();
    if (!shouldExit) await capabilityOverrideSync?.flushAfterSettledTurn?.(turnId);
  }
  const runtimeTranscriptProvider = normalizeAcpProvider(params.config.agentMessageType, 'agent');
  const normalizedToolTurnChangeTracker = new NormalizedToolTurnChangeTracker({
    provider: runtimeTranscriptProvider,
  });
  const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
    provider: runtimeTranscriptProvider,
    createSessionForStream: () => params.session,
  });
  const runtimeFailureTranscriptProjector = createRuntimeFailureTranscriptProjector({
    session: params.session,
    provider: runtimeTranscriptProvider,
    providerName: params.config.providerName,
  });
  let activeTerminalRemoteMode: TerminalRemoteSessionMode =
    resolvedStartingMode.kind === 'switching' ? resolvedStartingMode.startingMode : 'remote';
  let terminalHandoffFailureRequiresManualAction = false;
  let runtimeTranscriptProjectionSerial = Promise.resolve();
  const projectRuntimeTranscript = createRuntimeTranscriptProjector();
  // A native runtime ending can mean observer/protocol loss or a crash. It
  // cannot establish a clean process end, even when host cleanup exits zero.
  let runtimeEndedWithoutCleanExit = false;
  let requestRuntimeEndedTermination = (): void => undefined;
  const observeRuntimeLifecycleMessage = (message: unknown): void => {
    const parsedRuntimeEvent = AgentSessionRuntimeEventSchema.safeParse(message);
    if (parsedRuntimeEvent.success && parsedRuntimeEvent.data.kind === 'turn-cancelled') {
      logger.debug(`${params.config.uiLogPrefix} Runtime cancellation observed`, {
        turnId: parsedRuntimeEvent.data.turnId,
        emittedAtMs: parsedRuntimeEvent.data.emittedAtMs,
        pendingTranscriptProjections: pendingRuntimeTranscriptProjections.size,
      });
    }
    const questionWaitTurnId = params.session.readQuestionWaitTurnId?.() ?? null;
    if (parsedRuntimeEvent.success && parsedRuntimeEvent.data.kind === 'turn-start') {
      if (hostReadyCapture?.turnId === null && parsedRuntimeEvent.data.startedBy === 'host') {
        hostReadyCapture.turnId = parsedRuntimeEvent.data.turnId;
      }
      activeRuntimeTranscriptTurnId = parsedRuntimeEvent.data.turnId;
      const state = readTurnTranscriptState(parsedRuntimeEvent.data.turnId);
      delete state.failure;
      const startSeq = params.session.getLastObservedMessageSeq?.();
      if (typeof startSeq === 'number' && Number.isSafeInteger(startSeq) && startSeq >= 0) state.startSeqExclusive = startSeq;
    }
    if (parsedRuntimeEvent.success && parsedRuntimeEvent.data.kind === 'input-accepted') {
      const event = parsedRuntimeEvent.data;
      const state = readTurnTranscriptState(event.delivery.turnId);
      for (const localId of event.inputIds) state.userLocalIds.add(localId);
    }
    if (parsedRuntimeEvent.success && parsedRuntimeEvent.data.kind === 'transcript-message-committed'
      && parsedRuntimeEvent.data.role === 'user' && parsedRuntimeEvent.data.turnId) {
      readTurnTranscriptState(parsedRuntimeEvent.data.turnId).userLocalIds.add(parsedRuntimeEvent.data.messageId);
    }
    const parsedProjectionTurnId = parsedRuntimeEvent.success && 'turnId' in parsedRuntimeEvent.data
      ? parsedRuntimeEvent.data.turnId
      : null;
    const projectionTurnId = parsedRuntimeEvent.success && isSessionScopedRuntimeTranscriptEvent(parsedRuntimeEvent.data)
      ? null
      : typeof parsedProjectionTurnId === 'string'
        ? parsedProjectionTurnId
        : activeRuntimeTranscriptTurnId;
    if (parsedRuntimeEvent.success && projectionTurnId
      && isForegroundTurnRuntimeTranscriptEvent(parsedRuntimeEvent.data)
      && ((parsedRuntimeEvent.data.kind === 'message-delta' && parsedRuntimeEvent.data.channel === 'assistant')
        || (parsedRuntimeEvent.data.kind === 'transcript-message-committed' && parsedRuntimeEvent.data.role === 'assistant'))
      && parsedRuntimeEvent.data.text.trim().length > 0) {
      readTurnTranscriptState(projectionTurnId).hasAssistantText = true;
    }
    if (parsedRuntimeEvent.success && params.config.publishHostRuntimeEvent) {
      try {
        params.config.publishHostRuntimeEvent(parsedRuntimeEvent.data);
      } catch {
        logger.debug(`${params.config.uiLogPrefix} Host Event publication failed (non-fatal)`, {
          error: 'host_event_publication_failed',
          eventKind: parsedRuntimeEvent.data.kind,
        });
      }
    }
    const readyCapture = hostReadyCapture?.turnId === projectionTurnId ? hostReadyCapture : null;
    const projectedTranscript = projectRuntimeTranscript({
      session: params.session,
      provider: runtimeTranscriptProvider,
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol,
      publishTurnChangeSet: repositoryCheckpointLifecycle?.publishTurnChangeSet,
      mcpServerIdentities: params.config.mcpServerIdentities,
      skillDelivery: params.config.readSkillDelivery?.(),
      usageAccount: params.config.skillUsageAccount,
      event: message,
      questionWaitTurnId,
      priorProjection: runtimeTranscriptProjectionSerial,
    });
    const transcriptProjection = (async () => {
      let transcriptProjectionError: unknown = null;
      let projectionResult: RuntimeTranscriptProjectionResult | undefined;
      try {
        projectionResult = await projectedTranscript;
      } catch (error) {
        transcriptProjectionError = error;
      }
      if (projectionTurnId && projectionResult?.projected && projectionResult.finalAssistantMessageSeq !== undefined) {
        const state = readTurnTranscriptState(projectionTurnId);
        state.finalAssistantMessageSeq = Math.max(state.finalAssistantMessageSeq ?? 0, projectionResult.finalAssistantMessageSeq);
      }
      try {
        if (parsedRuntimeEvent.success) {
          await observeAgentStreamTokenEvent({
            event: parsedRuntimeEvent.data,
            agentId: params.policyAgentId,
            observeAgentStreamToken,
            uiLogPrefix: params.config.uiLogPrefix,
          });
          const failureMarker = await runtimeFailureTranscriptProjector(parsedRuntimeEvent.data,
            projectionResult?.projected ? projectionResult.terminalSourceMessage : undefined);
          if (projectionTurnId && parsedRuntimeEvent.data.kind === 'turn-failed'
            && failureMarker?.committedSequence !== undefined) {
            readTurnTranscriptState(projectionTurnId).failureMessageSeq = failureMarker.committedSequence;
          }
        }
      } catch (error) {
        transcriptProjectionError ??= error;
      }
      if (
        parsedRuntimeEvent.success && projectionTurnId
        && (parsedRuntimeEvent.data.kind === 'turn-complete' || parsedRuntimeEvent.data.kind === 'turn-failed'
          || parsedRuntimeEvent.data.kind === 'turn-cancelled')
      ) {
        const state = readTurnTranscriptState(projectionTurnId);
        if (parsedRuntimeEvent.data.kind === 'turn-complete' && state.hasAssistantText
          && state.finalAssistantMessageSeq === undefined) {
          transcriptProjectionError ??= new RuntimeTranscriptRequiredAdmissionError('delivery_not_confirmed', parsedRuntimeEvent.data.kind);
        }
      }
      if (
        readyCapture && readyCapture.context === undefined && parsedRuntimeEvent.success
        && (parsedRuntimeEvent.data.kind === 'turn-complete' || parsedRuntimeEvent.data.kind === 'turn-failed'
          || parsedRuntimeEvent.data.kind === 'turn-cancelled')
      ) {
        // The ordered terminal projection has flushed this host turn's text.
        // Capture it before a successor can update the Session snapshot.
        readyCapture.context = {
          assistantPreviewText: transcriptProjectionError ? null : params.session.getTurnAssistantTextSnapshotStore?.()
            ?.getCurrentTurnSnapshot({ turnToken: readyCapture.snapshotScope?.turnToken ?? null })?.normalizedText ?? null,
          ...(!transcriptProjectionError && parsedRuntimeEvent.data.kind === 'turn-complete'
            && questionWaitTurnId !== parsedRuntimeEvent.data.turnId && projectionResult?.projected ? {
              completedTurn: { turnId: parsedRuntimeEvent.data.turnId,
                ...(projectionResult.terminalSourceMessage ? { original: projectionResult.terminalSourceMessage } : {}),
              },
            } : {}),
        };
      }
      if (transcriptProjectionError) {
        throw transcriptProjectionError;
      }
    })();
    const loggedTranscriptProjection = transcriptProjection.then(
      () => undefined,
      (error) => {
        if (
          projectionTurnId
          && error instanceof RuntimeTranscriptRequiredAdmissionError
        ) {
          readTurnTranscriptState(projectionTurnId).failure = error;
        }
        logger.debug(
          error instanceof RuntimeTranscriptRequiredAdmissionError
            ? `${params.config.uiLogPrefix} Required runtime transcript admission failed`
            : `${params.config.uiLogPrefix} Runtime transcript projection failed (non-fatal)`,
          {
            error: error instanceof RuntimeTranscriptRequiredAdmissionError
              ? error.code
              : 'runtime_transcript_projection_failed',
            eventKind: parsedRuntimeEvent.success ? parsedRuntimeEvent.data.kind : 'invalid',
            ...(error instanceof RuntimeTranscriptRequiredAdmissionError
              ? { reason: error.reason }
              : {}),
          },
        );
      },
    );
    void loggedTranscriptProjection;
    trackRuntimeTranscriptProjection(transcriptProjection);
    runtimeTranscriptProjectionSerial = transcriptProjection.then(
      () => undefined,
      () => undefined,
    );
    observeRuntimeMessageForSessionTurnLifecycle({
      lifecycle: sessionTurnLifecycle,
      message,
    });
    if (parsedRuntimeEvent.success) setThinkingState(sessionTurnLifecycle.hasActiveTurn());
    const observation = mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: params.policyAgentId,
      message,
    });
    if (observation) {
      terminalHandoffFailureRequiresManualAction = false;
      terminalTurnStateMachine.observe(observation);
    }
    if (parsedRuntimeEvent.success && parsedRuntimeEvent.data.kind === 'runtime-ended') {
      runtimeEndedWithoutCleanExit = true;
      requestRuntimeEndedTermination();
    }
  };
  let unsubscribeRuntimeEvents = (): void => undefined;
  const subscribeRuntimeEventsRequired = (): void => {
    let unsubscribe: unknown;
    try {
      unsubscribe = runtimeForPromptLoop.subscribeRuntimeEvents(observeRuntimeLifecycleMessage);
    } catch {
      throw new RuntimeEventSubscriptionRequiredError('subscription_failed');
    }
    if (typeof unsubscribe !== 'function') {
      throw new RuntimeEventSubscriptionRequiredError('invalid_unsubscribe');
    }
    unsubscribeRuntimeEvents = () => {
      unsubscribe();
    };
  };
  let runtimeEventsUnsubscribed = false;
  const unsubscribeRuntimeEventsOnce = (): void => {
    if (runtimeEventsUnsubscribed) return;
    runtimeEventsUnsubscribed = true;
    unsubscribeRuntimeEvents();
  };
  const runtimeOverrideTarget: RuntimeOverrideTarget = createRuntimeOverrideTarget({
    runtime: runtimeForPromptLoop,
    transitionModelSelection: params.transitionModelSelection,
  });
  const resolveFreshSessionSystemPrompt = params.resolveFreshSessionSystemPrompt
    ?? createSessionPromptPlanResolver({
      opts: params.opts, session: params.session, agentId: params.policyAgentId,
      machineId: params.machineId, directory: params.runtimeDirectory,
      memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled,
      readNativeSessionId: () => runtimeForPromptLoop.readSessionIdentity().sessionId,
      resolveRoleContext: params.resolveSessionRolePromptContext,
      daemonBridge: daemonTurnContributionsBridge,
    });
  const runtimeForInFlightSteer: { current: RuntimeTurnOperations | null } = { current: runtimeForPromptLoop };
  let shouldExit = false;
  let abortController = new AbortController();
  let cleanupPromise: Promise<void> | null = null;
  let runnerTerminationWork: Promise<void> | null = null;
  let runtimeDisposeReason: RuntimeTurnDisposeReason = 'runtime_recovery';
  let runtimeDisposePromise: Promise<void> | null = null;
  const disposeRuntimeOnce = (reason: RuntimeTurnDisposeReason): Promise<void> => {
    runtimeDisposePromise ??= (async () => {
      // Physical runner retirement owns every child Run in this generation.
      // Start child cleanup before native or transport cleanup can suspend it.
      // A mode handoff/recovery retains the Session's independent child work.
      const outcomes = await Promise.allSettled([
        ...(reason === 'host_shutdown' || reason === 'session_closed'
          ? [Promise.resolve().then(() => params.session.disposeExecutionRuns())]
          : []),
        Promise.resolve().then(() => runtimeForPromptLoop.resetOrDisposeRuntime(reason)),
      ]);
      const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (failures.length === 1) throw failures[0]!.reason;
      if (failures.length > 1) throw new AggregateError(failures.map(failure => failure.reason), 'Runner retirement failed');
    })();
    return runtimeDisposePromise;
  };
  let startupCoordinatorStarted = false;

  const startStartupCoordinator = async (): Promise<void> => {
    if (startupCoordinatorStarted) return;
    if (!params.startupCoordinator?.start) return;
    startupCoordinatorStarted = true;
    await params.startupCoordinator.start();
  };

  const cancelCurrentTurn = (permissionScope: 'foreground' | 'session') => {
    logger.debug(`${params.config.uiLogPrefix} Abort requested`);
    resetAssistantTextSnapshotTurnScope(params.session, 'abort');
    abortController.abort();
    abortController = new AbortController();
    // Permission withdrawal may await Home persistence. Native cancellation
    // must propagate while that independent write is still pending.
    let explicitStop = permissionScope === 'foreground';
    const permissions = (async () => {
      if (!explicitStop) {
        try {
          // Daemon Stop commits its intent before signalling, but the local
          // socket projection can lag. Read the canonical snapshot before
          // deciding whether this physical retirement withdraws questions.
          await params.session.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain', afterCurrentRead: true });
          const stop = readSessionExplicitStopV1FromMetadata(params.session.getMetadataSnapshot());
          explicitStop = stop !== null && !('status' in stop);
        } catch {
          logger.infoFile(`${params.config.uiLogPrefix} Stop intent unavailable during runtime retirement; preserving questions`, {
            error: 'retirement_stop_intent_unavailable',
          });
        }
      }
      try {
        await params.permissionHandler.reset(explicitStop ? { scope: 'foreground' } : undefined);
      } catch {
        logger.infoFile(`${params.config.uiLogPrefix} Permission reset failed during Stop; continuing runtime cancellation`, {
          error: 'permission_reset_failed',
        });
      }
    })();
    const completed = Promise.all([
      permissions,
      (async () => {
        try {
          await runtimeForPromptLoop.cancelTurn();
        } catch {
          logger.infoFile(`${params.config.uiLogPrefix} Failed to cancel current operation (non-fatal)`, {
            error: 'runtime_cancel_failed',
          });
        }
      })(),
    ]).then(() => undefined);
    return { permissions, completed, isExplicitStop: () => explicitStop };
  };
  const handleAbort = () => cancelCurrentTurn('foreground').completed;
  const settleExplicitlyStoppedTurn = async (): Promise<void> => {
    if (!sessionTurnLifecycle.hasActiveTurn() || !activeRuntimeTranscriptTurnId) return;
    // Successful disposal after an admitted person Stop establishes host
    // cancellation even when native cleanup retires its event subscribers.
    // Reuse terminal projection and reply custody; an abort request alone
    // cannot establish this outcome, nor replace an observed native terminal.
    observeRuntimeLifecycleMessage({
      sequence: 0,
      sessionId: params.session.sessionId,
      emittedAtMs: Date.now(),
      kind: 'turn-cancelled',
      turnId: activeRuntimeTranscriptTurnId,
      cause: 'user',
    });
    await drainRuntimeTranscriptProjections();
    await sessionTurnLifecycle.drainAcceptedLifecycle();
  };
  params.setAbortRequestedCallback(handleAbort, () => abortController.signal);
  let inkInstance: ReturnType<typeof render> | null = null;
  let staticControl: RemoteModeStaticControl | null = null;
  let terminalDisplayRequested = false;
  let terminalDisplayMount: Promise<void> | null = null;
  const requestTerminalExit = async (): Promise<void> => {
    terminationHandlers.requestTermination({
      kind: 'signal',
      signal: 'SIGINT',
    });
    await terminationHandlers.whenTerminated;
  };
  const mountTerminalDisplay = async (): Promise<void> => {
    if (!hasTTY || shouldExit || inkInstance || staticControl) return;
    terminalDisplayRequested = true;
    const shouldMountRemoteOnlyTerminalDisplay =
      resolvedStartingMode.kind === 'remote-only' && remoteControlSurface !== 'none';
    if (!shouldMountRemoteOnlyTerminalDisplay && remoteControlSurface === 'static') {
      staticControl = startRemoteModeStaticControlFn({
        providerName: params.config.providerName,
        stdin: process.stdin,
        stdout: process.stdout,
        allowSwitchToTerminal: false,
        onExit: requestTerminalExit,
      });
      return;
    }
    if (!shouldMountRemoteOnlyTerminalDisplay && remoteControlSurface !== 'ink') return;
    terminalDisplayMount ??= (async () => {
      // The catalog/daemon can construct plans without initializing the TUI.
      // Only this existing Ink-render branch owns loading its complete subtree.
      const displayProps = {
        messageBuffer: params.messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        onExit: requestTerminalExit,
      };
      const reactModule = import('react').then(module => ({ ...module.default, ...module }));
      const displayElement = shouldMountRemoteOnlyTerminalDisplay
        ? Promise.all([
            reactModule,
            params.deps.remoteOnlyTerminalDisplayComponent
              ? Promise.resolve(params.deps.remoteOnlyTerminalDisplayComponent)
              : import('./display/remoteOnlyTerminal').then(module => module.RemoteOnlyTerminalDisplay),
          ]).then(([React, Display]) => React.createElement(Display, {
            ...displayProps,
            backendDisplayName: params.config.backendDisplayName,
            requestedMode: resolvedStartingMode.requestedMode,
          }))
        : Promise.all([reactModule, params.config.loadTerminalDisplay()])
          .then(([React, Display]) => React.createElement(Display, displayProps));
      const [{ render }, element] = await Promise.all([import('ink'), displayElement]);
      // An attach/unmount or termination can retire this request while its
      // module loads. Do not clear or redraw the newly owned terminal then.
      if (!terminalDisplayRequested || shouldExit) return;
      console.clear();
      inkInstance = (params.deps.renderFn ?? render)(element, { exitOnCtrlC: false, patchConsole: false });
    })().finally(() => {
      terminalDisplayMount = null;
    });
    await terminalDisplayMount;
  };
  const unmountTerminalDisplay = async (): Promise<void> => {
    terminalDisplayRequested = false;
    if (staticControl) {
      await staticControl.stop();
      staticControl = null;
    }
    if (!inkInstance) return;
    inkInstance.unmount();
    inkInstance = null;
  };

  params.config.onTerminalDisplayControllerReady?.({
    mount: mountTerminalDisplay,
    unmount: unmountTerminalDisplay,
    isMounted: () => inkInstance !== null || staticControl !== null,
  });

  const getKeepAliveMode = (): HostSessionKeepAliveMode =>
    params.config.resolveKeepAliveMode?.()
    ?? (terminalRemoteModeLoop ? activeTerminalRemoteMode : 'remote');
  let lastKeepAliveSentAt = 0;
  let lastKeepAliveSignature: string | null = null;
  let keepAliveStopped = false;
  const stopKeepAlive = (): void => {
    keepAliveStopped = true;
  };
  const publishKeepAlive = (): void => {
    if (keepAliveStopped) return;
    const now = Date.now();
    const mode = getKeepAliveMode() === 'terminal' ? 'local' : 'remote';
    const signature = `${params.session.sessionId}:${params.runtimeState.thinking ? 'thinking' : 'idle'}:${mode}`;
    if (lastKeepAliveSignature === signature && now - lastKeepAliveSentAt < KEEP_ALIVE_DUPLICATE_SUPPRESSION_MS) return;
    params.session.keepAlive(params.runtimeState.thinking, mode);
    lastKeepAliveSignature = signature;
    lastKeepAliveSentAt = now;
  };
  const setThinkingState = (value: boolean): void => {
    const thinking = value || sessionTurnLifecycle.hasActiveTurn();
    if (params.runtimeState.thinking === thinking) return;
    params.runtimeState.thinking = thinking;
    publishKeepAlive();
  };
  publishKeepAlive();

  let closeFailedSession = false;
  const endSessionAfterProcessExit = async (cleanExit: boolean): Promise<void> => {
    try {
      if (cleanExit && params.session.hasOwnerMetadataAuthority()) {
        const stoppedAt = Date.now();
        await params.session.updateMetadataAsCurrentPublisher(metadata => ({
          ...metadata,
          lifecycleState: 'stopped',
          lifecycleStateSince: stoppedAt,
        }));
      }
    } finally {
      // Metadata failure or a superseded publisher must not skip the existing
      // semantic-end/transport cleanup; its own authority checks still apply.
      await params.session.endSessionAndClose();
    }
  };
  const cleanupOnce = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (closeFailedSession) params.session.prepareForClose();
      unsubscribeRuntimeEventsOnce();
      await drainRuntimeTranscriptProjections();
      // Normal completion retains accepted marker custody until it drains.
      // Termination retires publication separately when the daemon is quiescing.
      await sessionTurnLifecycle.drainAcceptedLifecycle();
      sessionTurnLifecycle.retireAcceptedLifecyclePublication();
      if (closeFailedSession) {
        // Failed startup/terminal admission still owns an open Session RPC
        // channel. Withdraw controls and settle its callers through normal
        // close before native cleanup can wait on those same observers.
        try {
          try {
            await onBeforeSessionClose?.({ session: params.session, runtime: hookRuntimeForCallbacks });
          } finally {
            await params.session.close();
          }
        } catch {
          logger.debug(`${params.config.uiLogPrefix} Failed Session close rejected (non-fatal)`, {
            error: 'failed_session_close_failed',
          });
        }
      }
      await params.config.lifecycleHooks?.onBeforeDispose?.({ session: params.session, runtime: hookRuntimeForCallbacks });
      await cleanupBackendRunResourcesFn({
        stopKeepAlive,
        reconnectionHandle: params.reconnectionHandle,
        stopMcpServer: () => params.happyMcpServerStop(),
        resetRuntime: () => disposeRuntimeOnce(runtimeDisposeReason),
        unmountUi: unmountTerminalDisplay,
      });
      await params.startupCoordinator?.cleanup?.();
      await params.config.onDispose?.({ session: params.session, runtime: hookRuntimeForCallbacks });
    })();
    return cleanupPromise;
  };

  const terminationHandlers = registerRunnerTerminationHandlersFn({
    process,
    exit: (code) => process.exit(code),
    ...(params.config.processLifecycleOwnership
      ? { processLifecycleOwnership: params.config.processLifecycleOwnership }
      : {}),
    sessionExitReport: { sessionId: params.session.sessionId },
    onTerminate: (event, outcome) => {
      const cleanProcessExit = outcome.exitCode === 0 && !runtimeEndedWithoutCleanExit;
      const work = (async () => {
        runtimeDisposeReason = resolveRunnerRuntimeDisposalReason(event);
        shouldExit = true;
        try {
          let permissionRetirement = Promise.resolve();
          let isExplicitStop = () => false;
          await abortAndDisposeRunnerRuntime({
            retireUndispatchedInput: () => params.session.retireUndispatchedProviderInput(),
            // Physical retirement keeps durable questions for the replacement
            // runner. Only explicit Stop withdraws them at the foreground owner.
            abortActiveTurn: () => {
              const cancellation = cancelCurrentTurn(event.kind === 'killSession' ? 'foreground' : 'session');
              permissionRetirement = cancellation.permissions;
              isExplicitStop = cancellation.isExplicitStop;
              return cancellation.completed;
            },
            disposeRuntime: disposeRuntimeOnce,
            reason: runtimeDisposeReason,
          });
          // Native disposal stays independent of provider cancellation. Keep
          // the transport alive until request retirement has read Stop intent.
          await permissionRetirement;
          if (isExplicitStop()) await settleExplicitlyStoppedTurn();
          params.session.prepareForClose();
          unsubscribeRuntimeEventsOnce();
          await drainRuntimeTranscriptProjections();
          sessionTurnLifecycle.retireAcceptedLifecyclePublication();
          await sessionTurnLifecycle.drainAcceptedLifecycle();
          await onBeforeSessionClose?.({
            session: params.session,
            runtime: hookRuntimeForCallbacks,
          });
          // Termination ends the runtime, never the Happy session's lifecycle intent:
          // the session becomes inactive and stays resumable. Archiving is a separate
          // user-intent action owned by the session archive service.
          await endSessionAfterProcessExit(cleanProcessExit);
        } finally {
          await cleanupOnce();
        }
      })();
      runnerTerminationWork = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
  });
  requestRuntimeEndedTermination = () => {
    terminationHandlers.requestTermination({ kind: 'exit', code: 0 });
  };

  params.session.rpcHandlerManager.registerHandler('abort', handleAbort);
  const requestRuntimeStop = async () => {
    logger.debug(`${params.config.uiLogPrefix} Kill session requested`);
    await requestExplicitRunnerStop({
      retireUndispatchedInput: () => params.session.retireUndispatchedProviderInput(),
      abortActiveTurn: handleAbort,
      disposeRuntime: disposeRuntimeOnce,
      requestTermination: terminationHandlers.requestTermination,
      whenTerminated: terminationHandlers.whenTerminated,
    });
  };
  params.config.onRuntimeStopReady?.(requestRuntimeStop);
  registerKillSessionHandlerFn(params.session.rpcHandlerManager, requestRuntimeStop);

  if (!shouldExit) {
    try {
      if (hasTTY && shouldRenderTerminalDisplay) await mountTerminalDisplay();
      if (!shouldExit) {
        subscribeRuntimeEventsRequired();
        await startStartupCoordinator();
      }
    } catch (error) {
      terminationHandlers.dispose();
      shouldExit = true;
      abortController.abort();
      closeFailedSession = true;
      try {
        await cleanupOnce();
      } catch {
        logger.debug(
          `${params.config.uiLogPrefix} Shared startup coordinator cleanup failed after startup rejection (non-fatal)`,
          { error: 'startup_coordinator_cleanup_failed' },
        );
      }
      throw error;
    }
  }

  const createSendReady = params.config.createSendReady
    ? params.config.createSendReady({ session: params.session, api: params.api })
    : createReadyNotificationDispatcher({
        session: params.session,
        pushSender: params.api.push(),
        waitingForCommandLabel: params.config.waitingForCommandLabel,
        logPrefix: params.config.uiLogPrefix,
        accountSettings: params.opts.accountSettingsContext?.settings ?? null,
        settingsSecretsReadKeys: params.opts.accountSettingsContext?.settingsSecretsReadKeys ?? [],
        includeAssistantPreviewText:
          params.opts.accountSettingsContext?.settings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
        sendReadyWithPushNotificationFn,
      });

  // Opaque Agent identity: presence gates the strict-resume path below, and
  // the value itself reaches the prompt loop byte for byte.
  const initialResumeId = readNonBlankOpaqueIdentifier(params.initialResumeId) ?? '';
  const resolvePendingCountForHandoff = async (): Promise<number> => {
    const pendingQueueState = params.session.getPendingQueueState?.();
    if (pendingQueueState?.known) {
      return Math.max(0, pendingQueueState.pendingCount);
    }
    if (typeof params.session.shouldAttemptPendingMaterialization === 'function'
      && !params.session.shouldAttemptPendingMaterialization()) {
      return 0;
    }
    return 1;
  };
  const resolveResumeReadiness = (): { ready: boolean; detail?: string } => {
    const adapterReadiness = terminalRemoteModeLoop?.getResumeReadiness?.();
    if (adapterReadiness?.ready) {
      return adapterReadiness;
    }
    try {
      const runtimeIdentity = runtimeForPromptLoop.readSessionIdentity();
      const sessionId = typeof runtimeIdentity.sessionId === 'string' ? runtimeIdentity.sessionId.trim() : '';
      if (sessionId.length > 0 || initialResumeId.length > 0) {
        return { ready: true };
      }
    } catch {
      return adapterReadiness ?? { ready: false, detail: 'runtime_session_identity_unavailable' };
    }
    return adapterReadiness ?? { ready: false, detail: 'missing_runtime_session_identity' };
  };
  const normalizeRemoteHandoffResult = (result: unknown): HostSessionTerminalRemoteHandoffResult => {
    if (result === false) {
      return { ok: false, detail: 'remote_handoff_rejected' };
    }
    if (result && typeof result === 'object') {
      const record = result as Readonly<Record<string, unknown>>;
      if (record.ok === false) {
        return { ok: false, detail: 'remote_handoff_rejected' };
      }
      if (record.ok === true) {
        return { ok: true };
      }
    }
    return { ok: true };
  };
  const requestGracefulRemoteHandoff = async (
    reason: HostSessionTerminalRemoteHandoffReason,
  ): Promise<HostSessionTerminalRemoteHandoffResult> => {
    try {
      if (terminalRemoteModeLoop?.requestGracefulRemoteHandoff) {
        return normalizeRemoteHandoffResult(await terminalRemoteModeLoop.requestGracefulRemoteHandoff(reason));
      }
      const result = await params.session.rpcHandlerManager.invokeLocal('switch', { to: 'remote', reason });
      if (result && typeof result === 'object') {
        const record = result as Readonly<Record<string, unknown>>;
        if (typeof record.error === 'string') {
          return { ok: false, detail: 'remote_handoff_rejected' };
        }
      }
      return normalizeRemoteHandoffResult(result);
    } catch {
      logger.debug(`${params.config.uiLogPrefix} Failed to request remote handoff`, {
        error: 'remote_handoff_failed',
        reason,
      });
      return {
        ok: false,
        detail: 'remote_handoff_failed',
      };
    }
  };
  const beforePendingMaterialize = async (): Promise<boolean> => {
    const decision = resolvePendingQueueHandoff({
      currentMode: activeTerminalRemoteMode,
      remoteTurnInFlight: sessionTurnLifecycle.hasActiveTurn(),
      terminalTopology: terminalRemoteModeLoop?.topology ?? (terminalRemoteModeLoop ? 'exclusive' : null),
      terminalRemoteWritable: terminalRemoteModeLoop?.remoteWritable === true,
      terminalTurnState: terminalTurnStateMachine.getState(),
      pendingCount: await resolvePendingCountForHandoff(),
      resumeReadiness: resolveResumeReadiness(),
      intent: 'queue',
      nowMs: Date.now(),
    });
    if (decision.action.type === 'materialize_remote_pending') {
      terminalHandoffFailureRequiresManualAction = false;
      return true;
    }
    if (decision.action.type === 'request_graceful_remote_handoff') {
      if (terminalHandoffFailureRequiresManualAction) {
        return false;
      }
      const result = await requestGracefulRemoteHandoff(decision.action.reason);
      if (!result.ok) {
        terminalHandoffFailureRequiresManualAction = true;
      }
      return false;
    }
    if (decision.action.type === 'cancel_terminal_turn_then_handoff') {
      try {
        await runtimeForPromptLoop.cancelTurn();
        terminalTurnStateMachine.observe({
          type: 'turn_aborted',
          agentId: params.policyAgentId,
          reason: decision.action.abortReason,
          detail: decision.action.detail,
          source: 'lifecycle_event',
        });
      } catch {
        terminalHandoffFailureRequiresManualAction = true;
        return false;
      }
      const result = await requestGracefulRemoteHandoff('switch_now');
      if (!result.ok) {
        terminalHandoffFailureRequiresManualAction = true;
      }
      return false;
    }
    return false;
  };
  let terminalRemoteModeLoopError: unknown = null;
  let terminalProcessExited = false;
  let terminalProcessExitedCleanly = false;
  const terminalRemoteModeLoopPromise = !shouldExit && terminalRemoteModeLoop && resolvedStartingMode.kind === 'switching'
    ? runTerminalRemoteSessionModeLoopFn({
        ...terminalRemoteModeLoop,
        startingMode: resolvedStartingMode.startingMode,
        onBeforeIteration: async (mode) => {
          activeTerminalRemoteMode = mode;
          if (terminalRemoteModeLoop.ownsCurrentTerminalDisplay === true) {
            if (mode === 'terminal') {
              await unmountTerminalDisplay();
            } else {
              await mountTerminalDisplay();
            }
          }
          await terminalRemoteModeLoop.onBeforeIteration?.(mode);
        },
        runTerminal: async (loopParams) => {
          if (shouldExit) return { type: 'exit', code: 0 };
          const result = await terminalRemoteModeLoop.runTerminal(loopParams);
          if (result.type === 'exit') {
            terminalProcessExited = true;
            terminalProcessExitedCleanly = result.code === 0;
            terminalTurnStateMachine.observe({
              type: 'process_exited',
              agentId: params.policyAgentId,
              exitCode: result.code,
            });
          }
          return result;
        },
        runRemote: async () => {
          if (shouldExit) return 'exit';
          activeTerminalRemoteMode = 'remote';
          return await terminalRemoteModeLoop.runRemote();
        },
        onModeChange: async (mode) => {
          activeTerminalRemoteMode = mode;
          if (mode === 'remote') {
            terminalHandoffFailureRequiresManualAction = false;
          }
          await terminalRemoteModeLoop.onModeChange(mode);
          publishKeepAlive();
        },
      }).catch((error: unknown) => {
        terminalRemoteModeLoopError = error;
        closeFailedSession = true;
      }).finally(() => {
        shouldExit = true;
        abortController.abort();
      })
    : null;

  let promptLoopError: unknown = null;
  try {
    await runPermissionModePromptLoopFn({
      providerName: params.config.providerName,
      agentMessageType: params.config.agentMessageType,
      explicitPermissionMode: params.opts.permissionMode,
      session: params.session,
      messageQueue: params.permissionModeState.messageQueue,
      replaySeedRetirement: params.permissionModeState.replaySeedRetirement,
      permissionHandler: params.permissionHandler,
      runtime: runtimeForPromptLoop,
      createOverrideSynchronizer: (isStarted, isInputSettled): PromptLoopOverrideSynchronizer | RuntimeOverrideSynchronizers => {
        const sync = createRuntimeOverrideSynchronizersFn({
        agentTargetKey: buildBackendTargetKeyV2(params.opts.backendTarget
          ? params.opts.backendTarget
          : { kind: 'backend', backendId: params.policyAgentId, sourceKind: 'built_in' }),
        session: params.session,
        runtime: runtimeOverrideTarget,
        isStarted,
        configOptionRejectionTranscript: {
          session: params.session,
          provider: normalizeAcpProvider(params.config.agentMessageType, params.policyAgentId),
        },
        ...(params.capabilitySelection ? { capabilitySelection: {
          ...params.capabilitySelection,
          session: params.session,
          isStarted,
          isSettled: () => isInputSettled() && !sessionTurnLifecycle.hasActiveTurn() && !params.runtimeState.thinking,
        } } : {}),
        });
        capabilityOverrideSync = sync;
        return sync;
      },
      messageBuffer: params.messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => publishKeepAlive(),
      setThinking: setThinkingState,
      sendReady: createSendReady,
      currentPermissionModeUpdatedAt: params.permissionModeState.getCurrentPermissionModeUpdatedAt(),
      setCurrentPermissionMode: params.permissionModeState.setCurrentPermissionMode,
      setCurrentPermissionModeUpdatedAt: params.permissionModeState.setCurrentPermissionModeUpdatedAt,
      registerProviderAcceptedEffect,
      onBeforeTurnBegin: (input, snapshotScope) => {
        const capture: HostReadyCapture = { turnId: null, snapshotScope };
        hostReadyCapture = capture;
        const contextOnly = input.hostContextOnly;
        preparedTurnFacts = stampTurnFacts({
          sessionWorkDepth: params.session.getWorkDepth?.() ?? 0,
          provenance: input.inputProvenance,
          hostContextOnly: contextOnly !== undefined,
          ...(contextOnly?.kind === 'workflow_step' ? {
            workflowInvocation: contextOnly.workflowInvocation,
            workflowWorkDepth: contextOnly.workDepth,
          } : {}),
        });
        return () => capture.context;
      },
      releaseRejectedBeforeProviderPromptIdentity: (session, message) =>
        params.permissionModeState.releaseRejectedBeforeProviderPromptIdentity(session, message),
      initialResumeId: initialResumeId || undefined,
      strictInitialResume: initialResumeId.length > 0,
      onPromptFailure: async error => {
        await surfacePrimarySessionRuntimeIssue({
          provider: params.policyAgentId,
          cause: 'session_error',
          error,
          session: { sessionId: params.session.sessionId, sessionTurnLifecycle },
          allocateTurnWhenIdle: true,
        });
      },
      onStrictInitialResumeFailure: async (failure) => {
        try {
          await params.onStrictInitialResumeFailure?.(failure);
        } finally {
          await surfacePrimarySessionRuntimeIssue({
            provider: params.policyAgentId,
            cause: 'status_error',
            error: failure.error,
            session: {
              sessionId: params.session.sessionId,
              sessionTurnLifecycle,
            },
            allocateTurnWhenIdle: true,
          });
        }
      },
      startRuntimeBeforeFirstPrompt: params.config.startRuntimeBeforeFirstPrompt === true,
      pendingQueueDrainMaxPopPerWake: resolveSessionPendingQueueMaxPopPerWake(params.opts.accountSettingsContext?.settings ?? null),
      pendingQueueDeliveryTiming: resolveSessionPendingQueueDeliveryTiming(params.opts.accountSettingsContext?.settings ?? null),
      setActiveAgentCompositionToolSelection: params.setActiveAgentCompositionToolSelection,
      readReferenceAction: params.readReferenceAction,
      ...(daemonTurnContributionsBridge
        ? {
            resolveComposerAttachmentForDispatch: async (input) =>
              await daemonTurnContributionsBridge.resolveComposerAttachment(
                projectSessionComposerAttachmentDispatchInput(input, params.session.sessionId),
              ),
          }
        : {}),
      resolveFreshSessionSystemPrompt: Object.assign(async (args: Parameters<SessionPromptPlanResolver>[0]) => {
        const prompt = await resolveFreshSessionSystemPrompt({ ...args, signal: abortController.signal });
        await params.prepareSessionRolePromptPolicy?.();
        resolveFreshSessionSystemPrompt.assertPreparedPlanCurrent?.();
        return prompt;
      }, { assertPreparedPlanCurrent: resolveFreshSessionSystemPrompt.assertPreparedPlanCurrent }),
      readSessionPromptPlanDeliveryState: () => {
        const startup = resolveFreshSessionSystemPrompt.readStartupInstructions?.();
        const capabilities = readAgentSessionCapabilities(readAgentCatalogSnapshot()
          .agentDefinitionsById.get(params.policyAgentId)?.richDefinition?.definition);
        return {
          ...(startup ? { marker: { v: startup.v, id: startup.id, revision: startup.revision } } : {}),
          startupInstructionsSupported: capabilities?.startupInstructions?.versions.includes(1) === true,
          ...(capabilities?.startupInstructions?.revisionChanges
            ? { revisionChanges: capabilities.startupInstructions.revisionChanges } : {}),
          // Spawn custody is not proof that the complete plan reached a native channel.
          // The native delivered marker is supplied only by the accepted full-plan producer.
        };
      },
      readSessionPromptPlanComposition: () => resolveFreshSessionSystemPrompt.readComposition?.() ?? null,
      resolveAgentCompositionBeforeDispatch: async ({ signal }) => {
        const executionRunsFeatureEnabled = resolveCliFeatureDecision({
          featureId: 'execution.runs',
          env: process.env,
        }).state === 'enabled';
        try {
          const composition = daemonTurnContributionsBridge
            ? await daemonTurnContributionsBridge.resolveAgentComposition({
                sessionId: params.session.sessionId,
                runtimeFamily: 'hostSession',
                machineId: params.machineId,
                featureIds: executionRunsFeatureEnabled ? ['execution.runs'] : [],
                signal,
              })
            : await resolveAgentCompositionThroughPluginHooks({
                sessionId: params.session.sessionId,
                agentId: params.policyAgentId,
                runtimeFamily: 'hostSession',
                machineId: params.machineId,
                featureIds: executionRunsFeatureEnabled ? ['execution.runs'] : [],
                signal,
              });
          return {
            managedPluginIds: composition.managedPluginIds,
            selectedTools: composition.selectedTools,
            selectedToolBindings: composition.selectedToolBindings,
            prompt: resolveAgentCompositionPromptText(composition),
          };
        } catch (error) {
          if (signal.aborted) throw error;
          logger.debug('[plugins] Agent composition unavailable; retaining the static prompt contribution path', {
            error: 'agent_composition_unavailable',
          });
          return {
            managedPluginIds: Object.freeze([]),
            selectedTools: Object.freeze([]),
            selectedToolBindings: Object.freeze([]),
            prompt: null,
          };
        }
      },
      transformAgentContextBeforeDispatch: daemonTurnContributionsBridge
        ? async (payload) => await daemonTurnContributionsBridge
            .transformAgentContext({
              sessionId: params.session.sessionId,
              payload,
              signal: abortController.signal,
            })
        : transformAgentContextThroughPluginHooks,
      transformAgentContextErrorPolicy: daemonTurnContributionsBridge
        ? 'throw'
        : 'fallback',
      transitionModelSelectionBeforePrompt: async (
        selection,
        runWithActiveSelection,
      ) =>
        await params.transitionModelSelection(
          selection,
          'prompt',
          runWithActiveSelection,
        ),
      ...(params.readActiveModelSelection
        ? { readActiveModelSelection: params.readActiveModelSelection }
        : {}),
      ...(params.onProviderPromptDispatchPrepared
        ? { onProviderPromptDispatchPrepared: params.onProviderPromptDispatchPrepared }
        : {}),
      onBeforeReset: params.config.lifecycleHooks?.onBeforeReset
        ? (loopParams) => params.config.lifecycleHooks?.onBeforeReset?.({ ...loopParams, session: params.session, runtime: hookRuntimeForCallbacks })
        : undefined,
      onAfterStart: params.config.onAfterStart ? () => params.config.onAfterStart?.({ session: params.session, runtime: hookRuntimeForCallbacks }) : undefined,
      onAfterReset:
        params.config.lifecycleHooks?.onAfterReset || params.config.onAfterReset
          ? async (loopParams) => {
              await params.config.lifecycleHooks?.onAfterReset?.({ ...loopParams, session: params.session, runtime: hookRuntimeForCallbacks });
              await params.config.onAfterReset?.({ session: params.session, runtime: hookRuntimeForCallbacks });
            }
          : undefined,
      onAfterLoopBoundary:
        async (loopParams) => {
          await drainRuntimeTranscriptProjections();
          await flushCapabilitiesAfterSettlement(lastCapabilitySettledTurnId);
          await params.sessionSwapStrategy.flushPendingSessionSwap?.();
          await params.config.lifecycleHooks?.onAfterLoopBoundary?.({ ...loopParams, session: params.session, runtime: hookRuntimeForCallbacks });
        },
      checkpointLifecycle: checkpointLifecycle ? {
        ...checkpointLifecycle,
        onTurnFinal: async (input) => {
          // Native terminal projection normally finalizes the combined card. Drain it
          // before the prompt-loop fallback so cleanup cannot publish it a second time.
          await drainRuntimeTranscriptProjections();
          await checkpointLifecycle.onTurnFinal?.(input);
        },
      } : null,
      beforePendingMaterialize,
      formatPromptErrorMessage: params.config.formatPromptErrorMessage,
    });
  } catch (error) {
    promptLoopError = error;
    closeFailedSession = true;
    throw error;
  } finally {
    terminationHandlers.dispose();
    shouldExit = true;
    abortController.abort();
    await readCapabilityOverrideSync()?.dispose?.();
    const activeRunnerTerminationWork = runnerTerminationWork;
    if (activeRunnerTerminationWork) {
      await activeRunnerTerminationWork;
    } else {
      try {
        if (terminalProcessExited) {
          // Publish unresolved native input custody while Pending settlement
          // still has the Session transport. Physical exit does not prove
          // whether the native process accepted an in-flight input.
          try {
            await disposeRuntimeOnce('session_closed');
          } finally {
            await onBeforeSessionClose?.({
              session: params.session,
              runtime: hookRuntimeForCallbacks,
            });
            await endSessionAfterProcessExit(terminalProcessExitedCleanly);
          }
        }
      } finally {
        await cleanupOnce();
      }
    }
    await terminalRemoteModeLoopPromise;
    if (!promptLoopError && terminalRemoteModeLoopError) {
      throw terminalRemoteModeLoopError;
    }
  }
}
