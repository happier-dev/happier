import { isNonSteerablePromptPayload, parseSpecialCommand } from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { sleep } from '@happier-dev/plugin-sdk/experimental/timeout';
import type {
  TerminalHostHandle,
  TerminalHostPreference,
  TerminalControlPort,
  TerminalPromptInput,
  TerminalInputInjectionResult,
  SessionTerminalComposerClearResultV1,
  RuntimeConfigUpdateOutcomeV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import {
  createSessionRuntimeActivityPublisher,
  type PluginContextV1,
  type RuntimeEventV1,
} from '@happier-dev/plugin-sdk';
import { randomUUID } from 'node:crypto';
import {
  buildClaudeHookPluginHooks,
  buildClaudeHookPluginManifest,
} from '../../../hooks/settings.js';
import { buildDefaultPermissionHookResponse } from '../../../hooks/protocol.js';
import { resolveClaudePermissionHookCeilingMs } from '../../../hooks/permissionHookTimeout.js';
import { createClaudeStatuslineApplier } from '../../../statusline/apply.js';
import {
  buildClaudeStatuslineOverlaySettings,
  resolveClaudeStatuslineOriginalCommand,
  type ClaudeStatuslineOverlaySettings,
} from '../../../statusline/overlay.js';
import { parseClaudeStatuslinePayload } from '../../../statusline/payload.js';

import { recordClaudeRuntimeProviderAccountUsageSnapshot } from '../../accountUsage.js';
import { createClaudeConnectedServiceRuntimeAuthAdapter } from '../../../auth/services/runtime/index.js';
import type { ClaudeTerminalLifecycleObservation } from '../lifecycle.js';
import { CLAUDE_TERMINAL_YOLO_ALLOW_FLAG } from '../argv.js';
import { buildClaudeEffortCliArgs, isClaudeUltracodeSupportedModelId } from '../../reasoningEffort.js';
import { mapToClaudePermissionMode, resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import { isSidechainSessionHook } from '../../../hooks/sidechain.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';
import {
  createClaudeUnifiedInputArbiter,
  type ClaudeUnifiedInputArbiter,
  type ClaudeUnifiedPromptDeliveryBlockedReason,
  type ClaudeUnifiedPromptInjectionFailure,
  type ClaudeUnifiedPromptTerminalRejection,
} from './inputArbiter.js';
import { subscribeClaudeUnifiedTerminalLifecycleEvents } from './lifecycleEvents.js';
import { createPersistedClaudeUnifiedOwnInjectedTextLog } from './ownInjectedTextLog.js';
import { isControllerTypedSlashCommandResidue } from './tuiControls/slashControls.js';
import {
  hasClaudeUnifiedVisibleDialog,
  resolveClaudeUnifiedDialogBlockedReason,
  type ClaudeUnifiedDialogBlockedReason,
} from './tuiControls/dialogRegistry.js';
import { createClaudeUnifiedPermissionHookHandler } from './permissionHooks.js';
import { createClaudeUnifiedPromptEchoSuppressor } from './promptEchoSuppression.js';
import { createClaudeUnifiedTerminalOriginLocalIdAllocator } from './terminalOriginLocalIds.js';
import { isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate } from './composerCaptureClassification.js';
import {
  isClaudeScreenReadyForInput,
  parseClaudeScreenState,
  resolveClaudeScreenInFlightSteerVeto,
} from './screenState.js';
import { createClaudeUnifiedProviderTranscriptPublisher } from './providerTranscript.js';
import { createClaudeUnifiedGoalRuntime } from './goalRuntime.js';
import {
  createClaudeUnifiedWorkflowRuntime,
  registerClaudeWorkflowOwnedToolUseIds,
} from '../../../workflowRecords/index.js';
import {
  createClaudeUnifiedRuntimeConfigOutcomeEmitter,
  mapApplyOutcomeToUpdateOutcome,
  mapRuntimeConfigUpdateToDesired,
  type ClaudeUnifiedRuntimeConfigOutcomeSessionEvent,
} from './runtimeControlIntegration.js';
import {
  CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID,
  DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS,
  createClaudeSettingsGuard,
  createClaudeTuiControlTelemetrySink,
  createClaudeUnifiedTuiControlController,
  clearUserAuthorizedClaudeComposerDraft,
  resolveClaudeConfigRootFromEnv,
  type ClaudeComposerClearRefusalReason,
  type ClaudeUserAuthorizedComposerClearResult,
  type ClaudeTuiControlTimings,
  type RuntimeConfigApplyOutcome,
  type ClaudeUnifiedTuiControlController,
} from './tuiControls/index.js';
import { createClaudeUnifiedSteerCapabilityPublisher } from './steerCapabilityPublisher.js';
import { createClaudeUnifiedTerminalRuntimeState } from './runtimeState.js';
import {
  ClaudeUnifiedTerminalInjectionFailureError,
  recordClaudeUnifiedProcessExitFailure,
  recordClaudeUnifiedTurnFailure,
} from './turnFailures.js';
import { mapClaudeProviderFailureToUsageDetails } from '../../issues/runtimeIssues.js';
import {
  isClaudeUnifiedProviderUnavailablePromptDeliveryWindowActive,
  resolveClaudeUnifiedProviderUnavailableUntilMs,
  type ClaudeUnifiedProviderUnavailablePromptDeliveryWindow,
} from './providerUnavailablePromptDelivery.js';
import {
  publishClaudeUnifiedRuntimeEvent,
  publishClaudeUnifiedTurnCancelled,
  publishClaudeUnifiedTurnComplete,
  publishClaudeUnifiedTurnStart,
} from './runtimeEvents.js';
import {
  createClaudeUnifiedPromptInput,
  createClaudeUnifiedTerminalSessionName,
  createClaudeUnifiedTurnId,
  createClaudeUnifiedWritableReadiness,
} from './turnInput.js';
import { createTerminalComposerDraftBlockedEvent } from './terminalComposerDraftBlockedEvent.js';
import {
  createClaudeUnifiedResumeChoiceStartupHandler,
  type ClaudeUnifiedResumeChoiceStartupResult,
} from './resumeChoice/startup.js';
import type { ClaudeUnifiedResumeChoicePolicy } from './resumeChoice/types.js';
import {
  createClaudePublicSessionRuntime,
  type ClaudePublicSessionRuntime,
  type ClaudeRuntimeTurnOperations,
} from '../../sessionRuntime.js';
import {
  buildClaudeProviderTaskRuntimeActivitySourceId,
  createClaudeProviderActivityLedger,
} from '../../remote/sdk/providerActivity.js';
import {
  clearClaudeRuntimeActivitySources,
  observeClaudeProviderTaskActivity,
  publishClaudeProviderSessionId,
  publishClaudeRuntimeActivityUpdate,
  readClaudeRuntimeConfigEffortUpdate,
  readClaudeRuntimeConfigUltracodeUpdate,
  respondToClaudePermission,
} from '../../shared/runtimeHelpers.js';

const claudeUnifiedTerminalRuntimeAuthAdapter = createClaudeConnectedServiceRuntimeAuthAdapter();

/**
 * Route a NON-sidechain StopFailure that carries authentication-failure evidence (an expired/invalid
 * OAuth token, not a usage/rate limit) into the daemon's runtime-auth recovery owner. Without this the
 * unified terminal only recorded the failure as a turn failure + usage snapshot and the auth-failed
 * session was never reactively recovered. We report via the SDK auth service with NO `selection`, which
 * takes the daemon report-recovery path (`reportConnectedServiceRuntimeAuthFailureToDaemon`) WITHOUT
 * attempting a token refresh whose result the already-running claude-code process could not adopt
 * anyway. Sidechain (subagent, `agent_id`) auth StopFailures are gated out by the caller (they describe
 * a subagent request, not the parent session's credentials — incident cmq8171vw). Best-effort.
 */
async function reportClaudeUnifiedTerminalStopFailureRuntimeAuth(params: Readonly<{
  ctx: PluginContextV1;
  happierSessionId: string;
  evidence: unknown;
}>): Promise<void> {
  const refreshRuntimeAuth = params.ctx.sessions.current.auth?.services?.refreshRuntimeAuth;
  if (typeof refreshRuntimeAuth !== 'function') return;
  const classification = claudeUnifiedTerminalRuntimeAuthAdapter.classifyRuntimeAuthFailure({
    target: { agentId: 'claude' },
    selection: { serviceId: 'claude-subscription' },
    error: params.evidence,
  });
  // Only genuine auth failures route to recovery; usage/rate/capacity classifications stay on the
  // existing usage-snapshot path.
  if (!classification || (classification.limitCategory !== 'auth_invalid' && classification.kind !== 'auth_expired')) {
    return;
  }
  await refreshRuntimeAuth({
    agentId: 'claude',
    serviceId: 'claude-subscription',
    targetId: params.happierSessionId,
    reason: 'claude_unified_terminal_stop_failure_auth',
    classification,
  }).catch(() => undefined);
}

const DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS = 5_000;
const DEFAULT_QUEUED_BANNER_CUSTODY_CHECK_DELAY_MS = 400;
const DEFAULT_QUEUED_BANNER_CUSTODY_RETRY_DELAYS_MS = [
  DEFAULT_QUEUED_BANNER_CUSTODY_CHECK_DELAY_MS,
  1_200,
  3_000,
] as const;

// Startup-readiness window: a live host that is still rendering may take longer than the
// base window to show an interactive composer. SessionStart evidence (or a progressing
// live screen) extends the wait up to the hard ceiling; a silent, unconfirmed host
// fast-fails after the base window plus a short progress grace.
const DEFAULT_STARTUP_READINESS_BASE_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_READINESS_EXTENDED_TIMEOUT_MS = 60_000;
const DEFAULT_STARTUP_READINESS_PROGRESS_GRACE_MS = 8_000;
const DEFAULT_STARTUP_READINESS_POLL_INTERVAL_MS = 1_000;
const READINESS_DIAGNOSTIC_TAIL_MAX_LINES = 40;
const READINESS_DIAGNOSTIC_TAIL_MAX_CHARS = 2_000;

// user_draft starvation (incident 294-veto loop, lane X1): a leftover composer draft blocks
// every injection/steer window. An OWN exact-match leftover on a non-generating screen is
// cleared with a bounded Escape; a persisting (genuine) draft escalates ONCE per episode into
// an honest blocking notice instead of starving silently.
const MAX_OWN_LEFTOVER_DRAFT_CLEAR_ATTEMPTS = 2;
const USER_DRAFT_STARVATION_VETO_THRESHOLD = 4;
const USER_DRAFT_STARVATION_MIN_EPISODE_MS = 15_000;
const USER_DRAFT_STARVATION_RECHECK_MS = 30_000;

// Stale-turn recovery (incident cmq7pyqkj, L1): when a prompt is queued behind a turn whose
// completion evidence was lost, a bounded window of provider silence plus idle-composer screen
// evidence reconciles the turn so the queued prompt can drain as a new turn. Demand-driven only —
// never an idle completion watchdog (a quiet accepted turn with no queued prompt keeps waiting).
const DEFAULT_STALE_TURN_RECOVERY_WINDOW_MS = 30_000;
const DEFAULT_STALE_TURN_RECOVERY_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ACTIVE_TURN_PROGRESS_INTERVAL_MS = 60_000;

// Turn-end/idle dialog probe (incident: a queued control such as `/effort` pops a dialog AFTER the
// turn goes terminal into an idle session with no further screen observations). After a turn settles
// the dialog registry is re-evaluated on a bounded idle re-arm schedule (absolute offsets in ms from
// settle): the first two shots catch a dialog that renders a beat after Stop, and the backoff tail
// keeps re-evaluating for ~a minute so a late dialog is still surfaced instead of a silent hang. The
// tail is strictly bounded — it stops early once a dialog is surfaced/answered or the screen is clear,
// and escalates ONCE at exhaustion (no infinite polling).
const DEFAULT_DIALOG_TURN_END_PROBE_DELAYS_MS: readonly number[] = [0, 1_500, 5_000, 15_000, 30_000, 60_000];

// A registry-recognized dialog that owns terminal input while a prompt is queued blocks delivery. The
// dialog is routed to the resolver (published for a user decision) before deferring; if it stays
// unresolved past this bounded window the block escalates ONCE (one-shot latch) and projects a durable
// block via the existing `runtime_config_blocked` reason. Configurable, clamped to [1s, 5min].
const DEFAULT_DIALOG_INJECTION_BLOCK_ESCALATION_MS = 15_000;
const MIN_DIALOG_INJECTION_BLOCK_ESCALATION_MS = 1_000;
const MAX_DIALOG_INJECTION_BLOCK_ESCALATION_MS = 300_000;

function sanitizeTurnEndProbeDelaysMs(delays: readonly number[] | undefined): readonly number[] {
  const source = delays ?? DEFAULT_DIALOG_TURN_END_PROBE_DELAYS_MS;
  const sanitized = source
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map((value) => Math.max(0, Math.trunc(value)));
  return sanitized.length > 0 ? sanitized : DEFAULT_DIALOG_TURN_END_PROBE_DELAYS_MS;
}
const MAX_RECENT_PROVIDER_PROMPT_SUBMISSIONS = 64;
const PROVIDER_CLAIMED_PENDING_PREFIX_RESIDUE_MIN_CHARS = 16;

export type ClaudeUnifiedTerminalTurnOperationsParams = Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  hostPreference: TerminalHostPreference;
  launchEnv: Readonly<Record<string, string>>;
  permissionMode: string | null;
  /** Persisted workflow headline from the session snapshot that created this runtime. */
  initialWorkflowActivityHeadline?: unknown;
  knownProviderSession?: Readonly<{
    providerSessionId: string;
    transcriptPath: string;
  }> | null;
  setThinking?: (thinking: boolean) => void;
  startupReadiness?: Readonly<{
    baseTimeoutMs?: number;
    extendedTimeoutMs?: number;
    progressGraceMs?: number;
    pollIntervalMs?: number;
  }>;
  staleTurnRecovery?: Readonly<{
    windowMs?: number;
    pollIntervalMs?: number;
  }>;
  /** Test seam for the TUI runtime-control controller (settle/verification delays). */
  tuiControl?: Readonly<{
    timings?: Partial<ClaudeTuiControlTimings>;
  }>;
  /**
   * Startup policy for Claude's heavy-session interstitial ("Resume from summary" vs full
   * session). Defaults to asking the user through the existing AskUserQuestion permission surface.
   */
  resumeChoice?: ClaudeUnifiedResumeChoicePolicy | null | undefined;
  /**
   * Dialog-resolution tuning (test seam). `turnEndProbeDelaysMs` are the absolute offsets (from turn
   * settle) of the bounded turn-end/idle dialog re-arm tail; `injectionBlockEscalationMs` is the
   * one-shot escalation window for a registry-recognized dialog blocking prompt delivery.
   */
  dialogResolution?: Readonly<{
    turnEndProbeDelaysMs?: readonly number[];
    injectionBlockEscalationMs?: number;
  }>;
}>;

/**
 * Outcome of an in-flight permission-mode delta application (the host's steer-config seam):
 * `applied`/`scheduled_in_turn` let the steered text join the running turn; `unsupported`/`failed`
 * send the message back to the legacy queue path (mode applies when the queue drains).
 */
export type ClaudeUnifiedInFlightConfigApplyOutcome = Readonly<
  | { status: 'applied' }
  | { status: 'scheduled_in_turn' }
  | { status: 'unsupported'; reason?: string | undefined }
  | { status: 'failed'; reason?: string | undefined }
>;

type TurnCompletionWaiter = Readonly<{
  resolve(): void;
  reject(error: Error): void;
}>;

type ClaudeUnifiedSessionHookServer = Awaited<ReturnType<PluginContextV1['agentRuntime']['sessionHooks']['startServer']>> & Readonly<{
  sessionHookSecretFile?: string;
  permissionHookSecretFile?: string;
}>;

type SessionTerminalComposerClearFailureStatusV1 = Extract<
  SessionTerminalComposerClearResultV1,
  { ok: false }
>['status'];

type ClaudeUnifiedPromptDeliveryBlockerClear = Readonly<{
  deliveryBlockedReason?: ClaudeUnifiedPromptDeliveryBlockedReason;
}>;

type ClaudeUnifiedTerminalNativeRuntime = ClaudeRuntimeTurnOperations & Readonly<{
  confirmProviderAcceptance(evidence?: Readonly<{ promptText?: string; includeTimedOutAmbiguous?: boolean; agentTurnId?: string | null }>): Promise<boolean>;
  observeTerminalLifecycle(observation: ClaudeTerminalLifecycleObservation): Promise<void>;
  /**
   * HF-1 (A3-HIGH-1) provider-acceptance watermark seam: the host opts the session's
   * owed-delivery watermark into deferral and confirms accepted row seqs through this handler.
   * Fired ONLY at arbiter acceptance (transcript/hook-confirmed evidence) — injection alone is
   * never acceptance.
   */
  setOnPromptAcceptedByProvider(handler: (info: ClaudeUnifiedPromptDeliveryIdentity) => void): void;
  /**
   * Deterministic pre-provider terminalization seam: input rejected before provider custody for
   * a non-retryable prompt-text reason is handled once and must advance durable pending state.
   */
  setOnPromptTerminallyRejectedBeforeProvider(
    handler: (info: ClaudeUnifiedPromptDeliveryIdentity) => void,
  ): void;
  setOnPromptDeliveryBlockerCleared(
    handler: (info?: ClaudeUnifiedPromptDeliveryBlockerClear) => void,
  ): void;
  /**
   * HF-2 (F-1) undeliverable-prompt handback: prompts still queued/unaccepted when the runtime
   * is disposed are handed back (FIFO) so the host can re-pend them instead of losing them.
   */
  setOnUndeliverablePrompts(
    handler: (prompts: ReadonlyArray<ClaudeUnifiedUndeliverablePrompt>) => void,
  ): void;
  sendTurnPrompt(prompt: string, meta?: ClaudeUnifiedPromptDeliveryMeta): Promise<void>;
  /**
   * ACTIVE-session native `/goal` controls (read off the native runtime by
   * runHostSessionRuntime's SessionRuntimeControls forwarder). Inject a literal
   * `/goal …` user turn; the resulting `goal_status` attachment is the source of
   * truth. Return a typed `{ ok:false, errorCode }` on failure (never throw).
   */
  setGoal(
    objective: string | undefined,
    options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
  ): Promise<unknown>;
  clearGoal(): Promise<unknown>;
  // Host session-loop in-flight steer hooks (read off the native runtime by
  // runHostSessionRuntime's InFlightSteerController).
  supportsInFlightSteer(): boolean;
  isTurnInFlight(): boolean;
  canSteerPrompt(): boolean;
  steerPrompt(prompt: string, options?: ClaudeUnifiedPromptDeliveryMeta): Promise<void>;
  // Demand signal from the host: a prompt was queued behind the running turn (mode change /
  // special command / steer fallback). Arms the bounded stale-turn recovery check.
  notifyPromptQueuedDuringTurn(): void;
  /**
   * Apply a steered message's PERMISSION-MODE delta to the RUNNING turn (probe Q-A steer-safe
   * generating window) so the message can steer instead of deferring to turn end. Gated behind
   * the TUI runtime-control feature; without it the result is `unsupported` and the message
   * keeps the legacy queue path.
   */
  applyConfigDeltaInFlight(delta: Readonly<{ permissionMode: string }>): Promise<ClaudeUnifiedInFlightConfigApplyOutcome>;
  clearTerminalComposer(request?: Readonly<{ sessionId?: string }>): Promise<SessionTerminalComposerClearResultV1>;
}>;

type ClaudeUnifiedPromptDeliveryMeta = Readonly<{
  localId?: string | null;
  localIds?: readonly string[];
  providerClaimedPendingLocalIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;

type ClaudeUnifiedPromptDeliveryIdentity = Readonly<{
  localIds?: readonly string[];
  userMessageSeq: number | null;
  userMessageSeqs?: readonly number[];
  deliveryBlockedReason?: ClaudeUnifiedPromptDeliveryBlockedReason;
}>;

type RecentProviderPromptSubmissionEvidence = Readonly<{
  promptText: string;
  agentTurnId: string | null;
  queuedCommandEvidence: boolean;
}>;

type ClaudeUnifiedUndeliverablePrompt = Readonly<{
  text: string;
  localIds?: readonly string[];
  userMessageSeq: number | null;
  userMessageSeqs?: readonly number[];
}>;

function mapComposerClearRefusalStatus(
  reason: ClaudeComposerClearRefusalReason,
): SessionTerminalComposerClearFailureStatusV1 {
  switch (reason) {
    case 'generating':
    case 'queued_message_banner':
      return 'generating';
    case 'no_interactive_composer':
      return 'not_safe';
    case 'permission_prompt':
    case 'permission_editor':
    case 'trust_prompt':
    case 'switch_model_dialog':
    case 'resume_choice_dialog':
    case 'effort_change_dialog':
    case 'unrecognized_confirmation_dialog':
    case 'slash_picker':
    case 'selection_list':
      return 'dialog_open';
  }
}

function mapComposerClearFailureStatus(
  reason: string,
): SessionTerminalComposerClearFailureStatusV1 {
  if (reason.startsWith('host_dead:')) return 'host_dead';
  if (reason.startsWith('capture_unsupported:') || reason.startsWith('capture_failed:')) {
    return 'capture_unavailable';
  }
  return 'clear_failed';
}

function mapComposerClearResult(
  sessionId: string,
  result: ClaudeUserAuthorizedComposerClearResult,
): SessionTerminalComposerClearResultV1 {
  switch (result.status) {
    case 'cleared':
    case 'already_empty':
      return { ok: true, status: result.status, sessionId };
    case 'refused':
      return {
        ok: false,
        status: mapComposerClearRefusalStatus(result.reason),
        sessionId,
        error: result.reason,
      };
    case 'unsupported':
      return { ok: false, status: 'unsupported', sessionId, error: result.reason };
    case 'failed':
      return {
        ok: false,
        status: mapComposerClearFailureStatus(result.reason),
        sessionId,
        error: result.reason,
      };
  }
}

function createProviderAcceptancePendingError(
  snapshot: ReturnType<ClaudeUnifiedInputArbiter['snapshot']>,
  failureState: 'failed_terminal' | 'failed_ambiguous' = 'failed_terminal',
): Error {
  const suffix = snapshot.lastFailureReason ? `: ${snapshot.lastFailureReason}` : '';
  return new ClaudeUnifiedTerminalInjectionFailureError(
    `Claude unified terminal prompt is awaiting provider acceptance${suffix}`,
    failureState,
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readAssistantModelId(row: unknown): string | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (record.type !== 'assistant') return null;
  if (record.isSidechain === true || record.isMeta === true) return null;
  const message = record.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  return readNonEmptyString((message as Record<string, unknown>).model);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalHostStartupFailure(error: unknown): boolean {
  return isRecord(error) && error.code === 'terminal_host_startup_failed';
}

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error.trim();
  return fallback;
}

function boundReadinessDiagnosticTail(text: string | null): string {
  if (!text) return '';
  const tail = text
    .split('\n')
    .slice(-READINESS_DIAGNOSTIC_TAIL_MAX_LINES)
    .join('\n');
  return tail.length > READINESS_DIAGNOSTIC_TAIL_MAX_CHARS
    ? tail.slice(-READINESS_DIAGNOSTIC_TAIL_MAX_CHARS)
    : tail;
}

function waitMs(ms: number): Promise<void> {
  const delay = Math.max(0, Math.trunc(ms));
  if (delay === 0) return Promise.resolve();
  return sleep(delay);
}

const readEffortFromRuntimeConfigUpdate = readClaudeRuntimeConfigEffortUpdate;
const readUltracodeFromRuntimeConfigUpdate = readClaudeRuntimeConfigUltracodeUpdate;

export function createClaudeUnifiedTerminalTurnOperations(
  params: ClaudeUnifiedTerminalTurnOperationsParams,
): ClaudePublicSessionRuntime<ClaudeUnifiedTerminalNativeRuntime> {
  const state = createClaudeUnifiedTerminalRuntimeState();
  const handlers = new Set<(message: RuntimeEventV1) => void>();
  const completionWaiters = new Set<TurnCompletionWaiter>();
  const publishedFailureTurnIds = new Set<string>();
  const observedCompactionCompletedEventIds = new Set<string>();
  const providerActivityLedger = createClaudeProviderActivityLedger({
    // W-3 backstop: a stale provider task whose terminal event was dropped expires after the TTL.
    // Re-check turn-completion so a silent session does not stay "working" forever. (The target
    // function is a hoisted declaration below; the arrow only runs at expiry, well after init.)
    onActiveTasksExpired: () => { observeProviderTaskTerminalCompletionWhenReady(); },
  });
  const runtimeActivityPublisher = createSessionRuntimeActivityPublisher({
    session: params.ctx.sessions.current,
  });
  const promptEchoSuppressor = createClaudeUnifiedPromptEchoSuppressor();
  const terminalOriginLocalIds = createClaudeUnifiedTerminalOriginLocalIdAllocator({
    ctx: params.ctx,
    sessionId: params.happierSessionId,
  });

  function publishRuntimeActivityUpdate(promise: Promise<void>, reason: string): void {
    publishClaudeRuntimeActivityUpdate({
      logger: params.ctx.logger,
      logPrefix: '[ClaudeUnifiedTerminal]',
      promise,
      reason,
    });
  }

  function clearRuntimeActivitySources(reason: string): void {
    clearClaudeRuntimeActivitySources({
      logger: params.ctx.logger,
      logPrefix: '[ClaudeUnifiedTerminal]',
      runtimeActivityPublisher,
      reason,
    });
  }

  function rememberCompactionCompletedEventId(agentEventId: string | null | undefined): boolean {
    if (!agentEventId) return true;
    if (observedCompactionCompletedEventIds.has(agentEventId)) return false;
    observedCompactionCompletedEventIds.add(agentEventId);
    if (observedCompactionCompletedEventIds.size > 512) {
      const oldest = observedCompactionCompletedEventIds.values().next().value;
      if (typeof oldest === 'string') observedCompactionCompletedEventIds.delete(oldest);
    }
    return true;
  }
  // Centralized native `/goal` runtime (SOURCE + EFFECTOR). The source observes
  // every raw transcript row (incl. `goal_status` attachments + system-init
  // `slash_commands`) via the publisher's `onObserveRow`; the effector injects a
  // literal `/goal …` user turn via `sendTurnPrompt` (late-bound below, since the
  // native runtime that owns `sendTurnPrompt` is created further down).
  const goalRuntime = createClaudeUnifiedGoalRuntime({
    backendId: 'claude',
    agentId: 'claude',
    getCurrentClaudeSessionId: () => state.providerSessionId ?? null,
    writeMetadataUpdate: async (request) => { await params.ctx.sessions.current.writeMetadata(request); },
    injectGoalCommand: async (message) => { await nativeRuntime.sendTurnPrompt(message); },
    logError: (message, error) => { params.ctx.logger.debug(`[ClaudeUnifiedTerminal] ${message}`, { error }); },
  });
  // Centralized Claude Dynamic Workflow ACTIVITY runtime (CWF2/CWF3/CWF4). Observes the SAME raw
  // transcript channel as the goal source; turns `Workflow`/`Task`/`task_progress` events into durable
  // `activity/workflow_run.v1` records (record-FIRST via the host `writeSystemRecord` capability) plus
  // the compact `sessionWorkflowActivityHeadlineV1` headline (SECOND via `writeMetadata`). The host
  // owns credentials/DEK/sealing; this runtime only contributes typed payloads.
  const workflowRuntime = createClaudeUnifiedWorkflowRuntime({
    backendId: 'claude',
    agentId: 'claude',
    getCurrentClaudeSessionId: () => state.providerSessionId ?? null,
    writeSystemRecord: async (request) => {
      const writeSystemRecordFn = params.ctx.sessions.current.writeSystemRecord;
      if (!writeSystemRecordFn) {
        throw new Error('host session does not support durable system records');
      }
      await writeSystemRecordFn(request);
    },
    ...(params.ctx.sessions.current.readSystemRecord
      ? {
        readSystemRecord: async (request) => {
          const readSystemRecordFn = params.ctx.sessions.current.readSystemRecord;
          return readSystemRecordFn ? await readSystemRecordFn(request) : null;
        },
      }
      : {}),
    writeMetadata: async (request) => { await params.ctx.sessions.current.writeMetadata(request); },
    fileFollow: params.ctx.agentRuntime.transcripts.fileFollow,
    runtimeActivityPublisher,
    initialWorkflowActivityHeadline: params.initialWorkflowActivityHeadline,
    logError: (message, error) => { params.ctx.logger.debug(`[ClaudeUnifiedTerminal] ${message}`, { error }); },
  });
  // CWF4: expose the workflow-owned subagent tool-use ids to the (engine-level, stateless) task
  // work-state derivation, keyed by the Happier session id, so a canonical Workflow run's agents do
  // not ALSO render as top-level task/todo rows.
  const disposeWorkflowOwnedToolUseIdsRegistration = registerClaudeWorkflowOwnedToolUseIds(
    params.happierSessionId,
    () => workflowRuntime.getWorkflowOwnedAgentToolUseIds(),
  );
  const providerTranscriptPublisher = createClaudeUnifiedProviderTranscriptPublisher({
    ctx: params.ctx,
    sessionId: params.happierSessionId,
    onObserveRow: (row) => {
      statuslineApplier.applyModelEvidence({
        modelId: readAssistantModelId(row),
      });
      // ONE raw channel, two provider-clean sources: goal status + workflow activity.
      observeProviderTaskActivity(row);
      goalRuntime.source.observeTranscriptMessage(row);
      const workflowObservation = workflowRuntime.observeTranscriptMessage(row);
      if (workflowObservation.terminalRunIds.length > 0) {
        observeProviderTaskTerminalCompletionWhenReady();
      }
    },
  });
  let onPromptAcceptedByProviderHandler:
    ((info: ClaudeUnifiedPromptDeliveryIdentity) => void) | null = null;
  let onPromptTerminallyRejectedBeforeProviderHandler:
    ((info: ClaudeUnifiedPromptDeliveryIdentity) => void) | null = null;
  let onPromptDeliveryBlockerClearedHandler:
    ((info?: ClaudeUnifiedPromptDeliveryBlockerClear) => void) | null = null;
  let onUndeliverablePromptsHandler:
    ((prompts: ReadonlyArray<ClaudeUnifiedUndeliverablePrompt>) => void) | null = null;
  let recentPrimaryProviderUnavailableForPromptDelivery:
    ClaudeUnifiedProviderUnavailablePromptDeliveryWindow | null = null;
  let sessionHookServer: ClaudeUnifiedSessionHookServer | null = null;
  let hookPluginDir: string | null = null;
  let hookSecret: string | null = null;
  let statuslineOverlaySettings: ClaudeStatuslineOverlaySettings | null = null;
  let statuslineTranscriptPath: string | null = null;
  const providerSessionPublicationState = { publishedProviderSessionId: null as string | null };
  let knownProviderSessionBound = false;
  let sessionStartObservedForReadiness = false;
  // Statusline-verified effective truth (the `lastVerified` analogue, lane Y intent): the model
  // and effort the live TUI is ACTUALLY running. Feeds the convergence baseline ONLY — never
  // desired-state surfaces, never the TUI, never launch args.
  let verifiedModelId: string | null = null;
  let verifiedEffort: string | null = null;
  // TUI runtime-control controller (feature-gated, lazily created once the host handle exists and
  // the host adapter exposes a control port). `null` means "not (yet) available"; the resolved
  // value is cached so repeated updates share one controller (one lock, one lastVerified).
  let tuiController: ClaudeUnifiedTuiControlController | null = null;
  let tuiControllerPromise: Promise<ClaudeUnifiedTuiControlController | null> | null = null;
  let resumeChoiceStartupHandler: ReturnType<typeof createClaudeUnifiedResumeChoiceStartupHandler> | null = null;
  let resumeChoiceControlPortPromise: Promise<TerminalControlPort | null> | null = null;
  const statuslineApplier = createClaudeStatuslineApplier({
    logger: params.ctx.logger,
    // Async wrapper: a host without the session metadata seam rejects instead of throwing, and
    // the applier downgrades that to a warn log (statusline is additive enrichment only).
    writeMetadata: async (request) => await params.ctx.sessions.current.writeMetadata(request),
    readIdentity: () => ({
      providerSessionId: state.providerSessionId,
      transcriptPath: statuslineTranscriptPath,
    }),
    onRuntimeTruth: (truth) => {
      if (truth.modelId) verifiedModelId = truth.modelId;
      if (truth.effortLevel) verifiedEffort = truth.effortLevel;
      // Statusline is the live EFFECTIVE-truth feed for the controller's convergence baseline:
      // a matching desired change then short-circuits as already-effective with zero TUI bytes.
      const controller: ClaudeUnifiedTuiControlController | null = tuiController;
      if (controller) {
        controller.reconcileFromStatusline({
          ...(truth.modelId ? { model: truth.modelId } : {}),
          ...(truth.effortLevel ? { reasoningEffort: truth.effortLevel } : {}),
        });
      }
    },
    onModelChanged: (change) => {
      publishSessionEvent({
        id: change.eventId,
        type: 'message',
        message: `Model changed to ${change.modelId}`,
      }, {
        unavailableDebugMessage: '[ClaudeUnifiedTerminal] session send unavailable; model-change event not published',
        failureWarnMessage: '[ClaudeUnifiedTerminal] model-change event publish failed',
        debugMeta: { modelId: change.modelId, previousModelId: change.previousModelId },
      });
    },
  });
  let unsubscribeLifecycleEvents: (() => void) | null = null;
  let launchModelId: string | null = null;
  let launchFallbackModelId: string | null = null;
  let launchEffort: string | null = null;
  let launchUltracode = false;
  // Effective permission mode at spawn. Plan-inclusive: a pre-launch `{modeId:'plan'}` toggle
  // wins over the raw permission mode so the TUI launches in plan rather than the raw mode.
  let launchPermissionMode: string | null = params.permissionMode;

  function publishProviderSessionId(nextSessionId: string, reason: string): void {
    publishClaudeProviderSessionId({
      ctx: params.ctx,
      state: providerSessionPublicationState,
      nextSessionId,
      reason,
      logPrefix: '[ClaudeUnifiedTerminal]',
    });
  }

  function adoptProviderSessionId(input: Readonly<{
    providerSessionId: string;
    transcriptPath?: string | null;
    reason: string;
  }>): void {
    state.providerSessionId = input.providerSessionId;
    if (input.transcriptPath) {
      statuslineTranscriptPath = input.transcriptPath;
    }
    publishProviderSessionId(input.providerSessionId, input.reason);
  }

  async function bindKnownProviderSessionTranscript(): Promise<void> {
    if (knownProviderSessionBound) return;
    const knownProviderSession = params.knownProviderSession;
    if (!knownProviderSession) return;
    knownProviderSessionBound = true;
    const bindResult = await providerTranscriptPublisher.bindKnownLiveTranscript(knownProviderSession);
    if (
      bindResult.status === 'bound'
      || bindResult.status === 'unchanged'
      || bindResult.status === 'deferred'
    ) {
      adoptProviderSessionId({
        providerSessionId: bindResult.binding.providerSessionId,
        transcriptPath: bindResult.binding.transcriptPath,
        reason: 'claude-unified-known-resume-transcript',
      });
    }
  }

  const startupReadinessConfig = (() => {
    const base = Math.max(1, Math.trunc(params.startupReadiness?.baseTimeoutMs ?? DEFAULT_STARTUP_READINESS_BASE_TIMEOUT_MS));
    return {
      baseTimeoutMs: base,
      extendedTimeoutMs: Math.max(base, Math.trunc(params.startupReadiness?.extendedTimeoutMs ?? DEFAULT_STARTUP_READINESS_EXTENDED_TIMEOUT_MS)),
      progressGraceMs: Math.max(1, Math.trunc(params.startupReadiness?.progressGraceMs ?? DEFAULT_STARTUP_READINESS_PROGRESS_GRACE_MS)),
      pollIntervalMs: Math.max(1, Math.trunc(params.startupReadiness?.pollIntervalMs ?? DEFAULT_STARTUP_READINESS_POLL_INTERVAL_MS)),
    };
  })();
  let lastObservedPaneAlive: boolean | null = null;
  let lastObservedScreenText: string | null = null;
  let lastScreenProgressAtMs: number | null = null;
  let lastReadinessKind: 'writable' | 'writable_steer' | 'deferred' | 'failed' = 'deferred';
  let lastSteerVetoReason: string | null = null;
  let readinessWakeTimer: ReturnType<typeof setTimeout> | null = null;
  const queuedBannerCustodyTimers = new Set<ReturnType<typeof setTimeout>>();
  let readinessWaitStartedAtMs: number | null = null;
  const staleTurnRecoveryConfig = {
    windowMs: Math.max(1, Math.trunc(params.staleTurnRecovery?.windowMs ?? DEFAULT_STALE_TURN_RECOVERY_WINDOW_MS)),
    pollIntervalMs: Math.max(1, Math.trunc(params.staleTurnRecovery?.pollIntervalMs ?? DEFAULT_STALE_TURN_RECOVERY_POLL_INTERVAL_MS)),
  };
  let staleTurnDemandActive = false;
  let staleTurnWakeTimer: ReturnType<typeof setTimeout> | null = null;
  const dialogTurnEndProbeDelaysMs: readonly number[] = sanitizeTurnEndProbeDelaysMs(
    params.dialogResolution?.turnEndProbeDelaysMs,
  );
  const dialogInjectionBlockEscalationMs = Math.min(
    MAX_DIALOG_INJECTION_BLOCK_ESCALATION_MS,
    Math.max(
      MIN_DIALOG_INJECTION_BLOCK_ESCALATION_MS,
      Math.trunc(params.dialogResolution?.injectionBlockEscalationMs ?? DEFAULT_DIALOG_INJECTION_BLOCK_ESCALATION_MS),
    ),
  );
  let turnEndDialogProbeTimer: ReturnType<typeof setTimeout> | null = null;
  let turnEndDialogProbeGeneration = 0;
  let turnEndDialogProbeEscalated = false;
  let dialogInjectionBlockStartedAtMs: number | null = null;
  let dialogInjectionBlockEscalated = false;
  let lastProviderActivityAtMs: number | null = null;
  let lastTurnProgressPublishedAtMs: number | null = null;
  const publishedLifecycleStartTurnIds = new Set<string>();
  const publishedTerminalLifecycleTurnIds = new Set<string>();
  // Durable across runner respawns (ported S-1): a leftover own draft must still be recognized by
  // the NEXT runner process, or it reads as a foreign user draft and idle injection starves.
  const ownInjectedTextLog = createPersistedClaudeUnifiedOwnInjectedTextLog({
    storage: params.ctx.storage.session,
    onStorageError: (operation, error) => {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] own-injected-text log storage degraded', { operation, error });
    },
  });
  const recentProviderPromptSubmissions: RecentProviderPromptSubmissionEvidence[] = [];
  let pendingRuntimeConfigDeliveryBlocker: ClaudeUnifiedPromptDeliveryBlockedReason | null = null;
  let pendingProviderUnavailableDeliveryBlocker = false;
  let pendingTerminalHostStartupFailurePromptMeta: ClaudeUnifiedPromptDeliveryMeta | null = null;

  function isCanonicalTurnActive(): boolean {
    return state.turnInFlight || state.terminalOriginTurnInFlight;
  }

  function notifyPromptDeliveryBlockerCleared(
    deliveryBlockedReason: ClaudeUnifiedPromptDeliveryBlockedReason,
  ): void {
    try {
      onPromptDeliveryBlockerClearedHandler?.({ deliveryBlockedReason });
    } catch (error) {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] onPromptDeliveryBlockerCleared handler failed', { error });
    }
  }

  function notePromptDeliveryBlockerEmitted(
    deliveryBlockedReason: ClaudeUnifiedPromptDeliveryBlockedReason | undefined,
  ): void {
    if (deliveryBlockedReason === 'provider_unavailable_before_acceptance') {
      pendingProviderUnavailableDeliveryBlocker = true;
    }
  }

  function clearProviderUnavailableDeliveryBlockerIfNeeded(): void {
    if (!pendingProviderUnavailableDeliveryBlocker) return;
    pendingProviderUnavailableDeliveryBlocker = false;
    notifyPromptDeliveryBlockerCleared('provider_unavailable_before_acceptance');
  }

  function blockPendingDeliveryForTerminalHostStartupFailure(): void {
    const identity = buildPromptDeliveryIdentityFromMeta(pendingTerminalHostStartupFailurePromptMeta, {
      deliveryBlockedReason: 'terminal_host_unreachable',
    });
    if (!identity) return;
    try {
      onPromptTerminallyRejectedBeforeProviderHandler?.(identity);
      notePromptDeliveryBlockerEmitted('terminal_host_unreachable');
    } catch (error) {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] terminal-host pending delivery block handler failed', { error });
    }
  }

  function canRejectCurrentQueuedPromptBeforeProvider(
    reason: ClaudeUnifiedPromptDeliveryBlockedReason,
  ): boolean {
    if (reason === 'capture_style_unavailable') return false;
    if ((reason === 'terminal_composer_draft' || reason === 'runtime_config_blocked') && isCanonicalTurnActive()) {
      return false;
    }
    return true;
  }

  function hasProviderClaimedPendingPrompt(meta: ClaudeUnifiedPromptDeliveryMeta | undefined): boolean {
    return (meta?.providerClaimedPendingLocalIds ?? []).some((localId) => {
      return typeof localId === 'string' && localId.trim().length > 0;
    });
  }

  function recordProviderClaimedPendingPromptIfNeeded(
    prompt: string,
    meta: ClaudeUnifiedPromptDeliveryMeta | undefined,
  ): void {
    if (!hasProviderClaimedPendingPrompt(meta)) return;
    ownInjectedTextLog.record(prompt);
    ownInjectedTextLog.recordPossiblePartialResidue(prompt, {
      minPrefixChars: PROVIDER_CLAIMED_PENDING_PREFIX_RESIDUE_MIN_CHARS,
    });
  }

  const DEPENDENT_RUNTIME_CONFIG_CHANGE_KEYS = new Set(['permissionMode', 'sessionMode']);
  const DEFERRED_RUNTIME_CONFIG_TIMINGS = new Set(['scheduled_for_next_prompt', 'queued_until_safe_window', 'next_idle']);

  function isRuntimeConfigUpdatePromptDependent(update: Readonly<Record<string, unknown>>): boolean {
    return readNonEmptyString(update.permissionMode) !== null || readNonEmptyString(update.modeId) !== null;
  }

  function isRuntimeConfigChangePromptBlocking(change: RuntimeConfigApplyOutcome['changes'][number]): boolean {
    return change.status === 'failed'
      || change.status === 'requires_interactive_control'
      || (change.timing !== undefined && DEFERRED_RUNTIME_CONFIG_TIMINGS.has(change.timing));
  }

  function dependentRuntimeConfigPromptMayProceed(outcome: RuntimeConfigApplyOutcome): boolean {
    const dependentChanges = outcome.changes.filter((change) => DEPENDENT_RUNTIME_CONFIG_CHANGE_KEYS.has(change.key));
    if (dependentChanges.length === 0) return true;
    return !dependentChanges.some(isRuntimeConfigChangePromptBlocking);
  }

  function rememberRuntimeConfigUpdateOutcome<T extends RuntimeConfigUpdateOutcomeV1 | void>(
    outcome: T,
    opts: Readonly<{ promptMayProceed?: boolean }> = {},
  ): T {
    if (!outcome) return outcome;
    if (opts.promptMayProceed === undefined) {
      return outcome;
    }
    if (opts.promptMayProceed) {
      const hadRuntimeConfigDeliveryBlocker = pendingRuntimeConfigDeliveryBlocker === 'runtime_config_blocked';
      pendingRuntimeConfigDeliveryBlocker = null;
      if (hadRuntimeConfigDeliveryBlocker) {
        notifyPromptDeliveryBlockerCleared('runtime_config_blocked');
      }
    } else {
      pendingRuntimeConfigDeliveryBlocker = 'runtime_config_blocked';
    }
    return outcome;
  }

  function rejectCurrentQueuedPromptBeforeProvider(
    reason: ClaudeUnifiedPromptDeliveryBlockedReason,
  ): boolean {
    if (!canRejectCurrentQueuedPromptBeforeProvider(reason)) return false;
    const rejected = arbiter.rejectHeadBeforeProvider({ deliveryBlockedReason: reason });
    if (!rejected) return false;
    state.dispatchAttemptInFlight = false;
    params.setThinking?.(false);
    settleTurnCompletionWaiters();
    return true;
  }

  function handlePendingRuntimeConfigDeliveryBlockerBeforeDrain(): boolean {
    if (!pendingRuntimeConfigDeliveryBlocker) return false;
    if (rejectCurrentQueuedPromptBeforeProvider(pendingRuntimeConfigDeliveryBlocker)) {
      return true;
    }
    if (!isCanonicalTurnActive()) return false;
    steerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
    publishSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'), {
      unavailableDebugMessage: '[ClaudeUnifiedTerminal] session send unavailable; runtime-config-blocked pending notice not published',
      failureWarnMessage: '[ClaudeUnifiedTerminal] runtime-config-blocked pending notice publish failed',
    });
    ensureStaleTurnWake();
    return true;
  }

  function rememberRecentProviderPromptSubmission(
    evidence: RecentProviderPromptSubmissionEvidence,
  ): void {
    recentProviderPromptSubmissions.push(evidence);
    while (recentProviderPromptSubmissions.length > MAX_RECENT_PROVIDER_PROMPT_SUBMISSIONS) {
      recentProviderPromptSubmissions.shift();
    }
  }

  async function replayRecentProviderPromptSubmissions(): Promise<void> {
    if (recentProviderPromptSubmissions.length === 0) return;
    const submissions = recentProviderPromptSubmissions.splice(0);
    for (const submission of submissions) {
      await arbiter.confirmProviderAcceptance({
        promptText: submission.promptText,
        ...(submission.agentTurnId ? { agentTurnId: submission.agentTurnId } : {}),
        ...(submission.queuedCommandEvidence ? { includeTimedOutAmbiguous: true } : {}),
      });
    }
  }

  const publishSessionEvent = (
    event: Readonly<Record<string, unknown>>,
    opts?: Readonly<{
      unavailableDebugMessage?: string;
      failureWarnMessage?: string;
      debugMeta?: Readonly<Record<string, unknown>>;
    }>,
  ): void => {
    const send = (params.ctx.sessions.current as { send?: (request: unknown) => Promise<unknown> }).send;
    const eventType = typeof event.type === 'string' ? event.type : 'unknown';
    if (typeof send !== 'function') {
      params.ctx.logger.debug(
        opts?.unavailableDebugMessage ?? '[ClaudeUnifiedTerminal] session send unavailable; session event not published',
        { eventType, ...opts?.debugMeta },
      );
      return;
    }
    void Promise.resolve(send.call(params.ctx.sessions.current, { kind: 'sessionEvent', event })).catch((error) => {
      params.ctx.logger.warn(
        opts?.failureWarnMessage ?? '[ClaudeUnifiedTerminal] session-event publish failed',
        { error, eventType },
      );
    });
  };
  // Single owner of the runtime-config-outcome session-event emission (grouped per status,
  // transition-deduped). The session `send` seam is optional on older hosts; emission is then a
  // logged no-op (outcomes still flow through the typed updateSessionRuntimeConfig return).
  const runtimeConfigOutcomeEmitter = createClaudeUnifiedRuntimeConfigOutcomeEmitter({
    sendSessionEvent: (event: ClaudeUnifiedRuntimeConfigOutcomeSessionEvent) => {
      publishSessionEvent(event, {
        unavailableDebugMessage: '[ClaudeUnifiedTerminal] session send unavailable; runtime-config-outcome not published',
        failureWarnMessage: '[ClaudeUnifiedTerminal] runtime-config-outcome publish failed',
        debugMeta: { status: event.status },
      });
    },
  });

  function buildPromptDeliveryIdentity(
    input: TerminalPromptInput,
    options?: Readonly<{
      deliveryBlockedReason?: ClaudeUnifiedPromptDeliveryIdentity['deliveryBlockedReason'];
    }>,
  ): ClaudeUnifiedPromptDeliveryIdentity {
    const userMessageSeq = typeof input.origin?.userMessageSeq === 'number'
      ? input.origin.userMessageSeq
      : null;
    return {
      userMessageSeq,
      ...(input.origin?.localIds && input.origin.localIds.length > 0
        ? { localIds: input.origin.localIds }
        : {}),
      ...(input.origin?.userMessageSeqs && input.origin.userMessageSeqs.length > 0
        ? { userMessageSeqs: input.origin.userMessageSeqs }
        : {}),
      ...(options?.deliveryBlockedReason ? { deliveryBlockedReason: options.deliveryBlockedReason } : {}),
    };
  }

  function normalizePromptDeliveryMetaLocalIds(meta: ClaudeUnifiedPromptDeliveryMeta | null): string[] {
    if (!meta) return [];
    const rawLocalIds = [meta.localId, ...(meta.localIds ?? [])];
    const localIds: string[] = [];
    const seen = new Set<string>();
    for (const rawLocalId of rawLocalIds) {
      if (typeof rawLocalId !== 'string') continue;
      const localId = rawLocalId.trim();
      if (!localId || seen.has(localId)) continue;
      seen.add(localId);
      localIds.push(localId);
    }
    return localIds;
  }

  function buildPromptDeliveryIdentityFromMeta(
    meta: ClaudeUnifiedPromptDeliveryMeta | null,
    options: Readonly<{
      deliveryBlockedReason: ClaudeUnifiedPromptDeliveryIdentity['deliveryBlockedReason'];
    }>,
  ): ClaudeUnifiedPromptDeliveryIdentity | null {
    const localIds = normalizePromptDeliveryMetaLocalIds(meta);
    const userMessageSeq = typeof meta?.userMessageSeq === 'number' ? meta.userMessageSeq : null;
    const rawUserMessageSeqs: readonly number[] = meta?.userMessageSeqs ?? [];
    const userMessageSeqs = rawUserMessageSeqs.filter((seq) => Number.isInteger(seq) && seq >= 0);
    if (localIds.length === 0 && userMessageSeq === null && userMessageSeqs.length === 0) return null;
    return {
      userMessageSeq,
      ...(localIds.length > 0 ? { localIds } : {}),
      ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
      ...(options.deliveryBlockedReason ? { deliveryBlockedReason: options.deliveryBlockedReason } : {}),
    };
  }

  function recordPrimaryProviderUnavailableForPromptDelivery(evidence: unknown, observedAtMs: number): void {
    const usageLimitDetails = mapClaudeProviderFailureToUsageDetails(evidence);
    if (!usageLimitDetails) return;
    const unavailableUntilMs = resolveClaudeUnifiedProviderUnavailableUntilMs(
      usageLimitDetails,
      observedAtMs,
    );
    if (unavailableUntilMs === null) return;
    recentPrimaryProviderUnavailableForPromptDelivery = { unavailableUntilMs };
  }

  function resolveProviderUnavailablePromptTerminalRejection(
    _input: TerminalPromptInput,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  ): ClaudeUnifiedPromptTerminalRejection | undefined {
    if (
      result.reason !== 'ambiguous_provider_acceptance'
      || result.phase !== 'after_enter_unknown'
      || !isClaudeUnifiedProviderUnavailablePromptDeliveryWindowActive(
        recentPrimaryProviderUnavailableForPromptDelivery,
        Date.now(),
      )
    ) {
      return undefined;
    }
    return { deliveryBlockedReason: 'provider_unavailable_before_acceptance' };
  }

  function isPromptDeliveryAccepted(input: TerminalPromptInput): boolean {
    try {
      return params.ctx.sessions.current.hasProviderAcceptedUserMessageDelivery?.(buildPromptDeliveryIdentity(input)) === true;
    } catch (error) {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] provider-accepted delivery query failed', { error });
      return false;
    }
  }

  function isTuiRuntimeControlFeatureEnabled(): boolean {
    try {
      return params.ctx.features.isEnabled(CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID) === true;
    } catch {
      // Fail-closed: a missing/throwing feature service means the gate is OFF.
      return false;
    }
  }

  async function ensureTuiController(): Promise<ClaudeUnifiedTuiControlController | null> {
    if (state.disposed || !state.handle) return null;
    if (!isTuiRuntimeControlFeatureEnabled()) return null;
    if (!tuiControllerPromise) {
      const handle = state.handle;
      tuiControllerPromise = (async () => {
        const port = await params.ctx.agentRuntime.terminalHost.controlPort(handle);
        if (!port) return null;
        const controller = createClaudeUnifiedTuiControlController({
          port,
          featureEnabled: true,
          settingsGuard: createClaudeSettingsGuard({
            // The SPAWNED process env decides which config root `/model`/`/effort` mutate.
            configDir: resolveClaudeConfigRootFromEnv(params.launchEnv),
          }),
          telemetry: createClaudeTuiControlTelemetrySink({ logger: params.ctx.logger }),
          ...(params.tuiControl?.timings ? { timings: params.tuiControl.timings } : {}),
          onControlCommandTyped: (commandText) => {
            // Controller-typed slash commands must never surface as user messages: register them
            // both as own-injected text (leftover-draft recognition) and as accepted-prompt echoes
            // (terminal-origin materialization suppression).
            ownInjectedTextLog.record(commandText);
            promptEchoSuppressor.recordAcceptedPrompt({ text: commandText });
          },
          onControlCommandTextEntered: (commandText) => {
            // TYPE-time registration only (ported S-7): a typed-but-never-submitted command can
            // survive the cleanup Escape as a composer leftover that must read as OUR OWN residue.
            // Echo suppression stays on the submit hook — suppressing the echo of a never-submitted
            // text could swallow a real user message.
            ownInjectedTextLog.record(commandText);
          },
        });
        tuiController = controller;
        return controller;
      })().catch((error) => {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] TUI runtime-control controller unavailable', { error });
        return null;
      });
    }
    return tuiControllerPromise;
  }

  async function ensureResumeChoiceStartupHandler(
    handle: TerminalHostHandle,
  ): Promise<ReturnType<typeof createClaudeUnifiedResumeChoiceStartupHandler> | null> {
    if (resumeChoiceStartupHandler) return resumeChoiceStartupHandler;
    if (!resumeChoiceControlPortPromise) {
      resumeChoiceControlPortPromise = params.ctx.agentRuntime.terminalHost.controlPort(handle).catch((error: unknown) => {
        params.ctx.logger.debug('[ClaudeUnifiedTerminal] resume-choice control port unavailable', { error });
        return null;
      });
    }
    const port = await resumeChoiceControlPortPromise;
    if (!port) return null;
    resumeChoiceStartupHandler = createClaudeUnifiedResumeChoiceStartupHandler({
      ctx: params.ctx,
      sessionId: params.happierSessionId,
      policy: params.resumeChoice,
      port,
      settleMs: params.tuiControl?.timings?.commandSettleMs ?? DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.commandSettleMs,
      wait: waitMs,
      runtimeConfig: {
        model: launchModelId,
        reasoningEffort: launchEffort,
        ultracode: launchUltracode,
      },
      isRuntimeControlInFlight: () => tuiController?.isControlInFlight() === true,
      // resume_choice is owned by the startup resolver only while startup is active (before the
      // provider SessionStart hook is observed). Post-startup the resolver fails OPEN — a resume
      // dialog surfacing during the idle probe is published like any other dialog, never silently
      // deferred to a dedicated startup owner that is already gone.
      isStartupActive: () => !sessionStartObservedForReadiness,
    });
    return resumeChoiceStartupHandler;
  }

  async function maybeHandleStartupResumeChoiceDialog(
    handle: TerminalHostHandle,
    screen: ReturnType<typeof parseClaudeScreenState>,
  ): Promise<ClaudeUnifiedResumeChoiceStartupResult> {
    // Registry-driven: the generalized startup dialog resolver reacts to EVERY recognized dialog
    // (incl. usage-limit) plus the fail-closed unrecognized-confirmation notice, not only the four
    // original screens, so a newly surfaced dialog is never silently ignored at the drive point.
    const startupDialogVisible = hasClaudeUnifiedVisibleDialog(screen);
    if (!startupDialogVisible && !resumeChoiceStartupHandler) {
      return 'unhandled';
    }
    const handler = await ensureResumeChoiceStartupHandler(handle);
    return handler ? await handler.handle(screen) : 'unhandled';
  }

  function resumeChoiceUserActionPending(): boolean {
    return resumeChoiceStartupHandler?.hasPendingUserAction() === true;
  }
  let consecutiveUserDraftDeferrals = 0;
  let userDraftEpisodeStartedAtMs: number | null = null;
  let userDraftEscalated = false;
  // Seam A: publish live steer availability (+reason) into agentState.capabilities so the UI's
  // delivery decision can stop pretending a non-steerable send was delivered. Fed by the
  // steer-window decisions inside observeCurrentReadiness; controller-independent.
  const steerCapabilityPublisher = createClaudeUnifiedSteerCapabilityPublisher({
    session: params.ctx.sessions.current,
    logger: params.ctx.logger,
    isCanonicalTurnActive: () => !state.disposed && (state.turnInFlight || state.terminalOriginTurnInFlight),
    // Lane Q: resolved once at runtime creation; the UI's "Apply & steer now" gate is fail-closed
    // on this static capability, so it must land before the first steered send.
    inFlightConfigApplySupported: isTuiRuntimeControlFeatureEnabled(),
  });
  const arbiter = createClaudeUnifiedInputArbiter({
    providerAcceptanceTimeoutMs: DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS,
    injectPrompt: async (input) => {
      const handle = await ensureHost();
      // Never interleave prompt bytes with an in-flight control sequence (slash command /
      // mode cycle): the controller holds the terminal lock; wait for it to drain first.
      if (tuiController) await tuiController.whenControlIdle();
      // Recorded BEFORE the injection so failed/partial attempts (the own-leftover class)
      // are matchable too.
      ownInjectedTextLog.record(input.text);
      const result = await params.ctx.agentRuntime.terminalHost.injectUserPrompt(handle, input);
      if (result.status === 'failed'
        && result.phase === 'during_write'
        && result.duplicateRisk !== 'none') {
        ownInjectedTextLog.recordPossiblePartialResidue(input.text);
      }
      return result;
    },
    onPromptInjected: async (input, acceptance) => {
      recordProviderActivity();
      params.setThinking?.(true);
      scheduleQueuedBannerCustodyCheck(input, acceptance.acceptedAs);
      await replayRecentProviderPromptSubmissions();
    },
    onPromptAccepted: async (input, acceptance) => {
      recordProviderActivity();
      promptEchoSuppressor.recordAcceptedPrompt({
        text: input.text,
        agentTurnId: acceptance.agentTurnId ?? null,
      });
      ensureAcceptedTurnStarted(input);
      state.turnInFlight = true;
      params.setThinking?.(true);
      // HF-1: provider acceptance is the watermark-confirmation point for this prompt's row seq.
      try {
        onPromptAcceptedByProviderHandler?.(buildPromptDeliveryIdentity(input));
      } catch (error) {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] onPromptAcceptedByProvider handler failed', { error });
      }
    },
    onPromptTerminallyRejectedBeforeProvider: async (input, _result, rejection) => {
      try {
        onPromptTerminallyRejectedBeforeProviderHandler?.(buildPromptDeliveryIdentity(input, {
          ...(rejection?.deliveryBlockedReason ? { deliveryBlockedReason: rejection.deliveryBlockedReason } : {}),
        }));
        notePromptDeliveryBlockerEmitted(rejection?.deliveryBlockedReason);
      } catch (error) {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] onPromptTerminallyRejectedBeforeProvider handler failed', { error });
      }
    },
    onUndeliverableInputs: (inputs) => {
      // HF-2: never silently drop queued/unaccepted prompts on dispose; hand them back.
      try {
        onUndeliverablePromptsHandler?.(inputs.map((input) => ({
          text: input.text,
          ...buildPromptDeliveryIdentity(input),
        })));
      } catch (error) {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] onUndeliverablePrompts handler failed', { error });
      }
    },
    isPromptDeliveryAccepted,
    resolvePromptTerminalRejection: resolveProviderUnavailablePromptTerminalRejection,
    onInjectionFailure: (failure) => {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] prompt injection failed', {
        reason: failure.result.reason,
        phase: failure.result.phase,
        failureState: failure.failureState,
      });
      params.setThinking?.(false);
      if (failure.failureState === 'failed_ambiguous') {
        publishAmbiguousInjectionFailure(failure);
        return;
      }
      state.dispatchAttemptInFlight = false;
      state.lastTurnFailure ??= createProviderAcceptancePendingError(arbiter.snapshot());
      settleTurnCompletionWaiters();
    },
  });

  function scheduleQueuedBannerCustodyCheck(input: TerminalPromptInput, acceptedAs: 'new_turn' | 'in_flight_steer'): void {
    if (acceptedAs !== 'in_flight_steer' || state.disposed) return;
    scheduleQueuedBannerCustodyProbe(input, 0);
  }

  function scheduleQueuedBannerCustodyProbe(input: TerminalPromptInput, attemptIndex: number): void {
    const delayMs = DEFAULT_QUEUED_BANNER_CUSTODY_RETRY_DELAYS_MS[attemptIndex];
    if (delayMs === undefined || state.disposed) return;
    const timer = setTimeout(() => {
      queuedBannerCustodyTimers.delete(timer);
      void (async () => {
        if (state.disposed || !state.handle) return;
        let shouldRetry = true;
        let inputState: Awaited<ReturnType<typeof params.ctx.agentRuntime.terminalHost.captureInputState>>;
        try {
          inputState = await params.ctx.agentRuntime.terminalHost.captureInputState(state.handle);
        } catch {
          scheduleQueuedBannerCustodyProbe(input, attemptIndex + 1);
          return;
        }
        if (inputState) {
          const screen = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
          if (screen.queuedMessageBannerVisible && !screen.userDraftPresent) {
            shouldRetry = false;
            await arbiter.observeTerminalPromptCustody(input);
          }
        }
        if (shouldRetry) {
          scheduleQueuedBannerCustodyProbe(input, attemptIndex + 1);
        }
      })().catch((error: unknown) => {
        params.ctx.logger.debug('[ClaudeUnifiedTerminal] queued-banner custody check failed', { error });
      });
    }, delayMs);
    timer.unref?.();
    queuedBannerCustodyTimers.add(timer);
  }

  function clearQueuedBannerCustodyTimers(): void {
    for (const timer of queuedBannerCustodyTimers) {
      clearTimeout(timer);
    }
    queuedBannerCustodyTimers.clear();
  }

  async function ensureHost(): Promise<TerminalHostHandle> {
    if (state.disposed) {
      throw new Error('Claude unified terminal runtime is disposed');
    }
    if (state.handle) return state.handle;
    // Respawn-attach can land on a pane holding the PREVIOUS runner's leftover draft: the seeded
    // registry must be loaded before any readiness/draft classification runs (ported S-1).
    await ownInjectedTextLog.hydrated;

    const resolution = await params.ctx.agentRuntime.terminalHost.resolve({ preference: params.hostPreference });
    if (resolution.status !== 'resolved') {
      throw new Error(`Claude unified terminal host unavailable: ${resolution.reason}`);
    }

    const resolvedHookPluginDir = await ensureSessionHookPluginDir();
    // Ultracode and the statusline forwarder ride ONE --settings overlay (Claude Code keeps
    // only the FIRST --settings). The overlay value is secret-free: the forwarder reads the
    // hook secret from its 0600 secret file, never from the command line.
    const settingsOverlay: Record<string, unknown> = {
      ...(launchUltracode && isClaudeUltracodeSupportedModelId(launchModelId)
        ? { ultracode: true }
        : {}),
      ...(statuslineOverlaySettings ? { statusLine: statuslineOverlaySettings } : {}),
    };
    const sessionName = createClaudeUnifiedTerminalSessionName(params.happierSessionId);
    let handle: TerminalHostHandle;
    try {
      handle = await params.ctx.agentRuntime.terminalHost.createOrAttachHost({
        preference: params.hostPreference,
        sessionName,
        workingDirectory: params.directory,
        isolatedEnv: true,
        launch: {
          kind: 'agent-cli',
          agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
          args: [
            ...(resolvedHookPluginDir ? ['--plugin-dir', resolvedHookPluginDir] : []),
            ...(launchModelId ? ['--model', launchModelId] : []),
            ...(launchFallbackModelId ? ['--fallback-model', launchFallbackModelId] : []),
            ...buildClaudeEffortCliArgs({ modelId: launchModelId, effort: launchEffort }),
            // Single --settings overlay (ultracode + statusline forwarder). An unhonorable
            // ultracode request resolves to OFF: the gate is xhigh capability on the launch
            // model, so we never enable ultracode at a model that cannot offer it.
            ...(Object.keys(settingsOverlay).length > 0
              ? ['--settings', JSON.stringify(settingsOverlay)]
              : []),
            CLAUDE_TERMINAL_YOLO_ALLOW_FLAG,
            ...(launchPermissionMode ? ['--permission-mode', mapToClaudePermissionMode(launchPermissionMode)] : []),
          ],
          cwd: params.directory,
          env: params.launchEnv,
        },
      });
    } catch (error) {
      throw recordTerminalHostStartupFailure(error) ?? error;
    }
    state.handle = handle;
    return handle;
  }

  async function ensureSessionHookPluginDir(): Promise<string | null> {
    if (hookPluginDir) return hookPluginDir;
    if (!sessionHookServer) {
      hookSecret = randomUUID();
      sessionHookServer = await params.ctx.agentRuntime.sessionHooks.startServer({
        providerId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
        sessionId: params.happierSessionId,
        lifecycle: { kind: 'session', sessionId: params.happierSessionId },
        sessionHookSecret: hookSecret,
        onSessionHook: async (providerSessionId, payload) => {
          // Sidechain (subagent) session hooks must never rebind the PRIMARY provider session
          // identity or transcript path (ported R-11 / HF-7).
          if (isSidechainSessionHook(payload)) return;
          const hookEventName = readNonEmptyString(payload.hook_event_name)
            ?? readNonEmptyString(payload.hookEventName)
            ?? readNonEmptyString(payload.eventName);
          if (hookEventName === 'SessionStart') {
            sessionStartObservedForReadiness = true;
          }
          const bindResult = await providerTranscriptPublisher.bindFromSessionHook(providerSessionId, payload);
          if (
            bindResult.status === 'bound'
            || bindResult.status === 'unchanged'
            || bindResult.status === 'deferred'
          ) {
            adoptProviderSessionId({
              providerSessionId: bindResult.binding.providerSessionId,
              transcriptPath: bindResult.binding.transcriptPath,
              reason: 'claude-unified-session-start',
            });
          } else if (hookEventName === 'SessionStart' && !state.providerSessionId) {
            const trustedProviderSessionId = readNonEmptyString(providerSessionId)
              ?? readNonEmptyString(payload.session_id)
              ?? readNonEmptyString(payload.sessionId);
            if (trustedProviderSessionId) {
              adoptProviderSessionId({
                providerSessionId: trustedProviderSessionId,
                transcriptPath: readNonEmptyString(payload.transcript_path) ?? readNonEmptyString(payload.transcriptPath),
                reason: 'claude-unified-session-start',
              });
            }
          }
        },
        onStatuslineUpdate: (payload) => {
          const parsed = parseClaudeStatuslinePayload(payload);
          if (!parsed) return;
          statuslineApplier.apply(parsed);
        },
        onPermissionHook: createClaudeUnifiedPermissionHookHandler(params.ctx),
        defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
        permissionHookSecret: hookSecret,
        // Host response ceiling aligned with the installed Claude permission-hook `timeout`
        // (effectively-unlimited 7d, env-overridable via the shared resolver). The ceiling is
        // FINITE and >= the installed hook timeout, so a late answer that arrives after Claude
        // has already killed the forwarder honestly expires (408) instead of resolving into a
        // dead socket — the bridge never expires while the forwarder is alive (alignment
        // invariant). Interactive tools (AskUserQuestion / ExitPlanMode) inherit the SAME finite
        // ceiling: a `null` (unbounded) host wait would outlive Claude's installed hook timeout
        // and let a late answer resolve into a dead forwarder socket instead of honestly expiring.
        permissionRequestTimeoutMs: resolveClaudePermissionHookCeilingMs({ env: params.launchEnv }),
      }) as ClaudeUnifiedSessionHookServer;
    }

    const assets = await params.ctx.agentRuntime.sessionHooks.resolveForwarderAssets();
    // Statusline forwarder overlay (merged into the single --settings at launch). STRICTLY
    // fail-open: hosts without the forwarder asset or without a 0600 secret file (the secret
    // must never ride argv — S7 hardening carry-over) leave the user's own statusline in charge.
    const statuslineForwarderScript = readNonEmptyString(assets.statuslineForwarderScript);
    const statuslineSecretFile = readNonEmptyString(sessionHookServer.sessionHookSecretFile);
    if (statuslineForwarderScript && statuslineSecretFile) {
      try {
        statuslineOverlaySettings = buildClaudeStatuslineOverlaySettings({
          nodeExecutable: assets.nodeExecutable,
          forwarderScriptPath: statuslineForwarderScript,
          port: sessionHookServer.port,
          secretFilePath: statuslineSecretFile,
          original: resolveClaudeStatuslineOriginalCommand({ env: params.launchEnv }),
        });
      } catch (error) {
        params.ctx.logger.debug('[ClaudeUnifiedTerminal] statusline overlay resolution failed (statusline forwarding off)', {
          error: error instanceof Error ? error.message : String(error),
        });
        statuslineOverlaySettings = null;
      }
    }
    const hooks = buildClaudeHookPluginHooks({
      port: sessionHookServer.port,
      nodeExecutable: assets.nodeExecutable,
      sessionForwarderScript: assets.sessionForwarderScript,
      permissionForwarderScript: assets.permissionForwarderScript,
      enableLocalPermissionBridge: true,
      ...(sessionHookServer.sessionHookSecretFile ? { sessionHookSecretFile: sessionHookServer.sessionHookSecretFile } : {}),
      ...(sessionHookServer.permissionHookSecretFile ? { permissionHookSecretFile: sessionHookServer.permissionHookSecretFile } : {}),
    });
    const manifest = buildClaudeHookPluginManifest({ instanceId: params.happierSessionId });
    hookPluginDir = await params.ctx.agentRuntime.sessionHooks.createPluginDir({
      providerId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      lifecycle: { kind: 'session', sessionId: params.happierSessionId },
      files: [
        { path: '.claude-plugin/plugin.json', json: manifest },
        { path: 'hooks/hooks.json', json: hooks },
      ],
    });
    return hookPluginDir;
  }

  function publishActiveTurnProgress(nowMs: number): void {
    if (!state.activeTurnId) return;
    if (!state.turnInFlight && !state.terminalOriginTurnInFlight) return;
    if (state.turnCompleted || state.lastTurnFailure) return;
    if (
      lastTurnProgressPublishedAtMs !== null
      && nowMs - lastTurnProgressPublishedAtMs < DEFAULT_ACTIVE_TURN_PROGRESS_INTERVAL_MS
    ) {
      return;
    }
    lastTurnProgressPublishedAtMs = nowMs;
    publishClaudeUnifiedRuntimeEvent({
      handlers,
      logger: params.ctx.logger,
      event: {
        kind: 'turn-progress',
        sessionId: params.happierSessionId,
        turnId: state.activeTurnId,
        emittedAtMs: nowMs,
      },
    });
  }

  function recordProviderActivity(): void {
    const nowMs = Date.now();
    lastProviderActivityAtMs = nowMs;
    publishActiveTurnProgress(nowMs);
  }

  function publishActiveTurnStarted(nowMs: number): void {
    const turnId = state.activeTurnId;
    if (!turnId || publishedLifecycleStartTurnIds.has(turnId)) return;
    publishedLifecycleStartTurnIds.add(turnId);
    // A new turn supersedes any pending turn-end/idle dialog re-arm from the previous turn.
    clearTurnEndDialogProbe();
    publishClaudeUnifiedTurnStart({
      handlers,
      logger: params.ctx.logger,
      sessionId: params.happierSessionId,
      turnId,
      emittedAtMs: nowMs,
    });
  }

  function publishActiveTurnComplete(nowMs: number): void {
    const turnId = state.activeTurnId;
    if (state.lastTurnFailure) return;
    if (!turnId || publishedTerminalLifecycleTurnIds.has(turnId)) return;
    publishedTerminalLifecycleTurnIds.add(turnId);
    publishClaudeUnifiedTurnComplete({
      handlers,
      logger: params.ctx.logger,
      sessionId: params.happierSessionId,
      turnId,
      emittedAtMs: nowMs,
    });
  }

  function publishActiveTurnCancelled(nowMs: number, reason?: string): void {
    const turnId = state.activeTurnId;
    if (!turnId || publishedTerminalLifecycleTurnIds.has(turnId)) return;
    publishedTerminalLifecycleTurnIds.add(turnId);
    publishClaudeUnifiedTurnCancelled({
      handlers,
      logger: params.ctx.logger,
      sessionId: params.happierSessionId,
      turnId,
      emittedAtMs: nowMs,
      ...(reason ? { reason } : {}),
    });
  }

  function resetCompletedTurnState(): void {
    staleTurnDemandActive = false;
    stopStaleTurnWake();
    providerActivityLedger.clearProviderTasks();
    state.activePromptText = null;
    state.dispatchAttemptInFlight = false;
    state.turnInFlight = false;
    state.activeTurnId = null;
    state.providerAccepted = false;
    state.turnCompleted = false;
    state.terminalOriginTurnInFlight = false;
    state.lastTurnFailure = null;
    lastTurnProgressPublishedAtMs = null;
    params.setThinking?.(false);
  }

  function readPromptText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function isCompactPromptText(value: string | null | undefined): boolean {
    const text = readPromptText(value);
    return parseSpecialCommand(text ?? '').type === 'compact';
  }

  function ensureTerminalOriginTurnStarted(promptText?: string): void {
    if (!state.activeTurnId) {
      state.promptNonce += 1;
      state.activeTurnId = createClaudeUnifiedTurnId(params.happierSessionId, state.promptNonce);
    }
    state.activePromptText = readPromptText(promptText);
    state.providerAccepted = true;
    state.turnInFlight = true;
    state.turnCompleted = false;
    const nowMs = Date.now();
    lastTurnProgressPublishedAtMs = nowMs;
    publishActiveTurnStarted(nowMs);
    params.setThinking?.(true);
  }

  function readPromptNonce(input: TerminalPromptInput): number | null {
    const nonce = input.origin?.nonce;
    if (typeof nonce !== 'string') return null;
    const prefix = `${params.happierSessionId}:`;
    if (!nonce.startsWith(prefix)) return null;
    const parsed = Number.parseInt(nonce.slice(prefix.length), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function ensureAcceptedTurnStarted(input: TerminalPromptInput): void {
    const promptNonce = readPromptNonce(input) ?? state.promptNonce;
    if (!state.activeTurnId) {
      state.activeTurnId = createClaudeUnifiedTurnId(params.happierSessionId, promptNonce);
    }
    state.activePromptText = input.text;
    state.dispatchAttemptInFlight = false;
    state.providerAccepted = true;
    state.turnInFlight = true;
    state.turnCompleted = false;
    const nowMs = Date.now();
    lastTurnProgressPublishedAtMs = nowMs;
    publishActiveTurnStarted(nowMs);
  }

  function clearProviderTasksForNewTurn(): void {
    providerActivityLedger.clearProviderTasks();
  }

  function recordTerminalHostStartupFailure(error: unknown): Error | null {
    if (!isTerminalHostStartupFailure(error)) return null;
    const fallbackMessage = readErrorMessage(error, 'Claude unified terminal host failed to start');
    const evidence = isRecord(error)
      ? {
          code: error.code,
          hostKind: error.hostKind,
          reason: error.reason,
          message: fallbackMessage,
          ...(isRecord(error.diagnostics) ? { diagnostics: error.diagnostics } : {}),
        }
      : { code: 'terminal_host_startup_failed', message: fallbackMessage };
    blockPendingDeliveryForTerminalHostStartupFailure();
    const allocateTurnWhenIdle = state.dispatchAttemptInFlight;
    state.dispatchAttemptInFlight = false;
    state.turnInFlight = false;
    state.terminalOriginTurnInFlight = false;
    state.turnCompleted = true;
    state.lastTurnFailure = recordClaudeUnifiedTurnFailure({
      evidence,
      fallbackMessage,
      handlers,
      logger: params.ctx.logger,
      publishedFailureTurnIds,
      sessionId: params.happierSessionId,
      turnId: state.activeTurnId,
      // Prompt dispatch can fail while bootstrapping the first host, before a provider-backed
      // turn id exists. Publish a complete synthetic lifecycle instead of dropping the failure.
      allocateTurnWhenIdle,
    });
    params.setThinking?.(false);
    settleTurnCompletionWaiters();
    return state.lastTurnFailure;
  }

  function publishAmbiguousInjectionFailure(failure: ClaudeUnifiedPromptInjectionFailure): void {
    if (
      failure.result.reason === 'host_unreachable'
      && failure.result.phase === 'after_enter_unknown'
      && failure.result.recoverable === true
      && failure.result.duplicateRisk !== 'none'
    ) {
      try {
        onPromptTerminallyRejectedBeforeProviderHandler?.(buildPromptDeliveryIdentity(failure.input, {
          deliveryBlockedReason: 'ambiguous_terminal_delivery',
        }));
      } catch (error) {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] ambiguous pending delivery block handler failed', { error });
      }
    }
    publishClaudeUnifiedRuntimeEvent({
      handlers,
      logger: params.ctx.logger,
      event: {
        kind: 'backend-error',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        error: {
          code: 'claude_unified_terminal_injection_failed',
          message: createProviderAcceptancePendingError(arbiter.snapshot()).message,
          cause: {
            failureState: failure.failureState,
            reason: failure.result.reason,
            phase: failure.result.phase,
            duplicateRisk: failure.result.duplicateRisk,
            recoverable: failure.result.recoverable,
          },
        },
      },
    });
  }

  function hasQueuedPromptAwaitingProviderAcceptance(): boolean {
    const snapshot = arbiter.snapshot();
    return snapshot.queuedCount > 0 && snapshot.headInputState === 'awaiting_provider_acceptance';
  }

  function recordTerminalOriginTurnStarted(promptText?: string): void {
    if (hasQueuedPromptAwaitingProviderAcceptance()) {
      state.terminalOriginTurnInFlight = true;
      params.setThinking?.(true);
      return;
    }
    ensureTerminalOriginTurnStarted(promptText);
  }

  function consumeTerminalOriginTurnCompletion(): boolean {
    if (!state.terminalOriginTurnInFlight) return false;
    state.terminalOriginTurnInFlight = false;
    return true;
  }

  function observeProviderTaskTerminalCompletion(): void {
    // Claude terminal JSONL can close a Dynamic Workflow via `task_updated` without a separate
    // assistant-stop row. Treat that provider-task terminal signal as turn-completion evidence so
    // the session does not stay working after Claude has finished.
    arbiter.armPendingProviderAcceptanceTimeout();
    // A queued control (e.g. `/effort`) can pop a dialog into the now-idle session with no further
    // screen observation. Re-arm the bounded turn-end dialog probe so it is surfaced, not silent —
    // for both the terminal-origin and the accepted-prompt completion paths.
    if (consumeTerminalOriginTurnCompletion()) {
      scheduleTurnEndDialogProbes();
      return;
    }
    if (!state.activeTurnId && !state.providerAccepted) return;
    state.providerAccepted = true;
    publishActiveTurnComplete(Date.now());
    state.turnCompleted = true;
    settleTurnCompletionWaiters();
    scheduleTurnEndDialogProbes();
  }

  function observeProviderTaskTerminalCompletionWhenReady(): void {
    observeProviderTaskTerminalCompletion();
  }

  function observeProviderTaskActivity(row: unknown): void {
    observeClaudeProviderTaskActivity({
      row,
      ledger: providerActivityLedger,
      runtimeActivityPublisher,
      logger: params.ctx.logger,
      logPrefix: '[ClaudeUnifiedTerminal]',
    });
  }

  function observeSidechainRuntimeActivity(sourceTaskId: string): void {
    const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(sourceTaskId);
    if (!sourceId) return;
    publishRuntimeActivityUpdate(
      runtimeActivityPublisher.renewSource(sourceId),
      'sidechain-hook-activity',
    );
  }

  function clearSidechainRuntimeActivity(sourceTaskId: string): void {
    const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(sourceTaskId);
    if (!sourceId) return;
    publishRuntimeActivityUpdate(
      runtimeActivityPublisher.clearSource(sourceId),
      'sidechain-hook-terminal',
    );
  }

  async function materializeTerminalOriginPrompt(params2: Readonly<{
    text?: string;
    observedAtMs?: number;
    agentTurnId?: string | null;
    source: 'hook' | 'transcript';
  }>): Promise<void> {
    const text = readPromptText(params2.text);
    if (!text) return;
    const observedAtMs =
      typeof params2.observedAtMs === 'number' && Number.isFinite(params2.observedAtMs)
        ? Math.trunc(params2.observedAtMs)
        : Date.now();
    if (
      params2.source === 'transcript'
      && promptEchoSuppressor.consumeMaterializedTerminalPromptDuplicate({
        text,
        observedAtMs,
        agentTurnId: params2.agentTurnId ?? null,
      })
    ) {
      return;
    }
    if (
      params2.source === 'transcript'
      && promptEchoSuppressor.consumeAcceptedPromptEcho({
        text,
        observedAtMs,
        agentTurnId: params2.agentTurnId ?? null,
      })
    ) {
      return;
    }

    const localId = await terminalOriginLocalIds.next({
      agentTurnId: params2.agentTurnId ?? null,
    });
    publishClaudeUnifiedRuntimeEvent({
      handlers,
      logger: params.ctx.logger,
      event: {
        kind: 'transcript-user-text',
        sessionId: params.happierSessionId,
        emittedAtMs: observedAtMs,
        text,
        localId,
        meta: {
          provider: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
          source: 'cli',
          sentFrom: 'cli',
          terminalOrigin: true,
        },
      },
    });
    if (params2.source === 'hook') {
      promptEchoSuppressor.recordMaterializedTerminalPrompt({
        text,
        materializedAtMs: observedAtMs,
        agentTurnId: params2.agentTurnId ?? null,
      });
    }
  }

  function readTurnCompletionFailure(): Error | null {
    if (state.disposed && (state.turnInFlight || state.dispatchAttemptInFlight)) {
      return new Error('Claude unified terminal runtime was disposed while a turn was in flight');
    }
    if (state.lastTurnFailure) {
      return state.lastTurnFailure;
    }
    const snapshot = arbiter.snapshot();
    if (snapshot.headInputState === 'failed_terminal') {
      return createProviderAcceptancePendingError(snapshot);
    }
    return null;
  }

  function rejectTurnCompletionWaiters(error: Error): void {
    if (completionWaiters.size === 0) return;
    const waiters = Array.from(completionWaiters);
    completionWaiters.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  function resolveTurnCompletionWaiters(): void {
    if (completionWaiters.size === 0) return;
    const waiters = Array.from(completionWaiters);
    completionWaiters.clear();
    resetCompletedTurnState();
    for (const waiter of waiters) waiter.resolve();
  }

  function settleTurnCompletionWaiters(): void {
    const failure = readTurnCompletionFailure();
    if (failure) {
      rejectTurnCompletionWaiters(failure);
      return;
    }
    if (state.turnCompleted) {
      resolveTurnCompletionWaiters();
    }
  }

  function recordScreenProgress(screenText: string): void {
    if (screenText !== lastObservedScreenText) {
      lastObservedScreenText = screenText;
      lastScreenProgressAtMs = Date.now();
    }
  }

  function resetUserDraftStarvation(): void {
    const hadEscalatedDraftBlocker = userDraftEscalated;
    consecutiveUserDraftDeferrals = 0;
    userDraftEpisodeStartedAtMs = null;
    userDraftEscalated = false;
    if (hadEscalatedDraftBlocker) {
      notifyPromptDeliveryBlockerCleared('terminal_composer_draft');
    }
  }

  function hasPromptDeliveryDemand(): boolean {
    return arbiter.snapshot().queuedCount > 0 || state.dispatchAttemptInFlight;
  }

  // Bounded clear of an OWN injection leftover: only when the draft EXACTLY matches text this
  // runtime injected, and NEVER while the screen is generating (Escape would interrupt the
  // running turn — deliberate fail-safe). A genuine user draft can never match. Registry fallback
  // (ported HF-4): controller-typed slash residue from the finite /model//effort vocabulary is
  // provably our own even when the persisted registry cannot match after a respawn.
  function isOwnLeftoverDraft(composerContent: string | null | undefined): boolean {
    return ownInjectedTextLog.matches(composerContent)
      || isControllerTypedSlashCommandResidue(composerContent);
  }

  async function maybeClearOwnLeftoverDraft(
    handle: TerminalHostHandle,
    screen: ReturnType<typeof parseClaudeScreenState>,
  ): Promise<ReturnType<typeof parseClaudeScreenState> | null> {
    if (screen.generating) return null;
    if (!isOwnLeftoverDraft(screen.composerContent)) return null;
    for (let attempt = 1; attempt <= MAX_OWN_LEFTOVER_DRAFT_CLEAR_ATTEMPTS; attempt += 1) {
      try {
        await params.ctx.agentRuntime.terminalHost.interruptTurn(handle);
      } catch (error) {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] own leftover draft clear failed', { error, attempt });
        return null;
      }
      const recapture = await params.ctx.agentRuntime.terminalHost.captureInputState(handle).catch(() => null);
      if (!recapture) return null;
      const next = parseClaudeScreenState(recapture.currentInput, { cursor: recapture.cursor });
      if (!next.userDraftPresent) {
        params.ctx.logger.info('[ClaudeUnifiedTerminal] cleared own leftover composer draft', {
          sessionId: params.happierSessionId,
          attempts: attempt,
        });
        resetUserDraftStarvation();
        return next;
      }
      if (next.generating || !isOwnLeftoverDraft(next.composerContent)) return null;
    }
    return null;
  }

  function noteUserDraftDeferral(screen: ReturnType<typeof parseClaudeScreenState>): void {
    if (!hasPromptDeliveryDemand()) return;
    consecutiveUserDraftDeferrals += 1;
    if (userDraftEpisodeStartedAtMs === null) userDraftEpisodeStartedAtMs = Date.now();
    if (
      userDraftEscalated
      || consecutiveUserDraftDeferrals < USER_DRAFT_STARVATION_VETO_THRESHOLD
      || Date.now() - userDraftEpisodeStartedAtMs < USER_DRAFT_STARVATION_MIN_EPISODE_MS
    ) {
      return;
    }
    userDraftEscalated = true;
    const draftLength = screen.composerContent?.length ?? 0;
    const ownDraft = ownInjectedTextLog.matches(screen.composerContent);
    params.ctx.logger.warn('[ClaudeUnifiedTerminal] user draft starvation escalated', {
      sessionId: params.happierSessionId,
      consecutiveDeferrals: consecutiveUserDraftDeferrals,
      draftLength,
      ownDraft,
    });
    publishClaudeUnifiedRuntimeEvent({
      handlers,
      logger: params.ctx.logger,
      event: {
        kind: 'backend-error',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        error: {
          code: 'claude_unified_terminal_user_draft_blocking',
          message: 'A draft typed in the Claude terminal composer is blocking delivery of queued messages. Send or clear the draft in the terminal to let them through.',
          cause: {
            draftLength,
            ownDraft,
            consecutiveDeferrals: consecutiveUserDraftDeferrals,
          },
        },
      },
    });
    steerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
    publishSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'), {
      unavailableDebugMessage: '[ClaudeUnifiedTerminal] session send unavailable; terminal-composer-draft-blocked not published',
      failureWarnMessage: '[ClaudeUnifiedTerminal] terminal-composer-draft-blocked publish failed',
    });
    if (!rejectCurrentQueuedPromptBeforeProvider('terminal_composer_draft') && isCanonicalTurnActive()) {
      ensureStaleTurnWake();
    }
  }

  async function observeCurrentReadiness(): Promise<void> {
    const handle = await ensureHost();
    lastSteerVetoReason = null;
    const liveness = await params.ctx.agentRuntime.terminalHost.evaluateLiveness(handle).catch((error: unknown) => {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] terminal liveness check failed', { error });
      return null;
    });
    if (!liveness) {
      lastObservedPaneAlive = null;
      lastReadinessKind = 'deferred';
      arbiter.observeReadiness({
        status: 'defer_liveness_uncertain',
        observedAt: Date.now(),
        reason: 'liveness_probe_failed',
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
      });
      return;
    }
    lastObservedPaneAlive = liveness.paneAlive === true;
    if (!liveness.paneAlive) {
      if (liveness.paneDead === true) {
        // The host confirmed the pane is dead. Terminalize: there is no recovery path.
        lastReadinessKind = 'failed';
        arbiter.observeReadiness({
          status: 'failed_terminal',
          observedAt: liveness.observedAt,
          reason: 'pane_dead',
          hostKind: handle.kind,
          hostSessionName: handle.sessionName,
          ...(handle.paneId ? { paneId: handle.paneId } : {}),
          liveness,
          recoverable: false,
        });
        return;
      }
      // Non-alive but NOT confirmed dead is a transient liveness observation (e.g. a momentary
      // non-interactive command during heavy resume/startup). Defer with a bounded wake — the
      // same treatment as a failed liveness probe — instead of terminalizing on a blip. A
      // genuinely dead pane is reported with `paneDead: true` by the tmux/zellij adapters and
      // takes the terminal branch above.
      lastReadinessKind = 'deferred';
      arbiter.observeReadiness({
        status: 'defer_liveness_uncertain',
        observedAt: liveness.observedAt,
        reason: 'liveness_non_alive_transient',
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
        liveness,
      });
      return;
    }
    const inputState = await params.ctx.agentRuntime.terminalHost.captureInputState(handle).catch(() => null);
    if (inputState && !inputState.stable) {
      lastReadinessKind = 'deferred';
      lastSteerVetoReason = 'user_typing';
      arbiter.observeReadiness({
        status: 'defer_user_typing',
        observedAt: inputState.observedAt,
        reason: 'user_typing',
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
        liveness,
      });
      return;
    }
    if (inputState) {
      // ONE shared screen-state owner for readiness and steer decisions: the parser
      // recognizes the real TUI composer shapes (boxed `│ > │`, the `❯` glyph, mode
      // markers) so a live rendered composer is never false-negatively deferred.
      let screen = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
      recordScreenProgress(screen.text);
      // Resolve a recognized dialog (owner arbitration → publish) BEFORE composer-draft
      // classification so an owned effort/model dialog is answered/published first. A registry-
      // recognized dialog that blocks a queued prompt is tracked so a sustained block escalates once
      // and projects a durable block instead of deferring forever.
      const dialogBlockedReason = resolveClaudeUnifiedDialogBlockedReason(screen);
      const resumeChoiceResult = await maybeHandleStartupResumeChoiceDialog(handle, screen);
      if (dialogBlockedReason !== null) {
        noteDialogInjectionBlock(dialogBlockedReason);
      } else {
        resetDialogInjectionBlock();
      }
      if (resumeChoiceResult !== 'unhandled') {
        lastReadinessKind = 'deferred';
        arbiter.observeReadiness({
          status: 'defer_provider_starting',
          observedAt: inputState.observedAt,
          reason: resumeChoiceResult === 'waiting_for_user'
            ? 'resume_choice_user_action'
            : 'resume_choice_dialog',
          hostKind: handle.kind,
          hostSessionName: handle.sessionName,
          ...(handle.paneId ? { paneId: handle.paneId } : {}),
          liveness,
        });
        return;
      }
      if (screen.userDraftPresent && hasPromptDeliveryDemand()) {
        const clearedScreen = await maybeClearOwnLeftoverDraft(handle, screen);
        if (clearedScreen) {
          screen = clearedScreen;
          recordScreenProgress(screen.text);
        }
      }
      const captureStyleUnavailablePlaceholder =
        isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate(inputState.currentInput, screen);
      if (!isClaudeScreenReadyForInput(screen)) {
        const turnRunning = state.turnInFlight || state.terminalOriginTurnInFlight;
        const steerVeto = captureStyleUnavailablePlaceholder
          ? 'capture_style_unavailable'
          : resolveClaudeScreenInFlightSteerVeto(screen);
        if (turnRunning && steerVeto === null) {
          // In-flight steer safe-window: the screen is provably generating with a clean
          // composer — Claude natively queues typed text and submits it at turn end.
          params.ctx.logger.info('[ClaudeUnifiedTerminal] steer window safe', {
            sessionId: params.happierSessionId,
            decision: 'safe',
            generating: screen.generating,
          });
          resetUserDraftStarvation();
          lastReadinessKind = 'writable_steer';
          steerCapabilityPublisher.publish({ available: true, reason: null });
          arbiter.observeReadiness(createClaudeUnifiedWritableReadiness(handle, state.activeTurnId));
          return;
        }
        if (turnRunning && steerVeto) {
          params.ctx.logger.info('[ClaudeUnifiedTerminal] steer window vetoed', {
            sessionId: params.happierSessionId,
            decision: 'vetoed',
            reason: steerVeto,
            // Veto telemetry carries draft evidence (the incident veto loop had none).
            ...(steerVeto === 'user_draft' ? {
              draftLength: screen.composerContent?.length ?? 0,
              ownDraft: ownInjectedTextLog.matches(screen.composerContent),
            } : {}),
          });
          lastSteerVetoReason = steerVeto;
          if (steerVeto !== 'user_draft') {
            steerCapabilityPublisher.publish({ available: false, reason: 'unsafe_window' });
          }
        }
        lastReadinessKind = 'deferred';
        if (screen.usageLimitDialogVisible) {
          resetUserDraftStarvation();
          if (turnRunning) {
            steerCapabilityPublisher.publish({ available: false, reason: 'unsafe_window' });
          }
          arbiter.observeReadiness({
            status: 'defer_provider_starting',
            observedAt: inputState.observedAt,
            reason: 'provider_unavailable',
            hostKind: handle.kind,
            hostSessionName: handle.sessionName,
            ...(handle.paneId ? { paneId: handle.paneId } : {}),
            liveness,
          });
          return;
        }
        if (screen.userDraftPresent) {
          if (captureStyleUnavailablePlaceholder) {
            resetUserDraftStarvation();
            if (turnRunning) {
              steerCapabilityPublisher.publish({ available: false, reason: 'unsafe_window' });
            }
            arbiter.observeReadiness({
              status: 'defer_provider_starting',
              observedAt: inputState.observedAt,
              reason: 'capture_style_unavailable',
              hostKind: handle.kind,
              hostSessionName: handle.sessionName,
              ...(handle.paneId ? { paneId: handle.paneId } : {}),
              liveness,
            });
            return;
          }
          noteUserDraftDeferral(screen);
          if (turnRunning) {
            // X1: an escalated draft starvation keeps its honest published reason instead of
            // downgrading to a generic unsafe window (published AFTER the escalation check).
            steerCapabilityPublisher.publish({
              available: false,
              reason: userDraftEscalated ? 'user_terminal_draft' : 'unsafe_window',
            });
          }
          arbiter.observeReadiness({
            status: 'defer_user_typing',
            observedAt: inputState.observedAt,
            reason: 'user_draft',
            hostKind: handle.kind,
            hostSessionName: handle.sessionName,
            ...(handle.paneId ? { paneId: handle.paneId } : {}),
            liveness,
          });
          return;
        }
        resetUserDraftStarvation();
        arbiter.observeReadiness({
          status: 'defer_provider_starting',
          observedAt: inputState.observedAt,
          reason: 'screen_not_interactive',
          hostKind: handle.kind,
          hostSessionName: handle.sessionName,
          ...(handle.paneId ? { paneId: handle.paneId } : {}),
          liveness,
        });
        return;
      }
    }
    resetUserDraftStarvation();
    clearProviderUnavailableDeliveryBlockerIfNeeded();
    lastReadinessKind = 'writable';
    arbiter.observeReadiness(createClaudeUnifiedWritableReadiness(handle, state.activeTurnId));
  }

  function stopReadinessWake(): void {
    if (readinessWakeTimer) {
      clearTimeout(readinessWakeTimer);
      readinessWakeTimer = null;
    }
    readinessWaitStartedAtMs = null;
  }

  function readinessWakeNeeded(): boolean {
    if (state.disposed) return false;
    const snapshot = arbiter.snapshot();
    return snapshot.queuedCount > 0
      && (snapshot.headInputState === 'waiting_for_readiness' || snapshot.headInputState === 'queued');
  }

  // Bounded startup-readiness wake: a deferred prompt re-polls the screen until it becomes
  // interactive or the adaptive window expires. SessionStart is host-alive evidence that
  // holds the wait through static stalls up to the hard ceiling; a live-but-unconfirmed
  // host must keep progressing (screen output changing) past the base window; anything
  // else fails fast after the base window. On expiry the prompt fails with a STRUCTURED
  // runtime issue carrying sanitized diagnostics — never a silent hang or a generic fatal.
  function ensureReadinessWake(): void {
    if (readinessWakeTimer || state.disposed) return;
    if (!readinessWakeNeeded()) return;
    if (readinessWaitStartedAtMs === null) {
      readinessWaitStartedAtMs = Date.now();
      lastScreenProgressAtMs = Date.now();
    }
    const delayMs = userDraftEscalated
      ? Math.max(startupReadinessConfig.pollIntervalMs, USER_DRAFT_STARVATION_RECHECK_MS)
      : startupReadinessConfig.pollIntervalMs;
    readinessWakeTimer = setTimeout(() => {
      readinessWakeTimer = null;
      void runReadinessWakeTick().catch((error: unknown) => {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] readiness wake tick failed', { error });
      });
    }, delayMs);
    readinessWakeTimer.unref?.();
  }

  async function runReadinessWakeTick(): Promise<void> {
    if (!readinessWakeNeeded()) {
      stopReadinessWake();
      return;
    }
    await observeCurrentReadiness().catch((error: unknown) => {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] readiness wake observation failed', { error });
    });
    if (!readinessWakeNeeded()) {
      stopReadinessWake();
      return;
    }
    if (resumeChoiceUserActionPending()) {
      readinessWaitStartedAtMs = Date.now();
      lastScreenProgressAtMs = Date.now();
      ensureReadinessWake();
      return;
    }
    const startedAt = readinessWaitStartedAtMs ?? Date.now();
    const elapsedMs = Date.now() - startedAt;
    const sessionStartObserved = sessionStartObservedForReadiness;
    const hostAlive = sessionStartObserved || lastObservedPaneAlive === true;
    const screenStaticForMs = Date.now() - (lastScreenProgressAtMs ?? startedAt);
    const timedOut = elapsedMs >= startupReadinessConfig.extendedTimeoutMs
      || (elapsedMs >= startupReadinessConfig.baseTimeoutMs && !hostAlive)
      || (
        elapsedMs >= startupReadinessConfig.baseTimeoutMs
        && !sessionStartObserved
        && screenStaticForMs > startupReadinessConfig.progressGraceMs
      );
    if (!timedOut) {
      ensureReadinessWake();
      return;
    }
    failStartupReadiness({ elapsedMs, hostAlive, sessionStartObserved });
  }

  function failStartupReadiness(diagnostics: Readonly<{
    elapsedMs: number;
    hostAlive: boolean;
    sessionStartObserved: boolean;
  }>): void {
    stopReadinessWake();
    const blocker = arbiter.snapshot().headDeliveryBlocker;
    if (blocker && rejectCurrentQueuedPromptBeforeProvider(blocker.reason)) {
      return;
    }
    if (blocker?.reason === 'capture_style_unavailable') {
      publishSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'), {
        unavailableDebugMessage: '[ClaudeUnifiedTerminal] session send unavailable; capture-style pending notice not published',
        failureWarnMessage: '[ClaudeUnifiedTerminal] capture-style pending notice publish failed',
      });
      readinessWaitStartedAtMs = Date.now();
      lastScreenProgressAtMs = Date.now();
      ensureReadinessWake();
      return;
    }
    const handle = state.handle;
    const lastScreenTail = boundReadinessDiagnosticTail(lastObservedScreenText);
    arbiter.observeReadiness({
      status: 'failed_terminal',
      observedAt: Date.now(),
      reason: 'startup_readiness_timeout',
      ...(handle ? {
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
      } : {}),
      recoverable: false,
    });
    state.dispatchAttemptInFlight = false;
    state.lastTurnFailure = recordClaudeUnifiedTurnFailure({
      evidence: {
        code: 'claude_unified_terminal_readiness_timeout',
        message: 'Claude unified terminal did not become ready for input before the startup readiness window expired',
        elapsedMs: diagnostics.elapsedMs,
        hostAlive: diagnostics.hostAlive,
        sessionStartObserved: diagnostics.sessionStartObserved,
        lastScreenTail,
      },
      fallbackMessage: 'Claude unified terminal startup readiness timed out',
      handlers,
      logger: params.ctx.logger,
      publishedFailureTurnIds,
      sessionId: params.happierSessionId,
      turnId: state.activeTurnId ?? createClaudeUnifiedTurnId(params.happierSessionId, state.promptNonce),
      // Session-scoped failure: publish begin+fail so the session-turn lifecycle commits the
      // failed turn instead of dropping a turn-failed it never saw begin (SILENT-F1 port).
      allocateTurnWhenIdle: true,
    });
    params.ctx.logger.warn('[ClaudeUnifiedTerminal] startup readiness timed out', {
      sessionId: params.happierSessionId,
      ...diagnostics,
      lastScreenTail,
    });
    params.setThinking?.(false);
    settleTurnCompletionWaiters();
  }

  function stopStaleTurnWake(): void {
    if (staleTurnWakeTimer) {
      clearTimeout(staleTurnWakeTimer);
      staleTurnWakeTimer = null;
    }
  }

  function staleTurnRecoveryNeeded(): boolean {
    return !state.disposed
      && staleTurnDemandActive
      && (state.turnInFlight || state.terminalOriginTurnInFlight);
  }

  function ensureStaleTurnWake(): void {
    if (staleTurnWakeTimer || state.disposed) return;
    if (!staleTurnRecoveryNeeded()) return;
    staleTurnWakeTimer = setTimeout(() => {
      staleTurnWakeTimer = null;
      void runStaleTurnWakeTick().catch((error: unknown) => {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] stale-turn wake tick failed', { error });
      });
    }, staleTurnRecoveryConfig.pollIntervalMs);
    staleTurnWakeTimer.unref?.();
  }

  // Bounded, demand-driven stale-turn recovery: only runs while a prompt is queued behind the
  // running turn. A turn is reconciled as ended ONLY when the provider has been silent for the
  // whole window AND the screen proves an idle interactive composer (turn likely ended). A
  // generating screen, fresh lifecycle activity, or a failed capture keeps the wait (fail-closed).
  async function runStaleTurnWakeTick(): Promise<void> {
    if (!staleTurnRecoveryNeeded()) {
      stopStaleTurnWake();
      if (!state.turnInFlight && !state.terminalOriginTurnInFlight) staleTurnDemandActive = false;
      return;
    }
    const lastActivityAtMs = lastProviderActivityAtMs ?? Date.now();
    if (lastProviderActivityAtMs === null) lastProviderActivityAtMs = lastActivityAtMs;
    const silentForMs = Date.now() - lastActivityAtMs;
    if (silentForMs < staleTurnRecoveryConfig.windowMs) {
      ensureStaleTurnWake();
      return;
    }
    const handle = state.handle;
    if (!handle) {
      ensureStaleTurnWake();
      return;
    }
    const inputState = await params.ctx.agentRuntime.terminalHost.captureInputState(handle).catch(() => null);
    if (!inputState || !inputState.stable) {
      ensureStaleTurnWake();
      return;
    }
    const screen = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
    const resumeChoiceResult = await maybeHandleStartupResumeChoiceDialog(handle, screen);
    if (resumeChoiceResult !== 'unhandled') {
      lastProviderActivityAtMs = Date.now();
      ensureStaleTurnWake();
      return;
    }
    if (!isClaudeScreenReadyForInput(screen)) {
      ensureStaleTurnWake();
      return;
    }
    params.ctx.logger.warn('[ClaudeUnifiedTerminal] stale turn reconciled as ended', {
      sessionId: params.happierSessionId,
      silentForMs,
      turnId: state.activeTurnId,
      terminalOriginTurnInFlight: state.terminalOriginTurnInFlight,
    });
    staleTurnDemandActive = false;
    stopStaleTurnWake();
    state.providerAccepted = true;
    state.turnCompleted = true;
    if (completionWaiters.size > 0) {
      settleTurnCompletionWaiters();
    } else {
      resetCompletedTurnState();
    }
  }

  // Lane 2 — injection-guard route-on-block. A registry-recognized dialog owning terminal input while
  // a prompt is queued is routed to the resolver (published for a decision) BEFORE the injection
  // defers (the resolve runs ahead of composer-draft classification in observeCurrentReadiness). If it
  // stays unresolved past the bounded escalation window the block escalates ONCE and projects a
  // durable block via the existing `runtime_config_blocked` reason — never a silent deferral loop.
  function resetDialogInjectionBlock(): void {
    dialogInjectionBlockStartedAtMs = null;
    dialogInjectionBlockEscalated = false;
  }

  function noteDialogInjectionBlock(blockedReason: ClaudeUnifiedDialogBlockedReason): void {
    if (!hasPromptDeliveryDemand()) {
      resetDialogInjectionBlock();
      return;
    }
    const nowMs = Date.now();
    if (dialogInjectionBlockStartedAtMs === null) {
      dialogInjectionBlockStartedAtMs = nowMs;
      params.ctx.logger.debug('[ClaudeUnifiedTerminal] dialog owns terminal input; routing queued prompt to the dialog resolver', {
        sessionId: params.happierSessionId,
        blockedReason,
      });
    }
    if (dialogInjectionBlockEscalated) return;
    if (nowMs - dialogInjectionBlockStartedAtMs < dialogInjectionBlockEscalationMs) return;
    dialogInjectionBlockEscalated = true;
    const blockedForMs = nowMs - dialogInjectionBlockStartedAtMs;
    params.ctx.logger.warn('[ClaudeUnifiedTerminal] dialog blocked prompt delivery beyond the escalation window', {
      sessionId: params.happierSessionId,
      blockedReason,
      blockedForMs,
    });
    // Durable block projection for registry-recognized dialogs only (transient generation/queue/
    // permission states never reach here — `resolveClaudeUnifiedDialogBlockedReason` gates it). Reuse
    // the existing `runtime_config_blocked` reason rather than inventing a new status; when the
    // session is idle the head prompt is rejected before provider (carrying that durable reason) so
    // the UI stops pretending it was delivered instead of the prompt silently deferring behind the
    // dialog. The reject carries the projection itself, so no persistent runtime-config latch is set
    // (that latch would over-block the resend after the user answers the dialog).
    if (!isCanonicalTurnActive()) {
      rejectCurrentQueuedPromptBeforeProvider('runtime_config_blocked');
    }
  }

  // Lane 3 — turn-end/idle dialog probe. A self-rescheduling probe on ONE timer walks the bounded
  // backoff tail from turn settle. The generation guard invalidates any probe whose async shot is
  // mid-flight when the tail is cancelled/restarted (next turn start, compaction start, dispose,
  // resolution) so a superseded episode can never re-arm or escalate.
  function clearTurnEndDialogProbe(): void {
    if (turnEndDialogProbeTimer) {
      clearTimeout(turnEndDialogProbeTimer);
      turnEndDialogProbeTimer = null;
    }
    turnEndDialogProbeEscalated = false;
    turnEndDialogProbeGeneration += 1;
  }

  async function probeTurnEndDialogOnce(): Promise<boolean> {
    if (state.disposed) return true;
    const handle = state.handle;
    if (!handle) return true;
    const inputState = await params.ctx.agentRuntime.terminalHost.captureInputState(handle).catch(() => null);
    if (!inputState || !inputState.stable) return false;
    const screen = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
    if (!hasClaudeUnifiedVisibleDialog(screen)) return true;
    // Reuse the Lane 1 resolver as the probe — no second prober. Published / handled / awaiting-user
    // all count as resolved (the tail stops); an `unhandled` recognized dialog (latched or owned but
    // not published) keeps the bounded re-arm going.
    const result = await maybeHandleStartupResumeChoiceDialog(handle, screen);
    return result !== 'unhandled';
  }

  function scheduleTurnEndDialogProbeAt(index: number, generation: number): void {
    if (state.disposed || generation !== turnEndDialogProbeGeneration) return;
    const delays = dialogTurnEndProbeDelaysMs;
    if (index >= delays.length) return;
    const prevDelay = index === 0 ? 0 : Math.max(0, delays[index - 1] ?? 0);
    const thisDelay = Math.max(0, delays[index] ?? 0);
    const waitMs = Math.max(0, thisDelay - prevDelay);
    turnEndDialogProbeTimer = setTimeout(() => {
      turnEndDialogProbeTimer = null;
      void runTurnEndDialogProbe(index, generation).catch((error: unknown) => {
        params.ctx.logger.debug('[ClaudeUnifiedTerminal] turn-end dialog probe failed', { error });
      });
    }, waitMs);
    turnEndDialogProbeTimer.unref?.();
  }

  async function runTurnEndDialogProbe(index: number, generation: number): Promise<void> {
    if (state.disposed || generation !== turnEndDialogProbeGeneration) return;
    let resolved = false;
    try {
      resolved = await probeTurnEndDialogOnce();
    } catch (error) {
      params.ctx.logger.debug('[ClaudeUnifiedTerminal] turn-end dialog probe shot failed', { error });
    }
    if (state.disposed || generation !== turnEndDialogProbeGeneration) return;
    if (resolved) {
      clearTurnEndDialogProbe();
      return;
    }
    if (index >= dialogTurnEndProbeDelaysMs.length - 1) {
      // Bounded: the re-arm tail is exhausted with a dialog still unresolved. Escalate ONCE so the
      // residual silent-hang is observable, then stop (no infinite polling).
      if (!turnEndDialogProbeEscalated) {
        turnEndDialogProbeEscalated = true;
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] turn-end idle dialog re-arm exhausted with a dialog still unresolved', {
          sessionId: params.happierSessionId,
          shots: dialogTurnEndProbeDelaysMs.length,
        });
      }
      return;
    }
    scheduleTurnEndDialogProbeAt(index + 1, generation);
  }

  function scheduleTurnEndDialogProbes(): void {
    if (state.disposed) return;
    clearTurnEndDialogProbe();
    if (dialogTurnEndProbeDelaysMs.length === 0) return;
    scheduleTurnEndDialogProbeAt(0, turnEndDialogProbeGeneration);
  }

  const CONVERGENCE_KNOWN_CONFIG_OPTION_IDS = new Set(['reasoning_effort', 'effort', 'ultracode']);

  // L5d convergence: whether a post-launch runtime-config update requests ONLY values that already
  // equal the effective config. Conservative: any unrecognized directive, unknown config
  // option, or diverging value means NOT converged (the override stays pending). Baseline is the
  // statusline-VERIFIED effective truth when observed (lane Y: the TUI's actual model/effort),
  // falling back to the launch-effective config; a `default` model request still converges only
  // against the launch intent (no override at launch).
  function isRuntimeConfigUpdateConvergedWithLaunch(update: Readonly<Record<string, unknown>>): boolean {
    let sawRecognizedDirective = false;
    for (const key of Object.keys(update)) {
      const value = update[key];
      if (value === undefined) continue;
      if (key === 'modelId') {
        const modelId = readNonEmptyString(value);
        if (modelId === null) continue;
        sawRecognizedDirective = true;
        const requested = modelId === 'default' ? null : modelId;
        if (requested === null) {
          // "default" = no override; converged only when none was launched (verified truth
          // cannot prove what "default" resolves to).
          if (launchModelId !== null) return false;
        } else if (requested !== (verifiedModelId ?? launchModelId)) {
          return false;
        }
        continue;
      }
      if (key === 'fallbackModel') {
        sawRecognizedDirective = true;
        if (value === null) {
          if (launchFallbackModelId !== null) return false;
          continue;
        }
        const fallback = readNonEmptyString(value);
        if (fallback === null) return false;
        const requested = fallback === 'default' ? null : fallback;
        if (requested !== launchFallbackModelId) return false;
        continue;
      }
      if (key === 'permissionMode') {
        if (value === null) continue;
        const permissionMode = readNonEmptyString(value);
        if (permissionMode === null) return false;
        sawRecognizedDirective = true;
        if (resolveClaudePermissionModeFromRuntimeMode({ permissionMode }) !== launchPermissionMode) return false;
        continue;
      }
      if (key === 'configOption') {
        if (value === null) continue;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        const optionId = readNonEmptyString((value as Record<string, unknown>).id);
        if (optionId === null || !CONVERGENCE_KNOWN_CONFIG_OPTION_IDS.has(optionId)) return false;
        continue;
      }
      if (key === 'modeId') {
        if (value === null) continue;
        // The unified terminal cannot honor session-mode changes at all; never claim convergence.
        return false;
      }
      // Unknown directive: never claim convergence for something we do not understand.
      return false;
    }
    const effort = readEffortFromRuntimeConfigUpdate(update);
    if (effort !== undefined) {
      sawRecognizedDirective = true;
      const effectiveEffort = verifiedEffort ?? launchEffort;
      if (effort === null) {
        if (effectiveEffort !== null) return false;
      } else if (effectiveEffort === null || effort.toLowerCase() !== effectiveEffort.toLowerCase()) {
        return false;
      }
    }
    const ultracode = readUltracodeFromRuntimeConfigUpdate(update);
    if (ultracode !== undefined) {
      sawRecognizedDirective = true;
      if (ultracode !== launchUltracode) return false;
    }
    if (update.configOption != null && effort === undefined && ultracode === undefined) {
      // A config option was addressed but carried no comparable value (e.g. malformed payload).
      return false;
    }
    return sawRecognizedDirective;
  }

  const nativeRuntime: ClaudeUnifiedTerminalNativeRuntime = {
    beginTurnLifecycle() {
      clearProviderTasksForNewTurn();
      state.promptNonce += 1;
      state.dispatchAttemptInFlight = true;
      state.lastTurnFailure = null;
      state.providerAccepted = false;
      state.turnCompleted = false;
      lastTurnProgressPublishedAtMs = null;
      params.setThinking?.(true);
    },
    async startOrLoadSession() {
      const handle = await ensureHost();
      await bindKnownProviderSessionTranscript();
      await observeCurrentReadiness();
      return {
        sessionId: handle.sessionName,
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
      };
    },
    async sendTurnPrompt(prompt: string, meta?: ClaudeUnifiedPromptDeliveryMeta) {
      if (!state.activeTurnId && !state.dispatchAttemptInFlight) nativeRuntime.beginTurnLifecycle();
      recordProviderClaimedPendingPromptIfNeeded(prompt, meta);
      pendingTerminalHostStartupFailurePromptMeta = meta ?? null;
      try {
        await observeCurrentReadiness();
      } finally {
        pendingTerminalHostStartupFailurePromptMeta = null;
      }
      const input = createClaudeUnifiedPromptInput({
        text: prompt,
        sessionId: params.happierSessionId,
        nonce: state.promptNonce,
        isSteer: false,
        localId: meta?.localId ?? null,
        localIds: meta?.localIds ?? [],
        userMessageSeq: meta?.userMessageSeq ?? null,
        userMessageSeqs: meta?.userMessageSeqs ?? [],
      });
      arbiter.enqueue(input);
      if (handlePendingRuntimeConfigDeliveryBlockerBeforeDrain()) {
        return;
      }
      await arbiter.drain();
      ensureReadinessWake();
    },
    setGoal: (objective, options) => goalRuntime.setGoal(objective, options),
    clearGoal: () => goalRuntime.clearGoal(),
    async steerInFlightTurn(message, meta) {
      recordProviderClaimedPendingPromptIfNeeded(message, meta);
      pendingTerminalHostStartupFailurePromptMeta = meta ?? null;
      try {
        await observeCurrentReadiness();
      } finally {
        pendingTerminalHostStartupFailurePromptMeta = null;
      }
      state.promptNonce += 1;
      const input = createClaudeUnifiedPromptInput({
        text: message,
        sessionId: params.happierSessionId,
        nonce: state.promptNonce,
        isSteer: true,
        localId: meta?.localId ?? null,
        localIds: meta?.localIds ?? [],
        userMessageSeq: meta?.userMessageSeq ?? null,
        userMessageSeqs: meta?.userMessageSeqs ?? [],
      });
      arbiter.enqueue(input);
      if (handlePendingRuntimeConfigDeliveryBlockerBeforeDrain()) {
        return;
      }
      await arbiter.drain();
      ensureReadinessWake();
    },
    // Host in-flight steer hooks (consumed by the session loop's InFlightSteerController):
    // a prompt delivered while a turn is running is steered into the live TUI when the
    // screen is provably safe; any veto throws so the host falls back to the bounded
    // pending queue and drains at turn end per policy.
    supportsInFlightSteer() {
      return true;
    },
    isTurnInFlight() {
      return !state.disposed && (state.turnInFlight || state.terminalOriginTurnInFlight);
    },
    canSteerPrompt() {
      return !state.disposed && (state.turnInFlight || state.terminalOriginTurnInFlight);
    },
    async steerPrompt(prompt: string, options?: ClaudeUnifiedPromptDeliveryMeta) {
      const text = readPromptText(prompt);
      if (!text) return;
      if (state.disposed) {
        throw new Error('claude_unified_steer_vetoed: runtime_disposed');
      }
      if (isNonSteerablePromptPayload(text)) {
        // Context-mutating special commands keep the deferred path and drain at turn end as
        // normal new-turn prompts. Other native Claude slash commands are accepted by the TUI's
        // own pending queue and sequenced at its safe boundary.
        params.ctx.logger.info('[ClaudeUnifiedTerminal] steer window vetoed', {
          sessionId: params.happierSessionId,
          decision: 'vetoed',
          reason: 'non_steerable_special_command',
        });
        throw new Error('claude_unified_steer_vetoed: non_steerable_special_command');
      }
      recordProviderClaimedPendingPromptIfNeeded(text, options);
      pendingTerminalHostStartupFailurePromptMeta = options ?? null;
      try {
        await observeCurrentReadiness();
      } finally {
        pendingTerminalHostStartupFailurePromptMeta = null;
      }
      if (lastReadinessKind !== 'writable' && lastReadinessKind !== 'writable_steer') {
        throw new Error(`claude_unified_steer_vetoed: ${lastSteerVetoReason ?? 'screen_not_steerable'}`);
      }
      state.promptNonce += 1;
      const input = createClaudeUnifiedPromptInput({
        text,
        sessionId: params.happierSessionId,
        nonce: state.promptNonce,
        isSteer: true,
        localId: options?.localId ?? null,
        localIds: options?.localIds ?? [],
        userMessageSeq: options?.userMessageSeq ?? null,
        userMessageSeqs: options?.userMessageSeqs ?? [],
      });
      arbiter.enqueue(input);
      if (handlePendingRuntimeConfigDeliveryBlockerBeforeDrain()) {
        return;
      }
      await arbiter.drain();
      ensureReadinessWake();
    },
    setOnPromptAcceptedByProvider(handler) {
      onPromptAcceptedByProviderHandler = handler;
    },
    setOnPromptTerminallyRejectedBeforeProvider(handler) {
      onPromptTerminallyRejectedBeforeProviderHandler = handler;
    },
    setOnPromptDeliveryBlockerCleared(handler) {
      onPromptDeliveryBlockerClearedHandler = handler;
    },
    setOnUndeliverablePrompts(handler) {
      onUndeliverablePromptsHandler = handler;
    },
    notifyPromptQueuedDuringTurn() {
      if (state.disposed) return;
      if (!state.turnInFlight && !state.terminalOriginTurnInFlight) return;
      staleTurnDemandActive = true;
      if (lastProviderActivityAtMs === null) lastProviderActivityAtMs = Date.now();
      ensureStaleTurnWake();
    },
    async clearTerminalComposer(request): Promise<SessionTerminalComposerClearResultV1> {
      const sessionId = request?.sessionId ?? params.happierSessionId;
      if (!isTuiRuntimeControlFeatureEnabled()) {
        return {
          ok: false,
          status: 'unsupported',
          sessionId,
          error: 'tui_runtime_control_unavailable',
        };
      }
      const handle = state.handle;
      if (state.disposed || !handle) {
        return {
          ok: false,
          status: 'no_live_terminal',
          sessionId,
          error: 'no_live_terminal',
        };
      }
      const port = await params.ctx.agentRuntime.terminalHost.controlPort(handle).catch((error: unknown) => {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] terminal composer clear control port unavailable', { error });
        return null;
      });
      if (!port) {
        return {
          ok: false,
          status: 'no_live_terminal',
          sessionId,
          error: 'no_terminal_control_port',
        };
      }

      const result = mapComposerClearResult(sessionId, await clearUserAuthorizedClaudeComposerDraft({
        port,
        wait: waitMs,
        settleMs: params.tuiControl?.timings?.commandSettleMs,
      }));
      if (!result.ok) return result;

      resetUserDraftStarvation();
      lastReadinessKind = state.turnInFlight || state.terminalOriginTurnInFlight ? 'writable_steer' : 'writable';
      lastSteerVetoReason = null;
      steerCapabilityPublisher.publish({ available: true, reason: null });
      arbiter.notifyTerminalComposerCleared(createClaudeUnifiedWritableReadiness(handle, state.activeTurnId));
      await arbiter.drain();
      ensureReadinessWake();
      return result;
    },
    async applyConfigDeltaInFlight(delta): Promise<ClaudeUnifiedInFlightConfigApplyOutcome> {
      const controller = await ensureTuiController();
      if (!controller) {
        // Gate off / no control port: the message keeps the legacy queue path so the mode
        // change applies when the queue drains at turn end.
        return { status: 'unsupported', reason: 'tui_runtime_control_unavailable' };
      }
      const outcome = await controller.applyPermissionModeInFlight({ permissionMode: delta.permissionMode });
      await controller.whenControlIdle();
      runtimeConfigOutcomeEmitter.emit(outcome);
      if (outcome.status === 'applied' && outcome.promptMayProceed) {
        launchPermissionMode = delta.permissionMode;
        return { status: 'applied' };
      }
      const detail = outcome.timing !== undefined ? `${outcome.status}:${outcome.timing}` : outcome.status;
      return { status: 'failed', reason: `in_flight_mode_apply_${detail}` };
    },
    async waitForTurnCompletion() {
      const failure = readTurnCompletionFailure();
      if (failure) throw failure;
      if (state.turnCompleted) {
        resetCompletedTurnState();
        return;
      }
      if (!state.turnInFlight && !state.providerAccepted && !state.dispatchAttemptInFlight) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = Object.freeze({
          resolve,
          reject,
        });
        completionWaiters.add(waiter);
        settleTurnCompletionWaiters();
      });
    },
    subscribeRuntimeEvents(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async respondToPermission(requestId, approved) {
      return respondToClaudePermission({
        ctx: params.ctx,
        provider: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
        requestId,
        approved,
      });
    },
    async cancelTurn() {
      stopReadinessWake();
      staleTurnDemandActive = false;
      stopStaleTurnWake();
      const handle = state.handle;
      if (handle) {
        await params.ctx.agentRuntime.terminalHost.interruptTurn(handle);
      }
      publishActiveTurnCancelled(Date.now(), 'user');
      state.turnInFlight = false;
      state.activeTurnId = null;
      state.activePromptText = null;
      state.dispatchAttemptInFlight = false;
      state.providerAccepted = false;
      state.turnCompleted = false;
      state.lastTurnFailure = null;
      state.terminalOriginTurnInFlight = false;
      lastTurnProgressPublishedAtMs = null;
      params.setThinking?.(false);
      rejectTurnCompletionWaiters(new Error('Claude unified terminal turn was cancelled'));
    },
    readSessionIdentity() {
      return { sessionId: state.providerSessionId };
    },
    async updateSessionRuntimeConfig(update) {
      const promptDependentUpdate = isRuntimeConfigUpdatePromptDependent(update);
      if (state.handle) {
        // The Claude TUI is already running. Convergence short-circuit (L5d, anti-hot-loop): when
        // every requested value already equals the effective config there is nothing left to
        // apply, so report `skipped_already_effective` and let the override-synchronizer stop
        // re-attempting it.
        if (isRuntimeConfigUpdateConvergedWithLaunch(update)) {
          return rememberRuntimeConfigUpdateOutcome(
            Object.freeze({ status: 'applied', timing: 'skipped_already_effective' } as const),
            promptDependentUpdate ? { promptMayProceed: true } : {},
          );
        }
        // Live TUI runtime control (feature-gated): route the update through the verified
        // controller (`/model`, `/effort`, ShiftTab mode cycling). Deferred timings keep the
        // override pending on the synchronizer; outcome events ride the runtime-config-outcome
        // session-event contract.
        const controller = await ensureTuiController();
        if (controller) {
          const resolution = mapRuntimeConfigUpdateToDesired(update, {
            launchPermissionMode,
            effectiveModelId: verifiedModelId ?? launchModelId,
          });
          if (resolution.kind === 'desired') {
            const outcome = await controller.applyDesiredRuntimeConfig({
              desired: resolution.desired,
              reason: 'out_of_band',
            });
            await controller.whenControlIdle();
            runtimeConfigOutcomeEmitter.emit(outcome);
            const mapped = mapApplyOutcomeToUpdateOutcome(outcome);
            if (mapped.status === 'applied' && mapped.timing !== 'queued_until_safe_window'
              && mapped.timing !== 'scheduled_for_next_prompt' && mapped.timing !== 'next_idle') {
              // Fold the now-effective values into the launch-effective baseline so the
              // convergence check and a future respawn reflect the applied config.
              if (resolution.desired.model !== undefined) launchModelId = resolution.desired.model;
              if (resolution.desired.reasoningEffort !== undefined) launchEffort = resolution.desired.reasoningEffort;
              if (resolution.desired.ultracode !== undefined) launchUltracode = resolution.desired.ultracode;
              if (resolution.desired.agentModeId === 'plan' || resolution.desired.permissionMode !== undefined) {
                launchPermissionMode = resolveClaudePermissionModeFromRuntimeMode({
                  permissionMode: resolution.desired.permissionMode ?? launchPermissionMode ?? 'default',
                  agentModeId: resolution.desired.agentModeId ?? null,
                });
              }
            }
            return rememberRuntimeConfigUpdateOutcome(
              Object.freeze(mapped),
              promptDependentUpdate ? { promptMayProceed: dependentRuntimeConfigPromptMayProceed(outcome) } : {},
            );
          }
          return rememberRuntimeConfigUpdateOutcome(Object.freeze({
            status: 'requires_interactive_control',
            reason: resolution.reason,
          } as const), promptDependentUpdate ? { promptMayProceed: false } : {});
        }
        // Gate off / no control port: model/effort/fallback stay launch-time only, so this
        // override cannot take effect now. A non-applied outcome (gap 27) keeps the override
        // pending on the host instead of marking it swallowed-but-applied.
        if (readNonEmptyString(update.permissionMode) !== null) {
          return rememberRuntimeConfigUpdateOutcome(Object.freeze({
            status: 'requires_restart',
            reason: 'tui_runtime_control_unavailable',
          } as const), { promptMayProceed: false });
        }
        return rememberRuntimeConfigUpdateOutcome(Object.freeze({
          status: 'requires_interactive_control',
          reason: 'claude_unified_terminal_running',
        } as const), promptDependentUpdate ? { promptMayProceed: false } : {});
      }
      const modelId = readNonEmptyString(update.modelId);
      if (modelId && modelId !== 'default') {
        launchModelId = modelId;
      }
      const fallbackModel = readNonEmptyString(update.fallbackModel);
      if (fallbackModel && fallbackModel !== 'default') {
        launchFallbackModelId = fallbackModel;
      } else if (update.fallbackModel === null) {
        launchFallbackModelId = null;
      }
      const effort = readEffortFromRuntimeConfigUpdate(update);
      if (effort) {
        launchEffort = effort;
      } else if (effort === null) {
        launchEffort = null;
      }
      const ultracode = readUltracodeFromRuntimeConfigUpdate(update);
      if (ultracode !== undefined) {
        launchUltracode = ultracode;
      }
      const permissionMode = readNonEmptyString(update.permissionMode);
      if (permissionMode) {
        launchPermissionMode = resolveClaudePermissionModeFromRuntimeMode({ permissionMode });
      }
      const modeId = readNonEmptyString(update.modeId);
      if (modeId) {
        // Plan wins over the raw permission mode at spawn; a non-plan agent mode leaves the
        // current launch permission mode intact (it has no Claude permission-mode equivalent).
        launchPermissionMode = resolveClaudePermissionModeFromRuntimeMode({
          permissionMode: launchPermissionMode ?? 'default',
          agentModeId: modeId,
        });
      }
      // Captured into the next launch args; it will take effect before the next prompt.
      return rememberRuntimeConfigUpdateOutcome(
        Object.freeze({ status: 'applied', timing: 'before_next_prompt' } as const),
        promptDependentUpdate ? { promptMayProceed: true } : {},
      );
    },
    async resetOrDisposeRuntime() {
      state.disposed = true;
      stopReadinessWake();
      clearQueuedBannerCustodyTimers();
      clearTurnEndDialogProbe();
      staleTurnDemandActive = false;
      stopStaleTurnWake();
      steerCapabilityPublisher.dispose();
      arbiter.dispose();
      runtimeConfigOutcomeEmitter.dispose();
      if (tuiController) {
        await tuiController.dispose().catch(() => undefined);
        tuiController = null;
        tuiControllerPromise = null;
      }
      resumeChoiceStartupHandler?.dispose();
      resumeChoiceStartupHandler = null;
      resumeChoiceControlPortPromise = null;
      const handle = state.handle;
      state.handle = null;
      params.setThinking?.(false);
      let terminalHostDisposeError: unknown;
      let cleanupError: unknown;
      const recordCleanupError = (error: unknown, message: string): void => {
        if (cleanupError === undefined) cleanupError = error;
        params.ctx.logger.warn(message, { error });
      };
      try {
        if (handle) await params.ctx.agentRuntime.terminalHost.dispose(handle);
      } catch (error) {
        terminalHostDisposeError = error;
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] terminal host dispose failed', { error });
      } finally {
        try {
          try {
            await providerTranscriptPublisher.dispose();
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] provider transcript cleanup failed');
          }
          // The provider-transcript drain above feeds the workflow source's last rows through
          // onObserveRow; flush any pending durable writes, then stop scheduling + drop the CWF4
          // registration.
          try {
            await workflowRuntime.flush();
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] workflow activity flush failed');
          } finally {
            workflowRuntime.dispose();
            disposeWorkflowOwnedToolUseIdsRegistration();
          }
          try {
            unsubscribeLifecycleEvents?.();
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] lifecycle unsubscribe failed');
          } finally {
            unsubscribeLifecycleEvents = null;
          }
          try {
            if (hookPluginDir) {
              await params.ctx.agentRuntime.sessionHooks.disposePluginDir(hookPluginDir);
            }
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] hook plugin cleanup failed');
          }
          try {
            await sessionHookServer?.dispose();
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] hook server cleanup failed');
          }
        } finally {
          sessionHookServer = null;
          hookPluginDir = null;
          hookSecret = null;
          sessionStartObservedForReadiness = false;
          state.providerSessionId = null;
          state.activeTurnId = null;
          state.activePromptText = null;
          state.dispatchAttemptInFlight = false;
          state.providerAccepted = false;
          state.turnCompleted = false;
          state.turnInFlight = false;
          state.terminalOriginTurnInFlight = false;
          state.lastTurnFailure = null;
          providerActivityLedger.clearProviderTasks();
          clearRuntimeActivitySources('runtime-dispose');
          lastTurnProgressPublishedAtMs = null;
          recentPrimaryProviderUnavailableForPromptDelivery = null;
          publishedLifecycleStartTurnIds.clear();
          publishedTerminalLifecycleTurnIds.clear();
          publishedFailureTurnIds.clear();
          rejectTurnCompletionWaiters(new Error('Claude unified terminal runtime was disposed'));
          handlers.clear();
        }
      }
      if (terminalHostDisposeError) throw terminalHostDisposeError;
      if (cleanupError) throw cleanupError;
    },
    async confirmProviderAcceptance(evidence) {
      const accepted = await arbiter.confirmProviderAcceptance(evidence);
      if (accepted) {
        params.setThinking?.(true);
      }
      return accepted;
    },
    async observeTerminalLifecycle(observation) {
      if (observation.agentId !== CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID) return;
      recordProviderActivity();
      if (observation.type === 'prompt_submitted') {
        const queuedCommandEvidence = observation.providerEvidence === 'queued_command';
        const acceptedQueuedPrompt = await nativeRuntime.confirmProviderAcceptance({
          ...(observation.promptText ? { promptText: observation.promptText } : {}),
          ...(observation.turnId ? { agentTurnId: observation.turnId } : {}),
          ...(queuedCommandEvidence ? { includeTimedOutAmbiguous: true } : {}),
        });
        if (acceptedQueuedPrompt) {
          // FIFO multi-steer: once the head prompt is accepted, re-evaluate the screen so
          // the next queued prompt (e.g. a second steer) can take its safe window.
          if (arbiter.snapshot().queuedCount > 0) {
            await observeCurrentReadiness();
            await arbiter.drain();
            ensureReadinessWake();
          }
          return;
        }
        if (
          state.dispatchAttemptInFlight
          && observation.promptText
          && ownInjectedTextLog.matches(observation.promptText)
        ) {
          rememberRecentProviderPromptSubmission({
            promptText: observation.promptText,
            agentTurnId: observation.turnId ?? null,
            queuedCommandEvidence,
          });
          return;
        }
        if (queuedCommandEvidence) return;
        recordTerminalOriginTurnStarted(observation.promptText);
        await materializeTerminalOriginPrompt({
          ...(observation.promptText ? { text: observation.promptText } : {}),
          ...(typeof observation.observedAtMs === 'number' ? { observedAtMs: observation.observedAtMs } : {}),
          ...(observation.turnId ? { agentTurnId: observation.turnId } : {}),
          source: observation.source,
        });
        return;
      }
      if (observation.type === 'compaction_started') {
        // Compaction supersedes any pending turn-end/idle dialog re-arm episode.
        clearTurnEndDialogProbe();
        arbiter.observeCompaction({ phase: 'started' });
        return;
      }
      if (observation.type === 'compaction_completed') {
        if (!rememberCompactionCompletedEventId(observation.agentEventId)) return;
        const acceptedCompactPrompt = await nativeRuntime.confirmProviderAcceptance({
          promptText: '/compact',
          includeTimedOutAmbiguous: true,
        });
        const completesActiveCompactPrompt = acceptedCompactPrompt || isCompactPromptText(state.activePromptText);
        arbiter.observeCompaction({ phase: 'completed' });
        if (completesActiveCompactPrompt) {
          state.providerAccepted = true;
          publishActiveTurnComplete(Date.now());
          state.turnCompleted = true;
          settleTurnCompletionWaiters();
          // Compaction completion also transitions to idle; a queued command dialog can pop here too.
          scheduleTurnEndDialogProbes();
          return;
        }
        await observeCurrentReadiness();
        await arbiter.drain();
        ensureReadinessWake();
        scheduleTurnEndDialogProbes();
        return;
      }
      if (observation.type === 'sidechain_activity') {
        observeSidechainRuntimeActivity(observation.sidechainAgentId);
        return;
      }
      if (observation.type === 'sidechain_terminal') {
        clearSidechainRuntimeActivity(observation.sidechainAgentId);
        return;
      }
      if (observation.type === 'completion_candidate') {
        observeProviderTaskTerminalCompletionWhenReady();
        return;
      }
      if (observation.type === 'completion_candidate_invalidated') {
        if (state.activeTurnId && publishedTerminalLifecycleTurnIds.has(state.activeTurnId)) return;
        state.turnCompleted = false;
        return;
      }
      if (observation.type === 'turn_failed') {
        if (observation.source === 'hook' && observation.sidechainAgentId) {
          // Sidechain StopFailure carve-out (ported R-11 / HF-3): subagent usage/auth evidence
          // stays valid at the ACCOUNT level but must never terminalize the parent turn.
          clearSidechainRuntimeActivity(observation.sidechainAgentId);
          await recordClaudeRuntimeProviderAccountUsageSnapshot({
            ctx: params.ctx,
            evidence: observation.evidence ?? observation.detail ?? observation.reason,
            sessionId: params.happierSessionId,
            launchEnv: params.launchEnv,
          });
          return;
        }
        if (consumeTerminalOriginTurnCompletion()) return;
        const allocateFailedTurn = !state.activeTurnId && state.dispatchAttemptInFlight;
        state.dispatchAttemptInFlight = false;
        const failureEvidence = observation.source === 'hook'
          ? observation.evidence ?? observation.detail ?? observation.reason
          : observation.reason;
        const failureFallbackMessage = observation.source === 'hook'
          ? observation.detail ?? observation.reason
          : observation.reason;
        await recordClaudeRuntimeProviderAccountUsageSnapshot({
          ctx: params.ctx,
          evidence: failureEvidence,
          sessionId: params.happierSessionId,
          launchEnv: params.launchEnv,
        });
        // Route an auth-failure StopFailure (not a usage limit) into the daemon's runtime-auth
        // recovery owner so an auth-failed turn triggers the same reactive recovery as the SDK path.
        void reportClaudeUnifiedTerminalStopFailureRuntimeAuth({
          ctx: params.ctx,
          happierSessionId: params.happierSessionId,
          evidence: failureEvidence,
        });
        recordPrimaryProviderUnavailableForPromptDelivery(failureEvidence, Date.now());
        state.lastTurnFailure = recordClaudeUnifiedTurnFailure({
          evidence: failureEvidence,
          fallbackMessage: failureFallbackMessage,
          handlers,
          logger: params.ctx.logger,
          publishedFailureTurnIds,
          sessionId: params.happierSessionId,
          turnId: state.activeTurnId,
          allocateTurnWhenIdle: allocateFailedTurn,
        });
        if (!arbiter.observePendingProviderAcceptanceTerminalFailure()) {
          arbiter.armPendingProviderAcceptanceTimeout();
        }
        state.turnCompleted = true;
        params.setThinking?.(false);
        settleTurnCompletionWaiters();
        return;
      }
      if (observation.type === 'turn_aborted') {
        arbiter.armPendingProviderAcceptanceTimeout();
        if (consumeTerminalOriginTurnCompletion()) return;
        state.dispatchAttemptInFlight = false;
        publishActiveTurnCancelled(Date.now(), observation.reason);
        state.turnInFlight = false;
        state.activeTurnId = null;
        state.activePromptText = null;
        state.providerAccepted = false;
        state.turnCompleted = false;
        state.terminalOriginTurnInFlight = false;
        state.lastTurnFailure = null;
        lastTurnProgressPublishedAtMs = null;
        params.setThinking?.(false);
        rejectTurnCompletionWaiters(new Error(observation.detail));
        return;
      }
      if (observation.type === 'process_exited' && (state.turnInFlight || state.dispatchAttemptInFlight)) {
        state.dispatchAttemptInFlight = false;
        state.lastTurnFailure = recordClaudeUnifiedProcessExitFailure({
          exitCode: observation.exitCode, signal: observation.signal, handlers,
          logger: params.ctx.logger, publishedFailureTurnIds,
          sessionId: params.happierSessionId, turnId: state.activeTurnId,
        });
        state.turnCompleted = true;
        params.setThinking?.(false);
        settleTurnCompletionWaiters();
        return;
      }
      if (observation.type === 'process_exited' && !state.disposed) {
        // IDLE host death (SILENT-F1 port): the Claude process died between turns. Surface a
        // structured failed turn (allocated begin+fail) instead of staying silent. Turn state
        // is deliberately untouched — there is no in-flight turn to settle and the allocated
        // failure must not poison the next turn's completion contract.
        recordClaudeUnifiedProcessExitFailure({
          exitCode: observation.exitCode, signal: observation.signal, handlers,
          logger: params.ctx.logger, publishedFailureTurnIds,
          sessionId: params.happierSessionId, turnId: null,
          allocateTurnWhenIdle: true,
        });
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] host process exited while session was idle', {
          sessionId: params.happierSessionId,
          exitCode: observation.exitCode,
          signal: observation.signal,
        });
      }
    },
  };

  unsubscribeLifecycleEvents = subscribeClaudeUnifiedTerminalLifecycleEvents({
    ctx: params.ctx,
    happierSessionId: params.happierSessionId,
    observer: nativeRuntime,
  });

  return createClaudePublicSessionRuntime(nativeRuntime);
}
