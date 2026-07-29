import { sleep } from '@happier-dev/plugin-sdk/experimental/timeout';

import { resolveClaudeDefaultEffortForKnownAliasOrModel } from '../../../reasoningEffort.js';

import type { ControlRuntime } from './controlRuntime.js';
import {
  aggregateApplyOutcome,
  controlResultToChangeOutcome,
  type ControlAttemptResult,
  type ControlScheduleTiming,
} from './outcome.js';
import {
  applyPermissionModeControl,
  resolveTargetModeMarker,
} from './permissionMode.js';
import {
  applyEffortControl,
  applyModelControl,
  EFFORT_CHANGE_DECLINED_REASON,
  type SlashControlContext,
} from './slashControls.js';
import {
  DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS,
  type ApplyRuntimeConfigInput,
  type ApplyRuntimeConfigReason,
  type ClaudeDesiredInFlightModeConfig,
  type ClaudeDesiredRuntimeConfig,
  type ClaudePromptSubmitMetadata,
  type ClaudeStatuslineRuntimeMetadata,
  type ClaudeTuiControlControllerDeps,
  type ClaudeTuiModeMarker,
  type ClaudeUnifiedTuiControlController,
  type ClaudeUnifiedVerifiedRuntimeConfig,
  type RuntimeConfigApplyOutcome,
  type RuntimeConfigChangeOutcome,
  type RuntimeConfigOutcomeChangeKeyV1,
  type RuntimeConfigOutcomeScalar,
  type RuntimeConfigOutcomeTimingV1,
  type RuntimeConfigScheduleOutcome,
} from './types.js';
import type { ClaudeTuiControlTelemetrySink } from './telemetry.js';

const EMPTY_VERIFIED: ClaudeUnifiedVerifiedRuntimeConfig = {
  model: null,
  reasoningEffort: null,
  modeMarker: null,
  verifiedAtMs: null,
};

const NOOP_TELEMETRY: ClaudeTuiControlTelemetrySink = { emit: () => undefined };

function hasModeChange(desired: ClaudeDesiredRuntimeConfig): boolean {
  if (typeof desired.permissionMode === 'string' && desired.permissionMode.length > 0) return true;
  return typeof desired.agentModeId === 'string' && desired.agentModeId.trim().length > 0;
}

function isModeOnlyRuntimeConfigChange(desired: ClaudeDesiredRuntimeConfig): boolean {
  return hasModeChange(desired)
    && desired.model === undefined
    && desired.reasoningEffort === undefined
    && desired.ultracode === undefined
    && desired.maxThinkingTokens == null;
}

function mergeDesired(
  base: ClaudeDesiredRuntimeConfig,
  override: ClaudeDesiredRuntimeConfig,
): ClaudeDesiredRuntimeConfig {
  return {
    model: override.model ?? base.model,
    reasoningEffort: override.reasoningEffort ?? base.reasoningEffort,
    permissionMode: override.permissionMode ?? base.permissionMode,
    agentModeId: override.agentModeId ?? base.agentModeId,
    maxThinkingTokens: override.maxThinkingTokens ?? base.maxThinkingTokens,
    ultracode: override.ultracode ?? base.ultracode,
  };
}

function describeChangeKeys(desired: ClaudeDesiredRuntimeConfig): string {
  const keys: string[] = [];
  if (desired.model !== undefined) keys.push('model');
  if (desired.reasoningEffort !== undefined) keys.push('reasoningEffort');
  if (desired.ultracode !== undefined) keys.push('ultracode');
  if (hasModeChange(desired)) keys.push('mode');
  if (desired.maxThinkingTokens != null) keys.push('maxThinkingTokens');
  return keys.join(',') || 'none';
}

// Timings that mean "not yet effective" (mirror of the outcome aggregation set).
const DEFERRED_CHANGE_TIMINGS: ReadonlySet<RuntimeConfigOutcomeTimingV1> = new Set([
  'scheduled_for_next_prompt',
  'queued_until_safe_window',
  'next_idle',
]);

function modeChangeKey(desired: ClaudeDesiredRuntimeConfig): RuntimeConfigOutcomeChangeKeyV1 {
  const target = resolveTargetModeMarker({ permissionMode: desired.permissionMode, agentModeId: desired.agentModeId });
  return target.kind === 'cyclable' && target.marker === 'plan' ? 'sessionMode' : 'permissionMode';
}

function permissionModeToMarker(mode: string): ClaudeTuiModeMarker | null {
  const target = resolveTargetModeMarker({ permissionMode: mode });
  return target.kind === 'cyclable' ? target.marker : null;
}

export function createClaudeUnifiedTuiControlController(
  deps: ClaudeTuiControlControllerDeps,
): ClaudeUnifiedTuiControlController {
  const nowMs = deps.nowMs ?? Date.now;
  const wait = deps.wait ?? sleep;
  const timings = { ...DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS, ...deps.timings };
  const telemetry = deps.telemetry ?? NOOP_TELEMETRY;
  const runtime: ControlRuntime = { port: deps.port, wait, timings, nowMs };

  let disposed = false;
  let lastVerified: ClaudeUnifiedVerifiedRuntimeConfig = EMPTY_VERIFIED;
  let pending: ClaudeDesiredRuntimeConfig = {};
  // Consecutive unsafe-window deferrals per change key. A persistently blocked safe window
  // (e.g. a stuck overlay) escalates ONCE to requires_interactive_control instead of re-deferring
  // blindly forever; any other result resets the counter.
  const consecutiveUnsafeWindowDeferrals = new Map<RuntimeConfigOutcomeChangeKeyV1, number>();
  // Consecutive dialog-declined failures per change key. A deliberately-answered effort dialog
  // that keeps resolving as "Kept effort level as <current>" can never converge by retrying, so it
  // escalates ONCE to requires_interactive_control instead of failing at backoff cadence forever.
  const consecutiveDialogDeclines = new Map<RuntimeConfigOutcomeChangeKeyV1, number>();

  // Terminal control lock: serialize ALL control ops so prompt injection / attached-user writes /
  // permission answers cannot interleave with control sequences. Injection honors `isControlInFlight()`.
  let queue: Promise<unknown> = Promise.resolve();
  let activeCount = 0;
  const idleResolvers: Array<() => void> = [];

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    activeCount += 1;
    const result = queue.then(() => fn());
    queue = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      activeCount -= 1;
      if (activeCount === 0) idleResolvers.splice(0).forEach((resolve) => resolve());
    });
  }

  function whenIdle(): Promise<void> {
    if (activeCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => idleResolvers.push(resolve));
  }

  function recordVerified(key: RuntimeConfigOutcomeChangeKeyV1, change: RuntimeConfigChangeOutcome): void {
    if (change.status !== 'applied') return;
    const effective = typeof change.effective === 'string' ? change.effective : null;
    if (key === 'model') {
      lastVerified = { ...lastVerified, model: effective ?? lastVerified.model, verifiedAtMs: nowMs() };
    } else if (key === 'reasoningEffort') {
      lastVerified = { ...lastVerified, reasoningEffort: effective ?? lastVerified.reasoningEffort, verifiedAtMs: nowMs() };
    } else if (key === 'permissionMode' || key === 'sessionMode') {
      const marker = effective as ClaudeTuiModeMarker | null;
      lastVerified = { ...lastVerified, modeMarker: marker ?? lastVerified.modeMarker, verifiedAtMs: nowMs() };
    }
  }

  function emitChange(change: RuntimeConfigChangeOutcome): void {
    telemetry.emit({
      name: 'unified.control.outcome',
      properties: { key: change.key, status: change.status, timing: change.timing, reason: change.reason },
    });
  }

  type ControlPlan = Readonly<{
    key: RuntimeConfigOutcomeChangeKeyV1;
    requested: RuntimeConfigOutcomeScalar;
    run: (batchChanges: readonly RuntimeConfigChangeOutcome[]) => Promise<ControlAttemptResult>;
    stash: (into: ClaudeDesiredRuntimeConfig) => ClaudeDesiredRuntimeConfig;
  }>;

  /**
   * Ultracode-off fallback effort: the `/effort` menu replaces ultracode with a level, so
   * turning it off means re-selecting one. Preference order: the explicitly desired effort,
   * the last verified effort (unless that is ultracode itself), the model's default effort,
   * then `high` (the default of every xhigh-capable — i.e. ultracode-capable — model except
   * Opus 4.7, which the model-default lookup already covers).
   */
  function resolveUltracodeOffFallbackEffort(desired: ClaudeDesiredRuntimeConfig): string {
    if (desired.reasoningEffort !== undefined) return desired.reasoningEffort;
    const verified = lastVerified.reasoningEffort;
    if (typeof verified === 'string' && verified.length > 0 && verified !== 'ultracode') return verified;
    const modelDefault = resolveClaudeDefaultEffortForKnownAliasOrModel(desired.model ?? lastVerified.model ?? undefined);
    return modelDefault ?? 'high';
  }

  const slashContext = (reason: ApplyRuntimeConfigReason): SlashControlContext => ({
    runtime,
    settingsGuard: deps.settingsGuard,
    reason,
    telemetry,
    onCommandSubmitted: deps.onControlCommandTyped,
    onCommandTyped: deps.onControlCommandTextEntered,
  });

  function buildControlPlans(desired: ClaudeDesiredRuntimeConfig, reason: ApplyRuntimeConfigReason): ControlPlan[] {
    const plans: ControlPlan[] = [];
    const modeOnly = isModeOnlyRuntimeConfigChange(desired);
    // Ordering: model → effort → ultracode → permission/plan mode.
    if (desired.model !== undefined) {
      plans.push({
        key: 'model',
        requested: desired.model,
        run: () => applyModelControl(slashContext(reason), desired.model as string),
        stash: (into) => ({ ...into, model: desired.model }),
      });
    }
    if (desired.reasoningEffort !== undefined) {
      plans.push({
        key: 'reasoningEffort',
        requested: desired.reasoningEffort,
        run: () => applyEffortControl(slashContext(reason), desired.reasoningEffort as string),
        stash: (into) => ({ ...into, reasoningEffort: desired.reasoningEffort }),
      });
    }
    if (desired.ultracode !== undefined) {
      // Session-only setting mapped onto the existing `launchOption` change key (no new
      // protocol change-key member). ON types `/effort ultracode`; OFF re-selects a level.
      const requestedUltracode = desired.ultracode;
      plans.push({
        key: 'launchOption',
        requested: requestedUltracode,
        run: async (batchChanges) => {
          if (requestedUltracode) {
            return applyEffortControl(slashContext(reason), 'ultracode');
          }
          const effortChange = batchChanges.find((change) => change.key === 'reasoningEffort');
          if (effortChange) {
            // The effort control in this same batch already (or will) replace ultracode.
            if (effortChange.status === 'applied') {
              if (effortChange.timing !== undefined && DEFERRED_CHANGE_TIMINGS.has(effortChange.timing)) {
                return {
                  kind: 'scheduled',
                  timing: effortChange.timing as ControlScheduleTiming,
                  reason: 'effort_control_deferred',
                };
              }
              return { kind: 'already_effective', effective: false };
            }
            // The in-batch effort apply did not land: the dependent ultracode-off change defers to
            // the next prompt instead of surfacing a misleading failed launch-option row.
            return {
              kind: 'scheduled',
              timing: 'scheduled_for_next_prompt',
              reason: 'effort_control_not_applied',
            };
          }
          return applyEffortControl(
            slashContext(reason),
            resolveUltracodeOffFallbackEffort(desired),
          );
        },
        stash: (into) => ({ ...into, ultracode: desired.ultracode }),
      });
    }
    if (hasModeChange(desired)) {
      const key = modeChangeKey(desired);
      plans.push({
        key,
        requested: key === 'sessionMode' ? 'plan' : (desired.permissionMode ?? null),
        run: () => applyPermissionModeControl(
          {
            runtime,
            telemetry,
            maxAttempts: deps.maxModeCycleAttempts,
            // Mode-only changes may cycle in the steer-safe GENERATING window regardless of caller
            // path. Non-mode and mixed changes keep the idle-only window so partial config truth is
            // never reported as fully effective.
            ...(modeOnly ? { window: 'in_flight_steer' as const } : {}),
          },
          { permissionMode: desired.permissionMode, agentModeId: desired.agentModeId },
        ),
        stash: (into) => ({ ...into, permissionMode: desired.permissionMode, agentModeId: desired.agentModeId }),
      });
    }
    if (desired.maxThinkingTokens != null) {
      plans.push({
        key: 'maxThinkingTokens',
        requested: desired.maxThinkingTokens,
        run: async () => ({ kind: 'unsupported', reason: 'no_tui_control' }),
        stash: (into) => into,
      });
    }
    return plans;
  }

  /**
   * Verified-config short-circuit: a control whose requested value already equals the last
   * VERIFIED value is reported already-set without touching the TUI. Only exact scalar matches
   * qualify (model TUI echoes differ in shape from requested ids, so model never short-circuits
   * unless the echo matches exactly).
   */
  function resolveAlreadyVerifiedResult(
    key: RuntimeConfigOutcomeChangeKeyV1,
    desired: ClaudeDesiredRuntimeConfig,
  ): ControlAttemptResult | null {
    if (key === 'reasoningEffort') {
      const requested = desired.reasoningEffort;
      const verified = lastVerified.reasoningEffort;
      if (typeof requested === 'string' && verified !== null && requested.toLowerCase() === verified.toLowerCase()) {
        return { kind: 'already_effective', effective: verified };
      }
      return null;
    }
    if (key === 'model') {
      const requested = desired.model;
      if (typeof requested === 'string' && lastVerified.model !== null && requested === lastVerified.model) {
        return { kind: 'already_effective', effective: lastVerified.model };
      }
      return null;
    }
    if (key === 'permissionMode' || key === 'sessionMode') {
      const target = resolveTargetModeMarker({ permissionMode: desired.permissionMode, agentModeId: desired.agentModeId });
      if (target.kind === 'cyclable' && lastVerified.modeMarker !== null && target.marker === lastVerified.modeMarker) {
        return { kind: 'already_effective', effective: lastVerified.modeMarker };
      }
      return null;
    }
    return null;
  }

  // Bounded consecutive unsafe-window deferrals / dialog declines before escalating.
  const MAX_CONSECUTIVE_UNSAFE_WINDOW_DEFERRALS = 3;
  const MAX_CONSECUTIVE_DIALOG_DECLINES = 3;

  function isUnsafeWindowDeferral(
    result: ControlAttemptResult,
  ): result is Extract<ControlAttemptResult, { kind: 'scheduled' }> {
    return result.kind === 'scheduled'
      && result.timing === 'queued_until_safe_window';
  }

  function isDialogDeclinedFailure(
    result: ControlAttemptResult,
  ): result is Extract<ControlAttemptResult, { kind: 'failed' }> {
    return result.kind === 'failed' && result.reason === EFFORT_CHANGE_DECLINED_REASON;
  }

  function applyStuckControlEscalation(
    key: RuntimeConfigOutcomeChangeKeyV1,
    result: ControlAttemptResult,
  ): ControlAttemptResult {
    if (isUnsafeWindowDeferral(result)) {
      consecutiveDialogDeclines.delete(key);
      const count = (consecutiveUnsafeWindowDeferrals.get(key) ?? 0) + 1;
      consecutiveUnsafeWindowDeferrals.set(key, count);
      if (count <= MAX_CONSECUTIVE_UNSAFE_WINDOW_DEFERRALS) return result;
      // Persistently blocked safe window: surface once as needs-interactive-control instead of
      // re-deferring blindly (incident cmq8y3nlx hot loop).
      return { kind: 'unreachable', reason: `stuck_unsafe_window:${result.reason ?? 'unknown'}` };
    }
    consecutiveUnsafeWindowDeferrals.delete(key);
    if (isDialogDeclinedFailure(result)) {
      const count = (consecutiveDialogDeclines.get(key) ?? 0) + 1;
      consecutiveDialogDeclines.set(key, count);
      if (count <= MAX_CONSECUTIVE_DIALOG_DECLINES) return result;
      // The deliberately-answered dialog keeps declining (incident cmq8y3nlx, L6): retrying cannot
      // converge, so escalate once to needs-interactive-control (event dedup keeps it single).
      return { kind: 'unreachable', reason: `stuck_dialog_decline:${result.reason}` };
    }
    consecutiveDialogDeclines.delete(key);
    return result;
  }

  async function applyControls(
    desired: ClaudeDesiredRuntimeConfig,
    reason: ApplyRuntimeConfigReason,
  ): Promise<{ changes: RuntimeConfigChangeOutcome[]; scheduled: ClaudeDesiredRuntimeConfig }> {
    const changes: RuntimeConfigChangeOutcome[] = [];
    let scheduled: ClaudeDesiredRuntimeConfig = {};
    for (const plan of buildControlPlans(desired, reason)) {
      let result: ControlAttemptResult;
      const alreadyVerified = resolveAlreadyVerifiedResult(plan.key, desired);
      if (alreadyVerified) {
        result = alreadyVerified;
        consecutiveUnsafeWindowDeferrals.delete(plan.key);
        consecutiveDialogDeclines.delete(plan.key);
      } else {
        try {
          result = await plan.run(changes);
        } catch (error) {
          // Never reject the apply promise: a thrown control (e.g. settings lock timeout) becomes a
          // failed change so the prompt stays blocked under the existing structured-outcome contract.
          result = { kind: 'failed', reason: `control_threw:${error instanceof Error ? error.message : 'unknown'}` };
        }
        // Mid-turn steer applies do not feed the stuck counters — transient mid-turn vetoes
        // (e.g. a permission prompt) are NORMAL and must not escalate the before-prompt path
        // to requires_interactive_control.
        if (reason !== 'in_flight_steer') {
          result = applyStuckControlEscalation(plan.key, result);
        }
      }
      const change = controlResultToChangeOutcome({ key: plan.key, requested: plan.requested, result });
      changes.push(change);
      emitChange(change);
      recordVerified(plan.key, change);
      if (result.kind === 'scheduled') scheduled = plan.stash(scheduled);
    }
    return { changes, scheduled };
  }

  function buildStaticOutcome(
    desired: ClaudeDesiredRuntimeConfig,
    makeResult: (key: RuntimeConfigOutcomeChangeKeyV1) => ControlAttemptResult,
  ): RuntimeConfigApplyOutcome {
    const changes: RuntimeConfigChangeOutcome[] = [];
    for (const plan of buildControlPlans(desired, 'out_of_band')) {
      const result = plan.key === 'maxThinkingTokens' ? ({ kind: 'unsupported', reason: 'no_tui_control' } as const) : makeResult(plan.key);
      const change = controlResultToChangeOutcome({ key: plan.key, requested: plan.requested, result });
      changes.push(change);
      emitChange(change);
    }
    return aggregateApplyOutcome(changes);
  }

  return {
    async applyDesiredRuntimeConfig(input: ApplyRuntimeConfigInput): Promise<RuntimeConfigApplyOutcome> {
      const reason = input.reason ?? 'before_prompt';
      const effectiveDesired = mergeDesired(pending, input.desired);
      pending = {};
      telemetry.emit({
        name: 'unified.control.start',
        properties: { changeKeys: describeChangeKeys(effectiveDesired), reason, featureEnabled: deps.featureEnabled },
      });

      if (disposed) {
        // Fail-closed: never let a dependent prompt proceed under a disposed controller.
        return buildStaticOutcome(effectiveDesired, () => ({ kind: 'failed', reason: 'controller_disposed' }));
      }
      if (!deps.featureEnabled) {
        // Gate off → fall back to existing structured restart/unsupported outcomes.
        return buildStaticOutcome(effectiveDesired, () => ({ kind: 'requires_restart', reason: 'tui_runtime_control_disabled' }));
      }

      return runExclusive(async () => {
        const { changes, scheduled } = await applyControls(effectiveDesired, reason);
        pending = mergeDesired(pending, scheduled);
        return aggregateApplyOutcome(changes);
      });
    },

    async applyPermissionModeInFlight(desired: ClaudeDesiredInFlightModeConfig): Promise<RuntimeConfigApplyOutcome> {
      const modeDesired: ClaudeDesiredRuntimeConfig = {
        permissionMode: desired.permissionMode,
        agentModeId: desired.agentModeId,
      };
      telemetry.emit({
        name: 'unified.control.start',
        properties: { changeKeys: describeChangeKeys(modeDesired), reason: 'in_flight_steer', featureEnabled: deps.featureEnabled },
      });
      if (disposed) {
        return buildStaticOutcome(modeDesired, () => ({ kind: 'failed', reason: 'controller_disposed' }));
      }
      if (!deps.featureEnabled) {
        return buildStaticOutcome(modeDesired, () => ({ kind: 'requires_restart', reason: 'tui_runtime_control_disabled' }));
      }
      if (!hasModeChange(modeDesired)) {
        return aggregateApplyOutcome([]);
      }
      return runExclusive(async () => {
        // Deliberately no `pending` merge: stashed model/effort are next-idle controls and must
        // never be typed mid-generation. A deferred mode result re-enters the pending stash so the
        // before-next-prompt apply converges it.
        const { changes, scheduled } = await applyControls(modeDesired, 'in_flight_steer');
        pending = mergeDesired(pending, scheduled);
        return aggregateApplyOutcome(changes);
      });
    },

    scheduleDesiredRuntimeConfig(input: ApplyRuntimeConfigInput): RuntimeConfigScheduleOutcome {
      if (disposed) {
        return { status: 'failed', scheduled: false, message: 'Controller disposed; cannot schedule runtime config.' };
      }
      if (!deps.featureEnabled) {
        return {
          status: 'requires_restart',
          scheduled: false,
          message: 'Claude Unified TUI runtime control is disabled; changes require a restart.',
        };
      }
      pending = mergeDesired(pending, input.desired);
      return {
        status: 'applied',
        timing: 'scheduled_for_next_prompt',
        scheduled: true,
        message: 'Scheduled runtime config to apply before the next prompt.',
      };
    },

    reconcileFromStatusline(metadata: ClaudeStatuslineRuntimeMetadata): void {
      // Effective-truth feed only: updates lastVerified, never desired/pending state and never the
      // TUI. Absent fields are ignored (haiku statuslines omit effort); a fully-empty update must
      // not even bump verifiedAtMs.
      if (metadata.model === undefined && metadata.reasoningEffort === undefined) return;
      lastVerified = {
        ...lastVerified,
        model: metadata.model ?? lastVerified.model,
        reasoningEffort: metadata.reasoningEffort ?? lastVerified.reasoningEffort,
        verifiedAtMs: nowMs(),
      };
    },

    reconcileAfterProviderPromptSubmit(metadata: ClaudePromptSubmitMetadata): void {
      const effort = metadata.reasoningEffort ?? metadata.effort;
      const modeMarker = typeof metadata.permissionMode === 'string'
        ? permissionModeToMarker(metadata.permissionMode)
        : lastVerified.modeMarker;
      lastVerified = {
        model: metadata.model ?? lastVerified.model,
        reasoningEffort: effort ?? lastVerified.reasoningEffort,
        modeMarker: modeMarker ?? lastVerified.modeMarker,
        verifiedAtMs: nowMs(),
      };
    },

    getLastVerifiedRuntimeConfig(): ClaudeUnifiedVerifiedRuntimeConfig {
      return lastVerified;
    },

    isControlInFlight(): boolean {
      return activeCount > 0;
    },

    whenControlIdle(): Promise<void> {
      return whenIdle();
    },

    async dispose(): Promise<void> {
      disposed = true;
      await whenIdle();
    },
  };
}
