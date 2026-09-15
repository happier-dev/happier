import { buildClaudeGoalCommand } from './claudeGoalCommand';

/**
 * ACTIVE-session goal effector for Claude (P1-E3 / G3).
 *
 * The generic goal router prefers the live session RPC for active sessions
 * (`SESSION_GOAL_SET` / `SESSION_GOAL_CLEAR`). For Claude those handlers call
 * these runtime controls, which inject a terminal-local `/goal` control into
 * the unified terminal arbiter without opening a provider turn.
 *
 * Delivery semantics are explicit (G3): the injector reports the strongest
 * runtime-observable delivery state it can PROVE. The terminal/arbiter can prove
 * the command was drained and written to the terminal (`sent-to-terminal`); it
 * CANNOT currently prove provider acceptance or correlate a matching
 * `goal_status`, so the controls never claim `confirmed`. The emitted
 * `goal_status` attachment remains the SOURCE OF TRUTH for SET state (parsed by
 * `claudeGoalStatus`); for CLEAR, Claude emits no `goal_status`, so the app owns
 * deterministic removal after the accepted delivery threshold is reached.
 */

/**
 * The strongest delivery state observed for an injected `/goal` command:
 *  - `queued`: accepted into the arbiter queue but not yet written to the terminal;
 *  - `sent-to-terminal`: drained from the arbiter and written to the terminal input.
 *
 * It deliberately stops at runtime-observable states. A later matching `goal_status` is SOURCE
 * observation that resolves UI pending state; it is not modeled as a command-delivery variant here
 * because the runtime control path does not receive/correlate that signal.
 */
export type ClaudeGoalCommandDelivery =
  | Readonly<{ kind: 'queued' }>
  | Readonly<{ kind: 'sent-to-terminal' }>;

/**
 * Injects a terminal-local `/goal …` command into the unified terminal arbiter and resolves with the
 * strongest delivery state it can prove. Rejects only on a genuine injection failure.
 */
export type ClaudeGoalCommandInjector = (message: string) => Promise<ClaudeGoalCommandDelivery>;

const DELIVERY_RANK: Record<ClaudeGoalCommandDelivery['kind'], number> = {
  queued: 0,
  'sent-to-terminal': 1,
};

/**
 * The minimum delivery state at which an injected goal command is considered ACCEPTED: the command
 * reached the terminal. We do NOT require provider acceptance / a matching `goal_status` because the
 * terminal/arbiter cannot currently prove that for `/goal`. Naming this `sent-to-terminal` (not
 * `confirmed`) keeps the guarantee honest.
 */
const ACCEPTED_DELIVERY_THRESHOLD = DELIVERY_RANK['sent-to-terminal'];

function reachedAcceptedThreshold(delivery: ClaudeGoalCommandDelivery): boolean {
  return DELIVERY_RANK[delivery.kind] >= ACCEPTED_DELIVERY_THRESHOLD;
}

export type ClaudeGoalRuntimeControls = Readonly<{
  setGoal: (
    objective: string | undefined,
    options?: Readonly<{ status?: string }>,
  ) => Promise<unknown>;
  clearGoal: () => Promise<unknown>;
}>;

type GoalControlError = Readonly<{ ok: false; errorCode: string; error: string }>;

function stableError(errorCode: string): GoalControlError {
  return { ok: false, errorCode, error: errorCode };
}

function objectiveRequiredError(): GoalControlError {
  return stableError('session_goal_control_objective_required');
}

/**
 * H4-CLI: a failed (or below-threshold) `/goal` injection must surface as a TYPED non-fallback error
 * (errorCode NOT in the goal router's fallback set), so the live RPC reports the failure cleanly
 * instead of throwing — which the router would treat as a fallback trigger and then seed a
 * decorative metadata goal the running session never actually started pursuing.
 */
function injectFailedError(): GoalControlError {
  return stableError('session_goal_control_inject_failed');
}

/**
 * G-1: Claude's `/goal` command carries an objective ONLY — it cannot
 * apply a status transition (pause/complete/…). Requesting that is UNSUPPORTED on the Claude
 * runtime path. Returning a typed, NON-fallback error (`session_goal_control_unsupported`, absent
 * from the goal router's fallback set) fails loudly instead of silently dropping the option while
 * reporting success — the original bug that let non-UI callers lose data with no signal.
 */
function unsupportedOptionError(): GoalControlError {
  return stableError('session_goal_control_unsupported');
}

/**
 * True when the caller requested a Claude-unsupported goal mutation: a status transition.
 * `objective`-only sets are the sole supported mutation and pass through.
 */
function requestsUnsupportedGoalOption(
  options: Readonly<{ status?: string }> | undefined,
): boolean {
  if (!options) return false;
  if (options.status !== undefined) return true;
  return false;
}

export function createClaudeGoalRuntimeControls(opts: Readonly<{
  injectGoalCommand: ClaudeGoalCommandInjector;
  /**
   * Deterministically remove the published Claude goal work-state item after the `/goal clear` inject
   * reaches the accepted delivery threshold. Required because Claude's `/goal clear` emits NO
   * `goal_status` attachment the goal source could observe (verified live), so without this the
   * work-state keeps showing the last (now-stale) goal after a clear. Idempotent; safe to omit (then
   * clear is inject-only).
   */
  clearGoalWorkState?: () => void;
  /**
   * Record a goal-control SET intent once the `/goal <objective>` inject reaches the accepted
   * delivery threshold (G2/G3). This bumps the goal-control epoch BEFORE any provider `goal_status`,
   * so re-setting the SAME objective after a clear is accepted instead of being suppressed as a stale
   * post-clear replay. Best-effort; safe to omit.
   */
  recordGoalSetIntent?: () => void;
}>): ClaudeGoalRuntimeControls {
  return {
    setGoal: async (objective, options) => {
      if (requestsUnsupportedGoalOption(options)) {
        // Fail loudly before injecting: a status mutation cannot be delivered via `/goal`,
        // so pretending it succeeded (or injecting an objective-only command that silently drops it)
        // would leave metadata/runtime disagreeing.
        return unsupportedOptionError();
      }
      const trimmed = typeof objective === 'string' ? objective.trim() : '';
      if (!trimmed) {
        // Claude `/goal` cannot pursue an empty objective. Returning a non-fallback
        // error keeps the router on the live path and surfaces the failure cleanly.
        return objectiveRequiredError();
      }
      let delivery: ClaudeGoalCommandDelivery;
      try {
        delivery = await opts.injectGoalCommand(buildClaudeGoalCommand({ type: 'set', objective: trimmed }));
      } catch {
        return injectFailedError();
      }
      if (!reachedAcceptedThreshold(delivery)) {
        // Queued but not yet sent to the terminal: do not claim success and do not record a set epoch
        // for a command the session has not received.
        return injectFailedError();
      }
      // Record the SET epoch now (at the strongest runtime-observable delivery state), BEFORE any
      // provider `goal_status`, so re-setting the same objective after a clear is accepted (G2).
      try {
        opts.recordGoalSetIntent?.();
      } catch {
        // Non-fatal: the `/goal` was sent; the epoch nudge is a best-effort suppression lift.
      }
      return undefined;
    },
    clearGoal: async () => {
      let delivery: ClaudeGoalCommandDelivery;
      try {
        delivery = await opts.injectGoalCommand(buildClaudeGoalCommand({ type: 'clear' }));
      } catch {
        return injectFailedError();
      }
      if (!reachedAcceptedThreshold(delivery)) {
        // Below the accepted threshold the clear has not reached the terminal — do NOT remove the
        // work-state yet (removing it would falsely show "no goal" while the goal is still active).
        return injectFailedError();
      }
      // The inject reached the terminal but Claude echoes no goal_status for a clear, so remove the
      // work-state goal item directly. Best-effort: a removal failure must not fail the clear itself.
      try {
        opts.clearGoalWorkState?.();
      } catch {
        // Non-fatal: the `/goal clear` was sent; the metadata reconciliation is a follow-up.
      }
      return undefined;
    },
  };
}
