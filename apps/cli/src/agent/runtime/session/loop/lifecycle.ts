import { randomUUID } from 'node:crypto';

import { resolveRuntimeCheckpointToolProtocol } from '@happier-dev/agents/session/controls/checkpoints';
import { render } from 'ink';
import React from 'react';

import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/session/sessionClient';
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
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import { resolveSessionPendingQueueMaxPopPerWake } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import { resolvePendingQueueHandoff } from '@/agent/runtime/mode/switching/pendingQueueHandoffOrchestrator';
import { publishTerminalPendingHandoffState } from '@/agent/runtime/mode/switching/publishTerminalPendingHandoffState';
import { createTerminalTurnStateMachine } from '@/agent/runtime/terminal/turnStateMachine';
import { mapRuntimeMessageToTerminalLifecycleObservation } from '@/agent/runtime/terminal/runtimeMessageObservationAdapter';
import {
  createSessionTurnLifecycle,
  observeRuntimeMessageForSessionTurnLifecycle,
} from '@/agent/runtime/session/turn/lifecycle';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import type {
  HostSessionRuntimeConfig,
  HostSessionRuntimeDeps,
  HostSessionKeepAliveMode,
  HostSessionRuntimeHookRuntime,
  HostSessionRuntimeLoopApi,
  HostSessionRuntimeRunOptions,
  HostSessionRuntimeSessionSwapStrategy,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { RemoteOnlyTerminalDisplay, type RemoteOnlyTerminalDisplayProps } from './display';
import { resolveStartingMode } from './resolveStartingMode';
import { runTerminalRemoteSessionModeLoop, type TerminalRemoteSessionMode } from './runTerminalRemoteSessionModeLoop';
import {
  resolveHostSessionTerminalRemoteModeLoop,
  type HostSessionTerminalRemoteHandoffReason,
  type HostSessionTerminalRemoteHandoffResult,
} from './terminalRemoteModeRuntime';
import { configuration } from '@/configuration';

export const HOST_SESSION_RUNTIME_PLAN_KIND = 'hostSessionRuntimePlan' as const;

const KEEP_ALIVE_DUPLICATE_SUPPRESSION_MS = 100;

export type HostSessionRuntimePlan = Readonly<{
  kind: typeof HOST_SESSION_RUNTIME_PLAN_KIND;
  providerId: string;
  opts: HostSessionRuntimeRunOptions;
  config: HostSessionRuntimeConfig;
  deps?: HostSessionRuntimeDeps;
}>;

export function isHostSessionRuntimePlan(value: unknown): value is HostSessionRuntimePlan {
  if (!value || typeof value !== 'object') return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.kind === HOST_SESSION_RUNTIME_PLAN_KIND
    && typeof record.providerId === 'string'
    && Boolean(record.opts)
    && Boolean(record.config);
}

export async function runHostSessionRuntimePlan(plan: HostSessionRuntimePlan): Promise<void> {
  const { runHostSessionRuntime } = await import('@/agent/runtime/session/loop/runHostSessionRuntime');
  await runHostSessionRuntime(plan.opts, plan.config, plan.deps);
}

export type SessionLoopLifecycleDeps = Readonly<{
  cleanupBackendRunResourcesFn?: typeof cleanupBackendRunResources;
  createRuntimeOverrideSynchronizersFn?: typeof createRuntimeOverrideSynchronizers;
  runPermissionModePromptLoopFn?: typeof runPermissionModePromptLoop;
  registerRunnerTerminationHandlersFn?: typeof registerRunnerTerminationHandlers;
  sendReadyWithPushNotificationFn?: typeof sendReadyWithPushNotification;
  archiveAndCloseRuntimeSessionFn?: typeof archiveAndCloseRuntimeSession;
  registerKillSessionHandlerFn?: typeof registerKillSessionHandler;
  renderFn?: typeof render;
  startRemoteModeStaticControlFn?: typeof startRemoteModeStaticControl;
  runTerminalRemoteSessionModeLoopFn?: typeof runTerminalRemoteSessionModeLoop;
  remoteOnlyTerminalDisplayComponent?: React.ComponentType<RemoteOnlyTerminalDisplayProps>;
}>;

export type SessionLoopLifecycleParams = Readonly<{
  opts: HostSessionRuntimeRunOptions;
  config: HostSessionRuntimeConfig;
  api: HostSessionRuntimeLoopApi;
  session: ApiSessionClient;
  runtime: RuntimeTurnOperations;
  hookRuntime?: HostSessionRuntimeHookRuntime | null;
  messageBuffer: MessageBuffer;
  permissionHandler: PromptLoopPermissionHandler;
  permissionModeState: Readonly<{
    rebindSession: (session: ApiSessionClient) => void;
    getCurrentPermissionMode: () => PermissionMode | undefined;
    getCurrentPermissionModeUpdatedAt: () => number;
    setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
    setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
    messageQueue: MessageQueue2<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>;
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
    cleanup?: (() => void | Promise<void>) | null;
  }> | null;
  runtimeState: {
    thinking: boolean;
  };
  setAbortRequestedCallback: (callback: (() => void | Promise<void>) | null) => void;
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
  const terminalRemoteModeLoop = resolveHostSessionTerminalRemoteModeLoop(hookRuntimeForCallbacks);
  const resolvedStartingMode = resolveStartingMode({
    terminalCapable: terminalRemoteModeLoop !== null,
    userIntent: (params.opts as Readonly<{ startingMode?: unknown }>).startingMode,
    providerHint: terminalRemoteModeLoop?.startingMode,
  });
  const terminalTurnStateMachine = createTerminalTurnStateMachine();
  const sessionTurnLifecycle = createSessionTurnLifecycle({
    session: params.session,
    provider: params.policyAgentId,
  });
  let activeTerminalRemoteMode: TerminalRemoteSessionMode =
    resolvedStartingMode.kind === 'switching' ? resolvedStartingMode.startingMode : 'remote';
  let terminalHandoffFailureRequiresManualAction = false;
  const observeRuntimeLifecycleMessage = (message: unknown): void => {
    void projectRuntimeTranscriptEvent({
      session: params.session,
      event: message,
    }).catch((error) => {
      logger.debug(`${params.config.uiLogPrefix} Runtime transcript projection failed (non-fatal)`, error);
    });
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
    } catch (error) {
      logger.debug(`${params.config.uiLogPrefix} Failed to subscribe to terminal lifecycle messages (non-fatal)`, error);
      return () => undefined;
    }
  })();
  const runtimeOverrideTarget: RuntimeOverrideTarget = {
    setSessionMode: async (modeId) => {
      await runtimeForPromptLoop.updateSessionRuntimeConfig({ modeId });
    },
    setSessionModel: async (modelId) => {
      await runtimeForPromptLoop.updateSessionRuntimeConfig({ modelId });
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
  let cleanupRan = false;
  let startupCoordinatorStarted = false;

  const startStartupCoordinator = (): void => {
    if (startupCoordinatorStarted) return;
    if (!params.startupCoordinator?.start) return;
    startupCoordinatorStarted = true;
    void Promise.resolve(params.startupCoordinator.start()).catch((error) => {
      logger.debug(`${params.config.uiLogPrefix} Shared startup coordinator failed (non-fatal)`, error);
    });
  };

  const handleAbort = async () => {
    logger.debug(`${params.config.uiLogPrefix} Abort requested`);
    resetAssistantTextSnapshotTurnScope(params.session, 'abort');
    params.session.sendAgentMessage(params.config.agentMessageType, { type: 'turn_cancelled', id: randomUUID() });
    params.permissionHandler.reset();
    try {
      abortController.abort();
      abortController = new AbortController();
      await runtimeForPromptLoop.cancelTurn();
    } catch (error) {
      logger.debug(`${params.config.uiLogPrefix} Failed to cancel current operation (non-fatal)`, error);
    }
  };
  params.setAbortRequestedCallback(handleAbort);

  let inkInstance: ReturnType<typeof render> | null = null;
  let staticControl: RemoteModeStaticControl | null = null;
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
        onExit: async () => {
          shouldExit = true;
          await handleAbort();
        },
      });
      return;
    }
    if (!shouldMountRemoteOnlyTerminalDisplay && remoteControlSurface !== 'ink') return;
    console.clear();
    const displayProps = {
      messageBuffer: params.messageBuffer,
      logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
      onExit: async () => {
        shouldExit = true;
        await handleAbort();
      },
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

  if (hasTTY && shouldRenderTerminalDisplay) {
    mountTerminalDisplay();
  }

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

  const cleanupOnce = async () => {
    if (cleanupRan) return;
    cleanupRan = true;
    unsubscribeRuntimeEvents();
    await params.config.lifecycleHooks?.onBeforeDispose?.({ session: params.session, runtime: hookRuntimeForCallbacks });
    await cleanupBackendRunResourcesFn({
      keepAliveInterval,
      reconnectionHandle: params.reconnectionHandle,
      stopMcpServer: () => params.happyMcpServerStop(),
      resetRuntime: () => runtimeForPromptLoop.resetOrDisposeRuntime(),
      unmountUi: unmountTerminalDisplay,
    });
    await params.startupCoordinator?.cleanup?.();
    await params.config.onDispose?.({ session: params.session, runtime: hookRuntimeForCallbacks });
  };

  const terminationHandlers = registerRunnerTerminationHandlersFn({
    process,
    exit: (code) => process.exit(code),
    onTerminate: async (event, outcome) => {
      shouldExit = true;
      await handleAbort();
      const archiveDecision = resolveTerminationArchiveDecision({
        startedBy: params.opts.startedBy,
        event,
        outcome,
      });
      try {
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
        }
      } finally {
        await cleanupOnce();
      }
    },
  });

  params.session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandlerFn(params.session.rpcHandlerManager, async () => {
    logger.debug(`${params.config.uiLogPrefix} Kill session requested`);
    terminationHandlers.requestTermination({ kind: 'killSession' });
    await terminationHandlers.whenTerminated;
  });

  startStartupCoordinator();

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
        return {
          ok: false,
          ...(typeof record.detail === 'string' && record.detail.trim().length > 0
            ? { detail: record.detail.trim() }
            : {}),
        };
      }
      if (record.ok === true) {
        return {
          ok: true,
          ...(typeof record.detail === 'string' && record.detail.trim().length > 0
            ? { detail: record.detail.trim() }
            : {}),
        };
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
          return { ok: false, detail: record.error };
        }
      }
      return normalizeRemoteHandoffResult(result);
    } catch (error) {
      logger.debug(`${params.config.uiLogPrefix} Failed to request remote handoff`, error);
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'remote_handoff_failed',
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
      } catch (error) {
        terminalHandoffFailureRequiresManualAction = true;
        publishTerminalHandoffFailure(
          decision.status.pendingCount,
          error instanceof Error ? error.message : 'terminal_cancel_failed',
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
      resolveFreshSessionSystemPrompt: async ({ baseOverride }) =>
        await resolveEffectiveCodingPromptText({
          credentials: params.opts.credentials,
          settings: params.opts.accountSettingsContext?.settings ?? null,
          profileId: params.session.getMetadataSnapshot()?.profileId ?? null,
          baseOverride,
          executionRunsFeatureEnabled: resolveCliFeatureDecision({
            featureId: 'execution.runs',
            env: process.env,
          }).state === 'enabled',
          providerId: params.policyAgentId,
          toolDelivery,
          toolDeliverySessionId: resolveToolDeliverySessionId(),
          toolDeliveryDirectory: params.runtimeDirectory,
          memoryMachineId: params.machineId,
          memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled,
          cache: promptArtifactBodyCache,
        }),
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
        params.sessionSwapStrategy.flushPendingSessionSwap || params.config.lifecycleHooks?.onAfterLoopBoundary
          ? async (loopParams) => {
              await params.sessionSwapStrategy.flushPendingSessionSwap?.();
              await params.config.lifecycleHooks?.onAfterLoopBoundary?.({ ...loopParams, session: params.session, runtime: hookRuntimeForCallbacks });
            }
          : undefined,
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
    await cleanupOnce();
    await terminalRemoteModeLoopPromise;
    if (!promptLoopError && terminalRemoteModeLoopError) {
      throw terminalRemoteModeLoopError;
    }
  }
}
