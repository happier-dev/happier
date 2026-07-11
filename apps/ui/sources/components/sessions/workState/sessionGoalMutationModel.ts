import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';

/**
 * Pure goal-mutation model (G6): request/result contracts plus the value-stable goal signature and
 * the no-op detection used by the goal controller. Extracted from the React hook so the mutation
 * rules can be tested without rendering the popover, and so the chip/popover/content surfaces share
 * exactly one definition. Ported from remote-dev by intent (D-3 no-op detection fix), adapted to
 * dev's `@/sync/domains/...` type paths.
 */

export type SessionWorkStateGoalOperationResult = { ok: true } | { ok: false; error: string };

export type SessionWorkStateGoalSetRequest = Readonly<{
    objective?: string;
    status?: 'active' | 'paused' | 'complete';
    tokenBudget?: number | null;
    resumeInactiveWithInitialGoal?: boolean;
}>;

/**
 * After the goal RPC is acknowledged we keep the popover in a "setting goal…" pending state until
 * the native work-state actually reflects the change. For Claude the confirmation only arrives once
 * a fresh `goal_status` work-state item lands. If it has not arrived within this window we do NOT
 * tear the pending state down or surface an error (the `/goal` inject is commonly just queued behind
 * an in-flight turn — G-5): instead we soften the copy to a non-error "still waiting" note and keep
 * waiting, auto-resolving the moment confirmation lands.
 */
export const GOAL_CONFIRMATION_TIMEOUT_MS = 12_000;

/**
 * Pending-confirmation state for a dispatched goal mutation. `idle` = nothing awaiting confirmation;
 * `pending` = the popover holds "setting goal…" keyed to the goal signature captured at request time;
 * `slow` flips true once the confirmation window elapses so the controller can show the softened
 * "still waiting for confirmation…" note without dropping the pending row. Kept as a pure model so the
 * transitions are testable without rendering the popover.
 */
export type GoalConfirmation =
    | { readonly phase: 'idle' }
    | { readonly phase: 'pending'; readonly baseline: string; readonly slow: boolean };

export const IDLE_GOAL_CONFIRMATION: GoalConfirmation = { phase: 'idle' };

/** Begin awaiting confirmation for a dispatched mutation, keyed to the pre-mutation goal signature. */
export function beginGoalConfirmation(baseline: string): GoalConfirmation {
    return { phase: 'pending', baseline, slow: false };
}

/** Flip a pending confirmation into its softened "still waiting" presentation (no-op otherwise). */
export function markGoalConfirmationSlow(state: GoalConfirmation): GoalConfirmation {
    if (state.phase !== 'pending' || state.slow) return state;
    return { phase: 'pending', baseline: state.baseline, slow: true };
}

/**
 * Resolve a pending confirmation once the live work-state signature has moved off the captured
 * baseline (the mutation is now observed natively). Returns `idle` on confirmation; otherwise returns
 * the input state unchanged (referentially stable so effects do not churn).
 */
export function resolveGoalConfirmation(state: GoalConfirmation, currentSignature: string): GoalConfirmation {
    if (state.phase !== 'pending') return state;
    return currentSignature !== state.baseline ? IDLE_GOAL_CONFIRMATION : state;
}

/**
 * A value-stable signature of the goal item used to detect that the work-state confirmed a mutation.
 * Any change (new goal, title, status, status-reason, or a fresh `updatedAt`) counts as confirmation.
 */
export function goalSignature(goal: SessionWorkStateItem | null): string {
    if (!goal) return '';
    return `${goal.id}|${goal.title}|${goal.status}|${goal.statusReason ?? ''}|${goal.updatedAt}`;
}

/**
 * Whether a set request would leave the goal unchanged. A no-op never produces a fresh native
 * work-state item, so the source's no-churn dedupe suppresses the republish and the confirmation
 * effect would otherwise wait the full timeout. We detect "no change needed" up front and treat
 * the acknowledged mutation as immediate success instead of pending (D-3 fix).
 */
export function isNoOpGoalMutation(goal: SessionWorkStateItem | null, request: SessionWorkStateGoalSetRequest): boolean {
    if (!goal) return false;
    // A budget change always mutates the goal.
    if (request.tokenBudget !== undefined) return false;
    if (request.objective !== undefined) {
        if (request.objective.trim() !== goal.title.trim()) return false;
        // The objective matches; only a no-op if no status transition is requested.
        return request.status === undefined || request.status === goal.status;
    }
    // Status-only request (pause/resume/complete): no-op when already in that status.
    if (request.status !== undefined) return request.status === goal.status;
    return true;
}
