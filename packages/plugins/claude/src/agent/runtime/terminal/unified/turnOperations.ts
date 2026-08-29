import { sleep } from '@happier-dev/plugin-sdk/async';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  TerminalHostHandle,
  TerminalHostPreference,
  TerminalControlPort,
  TerminalPromptInput,
  TerminalInputInjectionResult,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  AgentRuntimeJsonValueSchema,
  type AgentSessionHookServerHandle,
  type AgentSessionHooksService,
  type AgentSessionHostServices,
  type AgentSessionAuthRefreshRequest,
  type AgentSessionRuntimeContext,
  type AgentSessionTerminalComposerClearOutcome,
  type AgentSessionProviderBinding,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/sessions/work-state';
import {
  isNonSteerablePromptPayload,
  parseSpecialCommand,
} from '@happier-dev/plugin-sdk/sessions';
import { isRuntimeConfigUpdateOutcomeApplied } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ClaudeUnifiedTerminalWorkspaceTrustPolicy } from '../../../../agentSettings/definition.js';
import { createClaudeRuntimeActivityPublisher } from '../../shared/runtimeActivityPublisher.js';
import { resolveClaudeLaunchSettingsOverlayArgs } from '../../launchSettings.js';
import { randomUUID } from 'node:crypto';
import { resolveClaudeTerminalHostDisposeIntent } from './terminalHostDisposeIntent.js';
import {
  buildClaudeHookPluginHooks,
  buildClaudeHookPluginManifest,
} from '../../../hooks/settings.js';
import { buildDefaultPermissionHookResponse } from '../../../hooks/protocol.js';
import { resolveClaudePermissionHookCeilingMs } from '../../../hooks/permissionHookTimeout.js';
import { createClaudeStatuslineApplier } from '../../../statusline/apply.js';
import {
  readClaudeMainChainAssistantModelId,
  type ClaudeEffectiveModelEvidence,
  type ClaudeEffectiveModelEvidenceSubscription,
} from '../../effectiveModelEvidence.js';
import {
  buildClaudeStatuslineOverlaySettings,
  resolveClaudeStatuslineOriginalCommand,
  type ClaudeStatuslineOverlaySettings,
} from '../../../statusline/overlay.js';
import { parseClaudeStatuslinePayload } from '../../../statusline/payload.js';

import { recordClaudeRuntimeProviderAccountUsageSnapshot } from '../../accountUsage.js';
import type { ClaudeRuntimeAccountUsageService } from '../../accountUsage.js';
import type { ClaudePermissionContext } from '../../../permissions/createClaudePermissionEngine.js';
import type { ClaudeRuntimeLogger } from '../../dependencies.js';
import {
  containsDefinitiveClaudeOAuthRevocationEvidence,
  createClaudeConnectedServiceRuntimeAuthAdapter,
  readClaudeSubscriptionRuntimeAuthSelectionFromEnv,
} from '../../../auth/services/runtime/index.js';
import {
  isClaudeTaskNotificationPromptText,
  type ClaudeTerminalLifecycleObservation,
} from '../lifecycle.js';
import { CLAUDE_TERMINAL_YOLO_ALLOW_FLAG } from '../argv.js';
import { buildClaudeEffortCliArgs, isClaudeUltracodeSupportedModelId } from '../../reasoningEffort.js';
import { mapToClaudePermissionMode, resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import { isSidechainSessionHook } from '../../../hooks/sidechain.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';
import {
  createClaudeUnifiedInputArbiter,
  hasCanonicalPendingOwner,
  isClaudeUnifiedPromptDeliveryBlockReversible,
  type ClaudeUnifiedInputArbiter,
  type ClaudeUnifiedPromptDeliveryBlockedReason,
  type ClaudeUnifiedPromptInjectionFailure,
  type ClaudeUnifiedPromptTerminalRejection,
} from './inputArbiter.js';
import {
  mapClaudeUnifiedHookLifecyclePayload,
  mapClaudeUnifiedTranscriptLifecyclePayload,
} from './lifecycleEvents.js';
import { createPersistedClaudeUnifiedOwnInjectedTextLog } from './ownInjectedTextLog.js';
import { isControllerTypedSlashCommandResidue } from './tuiControls/slashControls.js';
import {
  hasClaudeUnifiedVisibleDialog,
  resolveClaudeUnifiedDialogBlockedReason,
  type ClaudeUnifiedDialogBlockedReason,
} from './tuiControls/dialogRegistry.js';
import { createClaudeUnifiedPermissionHookHandler } from './permissionHooks.js';
import { createClaudeUnifiedPromptEchoSuppressor } from './promptEchoSuppression.js';
import { normalizeClaudeActivityStatusSignal } from '../../../activityStatus.js';
import { readClaudeJsonlRowTimestampMs } from '../../../transcripts/jsonlReplaySuppression.js';
import { parseClaudeTaskNotification } from '../../../transcripts/taskNotification.js';
import { createClaudeUnifiedTerminalOriginLocalIdAllocator } from './terminalOriginLocalIds.js';
import { buildClaudeJsonlProviderFactLocalIdFromParts } from '../../../transcripts/providerFactIdentity.js';
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
  type ClaudeWorkflowHeadlinePublisher,
  type ClaudeWorkflowSystemRecordReader,
  type ClaudeWorkflowSystemRecordWriter,
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
import { isClaudeUnifiedPendingInputInterruptAndRunEnabled } from './pendingInputInterruptAndRunActivation.js';
import { captureScreenState } from './tuiControls/controlRuntime.js';
import { createClaudeUnifiedResumeTurnBarrier } from './resumeTurnBarrier.js';
import {
  applyClaudeUnifiedTerminalLaunchIntent,
  type ClaudeUnifiedTerminalLaunchIntent,
} from './launchIntent.js';
import { createClaudeUnifiedTerminalRuntimeState } from './runtimeState.js';
import {
  ClaudeUnifiedResumeIdentityMismatchError,
  ClaudeUnifiedTerminalInjectionFailureError,
  recordClaudeUnifiedHookActivationFailure,
  recordClaudeUnifiedProcessExitFailure,
  recordClaudeUnifiedResumeIdentityMismatchFailure,
  recordClaudeUnifiedTurnFailure,
} from './turnFailures.js';
import { mapClaudeProviderFailureToUsageDetails } from '../../issues/runtimeIssues.js';
import { buildClaudeAssistantUsageObservation } from '../../../usage/buildAssistantObservation.js';
import { buildClaudeSdkResultUsageObservation } from '../../../usage/buildSdkResultObservation.js';
import type {
  ClaudeUsageObservation,
  ClaudeUsageObservationSubscription,
} from '../../../usage/types.js';
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
  CLAUDE_UNIFIED_TERMINAL_INPUT_QUIET_PERIOD_MS,
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
  readClaudePendingLocalId,
  type ClaudeProviderConfigurationOutcome,
  type ClaudeRuntimePromptSubmissionOutcome,
  type ClaudeRuntimeTurnOperations,
} from '../../providerOperations.js';
import type {
  ClaudeProviderEvent,
} from '../../providerEvents.js';
import {
  createClaudeProviderActivityLedger,
} from '../../remote/sdk/providerActivity.js';
import {
  applyClaudeProviderTaskActivity,
  observeClaudeProviderTaskActivity,
  publishClaudeProviderTaskInventory,
  readClaudeRuntimeConfigEffortUpdate,
  readClaudeRuntimeConfigUltracodeUpdate,
  respondToClaudePermission,
} from '../../shared/runtimeHelpers.js';

type ClaudeUnifiedSessionHooksService = Omit<
  AgentSessionHooksService,
  'startServer' | 'createPluginDir'
> & Readonly<{
  startServer(
    request: Parameters<AgentSessionHooksService['startServer']>[0] & Readonly<{
      providerId: string;
      sessionId: string;
      lifecycle: Readonly<{ kind: 'session'; sessionId: string }>;
    }>,
  ): Promise<AgentSessionHookServerHandle>;
  createPluginDir(
    request: Parameters<AgentSessionHooksService['createPluginDir']>[0] & Readonly<{
      providerId: string;
      lifecycle: Readonly<{ kind: 'session'; sessionId: string }>;
    }>,
  ): Promise<string>;
}>;

export type ClaudeUnifiedTerminalContext = ClaudePermissionContext & Readonly<{
  logger: ClaudeRuntimeLogger;
  features: Readonly<{ isEnabled(featureId: string): boolean }>;
  storage: Readonly<{
    daemonSession: Readonly<{
      get<T = unknown>(key: string): Promise<T | null>;
      set(key: string, value: unknown): Promise<void>;
    }>;
  }>;
  agentRuntime: Readonly<{
    terminalHost: NonNullable<AgentSessionHostServices['terminalHost']>;
    sessionHooks: ClaudeUnifiedSessionHooksService;
    transcripts: AgentSessionHostServices['transcripts'];
    accountUsage: ClaudeRuntimeAccountUsageService;
    nativeHome?: AgentSessionHostServices['nativeHome'];
    toolExecution: AgentSessionHostServices['toolExecution'];
  }>;
  sessions: Readonly<{
    current: ClaudePermissionContext['sessions']['current'] & Readonly<{
      workflowActivity: Readonly<{ publishHeadlines: ClaudeWorkflowHeadlinePublisher }>;
      writeSystemRecord: ClaudeWorkflowSystemRecordWriter;
      readSystemRecord: ClaudeWorkflowSystemRecordReader;
      writeStateField(request: Readonly<{
        fieldId: 'identity.providerSessionId';
        value: Readonly<{ metadataKey: 'claudeSessionId'; value: string }>;
        reason: string;
      }>): Promise<void>;
      auth?: Readonly<{
        services?: Readonly<{
          refreshRuntimeAuth?(
            request: AgentSessionAuthRefreshRequest & Readonly<{ agentId: string }>,
            options?: Readonly<{ signal?: AbortSignal }>,
          ): Promise<unknown>;
        }>;
      }>;
    }>;
  }>;
}>;

const claudeUnifiedTerminalRuntimeAuthAdapter = createClaudeConnectedServiceRuntimeAuthAdapter();

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Route exact Claude subscription auth evidence through the existing session runtime-auth owner.
 * The caller keeps generic sidechain failures inert; only the provider-owned revoked/expired marker
 * may repair the shared credential without failing the healthy parent turn.
 */
async function reportClaudeUnifiedTerminalStopFailureRuntimeAuth(params: Readonly<{
  ctx: ClaudeUnifiedTerminalContext;
  happierSessionId: string;
  evidence: unknown;
  launchEnv: Readonly<Record<string, string>>;
}>): Promise<void> {
  const refreshRuntimeAuth = params.ctx.sessions.current.auth?.services?.refreshRuntimeAuth;
  if (typeof refreshRuntimeAuth !== 'function') return;
  const selection = readClaudeSubscriptionRuntimeAuthSelectionFromEnv(params.launchEnv);
  if (!selection) return;
  const classification = claudeUnifiedTerminalRuntimeAuthAdapter.classifyRuntimeAuthFailure({
    target: { agentId: 'claude' },
    selection,
    error: params.evidence,
  });
  // Only genuine auth failures route to recovery; usage/rate/capacity classifications stay on the
  // existing usage-snapshot path.
  if (!classification || (classification.limitCategory !== 'auth_invalid' && classification.kind !== 'auth_expired')) {
    return;
  }
  const jsonClassification = AgentRuntimeJsonValueSchema.safeParse(classification);
  if (
    !jsonClassification.success
    || !isJsonRecord(jsonClassification.data)
  ) return;
  const jsonSelection = AgentRuntimeJsonValueSchema.safeParse(selection);
  if (!jsonSelection.success || !isJsonRecord(jsonSelection.data)) return;
  await refreshRuntimeAuth({
    agentId: 'claude',
    serviceId: 'claude-subscription',
    targetId: params.happierSessionId,
    reason: 'claude_unified_terminal_stop_failure_auth',
    selection: jsonSelection.data,
    expectedCredentialRevision: selection.credentialRevision,
    refreshAttemptId: `claude-auth-refresh-${randomUUID()}`,
    classification: jsonClassification.data,
  }).catch(() => undefined);
}

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

export type ClaudeUnifiedTerminalTurnOperationsParams = Readonly<{
  ctx: ClaudeUnifiedTerminalContext;
  activeInput?: Pick<
    AgentSessionRuntimeContext['session']['services']['activeInput'],
    'publishStatus'
  >;
  directory: string;
  happierSessionId: string;
  hostPreference: TerminalHostPreference;
  launchEnv: Readonly<Record<string, string>>;
  supportsEffort?: boolean;
  providerModel?: AgentSessionProviderBinding['model'];
  initialModelId?: string | null;
  initialEffort?: string | null;
  initialUltracode?: boolean;
  permissionMode: string | null;
  /** Persisted workflow headline from the session snapshot that created this runtime. */
  initialWorkflowActivityHeadline?: unknown;
  /** Its agent-scoped half, written in the same metadata update — the only one that names agents. */
  initialAgentActivityHeadline?: unknown;
  knownProviderSession?: Readonly<{
    providerSessionId: string;
    transcriptPath: string;
  }> | null;
  launchIntent?: ClaudeUnifiedTerminalLaunchIntent;
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
  /** Account-scoped policy for Claude's provider-owned pre-hook workspace trust prompt. */
  workspaceTrustPolicy?: ClaudeUnifiedTerminalWorkspaceTrustPolicy | null | undefined;
  /**
   * Dialog-resolution tuning (test seam). `turnEndProbeDelaysMs` are the absolute offsets (from turn
   * settle) of the bounded turn-end/idle dialog re-arm tail; `injectionBlockEscalationMs` is the
   * one-shot escalation window for a registry-recognized dialog blocking prompt delivery.
   */
  dialogResolution?: Readonly<{
    turnEndProbeDelaysMs?: readonly number[];
    injectionBlockEscalationMs?: number;
  }>;
  /** Native AgentRuntime work-state projection; omitting it preserves the legacy metadata owner. */
  publishGoalWorkState?: (snapshot: SessionWorkStateV1) => void;
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

type ClaudeUnifiedSessionHookServer = AgentSessionHookServerHandle & Readonly<{
  sessionHookSecretFile?: string;
  permissionHookSecretFile?: string;
}>;

type WithSessionId<T> = T extends unknown
  ? T & Readonly<{ sessionId: string }>
  : never;

type ClaudeSessionTerminalComposerClearResult =
  WithSessionId<AgentSessionTerminalComposerClearOutcome>;

type SessionTerminalComposerClearFailureStatusV1 = Extract<
  ClaudeSessionTerminalComposerClearResult,
  { ok: false }
>['status'];

type ClaudeUnifiedPromptDeliveryBlockerClear = Readonly<{
  deliveryBlockedReason?: ClaudeUnifiedPromptDeliveryBlockedReason;
}>;

export type ClaudeUnifiedTerminalNativeRuntime = ClaudeRuntimeTurnOperations & Readonly<{
  promptCustody: 'unified_terminal';
  subscribeEffectiveModel: ClaudeEffectiveModelEvidenceSubscription;
  subscribeUsageObservation: ClaudeUsageObservationSubscription;
  subscribeCanonicalAgentSessionEvents: ReturnType<typeof createClaudeRuntimeActivityPublisher>['subscribe'];
  confirmProviderAcceptance(evidence?: Readonly<{
    promptText?: string;
    exactPromptText?: boolean;
    includeTimedOutAmbiguous?: boolean;
    agentTurnId?: string | null;
  }>): Promise<boolean>;
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
  setOnPromptDeliveryOutcome(handler: ((outcome: ClaudeUnifiedPromptDeliveryOutcome) => void) | null): void;
  setOnPromptDeliveryBlockerCleared(
    handler: (info?: ClaudeUnifiedPromptDeliveryBlockerClear) => void,
  ): void;
  setOnUndeliverablePrompts(
    handler: (prompts: ReadonlyArray<ClaudeUnifiedUndeliverablePrompt>) => void,
  ): void;
  sendProviderTurnPrompt(
    prompt: string,
    meta?: ClaudeUnifiedPromptDeliveryMeta,
  ): Promise<ClaudeRuntimePromptSubmissionOutcome>;
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
  canInterruptForPendingInput(): boolean;
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
  clearTerminalComposer(request?: Readonly<{
    sessionId?: string;
    expectedStateAtMs?: number;
  }>): Promise<ClaudeSessionTerminalComposerClearResult>;
  releaseConnectedServiceUsageLimitDialog(): Promise<void>;
  interruptPendingInputAndRun(request: Readonly<{
    sessionId?: string;
    localId: string;
    expectedStateAtMs?: number;
  }>): Promise<unknown>;
}>;

type ClaudeUnifiedPromptDeliveryMeta = Readonly<{
  localId?: string | null;
  localIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;

export type ClaudeUnifiedPromptDeliveryIdentity = Readonly<{
  localIds?: readonly string[];
  userMessageSeq: number | null;
  userMessageSeqs?: readonly number[];
  deliveryBlockedReason?: ClaudeUnifiedPromptDeliveryBlockedReason;
}>;

export type ClaudeUnifiedPromptDeliveryOutcome = ClaudeUnifiedPromptDeliveryIdentity & Readonly<{
  type: 'custody_observed' | 'provider_accepted' | 'rejected_before_write' | 'possible_write';
  reason?: string;
}>;

type RecentProviderPromptSubmissionEvidence = Readonly<{
  promptText: string;
  agentTurnId: string | null;
  queuedCommandEvidence: boolean;
  source: 'hook' | 'transcript';
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
): ClaudeSessionTerminalComposerClearResult {
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
  return readClaudeMainChainAssistantModelId(row);
}

function readTaskNotificationTranscriptIdentity(row: unknown): Readonly<{
  sessionId: string;
  promptId: string | null;
  uuid: string;
}> | null {
  if (!isRecord(row) || row.type !== 'user' || row.isSidechain === true) return null;
  const origin = isRecord(row.origin) ? row.origin : null;
  const message = isRecord(row.message) ? row.message : null;
  const content = readNonEmptyString(message?.content);
  if (readNonEmptyString(origin?.kind) !== 'task-notification' && !isClaudeTaskNotificationPromptText(content)) {
    return null;
  }
  const sessionId = readNonEmptyString(row.session_id) ?? readNonEmptyString(row.sessionId);
  const uuid = readNonEmptyString(row.uuid);
  if (!sessionId || !uuid) return null;
  return {
    sessionId,
    promptId: readNonEmptyString(row.prompt_id) ?? readNonEmptyString(row.promptId),
    uuid,
  };
}

function isMatchingTaskNotificationAssistantReaction(
  row: unknown,
  pending: Readonly<{ sessionId: string; transcriptUuid: string }>,
): boolean {
  if (!isRecord(row) || row.type !== 'assistant') return false;
  if (row.isSidechain === true || row.isReplay === true || row.is_replay === true) return false;
  const sessionId = readNonEmptyString(row.session_id) ?? readNonEmptyString(row.sessionId);
  const parentUuid = readNonEmptyString(row.parentUuid) ?? readNonEmptyString(row.parent_uuid);
  return sessionId === pending.sessionId && parentUuid === pending.transcriptUuid;
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
): ClaudeUnifiedTerminalNativeRuntime {
  const state = createClaudeUnifiedTerminalRuntimeState();
  const handlers = new Set<(message: ClaudeProviderEvent) => void>();
  const effectiveModelListeners = new Set<(evidence: ClaudeEffectiveModelEvidence) => void>();
  const usageObservationListeners = new Set<(observation: ClaudeUsageObservation) => void>();
  let currentProviderModel = params.providerModel;
  const completionWaiters = new Set<TurnCompletionWaiter>();
  const publishedFailureTurnIds = new Set<string>();
  const observedCompactionCompletedEventIds = new Set<string>();
  const providerActivityLedger = createClaudeProviderActivityLedger();
  const runtimeActivityPublisher = createClaudeRuntimeActivityPublisher({
    sessionId: params.happierSessionId,
  });
  let pendingTaskNotificationReaction: {
    sessionId: string;
    promptId: string | null;
    transcriptUuid: string | null;
  } | null = null;
  const promptEchoSuppressor = createClaudeUnifiedPromptEchoSuppressor();
  const terminalOriginLocalIds = createClaudeUnifiedTerminalOriginLocalIdAllocator({
    ctx: params.ctx,
    sessionId: params.happierSessionId,
  });

  function publishProviderTaskInventory(reason: string): void {
    publishClaudeProviderTaskInventory({
      logger: params.ctx.logger,
      logPrefix: '[ClaudeUnifiedTerminal]',
      ledger: providerActivityLedger,
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
  // literal `/goal …` user turn via `sendProviderTurnPrompt` (late-bound below, since the
  // native runtime that owns `sendProviderTurnPrompt` is created further down).
  const goalRuntime = createClaudeUnifiedGoalRuntime({
    backendId: 'claude',
    agentId: 'claude',
    getCurrentClaudeSessionId: () => state.providerSessionId ?? null,
    ...(params.publishGoalWorkState
      ? { publishWorkStateSnapshot: params.publishGoalWorkState }
      : {}),
    injectGoalCommand: async (message) => { await nativeRuntime.sendProviderTurnPrompt(message); },
    logError: (message, error) => { params.ctx.logger.debug(`[ClaudeUnifiedTerminal] ${message}`, { error }); },
  });
  // Centralized Claude Dynamic Workflow ACTIVITY runtime (CWF2/CWF3/CWF4). Observes the SAME raw
  // transcript channel as the goal source; turns `Workflow`/`Task`/`task_progress` events into durable
  // `activity/workflow_run.v1` records (record-FIRST via the private host-owned System Records port)
  // plus the compact `sessionWorkflowActivityHeadlineV1` headline (SECOND via its typed owner).
  const workflowRuntime = createClaudeUnifiedWorkflowRuntime({
    backendId: 'claude',
    agentId: 'claude',
    getCurrentClaudeSessionId: () => state.providerSessionId ?? null,
    writeSystemRecord: async (request) => {
      await params.ctx.sessions.current.writeSystemRecord(request);
    },
    readSystemRecord: async (request) =>
      await params.ctx.sessions.current.readSystemRecord(request),
    publishHeadlines: async (bundle) => {
      await params.ctx.sessions.current.workflowActivity.publishHeadlines(bundle);
    },
    fileFollow: params.ctx.agentRuntime.transcripts.fileFollow,
    initialWorkflowActivityHeadline: params.initialWorkflowActivityHeadline,
    initialAgentActivityHeadline: params.initialAgentActivityHeadline,
    onProviderTaskActivity: (activity) => {
      applyClaudeProviderTaskActivity({
        activity,
        ledger: providerActivityLedger,
        runtimeActivityPublisher,
        logger: params.ctx.logger,
        logPrefix: '[ClaudeUnifiedTerminal]',
      });
    },
    logError: (message, error) => { params.ctx.logger.debug(`[ClaudeUnifiedTerminal] ${message}`, { error }); },
    // On `warn`, not `debug`: a session process runs at `info`, so a debug line here could never be
    // seen in the situation it exists to report.
    reportShapeDrift: (message) => { params.ctx.logger.warn(`[ClaudeUnifiedTerminal] ${message}`); },
  });
  const publishUsageObservation = (observation: ClaudeUsageObservation | null): void => {
    if (!observation) return;
    for (const listener of usageObservationListeners) listener(observation);
  };
  const providerTranscriptPublisher = createClaudeUnifiedProviderTranscriptPublisher({
    ctx: params.ctx,
    onPublishPayload: async (payload) => {
      if (
        payload.kind === 'slash_command'
        && parseSpecialCommand(payload.text ?? '').type === 'compact'
      ) {
        // Resume-from-summary is submitted by Claude itself and appears as an authenticated
        // provider transcript slash-command row rather than a UserPromptSubmit hook. Confirm the
        // existing provisional resume turn at that exact boundary so the idle-release timer cannot
        // falsely cancel an active compaction. This is lifecycle evidence only, never Pending
        // acceptance for the queued user prompt that follows compaction.
        nativeResumeTurnBarrier?.observePromptStart();
      }
      const observation = mapClaudeUnifiedTranscriptLifecyclePayload(payload, params.happierSessionId);
      if (observation) await nativeRuntime.observeTerminalLifecycle(observation);
    },
    onObserveRow: async (row, observation) => {
      const modelSource = currentProviderModel ? 'provider' as const : 'claude-native' as const;
      const observedAtMs = readClaudeJsonlRowTimestampMs(row)
        ?? (observation.historicalReplay ? undefined : Date.now());
      if (row.type === 'assistant' && row.message?.usage) {
        publishUsageObservation(buildClaudeAssistantUsageObservation({
          modelId: readAssistantModelId(row) ?? verifiedModelId ?? launchModelId,
          modelSource,
          ...(observedAtMs === undefined ? {} : { observedAtMs }),
          usage: row.message.usage,
        }));
      } else if (row.type === 'result') {
        const selectedModelId = verifiedModelId ?? launchModelId ?? currentProviderModel?.id ?? null;
        const modelUsageIds = Object.keys(row.modelUsage);
        const resultModelId = selectedModelId && modelUsageIds.includes(selectedModelId)
          ? selectedModelId
          : modelUsageIds.length === 1
            ? modelUsageIds[0]!
            : selectedModelId;
        if (resultModelId) {
          publishUsageObservation(buildClaudeSdkResultUsageObservation({
            modelId: resultModelId,
            modelSource,
            ...(observedAtMs === undefined ? {} : { observedAtMs }),
            result: row,
          }));
        }
      }
      observeTaskNotificationReactionTranscriptRow(row);
      await statuslineApplier.applyModelEvidence({
        modelId: readAssistantModelId(row),
      });
      // ONE raw channel, two provider-clean sources: goal status + workflow activity.
      observeProviderTaskActivity(row);
      if (!observation.historicalReplay) {
        observeProviderTaskNotificationTerminal(row, observation.providerSessionId);
      }
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
  let onPromptDeliveryOutcomeHandler:
    ((outcome: ClaudeUnifiedPromptDeliveryOutcome) => void) | null = null;
  let onPromptDeliveryBlockerClearedHandler:
    ((info?: ClaudeUnifiedPromptDeliveryBlockerClear) => void) | null = null;
  let onUndeliverablePromptsHandler:
    ((prompts: ReadonlyArray<ClaudeUnifiedUndeliverablePrompt>) => void) | null = null;
  const promptDeliveryTerminalWaiters = new Map<TerminalPromptInput, () => void>();

  function waitForPromptDeliveryTerminal(input: TerminalPromptInput): Readonly<{
    promise: Promise<void>;
    cancel: () => void;
  }> {
    let resolveTerminal: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    promptDeliveryTerminalWaiters.set(input, resolveTerminal);
    return {
      promise,
      cancel: () => {
        if (promptDeliveryTerminalWaiters.get(input) === resolveTerminal) {
          promptDeliveryTerminalWaiters.delete(input);
        }
      },
    };
  }

  function settlePromptDeliveryTerminal(input: TerminalPromptInput): void {
    const resolveTerminal = promptDeliveryTerminalWaiters.get(input);
    if (!resolveTerminal) return;
    promptDeliveryTerminalWaiters.delete(input);
    resolveTerminal();
  }

  function settleAllPromptDeliveryTerminalWaiters(): void {
    const resolveTerminals = [...promptDeliveryTerminalWaiters.values()];
    promptDeliveryTerminalWaiters.clear();
    for (const resolveTerminal of resolveTerminals) resolveTerminal();
  }
  let recentPrimaryProviderUnavailableForPromptDelivery:
    ClaudeUnifiedProviderUnavailablePromptDeliveryWindow | null = null;
  let sessionHookServer: ClaudeUnifiedSessionHookServer | null = null;
  let hookPluginDir: string | null = null;
  let hookSecret: string | null = null;
  let statuslineOverlaySettings: ClaudeStatuslineOverlaySettings | null = null;
  let statuslineTranscriptPath: string | null = null;
  // Transcript path this terminal ATTACHED to for the current provider session
  // id. Distinct from `statuslineTranscriptPath`, which only needs a plausible
  // path for the overlay; only an attached binding is continuity proof.
  let provenTranscriptPath: string | null = null;
  // Matched-pair dedupe key: "<providerSessionId> <proven transcriptPath or empty>".
  let publishedProviderSessionId: string | null = null;
  let knownProviderSessionBound = false;
  let sessionStartObservedForReadiness = false;
  let nativeResumeTurnBarrier: ReturnType<typeof createClaudeUnifiedResumeTurnBarrier> | null = null;
  const requestedResumeProviderSessionId = params.launchIntent?.kind === 'resume_native'
    ? params.launchIntent.providerSessionId
    : null;
  let explicitResumeIdentityEstablished = requestedResumeProviderSessionId === null;
  let explicitResumeIdentityFailure: ClaudeUnifiedResumeIdentityMismatchError | null = null;
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
    onEffectiveModel: (evidence) => {
      for (const listener of effectiveModelListeners) listener(evidence);
    },
    onModelChanged: async (change) => {
      await publishSessionEvent({
        id: change.eventId,
        type: 'message',
        message: `Model changed to ${change.modelId}`,
      }, {
        failureWarnMessage: '[ClaudeUnifiedTerminal] model-change event publish failed',
        debugMeta: { modelId: change.modelId, previousModelId: change.previousModelId },
      });
    },
  });
  let launchModelId: string | null = readNonEmptyString(params.initialModelId);
  let launchFallbackModelId: string | null = null;
  let launchEffort: string | null = params.supportsEffort === false
    ? null
    : readNonEmptyString(params.initialEffort);
  let launchUltracode = params.supportsEffort !== false && params.initialUltracode === true;
  // Effective permission mode at spawn. Plan-inclusive: a pre-launch `{modeId:'plan'}` toggle
  // wins over the raw permission mode so the TUI launches in plan rather than the raw mode.
  let launchPermissionMode: string | null = params.permissionMode;

  /**
   * Publishes the resume id together with the transcript path that holds its
   * conversation, when this terminal has an attached transcript binding for that
   * exact id.
   *
   * Dedupe is keyed on the matched pair rather than the id: the terminal learns
   * the id first and its transcript later, so an id-keyed guard would drop the
   * very update that carries the path.
   */
  function publishProviderSessionId(nextSessionId: string, reason: string): void {
    const nativeSessionLogPath = provenTranscriptPath?.trim() || null;
    const publishedIdentity = `${nextSessionId} ${nativeSessionLogPath ?? ''}`;
    if (publishedProviderSessionId === publishedIdentity) return;
    publishedProviderSessionId = publishedIdentity;
    publishClaudeUnifiedRuntimeEvent({
      handlers,
      logger: params.ctx.logger,
      event: {
        kind: 'session-id-publish',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        publishedSessionId: nextSessionId,
        source: reason,
        ...(nativeSessionLogPath ? { nativeSessionLogPath } : {}),
      },
    });
  }

  function adoptProviderSessionId(input: Readonly<{
    providerSessionId: string;
    transcriptPath?: string | null;
    /**
     * True only when the transcript publisher ATTACHED to this path for this id
     * (`bound`/`unchanged`). A `deferred` bind means the file could not be
     * followed, and an unvalidated hook payload path was never checked at all —
     * neither is proof, so both degrade to a fresh target (`REQ-STATE-03`).
     */
    transcriptPathProven?: boolean;
    reason: string;
  }>): void {
    // A proof only proves the id it arrived with, so a re-key discards it before
    // the new id is published and can never inherit a foreign transcript.
    if (state.providerSessionId !== input.providerSessionId) {
      provenTranscriptPath = null;
    }
    state.providerSessionId = input.providerSessionId;
    if (input.transcriptPath) {
      statuslineTranscriptPath = input.transcriptPath;
      if (input.transcriptPathProven === true) {
        provenTranscriptPath = input.transcriptPath;
      }
    }
    publishProviderSessionId(input.providerSessionId, input.reason);
  }

  function readPrimarySessionHookProviderSessionId(
    providerSessionId: string,
    payload: Readonly<Record<string, unknown>>,
  ): string | null {
    return readNonEmptyString(providerSessionId)
      ?? readNonEmptyString(payload.session_id)
      ?? readNonEmptyString(payload.sessionId);
  }

  async function bindKnownProviderSessionTranscript(): Promise<void> {
    if (knownProviderSessionBound) return;
    const knownProviderSession = params.knownProviderSession;
    if (!knownProviderSession) return;
    if (!explicitResumeIdentityEstablished) return;
    if (
      requestedResumeProviderSessionId
      && knownProviderSession.providerSessionId !== requestedResumeProviderSessionId
    ) return;
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
        transcriptPathProven: bindResult.status !== 'deferred',
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
    storage: params.ctx.storage.daemonSession,
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
    arbiter.clearHeadBeforeProviderBlock(deliveryBlockedReason);
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

  function rememberRuntimeConfigUpdateOutcome<T extends ClaudeProviderConfigurationOutcome | void>(
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
    const reversible = isClaudeUnifiedPromptDeliveryBlockReversible(reason);
    const rejected = reversible
      ? arbiter.blockHeadBeforeProvider({ deliveryBlockedReason: reason })
      : arbiter.rejectHeadBeforeProvider({ deliveryBlockedReason: reason });
    if (!rejected) return false;
    state.dispatchAttemptInFlight = false;
    if (reversible) state.turnCompleted = true;
    settleTurnCompletionWaiters();
    return true;
  }

  function failExplicitResumeIdentityMismatch(params2: Readonly<{
    observedProviderSessionId: string | null;
    source: string | null;
  }>): void {
    if (explicitResumeIdentityFailure) return;
    explicitResumeIdentityFailure = recordClaudeUnifiedResumeIdentityMismatchFailure({
      handlers,
      logger: params.ctx.logger,
      publishedFailureTurnIds,
      sessionId: params.happierSessionId,
      turnId: state.activeTurnId,
      allocateTurnWhenIdle: state.activeTurnId === null,
    });
    params.ctx.logger.warn('[ClaudeUnifiedTerminal] explicit resume identity validation failed', {
      sessionId: params.happierSessionId,
      expectedProviderSessionId: requestedResumeProviderSessionId,
      observedProviderSessionId: params2.observedProviderSessionId,
      source: params2.source,
    });
    nativeResumeTurnBarrier?.observeTerminal();
    state.lastTurnFailure = explicitResumeIdentityFailure;
    state.turnCompleted = true;
    state.turnInFlight = false;
    state.terminalOriginTurnInFlight = false;
    rejectCurrentQueuedPromptBeforeProvider('resume_identity_mismatch');
    settleTurnCompletionWaiters();
  }

  function assertExplicitResumeIdentityDidNotFail(): void {
    if (explicitResumeIdentityFailure) throw explicitResumeIdentityFailure;
  }

  async function handlePendingRuntimeConfigDeliveryBlockerBeforeDrain(): Promise<boolean> {
    if (!pendingRuntimeConfigDeliveryBlocker) return false;
    if (rejectCurrentQueuedPromptBeforeProvider(pendingRuntimeConfigDeliveryBlocker)) {
      return true;
    }
    if (!isCanonicalTurnActive()) return false;
    steerCapabilityPublisher.publish({ available: false, reason: 'user_terminal_draft' });
    await publishSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'), {
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
      const evidence = {
        promptText: submission.promptText,
        ...(submission.agentTurnId ? { agentTurnId: submission.agentTurnId } : {}),
        ...(submission.queuedCommandEvidence ? {
          exactPromptText: true,
          includeTimedOutAmbiguous: true,
        } : {}),
      };
      await arbiter.confirmProviderAcceptance(evidence);
    }
  }

  const publishSessionEvent = async (
    event: Parameters<AgentSessionHostServices['transcripts']['publishSessionEvent']>[0],
    opts?: Readonly<{
      failureWarnMessage?: string;
      debugMeta?: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<Readonly<{ status: 'custodied' }>> => {
    const eventType = typeof event.type === 'string' ? event.type : 'unknown';
    try {
      return await params.ctx.agentRuntime.transcripts.publishSessionEvent(event);
    } catch (error) {
      params.ctx.logger.warn(
        opts?.failureWarnMessage ?? '[ClaudeUnifiedTerminal] durable session-event publication failed',
        { error, eventType, ...opts?.debugMeta },
      );
      throw error;
    }
  };
  // Single owner of the runtime-config-outcome session-event emission (grouped per status,
  // transition-deduped). Dedupe commits only after the host-owned transcript outbox accepts custody.
  const runtimeConfigOutcomeEmitter = createClaudeUnifiedRuntimeConfigOutcomeEmitter({
    sendSessionEvent: async (event: ClaudeUnifiedRuntimeConfigOutcomeSessionEvent) => {
      return await publishSessionEvent(event, {
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
      const localId = readClaudePendingLocalId(rawLocalId);
      if (localId === null || seen.has(localId)) continue;
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
      workspaceTrustPolicy: params.workspaceTrustPolicy,
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
      onPendingUserActionChange: (pending) => {
        if (pending) {
          stopReadinessWake();
          return;
        }
        readinessWaitStartedAtMs = Date.now();
        lastScreenProgressAtMs = Date.now();
        ensureReadinessWake();
      },
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
    publishStatus: params.activeInput?.publishStatus ?? (() => undefined),
    logger: params.ctx.logger,
    isCanonicalTurnActive: () => !state.disposed && (state.turnInFlight || state.terminalOriginTurnInFlight),
    // Lane Q: resolved once at runtime creation; the UI's "Apply & steer now" gate is fail-closed
    // on this static capability, so it must land before the first steered send.
    inFlightConfigApplySupported: isTuiRuntimeControlFeatureEnabled(),
  });
  const arbiter = createClaudeUnifiedInputArbiter({
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
      scheduleQueuedBannerCustodyCheck(input, acceptance.acceptedAs);
      // A slash command can replace the composer with a native chooser without a hook or
      // turn-lifecycle event. Its Enter write may finish just before Claude paints the chooser, so
      // reuse the existing bounded control settle before probing the single dialog owner once.
      if (input.text.trimStart().startsWith('/')) {
        await waitMs(
          params.tuiControl?.timings?.commandSettleMs
            ?? DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.commandSettleMs,
        );
      }
      await probeVisibleDialogOnce();
      await replayRecentProviderPromptSubmissions();
    },
    onPromptAccepted: async (input, acceptance) => {
      recordProviderActivity();
      promptEchoSuppressor.recordAcceptedPrompt({
        text: input.text,
        agentTurnId: acceptance.agentTurnId ?? null,
        retainUntilObserved: hasCanonicalPendingOwner(input),
      });
      ensureAcceptedTurnStarted(input);
      state.turnInFlight = true;
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
      try {
        onUndeliverablePromptsHandler?.(inputs.map((input) => ({
          text: input.text,
          ...buildPromptDeliveryIdentity(input),
        })));
      } catch (error) {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] onUndeliverablePrompts handler failed', { error });
      }
    },
    onPendingInputInterruptAndRunLocalIdChange: (localId) => {
      const handle = state.handle;
      steerCapabilityPublisher.publishPendingInputInterruptAndRunLocalId(
        handle && isClaudeUnifiedPendingInputInterruptAndRunEnabled(handle.kind) ? localId : null,
      );
    },
    resolvePromptTerminalRejection: resolveProviderUnavailablePromptTerminalRejection,
    onInjectionFailure: (failure) => {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] prompt injection failed', {
        reason: failure.result.reason,
        phase: failure.result.phase,
        failureState: failure.failureState,
      });
      publishAmbiguousProviderInputOutcome(failure);
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
            const custodyObserved = await arbiter.observeTerminalPromptCustody(input);
            if (custodyObserved) {
              try {
                onPromptDeliveryOutcomeHandler?.({
                  type: 'custody_observed',
                  ...buildPromptDeliveryIdentity(input),
                });
              } catch (error) {
                params.ctx.logger.warn('[ClaudeUnifiedTerminal] custody delivery handler failed', { error });
              }
            }
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
      ...(launchUltracode && isClaudeUltracodeSupportedModelId(launchModelId, currentProviderModel)
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
          args: applyClaudeUnifiedTerminalLaunchIntent(resolveClaudeLaunchSettingsOverlayArgs({
            args: [
              ...(resolvedHookPluginDir ? ['--plugin-dir', resolvedHookPluginDir] : []),
              ...(launchModelId ? ['--model', launchModelId] : []),
              ...(launchFallbackModelId ? ['--fallback-model', launchFallbackModelId] : []),
              ...buildClaudeEffortCliArgs({
                modelId: launchModelId,
                effort: launchEffort,
                ...(currentProviderModel ? { providerModel: currentProviderModel } : {}),
              }),
              CLAUDE_TERMINAL_YOLO_ALLOW_FLAG,
              ...(launchPermissionMode ? ['--permission-mode', mapToClaudePermissionMode(launchPermissionMode)] : []),
            ],
            interactionKind: 'interactive_terminal',
            permissionMode: mapToClaudePermissionMode(launchPermissionMode),
            launchSettings: settingsOverlay,
          }), params.launchIntent ?? { kind: 'new_session' }),
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
          // Runtime Activity observes the authenticated hook before identity/sidechain routing.
          // SubagentStart may refresh only an admitted ID; SubagentStop may clear only its exact ID.
          observeProviderTaskActivity(payload, providerSessionId);
          const lifecycleObservation = mapClaudeUnifiedHookLifecyclePayload(payload, params.happierSessionId);
          if (lifecycleObservation) {
            await nativeRuntime.observeTerminalLifecycle(lifecycleObservation);
          }
          // Sidechain (subagent) session hooks must never rebind the PRIMARY provider session
          // identity or transcript path (ported R-11 / HF-7).
          if (isSidechainSessionHook(payload)) return;
          const hookEventName = readNonEmptyString(payload.hook_event_name)
            ?? readNonEmptyString(payload.hookEventName)
            ?? readNonEmptyString(payload.eventName);
          let establishedExplicitResumeIdentityNow = false;
          if (hookEventName === 'SessionStart') {
            pendingTaskNotificationReaction = null;
            const source = readNonEmptyString(payload.source);
            const observedProviderSessionId = readPrimarySessionHookProviderSessionId(providerSessionId, payload);
            if (requestedResumeProviderSessionId && !explicitResumeIdentityEstablished) {
              if (source !== 'resume' || observedProviderSessionId !== requestedResumeProviderSessionId) {
                failExplicitResumeIdentityMismatch({ observedProviderSessionId, source });
                return;
              }
              explicitResumeIdentityEstablished = true;
              establishedExplicitResumeIdentityNow = true;
              await bindKnownProviderSessionTranscript();
            }
            sessionStartObservedForReadiness = true;
            nativeResumeTurnBarrier?.observeProviderSessionStart(source);
          } else if (
            hookEventName === 'UserPromptSubmit'
            && isClaudeTaskNotificationPromptText(readNonEmptyString(payload.prompt))
          ) {
            // A task notification is detached provider evidence. It neither confirms nor extends
            // the provisional native-resume turn and is never Pending acceptance. Only a later
            // authenticated primary-chain reaction may open a foreground turn.
            if (!state.activeTurnId) {
              const taskNotificationSessionId = readPrimarySessionHookProviderSessionId(providerSessionId, payload);
              if (taskNotificationSessionId) {
                pendingTaskNotificationReaction = {
                  sessionId: taskNotificationSessionId,
                  promptId: readNonEmptyString(payload.prompt_id) ?? readNonEmptyString(payload.promptId),
                  transcriptUuid: null,
                };
              }
            }
          } else if (hookEventName === 'UserPromptSubmit') {
            pendingTaskNotificationReaction = null;
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
              transcriptPathProven: bindResult.status !== 'deferred',
              reason: 'claude-unified-session-start',
            });
          } else if (hookEventName === 'SessionStart' && !state.providerSessionId) {
            const trustedProviderSessionId = readPrimarySessionHookProviderSessionId(providerSessionId, payload);
            if (trustedProviderSessionId) {
              adoptProviderSessionId({
                providerSessionId: trustedProviderSessionId,
                // The bind was refused, so this raw hook path is retained for
                // statusline identity only and is deliberately NOT proof.
                transcriptPath: readNonEmptyString(payload.transcript_path) ?? readNonEmptyString(payload.transcriptPath),
                reason: 'claude-unified-session-start',
              });
            }
          }
          if (hookEventName === 'PostToolUse' && state.handle) {
            // Claude can keep working behind a short-lived nonblocking overlay (for example an LSP
            // recommendation). The authenticated primary hook is an event-driven observation edge;
            // the existing generalized dialog controller remains the only parser/decision owner.
            await probeVisibleDialogOnce();
          }
          if (hookEventName === 'PostToolUse' && pendingTaskNotificationReaction) {
            const toolSessionId = readPrimarySessionHookProviderSessionId(providerSessionId, payload);
            if (toolSessionId === pendingTaskNotificationReaction.sessionId) {
              beginTaskNotificationReactionTurn();
            }
          }
          if (
            hookEventName === 'Stop'
            || hookEventName === 'StopFailure'
            || hookEventName === 'SessionEnd'
          ) {
            pendingTaskNotificationReaction = null;
          }
          if (hookEventName === 'SessionStart' && establishedExplicitResumeIdentityNow) {
            // SessionStart can race terminalHost.start() resolving. Avoid recursively starting a
            // second host while still waking a prompt that was parked behind identity validation.
            if (state.handle) {
              await observeCurrentReadiness();
              await arbiter.drain();
            }
            ensureReadinessWake();
          }
        },
        onStatuslineUpdate: async (payload) => {
          const parsed = parseClaudeStatuslinePayload(payload);
          if (!parsed) return;
          const statuslineProviderSessionId = readNonEmptyString(parsed.session_id);
          const statuslineProviderTranscriptPath = readNonEmptyString(parsed.transcript_path);
          if (
            !state.providerSessionId
            && statuslineProviderSessionId
            && explicitResumeIdentityEstablished
          ) {
            if (statuslineProviderTranscriptPath) {
              const bindResult = await providerTranscriptPublisher.bindKnownLiveTranscript({
                providerSessionId: statuslineProviderSessionId,
                transcriptPath: statuslineProviderTranscriptPath,
              });
              if (
                !state.providerSessionId
                && (
                  bindResult.status === 'bound'
                  || bindResult.status === 'unchanged'
                  || bindResult.status === 'deferred'
                )
              ) {
                adoptProviderSessionId({
                  providerSessionId: bindResult.binding.providerSessionId,
                  transcriptPath: bindResult.binding.transcriptPath,
                  transcriptPathProven: bindResult.status !== 'deferred',
                  reason: 'claude-unified-statusline-transcript',
                });
              }
            } else {
              // The statusline forwarder is authenticated by the same session-scoped secret as
              // hooks. Even if Claude omits its transcript path, retain its provider identity so a
              // later Stop/Resume does not silently launch a fresh native session.
              adoptProviderSessionId({
                providerSessionId: statuslineProviderSessionId,
                reason: 'claude-unified-statusline-session',
              });
            }
          }
          await statuslineApplier.apply(parsed);
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
    promptEchoSuppressor.clearAcceptedPromptEchoes();
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
    promptEchoSuppressor.clearAcceptedPromptEchoes();
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

  function beginProviderContinuationTurn(): void {
    state.promptNonce += 1;
    state.activeTurnId = createClaudeUnifiedTurnId(params.happierSessionId, state.promptNonce);
    state.activePromptText = null;
    state.dispatchAttemptInFlight = false;
    state.providerAccepted = true;
    state.turnInFlight = true;
    state.turnCompleted = false;
    state.terminalOriginTurnInFlight = false;
    state.lastTurnFailure = null;
    const nowMs = Date.now();
    lastTurnProgressPublishedAtMs = nowMs;
    publishActiveTurnStarted(nowMs);
  }

  function beginTaskNotificationReactionTurn(): void {
    pendingTaskNotificationReaction = null;
    if (state.activeTurnId) return;
    beginProviderContinuationTurn();
  }

  function observeTaskNotificationReactionTranscriptRow(row: unknown): void {
    const pendingReaction = pendingTaskNotificationReaction;
    if (!pendingReaction) return;
    const notification = readTaskNotificationTranscriptIdentity(row);
    if (notification) {
      if (
        notification.sessionId === pendingReaction.sessionId
        && (!pendingReaction.promptId || notification.promptId === pendingReaction.promptId)
      ) {
        pendingReaction.transcriptUuid = notification.uuid;
      }
      return;
    }
    if (
      pendingReaction.transcriptUuid
      && isMatchingTaskNotificationAssistantReaction(row, {
        sessionId: pendingReaction.sessionId,
        transcriptUuid: pendingReaction.transcriptUuid,
      })
    ) {
      beginTaskNotificationReactionTurn();
    }
  }

  function resetCompletedTurnState(options?: Readonly<{ preserveResumePromptProvenance?: boolean }>): void {
    if (options?.preserveResumePromptProvenance !== true) {
      nativeResumeTurnBarrier?.observeTerminal();
    }
    promptEchoSuppressor.clearAcceptedPromptEchoes();
    staleTurnDemandActive = false;
    stopStaleTurnWake();
    state.activePromptText = null;
    state.dispatchAttemptInFlight = false;
    state.turnInFlight = false;
    state.activeTurnId = null;
    state.providerAccepted = false;
    state.turnCompleted = false;
    state.terminalOriginTurnInFlight = false;
    state.lastTurnFailure = null;
    lastTurnProgressPublishedAtMs = null;
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

  nativeResumeTurnBarrier = createClaudeUnifiedResumeTurnBarrier({
    intent: params.launchIntent ?? { kind: 'new_session' },
    quietMs: CLAUDE_UNIFIED_TERMINAL_INPUT_QUIET_PERIOD_MS,
    begin: beginProviderContinuationTurn,
    cancel: () => {
      publishActiveTurnCancelled(Date.now(), 'idle_native_resume');
      // The screen is authoritatively idle, but Claude's first resume-native prompt hook can be
      // forwarded after that observation. Reset the provisional turn without discarding the exact
      // SessionStart provenance needed to classify that one delayed prompt.
      resetCompletedTurnState({ preserveResumePromptProvenance: true });
    },
  });

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
    settleTurnCompletionWaiters();
    return state.lastTurnFailure;
  }

  function publishAmbiguousInjectionFailure(failure: ClaudeUnifiedPromptInjectionFailure): void {
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

  function publishAmbiguousProviderInputOutcome(failure: ClaudeUnifiedPromptInjectionFailure): void {
    if (
      failure.result.duplicateRisk === 'none'
      || resolveProviderUnavailablePromptTerminalRejection(failure.input, failure.result) !== undefined
    ) {
      return;
    }
    try {
      onPromptDeliveryOutcomeHandler?.({
        type: 'possible_write',
        ...buildPromptDeliveryIdentity(failure.input),
        reason: 'ambiguous_terminal_delivery',
      });
    } catch (error) {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] ambiguous provider-input outcome handler failed', { error });
    }
  }

  function hasQueuedPromptAwaitingProviderAcceptance(): boolean {
    const snapshot = arbiter.snapshot();
    return snapshot.queuedCount > 0 && snapshot.headInputState === 'awaiting_provider_acceptance';
  }

  function recordTerminalOriginTurnStarted(promptText?: string): void {
    if (hasQueuedPromptAwaitingProviderAcceptance()) {
      state.terminalOriginTurnInFlight = true;
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

  function observeProviderTaskActivity(row: unknown, providerSessionId?: string): void {
    observeClaudeProviderTaskActivity({
      row,
      ...(providerSessionId ? { providerSessionId } : {}),
      ledger: providerActivityLedger,
      runtimeActivityPublisher,
      logger: params.ctx.logger,
      logPrefix: '[ClaudeUnifiedTerminal]',
    });
  }

  function observeProviderTaskNotificationTerminal(
    row: unknown,
    providerSessionId: string,
  ): void {
    const notification = parseClaudeTaskNotification(row);
    if (
      !notification?.taskId
      || (
        notification.sourceSessionId !== undefined
        && notification.sourceSessionId !== providerSessionId
      )
    ) return;
    const status = normalizeClaudeActivityStatusSignal(notification.status, 'task_notification');
    const terminalStatus = status === 'complete'
      ? 'completed' as const
      : status === 'failed'
        ? 'failed' as const
        : status === 'cancelled'
          ? 'stopped' as const
          : null;
    if (!terminalStatus) return;
    applyClaudeProviderTaskActivity({
      activity: {
        type: 'terminal',
        terminalStatus,
        sessionId: providerSessionId,
        taskId: notification.taskId,
      },
      ledger: providerActivityLedger,
      runtimeActivityPublisher,
      logger: params.ctx.logger,
      logPrefix: '[ClaudeUnifiedTerminal]',
    });
  }

  async function markHostPromptEchoConsumed(agentTurnId: string | null | undefined): Promise<void> {
    if (!agentTurnId) return;
    const localId = buildClaudeJsonlProviderFactLocalIdFromParts({
      type: 'user',
      id: agentTurnId,
    });
    if (!localId) return;
    const markSourceFactConsumed = params.ctx.agentRuntime.transcripts.markSourceFactConsumed;
    if (!markSourceFactConsumed) return;
    await markSourceFactConsumed({
      localId,
      reason: 'host_prompt_echo',
    });
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
      await markHostPromptEchoConsumed(params2.agentTurnId);
      return;
    }

    const localId = params2.source === 'transcript' && params2.agentTurnId
      ? buildClaudeJsonlProviderFactLocalIdFromParts({
          type: 'user',
          id: params2.agentTurnId,
        })
      : await terminalOriginLocalIds.next({
          agentTurnId: params2.agentTurnId ?? null,
        });
    if (!localId) return;
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
      if (next.composerContent === '') {
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

  async function noteUserDraftDeferral(screen: ReturnType<typeof parseClaudeScreenState>): Promise<void> {
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
    await publishSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'), {
      failureWarnMessage: '[ClaudeUnifiedTerminal] terminal-composer-draft-blocked publish failed',
    });
    userDraftEscalated = true;
    if (!rejectCurrentQueuedPromptBeforeProvider('terminal_composer_draft') && isCanonicalTurnActive()) {
      ensureStaleTurnWake();
    }
  }

  async function observeCurrentReadiness(): Promise<void> {
    const handle = await ensureHost();
    lastSteerVetoReason = null;
    if (explicitResumeIdentityFailure) {
      lastReadinessKind = 'failed';
      arbiter.observeReadiness({
        status: 'failed_terminal',
        observedAt: Date.now(),
        reason: 'resume_identity_mismatch',
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
        recoverable: false,
      });
      return;
    }
    if (!explicitResumeIdentityEstablished) {
      lastReadinessKind = 'deferred';
      arbiter.observeReadiness({
        status: 'defer_provider_starting',
        observedAt: Date.now(),
        reason: 'resume_identity_unverified',
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
      });
      return;
    }
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
      // Slash-prefixed composer content is deliberately excluded from `userDraftPresent`; route
      // every non-empty draft through the exact owner classifier so owned control/resume residue
      // is reachable while foreign slash commands still fail closed with zero keypresses.
      if ((screen.composerContent?.length ?? 0) > 0 && hasPromptDeliveryDemand()) {
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
          await noteUserDraftDeferral(screen);
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
    if (resumeChoiceUserActionPending()) return false;
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
    await failStartupReadiness({ elapsedMs, hostAlive, sessionStartObserved });
  }

  async function failStartupReadiness(diagnostics: Readonly<{
    elapsedMs: number;
    hostAlive: boolean;
    sessionStartObserved: boolean;
  }>): Promise<void> {
    const blocker = arbiter.snapshot().headDeliveryBlocker;
    if (blocker?.reason === 'capture_style_unavailable') {
      try {
        await publishSessionEvent(createTerminalComposerDraftBlockedEvent('idle_draft_guard'), {
          failureWarnMessage: '[ClaudeUnifiedTerminal] capture-style pending notice publish failed',
        });
      } catch (error) {
        ensureReadinessWake();
        throw error;
      }
      stopReadinessWake();
      readinessWaitStartedAtMs = Date.now();
      lastScreenProgressAtMs = Date.now();
      ensureReadinessWake();
      return;
    }
    stopReadinessWake();
    if (blocker && rejectCurrentQueuedPromptBeforeProvider(blocker.reason)) {
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
    const hadEscalatedDialogBlock = dialogInjectionBlockEscalated;
    dialogInjectionBlockStartedAtMs = null;
    dialogInjectionBlockEscalated = false;
    if (
      hadEscalatedDialogBlock
      && pendingRuntimeConfigDeliveryBlocker !== 'runtime_config_blocked'
    ) {
      notifyPromptDeliveryBlockerCleared('runtime_config_blocked');
    }
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

  async function probeVisibleDialogOnce(): Promise<boolean> {
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
      resolved = await probeVisibleDialogOnce();
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

  async function runInFlightSteerPrompt(
    prompt: string,
    meta?: ClaudeUnifiedPromptDeliveryMeta,
  ): Promise<void> {
    assertExplicitResumeIdentityDidNotFail();
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
    pendingTerminalHostStartupFailurePromptMeta = meta ?? null;
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
      localId: meta?.localId ?? null,
      localIds: meta?.localIds ?? [],
      userMessageSeq: meta?.userMessageSeq ?? null,
      userMessageSeqs: meta?.userMessageSeqs ?? [],
    });
    const deliveryTerminal = waitForPromptDeliveryTerminal(input);
    try {
      arbiter.enqueue(input);
      if (!await handlePendingRuntimeConfigDeliveryBlockerBeforeDrain()) {
        await arbiter.drain();
        ensureReadinessWake();
      }
      await deliveryTerminal.promise;
    } catch (error) {
      deliveryTerminal.cancel();
      throw error;
    }
  }

  const nativeRuntime: ClaudeUnifiedTerminalNativeRuntime = {
    promptCustody: 'unified_terminal',
    subscribeCanonicalAgentSessionEvents: runtimeActivityPublisher.subscribe,
    subscribeEffectiveModel(listener) {
      effectiveModelListeners.add(listener);
      return () => effectiveModelListeners.delete(listener);
    },
    subscribeUsageObservation(listener) {
      usageObservationListeners.add(listener);
      return () => usageObservationListeners.delete(listener);
    },
    beginProviderTurn() {
      publishProviderTaskInventory('new-turn');
      state.promptNonce += 1;
      state.dispatchAttemptInFlight = true;
      state.lastTurnFailure = null;
      state.providerAccepted = false;
      state.turnCompleted = false;
      lastTurnProgressPublishedAtMs = null;
    },
    async startProviderSession() {
      // Publish the foreground barrier before host startup can create a pending-input pump. The
      // provider's SessionStart/UserPromptSubmit hooks are necessarily later than this boundary.
      nativeResumeTurnBarrier?.beginBeforeProviderRun();
      const handle = await ensureHost();
      await bindKnownProviderSessionTranscript();
      await observeCurrentReadiness();
      nativeResumeTurnBarrier?.observeStartupReady();
      return {
        sessionId: handle.sessionName,
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
      };
    },
    async sendProviderTurnPrompt(prompt: string, meta?: ClaudeUnifiedPromptDeliveryMeta) {
      assertExplicitResumeIdentityDidNotFail();
      if (!state.activeTurnId && !state.dispatchAttemptInFlight) nativeRuntime.beginProviderTurn();
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
      if (await handlePendingRuntimeConfigDeliveryBlockerBeforeDrain()) {
        return { kind: 'custody_observed' };
      }
      await arbiter.drain();
      ensureReadinessWake();
      return { kind: 'custody_observed' };
    },
    setGoal: (objective, options) => goalRuntime.setGoal(objective, options),
    clearGoal: () => goalRuntime.clearGoal(),
    async steerProviderTurn(message, meta) {
      await runInFlightSteerPrompt(message, meta);
      return { kind: 'custody_observed' };
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
      return !state.disposed
        && explicitResumeIdentityEstablished
        && explicitResumeIdentityFailure === null
        && (state.turnInFlight || state.terminalOriginTurnInFlight);
    },
    canInterruptForPendingInput() {
      return nativeResumeTurnBarrier?.isActive() !== true;
    },
    async steerPrompt(prompt: string, options?: ClaudeUnifiedPromptDeliveryMeta) {
      await runInFlightSteerPrompt(prompt, options);
    },
    setOnPromptAcceptedByProvider(handler) {
      onPromptAcceptedByProviderHandler = handler;
    },
    setOnPromptTerminallyRejectedBeforeProvider(handler) {
      onPromptTerminallyRejectedBeforeProviderHandler = handler;
    },
    setOnPromptDeliveryOutcome(handler) {
      onPromptDeliveryOutcomeHandler = handler;
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
    async clearTerminalComposer(request): Promise<ClaudeSessionTerminalComposerClearResult> {
      const sessionId = request?.sessionId ?? params.happierSessionId;
      if (!isTuiRuntimeControlFeatureEnabled()) {
        return {
          ok: false,
          status: 'unsupported',
          sessionId,
          error: 'tui_runtime_control_unavailable',
        };
      }
      if (
        request?.expectedStateAtMs !== undefined
        && request.expectedStateAtMs !== steerCapabilityPublisher.readStateUpdatedAtMs()
      ) {
        return {
          ok: false,
          status: 'stale_state',
          sessionId,
          error: 'stale_terminal_input_state',
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
    async releaseConnectedServiceUsageLimitDialog(): Promise<void> {
      const handle = state.handle;
      if (state.disposed || !handle) return;
      const port = await params.ctx.agentRuntime.terminalHost.controlPort(handle).catch((error: unknown) => {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] connected-service dialog control port unavailable', { error });
        return null;
      });
      if (!port) return;
      const before = await captureScreenState(port);
      if (before.kind !== 'state' || !before.state.usageLimitDialogVisible) return;
      const sent = await port.sendSpecialKey('Escape');
      if (sent.status !== 'sent') {
        throw new Error(`claude_connected_service_usage_dialog_escape_${sent.status}`);
      }
      await waitMs(
        params.tuiControl?.timings?.commandSettleMs
          ?? DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.commandSettleMs,
      );
      const after = await captureScreenState(port);
      if (after.kind !== 'state' || after.state.usageLimitDialogVisible) {
        throw new Error('claude_connected_service_usage_dialog_not_released');
      }
      resetUserDraftStarvation();
      ensureReadinessWake();
      onPromptDeliveryBlockerClearedHandler?.();
    },
    async interruptPendingInputAndRun(request) {
      const sessionId = request.sessionId ?? params.happierSessionId;
      const base = { sessionId, localId: request.localId } as const;
      const handle = state.handle;
      if (state.disposed || !handle) {
        return { ok: false as const, status: 'no_live_terminal' as const, ...base, error: 'no_live_terminal' };
      }
      if (!isClaudeUnifiedPendingInputInterruptAndRunEnabled(handle.kind)) {
        return { ok: false as const, status: 'unsupported' as const, ...base, error: 'host_not_verified' };
      }
      if (
        request.expectedStateAtMs !== undefined
        && request.expectedStateAtMs !== steerCapabilityPublisher.readPendingInputInterruptAndRunStateAtMs()
      ) {
        return { ok: false as const, status: 'stale_state' as const, ...base, error: 'stale_terminal_input_state' };
      }
      if (arbiter.readPendingInputInterruptAndRunLocalId() !== request.localId) {
        return { ok: false as const, status: 'stale_state' as const, ...base, error: 'not_current_custody_head' };
      }
      const inputState = await params.ctx.agentRuntime.terminalHost.captureInputState(handle).catch(() => null);
      if (!inputState) {
        return { ok: false as const, status: 'capture_unavailable' as const, ...base };
      }
      const screen = parseClaudeScreenState(inputState.currentInput, { cursor: inputState.cursor });
      if (
        !screen.queuedMessageBannerVisible
        || resolveClaudeScreenInFlightSteerVeto(screen) !== null
      ) {
        return { ok: false as const, status: 'not_safe' as const, ...base };
      }
      if (!arbiter.claimPendingInputInterruptAndRun(request.localId)) {
        return { ok: false as const, status: 'stale_state' as const, ...base, error: 'custody_claim_lost' };
      }
      try {
        await params.ctx.agentRuntime.terminalHost.interruptTurn(handle);
        return { ok: true as const, status: 'interrupted' as const, ...base };
      } catch (error) {
        return {
          ok: false as const,
          status: 'interrupt_failed' as const,
          ...base,
          error: error instanceof Error ? error.message : 'interrupt_failed',
        };
      }
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
      await runtimeConfigOutcomeEmitter.emit(outcome);
      if (outcome.status === 'applied' && outcome.promptMayProceed) {
        launchPermissionMode = delta.permissionMode;
        return { status: 'applied' };
      }
      const detail = outcome.timing !== undefined ? `${outcome.status}:${outcome.timing}` : outcome.status;
      return { status: 'failed', reason: `in_flight_mode_apply_${detail}` };
    },
    async waitForProviderTurnCompletion() {
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
    subscribeProviderEvents(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async respondToProviderPermission(requestId, approved) {
      return respondToClaudePermission({
        ctx: params.ctx,
        provider: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
        requestId,
        approved,
      });
    },
    async cancelProviderTurn(expectedTurnId?: string) {
      if (expectedTurnId !== undefined && state.activeTurnId !== expectedTurnId) return false;
      nativeResumeTurnBarrier?.observeTerminal();
      pendingTaskNotificationReaction = null;
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
      rejectTurnCompletionWaiters(new Error('Claude unified terminal turn was cancelled'));
      return true;
    },
    readProviderIdentity() {
      return { sessionId: state.providerSessionId };
    },
    async updateProviderConfiguration(update) {
      const nextProviderModel = update.providerBinding === undefined
        ? undefined
        : update.providerBinding.model;
      const commitProviderModelIfApplied = <Outcome extends ClaudeProviderConfigurationOutcome | void>(
        outcome: Outcome,
      ): Outcome => {
        if (nextProviderModel && isRuntimeConfigUpdateOutcomeApplied(outcome)) {
          currentProviderModel = nextProviderModel;
        }
        return outcome;
      };
      const promptDependentUpdate = isRuntimeConfigUpdatePromptDependent(update);
      if (state.handle) {
        // The Claude TUI is already running. Convergence short-circuit (L5d, anti-hot-loop): when
        // every requested value already equals the effective config there is nothing left to
        // apply, so report `skipped_already_effective` and let the override-synchronizer stop
        // re-attempting it.
        if (isRuntimeConfigUpdateConvergedWithLaunch(update)) {
          return commitProviderModelIfApplied(rememberRuntimeConfigUpdateOutcome(
            Object.freeze({ status: 'applied', timing: 'skipped_already_effective' } as const),
            promptDependentUpdate ? { promptMayProceed: true } : {},
          ));
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
            ...(currentProviderModel ? { providerModel: currentProviderModel } : {}),
            supportsEffort: params.supportsEffort !== false,
          });
          if (resolution.kind === 'desired') {
            const outcome = await controller.applyDesiredRuntimeConfig({
              desired: resolution.desired,
              reason: 'out_of_band',
            });
            await controller.whenControlIdle();
            await runtimeConfigOutcomeEmitter.emit(outcome);
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
            return commitProviderModelIfApplied(rememberRuntimeConfigUpdateOutcome(
              Object.freeze(mapped),
              promptDependentUpdate ? { promptMayProceed: dependentRuntimeConfigPromptMayProceed(outcome) } : {},
            ));
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
      const configOptionId = update.configOption && typeof update.configOption === 'object'
        ? readNonEmptyString((update.configOption as Readonly<Record<string, unknown>>).id)
        : null;
      if (
        params.supportsEffort === false
        && (configOptionId === 'reasoning_effort' || configOptionId === 'effort' || configOptionId === 'ultracode')
      ) {
        return rememberRuntimeConfigUpdateOutcome(Object.freeze({
          status: 'unsupported',
          reason: 'effort_unsupported_by_installed_cli',
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
      return commitProviderModelIfApplied(rememberRuntimeConfigUpdateOutcome(
        Object.freeze({ status: 'applied', timing: 'before_next_prompt' } as const),
        promptDependentUpdate ? { promptMayProceed: true } : {},
      ));
    },
    async disposeProviderSession(reason) {
      state.disposed = true;
      usageObservationListeners.clear();
      stopReadinessWake();
      clearQueuedBannerCustodyTimers();
      clearTurnEndDialogProbe();
      staleTurnDemandActive = false;
      stopStaleTurnWake();
      steerCapabilityPublisher.dispose();
      arbiter.dispose();
      settleAllPromptDeliveryTerminalWaiters();
      runtimeConfigOutcomeEmitter.dispose();
      if (tuiController) {
        await tuiController.dispose().catch(() => undefined);
        tuiController = null;
        tuiControllerPromise = null;
      }
      await resumeChoiceStartupHandler?.dispose();
      resumeChoiceStartupHandler = null;
      resumeChoiceControlPortPromise = null;
      const handle = state.handle;
      state.handle = null;
      let terminalHostDisposeError: unknown;
      let cleanupError: unknown;
      const recordCleanupError = (error: unknown, message: string): void => {
        if (cleanupError === undefined) cleanupError = error;
        params.ctx.logger.warn(message, { error });
      };
      try {
        if (handle) {
          await params.ctx.agentRuntime.terminalHost.dispose(handle, resolveClaudeTerminalHostDisposeIntent(reason));
        }
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
          //
          // Workflow runs, their agents and their `Task` children all live INSIDE this query, so this
          // teardown is the observation that they are over — resolve them before the drain, or they
          // stay painted live until some later process's reconcile grace expires. Happier execution
          // runs are untouched: they own their own backend and genuinely outlive this process.
          try {
            workflowRuntime.finalizeInterruptedActivityOnShutdown();
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] workflow activity shutdown resolution failed');
          }
          try {
            await workflowRuntime.flush();
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] workflow activity flush failed');
          } finally {
            workflowRuntime.dispose();
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
          nativeResumeTurnBarrier?.dispose();
          pendingTaskNotificationReaction = null;
          state.providerSessionId = null;
          state.activeTurnId = null;
          state.activePromptText = null;
          state.dispatchAttemptInFlight = false;
          state.providerAccepted = false;
          state.turnCompleted = false;
          state.turnInFlight = false;
          state.terminalOriginTurnInFlight = false;
          state.lastTurnFailure = null;
          publishProviderTaskInventory('runtime-dispose');
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
      }
      return accepted;
    },
    async observeTerminalLifecycle(observation) {
      if (observation.agentId !== CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID) return;
      recordProviderActivity();
      if (observation.type === 'prompt_submitted') {
        const nativeResumePrompt = nativeResumeTurnBarrier?.observePromptStart() === true;
        if (nativeResumePrompt) {
          recordProviderActivity();
          return;
        }
        const queuedCommandEvidence = observation.providerEvidence === 'queued_command';
        const providerAcceptanceEvidence = {
          ...(observation.promptText ? { promptText: observation.promptText } : {}),
          ...(observation.turnId ? { agentTurnId: observation.turnId } : {}),
          ...(queuedCommandEvidence ? {
            exactPromptText: true,
            includeTimedOutAmbiguous: true,
          } : {}),
        };
        const acceptedQueuedPrompt = await nativeRuntime.confirmProviderAcceptance(providerAcceptanceEvidence);
        if (acceptedQueuedPrompt) {
          if (observation.source === 'transcript' && observation.turnId) {
            await markHostPromptEchoConsumed(observation.turnId);
          }
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
          if (observation.source === 'transcript' && observation.turnId) {
            await markHostPromptEchoConsumed(observation.turnId);
          }
          rememberRecentProviderPromptSubmission({
            promptText: observation.promptText,
            agentTurnId: observation.turnId ?? null,
            queuedCommandEvidence,
            source: observation.source,
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
        const compactAcceptanceEvidence = {
          promptText: '/compact',
          includeTimedOutAmbiguous: true,
        } as const;
        const acceptedCompactPrompt = await nativeRuntime.confirmProviderAcceptance(compactAcceptanceEvidence);
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
        return;
      }
      if (observation.type === 'sidechain_terminal') {
        return;
      }
      if (observation.type === 'completion_candidate') {
        nativeResumeTurnBarrier?.observeTerminal();
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
          await recordClaudeRuntimeProviderAccountUsageSnapshot({
            ctx: params.ctx,
            evidence: observation.evidence ?? observation.detail ?? observation.reason,
            sessionId: params.happierSessionId,
            launchEnv: params.launchEnv,
          });
          const sidechainFailureEvidence = observation.evidence ?? observation.detail ?? observation.reason;
          if (containsDefinitiveClaudeOAuthRevocationEvidence(sidechainFailureEvidence)) {
            void reportClaudeUnifiedTerminalStopFailureRuntimeAuth({
              ctx: params.ctx,
              happierSessionId: params.happierSessionId,
              evidence: sidechainFailureEvidence,
              launchEnv: params.launchEnv,
            });
          }
          return;
        }
        nativeResumeTurnBarrier?.observeTerminal();
        if (consumeTerminalOriginTurnCompletion()) return;
        promptEchoSuppressor.clearAcceptedPromptEchoes();
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
          launchEnv: params.launchEnv,
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
        arbiter.observePendingProviderAcceptanceTerminalFailure();
        state.turnCompleted = true;
        settleTurnCompletionWaiters();
        return;
      }
      if (observation.type === 'turn_aborted') {
        nativeResumeTurnBarrier?.observeTerminal();
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
        rejectTurnCompletionWaiters(new Error(observation.detail));
        return;
      }
      if (observation.type === 'process_exited' && !state.disposed) {
        providerActivityLedger.noteObservationLost();
        publishProviderTaskInventory('process-exited-observation-lost');
      }
      if (observation.type === 'process_exited' && (state.turnInFlight || state.dispatchAttemptInFlight)) {
        nativeResumeTurnBarrier?.observeTerminal();
        promptEchoSuppressor.clearAcceptedPromptEchoes();
        state.dispatchAttemptInFlight = false;
        state.lastTurnFailure = recordClaudeUnifiedProcessExitFailure({
          exitCode: observation.exitCode, signal: observation.signal, handlers,
          logger: params.ctx.logger, publishedFailureTurnIds,
          sessionId: params.happierSessionId, turnId: state.activeTurnId,
        });
        state.turnCompleted = true;
        settleTurnCompletionWaiters();
        return;
      }
      if (observation.type === 'process_exited' && !state.disposed) {
        nativeResumeTurnBarrier?.observeTerminal();
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

  return nativeRuntime;
}
