import { randomUUID } from 'node:crypto';

import { resolveRuntimeCheckpointToolProtocol } from '@happier-dev/agents/session/controls/checkpoints';
import {
  buildBackendTargetKeyV2,
  readBackendTargetRefV2,
  RuntimeEventV1Schema,
  validatePluginHookPayloadV1,
  type RuntimeEventV1,
  type ProviderBoundModelRef,
  type SessionModelTransitionResultV1,
  type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';
import { render } from 'ink';
import React from 'react';

import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { RuntimeSessionTurnMutationV1 } from '@/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { isTerminalSessionTurnMutationAction } from '@/api/session/sessionTurnStatusSnapshot';
import type { Metadata, PermissionMode } from '@/api/types';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import {
  createRuntimeOverrideSynchronizers,
  type RuntimeOverrideSynchronizers,
  type RuntimeOverrideTarget,
} from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import {
  runPermissionModePromptLoop,
  type PromptLoopPermissionHandler,
  type PermissionModePromptLoopTurnOperations,
  type PromptLoopOverrideSynchronizer,
  type PromptLoopBoundaryReason,
  type PromptLoopResetReason,
} from '@/agent/runtime/runPermissionModePromptLoop';
import { createReadyNotificationDispatcher } from '@/agent/runtime/notifications/createReadyNotificationDispatcher';
import { sendReadyWithPushNotification } from '@/agent/runtime/notifications/sendReadyWithPushNotification';
import { resetAssistantTextSnapshotTurnScope } from '@/agent/runtime/turns/assistantTextSnapshotTurnScope';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import type { InFlightSteerController } from '@/agent/runtime/permissions/bindModeQueue';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  resolveRemoteModeControlSurface,
  startRemoteModeStaticControl,
  type RemoteModeStaticControl,
} from '@/ui/remoteControl/remoteModeControl';
import { logger } from '@/ui/logger';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { resolveTerminationArchiveDecision } from '@/agent/runtime/lifecycle/terminationArchivePolicy';
import { createRepositoryCheckpointPromptLifecycle } from '@/agent/runtime/checkpoints/repositoryCheckpointPromptLifecycle';
import { archiveAndCloseRuntimeSession } from '@/session/services/archiveAndCloseSession';
import { createSessionMetadataShutdownDeadline } from '@/session/services/sessionMetadataShutdownDeadline';
import { notifyDaemonConnectedServiceTurnLifecycle } from '@/daemon/controlClient';
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
import { publishTerminalPendingHandoffState } from '@/agent/runtime/mode/switching/publishTerminalPendingHandoffState';
import { createTerminalTurnStateMachine } from '@/agent/runtime/terminal/turnStateMachine';
import { mapRuntimeMessageToTerminalLifecycleObservation } from '@/agent/runtime/terminal/runtimeMessageObservationAdapter';
import {
  requestExplicitRunnerStop,
  resolveRunnerRuntimeDisposalReason,
} from './runnerRuntimeDisposal';
import {
  createSessionTurnLifecycle,
  observeRuntimeMessageForSessionTurnLifecycle,
} from '@/agent/runtime/session/turn/lifecycle';
import {
  projectRuntimeTranscriptEvent,
  readRuntimeMessageDeltaText,
} from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import {
  observeAgentStreamTokenThroughPluginHooks,
  resolvePluginPromptAssetBlocks,
  resolvePluginToolPromptContributions,
  transformAgentContextThroughPluginHooks,
} from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import {
  tryCreateDaemonAgentRuntimeTurnContributionsBridge,
  type DaemonAgentRuntimeTurnContributionsBridge,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeClient';
import type {
  HostSessionRuntimeConfig,
  HostSessionRuntimeDeps,
  HostSessionKeepAliveMode,
  HostSessionRuntimeHookRuntime,
  HostSessionRuntimeLoopApi,
  HostSessionRuntimeRunOptions,
  HostSessionRuntimeSessionSwapStrategy,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type {
  RuntimeTurnDisposeReason,
  RuntimeTurnOperations,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import { RemoteOnlyTerminalDisplay, type RemoteOnlyTerminalDisplayProps } from './display';
import { resolveStartingMode } from './resolveStartingMode';
import { runTerminalRemoteSessionModeLoop, type TerminalRemoteSessionMode } from './runTerminalRemoteSessionModeLoop';
import type {
  HostSessionTerminalRemoteHandoffReason,
  HostSessionTerminalRemoteHandoffResult,
  HostSessionTerminalRemoteModeLoop,
} from './terminalRemoteModeRuntime';
import { configuration } from '@/configuration';

export const HOST_SESSION_RUNTIME_PLAN_KIND = 'hostSessionRuntimePlan' as const;

const KEEP_ALIVE_DUPLICATE_SUPPRESSION_MS = 100;
const DEFAULT_RUNTIME_TRANSCRIPT_PROJECTION_DRAIN_TIMEOUT_MS = 5_000;

type RuntimeTranscriptAgentCommitEvent = Extract<RuntimeEventV1, { kind: 'transcript-agent-message-committed' }>;
type RuntimeTurnFailedEvent = Extract<RuntimeEventV1, { kind: 'turn-failed' }>;

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readMessageBodyType(body: unknown): string | null {
  const record = readObject(body);
  const type = record?.type;
  return typeof type === 'string' && type.trim().length > 0 ? type.trim() : null;
}

function readLifecycleMarkerId(event: RuntimeTranscriptAgentCommitEvent): string | null {
  if (readMessageBodyType(event.body) !== 'turn_failed') return null;
  const id = readObject(event.body)?.id;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

function isVisibleAssistantMessage(event: RuntimeTranscriptAgentCommitEvent): boolean {
  if (readMessageBodyType(event.body) !== 'message') return false;
  const message = readObject(event.body)?.message;
  return typeof message === 'string' && message.trim().length > 0;
}

function normalizeAcpProvider(value: string | null | undefined, fallback: string): ACPProvider {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length > 0) return normalized as ACPProvider;
  const fallbackNormalized = fallback.trim();
  return (fallbackNormalized.length > 0 ? fallbackNormalized : 'agent') as ACPProvider;
}

function formatRuntimeIssueTranscriptMessage(issue: SessionRuntimeIssueV1, fallbackProviderName: string): string {
  const providerLabel = issue.agentId?.trim() || fallbackProviderName.trim() || 'Agent';
  const detail = issue.sanitizedPreview?.trim() || issue.code.trim() || issue.source;
  if (issue.source === 'permission_blocked') return detail;
  return `${providerLabel} turn failed: ${detail}`;
}

function buildRuntimeIssueTranscriptMeta(issue: SessionRuntimeIssueV1): Record<string, unknown> {
  return {
    source: 'runtime',
    runtimeIssueCode: issue.code,
    runtimeIssueSource: issue.source,
    ...(issue.agentId ? { runtimeIssueProvider: issue.agentId } : {}),
    ...(issue.agentTurnId ? { runtimeIssueProviderTurnId: issue.agentTurnId } : {}),
  };
}

function shouldAlwaysProjectRuntimeIssueDiagnostic(issue: SessionRuntimeIssueV1): boolean {
  return issue.source === 'permission_blocked';
}

function createRuntimeFailureTranscriptProjector(params: Readonly<{
  session: ApiSessionClient;
  provider: ACPProvider;
  providerName: string;
}>): (event: RuntimeEventV1) => Promise<void> | null {
  let activeTurnId: string | null = null;
  const visibleAssistantTurnIds = new Set<string>();
  const projectedDiagnosticTurnIds = new Set<string>();
  const projectedLifecycleMarkerTurnIds = new Set<string>();

  return (event) => {
    if (event.sessionId !== params.session.sessionId) return null;

    if (event.kind === 'turn-start') {
      activeTurnId = event.turnId;
      return null;
    }

    if (event.kind === 'transcript-agent-message-committed') {
      if (activeTurnId && isVisibleAssistantMessage(event)) {
        visibleAssistantTurnIds.add(activeTurnId);
      }
      const markerTurnId = readLifecycleMarkerId(event);
      if (markerTurnId) {
        projectedLifecycleMarkerTurnIds.add(markerTurnId);
      }
      return null;
    }

    if (event.kind === 'message-delta') {
      if (readRuntimeMessageDeltaText(event.delta) !== null) {
        visibleAssistantTurnIds.add(event.turnId);
      }
      return null;
    }

    if (event.kind !== 'turn-failed') {
      return null;
    }

    if (activeTurnId === event.turnId) {
      activeTurnId = null;
    }

    return projectRuntimeFailureTranscript({
      session: params.session,
      provider: normalizeAcpProvider(event.issue.agentId, params.provider),
      providerName: params.providerName,
      event,
      shouldProjectDiagnostic:
        (!visibleAssistantTurnIds.has(event.turnId) || shouldAlwaysProjectRuntimeIssueDiagnostic(event.issue))
        && !projectedDiagnosticTurnIds.has(event.turnId),
      shouldProjectLifecycleMarker: !projectedLifecycleMarkerTurnIds.has(event.turnId),
      markDiagnosticProjected: () => projectedDiagnosticTurnIds.add(event.turnId),
      markLifecycleMarkerProjected: () => projectedLifecycleMarkerTurnIds.add(event.turnId),
    });
  };
}

async function projectRuntimeFailureTranscript(params: Readonly<{
  session: ApiSessionClient;
  provider: ACPProvider;
  providerName: string;
  event: RuntimeTurnFailedEvent;
  shouldProjectDiagnostic: boolean;
  shouldProjectLifecycleMarker: boolean;
  markDiagnosticProjected: () => void;
  markLifecycleMarkerProjected: () => void;
}>): Promise<void> {
  const meta = buildRuntimeIssueTranscriptMeta(params.event.issue);
  if (params.shouldProjectDiagnostic) {
    params.markDiagnosticProjected();
    await params.session.enqueueAgentMessageCommitted(
      params.provider,
      {
        type: 'message',
        message: formatRuntimeIssueTranscriptMessage(params.event.issue, params.providerName),
      } satisfies ACPMessageData,
      {
        localId: `${params.event.turnId}:runtime_issue`,
        meta,
        provenance: { kind: 'non_dependent', source: 'background' },
      },
    );
  }
  if (params.shouldProjectLifecycleMarker) {
    params.markLifecycleMarkerProjected();
    await params.session.enqueueAgentMessageCommitted(
      params.provider,
      { type: 'turn_failed', id: params.event.turnId } satisfies ACPMessageData,
      {
        localId: `${params.event.turnId}:turn_failed`,
        meta,
        provenance: { kind: 'non_dependent', source: 'background' },
      },
    );
  }
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
  cleanupBackendRunResourcesFn?: typeof cleanupBackendRunResources;
  createRuntimeOverrideSynchronizersFn?: typeof createRuntimeOverrideSynchronizers;
  runPermissionModePromptLoopFn?: typeof runPermissionModePromptLoop;
  observeAgentStreamToken?: (payload: Record<string, unknown>) => void | Promise<void>;
  notifyDaemonConnectedServiceTurnLifecycleFn?: typeof notifyDaemonConnectedServiceTurnLifecycle;
  registerRunnerTerminationHandlersFn?: typeof registerRunnerTerminationHandlers;
  sendReadyWithPushNotificationFn?: typeof sendReadyWithPushNotification;
  archiveAndCloseRuntimeSessionFn?: typeof archiveAndCloseRuntimeSession;
  registerKillSessionHandlerFn?: typeof registerKillSessionHandler;
  renderFn?: typeof render;
  startRemoteModeStaticControlFn?: typeof startRemoteModeStaticControl;
  runTerminalRemoteSessionModeLoopFn?: typeof runTerminalRemoteSessionModeLoop;
  onBeforeSessionClose?: (params: Readonly<{
    session: ApiSessionClient;
    runtime: HostSessionRuntimeHookRuntime;
  }>) => void | Promise<void>;
  remoteOnlyTerminalDisplayComponent?: React.ComponentType<RemoteOnlyTerminalDisplayProps>;
  runtimeTranscriptProjectionDrainTimeoutMs?: number;
}>;

function readStreamKindFromRuntimeDelta(delta: unknown): 'assistant' | 'thinking' | 'unknown' {
  const record = readObject(delta);
  if (!record) {
    return 'unknown';
  }
  return record.thinking === true ? 'thinking' : 'assistant';
}

async function observeAgentStreamTokenEvent(params: Readonly<{
  event: RuntimeEventV1;
  agentId: string;
  observeAgentStreamToken?: (payload: Record<string, unknown>) => void | Promise<void>;
  uiLogPrefix: string;
}>): Promise<void> {
  if (!params.observeAgentStreamToken || params.event.kind !== 'message-delta') {
    return;
  }
  const tokenText = readRuntimeMessageDeltaText(params.event.delta);
  if (tokenText === null) {
    return;
  }
  const payload = {
    sessionId: params.event.sessionId,
    agentId: params.agentId,
    runtimeFamily: 'hostSession',
    turnId: params.event.turnId,
    tokenText,
    streamKind: readStreamKindFromRuntimeDelta(params.event.delta),
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
  opts: HostSessionRuntimeRunOptions;
  config: HostSessionRuntimeConfig;
  api: HostSessionRuntimeLoopApi;
  session: ApiSessionClient;
  runtime: RuntimeTurnOperations;
  hookRuntime?: HostSessionRuntimeHookRuntime | null;
  terminalRemoteModeLoop?: HostSessionTerminalRemoteModeLoop | null;
  messageBuffer: MessageBuffer;
  permissionHandler: PromptLoopPermissionHandler;
  permissionModeState: Readonly<{
    rebindSession: (session: ApiSessionClient) => void;
    getCurrentPermissionMode: () => PermissionMode | undefined;
    getCurrentPermissionModeUpdatedAt: () => number;
    setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
    setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
    messageQueue: MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  }>;
  sessionSwapStrategy: HostSessionRuntimeSessionSwapStrategy;
  runtimeDirectory: string;
  runtimeMetadata: Metadata;
  machineId: string;
  memoryRecallGuidanceEnabled: boolean;
  policyAgentId: string;
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
  setAbortRequestedCallback: (callback: (() => void | Promise<void>) | null) => void;
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
  onProviderPromptDispatchPrepared?: (input: Readonly<{
    localIds: readonly string[];
    selection: ProviderBoundModelRef;
  }>) => void;
  deps: SessionLoopLifecycleDeps;
  initialResumeId: string;
}>;

export async function runSessionLoopLifecycle(params: SessionLoopLifecycleParams): Promise<void> {
  const cleanupBackendRunResourcesFn = params.deps.cleanupBackendRunResourcesFn ?? cleanupBackendRunResources;
  const createRuntimeOverrideSynchronizersFn = params.deps.createRuntimeOverrideSynchronizersFn ?? createRuntimeOverrideSynchronizers;
  const runPermissionModePromptLoopFn = params.deps.runPermissionModePromptLoopFn ?? runPermissionModePromptLoop;
  const registerRunnerTerminationHandlersFn = params.deps.registerRunnerTerminationHandlersFn ?? registerRunnerTerminationHandlers;
  const sendReadyWithPushNotificationFn = params.deps.sendReadyWithPushNotificationFn;
  const archiveAndCloseRuntimeSessionFn = params.deps.archiveAndCloseRuntimeSessionFn ?? archiveAndCloseRuntimeSession;
  const registerKillSessionHandlerFn = params.deps.registerKillSessionHandlerFn ?? registerKillSessionHandler;
  const renderFn = params.deps.renderFn ?? render;
  const startRemoteModeStaticControlFn = params.deps.startRemoteModeStaticControlFn ?? startRemoteModeStaticControl;
  const runTerminalRemoteSessionModeLoopFn = params.deps.runTerminalRemoteSessionModeLoopFn ?? runTerminalRemoteSessionModeLoop;
  const onBeforeSessionClose = params.deps.onBeforeSessionClose;
  const runtimeTranscriptProjectionDrainTimeoutMs =
    typeof params.deps.runtimeTranscriptProjectionDrainTimeoutMs === 'number'
    && Number.isFinite(params.deps.runtimeTranscriptProjectionDrainTimeoutMs)
    && params.deps.runtimeTranscriptProjectionDrainTimeoutMs >= 0
      ? params.deps.runtimeTranscriptProjectionDrainTimeoutMs
      : DEFAULT_RUNTIME_TRANSCRIPT_PROJECTION_DRAIN_TIMEOUT_MS;
  const notifyDaemonConnectedServiceTurnLifecycleFn =
    params.deps.notifyDaemonConnectedServiceTurnLifecycleFn ?? notifyDaemonConnectedServiceTurnLifecycle;
  const daemonTurnContributionsBridge =
    params.deps.daemonTurnContributionsBridge
    ?? tryCreateDaemonAgentRuntimeTurnContributionsBridge();
  const observeAgentStreamToken = params.deps.observeAgentStreamToken
    ?? (daemonTurnContributionsBridge
      ? undefined
      : observeAgentStreamTokenThroughPluginHooks);
  const RemoteOnlyTerminalDisplayComponent = params.deps.remoteOnlyTerminalDisplayComponent ?? RemoteOnlyTerminalDisplay;

  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  const shouldRenderTerminalDisplay = params.config.shouldRenderTerminalDisplay?.({ opts: params.opts, session: params.session, metadata: params.runtimeMetadata }) ?? true;
  const remoteControlSurface = resolveRemoteModeControlSurface({
    stdoutIsTTY: process.stdout.isTTY,
    stdinIsTTY: process.stdin.isTTY,
    startedBy: params.opts.startedBy,
    terminalMode: params.opts.terminalRuntime?.mode ?? null,
  });
  const toolDelivery = resolveAgentToolsDelivery(params.policyAgentId);
  const hookRuntime = params.hookRuntime ?? null;
  const hookRuntimeForCallbacks: HostSessionRuntimeHookRuntime = hookRuntime ?? params.runtime;
  const runtimeForPromptLoop: PermissionModePromptLoopTurnOperations = hookRuntimeForCallbacks;
  const configuredCheckpointLifecycle = await params.config.lifecycleHooks?.createCheckpointLifecycle?.({
    session: params.session,
    runtime: hookRuntimeForCallbacks,
    runtimeDirectory: params.runtimeDirectory,
    policyAgentId: params.policyAgentId,
  }) ?? null;
  const checkpointLifecycle = configuredCheckpointLifecycle ?? createRepositoryCheckpointPromptLifecycle({
    session: params.session,
    runtimeDirectory: params.runtimeDirectory,
    provider: params.config.agentMessageType,
    protocol: resolveRuntimeCheckpointToolProtocol(params.config.checkpointToolProtocol),
  });
  const terminalRemoteModeLoop = params.terminalRemoteModeLoop ?? null;
  const resolvedStartingMode = resolveStartingMode({
    terminalCapable: terminalRemoteModeLoop !== null,
    userIntent: (params.opts as Readonly<{ startingMode?: unknown }>).startingMode,
    providerHint: terminalRemoteModeLoop?.startingMode,
  });
  const terminalTurnStateMachine = createTerminalTurnStateMachine();
  const pendingRuntimeTranscriptProjections = new Set<Promise<void>>();
  const trackRuntimeTranscriptProjection = (projection: Promise<void>): void => {
    pendingRuntimeTranscriptProjections.add(projection);
    const removeSettledProjection = (): void => {
      pendingRuntimeTranscriptProjections.delete(projection);
    };
    void projection.then(removeSettledProjection, removeSettledProjection);
  };
  const waitForRuntimeTranscriptProjectionBatch = async (
    projections: readonly Promise<void>[],
    reason: string,
  ): Promise<void> => {
    if (projections.length === 0) return;
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), runtimeTranscriptProjectionDrainTimeoutMs);
      timeout.unref?.();
    });
    const outcome = await Promise.race([
      Promise.allSettled(projections).then(() => 'settled' as const),
      timeoutPromise,
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome !== 'timeout') return;

    for (const projection of projections) {
      pendingRuntimeTranscriptProjections.delete(projection);
    }
    logger.debug(`${params.config.uiLogPrefix} Runtime transcript projection drain timed out (non-fatal)`, {
      reason,
      pendingCount: projections.length,
      timeoutMs: runtimeTranscriptProjectionDrainTimeoutMs,
    });
  };
  const drainRuntimeTranscriptProjections = async (reason: string): Promise<void> => {
    while (pendingRuntimeTranscriptProjections.size > 0) {
      await waitForRuntimeTranscriptProjectionBatch([...pendingRuntimeTranscriptProjections], reason);
    }
  };
  const enqueueSessionTurnMutation = (mutation: RuntimeSessionTurnMutationV1): void | Promise<void> => {
    if (!isTerminalSessionTurnMutationAction(mutation.action)) {
      return params.session.enqueueSessionTurnMutation?.(mutation);
    }
    const projectionsBeforeTerminalMutation = [...pendingRuntimeTranscriptProjections];
    const terminalMutation = waitForRuntimeTranscriptProjectionBatch(
      projectionsBeforeTerminalMutation,
      'terminal_turn_mutation',
    ).then(async () => {
      try {
        await params.session.enqueueSessionTurnMutation?.(mutation);
      } catch (error) {
        logger.debug(`${params.config.uiLogPrefix} Runtime terminal turn mutation failed`, {
          error: 'runtime_terminal_turn_mutation_failed',
          action: mutation.action,
        });
        throw error;
      }
    });
    trackRuntimeTranscriptProjection(terminalMutation);
    return terminalMutation;
  };
  const sessionTurnLifecycle = createSessionTurnLifecycle({
    session: {
      get sessionId() {
        return params.session.sessionId;
      },
      enqueueSessionTurnMutation,
    },
    agentId: params.policyAgentId,
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
            if (response?.status !== 'recorded' || turnCustody?.status !== 'recorded') {
              throw new Error('Daemon did not record exact turn marker custody');
            }
          },
        }
      : {}),
  });
  const runtimeTranscriptProvider = normalizeAcpProvider(params.config.agentMessageType, 'agent');
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
  const observeRuntimeLifecycleMessage = (message: unknown): void => {
    const parsedRuntimeEvent = RuntimeEventV1Schema.safeParse(message);
    const transcriptProjection = runtimeTranscriptProjectionSerial.then(async () => {
      let transcriptProjectionError: unknown = null;
      try {
        await projectRuntimeTranscriptEvent({
          session: params.session,
          provider: runtimeTranscriptProvider,
          runtimeMessageDeltaBridge,
          event: message,
        });
      } catch (error) {
        transcriptProjectionError = error;
      }
      if (parsedRuntimeEvent.success) {
        await observeAgentStreamTokenEvent({
          event: parsedRuntimeEvent.data,
          agentId: params.policyAgentId,
          observeAgentStreamToken,
          uiLogPrefix: params.config.uiLogPrefix,
        });
        await runtimeFailureTranscriptProjector(parsedRuntimeEvent.data);
      }
      if (transcriptProjectionError) {
        throw transcriptProjectionError;
      }
    });
    const loggedTranscriptProjection = transcriptProjection.then(
      () => undefined,
      () => {
        logger.debug(`${params.config.uiLogPrefix} Runtime transcript projection failed (non-fatal)`, {
          error: 'runtime_transcript_projection_failed',
          eventKind: parsedRuntimeEvent.success ? parsedRuntimeEvent.data.kind : 'invalid',
        });
      },
    );
    trackRuntimeTranscriptProjection(loggedTranscriptProjection);
    runtimeTranscriptProjectionSerial = waitForRuntimeTranscriptProjectionBatch(
      [loggedTranscriptProjection],
      'runtime_transcript_projection_serial',
    );
    observeRuntimeMessageForSessionTurnLifecycle({
      lifecycle: sessionTurnLifecycle,
      message,
    });
    const observation = mapRuntimeMessageToTerminalLifecycleObservation({
      agentId: params.policyAgentId,
      message,
    });
    if (observation) {
      terminalHandoffFailureRequiresManualAction = false;
      terminalTurnStateMachine.observe(observation);
    }
  };
  const unsubscribeRuntimeEvents = (() => {
    try {
      return runtimeForPromptLoop.subscribeRuntimeEvents(observeRuntimeLifecycleMessage);
    } catch {
      logger.debug(`${params.config.uiLogPrefix} Failed to subscribe to terminal lifecycle messages (non-fatal)`, {
        error: 'runtime_lifecycle_subscription_failed',
      });
      return () => undefined;
    }
  })();
  const runtimeOverrideTarget: RuntimeOverrideTarget = {
    setSessionMode: async (modeId) => {
      await runtimeForPromptLoop.updateSessionRuntimeConfig({ modeId });
    },
    setSessionModelSelection: async (selection) => {
      const result = await params.transitionModelSelection(selection, 'metadata');
      if (!result.ok) {
        throw new Error(result.reason ?? `Session model transition failed: ${result.status}`);
      }
    },
    setPermissionMode: async (permissionMode) => {
      return await runtimeForPromptLoop.updateSessionRuntimeConfig({ permissionMode });
    },
    setSessionConfigOption: async (configId, value) => {
      return await runtimeForPromptLoop.updateSessionRuntimeConfig({ configOption: { id: configId, value } });
    },
  };
  const resolveToolDeliverySessionId = (): string | null =>
    toolDelivery === 'shell_bridge' ? params.session.sessionId : runtimeForPromptLoop.readSessionIdentity().sessionId;
  const promptArtifactBodyCache = new Map<string, string | null>();
  const runtimeForInFlightSteer: { current: RuntimeTurnOperations | null } = { current: runtimeForPromptLoop };
  let shouldExit = false;
  let abortController = new AbortController();
  let cleanupPromise: Promise<void> | null = null;
  let runnerTerminationWork: Promise<void> | null = null;
  let runtimeDisposeReason: RuntimeTurnDisposeReason = 'runtime_recovery';
  let startupCoordinatorStarted = false;

  const startStartupCoordinator = async (): Promise<void> => {
    if (startupCoordinatorStarted) return;
    if (!params.startupCoordinator?.start) return;
    startupCoordinatorStarted = true;
    await params.startupCoordinator.start();
  };

  const handleAbort = async () => {
    logger.debug(`${params.config.uiLogPrefix} Abort requested`);
    resetAssistantTextSnapshotTurnScope(params.session, 'abort');
    params.session.sendAgentMessage(params.config.agentMessageType, { type: 'turn_cancelled', id: randomUUID() });
    await params.permissionHandler.reset();
    try {
      abortController.abort();
      abortController = new AbortController();
      await runtimeForPromptLoop.cancelTurn();
    } catch {
      logger.debug(`${params.config.uiLogPrefix} Failed to cancel current operation (non-fatal)`, {
        error: 'runtime_cancel_failed',
      });
    }
  };
  params.setAbortRequestedCallback(handleAbort);
  const retireDaemonAgentRuntimeCarrierHost = () => {
    params.startupCoordinator?.cancel?.();
    // This host cannot deliver another prompt after its daemon-scoped carrier is retired.
    // End the local lifecycle so normal cleanup marks it unavailable for a successor host.
    shouldExit = true;
    abortController.abort('daemon-agent-runtime-carrier-retired');
  };
  const daemonAgentRuntimeCarrierRetirementSignal =
    params.config.daemonAgentRuntimeCarrierRetirementSignal;
  if (daemonAgentRuntimeCarrierRetirementSignal?.aborted) {
    retireDaemonAgentRuntimeCarrierHost();
  } else {
    daemonAgentRuntimeCarrierRetirementSignal?.addEventListener(
      'abort',
      retireDaemonAgentRuntimeCarrierHost,
      { once: true },
    );
  }
  const unsubscribeDaemonAgentRuntimeCarrierRetirement = () => {
    daemonAgentRuntimeCarrierRetirementSignal?.removeEventListener(
      'abort',
      retireDaemonAgentRuntimeCarrierHost,
    );
  };

  let inkInstance: ReturnType<typeof render> | null = null;
  let staticControl: RemoteModeStaticControl | null = null;
  const requestTerminalExit = async (): Promise<void> => {
    terminationHandlers.requestTermination({
      kind: 'signal',
      signal: 'SIGINT',
    });
    await terminationHandlers.whenTerminated;
  };
  const mountTerminalDisplay = (): void => {
    if (!hasTTY || inkInstance || staticControl) return;
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
    console.clear();
    const displayProps = {
      messageBuffer: params.messageBuffer,
      logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
      onExit: requestTerminalExit,
    };
    const displayElement = shouldMountRemoteOnlyTerminalDisplay
      ? React.createElement(RemoteOnlyTerminalDisplayComponent, {
          ...displayProps,
          backendDisplayName: params.config.backendDisplayName,
          requestedMode: resolvedStartingMode.requestedMode,
        })
      : React.createElement(params.config.terminalDisplay, displayProps);
    inkInstance = renderFn(displayElement, { exitOnCtrlC: false, patchConsole: false });
  };
  const unmountTerminalDisplay = async (): Promise<void> => {
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

  const getKeepAliveMode = (): HostSessionKeepAliveMode => params.config.resolveKeepAliveMode?.() ?? 'remote';
  let lastKeepAliveSentAt = 0;
  let lastKeepAliveSignature: string | null = null;
  const publishKeepAlive = (): void => {
    const now = Date.now();
    const mode = getKeepAliveMode() === 'terminal' ? 'local' : 'remote';
    const signature = `${params.session.sessionId}:${params.runtimeState.thinking ? 'thinking' : 'idle'}:${mode}`;
    if (lastKeepAliveSignature === signature && now - lastKeepAliveSentAt < KEEP_ALIVE_DUPLICATE_SUPPRESSION_MS) return;
    params.session.keepAlive(params.runtimeState.thinking, mode);
    lastKeepAliveSignature = signature;
    lastKeepAliveSentAt = now;
  };
  const setThinkingState = (value: boolean): void => {
    if (params.runtimeState.thinking === value) return;
    params.runtimeState.thinking = value;
    publishKeepAlive();
  };
  publishKeepAlive();
  const keepAliveTickIntervalMs = Math.min(configuration.sessionKeepAliveIdleMs, configuration.sessionKeepAliveThinkingMs);
  const keepAliveInterval = setInterval(() => {
    const cadenceMs = params.runtimeState.thinking
      ? configuration.sessionKeepAliveThinkingMs
      : configuration.sessionKeepAliveIdleMs;
    if (Date.now() - lastKeepAliveSentAt >= cadenceMs) {
      publishKeepAlive();
    }
  }, keepAliveTickIntervalMs);
  keepAliveInterval.unref?.();

  const cleanupOnce = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      unsubscribeRuntimeEvents();
      unsubscribeDaemonAgentRuntimeCarrierRetirement();
      await drainRuntimeTranscriptProjections('cleanup');
      await sessionTurnLifecycle.drainAcceptedLifecycle();
      await params.config.lifecycleHooks?.onBeforeDispose?.({ session: params.session, runtime: hookRuntimeForCallbacks });
      await cleanupBackendRunResourcesFn({
        keepAliveInterval,
        reconnectionHandle: params.reconnectionHandle,
        stopMcpServer: () => params.happyMcpServerStop(),
        resetRuntime: () => runtimeForPromptLoop.resetOrDisposeRuntime(runtimeDisposeReason),
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
    sessionExitReport: { sessionId: params.session.sessionId },
    onTerminate: (event, outcome) => {
      const work = (async () => {
        runtimeDisposeReason = resolveRunnerRuntimeDisposalReason(event);
        shouldExit = true;
        await handleAbort();
        const archiveDecision = resolveTerminationArchiveDecision({
          startedBy: params.opts.startedBy,
          event,
          outcome,
        });
        try {
          await onBeforeSessionClose?.({
            session: params.session,
            runtime: hookRuntimeForCallbacks,
          });
          if (archiveDecision.archive) {
            const metadataDeadline = createSessionMetadataShutdownDeadline();
            await params.config.lifecycleHooks?.onBeforeArchive?.({
              session: params.session,
              runtime: hookRuntimeForCallbacks,
              metadataTimeoutMs: metadataDeadline.remainingMs(),
            });
            await archiveAndCloseRuntimeSessionFn(params.session, params.opts.credentials, archiveDecision.archiveReason, {
              metadataTimeoutMs: metadataDeadline.remainingMs(),
            });
          } else {
            await params.session.close();
          }
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

  params.session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandlerFn(params.session.rpcHandlerManager, async () => {
    logger.debug(`${params.config.uiLogPrefix} Kill session requested`);
    await requestExplicitRunnerStop({
      abortActiveTurn: handleAbort,
      disposeRuntime: (reason) => runtimeForPromptLoop.resetOrDisposeRuntime(reason),
      requestTermination: terminationHandlers.requestTermination,
      whenTerminated: terminationHandlers.whenTerminated,
    });
  });

  if (hasTTY && shouldRenderTerminalDisplay) {
    mountTerminalDisplay();
  }

  if (!shouldExit) {
    try {
      await startStartupCoordinator();
    } catch (error) {
      terminationHandlers.dispose();
      shouldExit = true;
      abortController.abort();
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

  const initialResumeId = params.initialResumeId.trim();
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
  const publishTerminalHandoffFailure = (pendingCount: number, detail?: string): void => {
    publishTerminalPendingHandoffState({
      session: params.session,
      status: {
        v: 1,
        status: 'switch_failed',
        pendingCount,
        updatedAtMs: Date.now(),
        ...(detail && detail.trim().length > 0 ? { detail: detail.trim() } : {}),
      },
    });
  };
  const beforePendingMaterialize = async (): Promise<boolean> => {
    const decision = resolvePendingQueueHandoff({
      currentMode: activeTerminalRemoteMode,
      remoteTurnInFlight: sessionTurnLifecycle.hasActiveTurn(),
      terminalTopology: terminalRemoteModeLoop ? 'exclusive' : null,
      terminalTurnState: terminalTurnStateMachine.getState(),
      pendingCount: await resolvePendingCountForHandoff(),
      resumeReadiness: resolveResumeReadiness(),
      intent: 'queue',
      nowMs: Date.now(),
    });
    publishTerminalPendingHandoffState({
      session: params.session,
      status: decision.status,
    });
    if (decision.action.type === 'materialize_remote_pending') {
      terminalHandoffFailureRequiresManualAction = false;
      return true;
    }
    if (decision.action.type === 'request_graceful_remote_handoff') {
      if (terminalHandoffFailureRequiresManualAction) {
        publishTerminalPendingHandoffState({
          session: params.session,
          status: {
            v: 1,
            status: 'manual_action_required',
            pendingCount: decision.status.pendingCount,
            updatedAtMs: Date.now(),
            lastTerminalState: decision.status.lastTerminalState,
          },
        });
        return false;
      }
      const result = await requestGracefulRemoteHandoff(decision.action.reason);
      if (!result.ok) {
        terminalHandoffFailureRequiresManualAction = true;
        publishTerminalHandoffFailure(decision.status.pendingCount, result.detail);
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
        publishTerminalHandoffFailure(
          decision.status.pendingCount,
          'terminal_cancel_failed',
        );
        return false;
      }
      const result = await requestGracefulRemoteHandoff('switch_now');
      if (!result.ok) {
        terminalHandoffFailureRequiresManualAction = true;
        publishTerminalHandoffFailure(decision.status.pendingCount, result.detail);
      }
      return false;
    }
    return false;
  };
  let terminalRemoteModeLoopError: unknown = null;
  const terminalRemoteModeLoopPromise = terminalRemoteModeLoop && resolvedStartingMode.kind === 'switching'
    ? runTerminalRemoteSessionModeLoopFn({
        ...terminalRemoteModeLoop,
        startingMode: resolvedStartingMode.startingMode,
        onBeforeIteration: async (mode) => {
          activeTerminalRemoteMode = mode;
          await terminalRemoteModeLoop.onBeforeIteration?.(mode);
        },
        runTerminal: async (loopParams) => {
          const result = await terminalRemoteModeLoop.runTerminal(loopParams);
          if (result.type === 'exit') {
            terminalTurnStateMachine.observe({
              type: 'process_exited',
              agentId: params.policyAgentId,
              exitCode: result.code,
            });
          }
          return result;
        },
        runRemote: async () => {
          activeTerminalRemoteMode = 'remote';
          return await terminalRemoteModeLoop.runRemote();
        },
        onModeChange: async (mode) => {
          activeTerminalRemoteMode = mode;
          if (mode === 'remote') {
            terminalHandoffFailureRequiresManualAction = false;
          }
          await terminalRemoteModeLoop.onModeChange(mode);
        },
      }).catch((error: unknown) => {
        terminalRemoteModeLoopError = error;
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
      permissionHandler: params.permissionHandler,
      runtime: runtimeForPromptLoop,
      createOverrideSynchronizer: (isStarted): PromptLoopOverrideSynchronizer | RuntimeOverrideSynchronizers => createRuntimeOverrideSynchronizersFn({
        agentTargetKey: buildBackendTargetKeyV2(params.opts.backendTarget
          ? readBackendTargetRefV2(params.opts.backendTarget)
          : { kind: 'backend', backendId: params.policyAgentId, sourceKind: 'built_in' }),
        session: params.session,
        runtime: runtimeOverrideTarget,
        isStarted,
      }),
      messageBuffer: params.messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => publishKeepAlive(),
      setThinking: setThinkingState,
      sendReady: createSendReady,
      currentPermissionModeUpdatedAt: params.permissionModeState.getCurrentPermissionModeUpdatedAt(),
      setCurrentPermissionMode: params.permissionModeState.setCurrentPermissionMode,
      setCurrentPermissionModeUpdatedAt: params.permissionModeState.setCurrentPermissionModeUpdatedAt,
      initialResumeId: initialResumeId || undefined,
      strictInitialResume: initialResumeId.length > 0,
      startRuntimeBeforeFirstPrompt: params.config.startRuntimeBeforeFirstPrompt === true,
      pendingQueueDrainMaxPopPerWake: resolveSessionPendingQueueMaxPopPerWake(params.opts.accountSettingsContext?.settings ?? null),
      pendingQueueDeliveryTiming: resolveSessionPendingQueueDeliveryTiming(params.opts.accountSettingsContext?.settings ?? null),
      resolveFreshSessionSystemPrompt: async ({ baseOverride }) => {
        const executionRunsFeatureEnabled = resolveCliFeatureDecision({
          featureId: 'execution.runs',
          env: process.env,
        }).state === 'enabled';
        const promptContributions = daemonTurnContributionsBridge
          ? await daemonTurnContributionsBridge.resolvePrompt({
              sessionId: params.session.sessionId,
              machineId: params.machineId,
              featureIds: executionRunsFeatureEnabled ? ['execution.runs'] : [],
              signal: abortController.signal,
            })
          : {
              promptAssetBlocks: await resolvePluginPromptAssetBlocks({
                agentId: params.policyAgentId,
                sessionId: params.session.sessionId,
                machineId: params.machineId,
                featureIds: executionRunsFeatureEnabled ? ['execution.runs'] : [],
                signal: abortController.signal,
              }),
              toolPromptContributions:
                await resolvePluginToolPromptContributions(),
            };
        return await resolveEffectiveCodingPromptText({
          credentials: params.opts.credentials,
          settings: params.opts.accountSettingsContext?.settings ?? null,
          profileId: params.session.getMetadataSnapshot()?.profileId ?? null,
          baseOverride,
          executionRunsFeatureEnabled,
          agentId: params.policyAgentId,
          toolDelivery,
          toolDeliverySessionId: resolveToolDeliverySessionId(),
          toolDeliveryDirectory: params.runtimeDirectory,
          memoryMachineId: params.machineId,
          memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled,
          toolPromptContributions: promptContributions.toolPromptContributions,
          promptAssetBlocks: promptContributions.promptAssetBlocks,
          cache: promptArtifactBodyCache,
        });
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
          await drainRuntimeTranscriptProjections('loop_boundary');
          await params.sessionSwapStrategy.flushPendingSessionSwap?.();
          await params.config.lifecycleHooks?.onAfterLoopBoundary?.({ ...loopParams, session: params.session, runtime: hookRuntimeForCallbacks });
        },
      checkpointLifecycle,
      beforePendingMaterialize,
      formatPromptErrorMessage: params.config.formatPromptErrorMessage,
    });
  } catch (error) {
    promptLoopError = error;
    throw error;
  } finally {
    terminationHandlers.dispose();
    shouldExit = true;
    abortController.abort();
    const activeRunnerTerminationWork = runnerTerminationWork;
    if (activeRunnerTerminationWork) {
      await activeRunnerTerminationWork;
    } else {
      await cleanupOnce();
    }
    await terminalRemoteModeLoopPromise;
    if (!promptLoopError && terminalRemoteModeLoopError) {
      throw terminalRemoteModeLoopError;
    }
  }
}
