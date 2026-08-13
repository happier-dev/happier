import { rmdir, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type {
  ClaudeUnifiedTerminalHost,
  TerminalInputInjectionResult,
  TerminalInputInjectionV1,
} from '@happier-dev/agents';
import {
  SessionTerminalComposerClearResultV1Schema,
  type SessionTerminalComposerClearFailureStatusV1,
  type SessionTerminalComposerClearRequestV1,
  type SessionTerminalComposerClearResultV1,
  type SessionPendingInputInterruptAndRunRequestV1,
  type SessionPendingInputInterruptAndRunResultV1,
} from '@happier-dev/protocol';

import {
  ClaudeUnifiedTerminalHostDeadError,
  createClaudeUnifiedController,
  type ClaudeUnifiedController,
} from './createClaudeUnifiedController';
import {
  createClaudeUnifiedHookLifecycleBridge,
  type ClaudeUnifiedPromptTurnTerminalEvent,
  type ClaudeUnifiedSessionEndEvent,
  type ClaudeUnifiedSessionHookSubscription,
} from './createClaudeUnifiedHookLifecycleBridge';
import { createReplayableHookSubscription } from './createReplayableHookSubscription';
import { createClaudeUnifiedTranscriptBridge } from './createClaudeUnifiedTranscriptBridge';
import type { ClaudeRemoteSubagentFileCollector } from '../remote/sidechains/claudeRemoteSubagentFileCollector';
import {
  createClaudeUnifiedTerminalReadinessBridge,
  type ClaudeUnifiedStartupDialogResolver,
} from './createClaudeUnifiedTerminalReadinessBridge';
import { createClaudeUnifiedHostLivenessBridge } from './createClaudeUnifiedHostLivenessBridge';
import { assertClaudeUnifiedHookActivationBeforeTranscriptFallback } from './claudeUnifiedHookActivation';
import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import { interruptClaudeUnifiedQueuedPrompt } from './interruptClaudeUnifiedQueuedPrompt';
import { releaseClaudeUsageLimitDialogAfterExactApplication } from './releaseClaudeUsageLimitDialogAfterExactApplication';
import { isClaudeUnifiedPendingInputInterruptAndRunEnabled } from './pendingInputInterruptAndRunActivation';
import {
  createClaudeGoalRuntimeControls,
  type ClaudeGoalCommandDelivery,
  type ClaudeGoalRuntimeControls,
} from '../goalControl/claudeGoalRuntimeControl';
import { buildClaudeGoalCommand } from '../goalControl/claudeGoalCommand';
import { createClaudeUnifiedPendingQueuePump } from './createClaudeUnifiedPendingQueuePump';
import {
  createClaudeUnifiedPromptInjector,
  type ClaudeUnifiedDraftGuardStarvationInfo,
} from './createClaudeUnifiedPromptInjector';
import { createClaudePromptSubmitVerificationPolicy } from './claudePromptSubmitVerification';
import { clearOwnLeftoverComposerDraft } from './ownComposerDraftGuard';
import {
  createClaudeUnifiedInFlightSteerEvaluator,
  type ClaudeUnifiedSteerAvailabilitySnapshot,
  type ClaudeUnifiedInFlightSteerWiring,
} from './createClaudeUnifiedInFlightSteerEvaluator';
import { createClaudeOwnComposerTextLog, type ClaudeOwnComposerTextLog } from './ownComposerTextLog';
import { createClaudeUnifiedAcceptedPromptTranscriptDiscovery } from './acceptedPromptTranscriptDiscovery';
import { retireClaudeEndpointArtifactsForTerminalAttachment } from '../endpointRecovery/claudeEndpointArtifacts';
import { doesClaudeUnifiedPromptBatchMatchAcceptedTranscript } from './acceptedPromptDeliveryIdentity';
import { ClaudeUnifiedTerminalInjectionFailureError } from './terminalInjectionFailureError';
import { ClaudeUnifiedResumeIdentityMismatchError } from './resumeIdentity';
import type {
  createClaudeProviderActivityLedger,
} from '../providerActivity/createClaudeProviderActivityLedger';
import type { createClaudeProviderRuntimeActivityAdapter } from '../providerActivity/createClaudeProviderRuntimeActivityAdapter';
import {
  buildClaudeUnifiedRuntimeControlDisabledOutcomeEvents,
  createBlockedApplyStarvationTracker,
  createClaudeUnifiedRuntimeControlBridge,
  DEFAULT_BLOCKED_APPLY_STARVATION_THRESHOLD,
  mapEnhancedModeToDesiredRuntimeConfig,
  resolveBlockedApplyRetryMs,
  type BlockedApplyStarvationInfo,
  type ClaudeUnifiedRuntimeConfigOutcomeEvent,
  type ClaudeUnifiedRuntimeControlBridge,
  type ClaudeUnifiedRuntimeControlApplyResult,
} from './runtimeControlIntegration';
import {
  clearUserAuthorizedClaudeComposerDraft,
  createClaudeSettingsGuard,
  createClaudeUnifiedTuiControlController,
  DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS,
  resolveClaudeConfigRootFromEnv,
  type ClaudeComposerClearRefusalReason,
  type ClaudeStatuslineRuntimeMetadata,
  type ClaudeUserAuthorizedComposerClearResult,
} from './tuiControls';
import {
  createClaudeUnifiedDialogChoiceScreenProbe,
  type ClaudeUnifiedDialogChoiceScreenProbe,
} from './dialogChoice/claudeUnifiedDialogChoiceScreenProbe';
import type { ClaudeUnifiedDialogChoiceBroker } from './dialogChoice/claudeUnifiedDialogChoiceBroker';
import { hasClaudeUnifiedVisibleDialog } from './tuiControls/dialogRegistry';
import type {
  ClaudeUnifiedInputConsumer,
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedPromptAcceptance,
  ClaudeUnifiedPromptBatch,
  ClaudeUnifiedStartableDisposable,
  ClaudeUnifiedTerminalScreenObservation,
} from './_types';
import type { EnhancedMode } from '../loop';
import type { RawJSONLines } from '../types';
import type { SessionHookData } from '../utils/startHookServer';
import { resolveClaudeConfigDirOverride } from '../utils/resolveClaudeConfigDirOverride';
import type { MessageBatch } from '@/agent/runtime/sessionInput/types';
import type { Metadata } from '@/api/types';
import {
  buildTerminalAttachmentMetadataFromHostHandle,
  buildTerminalHostHandleFromAttachmentMetadata,
} from '@/agent/runtime/terminal/attachmentMetadata';
import type {
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalHostKind,
  TerminalHostLiveness,
  TerminalHostResolution,
} from '@/integrations/terminalHost/_types';
import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';
import {
  readTerminalAttachmentInfo,
  writeTerminalAttachmentInfo,
  createTerminalAttachmentId,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import {
  evaluateTerminalHostLivenessForRecovery,
  isTerminalHostConfirmedDeadForRelaunch,
  type TerminalHostConfirmedDeadProbeResult,
} from '@/integrations/terminalHost/livenessPolicy';
import { TerminalHostStartupError } from '@/integrations/terminalHost/errors';
import { createTerminalHostRegistry } from '@/integrations/terminalHost/registry';
import { resolveTerminalHost } from '@/integrations/terminalHost/resolveTerminalHost';
import { createTmuxTerminalHostAdapter, isTmuxAvailable } from '@/integrations/tmux';
import { createPtyTerminalHostAdapter } from '@/integrations/pty';
import { createZellijTerminalHostAdapter } from '@/integrations/zellij/adapter';
import { createWindowsTerminalZellijForegroundClientLauncher } from '@/integrations/zellij/windowsForegroundClient';
import { configuration } from '@/configuration';
import {
  buildClaudeUnifiedTerminalSpawn,
  type ClaudeUnifiedTerminalSpawn,
} from './buildClaudeUnifiedTerminalSpawn';
import { resolveZellijWindowsGuard } from '@/integrations/zellij/zellijWindowsGuards';
import { resolveZellijRuntimeBinary } from '@/integrations/zellij/runtimeBinary';
import {
  createClaudeUnifiedTelemetrySink,
  emitClaudeUnifiedDialogTurnEndIdleStarvation,
  emitClaudeUnifiedDialogTurnStallStarvation,
  emitClaudeUnifiedHostDead,
  emitClaudeUnifiedWindowsGuardTriggered,
  maybeEmitClaudeUnifiedWindowsGuardTriggered,
  type ClaudeUnifiedTelemetrySink,
} from './telemetry';
import type { NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { logger } from '@/ui/logger';
import {
  clearSessionMarkerTerminalHostHealth,
  publishSessionMarkerTerminalHostHealth,
} from '@/daemon/sessionRegistry';

type ClaudeUnifiedTerminalQueuedInput<Mode> = Readonly<{
  message: string;
  mode: Mode;
  /** Owed-delivery watermark attribution (A3-HIGH-1); see ClaudeUnifiedPromptBatch. */
  maxUserMessageSeq?: number | null;
  userMessageLocalIds?: readonly string[] | null;
  /**
   * True when the prompt comes from a durable provider-acceptance pending handoff. The terminal
   * may already contain this prompt, or a partial residue of it, before the arbiter injects.
   */
  providerAcceptancePending?: boolean | null;
  pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
}>;

type ClaudeUnifiedTerminalAcceptedInput<Mode> =
  ClaudeUnifiedTerminalQueuedInput<Mode> & ClaudeUnifiedPromptAcceptance;

type ClaudeUnifiedTerminalHostPreference = ClaudeUnifiedTerminalHost;
type ClaudeUnifiedProcessSignal = 'SIGINT' | 'SIGTERM';
type ClaudeUnifiedProcessSignals = Readonly<{
  once(event: ClaudeUnifiedProcessSignal, listener: () => void): unknown;
  removeListener(event: ClaudeUnifiedProcessSignal, listener: () => void): unknown;
}>;

export class ClaudeUnifiedTerminalHostUnavailableError extends Error {
  readonly code = 'claude_unified_terminal_host_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'ClaudeUnifiedTerminalHostUnavailableError';
  }
}

export type ClaudeUnifiedTerminalSessionOptions<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  path: string;
  happySessionId?: string | null | undefined;
  sessionId?: string | null | undefined;
  /** Exact provider identity a newly launched native resume must prove before input is admitted. */
  expectedProviderResumeSessionId?: string | null | undefined;
  transcriptPath?: string | null | undefined;
  claudeArgs?: readonly string[] | undefined;
  hookSettingsPath?: string | undefined;
  hookPluginDir?: string | null | undefined;
  happierMcpConfigJson?: string | undefined;
  systemPromptText?: string | null | undefined;
  /** Hook-server coordinates for the statusline forwarder wrapper (see buildClaudeUnifiedTerminalSpawn). */
  statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
  /** Exact surviving attachment authorized by validated endpoint-rebound recovery. */
  expectedExistingTerminalHostAttachmentId?: string | undefined;
  signal?: AbortSignal | undefined;
  initialMode?: Mode | undefined;
  nextMessage: () => Promise<ClaudeUnifiedTerminalQueuedInput<Mode> | null>;
  /**
   * Hands back a queued message that was already consumed by the input pump but
   * can no longer be delivered (host-death/dispose unwind), so the owner can
   * requeue it instead of the message being silently dropped into a dead session.
   */
  returnUnconsumedMessage?: ((input: ClaudeUnifiedTerminalQueuedInput<Mode>) => void) | undefined;
  /**
   * The live pending-input pump exhausted delivery retries but remains parked
   * for its next wake. The launcher owns the durable pending-row block and
   * visible escalation; this callback never represents host death.
   */
  onPendingQueuePumpPark?: ((params: Readonly<{
    error: unknown;
    failureCount: number;
  }>) => void | Promise<void>) | undefined;
  /**
   * Provider-acceptance seam for the owed-delivery watermark (A3-HIGH-1): fired once per prompt
   * batch the provider ACCEPTED (arbiter acceptance, i.e. transcript/hook-confirmed). Launchers
   * persist the delivered-user-message watermark here instead of at queue handoff.
   */
  onPromptAcceptedByProvider?: ((input: Readonly<{
    message: string;
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
    appliedModelId?: string;
  }>) => void) | undefined;
  /**
   * Deterministic pre-provider rejections consume the local batch but can never reach provider
   * custody. Launchers must terminalize the attributed pending seq so restart replay cannot
   * rematerialize the same invalid prompt.
   */
  onPromptTerminallyRejectedBeforeProvider?: ((input: Readonly<{
    message: string;
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
    reason: 'invalid_prompt_text';
  }>) => void) | undefined;
  resolveHostAdapter?: ((preference: ClaudeUnifiedTerminalHostPreference) => Promise<TerminalHostResolution>) | undefined;
  buildSpawn?: ((params: Readonly<{
    first: ClaudeUnifiedTerminalQueuedInput<Mode>;
    path: string;
    happySessionId?: string | null | undefined;
    claudeArgs?: readonly string[] | undefined;
    hookSettingsPath?: string | undefined;
    hookPluginDir?: string | null | undefined;
    happierMcpConfigJson?: string | undefined;
    systemPromptText?: string | null | undefined;
    statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
  }>) => Promise<ClaudeUnifiedTerminalSpawn>) | undefined;
  readTerminalHostAttachmentInfo?: typeof readTerminalAttachmentInfo | undefined;
  createSessionName?: (() => string) | undefined;
  telemetry?: ClaudeUnifiedTelemetrySink | undefined;
  subscribeClaudeSessionHooks?: ClaudeUnifiedSessionHookSubscription | undefined;
  lifecycleCompletionQuiescenceMs?: number | undefined;
  dialogChoiceBroker?: ClaudeUnifiedDialogChoiceBroker | undefined;
  dialogOwnershipGraceMs?: number | undefined;
  dialogTurnStallScreenProbeQuietMs?: number | undefined;
  dialogTurnStallScreenProbeMaxAttempts?: number | undefined;
  dialogTurnEndScreenProbeDelaysMs?: readonly number[] | undefined;
  onThinkingChange?: ((thinking: boolean) => void) | undefined;
  onReady?: (() => void | Promise<void>) | undefined;
  onUsageLimitDetails?: ((details: NormalizedProviderUsageLimitDetailsV1) => void | Promise<void>) | undefined;
  onTerminalScreenObserved?: ((observation: ClaudeUnifiedTerminalScreenObservation) => void) | undefined;
  onRuntimeAuthFailureEvent?: ((error: unknown) => void | Promise<void>) | undefined;
  onProviderPromptStarted?: (() => void | Promise<void>) | undefined;
  /** Fires only when this runner is about to create a new provider host with spawn argv. */
  onProviderLaunchStarting?: (() => void | Promise<void>) | undefined;
  onProviderSessionStarted?: (() => void) | undefined;
  /** Fires when the single startup-readiness owner proves the provider is at an idle input boundary. */
  onStartupReady?: (() => void | Promise<void>) | undefined;
  onPromptTurnTerminal?: ((event: ClaudeUnifiedPromptTurnTerminalEvent) => void | Promise<void>) | undefined;
  runtimeActivityAdapter?: ReturnType<typeof createClaudeProviderRuntimeActivityAdapter> | null | undefined;
  onWorkflowActivityObserverReady?: (() => void) | null | undefined;
  /**
   * Publishes this runtime's ONE sidechain importer (and `null` when it is torn down) so the
   * launcher can hand workflow-agent sidecars to the same importer that already owns `Task`
   * sub-agent transcripts, instead of standing up a second one with its own budget and dedupe.
   */
  onSubagentFileCollectorChanged?: ((
    collector: ClaudeRemoteSubagentFileCollector | null,
  ) => void) | undefined;
  providerActivityLedger?: ReturnType<typeof createClaudeProviderActivityLedger> | undefined;
  onMessage?: ((message: RawJSONLines) => void | Promise<void>) | undefined;
  onHistoricalMessage?: ((message: RawJSONLines) => void | Promise<void>) | undefined;
  /**
   * Raw transcript channel (plan H7): every parsed JSONL value BEFORE the scanner's
   * visible-transcript filtering. Native Claude `/goal` state is a `goal_status`
   * ATTACHMENT (and `/goal` capability rides the system/init `slash_commands`); the
   * scanner drops both before `onMessage` (F2 visible-transcript gate), so launchers
   * feed the centralized goal source from THIS channel instead. Never emit these to
   * the visible transcript.
   */
  onRawTranscriptValue?: ((
    value: unknown,
    observation: Readonly<{ historicalReplay: boolean }>,
  ) => void) | undefined;
  /**
   * Invoked for every transcript row the runner suppresses from `onMessage` (controller-typed
   * slash-command echoes, L3). Launchers must persist a consumed marker
   * (`recordClaudeJsonlMessageConsumed`) so the row joins the committed baseline and cannot
   * replay as a "new" message after a same-session relaunch (resume-replay leak, 2026-06-11).
   */
  onTranscriptMessageSuppressed?: ((message: RawJSONLines) => void) | undefined;
  onSessionFound?: ((sessionId: string, data?: SessionHookData) => void) | undefined;
  loadCommittedClaudeJsonlMessageBaseline?: (() =>
    | Promise<import('../utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline>
    | import('../utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline) | undefined;
  allowFirstInputBeforeSessionStart?: boolean | undefined;
  /** Canonical session-turn lifecycle probe for the arbiter's stale-turn recovery (Lane N2). */
  isCanonicalTurnActive?: (() => boolean) | undefined;
  /** Canonical session delivery-state probe used to suppress ambiguous retries already accepted by the provider. */
  isPromptDeliveryAccepted?: ((batch: ClaudeUnifiedPromptBatch<Mode>) => boolean) | undefined;
  /**
   * Lane P (O-design Seam A): de-duplicated session-level steer availability tee from the steer
   * evaluator. Launchers publish it to agentState via the capability publisher.
   */
  onInFlightSteerAvailabilitySnapshot?: ((snapshot: Readonly<{ available: boolean; reason: 'unsafe_window' | 'user_terminal_draft' | null }>) => void) | undefined;
  /** Registers the evaluator's event-driven, payload-free screen proof for pre-claim Pending admission. */
  registerInFlightSteerAvailabilityRefresh?: ((
    refresh: () => Promise<ClaudeUnifiedSteerAvailabilitySnapshot>,
  ) => (() => void)) | undefined;
  /**
   * Lane X (incident cmq8y3nlx): one-shot per starvation episode — a steered pending prompt has
   * been blocked by a terminal composer draft past the bounded veto threshold. Launchers surface
   * a single user-visible session notice (never a silent retry loop).
   */
  onInFlightSteerUserDraftStarvation?: ((info: Readonly<{
    consecutiveVetoes: number;
    ownLeftover: boolean;
    draftLength: number;
  }>) => void) | undefined;
  /**
   * One-shot per idle injection starvation episode: a queued prompt has been blocked by an
   * unresolved composer draft, clear failure, or dialog past the bounded retry threshold.
   */
  onDraftGuardStarvation?: ((info: ClaudeUnifiedDraftGuardStarvationInfo) => void) | undefined;
  /** Bounded test/configuration seam for sustained pre-injection guard escalation. */
  draftGuardStarvationThresholdMs?: number | undefined;
  /**
   * Fired when the pre-injection draft guard observes an injectable composer again after a
   * starvation episode. Launchers use this as the self-heal seam for rows this runtime blocked.
   */
  onDraftGuardClear?: (() => void) | undefined;
  /**
   * C11 (incident cmq8y3nlx): caller-owned own-injected-text registry. Launchers pass the binding's
   * registry, which is seeded from the persisted prompt store BEFORE the run, so a respawned runner
   * still recognizes (and may clear) its predecessor's leftover composer injection instead of
   * starving behind an honest-but-unresolvable `user_draft` veto. Defaults to a fresh in-memory log.
   */
  ownComposerTexts?: ClaudeOwnComposerTextLog | undefined;
  initialHostLivenessTimeoutMs?: number | undefined;
  initialHostLivenessPollMs?: number | undefined;
  /**
   * Retained source-compatibility input for callers that previously configured probe failures as
   * death confirmation. Inconclusive probes are never death evidence.
   */
  hostLivenessProbeFailureConfirmDeadMs?: number | undefined;
  /**
   * Non-destructive one-shot attention callback for a live host whose liveness probes remain
   * inconclusive. The bridge never treats this as host-death evidence.
   */
  onHostLivenessProbeFailureStarvation?: ((params: Readonly<{
    liveness: TerminalHostLiveness;
    streakStartedAtMs: number;
    durationMs: number;
  }>) => void | Promise<void>) | undefined;
  setTurnInterrupt?: ((handler: (() => Promise<void>) | null) => void) | null | undefined;
  /**
   * Registers the user-authorized terminal composer clear control while this concrete terminal host
   * is alive. The runner owns the terminal control port; the launcher owns session runtime controls.
   */
  registerTerminalComposerClearRuntimeControl?: ((
    clearTerminalComposer: (
      request: Readonly<SessionTerminalComposerClearRequestV1>,
    ) => Promise<SessionTerminalComposerClearResultV1>,
  ) => (() => void) | void) | undefined;
  /** Registers the provider-owned release applied only after exact connected-service settlement. */
  registerConnectedServiceExactApplicationHandler?: ((
    releaseProviderUi: () => Promise<void>,
  ) => (() => void) | void) | undefined;
  /** Wakes the canonical Pending owner after the stale usage-limit overlay was dismissed. */
  onConnectedServiceExactApplicationReleased?: (() => void) | undefined;
  onPendingInputInterruptAndRunLocalIdChange?: ((localId: string | null) => void) | undefined;
  registerPendingInputInterruptAndRunRuntimeControl?: ((
    interruptPendingInputAndRun: (
      request: Readonly<SessionPendingInputInterruptAndRunRequestV1>,
    ) => Promise<SessionPendingInputInterruptAndRunResultV1>,
  ) => (() => void) | void) | undefined;
  /**
   * Registers the Claude `/goal` effector as live session runtime controls (P1-E3). For an active
   * session the goal router prefers the live RPC, which calls these controls to inject a literal
   * `/goal` user turn into the arbiter. For SET the emitted `goal_status` attachment is the source of
   * truth (no metadata write here); for CLEAR there is no echoed status, so the control additionally
   * removes the goal work-state item via `clearGoalWorkState`.
   */
  registerGoalRuntimeControl?: ((
    controls: ClaudeGoalRuntimeControls,
  ) => (() => void) | void) | undefined;
  /**
   * Removes the published Claude goal work-state item (used by the live clear effector, since Claude
   * emits no `goal_status` for `/goal clear`). Provided by the launcher that owns the goal source.
   */
  clearGoalWorkState?: (() => void) | undefined;
  /**
   * Records a goal-control SET intent (used by the live set effector once the `/goal <objective>`
   * inject reaches the terminal), so re-setting the same objective after a clear is accepted instead
   * of being suppressed as a stale post-clear replay (G2). Provided by the launcher that owns the
   * goal source.
   */
  recordGoalSetIntent?: (() => void) | undefined;
  /**
   * Initial goal objective to pursue on (re)launch (P1-E4). When set, a single `/goal <objective>`
   * is injected once the arbiter is ready (mirrors Codex's initial `thread/goal/set`).
   */
  initialGoalObjective?: string | undefined;
  onTerminalPromptInjected?: ((input: ClaudeUnifiedTerminalAcceptedInput<Mode>) => void | Promise<void>) | undefined;
  onTerminalInjectionFailure?: ((error: ClaudeUnifiedTerminalInjectionFailureError) =>
    void
    | Readonly<{ action: 'claimed_pending_delivery' }>
    | Readonly<{ action: 'surfaced_runtime_issue' }>
    | Promise<
      | void
      | Readonly<{ action: 'claimed_pending_delivery' }>
      | Readonly<{ action: 'surfaced_runtime_issue' }>
    >
  ) | undefined;
  onTerminalHostReady?: ((params: Readonly<{
    handle: TerminalHostHandle;
    terminal: NonNullable<Metadata['terminal']>;
    destroyOwnedHostForExplicitStop: () => Promise<void>;
  }>) => void | Promise<void>) | undefined;
  persistTerminalHostAttachmentInfo?: ((params: Readonly<{
    sessionId: string;
    attachmentId: NonNullable<TerminalHostHandle['attachmentId']>;
    handle: TerminalHostHandle;
    terminal: NonNullable<Metadata['terminal']>;
  }>) => void | Promise<void>) | undefined;
  removeTerminalHostAttachmentInfo?: ((params: Readonly<{
    sessionId: string;
    expectedAttachmentId: NonNullable<TerminalHostHandle['attachmentId']>;
    terminal: NonNullable<Metadata['terminal']>;
  }>) => void | Promise<void>) | undefined;
  clearSessionMarkerTerminalHostHealth?: typeof clearSessionMarkerTerminalHostHealth | undefined;
  processSignals?: ClaudeUnifiedProcessSignals | null | undefined;
  createController?: ((params: Readonly<{
    hostAdapter: Omit<TerminalHostAdapter, 'dispose'>;
    inputInjection: TerminalInputInjectionV1;
    inputConsumer: ClaudeUnifiedInputConsumer<Mode>;
  }>) => ClaudeUnifiedController | Promise<ClaudeUnifiedController>) | undefined;
  createStartupDialogResolver?: ((params: Readonly<{
    controlPort: TerminalControlPort;
    startupMode: Mode;
    isRuntimeControlInFlight: () => boolean;
    onResumeSummaryCompactionSubmitted: () => void;
  }>) => ClaudeUnifiedStartupDialogResolver | null | undefined) | undefined;
  tuiRuntimeControl?: ClaudeUnifiedTuiRuntimeControlOptions<Mode> | undefined;
}>;

/**
 * Lane E runtime-control integration options. When `featureEnabled` is true and the resolved host exposes
 * a runtime-control port, the runner instantiates the Claude Unified TUI control controller + bridge and
 * applies verified model/effort/permission-mode controls before each dependent prompt injection. When the
 * gate is off (or no control port is available), the runner does not gate injection and the existing
 * restart-notice path is preserved (no regression).
 */
export type ClaudeUnifiedTuiRuntimeControlOptions<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  featureEnabled: boolean;
  sessionModeEmissionEnabled?: boolean | undefined;
  emitRuntimeConfigOutcome: (event: ClaudeUnifiedRuntimeConfigOutcomeEvent) => void;
  /** Delay before a control-gated prompt injection is retried after a blocked apply. */
  blockedInjectionRetryMs?: number | undefined;
  /**
   * F2 starvation honesty (qa/QA-B.md): fired ONCE per episode when consecutive blocked
   * before-prompt applies cross the bounded threshold — the queued prompt is honestly stuck behind
   * an unsafe TUI window (draft/dialog/overlay) instead of silently re-deferring forever.
   */
  onBlockedApplyStarvation?: ((info: BlockedApplyStarvationInfo) => void) | undefined;
  /** Fired after a previously blocked runtime-control apply can proceed again. */
  onBlockedApplyClear?: (() => void) | undefined;
  /** Test seam: blocked-apply starvation threshold override. */
  blockedApplyStarvationThreshold?: number | undefined;
  /** Test seam: inject a prebuilt bridge instead of constructing one from the host control port. */
  createBridge?: (() => ClaudeUnifiedRuntimeControlBridge | null) | undefined;
  /**
   * Lane Y: register the live statusline → lastVerified reconciler with the session-level
   * statusline feed (the statusline applier forwards effective model/effort through it into the
   * controller). Returns an unregister function; the runner unregisters on teardown so a stale
   * bridge never consumes payloads meant for a relaunched host.
   */
  registerStatuslineRuntimeReconciler?: ((
    reconcile: (metadata: ClaudeStatuslineRuntimeMetadata) => void,
  ) => () => void) | undefined;
  /**
   * Register a metadata-only immediate permission/config applier. The launcher calls this when
   * session metadata changes without a queued prompt; the runner routes it through the same
   * runtime-control bridge used before prompt injection, or emits structured restart outcomes when
   * live control is unavailable.
   */
  registerMetadataRuntimeModeApplier?: ((
    apply: (mode: Mode) => Promise<ClaudeUnifiedRuntimeControlApplyResult>,
  ) => (() => void) | void) | undefined;
}>;

const DEFAULT_RUNTIME_CONTROL_BLOCKED_INJECTION_RETRY_MS = 250;
const DEFAULT_DIALOG_OWNERSHIP_GRACE_MS = 300;
const DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_QUIET_MS = 45_000;
const DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_MAX_ATTEMPTS = 3;
// After a turn settles, evaluate the dialog registry on a bounded idle re-arm schedule (offsets in ms
// from settle): the first two shots catch a queued-command dialog that renders a beat after Stop, and
// the backoff tail keeps re-evaluating for ~a minute so a dialog rendering several seconds late is
// still surfaced instead of recurring the silent hang (incident cmr377jsr / S1-F1). Strictly bounded:
// the tail stops early once a dialog is surfaced and escalates once at exhaustion — no infinite poll.
const DEFAULT_DIALOG_TURN_END_SCREEN_PROBE_DELAYS_MS: readonly number[] = [
  0,
  1_500,
  5_000,
  15_000,
  30_000,
  60_000,
];
const MAX_RECENT_ACCEPTED_TRANSCRIPT_CANDIDATES = 64;
const PROVIDER_ACCEPTANCE_PENDING_PREFIX_RESIDUE_MIN_CHARS = 16;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sanitizeSessionName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'session';
}

function createDefaultSessionName(): string {
  return `happier-claude-unified-${sanitizeSessionName(String(process.pid))}-${Date.now()}`;
}

function normalizeHostPreferenceForCurrentPlatform(
  preference: ClaudeUnifiedTerminalHostPreference,
): ClaudeUnifiedTerminalHostPreference {
  if (process.platform === 'win32' && preference === 'tmux') {
    return 'auto';
  }
  return preference;
}

function isClaudeUnifiedReusableTerminalHostKind(
  kind: TerminalHostKind,
): kind is Exclude<ClaudeUnifiedTerminalHostPreference, 'auto'> {
  return kind === 'tmux' || kind === 'zellij';
}

function disposeReplayableHookSubscription(
  subscription: ReturnType<typeof createReplayableHookSubscription> | null,
): void {
  subscription?.dispose();
}

export function shouldProbeTmuxForClaudeUnifiedDefaultHost(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}

async function resolveDefaultHostAdapter(
  preference: ClaudeUnifiedTerminalHostPreference,
  telemetry: ClaudeUnifiedTelemetrySink,
): Promise<TerminalHostResolution> {
  const promptSubmitVerification = createClaudePromptSubmitVerificationPolicy();
  const tmuxAvailable = shouldProbeTmuxForClaudeUnifiedDefaultHost()
    ? await isTmuxAvailable()
    : false;
  const windowsConsoleAdapter = process.platform === 'win32'
    ? createPtyTerminalHostAdapter({ promptSubmitVerification })
    : null;
  const shouldConfigureZellij = process.platform !== 'win32' || preference === 'zellij' || !windowsConsoleAdapter;
  const zellijBinary = shouldConfigureZellij ? await resolveZellijRuntimeBinary() : null;
  const zellijWindowsGuard = shouldConfigureZellij
    ? resolveZellijWindowsGuard({
        platform: process.platform,
        arch: process.arch,
        env: process.env,
      })
    : { status: 'ok' } as const;
  if (shouldConfigureZellij) {
    if (zellijWindowsGuard.status === 'disabled') {
      emitClaudeUnifiedWindowsGuardTriggered(telemetry, zellijWindowsGuard.reason);
      return {
        status: 'disabled',
        reason: zellijWindowsGuard.reason,
        message: zellijWindowsGuard.message,
      };
    }
    if (process.platform === 'win32' && zellijWindowsGuard.shell === 'cmd.exe') {
      emitClaudeUnifiedWindowsGuardTriggered(telemetry, 'windows_default_shell_cmd');
    }
  }
  const resolvedZellijWindowsGuard = zellijWindowsGuard.status === 'ok' ? zellijWindowsGuard : null;
  const adapters = createTerminalHostRegistry([
    ...(windowsConsoleAdapter ? [windowsConsoleAdapter] : []),
    ...(tmuxAvailable ? [createTmuxTerminalHostAdapter({ promptSubmitVerification })] : []),
    ...(zellijBinary
      ? [
          createZellijTerminalHostAdapter({
            zellijBinary,
            happyHomeDir: configuration.happyHomeDir,
            promptSubmitVerification,
            defaultShell: resolvedZellijWindowsGuard?.shell,
            ...(resolvedZellijWindowsGuard?.launchStrategy === 'foreground_windows_terminal'
              ? {
                  launchStrategy: {
                    type: 'foregroundAttached',
                    launchClient: createWindowsTerminalZellijForegroundClientLauncher(),
                  } as const,
                }
              : {}),
            actionTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs,
          }),
        ]
      : []),
  ]);

  return resolveTerminalHost({
    preference,
    platform: { os: process.platform, arch: process.arch },
    adapters,
    tmuxAvailable,
    zellijAvailable: Boolean(zellijBinary),
  });
}

async function buildDefaultSpawn(params: Readonly<{
  first: ClaudeUnifiedTerminalQueuedInput<EnhancedMode>;
  path: string;
  happySessionId?: string | null | undefined;
  claudeArgs?: readonly string[] | undefined;
  hookSettingsPath?: string | undefined;
  hookPluginDir?: string | null | undefined;
  happierMcpConfigJson?: string | undefined;
  systemPromptText?: string | null | undefined;
  statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
}>): Promise<ClaudeUnifiedTerminalSpawn> {
  return buildClaudeUnifiedTerminalSpawn(params);
}

type ExistingTerminalHostAttachment = Readonly<{
  handle: TerminalHostHandle;
  terminal: NonNullable<Metadata['terminal']>;
  attachmentId: NonNullable<TerminalHostHandle['attachmentId']> | null;
}>;

async function readExistingTerminalHostAttachment(params: Readonly<{
  sessionId?: string | null | undefined;
  readAttachmentInfo: typeof readTerminalAttachmentInfo;
}>): Promise<ExistingTerminalHostAttachment | null> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) return null;
  const info = await params.readAttachmentInfo({
    happyHomeDir: configuration.happyHomeDir,
    sessionId,
  });
  if (!info) return null;
  const handle = info.version === 2
    ? info.handle
    : buildTerminalHostHandleFromAttachmentMetadata(info.terminal);
  if (!handle) return null;
  return {
    handle,
    terminal: info.terminal,
    attachmentId: info.version === 2 ? info.attachmentId : null,
  };
}

async function removeUnreadLaunchSpec(spawn: ClaudeUnifiedTerminalSpawn): Promise<void> {
  if (!spawn.launchSpecPath) return;
  await unlink(spawn.launchSpecPath).catch(() => undefined);
  const specDir = dirname(spawn.launchSpecPath);
  if (basename(specDir).startsWith('happier-terminal-launch-')) {
    await rmdir(specDir).catch(() => undefined);
  }
}

function isClaudePromptInputExit(event: ClaudeUnifiedSessionEndEvent): boolean {
  return event.reason === 'prompt_input_exit';
}

function isCleanTerminalExit(liveness: Readonly<{ paneExitStatus?: number | undefined }>): boolean {
  return liveness.paneExitStatus === 0;
}

function waitForAnyAbort(signals: readonly AbortSignal[]): Promise<void> {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanups: Array<() => void> = [];
    const onAbort = () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      resolve();
    };
    for (const signal of signals) {
      const listener = () => onAbort();
      cleanups.push(() => signal.removeEventListener('abort', listener));
      signal.addEventListener('abort', listener, { once: true });
    }
  });
}

function bindProcessSignalCleanup(params: Readonly<{
  processSignals: ClaudeUnifiedProcessSignals;
  abortController: AbortController;
  dispose: () => Promise<void>;
}>): () => void {
  let cleanupStarted = false;
  const onSignal = () => {
    if (!params.abortController.signal.aborted) {
      params.abortController.abort('claude-unified-process-signal');
    }
    if (cleanupStarted) return;
    cleanupStarted = true;
    void params.dispose().catch((error) => {
      logger.debug('[unified]: failed to dispose Claude unified terminal session during process signal cleanup', error);
    });
  };

  params.processSignals.once('SIGINT', onSignal);
  params.processSignals.once('SIGTERM', onSignal);

  return () => {
    params.processSignals.removeListener('SIGINT', onSignal);
    params.processSignals.removeListener('SIGTERM', onSignal);
  };
}

function normalizeMessageBatch<Mode>(input: ClaudeUnifiedTerminalQueuedInput<Mode>): MessageBatch<Mode, string> {
  return {
    message: input.message,
    mode: input.mode,
    isolate: false,
    hash: 'claude-unified-terminal',
    maxUserMessageSeq: input.maxUserMessageSeq ?? null,
    userMessageLocalIds: input.userMessageLocalIds ?? [],
    ...(input.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
    ...(input.pendingProviderAction ? { pendingProviderAction: input.pendingProviderAction } : {}),
  };
}

function isCompactBoundaryTranscriptMessage(message: RawJSONLines): boolean {
  return message.type === 'system' && (message as Record<string, unknown>).subtype === 'compact_boundary';
}

function isAcceptedPromptTranscriptCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const type = (value as Record<string, unknown>).type;
  return type === 'user' || type === 'queue-operation' || type === 'attachment';
}

function isCompactSlashCommandPrompt(message: string): boolean {
  const trimmed = message.trim();
  return trimmed === '/compact' || trimmed.startsWith('/compact ');
}

function isDeterministicInvalidPromptTextFailure(
  failure: Readonly<{
    failureState: string;
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>;
  }>,
): boolean {
  return failure.failureState === 'failed_terminal'
    && failure.result.reason === 'invalid_prompt_text'
    && failure.result.phase === 'before_write'
    && failure.result.duplicateRisk === 'none'
    && failure.result.recoverable === false;
}

function createCompositeBridge(
  bridges: ReadonlyArray<ClaudeUnifiedStartableDisposable | undefined>,
  afterStart?: (() => void | Promise<void>) | undefined,
): ClaudeUnifiedStartableDisposable | undefined {
  const activeBridges = bridges.filter((bridge): bridge is ClaudeUnifiedStartableDisposable => Boolean(bridge));
  if (activeBridges.length === 0 && !afterStart) return undefined;
  return {
    async start(opts) {
      await Promise.all(activeBridges.map((bridge) => Promise.resolve(bridge.start(opts))));
      await afterStart?.();
    },
    async dispose() {
      let firstError: unknown;
      for (const bridge of [...activeBridges].reverse()) {
        try {
          await Promise.resolve(bridge.dispose());
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) {
        throw firstError;
      }
    },
  };
}

function createInputConsumer<Mode>(
  first: ClaudeUnifiedTerminalQueuedInput<Mode> | null,
  nextMessage: () => Promise<ClaudeUnifiedTerminalQueuedInput<Mode> | null>,
): ClaudeUnifiedInputConsumer<Mode> {
  let firstPending = first !== null;
  return {
    async waitForNextInput() {
      if (firstPending && first) {
        firstPending = false;
        return normalizeMessageBatch(first);
      }
      const next = await nextMessage();
      return next ? normalizeMessageBatch(next) : null;
    },
  };
}

async function persistTerminalHostAttachmentInfoIfAvailable(params: Readonly<{
  sessionId: string | null | undefined;
  handle: TerminalHostHandle;
  persist: NonNullable<ClaudeUnifiedTerminalSessionOptions['persistTerminalHostAttachmentInfo']>;
}>): Promise<NonNullable<Metadata['terminal']> | null> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) return null;

  const terminal = buildTerminalAttachmentMetadataFromHostHandle(params.handle);
  const attachmentId = params.handle.attachmentId;
  if (!terminal || !attachmentId) return null;

  await params.persist({ sessionId, attachmentId, handle: params.handle, terminal });
  return terminal;
}

async function persistDefaultTerminalHostAttachmentInfo(params: Readonly<{
  sessionId: string;
  attachmentId: NonNullable<TerminalHostHandle['attachmentId']>;
  handle: TerminalHostHandle;
  terminal: NonNullable<Metadata['terminal']>;
}>): Promise<void> {
  await writeTerminalAttachmentInfo({
    happyHomeDir: configuration.happyHomeDir,
    ...params,
  });
}

function mapClaudeComposerClearRefusalToProtocolStatus(
  reason: ClaudeComposerClearRefusalReason,
): SessionTerminalComposerClearFailureStatusV1 {
  switch (reason) {
    case 'generating':
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

function mapClaudeComposerClearFailureReasonToProtocolStatus(
  reason: string,
): SessionTerminalComposerClearFailureStatusV1 {
  if (reason.startsWith('host_dead:')) return 'host_dead';
  if (reason.startsWith('capture_unsupported:')) return 'capture_unavailable';
  if (reason === 'clear_failed') return 'clear_failed';
  return 'clear_failed';
}

function mapClaudeComposerClearResultToProtocolResult(
  result: ClaudeUserAuthorizedComposerClearResult,
  sessionId: string,
): SessionTerminalComposerClearResultV1 {
  switch (result.status) {
    case 'cleared':
    case 'already_empty':
      return SessionTerminalComposerClearResultV1Schema.parse({
        ok: true,
        status: result.status,
        sessionId,
      });
    case 'refused':
      return SessionTerminalComposerClearResultV1Schema.parse({
        ok: false,
        status: mapClaudeComposerClearRefusalToProtocolStatus(result.reason),
        sessionId,
        errorCode: result.reason,
        error: `terminal_composer_clear_refused:${result.reason}`,
      });
    case 'unsupported':
      return SessionTerminalComposerClearResultV1Schema.parse({
        ok: false,
        status: 'unsupported',
        sessionId,
        errorCode: result.reason ?? 'terminal_control_unsupported',
        error: result.reason ? `terminal_control_unsupported:${result.reason}` : 'terminal_control_unsupported',
      });
    case 'failed':
      return SessionTerminalComposerClearResultV1Schema.parse({
        ok: false,
        status: mapClaudeComposerClearFailureReasonToProtocolStatus(result.reason),
        sessionId,
        errorCode: result.reason,
        error: `terminal_composer_clear_failed:${result.reason}`,
      });
  }
}

export async function runClaudeUnifiedTerminalSession<Mode extends EnhancedMode = EnhancedMode>(
  opts: ClaudeUnifiedTerminalSessionOptions<Mode>,
): Promise<void> {
  const first = opts.initialMode ? null : await opts.nextMessage();
  if (!first && !opts.initialMode) return;
  const allowReadinessBeforeSessionStart = Boolean(first && opts.allowFirstInputBeforeSessionStart);
  const allowEmptyStartupInputBeforeSessionStart = first === null && Boolean(opts.initialMode);
  let lifecycleBridge: ReturnType<typeof createClaudeUnifiedHookLifecycleBridge> | undefined;
  const acceptedPromptTranscriptDiscovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
    acceptedPromptWindowMs: configuration.claudeUnifiedTerminalAcceptedPromptEchoWindowMs,
    onControlCommandConsumed: opts.onTranscriptMessageSuppressed,
    onAttemptLocalCommandCompleted: async () => {
      await lifecycleBridge?.settleAttemptLocalCommandCompleted();
    },
  });

  const telemetry = opts.telemetry ?? createClaudeUnifiedTelemetrySink();
  const publishHostDeadHealth = async (
    handle: TerminalHostHandle,
    liveness: unknown,
  ): Promise<void> => {
    const sessionId = typeof opts.happySessionId === 'string' ? opts.happySessionId.trim() : '';
    if (!sessionId) return;
    const observedAt =
      liveness && typeof liveness === 'object' && typeof (liveness as { observedAt?: unknown }).observedAt === 'number'
        ? Math.max(0, Math.trunc((liveness as { observedAt: number }).observedAt))
        : Date.now();
    await publishSessionMarkerTerminalHostHealth({
      pid: process.pid,
      health: {
        status: 'host_dead',
        sessionId,
        runnerPid: process.pid,
        hostKind: handle.kind,
        ...(handle.kind === 'zellij' ? { zellijSessionName: handle.sessionName } : {}),
        observedAt,
        reason: 'host_dead',
      },
    }).catch((error) => {
      logger.debug('[unified]: failed to publish terminal host death to daemon marker state', error);
    });
  };
  const startupMode = first?.mode ?? opts.initialMode;
  if (!startupMode) return;
  const startupInput: ClaudeUnifiedTerminalQueuedInput<Mode> = first ?? {
    message: '',
    mode: startupMode,
  };
  const hostPreference = normalizeHostPreferenceForCurrentPlatform(startupMode.claudeUnifiedTerminalHost ?? 'auto');
  const resolveHostAdapterForPreference = async (preference: ClaudeUnifiedTerminalHostPreference): Promise<TerminalHostResolution> => (
    opts.resolveHostAdapter
      ? opts.resolveHostAdapter(preference)
      : resolveDefaultHostAdapter(preference, telemetry)
  );
  let hostResolution = await resolveHostAdapterForPreference(hostPreference);
  telemetry.emit({
    name: 'unified.session.host_resolved',
    properties: {
      kind: hostResolution.status === 'resolved' ? hostResolution.adapter.kind : 'disabled',
      platform: process.platform,
      preference: hostPreference,
      reason: hostResolution.reason,
    },
  });
  if (hostResolution.status !== 'resolved') {
    maybeEmitClaudeUnifiedWindowsGuardTriggered(telemetry, hostResolution.reason);
    throw new ClaudeUnifiedTerminalHostUnavailableError(hostResolution.message);
  }
  const savedTerminalHost = await readExistingTerminalHostAttachment({
    sessionId: opts.happySessionId,
    readAttachmentInfo: opts.readTerminalHostAttachmentInfo ?? readTerminalAttachmentInfo,
  });
  let existingTerminalHost = savedTerminalHost;
  if (existingTerminalHost && existingTerminalHost.handle.kind !== hostResolution.adapter.kind) {
    const attachedKind = existingTerminalHost.handle.kind;
    const attachedHostResolution = isClaudeUnifiedReusableTerminalHostKind(attachedKind)
      ? await resolveHostAdapterForPreference(attachedKind)
      : null;
    if (attachedHostResolution?.status === 'resolved') {
      hostResolution = attachedHostResolution;
    } else {
      throw new TerminalHostStartupError({
        hostKind: existingTerminalHost.handle.kind,
        reason: 'recovery_probe_inconclusive',
        message: 'Saved terminal host cannot be inspected; retaining its attachment for retry',
        diagnostics: {
          sessionName: existingTerminalHost.handle.sessionName,
          adapterResolutionReason: attachedHostResolution?.reason ?? 'unsupported_saved_host_kind',
        },
      });
    }
  }
  const discardExistingTerminalHost = async (
    existing: ExistingTerminalHostAttachment,
    reason: string,
    proof: TerminalHostConfirmedDeadProbeResult,
  ): Promise<void> => {
    if (!existing.attachmentId) {
      throw new TerminalHostStartupError({
        hostKind: existing.handle.kind,
        reason: 'recovery_probe_inconclusive',
        message: 'Legacy terminal attachment has no immutable identity; retaining it for manual recovery',
        diagnostics: {
          reason,
          sessionName: existing.handle.sessionName,
          probeCount: proof.probeCount,
        },
      });
    }
    const sessionId = typeof opts.happySessionId === 'string' ? opts.happySessionId.trim() : '';
    if (!sessionId) {
      throw new TerminalHostStartupError({
        hostKind: existing.handle.kind,
        reason: 'recovery_probe_inconclusive',
        message: 'Terminal attachment has no bound Happier session identity; retaining it for manual recovery',
        diagnostics: { reason, sessionName: existing.handle.sessionName, probeCount: proof.probeCount },
      });
    }
    const disposition = await executeTerminalHostDisposition({
      happyHomeDir: configuration.happyHomeDir,
      sessionId,
      expectedAttachmentId: existing.attachmentId,
      intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
      adapter: hostResolution.adapter,
      readAttachmentInfo: opts.readTerminalHostAttachmentInfo ?? readTerminalAttachmentInfo,
      ...(opts.removeTerminalHostAttachmentInfo
        ? {
            removeAttachmentInfo: async ({ sessionId: claimedSessionId, expectedAttachmentId, expectedTerminal }) => {
              await opts.removeTerminalHostAttachmentInfo?.({
                sessionId: claimedSessionId,
                expectedAttachmentId: expectedAttachmentId as NonNullable<TerminalHostHandle['attachmentId']>,
                terminal: expectedTerminal,
              });
              return true;
            },
          }
        : {}),
    });
    if (disposition.status !== 'retired') {
      throw new TerminalHostStartupError({
        hostKind: existing.handle.kind,
        reason: 'startup_action_failed',
        message: 'Failed to retire the confirmed-dead terminal attachment; retaining it for retry',
        diagnostics: { reason, sessionName: existing.handle.sessionName, probeCount: proof.probeCount },
      });
    }
    const endpointRetirement = await retireClaudeEndpointArtifactsForTerminalAttachment({
      happyHomeDir: configuration.happyHomeDir,
      sessionId,
      retiredAttachmentId: existing.attachmentId,
    }).catch((error) => {
      logger.debug('[unified]: terminal host retired; Claude endpoint cleanup failed and remains pending', {
        sessionName: existing.handle.sessionName,
        attachmentId: existing.attachmentId,
        error,
      });
      return null;
    });
    if (endpointRetirement?.status === 'retained') {
      logger.debug('[unified]: terminal host retired; Claude endpoint cleanup remains pending', {
        reason: endpointRetirement.reason,
        sessionName: existing.handle.sessionName,
        attachmentId: existing.attachmentId,
      });
    }
  };
  if (existingTerminalHost) {
    const liveness = await evaluateTerminalHostLivenessForRecovery(hostResolution.adapter, existingTerminalHost.handle);
    if (isTerminalHostConfirmedDeadForRelaunch(liveness)) {
      await discardExistingTerminalHost(existingTerminalHost, 'saved_host_confirmed_dead', liveness);
      existingTerminalHost = null;
    } else if (liveness.status === 'inconclusive') {
      throw new TerminalHostStartupError({
        hostKind: existingTerminalHost.handle.kind,
        reason: 'recovery_probe_inconclusive',
        message: 'Terminal host recovery probe was inconclusive; retaining the saved host for retry',
        diagnostics: {
          sessionName: existingTerminalHost.handle.sessionName,
          probeCount: liveness.probeCount,
        },
      });
    }
  }
  let spawn: ClaudeUnifiedTerminalSpawn | null = null;
  let spawnEnvForRuntimeControl: Readonly<Record<string, string>> | null = null;
  const ensureSpawn = async (): Promise<ClaudeUnifiedTerminalSpawn> => {
    if (spawn) return spawn;
    spawn = await (opts.buildSpawn ?? buildDefaultSpawn)({
      first: startupInput,
      path: opts.path,
      happySessionId: opts.happySessionId,
      claudeArgs: opts.claudeArgs,
      hookSettingsPath: opts.hookSettingsPath,
      hookPluginDir: opts.hookPluginDir,
      happierMcpConfigJson: opts.happierMcpConfigJson,
      systemPromptText: opts.systemPromptText,
      statuslineForwarder: opts.statuslineForwarder,
    });
    spawnEnvForRuntimeControl = spawn.spawnEnv;
    return spawn;
  };
  const fallbackSessionName = opts.createSessionName?.() ?? createDefaultSessionName();
  const sessionName = existingTerminalHost?.handle.sessionName ?? fallbackSessionName;
  let handle: TerminalHostHandle | null = null;
  let controller: ClaudeUnifiedController | null = null;
  let runtimeControlBridge: ClaudeUnifiedRuntimeControlBridge | null = null;
  let dialogChoiceScreenProbe: ClaudeUnifiedDialogChoiceScreenProbe | null = null;
  let unregisterStatuslineRuntimeReconciler: (() => void) | null = null;
  let unregisterMetadataRuntimeModeApplier: (() => void) | null = null;
  let unregisterTerminalComposerClearRuntimeControl: (() => void) | null = null;
  let unregisterConnectedServiceExactApplicationHandler: (() => void) | null = null;
  let unregisterPendingInputInterruptAndRunRuntimeControl: (() => void) | null = null;
  let unregisterGoalRuntimeControl: (() => void) | null = null;
  let unregisterInFlightSteerAvailabilityRefresh: (() => void) | null = null;
  let inFlightSteerWiring: ClaudeUnifiedInFlightSteerWiring<Mode> | null = null;
  let notifyTerminalComposerCleared: (() => void) | null = null;
  let arbiterForResumeSummaryCompaction: ClaudeUnifiedInputArbiter<Mode> | null = null;
  let terminalComposerClearedWakePending = false;
  let terminalAttachment: NonNullable<Metadata['terminal']> | null = null;
  let removeProcessSignalCleanup: (() => void) | null = null;
  let turnInterruptRegistered = false;
  let hookSubscription: ReturnType<typeof createReplayableHookSubscription> | null = null;
  const ensureHookSubscription = (): ReturnType<typeof createReplayableHookSubscription> => {
    hookSubscription ??= createReplayableHookSubscription(opts.subscribeClaudeSessionHooks);
    return hookSubscription;
  };
  const runtimeAbortController = new AbortController();
  const processSignalAbortController = new AbortController();
  let fatalRuntimeError: unknown = null;
  const expectedProviderResumeSessionId =
    typeof opts.expectedProviderResumeSessionId === 'string'
    && opts.expectedProviderResumeSessionId.trim().length > 0
      ? opts.expectedProviderResumeSessionId.trim()
      : null;
  let explicitResumeIdentityRequired = false;
  let explicitResumeIdentityEstablished = expectedProviderResumeSessionId === null;
  let startupHostLivenessGraceActive = true;
  let providerSessionStartedObserved = false;
  let trustedHookActivationObserved = false;
  let trustedProviderProgressObserved = false;
  let expectedPromptInputExit = false;
  const observeTerminalScreen = (observation: ClaudeUnifiedTerminalScreenObservation): void => {
    opts.onTerminalScreenObserved?.(observation);
    void dialogChoiceScreenProbe?.evaluateScreenState(observation.screenState).catch((error) => {
      logger.debug('[unified]: Claude unified dialog observation failed', error);
    });
  };
  let observeSafeRuntimeBoundaryForMetadataApply: (() => Promise<void>) | null = null;
  const endStartupHostLivenessGrace = (): void => {
    startupHostLivenessGraceActive = false;
  };
  // Startup-readiness gate (Lane N3, incident cmq8y3nlx): no controls or prompt bytes may be
  // typed into the TUI until the SINGLE startup-readiness owner (the readiness bridge's
  // composer-evidence check) reports ready, or the provider provably accepted a prompt. The
  // arbiter's quietness heuristic alone can pass while the TUI is still initializing.
  let startupReadinessObservedForInjection = false;
  const observeStartupReadyForInjection = (): void => {
    startupReadinessObservedForInjection = true;
  };
  const observePossibleDialogScreenChange = (): void => {
    void dialogChoiceScreenProbe?.probe().catch((error) => {
      logger.debug('[unified]: Claude unified dialog lifecycle observation failed', error);
    });
  };
  const observeTrustedProviderProgress = (): void => {
    trustedProviderProgressObserved = true;
    observeStartupReadyForInjection();
    // Provider work can continue behind a nonblocking terminal overlay (for example Claude's LSP
    // recommendation). Progress is evidence that the screen may have changed, never proof that an
    // already-visible dialog disappeared; only the screen controller may resolve that episode.
    observePossibleDialogScreenChange();
  };
  const wakeAfterTerminalComposerClear = (): void => {
    if (notifyTerminalComposerCleared) {
      notifyTerminalComposerCleared();
      return;
    }
    terminalComposerClearedWakePending = true;
  };
  const observeProviderSessionStarted = (): void => {
    providerSessionStartedObserved = true;
    endStartupHostLivenessGrace();
    opts.onProviderSessionStarted?.();
  };
  const observeTrustedHookActivation = (): void => {
    trustedHookActivationObserved = true;
  };
  removeProcessSignalCleanup = bindProcessSignalCleanup({
    processSignals: opts.processSignals ?? process,
    abortController: processSignalAbortController,
    dispose: async () => {
      await controller?.dispose();
    },
  });
  try {
    // Immutable attachment identity proves which host must not be replaced. It does not prove that
    // this wrapper owns live Claude hook/MCP endpoints. Adoption is enabled only after the provider
    // endpoint owner has validated and rebound the attachment-bound descriptor.
    const expectedExistingTerminalHostAttachmentId =
      typeof opts.expectedExistingTerminalHostAttachmentId === 'string'
        ? opts.expectedExistingTerminalHostAttachmentId.trim()
        : '';
    const shouldAdoptExistingTerminalHost = existingTerminalHost !== null
      && existingTerminalHost.attachmentId !== null
      && expectedExistingTerminalHostAttachmentId.length > 0
      && existingTerminalHost.attachmentId === expectedExistingTerminalHostAttachmentId;
    if (shouldAdoptExistingTerminalHost && existingTerminalHost && hostResolution.adapter.adoptExistingHost) {
      try {
        const adoptedHandle = await hostResolution.adapter.adoptExistingHost(existingTerminalHost.handle);
        handle = adoptedHandle.attachmentId
          ? adoptedHandle
          : { ...adoptedHandle, attachmentId: createTerminalAttachmentId() };
        ensureHookSubscription();
      } catch (error) {
        const liveness = await evaluateTerminalHostLivenessForRecovery(hostResolution.adapter, existingTerminalHost.handle);
        if (!isTerminalHostConfirmedDeadForRelaunch(liveness)) {
          throw error;
        }
        await discardExistingTerminalHost(existingTerminalHost, 'adopt_failed_host_confirmed_dead', liveness);
        const fallbackSpawn = await ensureSpawn();
        ensureHookSubscription();
        explicitResumeIdentityRequired = expectedProviderResumeSessionId !== null;
        await opts.onProviderLaunchStarting?.();
        handle = await hostResolution.adapter.createOrAttachHost({
          sessionName: fallbackSessionName,
          workingDirectory: opts.path,
          spawnArgv: fallbackSpawn.spawnArgv,
          spawnEnv: fallbackSpawn.spawnEnv,
          isolatedEnv: true,
        });
      }
    } else {
      if (existingTerminalHost) {
        throw new TerminalHostStartupError({
          hostKind: existingTerminalHost.handle.kind,
          reason: 'live_attachment_adoption_unavailable',
          message: 'A live terminal attachment cannot be relaunched destructively; use proven non-destructive adoption',
          diagnostics: { sessionName: existingTerminalHost.handle.sessionName },
        });
      } else {
        const launchSpawn = await ensureSpawn();
        ensureHookSubscription();
        const createOptions = {
          sessionName,
          workingDirectory: opts.path,
          spawnArgv: launchSpawn.spawnArgv,
          spawnEnv: launchSpawn.spawnEnv,
          isolatedEnv: true,
        } as const;
        explicitResumeIdentityRequired = expectedProviderResumeSessionId !== null;
        await opts.onProviderLaunchStarting?.();
        handle = await hostResolution.adapter.createOrAttachHost(createOptions);
      }
    }
  } catch (error) {
    removeProcessSignalCleanup?.();
    removeProcessSignalCleanup = null;
    disposeReplayableHookSubscription(hookSubscription);
    if (spawn) await removeUnreadLaunchSpec(spawn);
    throw error;
  }
  if (processSignalAbortController.signal.aborted) {
    removeProcessSignalCleanup?.();
    disposeReplayableHookSubscription(hookSubscription);
    if (spawn) await removeUnreadLaunchSpec(spawn);
    return;
  }
  const activeHandle = handle;
  const activeHookSubscription = hookSubscription ?? ensureHookSubscription();
  const preserveActiveTerminalHost = async (
    reason: 'planned_runner_refresh' | 'wrapper_exit' | 'controller_failure' | 'auth_switch_handoff',
  ): Promise<void> => {
    const sessionId = typeof opts.happySessionId === 'string' ? opts.happySessionId.trim() : '';
    if (!sessionId || !activeHandle.attachmentId) return;
    await executeTerminalHostDisposition({
      happyHomeDir: configuration.happyHomeDir,
      sessionId,
      expectedAttachmentId: activeHandle.attachmentId,
      intent: {
        kind: 'preserve_host',
        reason,
        runtimePhase: reason === 'controller_failure' ? 'blocked' : 'transfer_pending',
      },
    });
  };
  let explicitStopHostDisposal: Promise<void> | null = null;
  const destroyOwnedHostForExplicitStop = (): Promise<void> => {
    if (explicitStopHostDisposal) return explicitStopHostDisposal;

    const sessionId = typeof opts.happySessionId === 'string' ? opts.happySessionId.trim() : '';
    const attachmentId = activeHandle.attachmentId;
    if (!sessionId || !attachmentId) {
      return Promise.reject(new Error('Claude Unified terminal host has no exact persisted attachment identity'));
    }

    const attempt = (async () => {
      const disposition = await executeTerminalHostDisposition({
        happyHomeDir: configuration.happyHomeDir,
        sessionId,
        expectedAttachmentId: attachmentId,
        intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
        adapter: hostResolution.adapter,
        readAttachmentInfo: opts.readTerminalHostAttachmentInfo ?? readTerminalAttachmentInfo,
        ...(opts.removeTerminalHostAttachmentInfo
          ? {
              removeAttachmentInfo: async ({ sessionId: claimedSessionId, expectedAttachmentId, expectedTerminal }) => {
                await opts.removeTerminalHostAttachmentInfo?.({
                  sessionId: claimedSessionId,
                  expectedAttachmentId: expectedAttachmentId as NonNullable<TerminalHostHandle['attachmentId']>,
                  terminal: expectedTerminal,
                });
                return true;
              },
            }
          : {}),
      });
      if (disposition.status !== 'destroyed') {
        const failure = disposition.status === 'parked' ? disposition.reason : disposition.status;
        throw new Error(`Claude Unified terminal host disposal did not complete: ${failure}`);
      }
    })();
    const guardedAttempt = attempt.catch((error) => {
      if (explicitStopHostDisposal === guardedAttempt) {
        explicitStopHostDisposal = null;
      }
      throw error;
    });
    explicitStopHostDisposal = guardedAttempt;
    return guardedAttempt;
  };
  try {
    if (opts.registerTerminalComposerClearRuntimeControl || opts.registerConnectedServiceExactApplicationHandler) {
      const terminalSessionControlPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
      if (terminalSessionControlPort && opts.registerTerminalComposerClearRuntimeControl) {
        const unregister = opts.registerTerminalComposerClearRuntimeControl(async (request) => {
          const result = await clearUserAuthorizedClaudeComposerDraft({
            port: terminalSessionControlPort,
          });
          const protocolResult = mapClaudeComposerClearResultToProtocolResult(result, request.sessionId);
          if (protocolResult.ok) {
            opts.onInFlightSteerAvailabilitySnapshot?.({ available: true, reason: null });
            wakeAfterTerminalComposerClear();
          }
          return protocolResult;
        });
        unregisterTerminalComposerClearRuntimeControl = typeof unregister === 'function' ? unregister : null;
      }
      if (terminalSessionControlPort && opts.registerConnectedServiceExactApplicationHandler) {
        const unregister = opts.registerConnectedServiceExactApplicationHandler(async () => {
          const result = await releaseClaudeUsageLimitDialogAfterExactApplication({
            port: terminalSessionControlPort,
          });
          if (result.status === 'released') {
            opts.onConnectedServiceExactApplicationReleased?.();
          }
        });
        unregisterConnectedServiceExactApplicationHandler = typeof unregister === 'function' ? unregister : null;
      }
    }

    terminalAttachment = await persistTerminalHostAttachmentInfoIfAvailable({
      sessionId: opts.happySessionId,
      handle: activeHandle,
      persist: opts.persistTerminalHostAttachmentInfo ?? persistDefaultTerminalHostAttachmentInfo,
    });
    if (processSignalAbortController.signal.aborted) {
      return;
    }

    if (opts.dialogChoiceBroker) {
      const dialogChoiceControlPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
      if (dialogChoiceControlPort) {
        dialogChoiceScreenProbe = createClaudeUnifiedDialogChoiceScreenProbe({
          broker: opts.dialogChoiceBroker,
          port: dialogChoiceControlPort,
          wait: waitMs,
          graceMs: opts.dialogOwnershipGraceMs ?? DEFAULT_DIALOG_OWNERSHIP_GRACE_MS,
          settleMs: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.commandSettleMs,
          verifyPollIntervalMs: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.verifyPollIntervalMs,
          verifyPollTimeoutMs: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.verifyPollTimeoutMs,
          isDialogOwned: (dialogId) => runtimeControlBridge?.ownsDialog(dialogId) === true,
          // resume_choice ownership is scoped to the startup window: the startup resume resolver only
          // runs before readiness. Once startup is observed ready the resolver has stood down, so a
          // resume dialog after that point is unowned and must be published, not silently deferred.
          isResumeStartupActive: () => startupReadinessObservedForInjection === false,
        });
      }
    }

    // Runtime-control integration (Lane E): when the feature gate is on and the host exposes a control
    // port, run verified TUI controls (model/effort/permission/plan mode) before each dependent prompt
    // injection. Gated-off / no-control-port → bridge stays null and injection is never gated (the
    // existing restart-notice path remains the behavior).
    const runtimeControlOptions = opts.tuiRuntimeControl;
    let currentInjectionMode: Mode = startupInput.mode;
    let currentInjectionDeliveryUserMessageLocalIds: readonly string[] = startupInput.userMessageLocalIds ?? [];
    // Lane X (incident cmq8y3nlx): bounded log of texts this runtime wrote into the TUI; the steer
    // evaluator uses it to classify a `user_draft` veto as our own leftover vs a genuine user draft.
    // C11: launchers pass a registry pre-seeded from the persisted prompt store so a RESPAWNED
    // runner also recognizes its predecessor's leftovers.
    // RESUME2 (runner pid 86645, 2026-06-12): controller-TYPED slash commands feed it too — a
    // typed-but-never-submitted `/effort medium` leftover otherwise classifies as a foreign draft
    // and deadlocks idle injection forever.
    const ownComposerTextLog = opts.ownComposerTexts ?? createClaudeOwnComposerTextLog();
    if (runtimeControlOptions?.featureEnabled === true) {
      runtimeControlBridge = runtimeControlOptions.createBridge?.() ?? null;
      if (!runtimeControlBridge) {
        const controlPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
        if (controlPort) {
          const controlEnv = spawnEnvForRuntimeControl
            ? Object.assign({}, spawnEnvForRuntimeControl) as NodeJS.ProcessEnv
            : process.env;
          const configDir = resolveClaudeConfigRootFromEnv(
            controlEnv,
            process.platform,
          );
          const tuiController = createClaudeUnifiedTuiControlController({
            port: controlPort,
            featureEnabled: true,
            settingsGuard: createClaudeSettingsGuard({ configDir }),
            onControlCommandWillSubmit: (commandText) => {
              return acceptedPromptTranscriptDiscovery.recordIndependentControlCommand({ message: commandText });
            },
            onControlCommandSubmissionResolved: (input) => {
              acceptedPromptTranscriptDiscovery.recordIndependentControlCommandDisposition(input);
            },
            onControlCommandTextEntered: (commandText) => ownComposerTextLog.record(commandText),
          });
          runtimeControlBridge = createClaudeUnifiedRuntimeControlBridge({
            controller: tuiController,
            emitRuntimeConfigOutcome: runtimeControlOptions.emitRuntimeConfigOutcome,
            ...(runtimeControlOptions.sessionModeEmissionEnabled !== undefined
              ? { sessionModeEmissionEnabled: runtimeControlOptions.sessionModeEmissionEnabled }
              : {}),
            startupMode: startupInput.mode,
          });
        }
      }
      if (runtimeControlBridge && runtimeControlOptions.registerStatuslineRuntimeReconciler) {
        // Lane Y: statusline → lastVerified effective-truth feed. The applier dedups re-emits;
        // here we only hand the live bridge to the session-level statusline feed.
        const bridgeForStatusline = runtimeControlBridge;
        unregisterStatuslineRuntimeReconciler = runtimeControlOptions.registerStatuslineRuntimeReconciler(
          (metadata: ClaudeStatuslineRuntimeMetadata) => bridgeForStatusline.reconcileFromStatusline(metadata),
        );
      }
    }
    const blockedInjectionRetryMs = runtimeControlOptions?.blockedInjectionRetryMs
      ?? DEFAULT_RUNTIME_CONTROL_BLOCKED_INJECTION_RETRY_MS;
    const blockedApplyStarvationThreshold = Math.max(
      1,
      Math.trunc(runtimeControlOptions?.blockedApplyStarvationThreshold ?? DEFAULT_BLOCKED_APPLY_STARVATION_THRESHOLD),
    );

    const readCanonicalTurnActiveForRuntimeControl = (): boolean => {
      try {
        return opts.isCanonicalTurnActive?.() ?? true;
      } catch {
        return true;
      }
    };

    // F2 starvation honesty: one bounded escalation per blocked delivery-apply episode (never a loop).
    const deliveryBlockedApplyStarvationTracker = createBlockedApplyStarvationTracker({
      threshold: blockedApplyStarvationThreshold,
      onStarvation: (info: BlockedApplyStarvationInfo) => runtimeControlOptions?.onBlockedApplyStarvation?.({
        isCanonicalTurnActive: readCanonicalTurnActiveForRuntimeControl(),
        ...info,
      }),
    });
    const metadataBlockedApplyStarvationTracker = createBlockedApplyStarvationTracker({
      threshold: blockedApplyStarvationThreshold,
      onStarvation: () => undefined,
    });

    if (runtimeControlOptions?.registerMetadataRuntimeModeApplier) {
      let metadataFallbackBaselineMode: Mode = startupInput.mode;
      let pendingMetadataRuntimeModeApply: Mode | null = null;
      let metadataRuntimeModeApplyInFlight: Promise<ClaudeUnifiedRuntimeControlApplyResult> | null = null;
      let metadataRuntimeModeApplyRetryTimer: ReturnType<typeof setTimeout> | null = null;
      let metadataRuntimeModeApplyStarvationOutcomeEmitted = false;
      const deferredMetadataRuntimeApplyResult = (): ClaudeUnifiedRuntimeControlApplyResult => ({
        promptMayProceed: false,
        attempted: false,
      });
      const clearMetadataRuntimeModeApplyRetryTimer = (): void => {
        if (!metadataRuntimeModeApplyRetryTimer) return;
        clearTimeout(metadataRuntimeModeApplyRetryTimer);
        metadataRuntimeModeApplyRetryTimer = null;
      };
      const emitMetadataRuntimeModeApplyStarvationOutcome = (
        mode: Mode,
        blockedReason: string | undefined,
      ): void => {
        if (metadataRuntimeModeApplyStarvationOutcomeEmitted) return;
        metadataRuntimeModeApplyStarvationOutcomeEmitted = true;
        const desired = mapEnhancedModeToDesiredRuntimeConfig(mode);
        const changes: Array<ClaudeUnifiedRuntimeConfigOutcomeEvent['changes'][number]> = [];
        if (desired.model !== undefined) {
          changes.push({ key: 'model', requested: desired.model, ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (desired.reasoningEffort !== undefined) {
          changes.push({ key: 'reasoningEffort', requested: desired.reasoningEffort, ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (desired.ultracode !== undefined) {
          changes.push({ key: 'launchOption', requested: 'ultracode', ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (desired.maxThinkingTokens !== undefined) {
          changes.push({ key: 'maxThinkingTokens', requested: desired.maxThinkingTokens, ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (runtimeControlOptions.sessionModeEmissionEnabled === true && desired.agentModeId !== undefined) {
          changes.push({ key: 'sessionMode', requested: desired.agentModeId ?? null, ...(blockedReason ? { reason: blockedReason } : {}) });
        } else if (desired.permissionMode !== undefined) {
          changes.push({ key: 'permissionMode', requested: desired.permissionMode, ...(blockedReason ? { reason: blockedReason } : {}) });
        }
        if (changes.length === 0) return;
        runtimeControlOptions.emitRuntimeConfigOutcome({
          status: 'failed',
          timing: 'queued_until_safe_window',
          message: 'Claude Unified runtime changes are still blocked waiting for a safe terminal window.',
          changes,
        });
      };
      const schedulePendingMetadataRuntimeModeApplyRetry = (
        consecutiveBlockedApplies: number,
      ): void => {
        clearMetadataRuntimeModeApplyRetryTimer();
        metadataRuntimeModeApplyRetryTimer = setTimeout(() => {
          metadataRuntimeModeApplyRetryTimer = null;
          void retryPendingMetadataRuntimeModeApply().catch(() => undefined);
        }, resolveBlockedApplyRetryMs(consecutiveBlockedApplies, blockedInjectionRetryMs));
        metadataRuntimeModeApplyRetryTimer.unref?.();
      };
      const flushPendingMetadataRuntimeModeApply = async (): Promise<ClaudeUnifiedRuntimeControlApplyResult> => {
        if (metadataRuntimeModeApplyInFlight) return metadataRuntimeModeApplyInFlight;
        if (!pendingMetadataRuntimeModeApply || !runtimeControlBridge) {
          return deferredMetadataRuntimeApplyResult();
        }
        const apply = async (): Promise<ClaudeUnifiedRuntimeControlApplyResult> => {
          let lastResult = deferredMetadataRuntimeApplyResult();
          while (pendingMetadataRuntimeModeApply && runtimeControlBridge) {
            const modeForMetadataApply = pendingMetadataRuntimeModeApply;
            const result = await runtimeControlBridge.applyOutOfBand(modeForMetadataApply);
            lastResult = result;
            if (!result.promptMayProceed) {
              const consecutiveBlockedApplies = metadataBlockedApplyStarvationTracker.recordBlocked(result.blockedReason);
              if (consecutiveBlockedApplies >= blockedApplyStarvationThreshold) {
                emitMetadataRuntimeModeApplyStarvationOutcome(modeForMetadataApply, result.blockedReason);
              }
              schedulePendingMetadataRuntimeModeApplyRetry(consecutiveBlockedApplies);
              return result;
            }
            clearMetadataRuntimeModeApplyRetryTimer();
            metadataBlockedApplyStarvationTracker.reset();
            metadataRuntimeModeApplyStarvationOutcomeEmitted = false;
            metadataFallbackBaselineMode = modeForMetadataApply;
            if (pendingMetadataRuntimeModeApply === modeForMetadataApply) {
              pendingMetadataRuntimeModeApply = null;
            }
          }
          return lastResult;
        };
        const inFlight = apply().finally(() => {
          if (metadataRuntimeModeApplyInFlight === inFlight) {
            metadataRuntimeModeApplyInFlight = null;
          }
        });
        metadataRuntimeModeApplyInFlight = inFlight;
        return inFlight;
      };
      const retryPendingMetadataRuntimeModeApply = async (): Promise<void> => {
        if (!pendingMetadataRuntimeModeApply || !runtimeControlBridge) return;
        await flushPendingMetadataRuntimeModeApply();
      };
      observeSafeRuntimeBoundaryForMetadataApply = retryPendingMetadataRuntimeModeApply;
      const unregister = runtimeControlOptions.registerMetadataRuntimeModeApplier(async (modeForMetadataApply) => {
        if (runtimeControlBridge) {
          clearMetadataRuntimeModeApplyRetryTimer();
          metadataRuntimeModeApplyStarvationOutcomeEmitted = false;
          pendingMetadataRuntimeModeApply = modeForMetadataApply;
          return flushPendingMetadataRuntimeModeApply();
        }
        const events = buildClaudeUnifiedRuntimeControlDisabledOutcomeEvents({
          mode: modeForMetadataApply,
          baselineMode: metadataFallbackBaselineMode,
          sessionModeEmissionEnabled: runtimeControlOptions.sessionModeEmissionEnabled === true,
        });
        for (const event of events) {
          runtimeControlOptions.emitRuntimeConfigOutcome(event);
        }
        return {
          promptMayProceed: false,
          attempted: false,
        };
      });
      unregisterMetadataRuntimeModeApplier = typeof unregister === 'function'
        ? () => {
          clearMetadataRuntimeModeApplyRetryTimer();
          unregister();
        }
        : () => {
          clearMetadataRuntimeModeApplyRetryTimer();
        };
    }
    // The gate is armed only for the default controller wiring (which constructs the readiness
    // bridge below); a custom `createController` seam owns its own readiness.
    const startupReadinessGateArmed = !opts.createController;
    const runBeforePromptInjectionGates = async (): Promise<TerminalInputInjectionResult | null> => {
      if (startupReadinessGateArmed && !startupReadinessObservedForInjection) {
        return {
          status: 'deferred',
          reason: 'pane_initializing',
          retryAfterMs: 250,
        };
      }
      if (!runtimeControlBridge) return null;

      // Runtime controls own the effort/model dialogs they create. They must run before composer
      // classification; otherwise a visible leftover dialog makes the guard starve the only owner
      // capable of resolving it (incident cmraa2qky / cmr377jsr).
      const apply = await runtimeControlBridge.applyBeforePrompt(currentInjectionMode);
      if (!apply.promptMayProceed) {
        // A control can be blocked by a different, unowned dialog. Reuse the registry-backed probe
        // before deferring so that dialog is surfaced instead of hiding behind the control retry.
        await dialogChoiceScreenProbe?.probe();
        const consecutiveBlockedApplies = deliveryBlockedApplyStarvationTracker.recordBlocked(
          apply.blockedReason,
          {
            userMessageLocalIds: currentInjectionDeliveryUserMessageLocalIds,
          },
        );
        return {
          status: 'deferred',
          reason: 'terminal_busy',
          retryAfterMs: resolveBlockedApplyRetryMs(consecutiveBlockedApplies, blockedInjectionRetryMs),
          blocker: {
            kind: 'runtime_config_blocked',
            source: 'runtime_control',
            ...(apply.blockedReason !== undefined ? { blockedReason: apply.blockedReason } : {}),
          },
        };
      }
      deliveryBlockedApplyStarvationTracker.reset();
      runtimeControlOptions?.onBlockedApplyClear?.();
      return null;
    };

    const hostInputInjection: TerminalInputInjectionV1 = {
      hostKind: hostResolution.adapter.kind,
      injectUserPrompt: async (input, writeBoundary) => {
        // Lane X: every text we attempt to write is recorded so a later leftover composer draft
        // can be exact-match classified as OUR OWN residue (vs an untouchable genuine user draft).
        ownComposerTextLog.record(input.text);
        let writeAuthorized = false;
        const adapterWriteBoundary = writeBoundary
          ? {
              authorizeBeforeWrite: async () => {
                const authorized = await writeBoundary.authorizeBeforeWrite();
                writeAuthorized = authorized;
                return authorized;
              },
            }
          : undefined;
        let result: TerminalInputInjectionResult;
        try {
          result = adapterWriteBoundary
            ? await hostResolution.adapter.injectUserPrompt(activeHandle, input, adapterWriteBoundary)
            : await hostResolution.adapter.injectUserPrompt(activeHandle, input);
        } catch {
          result = {
            status: 'failed',
            reason: 'host_unreachable',
            phase: writeAuthorized ? 'during_write' : 'before_write',
            duplicateRisk: writeAuthorized ? 'possible' : 'none',
            recoverable: true,
          };
        }
        if (writeAuthorized && result.status !== 'injected') {
          result = {
            status: 'failed',
            reason: result.status === 'failed' ? result.reason : 'host_unreachable',
            phase: result.status === 'failed' && result.phase !== 'before_write'
              ? result.phase
              : 'during_write',
            duplicateRisk: result.status === 'failed' && result.duplicateRisk === 'likely'
              ? 'likely'
              : 'possible',
            recoverable: true,
          };
        }
        if (result.status === 'failed'
          && result.phase === 'during_write'
          && result.duplicateRisk !== 'none') {
          ownComposerTextLog.recordPossiblePartialResidue(input.text);
        }
        return result;
      },
    };
    const pendingInputInterruptAndRunEnabled =
      isClaudeUnifiedPendingInputInterruptAndRunEnabled(hostResolution.adapter.kind);

    // Preserve the public custom-controller seam: custom controllers still receive the same gated
    // TerminalInputInjectionV1. The default controller gives the prompt injector the raw host writer
    // plus the gate separately so the canonical order is controls -> draft guard -> host write.
    const inputInjection: TerminalInputInjectionV1 = {
      hostKind: hostInputInjection.hostKind,
      injectUserPrompt: async (input, writeBoundary) => {
        const gateResult = await runBeforePromptInjectionGates();
        return gateResult ?? hostInputInjection.injectUserPrompt(input, writeBoundary);
      },
    };
    removeProcessSignalCleanup?.();
    removeProcessSignalCleanup = bindProcessSignalCleanup({
      processSignals: opts.processSignals ?? process,
      abortController: processSignalAbortController,
      dispose: () => controller?.dispose() ?? preserveActiveTerminalHost('wrapper_exit'),
    });
    opts.setTurnInterrupt?.(() => hostResolution.adapter.interruptTurn(activeHandle));
    turnInterruptRegistered = true;
    const baseInputConsumer = createInputConsumer(first, opts.nextMessage);
    // Track the mode of the most recently pulled batch so the injection gate applies the runtime config
    // desired by the prompt that is about to be injected.
    const inputConsumer: ClaudeUnifiedInputConsumer<Mode> = runtimeControlBridge
      ? {
          async waitForNextInput(consumerOpts) {
            const batch = await baseInputConsumer.waitForNextInput(consumerOpts);
            if (batch) {
              currentInjectionMode = batch.mode;
              currentInjectionDeliveryUserMessageLocalIds = batch.userMessageLocalIds ?? [];
            }
            return batch;
          },
        }
      : baseInputConsumer;
    controller = await (opts.createController?.({
      hostAdapter: hostResolution.adapter,
      inputInjection,
      inputConsumer,
    }) ?? (() => {
      // Lane X: a dedicated control port for the bounded own-leftover composer clear (Escape on a
      // NON-generating screen only). Separate from the runtime-control controller's port — the
      // evaluator never routes through controller state. Shared with the pre-injection guard below.
      const steerDraftClearPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
      const startupDialogControlPort = opts.createStartupDialogResolver
        ? (hostResolution.adapter.createControlPort?.(activeHandle) ?? null)
        : null;
      const resolveStartupDialog = startupDialogControlPort
        ? (opts.createStartupDialogResolver?.({
          controlPort: startupDialogControlPort,
          startupMode: startupInput.mode,
          isRuntimeControlInFlight: () => runtimeControlBridge?.isControlInFlight() === true,
          onResumeSummaryCompactionSubmitted: () => {
            // Claude owns the `/compact` turn triggered by this dialog choice. Fence every
            // Pending provider effect immediately after the successful choice write—before the
            // asynchronous PreCompact hook—so an exact send-now request cannot Escape-cancel the
            // provider-owned startup turn. PostCompact releases the existing arbiter lifecycle.
            arbiterForResumeSummaryCompaction?.observeLifecycle({
              type: 'compaction',
              phase: 'started',
            });
          },
        }) ?? undefined)
        : undefined;
      const captureInputStateForGuard = hostResolution.adapter.captureInputState;
      const promptInjector = createClaudeUnifiedPromptInjector<Mode>({
        inputInjection: hostInputInjection,
        beforeComposerDraftGuard: runBeforePromptInjectionGates,
        // A terminal-local slash command can replace the composer with a chooser without emitting
        // a Claude turn or hook. Observe that exact successful injection boundary so the single
        // dialog broker sees the new screen; the other event sources (startup readiness, turn
        // hooks, and steer probes) are intentionally absent for this no-turn transition.
        onInjected: async (batch) => {
          // Enter can return before Claude has painted a slash-command chooser. Give that
          // event-triggered transition one bounded render settle; this is not a polling loop and
          // ordinary prompts retain the immediate no-dialog fast path.
          if (!dialogChoiceScreenProbe || !batch.message.trimStart().startsWith('/')) return;
          await waitMs(opts.dialogOwnershipGraceMs ?? DEFAULT_DIALOG_OWNERSHIP_GRACE_MS);
          await dialogChoiceScreenProbe.probe();
        },
        telemetry,
        onDraftGuardStarvation: opts.onDraftGuardStarvation,
        onDraftGuardClear: opts.onDraftGuardClear,
        isCanonicalTurnActive: opts.isCanonicalTurnActive,
        ...(opts.draftGuardStarvationThresholdMs !== undefined
          ? { draftGuardStarvationThresholdMs: opts.draftGuardStarvationThresholdMs }
          : {}),
        // C11 (live-proven, runner pid 83791): never type an idle injection next to a leftover
        // composer draft. Own leftovers (respawn-seeded registry) are cleared; anything else
        // defers the injection untouched.
        ...(captureInputStateForGuard && steerDraftClearPort
          ? {
              composerDraftGuard: async () => {
                const result = await clearOwnLeftoverComposerDraft({
                  captureInputState: () => captureInputStateForGuard(activeHandle),
                  sendClearKey: async () => {
                    await steerDraftClearPort.sendSpecialKey('Escape');
                  },
                  ownComposerTexts: ownComposerTextLog,
                });
                // An idle recognized dialog has no real composer. Route its parsed screen through
                // the single owner-first dialog evaluator; that evaluator either observes the
                // slash-control owner or publishes the unowned choice through the broker.
                if (
                  result.status === 'blocked_non_input_state'
                  && hasClaudeUnifiedVisibleDialog(result.screen)
                ) {
                  await dialogChoiceScreenProbe?.evaluateScreenState(result.screen);
                }
                // Dialog redraws can leave transcript `❯` echoes in the parser's composer slot.
                // They are not draft evidence while the dialog owns input, so do not project a
                // misleading draft length into guard telemetry/escalation.
                const draftLength = result.status !== 'blocked_non_input_state' && 'screen' in result
                  ? (result.screen.composerContent?.length ?? 0)
                  : undefined;
                return {
                  status: result.status,
                  ...(result.status === 'cleared' ? { attempts: result.attempts } : {}),
                  ...(result.status === 'blocked_non_input_state' ? { blockedReason: result.blockedReason } : {}),
                  ...(draftLength !== undefined ? { draftLength } : {}),
                };
              },
            }
          : {}),
      });
      // In-flight steering (D19, incident cmq8171vw): a `ui_pending` prompt delivered mid-turn is
      // steered into the live TUI when the shared screen-state parser proves the screen is safe
      // (actively generating, no dialog/picker/draft); otherwise it keeps the bounded deferred path.
      // Lane Q: when the runtime-control bridge exists, a mode-carrying pending prompt may have
      // its permission/plan mode applied to the RUNNING turn (verified ShiftTab, probe Q-A) so the
      // text steers instead of deferring to turn end. No bridge -> unchanged refusal/defer behavior.
      const bridgeForInFlightModeApply = runtimeControlBridge;
      let arbiterForPromptCustody: ClaudeUnifiedInputArbiter<Mode> | null = null;
      const steerWiring = createClaudeUnifiedInFlightSteerEvaluator<Mode>({
        hostAdapter: hostResolution.adapter,
        handle: activeHandle,
        telemetry,
        initialPermissionMode: startupInput.mode.permissionMode,
        onPromptCustodyByTerminal: async (batch) => {
          await arbiterForPromptCustody?.observePromptCustodyByTerminal(batch);
        },
        onAvailabilitySnapshot: opts.onInFlightSteerAvailabilitySnapshot,
        onScreenObserved: observeTerminalScreen,
        ownComposerTexts: ownComposerTextLog,
        ...(steerDraftClearPort
          ? {
              clearOwnLeftoverDraft: async () => {
                await steerDraftClearPort.sendSpecialKey('Escape');
              },
            }
          : {}),
        onUserDraftStarvation: opts.onInFlightSteerUserDraftStarvation,
        ...(bridgeForInFlightModeApply
          ? {
              applyPermissionModeDeltaInFlight: (mode: Mode) =>
                bridgeForInFlightModeApply.applyPermissionModeForInFlightSteer(mode),
            }
          : {}),
      });
      inFlightSteerWiring = steerWiring;
      unregisterInFlightSteerAvailabilityRefresh =
        opts.registerInFlightSteerAvailabilityRefresh?.(steerWiring.refreshAvailability) ?? null;
      const arbiter = createClaudeUnifiedInputArbiter<Mode>({
        injectPrompt: promptInjector.injectPrompt,
        injectionRetryLimit: configuration.claudeUnifiedTerminalInjectionRetryLimit,
        injectionRetryBaseDelayMs: configuration.claudeUnifiedTerminalInjectionRetryBaseDelayMs,
        evaluateInFlightSteer: steerWiring.evaluateInFlightSteer,
        interruptActiveTurn: () => hostResolution.adapter.interruptTurn(activeHandle),
        onSteerAcceptanceArmed: steerWiring.onSteerAcceptanceArmed,
        isCanonicalTurnActive: opts.isCanonicalTurnActive,
        isPromptDeliveryAccepted: opts.isPromptDeliveryAccepted,
        onPendingInputInterruptAndRunLocalIdChange: (localId) => {
          opts.onPendingInputInterruptAndRunLocalIdChange?.(
            pendingInputInterruptAndRunEnabled ? localId : null,
          );
        },
        onInjectionFailure: async (failure) => {
          const error = new ClaudeUnifiedTerminalInjectionFailureError(failure);
          const notifyTerminalInjectionFailure = async (logContext: string) => {
            try {
              return await opts.onTerminalInjectionFailure?.(error);
            } catch (notifyError) {
              logger.debug(logContext, notifyError);
              return undefined;
            }
          };
          if (failure.failureState === 'failed_terminal') {
            if (failure.batch.pendingProviderAction) {
              return await notifyTerminalInjectionFailure('[unified]: failed to surface exact pending delivery failure (non-fatal)');
            }
            if (isDeterministicInvalidPromptTextFailure(failure)) {
              opts.onPromptTerminallyRejectedBeforeProvider?.({
                message: failure.batch.message,
                maxUserMessageSeq: failure.batch.maxUserMessageSeq ?? null,
                userMessageLocalIds: failure.batch.userMessageLocalIds ?? [],
                reason: 'invalid_prompt_text',
              });
              return await notifyTerminalInjectionFailure('[unified]: failed to surface Claude unified terminal invalid prompt text (non-fatal)');
            }
            if (failure.result.recoverable) {
              return await notifyTerminalInjectionFailure('[unified]: failed to surface Claude unified terminal recoverable injection failure (non-fatal)');
            }
            fatalRuntimeError ??= error;
            runtimeAbortController.abort(error);
            return;
          }
          return await notifyTerminalInjectionFailure('[unified]: failed to surface Claude unified terminal injection failure (non-fatal)');
        },
        onProviderAcceptancePending: (batch, _acceptance, observedAtMs) => {
          recordPromptAcceptanceCorrelation(batch, observedAtMs);
        },
        onPromptInjected: async (batch, acceptance) => {
          steerWiring.observeInjectedPrompt(batch, acceptance);
          if (batch.mode === undefined) return undefined;
          endStartupHostLivenessGrace();
          return opts.onTerminalPromptInjected?.({
            message: batch.message,
            mode: batch.mode,
            acceptedAs: acceptance.acceptedAs,
            turnStateAtInjection: acceptance.turnStateAtInjection,
          });
        },
        onPromptAccepted: (batch, acceptance) => {
          acceptedPromptTranscriptDiscovery.consumeAcceptedPromptByBatch({
            message: batch.message,
            maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
            userMessageLocalIds: batch.userMessageLocalIds ?? [],
          });
          opts.onPromptAcceptedByProvider?.({
            message: batch.message,
            maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
            userMessageLocalIds: batch.userMessageLocalIds ?? [],
            ...(acceptance.acceptedAs === 'new_turn'
              && typeof batch.mode?.model === 'string'
              && batch.mode.model.trim()
              ? { appliedModelId: batch.mode.model.trim() }
              : {}),
          });
        },
        // F-1: a batch still inside the arbiter when it is disposed (failed_terminal park,
        // host-death unwind, graceful teardown) must return to the session queue, mirroring
        // the pump-level handback below — never silently dropped into a dead session.
        onUndeliverableBatches: (batches) => {
          // returnUnconsumedMessage unshifts to the queue head; reverse so FIFO order survives.
          for (const batch of [...batches].reverse()) {
            if (batch.mode === undefined) {
              logger.debug('[unified]: cannot requeue undeliverable arbiter batch without a mode');
              continue;
            }
            opts.returnUnconsumedMessage?.({
              message: batch.message,
              mode: batch.mode,
              maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
              userMessageLocalIds: batch.userMessageLocalIds ?? [],
              ...(batch.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
              ...(batch.pendingProviderAction ? { pendingProviderAction: batch.pendingProviderAction } : {}),
            });
          }
        },
      });
      arbiterForResumeSummaryCompaction = arbiter;
      notifyTerminalComposerCleared = () => {
        arbiter.notifyTerminalComposerCleared();
      };
      if (terminalComposerClearedWakePending) {
        terminalComposerClearedWakePending = false;
        notifyTerminalComposerCleared();
      }
      arbiterForPromptCustody = arbiter;
      if (
        pendingInputInterruptAndRunEnabled
        && opts.registerPendingInputInterruptAndRunRuntimeControl
        && hostResolution.adapter.captureInputState
      ) {
        const unregister = opts.registerPendingInputInterruptAndRunRuntimeControl(async (request) => {
          const result = await interruptClaudeUnifiedQueuedPrompt({
            localId: request.localId,
            readCurrentLocalId: arbiter.readPendingInputInterruptAndRunLocalId,
            claim: arbiter.claimPendingInputInterruptAndRun,
            captureInputState: () => hostResolution.adapter.captureInputState!(activeHandle),
            interruptTurn: () => hostResolution.adapter.interruptTurn(activeHandle),
          });
          return {
            ...result,
            sessionId: request.sessionId,
            localId: request.localId,
          };
        });
        unregisterPendingInputInterruptAndRunRuntimeControl =
          typeof unregister === 'function' ? unregister : null;
      }
      // Claude `/goal` injection seam (P1-E3/P1-E4): a goal command becomes a literal user turn
      // injected through the same arbiter as any prompt; the emitted `goal_status` attachment is
      // the source of truth, so nothing here writes goal state into metadata. `currentInjectionMode`
      // is read at injection time so the goal turn carries the live permission/plan mode.
      const injectGoalCommand = async (message: string): Promise<ClaudeGoalCommandDelivery> => {
        await arbiter.enqueueUiMessage({ message, mode: currentInjectionMode, origin: { kind: 'rpc' } });
        await arbiter.drainWhenSafe();
        // The strongest delivery state the arbiter can PROVE: the command was drained from the queue
        // and written to the terminal. It cannot prove provider acceptance, so we never claim more.
        return { kind: 'sent-to-terminal' };
      };
      if (opts.registerGoalRuntimeControl) {
        const unregister = opts.registerGoalRuntimeControl(
          createClaudeGoalRuntimeControls({
            injectGoalCommand,
            ...(opts.clearGoalWorkState ? { clearGoalWorkState: opts.clearGoalWorkState } : {}),
            ...(opts.recordGoalSetIntent ? { recordGoalSetIntent: opts.recordGoalSetIntent } : {}),
          }),
        );
        unregisterGoalRuntimeControl = typeof unregister === 'function' ? unregister : null;
      }
      const initialGoalObjective = opts.initialGoalObjective?.trim();
      if (initialGoalObjective) {
        // H4-CLI: a failed initial `/goal` injection must be SURFACED as a structured
        // runtime issue (the same seam prompt-injection failures use), not silently
        // swallowed. The goal_status attachment remains the source of truth, so a
        // failed inject never seeds a decorative goal — it just means Claude did not
        // start pursuing the requested objective, which the user must be told.
        void injectGoalCommand(buildClaudeGoalCommand({ type: 'set', objective: initialGoalObjective }))
          .catch(async (error) => {
            logger.debug('[unified]: failed to inject initial Claude goal', error);
            try {
              await opts.onTerminalInjectionFailure?.(error);
            } catch (surfaceError) {
              logger.debug('[unified]: failed to surface initial Claude goal injection failure (non-fatal)', surfaceError);
            }
          });
      }
      const recentAcceptedTranscriptCandidates: unknown[] = [];
      const rememberAcceptedTranscriptCandidates = (messages: readonly unknown[]): void => {
        for (const message of messages) {
          if (!isAcceptedPromptTranscriptCandidate(message)) continue;
          recentAcceptedTranscriptCandidates.push(message);
          while (recentAcceptedTranscriptCandidates.length > MAX_RECENT_ACCEPTED_TRANSCRIPT_CANDIDATES) {
            recentAcceptedTranscriptCandidates.shift();
          }
        }
      };
      let acceptedTranscriptConfirmationTail = Promise.resolve();
      const pendingAcceptedTranscriptMatchKeys = new Set<string>();
      const buildAcceptedTranscriptMatchKey = (match: Readonly<{
        acceptedPromptId: string;
        transcriptKey?: string | null | undefined;
      }>): string => `${match.acceptedPromptId}:${match.transcriptKey ?? 'unkeyed'}`;
      let confirmPromptAcceptedFromTranscript = (
        messages: readonly unknown[],
        confirmOpts?: Readonly<{ rememberUnmatched?: boolean | undefined }> | undefined,
      ): boolean => {
        if (confirmOpts?.rememberUnmatched !== false) {
          rememberAcceptedTranscriptCandidates(messages);
        }
        return false;
      };
      const replayRecentAcceptedTranscriptCandidates = (): boolean => (
        recentAcceptedTranscriptCandidates.length > 0
        && confirmPromptAcceptedFromTranscript([...recentAcceptedTranscriptCandidates], { rememberUnmatched: false })
      );
      const promptAcceptanceCorrelationRecordedBatches = new WeakSet<object>();
      const recordPromptAcceptanceCorrelation = (
        batch: ClaudeUnifiedPromptBatch<Mode>,
        acceptedAtMs?: number | undefined,
      ): void => {
        if (promptAcceptanceCorrelationRecordedBatches.has(batch)) return;
        promptAcceptanceCorrelationRecordedBatches.add(batch);
        acceptedPromptTranscriptDiscovery.recordAcceptedPrompt({
          message: batch.message,
          ...(acceptedAtMs === undefined ? {} : { acceptedAtMs }),
          deliveryIdentity: {
            localIds: batch.userMessageLocalIds ?? [],
            userMessageSeq: batch.maxUserMessageSeq ?? null,
          },
          // Canonical Pending settlement creates (or reuses) the durable user transcript row.
          // Claude's later JSONL user echo is provider evidence for that same input, never a
          // second user message. Keep non-Pending terminal input visible by relying on the
          // discovery owner's durable delivery-identity requirement.
          suppressTranscriptEcho: true,
        });
        replayRecentAcceptedTranscriptCandidates();
      };
      confirmPromptAcceptedFromTranscript = (
        messages: readonly unknown[],
        confirmOpts?: Readonly<{ rememberUnmatched?: boolean | undefined }> | undefined,
      ): boolean => {
        const match = acceptedPromptTranscriptDiscovery.findMatchingTranscript(messages);
        if (!match) {
          if (confirmOpts?.rememberUnmatched !== false) {
            rememberAcceptedTranscriptCandidates(messages);
          }
          return false;
        }
        acceptedPromptTranscriptDiscovery.reserveAcceptedPromptTranscriptEcho(match);
        try {
          assertClaudeUnifiedHookActivationBeforeTranscriptFallback({
            hookPluginDir: opts.hookPluginDir,
            hookSubscriptionConfigured: Boolean(opts.subscribeClaudeSessionHooks),
            trustedHookActivationObserved,
          });
        } catch (error) {
          fatalRuntimeError ??= error;
          runtimeAbortController.abort(error);
          return false;
        }
        const matchKey = buildAcceptedTranscriptMatchKey(match);
        if (pendingAcceptedTranscriptMatchKeys.has(matchKey)) return true;
        pendingAcceptedTranscriptMatchKeys.add(matchKey);
        observeTrustedProviderProgress();
        acceptedTranscriptConfirmationTail = acceptedTranscriptConfirmationTail
          .catch(() => undefined)
          .then(async () => {
            try {
              const confirmed = await arbiter.confirmPromptAcceptedByProviderIf((batch) => (
                doesClaudeUnifiedPromptBatchMatchAcceptedTranscript({ batch, match })
              ));
              if (confirmed) {
                acceptedPromptTranscriptDiscovery.consumeAcceptedPromptMatch(match);
              }
            } finally {
              pendingAcceptedTranscriptMatchKeys.delete(matchKey);
            }
          });
        void acceptedTranscriptConfirmationTail.catch(() => undefined);
        return true;
      };
      const confirmCompactBoundaryPromptAcceptedFromTranscript = (message: RawJSONLines): boolean => {
        if (!isCompactBoundaryTranscriptMessage(message)) return false;
        void arbiter.confirmPromptAcceptedByProviderIf((batch) => isCompactSlashCommandPrompt(batch.message)).catch(() => undefined);
        return true;
      };
      const pendingQueuePump = createClaudeUnifiedPendingQueuePump<Mode>({
        inputConsumer,
        arbiter,
        // A batch pulled during the death/dispose unwind must be returned to the
        // owner's queue, never silently dropped into a dead session.
        onUndeliverableBatch: (batch) => {
          opts.returnUnconsumedMessage?.({
            message: batch.message,
            mode: batch.mode,
            maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
            userMessageLocalIds: batch.userMessageLocalIds ?? [],
            ...(batch.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
            ...(batch.pendingProviderAction ? { pendingProviderAction: batch.pendingProviderAction } : {}),
          });
        },
        onProviderAcceptancePendingPrompt: (batch) => {
          ownComposerTextLog.record(batch.message);
          ownComposerTextLog.recordPossiblePartialResidue(batch.message, {
            minPrefixChars: PROVIDER_ACCEPTANCE_PENDING_PREFIX_RESIDUE_MIN_CHARS,
          });
        },
      });
      const observeMetadataApplySafeBoundary = async (): Promise<void> => {
        await observeSafeRuntimeBoundaryForMetadataApply?.();
      };
      lifecycleBridge = activeHookSubscription.subscribe
        ? createClaudeUnifiedHookLifecycleBridge({
            subscribeClaudeSessionHooks: activeHookSubscription.subscribe,
            arbiter,
            completionQuiescenceMs:
              opts.lifecycleCompletionQuiescenceMs ?? configuration.claudeLocalTurnCompletionQuiescenceMs,
            onThinkingChange: opts.onThinkingChange,
            onReady: async () => {
              await observeMetadataApplySafeBoundary();
              await opts.onReady?.();
            },
            onUsageLimitDetails: opts.onUsageLimitDetails,
            onRuntimeAuthFailureEvent: opts.onRuntimeAuthFailureEvent,
            onProviderPromptStarted: opts.onProviderPromptStarted,
            onProviderPromptSubmitMetadata: runtimeControlBridge
              ? (metadata) => runtimeControlBridge?.reconcileFromPromptSubmitMetadata(metadata)
              : undefined,
            onProviderSessionStarted: observeProviderSessionStarted,
            onAcceptedPromptSubmitEvidence: ({ batch, promptId, sessionId }) => {
              acceptedPromptTranscriptDiscovery.recordAcceptedPromptHookEcho({
                deliveryIdentity: {
                  localIds: batch.userMessageLocalIds ?? [],
                  userMessageSeq: batch.maxUserMessageSeq ?? null,
                },
                promptId,
                sessionId,
              });
            },
            onTrustedHookActivation: observeTrustedHookActivation,
            onTrustedProviderProgress: observeTrustedProviderProgress,
            onMainSessionScreenMayHaveChanged: observePossibleDialogScreenChange,
            onPromptTurnTerminal: async (event) => {
              await observeMetadataApplySafeBoundary();
              await opts.onPromptTurnTerminal?.(event);
            },
            ...(dialogChoiceScreenProbe
              ? {
                  turnStallScreenProbe: {
                    quietMs: opts.dialogTurnStallScreenProbeQuietMs
                      ?? DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_QUIET_MS,
                    maxAttempts: opts.dialogTurnStallScreenProbeMaxAttempts
                      ?? DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_MAX_ATTEMPTS,
                    onStalled: async () => {
                      await dialogChoiceScreenProbe?.probe();
                    },
                    onStarvation: () => {
                      // Mid-turn stall budget exhausted with the turn still active (e.g. an API-retry
                      // loop that never reaches turn-terminal, incident cmr3dpuka). Make one FINAL
                      // user-visible probe so a dialog stuck on the mid-turn screen — the Fable
                      // safeguard chooser — is still published through the dialog-choice broker, and
                      // emit a one-shot escalation so the residual stuck-turn is observable instead of
                      // a silent "computing…". This is the mid-turn analog of the turn-end tail's
                      // one-shot starvation — ONE escalation discipline, never silent.
                      void dialogChoiceScreenProbe?.probe().catch(() => undefined);
                      const quietMs = opts.dialogTurnStallScreenProbeQuietMs
                        ?? DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_QUIET_MS;
                      const attempts = opts.dialogTurnStallScreenProbeMaxAttempts
                        ?? DEFAULT_DIALOG_TURN_STALL_SCREEN_PROBE_MAX_ATTEMPTS;
                      emitClaudeUnifiedDialogTurnStallStarvation(telemetry, {
                        attempts,
                        windowMs: Math.max(0, quietMs) * Math.max(0, attempts),
                      });
                      logger.warn('[unified]: mid-turn stall dialog probe budget exhausted with the turn still active', {
                        attempts,
                      });
                    },
                  },
                  turnEndScreenProbe: {
                    delaysMs: opts.dialogTurnEndScreenProbeDelaysMs
                      ?? DEFAULT_DIALOG_TURN_END_SCREEN_PROBE_DELAYS_MS,
                    onProbe: async () => {
                      const result = await dialogChoiceScreenProbe?.probe();
                      // A screen with no dialog, an owner answering, or a published/pending surface is
                      // resolved (stop the tail). A capture failure or a still-hidden dialog keeps the
                      // bounded re-arm going and, at exhaustion, escalates once.
                      switch (result?.kind) {
                        case 'not_visible':
                        case 'owned':
                        case 'request_published':
                        case 'already_pending':
                        case 'automatic_answer_started':
                          return 'resolved';
                        default:
                          return 'pending';
                      }
                    },
                    onStarvation: () => {
                      const delays = opts.dialogTurnEndScreenProbeDelaysMs
                        ?? DEFAULT_DIALOG_TURN_END_SCREEN_PROBE_DELAYS_MS;
                      emitClaudeUnifiedDialogTurnEndIdleStarvation(telemetry, {
                        shots: delays.length,
                        windowMs: delays.length > 0 ? delays[delays.length - 1] ?? 0 : 0,
                      });
                      logger.warn('[unified]: turn-end idle dialog re-arm exhausted with a dialog still unresolved', {
                        shots: delays.length,
                      });
                    },
                  },
                }
              : {}),
            runtimeActivityAdapter: opts.runtimeActivityAdapter ?? null,
            providerActivityLedger: opts.providerActivityLedger,
            onSessionEnd: (event) => {
              if (isClaudePromptInputExit(event)) {
                expectedPromptInputExit = true;
              }
            },
          })
        : undefined;
      const forwardVisibleTranscriptMessage = async (
        message: RawJSONLines,
        handler: ((message: RawJSONLines) => void | Promise<void>) | undefined,
      ): Promise<void> => {
        if (acceptedPromptTranscriptDiscovery.consumeAcceptedPromptTranscriptEcho(message)) {
          opts.onTranscriptMessageSuppressed?.(message);
          return;
        }
        await handler?.(message);
      };
      const transcriptBridge = opts.runtimeActivityAdapter || opts.onMessage || opts.onHistoricalMessage || opts.onSessionFound || lifecycleBridge
        ? createClaudeUnifiedTranscriptBridge({
            sessionId: opts.sessionId ?? null,
            transcriptPath: opts.transcriptPath,
            workingDirectory: opts.path,
            claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
            onMessage: opts.onMessage
              ? (message) => forwardVisibleTranscriptMessage(message, opts.onMessage)
              : undefined,
            onHistoricalMessage: opts.onHistoricalMessage || opts.onMessage
              ? (message) => forwardVisibleTranscriptMessage(
                  message,
                  opts.onHistoricalMessage ?? opts.onMessage,
                )
              : undefined,
            onTranscriptMessage: (message) => {
              if (!confirmPromptAcceptedFromTranscript([message])) {
                confirmCompactBoundaryPromptAcceptedFromTranscript(message);
              }
              lifecycleBridge?.observeTranscript(message);
            },
            onLiveProviderTaskJsonlValue: ({ sessionId, value }) => {
              lifecycleBridge?.observeLiveProviderActivityRow(value, sessionId);
            },
            onLiveProviderTaskObservationLost: ({ reason }) => {
              lifecycleBridge?.handleProviderActivityObservationLoss(reason);
            },
            onRawTranscriptValue: (value, observation) => {
              acceptedPromptTranscriptDiscovery.observeControlCommandTranscript(value);
              // Native Claude `/goal` source (plan H7): the goal_status attachment +
              // system/init slash_commands survive only on this raw channel (the
              // scanner drops them before `onMessage`). Forward to the launcher so it
              // feeds the centralized goal source; never reaches the visible transcript.
              opts.onRawTranscriptValue?.(value, observation);
            },
            proveAcceptedMainTranscript: (value) => confirmPromptAcceptedFromTranscript([value]),
            onSubagentFileCollectorChanged: opts.onSubagentFileCollectorChanged,
            onSessionFound: opts.onSessionFound,
            validateSessionStart: (sessionInfo) => {
              if (
                !explicitResumeIdentityRequired
                || !expectedProviderResumeSessionId
                || explicitResumeIdentityEstablished
              ) return true;
              if (
                sessionInfo.source === 'resume'
                && sessionInfo.sessionId === expectedProviderResumeSessionId
              ) {
                explicitResumeIdentityEstablished = true;
                return true;
              }
              const error = new ClaudeUnifiedResumeIdentityMismatchError(
                expectedProviderResumeSessionId,
                sessionInfo.sessionId,
                sessionInfo.source,
              );
              fatalRuntimeError ??= error;
              runtimeAbortController.abort(error);
              return false;
            },
            loadCommittedClaudeJsonlMessageBaseline: opts.loadCommittedClaudeJsonlMessageBaseline,
            transcriptMissingWarningMs: configuration.claudeTranscriptMissingWarningMs,
            subscribeClaudeSessionHooks: activeHookSubscription.subscribe,
            classifyDiscoveredSession: ({ messages }) => (
              confirmPromptAcceptedFromTranscript(messages) ? 'main' : null
            ),
          })
        : undefined;
      return createClaudeUnifiedController({
        host: {
          evaluateLiveness: () => hostResolution.adapter.evaluateLiveness(activeHandle),
          preserve: () => preserveActiveTerminalHost('controller_failure'),
        },
        pendingQueuePump,
        arbiter,
        onFatalError: (error) => {
          fatalRuntimeError ??= error;
          runtimeAbortController.abort(error);
        },
        onDisposeError: (error) => {
          logger.debug('[unified]: failed to dispose Claude unified controller dependency (non-fatal)', error);
        },
        initialLivenessTimeoutMs:
          opts.initialHostLivenessTimeoutMs ??
          Math.min(configuration.claudeUnifiedTerminalStartupReadinessTimeoutMs, 1_000),
        initialLivenessPollMs:
          opts.initialHostLivenessPollMs ??
          Math.min(configuration.claudeUnifiedTerminalStartupReadinessPollMs, 50),
        observerBridge: createCompositeBridge(
          [lifecycleBridge, transcriptBridge],
          async () => {
            opts.onWorkflowActivityObserverReady?.();
            await opts.runtimeActivityAdapter?.activateObservation(
              'claude-unified-provider-observer-installed',
            );
          },
        ),
        transcriptBridge: createCompositeBridge([
          createClaudeUnifiedTerminalReadinessBridge({
            hostAdapter: hostResolution.adapter,
            handle: activeHandle,
            arbiter,
            pollIntervalMs: configuration.claudeUnifiedTerminalStartupReadinessPollMs,
            timeoutMs: configuration.claudeUnifiedTerminalStartupReadinessTimeoutMs,
            extendedTimeoutMs: configuration.claudeUnifiedTerminalStartupReadinessExtendedTimeoutMs,
            progressGraceMs: configuration.claudeUnifiedTerminalStartupReadinessProgressGraceMs,
            onStartupReady: () => {
              observeStartupReadyForInjection();
              void opts.onStartupReady?.();
              endStartupHostLivenessGrace();
            },
            hasTrustedProviderProgress: () => trustedProviderProgressObserved,
            // SessionStart proves the host process is ALIVE (D17). It does not prove the interactive
            // composer is ready, so it extends the startup window instead of standing it down — a
            // slow-but-alive fresh session must not be killed before injection.
            hasHostAliveEvidence: () => providerSessionStartedObserved,
            canReportStartupReady: () => (
              (!explicitResumeIdentityRequired || explicitResumeIdentityEstablished)
              && (
                allowEmptyStartupInputBeforeSessionStart
                || allowReadinessBeforeSessionStart
                || !opts.subscribeClaudeSessionHooks
                || Boolean(opts.sessionId || opts.transcriptPath)
                || providerSessionStartedObserved
              )
            ),
            resolveStartupDialog,
            onScreenObserved: observeTerminalScreen,
            emitOutputReadiness: true,
          }),
          createClaudeUnifiedHostLivenessBridge({
            hostAdapter: hostResolution.adapter,
            handle: activeHandle,
            telemetry,
            pollIntervalMs: configuration.claudeUnifiedTerminalHostLivenessPollMs,
            probeFailureConfirmDeadMs: opts.hostLivenessProbeFailureConfirmDeadMs,
            onProbeFailureStarvation: opts.onHostLivenessProbeFailureStarvation,
            startupGraceMs: configuration.claudeUnifiedTerminalStartupReadinessTimeoutMs,
            startupGraceActive: () => startupHostLivenessGraceActive,
            isExpectedHostExit: (liveness) => expectedPromptInputExit && isCleanTerminalExit(liveness),
            onHostExited: () => {
              if (!runtimeAbortController.signal.aborted) {
                runtimeAbortController.abort('claude-unified-terminal-graceful-exit');
              }
            },
            onHostDead: (error) => {
              void publishHostDeadHealth(activeHandle, error.liveness);
              fatalRuntimeError ??= error;
              runtimeAbortController.abort(error);
            },
          }),
        ]),
      });
    })());

    try {
      await controller.run();
    } catch (error) {
      if (error instanceof ClaudeUnifiedTerminalHostDeadError) {
        await publishHostDeadHealth(activeHandle, error.liveness);
        emitClaudeUnifiedHostDead(telemetry, {
          hostKind: activeHandle.kind,
          sessionName: activeHandle.sessionName,
          paneId: activeHandle.paneId,
          liveness: error.liveness,
        });
      }
      throw error;
    }
    if (terminalAttachment) {
      const happySessionId = typeof opts.happySessionId === 'string' ? opts.happySessionId.trim() : '';
      if (happySessionId) {
        await (opts.clearSessionMarkerTerminalHostHealth ?? clearSessionMarkerTerminalHostHealth)({
          pid: process.pid,
          sessionId: happySessionId,
        }).catch((error) => {
          logger.debug('[unified]: failed to clear recovered terminal host health marker', error);
        });
      }
      await opts.onTerminalHostReady?.({
        handle: activeHandle,
        terminal: terminalAttachment,
        destroyOwnedHostForExplicitStop,
      });
    }
    const waitSignals = [runtimeAbortController.signal, processSignalAbortController.signal];
    if (opts.signal) {
      waitSignals.push(opts.signal);
    }
    await waitForAnyAbort(waitSignals);
    if (fatalRuntimeError) {
      throw fatalRuntimeError;
    }
  } finally {
    arbiterForResumeSummaryCompaction = null;
    if (turnInterruptRegistered) {
      opts.setTurnInterrupt?.(null);
    }
    removeProcessSignalCleanup?.();
    unregisterStatuslineRuntimeReconciler?.();
    unregisterMetadataRuntimeModeApplier?.();
    unregisterTerminalComposerClearRuntimeControl?.();
    unregisterConnectedServiceExactApplicationHandler?.();
    unregisterPendingInputInterruptAndRunRuntimeControl?.();
    opts.onPendingInputInterruptAndRunLocalIdChange?.(null);
    unregisterGoalRuntimeControl?.();
    unregisterInFlightSteerAvailabilityRefresh?.();
    unregisterInFlightSteerAvailabilityRefresh = null;
    notifyTerminalComposerCleared = null;
    terminalComposerClearedWakePending = false;
    if (runtimeControlBridge) {
      await runtimeControlBridge.dispose().catch((error) => {
        logger.debug('[unified]: failed to dispose Claude unified runtime-control bridge (non-fatal)', error);
      });
    }
    dialogChoiceScreenProbe?.dispose();
    dialogChoiceScreenProbe = null;
    inFlightSteerWiring?.dispose();
    if (controller) {
      await controller.dispose();
    } else {
      await preserveActiveTerminalHost('wrapper_exit');
    }
    activeHookSubscription.dispose();
  }
}
