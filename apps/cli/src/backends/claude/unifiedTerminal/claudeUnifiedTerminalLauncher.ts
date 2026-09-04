import { createClaudeReadyHandler } from '../ready/createClaudeReadyHandler';
import { createClaudePendingAwareInputConsumer } from '../createClaudePendingAwareInputConsumer';
import { PendingQueueMaterializationAuthError } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { EnhancedMode } from '../loop';
import type { Session } from '../session';
import type { LauncherResult } from '../claudeLocalLauncher';
import { createClaudeSessionTranscriptProjector } from '../localControl/createClaudeSessionTranscriptProjector';
import { createClaudeWorkflowActivitySourceForSession } from '../workflows/createClaudeWorkflowActivitySourceForSession';
import { createWorkflowAgentTranscriptRegistrar } from '../remote/sidechains/createWorkflowAgentTranscriptRegistrar';
import type { ClaudeRemoteSubagentFileCollector } from '../remote/sidechains/claudeRemoteSubagentFileCollector';
import type { NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { adoptClaudePermissionModeFromMetadata } from '../utils/syncPermissionModeFromMetadata';
import {
  isClaudeRuntimeAuthRecoveryContinuing,
  surfaceClaudeRuntimeAuthFailure,
  surfaceClaudeRateLimitRuntimeIssue,
} from '../connectedServices/surfaceClaudeRuntimeIssues';
import {
  createClaudeInFlightSteerCapabilityPublisher,
  type ClaudeInFlightSteerAvailabilitySnapshot,
} from './createClaudeInFlightSteerCapabilityPublisher';
import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';
import type { ClaudeUnifiedTerminalScreenObservation } from './_types';
import { readDaemonInitialGoalFromEnv } from '@/agent/runtime/sessionInitialGoal';
import { isClaudeUnifiedTerminalManagedSettingsOptionError } from './buildClaudeUnifiedTerminalSpawn';
import { CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID } from './tuiControls';
import { ClaudeUnifiedDialogChoiceBroker } from './dialogChoice/claudeUnifiedDialogChoiceBroker';
import type { ClaudeUnifiedRuntimeControlApplyResult } from './runtimeControlIntegration';
import {
  buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent,
} from './runtimeControlIntegration';
import { createUnifiedTerminalGateOffRestartNoticeTracker } from './runtimeConfigRestartNotice';
import { createClaudeUnifiedTerminalMetadataModeApplier } from './metadataRuntimeModeApplier';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { bindClaudeUnifiedTerminalSession } from './bindClaudeUnifiedTerminalSession';
import { createTerminalComposerDraftBlockedEvent } from './terminalComposerDraftBlockedEvent';
import { isClaudeUnifiedTerminalHostDeadError } from './createClaudeUnifiedController';
import { isClaudeUnifiedTerminalReadinessTimeoutError } from './createClaudeUnifiedTerminalReadinessBridge';
import {
  isClaudeUnifiedTerminalRuntimeIssueError,
  surfaceClaudeUnifiedTerminalRuntimeIssue,
} from './surfaceClaudeUnifiedTerminalRuntimeIssue';
import {
  createClaudeUnifiedTerminalUnobservedFailedTurnError,
  isClaudeUnifiedTerminalAmbiguousInjectionFailureError,
  isClaudeUnifiedTerminalInjectionFailureError,
  isClaudeUnifiedTerminalRecoverableProviderAcceptanceUnknownFailure,
} from './terminalInjectionFailureError';
import {
  isClaudeUnifiedProviderUnavailablePromptDeliveryWindowActive,
  resolveClaudeUnifiedProviderUnavailableUntilMs,
  resolveClaudeUnifiedProviderUnavailableWindowForUsageLimitDialog,
  type ClaudeUnifiedProviderUnavailablePromptDeliveryWindow,
} from './pendingDeliveryBlock';
import {
  createClaudeUnifiedSustainedPendingDeliveryBlockHandler,
  handleClaudeUnifiedTerminalRuntimeIssuePendingDeliveryBlock,
} from './claudeUnifiedPendingDeliveryBlockHandling';
import {
  blockUndeliverableProviderPrompt,
  normalizePendingDeliveryLocalIds,
  readSinglePendingDeliveryLocalId,
} from '@/agent/runtime/session/pendingDelivery/undeliverableProviderPrompt';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { isRecoveryProbeInconclusiveError, isTerminalHostStartupError, TerminalHostStartupError } from '@/integrations/terminalHost/errors';
import { runTmuxAttach } from '@/terminal/attachment/tmuxAttach';
import { runZellijAttach } from '@/terminal/attachment/zellijAttach';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { logger } from '@/ui/logger';
import { extractClaudeTerminalInitialPrompt } from '../cli/terminalInitialPrompt';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import { configuration } from '@/configuration';
import { delay } from '@/utils/time';
import { readClaudeActiveUnifiedTerminalHost } from '../utils/readClaudeActiveTerminalMode';
import { prepareClaudeUnifiedStartupLifecycle } from './startupLifecycle';
import { applyClaudeUnifiedTerminalLaunchIntent } from './launchIntent';
import { createClaudeUnifiedProviderInputOutcomeBridge } from './claudeUnifiedProviderInputOutcome';
import { createClaudeUnifiedTerminalSharedCallbacks } from './createClaudeUnifiedTerminalSharedCallbacks';
import { createProviderPromptAcceptanceSettlement } from '@/agent/runtime/prompt/createProviderPromptAcceptanceSettlement';
import { resolveClaudeQueuedPromptForDispatch } from '../runtime/resolveClaudeQueuedPromptForDispatch';

function shouldForegroundAttachTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

const CLAUDE_UNIFIED_TERMINAL_AUTH_FAILURE_HOST_DEATH_WINDOW_MS = 5_000;
const CLAUDE_UNIFIED_PARK_EMPTY_WAKE_RETRY_MS = 250;

type ParkedUnifiedTerminalMessage = Readonly<{
  message: string;
  mode: EnhancedMode;
  maxUserMessageSeq: number | null;
  userMessageLocalIds: readonly string[];
  providerAcceptancePending?: boolean;
  pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
}>;

type InFlightStartupMessage = Readonly<{
  source: 'initial' | 'parked' | 'queue';
  /** Raw durable input; retries must never requeue the provider-expanded prompt. */
  batch: ParkedUnifiedTerminalMessage;
  /** Exact prompt handed to the terminal, used only to correlate runner handback. */
  providerMessage: string;
  launchAttempt: number;
}>;

function readClaudeResumeSessionId(claudeArgs: readonly string[]): string | null {
  for (let index = 0; index < claudeArgs.length; index += 1) {
    const arg = claudeArgs[index];
    if (arg === '--resume' || arg === '-r') {
      const value = claudeArgs[index + 1];
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    }
    if (typeof arg === 'string' && (arg.startsWith('--resume=') || arg.startsWith('-r='))) {
      const value = arg.slice(arg.indexOf('=') + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function hasClaudeContinueArg(claudeArgs: readonly string[]): boolean {
  return claudeArgs.some((arg) => arg === '--continue' || arg === '-c');
}

function areSameUserMessageLocalIds(a: readonly string[], b: readonly string[] | null | undefined): boolean {
  const rhs = b ?? [];
  if (a.length !== rhs.length) return false;
  return a.every((value, index) => value === rhs[index]);
}

function readPendingDeliveryLocalIdsFromPumpFailure(error: unknown): string[] {
  const rawLocalIds: unknown[] = [];
  const seenErrors = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seenErrors.has(current)) {
    seenErrors.add(current);
    const record = current as {
      localId?: unknown;
      localIds?: unknown;
      userMessageLocalIds?: unknown;
      cause?: unknown;
    };
    rawLocalIds.push(
      record.localId,
      ...(Array.isArray(record.localIds) ? record.localIds : []),
      ...(Array.isArray(record.userMessageLocalIds) ? record.userMessageLocalIds : []),
    );
    current = record.cause;
  }
  return normalizePendingDeliveryLocalIds(rawLocalIds.filter((localId): localId is string => typeof localId === 'string'));
}

function isInvalidPromptTextInjectionFailure(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_injection_failed'
    && (error as { failureState?: unknown }).failureState === 'failed_terminal'
    && (error as { reason?: unknown }).reason === 'invalid_prompt_text'
    && (error as { phase?: unknown }).phase === 'before_write'
    && (error as { duplicateRisk?: unknown }).duplicateRisk === 'none'
    && (error as { recoverable?: unknown }).recoverable === false;
}

function startForegroundAttach(params: Readonly<{
  sessionId: string;
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}>): void {
  if (!shouldForegroundAttachTerminal()) return;

  if (params.terminal.mode === 'tmux') {
    void runTmuxAttach({
      sessionId: params.sessionId,
      terminal: params.terminal,
    }).catch(() => undefined);
    return;
  }

  if (params.terminal.mode === 'zellij') {
    void runZellijAttach({
      sessionId: params.sessionId,
      terminal: params.terminal,
    }).catch(() => undefined);
  }
}

function sendUnifiedTerminalHostDeadMessage(
  session: Session,
  params: Readonly<{ promptDeliveryWasPending: boolean }>,
): void {
  session.client.sendSessionEvent({
    type: 'message',
    message: params.promptDeliveryWasPending
      ? 'Claude unified terminal host is not alive. The terminal process exited before Happier could send your prompt.'
      : 'Claude unified terminal host is not alive. The terminal process exited.',
  });
}

function sendUnifiedTerminalDeliveryUnknownMessage(session: Session): void {
  session.client.sendSessionEvent({
    type: 'message',
    message: 'Claude could not confirm whether your queued message reached the terminal. Happier stopped automatic retry to avoid sending the same prompt twice; send a new message or restart the session when you are ready.',
  });
}

function isRecentClaudeUnifiedTerminalAuthFailure(params: Readonly<{
  authFailureAtMs: number | null;
  nowMs: number;
}>): boolean {
  return params.authFailureAtMs !== null
    && params.nowMs - params.authFailureAtMs >= 0
    && params.nowMs - params.authFailureAtMs <= CLAUDE_UNIFIED_TERMINAL_AUTH_FAILURE_HOST_DEATH_WINDOW_MS;
}

async function flushUnifiedStartupFailureSurface(session: Session, reason: string): Promise<void> {
  try {
    await session.client.flush();
  } catch (error) {
    logger.debug('[unified]: failed to flush Claude unified startup failure surface (non-fatal)', {
      reason,
      error,
    });
  }
}

function asStandaloneUnifiedMode(mode: EnhancedMode): EnhancedMode {
  return {
    ...mode,
    claudeUnifiedTerminalEnabled: true,
  };
}

function readActiveUnifiedTerminalHost(session: Session): 'tmux' | 'zellij' | null {
  return readClaudeActiveUnifiedTerminalHost({
    terminalRuntime: session.terminalRuntime,
    metadata: session.client.getMetadataSnapshot?.(),
  });
}

function applyActiveTerminalHostToStartupMode(session: Session, mode: EnhancedMode): EnhancedMode {
  const activeHost = readActiveUnifiedTerminalHost(session);
  if (!activeHost) return mode;
  if (mode.claudeUnifiedTerminalHost === activeHost) return mode;
  return {
    ...mode,
    claudeUnifiedTerminalHost: activeHost,
  };
}

function resolveCurrentRuntimeModeForActiveTerminalRuntime(session: Session, mode: EnhancedMode): EnhancedMode {
  return asStandaloneUnifiedMode(applyActiveTerminalHostToStartupMode(session, mode));
}

export async function claudeUnifiedTerminalLauncher(
  session: Session,
  opts: Readonly<{
    initialMode?: EnhancedMode | undefined;
    expectedExistingTerminalHostAttachmentId?: string | undefined;
    onTerminalHostReady?: ((params: Readonly<{
      handle: import('@/integrations/terminalHost/_types').TerminalHostHandle;
      terminal: NonNullable<import('@/api/types').Metadata['terminal']>;
      destroyOwnedHostForExplicitStop: () => Promise<void>;
    }>) => void | Promise<void>) | undefined;
    signal?: AbortSignal | undefined;
  }>,
): Promise<LauncherResult> {
  const abortController = new AbortController();
  // Standalone/local Unified gets the SAME runtime-control integration as remote Unified (gap 26).
  const tuiRuntimeControlEnabled = resolveCliFeatureDecision({
    featureId: CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID,
    env: process.env,
  }).state === 'enabled';
  // QA-B B6 (live 2026-06-12, session cmqawdqzj): with the gate OFF the standalone launcher had no
  // legacy restart-notice path — runtime-config changes between turns were silently dropped. The
  // daemon launcher surfaces these notices at its mode boundary; the standalone launcher observes
  // each outgoing batch mode instead (one notice per distinct change signature).
  const gateOffRestartNoticeTracker = tuiRuntimeControlEnabled
    ? null
    : createUnifiedTerminalGateOffRestartNoticeTracker({
        emit: (emission) => {
          session.client.sendSessionEvent({ type: 'message', message: emission.message });
          session.client.sendSessionEvent(buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent({
            status: emission.status,
            reason: emission.reason,
            message: emission.message,
            changes: emission.changes,
          }));
        },
      });
  const normalizeStartupMode = (mode: EnhancedMode): EnhancedMode =>
    applyActiveTerminalHostToStartupMode(session, mode);
  let currentRuntimeMode: EnhancedMode | null = opts.initialMode
    ? resolveCurrentRuntimeModeForActiveTerminalRuntime(session, opts.initialMode)
    : null;
  let applyUnifiedTerminalMetadataMode: ((mode: EnhancedMode) => Promise<ClaudeUnifiedRuntimeControlApplyResult>) | null = null;
  const applyUnifiedTerminalPermissionMetadata = createClaudeUnifiedTerminalMetadataModeApplier({
    getCurrentMode: () => currentRuntimeMode,
    getApplier: () => applyUnifiedTerminalMetadataMode,
  });
  const observeOutgoingBatchMode = (mode: EnhancedMode): EnhancedMode => {
    const nextMode = normalizeStartupMode(mode);
    currentRuntimeMode = asStandaloneUnifiedMode(nextMode);
    gateOffRestartNoticeTracker?.observeBatchMode(nextMode);
    return nextMode;
  };
  let removeExternalAbortListener: (() => void) | null = null;
  if (opts.signal) {
    const abortFromExternalSignal = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(opts.signal?.reason ?? 'claude-unified-external-abort');
      }
    };
    if (opts.signal.aborted) {
      abortFromExternalSignal();
    } else {
      opts.signal.addEventListener('abort', abortFromExternalSignal, { once: true });
      removeExternalAbortListener = () => opts.signal?.removeEventListener('abort', abortFromExternalSignal);
    }
  }
  let turnInterrupt: (() => Promise<void>) | null = null;
  const initialPrompt = extractClaudeTerminalInitialPrompt(session.claudeArgs);
  let initialPromptPending = typeof initialPrompt.prompt === 'string';
  // Centralized Claude Dynamic Workflow ACTIVITY source (CWF2/CWF3/CWF4). Built at the launcher
  // (which owns credentials + stored-content encryption) and handed to the projector, which feeds it
  // the SAME raw transcript channel as the goal source and applies its CWF4 owned-id filter at the
  // work-state merge chokepoint. Null when no credentials are available yet — the goal / work-state
  // path is unaffected.
  // The runtime that owns this session's ONE sidechain importer is started further down (each
  // dispatch builds its own scanner and may replace it), so the source reaches the importer through
  // this holder, which the runtime keeps current and clears on teardown. The registrar FAILS while
  // the holder is empty rather than assuming an importer: an id is a claim that a transcript is
  // openable, so no importer must mean NO id — never a silent no-op.
  let subagentFileCollectorRef: ClaudeRemoteSubagentFileCollector | null = null;
  const workflowActivitySource = await createClaudeWorkflowActivitySourceForSession({
    session,
    logPrefix: '[unified]',
    // Workflow agent transcripts ride the SAME importer as `Task` sub-agent transcripts: one
    // follower budget, one dedupe, one `isSidechain`/`sidechainId` marking rule.
    registerWorkflowAgentTranscript: createWorkflowAgentTranscriptRegistrar({
      getCollector: () => subagentFileCollectorRef,
    }),
    getCurrentClaudeSessionId: () => {
      const claudeSessionId = session.client.getMetadataSnapshot?.()?.claudeSessionId;
      return typeof claudeSessionId === 'string' && claudeSessionId.trim().length > 0 ? claudeSessionId.trim() : null;
    },
  });
  const transcriptProjector = createClaudeSessionTranscriptProjector({ session, logPrefix: '[unified]', workflowActivitySource });
  /**
   * Did THIS launcher destroy the terminal host for an explicit user stop?
   *
   * The teardown below is reached by every exit — a provider crash, a runtime issue, a plain return,
   * a CLI signal — and on this runtime the terminal host is DETACHED, so most of those leave Claude
   * and its background shells running. Only the explicit-stop disposal is the kill we performed and
   * watched, which is the sole condition under which a background-task record may be resolved.
   */
  let ownedTerminalHostDestroyedForExplicitStop = false;
  let lastSurfacedRuntimeAuthFailureAtMs: number | null = null;
  let recentPrimaryProviderUnavailableForPromptDelivery: ClaudeUnifiedProviderUnavailablePromptDeliveryWindow | null = null;
  let usageLimitDialogVisible = false;
  const readyHandler = createClaudeReadyHandler({
    session: session.client,
    pushSender: session.pushSender,
    waitingForCommandLabel: 'Claude',
    logPrefix: '[unified]',
    getPending: () => null,
    getQueueSize: () => session.queue.size(),
    hasOnlyBlockedPendingWork: () => session.client.hasOnlyBlockedPendingWork?.() === true,
    accountSettings: session.accountSettings,
    settingsSecretsReadKeys: session.accountSettingsSecretsReadKeys,
    includeAssistantPreviewText:
      session.accountSettings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
    shouldSendPush: () => shouldSendReadyPushNotification(session.accountSettings ?? null),
  });
  const { mcpConfigJson } = await session.getOrCreateHappierMcpBridge();
  const binding = bindClaudeUnifiedTerminalSession({
    session: session.client,
    logPrefix: '[unified]',
    acceptedPromptEchoWindowMs: configuration.claudeUnifiedTerminalAcceptedPromptEchoWindowMs,
    onMessage: async (message) => {
      await transcriptProjector.observe(message);
    },
    onReady: (context) => {
      readyHandler(context);
    },
    onTurnInterruptChanged: (handler) => {
      turnInterrupt = handler;
    },
    onPromptTurnStarted: () => {
      // This callback is emitted only for an accepted new turn. In-flight steers stay attached
      // to the already-active turn, so the hook lifecycle bridge remains the serial task owner.
      session.setThinkingWithoutTaskLifecycle(true);
    },
  });
  await binding.seedPersistedPromptEchoes();

  const recordPrimaryProviderUnavailableForPromptDelivery = (
    details: NormalizedProviderUsageLimitDetailsV1,
  ): void => {
    if (details.sourcedFromSidechain !== true) {
      const observedAtMs = Date.now();
      const unavailableUntilMs = resolveClaudeUnifiedProviderUnavailableUntilMs(details, observedAtMs);
      recentPrimaryProviderUnavailableForPromptDelivery = unavailableUntilMs === null
        ? null
        : { unavailableUntilMs };
    }
  };

  const surfaceRateLimit = (details: NormalizedProviderUsageLimitDetailsV1): void => {
    recordPrimaryProviderUnavailableForPromptDelivery(details);

    void surfaceClaudeRateLimitRuntimeIssue(session, details, '[unified]')
      .catch((error) => {
        logger.debug('[unified]: failed to surface Claude rate-limit runtime issue', error);
      })
      .finally(binding.notePromptTurnTerminal);
  }

  const surfacePromptTurnTerminal = async (event: Readonly<{
    reason: string;
    source: string;
    detail?: string | undefined;
    providerAcceptanceFailureObserved?: boolean | undefined;
  }>): Promise<void> => {
    if (event.reason === 'aborted') {
      await binding.recordPromptTurnCancelled();
      session.abortCurrentTaskTurn();
      return;
    }
    try {
      if (event.reason === 'failed' && event.source === 'claude_transcript_api_error') {
        await surfacePrimarySessionRuntimeIssue({
          provider: 'claude',
          cause: 'status_error',
          error: {
            code: event.source,
            message: event.detail ?? event.source,
          },
          session: session.client,
        }).catch((error) => {
          logger.debug('[unified]: failed to surface Claude transcript API-error turn failure (non-fatal)', error);
          return null;
        });
      } else if (event.reason === 'failed' && event.providerAcceptanceFailureObserved !== true) {
        await surfaceTerminalRuntimeIssue(createClaudeUnifiedTerminalUnobservedFailedTurnError());
      }
    } finally {
      // Any non-aborted terminal projection (hook StopFailure, process exit, unknown) must
      // terminalize the canonical turn; leaving it open keeps the server turn 'in_progress'
      // forever and permanently blocks daemon pending-queue draining (QA A-F3/C-F2).
      await binding.recordPromptTurnFailed().catch(() => undefined);
    }
  };
  const surfaceTerminalRuntimeIssue = async (
    error: unknown,
    options?: Readonly<{ allowPendingDeliveryBlock?: boolean }>,
  ): Promise<
    | void
    | Readonly<{ action: 'claimed_pending_delivery' }>
    | Readonly<{ action: 'surfaced_runtime_issue' }>
  > => {
    const result = await handleClaudeUnifiedTerminalRuntimeIssuePendingDeliveryBlock({
      error,
      providerUnavailableWindow: recentPrimaryProviderUnavailableForPromptDelivery,
      setProviderUnavailableWindow: (window) => {
        recentPrimaryProviderUnavailableForPromptDelivery = window;
      },
      blockPendingMessageDelivery: options?.allowPendingDeliveryBlock === false
        ? undefined
        : session.client.blockPendingMessageDelivery?.bind(session.client),
      logPrefix: '[unified]',
      logDebug: (message, logError) => logger.debug(message, logError),
      deferAmbiguousRuntimeIssue: true,
      beforeSurfaceRuntimeIssue: () => session.onThinkingChange(false),
      surfaceRuntimeIssue: (runtimeIssueError) =>
        surfaceClaudeUnifiedTerminalRuntimeIssue({
          error: runtimeIssueError,
          session: session.client,
          onSurfaceError: (surfaceError) => {
            logger.debug('[unified]: failed to surface Claude unified terminal runtime issue (non-fatal)', surfaceError);
          },
        }).catch((surfaceError) => {
          logger.debug('[unified]: failed to surface Claude unified terminal runtime issue (non-fatal)', surfaceError);
          return null;
        }),
      onSurfacedRuntimeIssue: async () => {
        binding.notePromptTurnTerminal();
        await session.client.flush().catch((flushError) => {
          logger.debug('[unified]: failed to flush Claude unified terminal runtime issue surface (non-fatal)', flushError);
        });
      },
    });
    if (isClaudeUnifiedTerminalAmbiguousInjectionFailureError(error) && result === undefined) {
      logger.debug('[unified]: Claude unified terminal prompt delivery is ambiguous; waiting for confirmation or retry');
    }
    if (typeof result === 'boolean') {
      return result ? { action: 'surfaced_runtime_issue' } : undefined;
    }
    return result;
  };

  session.client.rpcHandlerManager.registerHandler('abort', async () => {
    session.noteUserAbortRequested();
    if (turnInterrupt) {
      try {
        await turnInterrupt();
        await binding.recordPromptTurnCancelled();
        session.abortCurrentTaskTurn();
        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        return true;
      } catch (error) {
        logger.debug('[unified]: failed to interrupt Claude terminal turn; keeping unified host alive', error);
        await binding.recordPromptTurnCancelled();
        session.abortCurrentTaskTurn();
        return true;
      }
    }
    logger.debug('[unified]: UI abort requested before Claude terminal turn interrupt handler was ready');
    await binding.recordPromptTurnCancelled();
    session.abortCurrentTaskTurn();
    return true;
  });

  // Lane P (O-design Seam A): publish live steer availability (+reason) to agentState.
  const inFlightSteerCapabilityPublisher = createClaudeInFlightSteerCapabilityPublisher({
    session: session.client,
    isCanonicalTurnActive: () => session.client.hasActiveCanonicalTurn?.() ?? true,
  });
  inFlightSteerCapabilityPublisher.publishPendingInputInterruptAndRunLocalId(null);
  let inFlightSteerAvailabilitySnapshot: ClaudeInFlightSteerAvailabilitySnapshot = {
    available: false,
    reason: 'unsafe_window',
  };
  let refreshInFlightSteerAvailability: (() => Promise<ClaudeInFlightSteerAvailabilitySnapshot>) | null = null;
  const observeInFlightSteerAvailabilitySnapshot = (
    snapshot: ClaudeInFlightSteerAvailabilitySnapshot,
  ): void => {
    inFlightSteerAvailabilitySnapshot = snapshot;
    inFlightSteerCapabilityPublisher.publish(snapshot);
  };
  const sustainedPendingDeliveryBlockHandler = createClaudeUnifiedSustainedPendingDeliveryBlockHandler({
    blockPendingMessageDelivery: session.client.blockPendingMessageDelivery?.bind(session.client),
    wakePendingMaterialization: session.client.wakePendingMaterialization?.bind(session.client),
    logPrefix: '[unified]',
    logDebug: (message, error) => logger.debug(message, error),
  });
  const releaseUsageLimitPendingBlock = (): void => {
    usageLimitDialogVisible = false;
    recentPrimaryProviderUnavailableForPromptDelivery = null;
    sustainedPendingDeliveryBlockHandler.wakePendingMaterialization();
  };
  const observeTerminalScreen = (observation: ClaudeUnifiedTerminalScreenObservation): void => {
    if (observation.screenState.usageLimitDialogVisible) {
      recentPrimaryProviderUnavailableForPromptDelivery =
        resolveClaudeUnifiedProviderUnavailableWindowForUsageLimitDialog(Date.now());
      usageLimitDialogVisible = true;
      void sustainedPendingDeliveryBlockHandler.blockForSustainedBlocker({
        localIds: observation.userMessageLocalIds,
        blocker: {
          kind: 'provider_unavailable',
          source: 'readiness',
          detail: 'claude_usage_limit_dialog',
        },
        isCanonicalTurnActive: session.client.hasActiveCanonicalTurn?.() ?? true,
      });
      return;
    }
    if (!usageLimitDialogVisible) return;
    releaseUsageLimitPendingBlock();
  };

  // Daemon-owned pending drain (QA C-F2/A-F3, live repro cmqb329qm044z): all idle input waits go
  // through the pending-aware consumer so server-side queued rows materialize on turn-end/idle
  // wakes. A raw `session.queue` wait only ever sees UI-RPC-delivered messages and strands queued
  // pending rows until a manual "Send now".
  const sessionInputConsumer = createClaudePendingAwareInputConsumer(session, {
    resolveActiveTurnSteerability: () => (
      inFlightSteerAvailabilitySnapshot.available ? 'steerable' : 'unsteerable'
    ),
    refreshActiveTurnSteerability: async () => {
      const refresh = refreshInFlightSteerAvailability;
      if (!refresh) return 'unsteerable';
      const snapshot = await refresh();
      return snapshot.available ? 'steerable' : 'unsteerable';
    },
    onMetadataUpdate: async () => {
      const updated = adoptClaudePermissionModeFromMetadata({ session });
      if (updated) {
        await applyUnifiedTerminalPermissionMetadata(updated.intent);
      }
    },
  });
  const dialogChoiceBroker = new ClaudeUnifiedDialogChoiceBroker(session);
  const waitForNextSessionInputBatch = async (): Promise<ParkedUnifiedTerminalMessage | null> => {
    try {
      const batch = await sessionInputConsumer.waitForNextInput({ abortSignal: abortController.signal });
      if (!batch) return null;
      const localId = readSinglePendingDeliveryLocalId(batch.userMessageLocalIds);
      if (!localId) {
        throw new Error('Canonical Pending provider input requires exactly one nonblank localId');
      }
      return {
        message: batch.message,
        mode: batch.mode,
        maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
        userMessageLocalIds: [localId],
        ...(batch.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
        ...(batch.pendingProviderAction ? { pendingProviderAction: batch.pendingProviderAction } : {}),
      };
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) {
        // Classified terminal-auth stop: end the wait gracefully instead of escaping
        // into the generic fatal-command-error path (incident cmq7pyqkj family).
        logger.debug('[unified]: pending-queue materialization stopped after supervisor auth failure');
        return null;
      }
      throw error;
    }
  };
  const waitForNextParkedSessionInputBatch = async (): Promise<ParkedUnifiedTerminalMessage | null> => {
    while (!abortController.signal.aborted) {
      const batch = await waitForNextSessionInputBatch();
      if (batch) return batch;
      if (abortController.signal.aborted) return null;
      logger.debug('[unified]: parked input wait woke empty; keeping runner parked for durable input');
      await delay(CLAUDE_UNIFIED_PARK_EMPTY_WAKE_RETRY_MS);
    }
    return null;
  };

  // A classified unified runtime failure (injection failure, host death) must NEVER escape as a
  // process-killing `[claude] Fatal command error` (incident cmq7pyqkj: a mid-turn steer injection
  // hit its provider-acceptance timeout, the failed_terminal error was surfaced and then RETHROWN
  // out of this launcher, and loop.ts has no retry loop around it — the runner exited and the
  // session went dead). Instead the launcher parks: it surfaces the structured runtime issue,
  // waits for the next queued message, and relaunches the unified host with that message.
  let parkedMessage: ParkedUnifiedTerminalMessage | null = null;
  let inFlightStartupMessage: InFlightStartupMessage | null = null;
  let didReplaySeedBootstrap = false;
  const replaySeedRetirement = createProviderPromptAcceptanceSettlement();
  const resolveQueuedPromptForProvider = async (
    batch: ParkedUnifiedTerminalMessage,
  ): Promise<ParkedUnifiedTerminalMessage> => {
    // Acceptance starts an async metadata write. Complete it before the next prompt reads the
    // seed snapshot, otherwise an accepted seed can be prefixed a second time.
    await replaySeedRetirement.drain();
    const resolution = await resolveClaudeQueuedPromptForDispatch({
      sessionClient: session.client,
      batch,
      didBootstrap: didReplaySeedBootstrap,
    });
    didReplaySeedBootstrap = resolution.didBootstrap;
    replaySeedRetirement.register(
      readSinglePendingDeliveryLocalId(batch.userMessageLocalIds),
      resolution.seedApplied ? resolution.settleReplaySeedOnProviderAcceptance : null,
    );
    return {
      ...batch,
      message: resolution.message,
    };
  };
  let lastSurfacedRuntimeAuthRecoveryWillContinue = false;
  // A4-MED-3: bounded park/relaunch budget. The undeliverable-batch handback (F-1) re-pends a
  // terminally failed message, so a deterministically dying host would otherwise relaunch with
  // the SAME message forever. Any provider acceptance proves real progress and resets the budget.
  const MAX_CONSECUTIVE_PARK_RELAUNCHES = 3;
  let consecutiveParkRelaunches = 0;
  const consumeParkRelaunchBudget = (): 'within_budget' | 'exhausted' => {
    consecutiveParkRelaunches += 1;
    return consecutiveParkRelaunches <= MAX_CONSECUTIVE_PARK_RELAUNCHES ? 'within_budget' : 'exhausted';
  };
  // hostres-ff (live incident cmrdazlqm, runner log 2026-07-09-23-26-33): a saved host whose liveness
  // probe stays inconclusive across relaunches must NOT be auto-disposed — hostres3 pins "never dispose
  // without positive death evidence", and an inconclusive probe is not death evidence. But an inconclusive
  // recovery loop must also not livelock silently. Mirror the injector's one-shot starvation escalation
  // (createClaudeUnifiedPromptInjector): bounded, constant-owned threshold, escalate exactly once with
  // durable telemetry + one user-visible attention event, then stay quiet until the condition clears.
  // Escalation surfaces; it never disposes and never changes the park control flow.
  const MAX_CONSECUTIVE_RECOVERY_PROBE_INCONCLUSIVE = 3;
  let consecutiveRecoveryProbeInconclusive = 0;
  let recoveryProbeInconclusiveEscalated = false;
  const resetRecoveryProbeInconclusiveEscalation = (): void => {
    consecutiveRecoveryProbeInconclusive = 0;
    recoveryProbeInconclusiveEscalated = false;
  };
  const noteRecoveryProbeInconclusiveAndMaybeEscalate = (error: TerminalHostStartupError): void => {
    consecutiveRecoveryProbeInconclusive += 1;
    if (
      consecutiveRecoveryProbeInconclusive < MAX_CONSECUTIVE_RECOVERY_PROBE_INCONCLUSIVE
      || recoveryProbeInconclusiveEscalated
    ) {
      return;
    }
    recoveryProbeInconclusiveEscalated = true;
    logger.warn('[unified]: terminal host recovery probe inconclusive repeatedly; escalating to a durable attention state without disposing (no positive death evidence)', {
      hostKind: error.hostKind,
      reason: error.reason,
      consecutiveInconclusiveProbes: consecutiveRecoveryProbeInconclusive,
      threshold: MAX_CONSECUTIVE_RECOVERY_PROBE_INCONCLUSIVE,
      ...(error.diagnostics ?? {}),
    });
    session.client.sendSessionEvent({
      type: 'message',
      message: `Claude terminal host is not responding to liveness checks (probed ${consecutiveRecoveryProbeInconclusive} times in a row). It is not being torn down automatically because there is no proof it has exited — reconnect to the terminal or restart the session to recover.`,
    });
  };
  // RC-RESUMEFLAP (live incident 2026-07-08, session cmr377jsr / runner pid 5526): four
  // deterministic host-startup failures burned this budget in ~50s and the exhaustion path
  // exited the runner with code 1 — a dead session the user had to resume manually, usually
  // hitting the same failure again (the resume flap). Durable server-owned rows make a better
  // terminal state available: BLOCK the poisoned rows (terminal_host_unreachable — manual
  // retry / a new message re-delivers them) and keep the runner alive parked for genuinely
  // new input with a fresh budget. Only legacy local-queue batches (no durable row to pause)
  // keep the old exit path, preserving the A4-MED-3 no-unbounded-loop invariant.
  let lastStartupBatchUserMessageLocalIds: readonly string[] = [];
  const noteStartupBatchLocalIds = (localIds: readonly string[] | null | undefined): void => {
    lastStartupBatchUserMessageLocalIds = normalizePendingDeliveryLocalIds(localIds);
  };
  const pauseExhaustedRelaunchBatchRows = async (): Promise<boolean> => {
    // The failing batch lives in exactly one of three places at exhaustion time: parked (pulled
    // but not yet handed to a run), in-flight (handed to the failing run, not provider-accepted),
    // or already returned to its durable rows (tracked local ids from the last startup batch).
    const localIds = normalizePendingDeliveryLocalIds(
      parkedMessage?.userMessageLocalIds?.length
        ? parkedMessage.userMessageLocalIds
        : inFlightStartupMessage?.batch.userMessageLocalIds?.length
          ? inFlightStartupMessage.batch.userMessageLocalIds
          : lastStartupBatchUserMessageLocalIds,
    );
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery?.bind(session.client);
    if (localIds.length === 0 || !blockPendingMessageDelivery) return false;
    const blocked = await blockPendingMessageDelivery({ localIds, reason: 'terminal_host_unreachable' })
      .catch((error) => {
        logger.debug('[unified]: failed to pause poisoned pending rows after relaunch budget exhaustion (non-fatal)', error);
        return false;
      });
    return blocked === true;
  };
  const parkAfterRelaunchBudgetExhausted = async (reason: string): Promise<boolean> => {
    const paused = await pauseExhaustedRelaunchBatchRows();
    if (!paused) {
      session.client.sendSessionEvent({
        type: 'message',
        message: `Claude unified terminal failed ${MAX_CONSECUTIVE_PARK_RELAUNCHES + 1} times in a row. Not retrying automatically — your queued message stays on the server and will be redelivered when the session restarts.`,
      });
      return false;
    }
    consecutiveParkRelaunches = 0;
    parkedMessage = null;
    inFlightStartupMessage = null;
    lastStartupBatchUserMessageLocalIds = [];
    session.client.sendSessionEvent({
      type: 'message',
      message: `Claude unified terminal failed ${MAX_CONSECUTIVE_PARK_RELAUNCHES + 1} times in a row. Your queued message is paused (not lost) — send a new message or retry the paused one to relaunch the terminal.`,
    });
    await flushUnifiedStartupFailureSurface(session, `${reason}_relaunch_budget_exhausted`);
    const batch = reason === 'host_dead'
      ? await waitForNextParkedSessionInputBatch()
      : await waitForNextSessionInputBatch();
    if (!batch) return false;
    parkedMessage = batch;
    return true;
  };
  const parkForNextMessageAfterRuntimeIssue = async (reason: string): Promise<boolean> => {
    session.client.sendSessionEvent({
      type: 'message',
      message: 'Claude unified terminal exited unexpectedly. Waiting for the next message to retry...',
    });
    await flushUnifiedStartupFailureSurface(session, reason);
    const batch = reason === 'host_dead'
      ? await waitForNextParkedSessionInputBatch()
      : await waitForNextSessionInputBatch();
    if (!batch) return false;
    parkedMessage = batch;
    return true;
  };
  const parkForHostRecoveryInput = async (): Promise<boolean> => {
    if (consumeParkRelaunchBudget() === 'exhausted') {
      return await parkAfterRelaunchBudgetExhausted('host_dead');
    }
    return await parkForNextMessageAfterRuntimeIssue('host_dead');
  };
  const isInFlightStartupMessage = (input: Readonly<{
    message: string;
    maxUserMessageSeq?: number | null | undefined;
    userMessageLocalIds?: readonly string[] | null | undefined;
  }>, launchAttempt: number): boolean => {
    return inFlightStartupMessage !== null
      && inFlightStartupMessage.launchAttempt === launchAttempt
      && inFlightStartupMessage.providerMessage === input.message
      && inFlightStartupMessage.batch.maxUserMessageSeq === (input.maxUserMessageSeq ?? null)
      && areSameUserMessageLocalIds(inFlightStartupMessage.batch.userMessageLocalIds, input.userMessageLocalIds);
  };
  const restoreInFlightStartupMessageAfterHostStartupFailure = (): boolean => {
    if (!inFlightStartupMessage) return false;
    const inFlight = inFlightStartupMessage;
    inFlightStartupMessage = null;
    if (inFlight.source === 'initial') {
      initialPromptPending = true;
      return true;
    }
    try {
      session.queue.unshift(inFlight.batch.message, inFlight.batch.mode, {
        userMessageSeq: inFlight.batch.maxUserMessageSeq,
        userMessageLocalIds: inFlight.batch.userMessageLocalIds,
        ...(inFlight.batch.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
        ...(inFlight.batch.pendingProviderAction
          ? { pendingProviderAction: inFlight.batch.pendingProviderAction }
          : {}),
      });
    } catch (error) {
      logger.debug('[unified]: failed to requeue in-flight unified terminal startup message after startup failure', error);
    }
    return false;
  };

  // Initial goal (P1-E4): consumed once from the daemon-provided env and injected on the FIRST
  // launch only; a relaunch (park/respawn) must not re-inject it.
  let pendingInitialGoalObjective = readDaemonInitialGoalFromEnv()?.objective?.trim() || null;
  let unifiedTerminalLaunchAttempt = 0;
  let expectedExistingTerminalHostAttachmentId = opts.expectedExistingTerminalHostAttachmentId?.trim() || undefined;
  const consumeInitialGoalObjective = (): string | undefined => {
    const objective = pendingInitialGoalObjective;
    pendingInitialGoalObjective = null;
    return objective ?? undefined;
  };
  const runUnifiedTerminalSessionOnce = async (): Promise<void> => {
    // Each terminal-host generation gets its own observer. A relaunch binds a newer generation,
    // fencing any late acceptance/rejection callback from the replaced host.
    const providerInputOutcomes = createClaudeUnifiedProviderInputOutcomeBridge(session.client, {
      isCurrentRuntimeMode: () => currentRuntimeMode?.claudeUnifiedTerminalEnabled === true,
    });
    const surfaceGenerationTerminalRuntimeIssue = async (error: unknown) => {
      const effectMayHaveOccurred = isClaudeUnifiedTerminalInjectionFailureError(error)
        && error.failureState === 'failed_ambiguous';
      if (effectMayHaveOccurred) {
        providerInputOutcomes.observeEffectMayHaveOccurred({
          userMessageLocalIds: error.userMessageLocalIds,
        });
        if (isClaudeUnifiedProviderUnavailablePromptDeliveryWindowActive(
          recentPrimaryProviderUnavailableForPromptDelivery,
          Date.now(),
        )) {
          // Positive usage-limit evidence already owns the primary failure. Do not overwrite it
          // with a generic provider-session timeout merely because acceptance remains uncertain.
          return { action: 'surfaced_runtime_issue' } as const;
        }
      }
      // Once the injector may have crossed the provider boundary, the provider leaf publishes
      // typed uncertainty and no longer invents a deterministic provider-acceptance timeout block.
      return await surfaceTerminalRuntimeIssue(error, {
        allowPendingDeliveryBlock: !effectMayHaveOccurred,
      });
    };
    const knownClaudeSessionId = typeof session.sessionId === 'string' && session.sessionId.trim().length > 0
      ? session.sessionId.trim()
      : null;
    const claudeArgs = unifiedTerminalLaunchAttempt === 0
      ? initialPrompt.claudeArgs
      : knownClaudeSessionId
        ? applyClaudeUnifiedTerminalLaunchIntent(initialPrompt.claudeArgs, {
            kind: 'resume_native',
            providerSessionId: knownClaudeSessionId,
          })
        : initialPrompt.claudeArgs;
    unifiedTerminalLaunchAttempt += 1;
    const launchAttempt = unifiedTerminalLaunchAttempt;
    const resumeSessionId = readClaudeResumeSessionId(claudeArgs);
    const startupLifecycle = await prepareClaudeUnifiedStartupLifecycle({
      intent: resumeSessionId
        ? { kind: 'resume_native', providerSessionId: resumeSessionId }
        : hasClaudeContinueArg(claudeArgs)
          ? { kind: 'continue_native' }
          : { kind: 'new_session' },
      binding,
    });
    const sharedTerminalCallbacks = createClaudeUnifiedTerminalSharedCallbacks({
      sessionClient: session.client,
      observeInFlightSteerAvailabilitySnapshot,
      sustainedPendingDeliveryBlockHandler,
      dialogChoiceBroker,
      tuiRuntimeControlEnabled,
      registerStatuslineRuntimeReconciler: (reconcile) =>
        session.setClaudeStatuslineRuntimeReconciler(reconcile),
      getMetadataRuntimeModeApplier: () => applyUnifiedTerminalMetadataMode,
      setMetadataRuntimeModeApplier: (apply) => {
        applyUnifiedTerminalMetadataMode = apply;
      },
      flushPendingMetadataMode: () => applyUnifiedTerminalPermissionMetadata.flushPending(),
      logPrefix: '[unified]',
      logDebug: (message, error) => logger.debug(message, error),
    });
    let launchAttemptSettled = false;
    let returnedExactInFlightMessage = false;
    const settleReturnedExactInFlightMessage = (): void => {
      if (!returnedExactInFlightMessage) return;
      returnedExactInFlightMessage = false;
      if (inFlightStartupMessage?.launchAttempt !== launchAttempt) return;
      const localIds = inFlightStartupMessage.batch.userMessageLocalIds;
      inFlightStartupMessage = null;
      blockUndeliverableProviderPrompt({
        localIds,
        blockPendingMessageDelivery: session.client.blockPendingMessageDelivery?.bind(session.client),
        blockReason: 'runtime_disposed_before_delivery',
        logPrefix: '[unified]',
      });
    };
    const providerDispatch = await sessionInputConsumer.runProviderInputDispatch({
      abortSignal: abortController.signal,
      dispatch: async () => runClaudeUnifiedTerminalSession({
      path: session.path,
      happySessionId: session.client.sessionId,
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      claudeArgs,
      expectedProviderResumeSessionId: resumeSessionId,
      hookSettingsPath: session.hookSettingsPath,
      hookPluginDir: session.hookPluginDir,
      statuslineForwarder: session.claudeStatuslineForwarder ?? undefined,
      happierMcpConfigJson: mcpConfigJson,
      systemPromptText: session.defaultSystemPromptText,
      // A parked message (post-runtime-issue relaunch) must drive the relaunch mode itself,
      // so initialMode stays undefined and the parked batch becomes the first message.
      initialMode: initialPromptPending || parkedMessage || !opts.initialMode
        ? undefined
        : normalizeStartupMode(opts.initialMode),
      // C11 (incident cmq8y3nlx): binding-owned registry, seeded from the persisted prompt store,
      // so a respawned runner recognizes its predecessor's leftover composer injection as our own.
      ownComposerTexts: binding.ownComposerTexts,
      dialogChoiceBroker,
      expectedExistingTerminalHostAttachmentId,
      ...binding.sessionOptions,
      onHistoricalMessage: async (message) => {
        if (binding.shouldSuppressTranscriptMessage(message)) return;
        await transcriptProjector.observeCommitted(message);
      },
      onProviderLaunchStarting: () => startupLifecycle.onProviderLaunchStarting(),
      onProviderSessionStarted: () => {
        startupLifecycle.onProviderSessionStarted();
      },
      onStartupReady: () => startupLifecycle.onStartupReady(),
      signal: abortController.signal,
      // A message pulled from canonical Pending custody during death/dispose must
      // remain server-owned. Missing or plural identity is contract-invalid and
      // cannot be inferred to be a replayable local prompt.
      returnUnconsumedMessage: ({
        message,
        maxUserMessageSeq,
        userMessageLocalIds,
      }) => {
        if (launchAttemptSettled) {
          logger.debug('[unified]: ignored late undeliverable-input callback from a settled terminal launch attempt');
          return;
        }
        if (isInFlightStartupMessage({ message, maxUserMessageSeq, userMessageLocalIds }, launchAttempt)) {
          // Defer the custody decision until this launch attempt settles. A startup/readiness
          // failure is retried by the existing restore path; clean disposal or any other failure
          // still blocks the durable row instead of replaying it from a second owner.
          returnedExactInFlightMessage = true;
          return;
        }
        blockUndeliverableProviderPrompt({
          localIds: userMessageLocalIds,
          blockPendingMessageDelivery: session.client.blockPendingMessageDelivery?.bind(session.client),
          blockReason: 'runtime_disposed_before_delivery',
          logPrefix: '[unified]',
        });
      },
      onPendingQueuePumpPark: async ({ error, failureCount }) => {
        const localIds = readPendingDeliveryLocalIdsFromPumpFailure(error);
        if (localIds.length > 0) {
          await session.client.blockPendingMessageDelivery?.({ localIds, reason: 'unknown' }).catch((blockError) => {
            logger.debug('[unified]: failed to block repeated pending-pump delivery failure (non-fatal)', blockError);
            return false;
          });
        }
        session.client.sendSessionEvent({
          type: 'message',
          message: `Claude could not retrieve queued input after ${failureCount} attempts. Your queued message is paused (not lost); send a new message or retry the paused one to resume delivery.`,
        });
        await flushUnifiedStartupFailureSurface(session, 'pending_queue_pump_park');
      },
      onHostLivenessProbeFailureStarvation: ({ durationMs }) => {
        session.client.sendSessionEvent({
          type: 'message',
          message: `Claude terminal host is not responding to liveness checks for ${Math.max(1, Math.ceil(durationMs / 1_000))} seconds. It is not being torn down automatically because there is no proof it has exited — reconnect to the terminal or restart the session to recover.`,
        });
      },
      // Transcript/hook correlation is Claude unified's exact acceptance boundary. SessionClient
      // retains Queue settlement ownership; this provider leaf emits only the typed evidence.
      onPromptAcceptedByProvider: ({ userMessageLocalIds, appliedModelId }) => {
        consecutiveParkRelaunches = 0;
        resetRecoveryProbeInconclusiveEscalation();
        if (inFlightStartupMessage?.launchAttempt === launchAttempt) inFlightStartupMessage = null;
        returnedExactInFlightMessage = false;
        lastStartupBatchUserMessageLocalIds = [];
        replaySeedRetirement.confirmProviderAccepted(userMessageLocalIds);
        if (!providerInputOutcomes.observeAccepted({ userMessageLocalIds, appliedModelId })) {
          logger.debug('[unified]: ignored provider acceptance without one exact Queue localId outcome binding');
        }
      },
      onPromptTerminallyRejectedBeforeProvider: ({ userMessageLocalIds, reason }) => {
        consecutiveParkRelaunches = 0;
        if (inFlightStartupMessage?.launchAttempt === launchAttempt) inFlightStartupMessage = null;
        returnedExactInFlightMessage = false;
        lastStartupBatchUserMessageLocalIds = [];
        if (!providerInputOutcomes.observeRejectedBeforeEffect({
            userMessageLocalIds,
            reason,
          })) {
          logger.debug('[unified]: ignored pre-effect rejection without one exact Queue localId outcome binding');
        }
      },
      runtimeActivityAdapter: session.getProviderTaskRuntimeActivityAdapter(),
      onWorkflowActivityObserverReady: () => workflowActivitySource?.armStartupReconciliation(),
      // Hands the workflow journal follower the same sidechain importer that already owns this
      // runtime's `Task` sub-agent transcripts, for exactly as long as that importer is alive.
      onSubagentFileCollectorChanged: (collector) => {
        subagentFileCollectorRef = collector;
      },
      providerActivityLedger: session.getProviderTaskActivityLedger() ?? undefined,
      registerTerminalComposerClearRuntimeControl: (clearTerminalComposer) =>
        session.client.registerSessionRuntimeControls?.({ clearTerminalComposer }) ?? (() => undefined),
      registerConnectedServiceExactApplicationHandler: (releaseProviderUi) =>
        session.registerConnectedServiceExactApplicationHandler(releaseProviderUi),
      onConnectedServiceExactApplicationReleased: releaseUsageLimitPendingBlock,
      onPendingInputInterruptAndRunLocalIdChange:
        inFlightSteerCapabilityPublisher.publishPendingInputInterruptAndRunLocalId,
      registerPendingInputInterruptAndRunRuntimeControl: (interruptPendingInputAndRun) =>
        session.client.registerSessionRuntimeControls?.({ interruptPendingInputAndRun }) ?? (() => undefined),
      registerGoalRuntimeControl: (controls) =>
        session.client.registerSessionRuntimeControls?.(controls) ?? (() => undefined),
      // Claude's live `/goal clear` emits no goal_status, so the clear effector deterministically
      // removes the goal work-state item via the projector-owned goal source.
      clearGoalWorkState: () => transcriptProjector.clearGoalWorkState(),
      // Record the SET epoch when `/goal <objective>` reaches the terminal, so re-setting the same
      // objective after a clear is accepted instead of being suppressed as a stale replay (G2).
      recordGoalSetIntent: () => transcriptProjector.recordGoalSetIntent(),
      // Native Claude `/goal` source (plan H7): the goal_status attachment + the
      // system/init slash_commands ride the raw transcript channel (the scanner drops
      // them before `onMessage`). Feed the centralized goal source via the projector;
      // it keeps them out of the visible transcript.
      onRawTranscriptValue: (value, observation) => {
        transcriptProjector.observeRaw(value, observation);
      },
      initialGoalObjective: consumeInitialGoalObjective(),
      nextMessage: async () => {
        await session.connectedServiceAuthGroupRequestFence?.waitUntilAvailable(abortController.signal);
        if (parkedMessage) {
          const parked = parkedMessage;
          const mode = observeOutgoingBatchMode(parked.mode);
          const rawBatch = { ...parked, mode };
          const providerBatch = await resolveQueuedPromptForProvider(rawBatch);
          parkedMessage = null;
          inFlightStartupMessage = {
            source: 'parked',
            batch: rawBatch,
            providerMessage: providerBatch.message,
            launchAttempt,
          };
          noteStartupBatchLocalIds(parked.userMessageLocalIds);
          binding.noteNextInjectedPromptShouldSuppressEcho({ retainUntilObserved: true });
          return providerBatch;
        }
        if (initialPromptPending && initialPrompt.prompt) {
          initialPromptPending = false;
          binding.noteNextInjectedPromptShouldImportEcho();
          const initialBatchMode = observeOutgoingBatchMode(opts.initialMode ?? {
            permissionMode: session.lastPermissionMode ?? 'default',
            claudeUnifiedTerminalEnabled: true,
          });
          const rawBatch: ParkedUnifiedTerminalMessage = {
            message: initialPrompt.prompt,
            mode: initialBatchMode,
            maxUserMessageSeq: null,
            userMessageLocalIds: [],
          };
          const providerBatch = await resolveQueuedPromptForProvider(rawBatch);
          inFlightStartupMessage = {
            source: 'initial',
            launchAttempt,
            batch: rawBatch,
            providerMessage: providerBatch.message,
          };
          noteStartupBatchLocalIds([]);
          return {
            message: providerBatch.message,
            mode: providerBatch.mode,
          };
        }
        initialPromptPending = false;
        const batch = await waitForNextSessionInputBatch();
        if (!batch) return null;
        const mode = observeOutgoingBatchMode(batch.mode);
        const rawBatch = {
          message: batch.message,
          mode,
          maxUserMessageSeq: batch.maxUserMessageSeq,
          userMessageLocalIds: batch.userMessageLocalIds,
          ...(batch.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
          ...(batch.pendingProviderAction ? { pendingProviderAction: batch.pendingProviderAction } : {}),
        } satisfies ParkedUnifiedTerminalMessage;
        const providerBatch = await resolveQueuedPromptForProvider(rawBatch);
        inFlightStartupMessage = {
          source: 'queue',
          launchAttempt,
          batch: rawBatch,
          providerMessage: providerBatch.message,
        };
        noteStartupBatchLocalIds(batch.userMessageLocalIds);
        binding.noteNextInjectedPromptShouldSuppressEcho({ retainUntilObserved: true });
        return providerBatch;
      },
      subscribeClaudeSessionHooks: (callback) => {
        session.addClaudeSessionHookCallback(callback);
        return () => {
          session.removeClaudeSessionHookCallback(callback);
        };
      },
      loadCommittedClaudeJsonlMessageBaseline: () =>
        session.client.fetchCommittedClaudeJsonlMessageBaseline?.()
        ?? { keys: new Set<string>(), complete: true, oldestCoveredAtMs: null },
      // Unknown canonical state (no accessor) counts as ACTIVE (fail-closed).
      isCanonicalTurnActive: () => session.client.hasActiveCanonicalTurn?.() ?? true,
      resolvePromptDeliveryState: (batch) => {
        const localId = batch.userMessageLocalIds?.length === 1
          ? batch.userMessageLocalIds[0]
          : undefined;
        if (!localId) return 'pending';
        if (session.client.hasPendingProviderInputAcceptance?.(localId) === true) return 'accepted';
        return session.client.hasCanonicalPendingProviderInputDelivery?.(localId) === false
          ? 'retired'
          : 'pending';
      },
      // Persist a consumed marker for controller-command echoes the runner suppresses, so they
      // join the committed baseline and cannot replay as "new" messages after a respawn
      // (resume-replay leak, 2026-06-11).
      onTranscriptMessageSuppressed: (message) => {
        session.client.recordClaudeJsonlMessageConsumed?.(message, {
          suppressedBy: 'control_command_echo',
        });
      },
      onInFlightSteerAvailabilitySnapshot: observeInFlightSteerAvailabilitySnapshot,
      registerInFlightSteerAvailabilityRefresh: (refresh) => {
        refreshInFlightSteerAvailability = refresh;
        return () => {
          if (refreshInFlightSteerAvailability === refresh) {
            refreshInFlightSteerAvailability = null;
          }
        };
      },
      onTerminalScreenObserved: observeTerminalScreen,
      // Lane X (incident cmq8y3nlx): one honest notice per starvation episode instead of a silent
      // 15s retry loop — the queued message is blocked by a draft in the terminal composer.
      onInFlightSteerUserDraftStarvation: () => {
        observeInFlightSteerAvailabilitySnapshot({ available: false, reason: 'user_terminal_draft' });
        session.client.sendSessionEvent(createTerminalComposerDraftBlockedEvent('in_flight_steer'));
      },
      ...sharedTerminalCallbacks,
      onSessionFound: (sessionId, data) => {
        session.onSessionFound(sessionId, data);
      },
      onThinkingChange: (thinking) => {
        session.onThinkingChange(thinking);
      },
      onUsageLimitDetails: surfaceRateLimit,
      onRuntimeAuthFailureEvent: async (error) => {
        try {
          const surfaced = await surfaceClaudeRuntimeAuthFailure(session, error, '[unified]');
          if (surfaced) {
            lastSurfacedRuntimeAuthFailureAtMs = Date.now();
            lastSurfacedRuntimeAuthRecoveryWillContinue = isClaudeRuntimeAuthRecoveryContinuing(error);
          }
        } finally {
          binding.notePromptTurnTerminal();
        }
      },
      onPromptTurnTerminal: surfacePromptTurnTerminal,
      onTerminalInjectionFailure: surfaceGenerationTerminalRuntimeIssue,
      onTerminalHostReady: async ({ handle, terminal, destroyOwnedHostForExplicitStop }) => {
        if (handle.attachmentId) {
          expectedExistingTerminalHostAttachmentId = handle.attachmentId;
        }
        startForegroundAttach({
          sessionId: session.client.sessionId,
          terminal,
        });
        await opts.onTerminalHostReady?.({
          handle,
          terminal,
          // Wrapped to RECORD the one observation the teardown cannot make for itself: that WE
          // destroyed the host, so everything that was running inside it — including the detached
          // background shells nothing else can report on — died with it. Set only after the
          // disposal resolves: a failed destroy leaves the host, and its shells, alive.
          destroyOwnedHostForExplicitStop: async () => {
            await destroyOwnedHostForExplicitStop();
            ownedTerminalHostDestroyedForExplicitStop = true;
          },
        });
      },
      publishTerminalHostMetadata: (terminal) => session.publishUnifiedTerminalHostMetadata(terminal),
      }),
    }).catch((error: unknown) => {
      launchAttemptSettled = true;
      if (
        returnedExactInFlightMessage
        && !isClaudeUnifiedTerminalReadinessTimeoutError(error)
        && !(
          isClaudeUnifiedTerminalRuntimeIssueError(error)
          && isTerminalHostStartupError(error)
        )
      ) {
        settleReturnedExactInFlightMessage();
      }
      throw error;
    });
    launchAttemptSettled = true;
    settleReturnedExactInFlightMessage();
    if (providerDispatch.status === 'cancelled') {
      return;
    }
  };

  try {
    while (true) {
      try {
        await runUnifiedTerminalSessionOnce();
        return { type: 'exit', code: 0 };
      } catch (error) {
        // hostres-ff: track consecutive inconclusive recovery probes across relaunches so a wedged
        // host escalates once (durable) instead of looping silently. Any non-inconclusive outcome is
        // real progress off the inconclusive path and resets the episode. This is additive bookkeeping
        // only — the existing branches below own the actual park/relaunch control flow.
        if (isRecoveryProbeInconclusiveError(error)) {
          noteRecoveryProbeInconclusiveAndMaybeEscalate(error);
        } else {
          resetRecoveryProbeInconclusiveEscalation();
        }
        if (isClaudeUnifiedTerminalHostDeadError(error)) {
          session.onThinkingChange(false);
          if (isRecentClaudeUnifiedTerminalAuthFailure({
            authFailureAtMs: lastSurfacedRuntimeAuthFailureAtMs,
            nowMs: Date.now(),
          })) {
            logger.debug('[unified]: terminal host died after Claude auth failure; keeping auth diagnostic primary');
            await flushUnifiedStartupFailureSurface(session, 'host_dead_after_auth_failure');
            binding.notePromptTurnTerminal();
            if (lastSurfacedRuntimeAuthRecoveryWillContinue) {
              lastSurfacedRuntimeAuthRecoveryWillContinue = false;
              continue;
            }
            if (await parkForHostRecoveryInput()) continue;
            return { type: 'exit', code: 1 };
          }
          await surfacePrimarySessionRuntimeIssue({
            provider: 'claude',
            cause: 'process_exit',
            error,
            session: session.client,
            // Host death routinely lands between turns (incident cmq8y3nlx); an
            // idle lifecycle must still surface it instead of no-opping.
            allocateTurnWhenIdle: true,
          }).catch((surfaceError) => {
            logger.debug('[unified]: failed to surface Claude unified terminal host death (non-fatal)', surfaceError);
            return null;
          });
          sendUnifiedTerminalHostDeadMessage(session, {
            promptDeliveryWasPending: Boolean(initialPromptPending || parkedMessage || inFlightStartupMessage),
          });
          await flushUnifiedStartupFailureSurface(session, 'host_dead');
          binding.notePromptTurnTerminal();
          if (await parkForHostRecoveryInput()) continue;
          return { type: 'exit', code: 1 };
        }
        if (isClaudeUnifiedTerminalReadinessTimeoutError(error)) {
          // Readiness is an input-admission signal, not host-death evidence. The provider may already
          // be alive and progressing while screen capture is unavailable (incidents cmrhn5/cmrraa).
          // Preserve the exact attachment and retry adoption in this SAME wrapper; exiting here would
          // publish session death while leaving Claude alive in an orphan terminal host.
          restoreInFlightStartupMessageAfterHostStartupFailure();
          await surfaceTerminalRuntimeIssue(error);
          await flushUnifiedStartupFailureSurface(session, 'readiness_timeout');
          if (consumeParkRelaunchBudget() === 'within_budget') continue;
          if (await parkAfterRelaunchBudgetExhausted('readiness_timeout')) continue;
          return { type: 'exit', code: 1 };
        }
        if (
          isInvalidPromptTextInjectionFailure(error)
          || isClaudeUnifiedTerminalManagedSettingsOptionError(error)
        ) {
          await surfaceTerminalRuntimeIssue(error);
          await flushUnifiedStartupFailureSurface(
            session,
            isInvalidPromptTextInjectionFailure(error)
              ? 'invalid_prompt_text'
              : 'managed_settings_option',
          );
          return { type: 'exit', code: 1 };
        }
        if (isClaudeUnifiedTerminalRecoverableProviderAcceptanceUnknownFailure(error)) {
          session.onThinkingChange(false);
          await binding.recordPromptTurnCancelled().catch((cancelError) => {
            logger.debug('[unified]: failed to cancel Claude unified delivery-unknown turn (non-fatal)', cancelError);
          });
          sendUnifiedTerminalDeliveryUnknownMessage(session);
          await flushUnifiedStartupFailureSurface(session, 'provider_acceptance_unknown');
          return { type: 'exit', code: 1 };
        }
        if (error instanceof PendingQueueMaterializationAuthError) {
          logger.debug('[unified]: pending-queue pump stopped after supervisor auth failure; parking for recovered input');
          if (await parkForNextMessageAfterRuntimeIssue('pending_queue_auth_failure')) continue;
          return { type: 'exit', code: 1 };
        }
        if (isClaudeUnifiedTerminalRuntimeIssueError(error)) {
          // Classified injection failure: surface structured, park for the next message, relaunch.
          // Never rethrow into `[claude] Fatal command error` (incident cmq7pyqkj).
          // Budget check precedes the startup-message restore: on exhaustion the poisoned batch
          // must be paused as a durable row, not re-queued locally where the park wait would
          // immediately re-feed it (RC-RESUMEFLAP).
          if (consumeParkRelaunchBudget() === 'exhausted') {
            await surfaceTerminalRuntimeIssue(error);
            if (await parkAfterRelaunchBudgetExhausted('injection_failure')) continue;
            return { type: 'exit', code: 1 };
          }
          const shouldRetryRestoredStartupMessage = isTerminalHostStartupError(error)
            && restoreInFlightStartupMessageAfterHostStartupFailure();
          await surfaceTerminalRuntimeIssue(error);
          if (shouldRetryRestoredStartupMessage) continue;
          if (await parkForNextMessageAfterRuntimeIssue('injection_failure')) continue;
          return { type: 'exit', code: 1 };
        }
        throw error;
      }
    }
  } finally {
    // An accepted prompt may end the terminal session before its metadata write resolves. Do not
    // let the next launcher instance observe the seed as still live.
    await replaySeedRetirement.drain();
    // This teardown is the OBSERVATION that the provider process is gone: resolve every
    // shutdown-sensitive source the projector owns before the sources are drained and disposed.
    // G-6 marks an active-but-unmet goal interrupted; RULING-14 resolves live workflow runs and
    // their agents so they stop reading as "Working" forever.
    transcriptProjector.finalizeInterruptedWorkOnShutdown();
    // Background shells are the one kind that can OUTLIVE the provider, so they are resolved on a
    // narrower fact than the rest: not "we are tearing down" but "we destroyed the host they lived
    // in". After a crash the shell may genuinely still be writing, and nothing would ever correct a
    // `cancelled` record — no startup reconcile reads this namespace.
    if (ownedTerminalHostDestroyedForExplicitStop) {
      try {
        workflowActivitySource?.finalizeBackgroundTaskRecordsOnOrderlyStop();
      } catch (error) {
        logger.debug('[unified]: failed to resolve background task records on explicit stop (non-fatal)', error);
      }
    }
    // Drain any pending workflow-activity writes, then stop scheduling (dispose via reset()).
    await transcriptProjector.flushWorkflowActivity();
    transcriptProjector.reset();
    await dialogChoiceBroker.dispose();
    inFlightSteerCapabilityPublisher.dispose();
    removeExternalAbortListener?.();
  }
}
