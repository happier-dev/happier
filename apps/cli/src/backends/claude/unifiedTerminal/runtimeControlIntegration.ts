import type {
  RuntimeConfigOutcomeChangeKeyV1,
  RuntimeConfigOutcomeStatusV1,
  RuntimeConfigOutcomeTimingV1,
} from '@happier-dev/protocol';

import type { InFlightConfigApplyOutcome } from '@/agent/runtime/permission/bindPermissionModeQueue';
import {
  resolveClaudeEffectiveEffortForModel,
  resolveClaudeUltracodeForModel,
  resolveModeEffortLevelsForModel,
} from '@/backends/claude/utils/claudeEffort';

import type { EnhancedMode } from '../loop';
import { controlResultToChangeOutcome } from './tuiControls/outcome';
import type {
  ClaudeDesiredRuntimeConfig,
  ClaudePromptSubmitMetadata,
  ClaudeStatuslineRuntimeMetadata,
  ClaudeUnifiedTuiControlController,
  RuntimeConfigApplyOutcome,
  RuntimeConfigChangeOutcome,
  RuntimeConfigOutcomeScalar,
} from './tuiControls';
import type { ClaudeUnifiedDialogId } from './tuiControls/dialogRegistry';

/**
 * Lane E runtime-control integration bridge.
 *
 * Connects the durable session desired-state (carried on the queued message {@link EnhancedMode}) to the
 * Claude Unified TUI runtime-control controller (Lane D). Responsibilities:
 *
 * - Map `EnhancedMode` → {@link ClaudeDesiredRuntimeConfig} (the same generic model/effort/permission/plan
 *   desired-state the ACP runtimes consume, here projected onto verified TUI controls).
 * - Only send the DELTA versus the last desired config that proceeded so a control is not re-applied on
 *   every prompt (the spawn already baked the startup config in; subsequent prompts apply only changes).
 * - Run `applyDesiredRuntimeConfig({ reason: 'before_prompt' })` and await the control lock to drain before
 *   the dependent prompt is injected. When `promptMayProceed === false`, the caller MUST NOT inject.
 * - Map controller change outcomes onto protocol `runtime-config-outcome` transcript events, grouped by the
 *   per-change public status so each emitted event's status is accurate. The `sessionMode` change key is
 *   gated behind {@link ClaudeUnifiedRuntimeControlBridgeParams.sessionModeEmissionEnabled} until UI/dev
 *   consumers ship the widened enum (Lane B version-skew note); until then plan-mode outcomes ride the
 *   legacy `permissionMode` key.
 */

export type ClaudeUnifiedRuntimeConfigOutcomeChange = Readonly<{
  key: RuntimeConfigOutcomeChangeKeyV1;
  requested?: RuntimeConfigOutcomeScalar | undefined;
  previous?: RuntimeConfigOutcomeScalar | undefined;
  effective?: RuntimeConfigOutcomeScalar | undefined;
  reason?: string | undefined;
}>;

export type ClaudeUnifiedRuntimeConfigOutcomeEvent = Readonly<{
  status: RuntimeConfigOutcomeStatusV1;
  timing?: RuntimeConfigOutcomeTimingV1 | undefined;
  message: string;
  changes: readonly ClaudeUnifiedRuntimeConfigOutcomeChange[];
}>;

export type ClaudeUnifiedRuntimeControlApplyResult = Readonly<{
  /** False when a required control could not be made effective; the caller MUST NOT inject the prompt. */
  promptMayProceed: boolean;
  /** True when at least one control was attempted (i.e. the desired config differed from the baseline). */
  attempted: boolean;
  /** Low-level unsafe-window/control reason that blocked a dependent prompt, when known. */
  blockedReason?: string | undefined;
}>;

export type ClaudeUnifiedRuntimeConfigOutcomeSessionEvent = Readonly<{
  type: 'runtime-config-outcome';
  provider: 'claude';
  runtime: 'claude-unified-terminal';
  status: RuntimeConfigOutcomeStatusV1;
  timing?: RuntimeConfigOutcomeTimingV1;
  reason?: string;
  message: string;
  changes: ClaudeUnifiedRuntimeConfigOutcomeChange[];
}>;

/**
 * Single owner for the `runtime-config-outcome` session-event payload shape. Every Claude Unified
 * emission site (standalone launcher, remote launcher controller bridge, remote launch-option
 * restart/unsupported notices) must build the event here so the protocol payload cannot drift
 * between launchers.
 */
export function buildClaudeUnifiedRuntimeConfigOutcomeSessionEvent(event: Readonly<{
  status: RuntimeConfigOutcomeStatusV1;
  timing?: RuntimeConfigOutcomeTimingV1 | undefined;
  reason?: string | undefined;
  message: string;
  changes: readonly ClaudeUnifiedRuntimeConfigOutcomeChange[];
}>): ClaudeUnifiedRuntimeConfigOutcomeSessionEvent {
  return {
    type: 'runtime-config-outcome',
    provider: 'claude',
    runtime: 'claude-unified-terminal',
    status: event.status,
    ...(event.timing ? { timing: event.timing } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    message: event.message,
    changes: [...event.changes],
  };
}

const STUCK_UNSAFE_WINDOW_REASON_PREFIX = 'stuck_unsafe_window:';

export function isClaudeUnifiedRuntimeControlUserDraftBlocker(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string') return false;
  const trimmed = reason.trim();
  if (trimmed === 'user_draft') return true;
  if (!trimmed.startsWith(STUCK_UNSAFE_WINDOW_REASON_PREFIX)) return false;
  return trimmed.slice(STUCK_UNSAFE_WINDOW_REASON_PREFIX.length).trim() === 'user_draft';
}

export type ClaudeUnifiedRuntimeControlBridge = Readonly<{
  applyBeforePrompt(mode: EnhancedMode): Promise<ClaudeUnifiedRuntimeControlApplyResult>;
  /**
   * Apply a metadata-only runtime config change without coupling it to prompt injection.
   * Used for UI "immediate" permission picker changes that publish metadata but do not send text.
   */
  applyOutOfBand(mode: EnhancedMode): Promise<ClaudeUnifiedRuntimeControlApplyResult>;
  /**
   * Lane Q: apply a steered message's PERMISSION/PLAN MODE delta to the RUNNING turn (probe Q-A
   * steer-safe generating window) so the message can steer instead of deferring to turn end.
   * Returns `unsupported` when the delta also carries next-idle controls (model/effort/ultracode) —
   * those messages keep the deferred path so the text never runs under the wrong model/effort.
   */
  applyPermissionModeForInFlightSteer(mode: EnhancedMode): Promise<InFlightConfigApplyOutcome>;
  reconcileFromPromptSubmitMetadata(metadata: ClaudePromptSubmitMetadata): void;
  /**
   * Lane Y: fold statusline-reported EFFECTIVE model/effort into the controller's lastVerified.
   * Effective-truth feed only — never writes desired-state surfaces and never types into the TUI;
   * a matching desired change then converges as `skipped_already_effective` (zero TUI bytes).
   */
  reconcileFromStatusline(metadata: ClaudeStatuslineRuntimeMetadata): void;
  isControlInFlight(): boolean;
  ownsDialog(dialogId: ClaudeUnifiedDialogId): boolean;
  whenControlIdle(): Promise<void>;
  dispose(): Promise<void>;
}>;

export type ClaudeUnifiedRuntimeControlBridgeParams = Readonly<{
  controller: ClaudeUnifiedTuiControlController;
  emitRuntimeConfigOutcome: (event: ClaudeUnifiedRuntimeConfigOutcomeEvent) => void;
  /**
   * When false (default), `sessionMode` change-key emission is downgraded to the legacy `permissionMode`
   * key so old clients (which reject the widened change-key enum) still receive plan-mode outcomes.
   */
  sessionModeEmissionEnabled?: boolean | undefined;
  /**
   * Desired config the session was SPAWNED with. The first prompt must not re-apply launch-baked settings,
   * so the baseline starts here and only later deltas are sent to the controller.
   */
  startupMode?: EnhancedMode | undefined;
}>;

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function mapEnhancedModeToDesiredRuntimeConfig(mode: EnhancedMode): ClaudeDesiredRuntimeConfig {
  const desired: {
    model?: string;
    reasoningEffort?: string;
    permissionMode?: string;
    agentModeId?: string | null;
    maxThinkingTokens?: number;
    ultracode?: boolean;
  } = {};
  const model = normalizeNonEmptyString(mode.model);
  if (model !== undefined) desired.model = model;
  const reasoningEffort = resolveClaudeEffectiveEffortForModel({
    modelId: mode.model,
    effort: mode.reasoningEffort,
    supportedLevels: resolveModeEffortLevelsForModel(mode, mode.model),
  });
  if (reasoningEffort !== null) desired.reasoningEffort = reasoningEffort;
  if (typeof mode.permissionMode === 'string') desired.permissionMode = mode.permissionMode;
  if (mode.agentModeId !== undefined) desired.agentModeId = mode.agentModeId ?? null;
  if (typeof mode.claudeRemoteMaxThinkingTokens === 'number') {
    desired.maxThinkingTokens = mode.claudeRemoteMaxThinkingTokens;
  }
  if (typeof mode.ultracode === 'boolean') {
    // Capability-gate here so the controller never types `/effort ultracode` at a model
    // that does not offer it (conservative: an unhonorable request resolves to off).
    desired.ultracode = resolveClaudeUltracodeForModel({
        modelId: mode.model,
        ultracode: mode.ultracode,
        supportedLevels: resolveModeEffortLevelsForModel(mode, mode.model),
    });
  }
  return desired;
}

function sameAgentModeId(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Compute the controls that changed versus the committed baseline. Mode (permission + plan) is compared
 * jointly because the controller cycles them through a single verified mode control.
 */
function computeDesiredDelta(
  desired: ClaudeDesiredRuntimeConfig,
  baseline: ClaudeDesiredRuntimeConfig,
): ClaudeDesiredRuntimeConfig {
  const delta: {
    model?: string;
    reasoningEffort?: string;
    permissionMode?: string;
    agentModeId?: string | null;
    maxThinkingTokens?: number;
    ultracode?: boolean;
  } = {};
  if (desired.model !== baseline.model && desired.model !== undefined) delta.model = desired.model;
  if (desired.reasoningEffort !== baseline.reasoningEffort && desired.reasoningEffort !== undefined) {
    delta.reasoningEffort = desired.reasoningEffort;
  }
  if (desired.ultracode !== baseline.ultracode && desired.ultracode !== undefined) {
    delta.ultracode = desired.ultracode;
  }
  const modeChanged =
    desired.permissionMode !== baseline.permissionMode
    || !sameAgentModeId(desired.agentModeId, baseline.agentModeId);
  if (modeChanged) {
    if (desired.permissionMode !== undefined) delta.permissionMode = desired.permissionMode;
    if (desired.agentModeId !== undefined) delta.agentModeId = desired.agentModeId;
  }
  if (desired.maxThinkingTokens !== baseline.maxThinkingTokens && desired.maxThinkingTokens !== undefined) {
    delta.maxThinkingTokens = desired.maxThinkingTokens;
  }
  return delta;
}

function isEmptyDesired(desired: ClaudeDesiredRuntimeConfig): boolean {
  return (
    desired.model === undefined
    && desired.reasoningEffort === undefined
    && desired.permissionMode === undefined
    && (desired.agentModeId === undefined || desired.agentModeId === null)
    && desired.maxThinkingTokens === undefined
    && desired.ultracode === undefined
  );
}

function pickDependentRuntimeConfigDelta(delta: ClaudeDesiredRuntimeConfig): ClaudeDesiredRuntimeConfig {
  const dependent: {
    permissionMode?: string;
    agentModeId?: string | null;
  } = {};
  if (delta.permissionMode !== undefined) dependent.permissionMode = delta.permissionMode;
  if (delta.agentModeId !== undefined) dependent.agentModeId = delta.agentModeId;
  return dependent;
}

function pickAmbientRuntimeConfigDelta(delta: ClaudeDesiredRuntimeConfig): ClaudeDesiredRuntimeConfig {
  const ambient: {
    model?: string;
    reasoningEffort?: string;
    maxThinkingTokens?: number;
    ultracode?: boolean;
  } = {};
  if (delta.model !== undefined) ambient.model = delta.model;
  if (delta.reasoningEffort !== undefined) ambient.reasoningEffort = delta.reasoningEffort;
  if (delta.ultracode !== undefined) ambient.ultracode = delta.ultracode;
  if (delta.maxThinkingTokens !== undefined) ambient.maxThinkingTokens = delta.maxThinkingTokens;
  return ambient;
}

function commitRuntimeConfigDelta(
  committed: ClaudeDesiredRuntimeConfig,
  desired: ClaudeDesiredRuntimeConfig,
  delta: ClaudeDesiredRuntimeConfig,
): ClaudeDesiredRuntimeConfig {
  return {
    ...committed,
    ...(delta.model !== undefined ? { model: desired.model } : {}),
    ...(delta.reasoningEffort !== undefined ? { reasoningEffort: desired.reasoningEffort } : {}),
    ...(delta.ultracode !== undefined ? { ultracode: desired.ultracode } : {}),
    ...(delta.maxThinkingTokens !== undefined ? { maxThinkingTokens: desired.maxThinkingTokens } : {}),
    ...(delta.permissionMode !== undefined ? { permissionMode: desired.permissionMode } : {}),
    ...(delta.agentModeId !== undefined ? { agentModeId: desired.agentModeId } : {}),
  };
}

function describeGroupEntry(change: ClaudeUnifiedRuntimeConfigOutcomeChange): string {
  const value = change.effective ?? change.requested;
  if (value === undefined || value === null || value === '') return change.key;
  return `${change.key} → ${String(value)}`;
}

function describeGroup(status: RuntimeConfigOutcomeStatusV1, changes: readonly ClaudeUnifiedRuntimeConfigOutcomeChange[]): string {
  const joined = changes.map(describeGroupEntry).join(', ');
  switch (status) {
    case 'applied':
      return `Applied Claude Unified runtime controls: ${joined}.`;
    case 'requires_restart':
      return `Claude Unified runtime changes require a session restart: ${joined}.`;
    case 'requires_interactive_control':
      return `Claude Unified runtime changes need interactive control: ${joined}.`;
    case 'unsupported':
      return `Claude Unified runtime changes are unsupported: ${joined}.`;
    case 'failed':
      return `Failed to apply Claude Unified runtime controls: ${joined}.`;
  }
}

function addChange(
  target: RuntimeConfigChangeOutcome[],
  change: RuntimeConfigChangeOutcome,
): void {
  target.push(change);
}

export function buildClaudeUnifiedRuntimeControlDisabledOutcomeEvents(params: Readonly<{
  mode: EnhancedMode;
  baselineMode?: EnhancedMode | undefined;
  sessionModeEmissionEnabled?: boolean | undefined;
}>): ClaudeUnifiedRuntimeConfigOutcomeEvent[] {
  const desired = mapEnhancedModeToDesiredRuntimeConfig(params.mode);
  const baseline = params.baselineMode ? mapEnhancedModeToDesiredRuntimeConfig(params.baselineMode) : {};
  const delta = computeDesiredDelta(desired, baseline);
  if (isEmptyDesired(delta)) return [];

  const changes: RuntimeConfigChangeOutcome[] = [];
  const restartResult = { kind: 'requires_restart', reason: 'tui_runtime_control_disabled' } as const;
  if (delta.model !== undefined) {
    addChange(changes, controlResultToChangeOutcome({ key: 'model', requested: delta.model, result: restartResult }));
  }
  if (delta.reasoningEffort !== undefined) {
    addChange(changes, controlResultToChangeOutcome({
      key: 'reasoningEffort',
      requested: delta.reasoningEffort,
      result: restartResult,
    }));
  }
  if (delta.ultracode !== undefined) {
    addChange(changes, controlResultToChangeOutcome({
      key: 'launchOption',
      requested: delta.ultracode,
      result: restartResult,
    }));
  }
  if (delta.permissionMode !== undefined || delta.agentModeId !== undefined) {
    const key: RuntimeConfigOutcomeChangeKeyV1 =
      params.sessionModeEmissionEnabled === true && delta.agentModeId === 'plan'
        ? 'sessionMode'
        : 'permissionMode';
    addChange(changes, controlResultToChangeOutcome({
      key,
      requested: key === 'sessionMode' ? 'plan' : (delta.permissionMode ?? null),
      result: restartResult,
    }));
  }
  if (delta.maxThinkingTokens !== undefined) {
    addChange(changes, controlResultToChangeOutcome({
      key: 'maxThinkingTokens',
      requested: delta.maxThinkingTokens,
      result: { kind: 'unsupported', reason: 'no_tui_control' },
    }));
  }

  const grouped = new Map<RuntimeConfigOutcomeStatusV1, ClaudeUnifiedRuntimeConfigOutcomeChange[]>();
  for (const change of changes) {
    const list = grouped.get(change.status) ?? [];
    list.push({
      key: change.key,
      ...(change.requested !== undefined ? { requested: change.requested } : {}),
      ...(change.previous !== undefined ? { previous: change.previous } : {}),
      ...(change.effective !== undefined ? { effective: change.effective } : {}),
      ...(change.reason !== undefined ? { reason: change.reason } : {}),
    });
    grouped.set(change.status, list);
  }

  return [...grouped].map(([status, groupedChanges]) => ({
    status,
    message: describeGroup(status, groupedChanges),
    changes: groupedChanges,
  }));
}

/** Upper bound for the blocked-apply injection retry delay (L5(a) bounded backoff). */
export const MAX_BLOCKED_APPLY_RETRY_MS = 15_000;

/**
 * Bounded exponential backoff for re-attempting a prompt injection whose before-prompt control
 * apply was blocked (L5(a), incident cmq8y3nlx: a fixed ~250ms retry hot-looped the apply path).
 */
export function resolveBlockedApplyRetryMs(
  consecutiveBlockedApplies: number,
  baseMs: number,
  maxMs: number = MAX_BLOCKED_APPLY_RETRY_MS,
): number {
  const attempt = Math.max(1, Math.trunc(consecutiveBlockedApplies));
  const base = Math.max(1, Math.trunc(baseMs));
  const cap = Math.max(base, Math.trunc(maxMs));
  return Math.min(cap, base * 2 ** Math.min(attempt - 1, 16));
}

/**
 * Consecutive blocked before-prompt applies before the single starvation escalation. With the
 * default 250ms base backoff (0.25/0.5/1/2/4/8s…) the 6th blocked apply lands ≈15s into the
 * episode — comparable to the in-flight steer evaluator's 4×~15s veto threshold in wall time.
 */
export const DEFAULT_BLOCKED_APPLY_STARVATION_THRESHOLD = 6;

export type BlockedApplyStarvationInfo = Readonly<{
  consecutiveBlockedApplies: number;
  blockedReason?: string | null;
  isCanonicalTurnActive?: boolean | undefined;
  userMessageLocalIds?: readonly string[] | undefined;
}>;

export type BlockedApplyStarvationTracker = Readonly<{
  /** Records one blocked apply; returns the consecutive count. Fires the callback ONCE per episode. */
  recordBlocked(
    blockedReason?: string | null,
    context?: Omit<BlockedApplyStarvationInfo, 'blockedReason' | 'consecutiveBlockedApplies'> | undefined,
  ): number;
  /** A successful (proceeding) apply ends the episode; the next starvation escalates again. */
  reset(): void;
}>;

/**
 * F2 (qa/QA-B.md, incident window 06:37–06:47): an IDLE queued prompt whose before-prompt control
 * apply stays blocked (`stuck_unsafe_window` — e.g. a composer draft or overlay) re-defers on the
 * bounded backoff forever but never tells the user WHY the message is not delivered. The outcome
 * events dedup to the first transition, so continued starvation was silent. This tracker mirrors
 * the in-flight steer evaluator's starvation honesty: ONE bounded escalation per episode (never a
 * notice loop), reset on the first apply that proceeds.
 */
export function createBlockedApplyStarvationTracker(opts: Readonly<{
  threshold?: number | undefined;
  onStarvation: (info: BlockedApplyStarvationInfo) => void;
}>): BlockedApplyStarvationTracker {
  const threshold = Math.max(1, Math.trunc(opts.threshold ?? DEFAULT_BLOCKED_APPLY_STARVATION_THRESHOLD));
  let consecutiveBlockedApplies = 0;
  let escalated = false;
  return {
    recordBlocked(
      blockedReason?: string | null,
      context?: Omit<BlockedApplyStarvationInfo, 'blockedReason' | 'consecutiveBlockedApplies'> | undefined,
    ): number {
      consecutiveBlockedApplies += 1;
      if (consecutiveBlockedApplies >= threshold && !escalated) {
        escalated = true;
        opts.onStarvation({
          ...context,
          consecutiveBlockedApplies,
          ...(blockedReason ? { blockedReason } : {}),
        });
      }
      return consecutiveBlockedApplies;
    },
    reset(): void {
      consecutiveBlockedApplies = 0;
      escalated = false;
    },
  };
}

export function createClaudeUnifiedRuntimeControlBridge(
  params: ClaudeUnifiedRuntimeControlBridgeParams,
): ClaudeUnifiedRuntimeControlBridge {
  const { controller, emitRuntimeConfigOutcome } = params;
  const sessionModeEmissionEnabled = params.sessionModeEmissionEnabled === true;
  // Baseline committed config: seeded from the spawn so launch-baked settings are not re-applied.
  let committed: ClaudeDesiredRuntimeConfig = params.startupMode
    ? mapEnhancedModeToDesiredRuntimeConfig(params.startupMode)
    : {};
  // F5 (qa/QA-B.md, live session cmqakh8mb): a NON-DEFAULT launch-claimed permission/plan mode is a
  // CLAIM, not a fact — `--permission-mode auto` is silently ignored by claude when `auto` is
  // model/account-gated, so blindly committing the claim made every later request for that mode a
  // no-op while the TUI actually ran in `default`, forever and silently. The claim is therefore
  // excluded from the committed baseline and verified through the controller on the first apply
  // (zero keystrokes + no transcript event when the screen confirms it; an honest repair otherwise).
  // A `default` claim keeps the zero-capture fast path: claude always boots into default without a flag.
  let pendingStartupModeClaim: Readonly<{
    permissionMode?: string | undefined;
    agentModeId?: string | null | undefined;
  }> | null = null;
  if (
    (committed.permissionMode !== undefined && committed.permissionMode !== 'default')
    || (committed.agentModeId !== undefined && committed.agentModeId !== null)
  ) {
    const { permissionMode, agentModeId, ...rest } = committed;
    pendingStartupModeClaim = { permissionMode, agentModeId };
    committed = rest;
  }
  // L5(b) outcome-event dedup: a re-attempted blocked apply yields the SAME per-change outcome
  // every few hundred milliseconds; only a transition may emit a new transcript event.
  const lastEmittedChangeSignatures = new Map<string, string>();

  function changeSignature(change: RuntimeConfigChangeOutcome): string {
    return [change.status, change.timing ?? '', change.reason ?? ''].join('|');
  }

  function emitOutcome(
    outcome: RuntimeConfigApplyOutcome,
    options?: Readonly<{ suppressSilentModeConfirmation?: boolean }>,
  ): void {
    // Drop changes whose (status,timing,reason) signature has not transitioned since last emission.
    const transitionedChanges = outcome.changes.filter((change) => {
      // F5: confirming the startup-claimed mode on-screen is bookkeeping, not user feedback.
      if (
        options?.suppressSilentModeConfirmation === true
        && (change.key === 'permissionMode' || change.key === 'sessionMode')
        && change.timing === 'skipped_already_effective'
      ) {
        return false;
      }
      const dedupKey = `${change.key}:${String(change.requested)}`;
      const signature = changeSignature(change);
      if (lastEmittedChangeSignatures.get(dedupKey) === signature) return false;
      lastEmittedChangeSignatures.set(dedupKey, signature);
      return true;
    });
    // Group changes by their per-change public status so each event's single status is accurate
    // (the protocol change shape carries only key/scalars, not per-change status). Mirrors the
    // existing launcher split of restart-only vs unsupported notices.
    const grouped = new Map<RuntimeConfigOutcomeStatusV1, RuntimeConfigChangeOutcome[]>();
    for (const change of transitionedChanges) {
      const list = grouped.get(change.status) ?? [];
      list.push(change);
      grouped.set(change.status, list);
    }
    for (const [status, changes] of grouped) {
      const timings = new Set(changes.map((c) => c.timing));
      const sharedTiming = timings.size === 1 ? changes[0].timing : undefined;
      const emittedChanges: ClaudeUnifiedRuntimeConfigOutcomeChange[] = changes.map((change) => {
        const key: RuntimeConfigOutcomeChangeKeyV1 =
          !sessionModeEmissionEnabled && change.key === 'sessionMode' ? 'permissionMode' : change.key;
        return {
          key,
          ...(change.requested !== undefined ? { requested: change.requested } : {}),
          ...(change.previous !== undefined ? { previous: change.previous } : {}),
          ...(change.effective !== undefined ? { effective: change.effective } : {}),
          ...(change.reason !== undefined ? { reason: change.reason } : {}),
        };
      });
      emitRuntimeConfigOutcome({
        status,
        ...(sharedTiming !== undefined ? { timing: sharedTiming } : {}),
        message: describeGroup(status, emittedChanges),
        changes: emittedChanges,
      });
    }
  }

  function resolveBlockedApplyReason(outcome: RuntimeConfigApplyOutcome): string | undefined {
    if (outcome.promptMayProceed) return undefined;
    const blockedChange = outcome.changes.find((change) =>
      change.status === 'failed'
      || change.status === 'requires_interactive_control'
      || change.timing === 'scheduled_for_next_prompt'
      || change.timing === 'queued_until_safe_window'
      || change.timing === 'next_idle'
    );
    const reason = blockedChange?.reason;
    if (typeof reason !== 'string') return undefined;
    const trimmed = reason.trim();
    if (trimmed.length === 0) return undefined;
    return isClaudeUnifiedRuntimeControlUserDraftBlocker(trimmed) ? 'user_draft' : trimmed;
  }

  async function applyDesiredMode(
    mode: EnhancedMode,
    reason: 'before_prompt' | 'out_of_band',
  ): Promise<ClaudeUnifiedRuntimeControlApplyResult> {
    const desired = mapEnhancedModeToDesiredRuntimeConfig(mode);
    const delta = computeDesiredDelta(desired, committed);
    if (isEmptyDesired(delta)) {
      return { promptMayProceed: true, attempted: false };
    }
    if (reason === 'before_prompt') {
      return await applyDesiredModeBeforePrompt(desired, delta);
    }
    // F5: the first apply whose desired mode equals the pending startup claim is a VERIFICATION
    // of the launch flag — a confirming already-effective result must stay silent.
    const verifyingStartupModeClaim =
      pendingStartupModeClaim !== null
      && desired.permissionMode === pendingStartupModeClaim.permissionMode
      && sameAgentModeId(desired.agentModeId, pendingStartupModeClaim.agentModeId);
    const outcome = await controller.applyDesiredRuntimeConfig({ desired: delta, reason });
    await controller.whenControlIdle();
    emitOutcome(outcome, { suppressSilentModeConfirmation: verifyingStartupModeClaim });
    if (outcome.promptMayProceed) {
      // Commit the full desired config as the new baseline so resolved controls (including non-blocking
      // unsupported / requires_restart notices) are not re-attempted/re-emitted on the next prompt.
      committed = desired;
      pendingStartupModeClaim = null;
    }
    const blockedReason = resolveBlockedApplyReason(outcome);
    return {
      promptMayProceed: outcome.promptMayProceed,
      attempted: true,
      ...(!outcome.promptMayProceed && blockedReason ? { blockedReason } : {}),
    };
  }

  async function applyRuntimeConfigDelta(params: Readonly<{
    delta: ClaudeDesiredRuntimeConfig;
    reason: 'before_prompt' | 'out_of_band';
    suppressSilentModeConfirmation?: boolean | undefined;
    includePending?: boolean | undefined;
  }>): Promise<RuntimeConfigApplyOutcome> {
    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: params.delta,
      reason: params.reason,
      ...(params.includePending !== undefined ? { includePending: params.includePending } : {}),
    });
    await controller.whenControlIdle();
    emitOutcome(outcome, {
      suppressSilentModeConfirmation: params.suppressSilentModeConfirmation === true,
    });
    return outcome;
  }

  async function applyDesiredModeBeforePrompt(
    desired: ClaudeDesiredRuntimeConfig,
    delta: ClaudeDesiredRuntimeConfig,
  ): Promise<ClaudeUnifiedRuntimeControlApplyResult> {
    const dependentDelta = pickDependentRuntimeConfigDelta(delta);
    const ambientDelta = pickAmbientRuntimeConfigDelta(delta);
    const verifyingStartupModeClaim =
      pendingStartupModeClaim !== null
      && desired.permissionMode === pendingStartupModeClaim.permissionMode
      && sameAgentModeId(desired.agentModeId, pendingStartupModeClaim.agentModeId);

    let dependentOutcome: RuntimeConfigApplyOutcome | null = null;
    if (!isEmptyDesired(dependentDelta)) {
      dependentOutcome = await applyRuntimeConfigDelta({
        delta: dependentDelta,
        reason: 'before_prompt',
        suppressSilentModeConfirmation: verifyingStartupModeClaim,
        includePending: false,
      });
      if (dependentOutcome.promptMayProceed) {
        committed = commitRuntimeConfigDelta(committed, desired, dependentDelta);
        pendingStartupModeClaim = null;
      }
    }

    if (!isEmptyDesired(ambientDelta)) {
      const ambientOutcome = await applyRuntimeConfigDelta({
        delta: ambientDelta,
        reason: 'out_of_band',
      });
      if (ambientOutcome.promptMayProceed) {
        committed = commitRuntimeConfigDelta(committed, desired, ambientDelta);
      }
    }

    if (dependentOutcome !== null && !dependentOutcome.promptMayProceed) {
      const blockedReason = resolveBlockedApplyReason(dependentOutcome);
      return {
        promptMayProceed: false,
        attempted: true,
        ...(blockedReason ? { blockedReason } : {}),
      };
    }
    return { promptMayProceed: true, attempted: true };
  }

  return {
    async applyBeforePrompt(mode: EnhancedMode): Promise<ClaudeUnifiedRuntimeControlApplyResult> {
      return await applyDesiredMode(mode, 'before_prompt');
    },
    async applyOutOfBand(mode: EnhancedMode): Promise<ClaudeUnifiedRuntimeControlApplyResult> {
      return await applyDesiredMode(mode, 'out_of_band');
    },
    async applyPermissionModeForInFlightSteer(mode: EnhancedMode): Promise<InFlightConfigApplyOutcome> {
      const desired = mapEnhancedModeToDesiredRuntimeConfig(mode);
      const delta = computeDesiredDelta(desired, committed);
      if (
        delta.model !== undefined
        || delta.reasoningEffort !== undefined
        || delta.ultracode !== undefined
        || delta.maxThinkingTokens !== undefined
      ) {
        // Model/effort/ultracode are next-idle controls (probe P-D): the steered text must not run
        // under the wrong config, so the whole message keeps the deferred path.
        return { status: 'unsupported', reason: 'non_mode_delta' };
      }
      const hasModeDelta = delta.permissionMode !== undefined
        || (delta.agentModeId !== undefined && delta.agentModeId !== null);
      if (!hasModeDelta && delta.agentModeId === undefined) {
        // Nothing to change versus the committed baseline (e.g. already applied by a prior steer).
        return { status: 'applied' };
      }
      const outcome = await controller.applyPermissionModeInFlight({
        permissionMode: delta.permissionMode,
        agentModeId: delta.agentModeId,
      });
      await controller.whenControlIdle();
      emitOutcome(outcome);
      if (outcome.status === 'applied' && outcome.promptMayProceed) {
        committed = {
          ...committed,
          permissionMode: desired.permissionMode,
          agentModeId: desired.agentModeId,
        };
        // A successfully applied in-flight mode supersedes any unverified startup claim (F5).
        pendingStartupModeClaim = null;
        return { status: 'applied' };
      }
      const detail = outcome.timing !== undefined ? `${outcome.status}:${outcome.timing}` : outcome.status;
      return { status: 'failed', reason: `in_flight_mode_apply_${detail}` };
    },
    reconcileFromPromptSubmitMetadata(metadata: ClaudePromptSubmitMetadata): void {
      controller.reconcileAfterProviderPromptSubmit(metadata);
    },
    reconcileFromStatusline(metadata: ClaudeStatuslineRuntimeMetadata): void {
      controller.reconcileFromStatusline(metadata);
    },
    isControlInFlight(): boolean {
      return controller.isControlInFlight();
    },
    ownsDialog(dialogId: ClaudeUnifiedDialogId): boolean {
      return controller.ownsDialog(dialogId);
    },
    whenControlIdle(): Promise<void> {
      return controller.whenControlIdle();
    },
    async dispose(): Promise<void> {
      lastEmittedChangeSignatures.clear();
      await controller.dispose();
    },
  };
}
