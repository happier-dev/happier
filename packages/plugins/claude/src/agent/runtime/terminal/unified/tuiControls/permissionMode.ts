import {
  captureFailureToResult,
  captureScreenState,
  sendResultToFailure,
  type ControlRuntime,
} from './controlRuntime.js';
import type { ControlAttemptResult } from './outcome.js';
import {
  isSafeWindowForModeCycle,
  resolveClaudeScreenInFlightSteerVeto,
  resolveClaudeScreenModeCycleVeto,
  type ClaudeScreenState,
  type ClaudeTuiModeMarker,
} from '../screenState.js';
import type { ClaudeTuiControlTelemetrySink } from './telemetry.js';

/**
 * Permission/plan mode control via verified raw ShiftTab cycling.
 *
 * NEVER uses `/permissions` (it is a permission-rule editor, not a mode setter). The cycle order
 * and reachable set are dynamic (probe P-E: `auto` is model/account-gated; `default` has no marker),
 * so the controller verifies the status marker after EVERY press and stops once it reaches the target,
 * cycles back to an already-seen marker, or exhausts a bounded attempt limit — it never counts presses.
 */
export type PermissionModeDesired = Readonly<{
  permissionMode?: string | undefined;
  agentModeId?: string | null | undefined;
}>;

/**
 * Mode-cycle window policy (probe Q-A on 2.1.173):
 * - `'idle'` (default): only an interactive non-generating composer is safe — unchanged behavior.
 * - `'in_flight_steer'`: additionally allows the steer-safe GENERATING window (probe-proven: raw
 *   ShiftTab registers live mid-generation/tool-execution, the footer marker renders and verifies,
 *   and output is not corrupted). Dialogs/pickers/drafts/unknown screens still defer.
 */
export type PermissionModeCycleWindow = 'idle' | 'in_flight_steer';

export type PermissionModeContext = Readonly<{
  runtime: ControlRuntime;
  telemetry?: ClaudeTuiControlTelemetrySink | undefined;
  maxAttempts?: number | undefined;
  window?: PermissionModeCycleWindow | undefined;
}>;

export type TargetModeResolution =
  | Readonly<{ kind: 'cyclable'; marker: ClaudeTuiModeMarker }>
  | Readonly<{ kind: 'launch_only'; mode: string }>;

const DEFAULT_MAX_ATTEMPTS = 6;

function resolveModeCycleWindowVeto(
  state: ClaudeScreenState,
  window: PermissionModeCycleWindow | undefined,
): string | null {
  return window === 'in_flight_steer'
    ? resolveClaudeScreenModeCycleVeto(state)
    : resolveClaudeScreenInFlightSteerVeto(state);
}

function resolveModeCycleBlockedReason(
  state: ClaudeScreenState,
  window: PermissionModeCycleWindow | undefined,
): string {
  return resolveModeCycleWindowVeto(state, window) ?? 'unsafe_window';
}

export function resolveTargetModeMarker(desired: PermissionModeDesired): TargetModeResolution {
  const agentModeId = typeof desired.agentModeId === 'string' ? desired.agentModeId.trim() : '';
  if (agentModeId === 'plan') return { kind: 'cyclable', marker: 'plan' };

  switch (desired.permissionMode) {
    case 'default':
      return { kind: 'cyclable', marker: 'default' };
    case 'acceptEdits':
      return { kind: 'cyclable', marker: 'acceptEdits' };
    case 'plan':
      return { kind: 'cyclable', marker: 'plan' };
    case 'auto':
    case 'safe-yolo':
      return { kind: 'cyclable', marker: 'auto' };
    case 'bypassPermissions':
    case 'yolo':
      return { kind: 'cyclable', marker: 'bypassPermissions' };
    case 'dontAsk':
    case 'read-only':
      return { kind: 'launch_only', mode: desired.permissionMode };
    default:
      return { kind: 'launch_only', mode: desired.permissionMode ?? 'unknown' };
  }
}

export async function applyPermissionModeControl(
  ctx: PermissionModeContext,
  desired: PermissionModeDesired,
): Promise<ControlAttemptResult> {
  const target = resolveTargetModeMarker(desired);
  if (target.kind === 'launch_only') {
    return { kind: 'requires_restart', reason: `mode_not_cycle_reachable:${target.mode}` };
  }

  const { port, wait, timings } = ctx.runtime;
  const maxAttempts = Math.max(1, ctx.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const isSafeWindow = (screen: ClaudeScreenState): boolean =>
    isSafeWindowForModeCycle(screen)
    || (ctx.window === 'in_flight_steer'
      && screen.generating
      && resolveClaudeScreenModeCycleVeto(screen) === null);

  const initial = await captureScreenState(port);
  if (initial.kind !== 'state') return captureFailureToResult(initial);

  let state = initial.state;
  if (!isSafeWindow(state)) {
    // Generation/dialog/draft/unknown: never cycle blindly. Queue for the next safe window unless the
    // screen is wholly unknown (no interactive composer at all).
    if (state.generating || state.inputBoxInteractive) {
      return {
        kind: 'scheduled',
        timing: 'queued_until_safe_window',
        reason: resolveModeCycleBlockedReason(state, ctx.window),
      };
    }
    return { kind: 'failed', reason: 'unsafe_or_unknown_screen' };
  }

  if (state.modeMarker === target.marker) {
    return { kind: 'already_effective', effective: target.marker };
  }

  const visited = new Set<ClaudeTuiModeMarker>([state.modeMarker]);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!isSafeWindow(state)) {
      return {
        kind: 'scheduled',
        timing: 'queued_until_safe_window',
        reason: resolveModeCycleWindowVeto(state, ctx.window) ?? 'safe_window_lost',
      };
    }

    const sendShiftTab = sendResultToFailure(await port.sendSpecialKey('ShiftTab'));
    if (sendShiftTab) return sendShiftTab;

    await wait(timings.modeCycleSettleMs);
    const captured = await captureScreenState(port);
    if (captured.kind !== 'state') return captureFailureToResult(captured);
    state = captured.state;

    if (state.modeMarker === target.marker) {
      return { kind: 'applied', effective: target.marker, timing: 'current_window' };
    }
    if (visited.has(state.modeMarker)) {
      ctx.telemetry?.emit({
        name: 'unified.control.verification_mismatch',
        properties: { key: 'permissionMode', expected: target.marker, observed: state.modeMarker },
      });
      return { kind: 'unreachable', reason: `${target.marker}_not_reachable` };
    }
    visited.add(state.modeMarker);
  }

  return { kind: 'unreachable', reason: `${target.marker}_not_reached_within_${maxAttempts}_attempts` };
}
