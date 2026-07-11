import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';

export function resolveGoalStatusLabelKey(goal: SessionWorkStateItem | null):
    | 'session.workState.goal.statusActive'
    | 'session.workState.goal.statusPaused'
    | 'session.workState.goal.statusComplete'
    | 'session.workState.goal.statusBudgetLimited'
    | 'session.workState.goal.statusInterrupted'
    | 'session.workState.badge.goalBlocked' {
    if (goal?.statusReason === 'budgetLimited') return 'session.workState.goal.statusBudgetLimited';
    // A goal left active when its CLI session tore down gracefully is flagged `interrupted` (status
    // STAYS active); surface a muted "Interrupted" so it does not read as actively running (plan #9).
    if (goal?.statusReason === 'interrupted' && goal.status === 'active') return 'session.workState.goal.statusInterrupted';
    if (goal?.status === 'paused') return 'session.workState.goal.statusPaused';
    if (goal?.status === 'complete') return 'session.workState.goal.statusComplete';
    if (goal?.status === 'blocked') return 'session.workState.badge.goalBlocked';
    return 'session.workState.goal.statusActive';
}

export function canPauseOrResumeGoal(goal: SessionWorkStateItem | null): boolean {
    return goal?.status === 'active' || goal?.status === 'paused';
}

export type GoalActionCapabilities = Readonly<{
    /** Edit the objective / set a new goal. */
    canEdit: boolean;
    /** Pause, resume, or mark complete (provider must own goal lifecycle control). */
    canStop: boolean;
    /** Clear the goal. */
    canClear: boolean;
    /** Configure a token budget on the goal (a control-tier, Codex-style affordance). */
    canConfigureBudget: boolean;
}>;

const FULL_GOAL_ACTION_CAPABILITIES: GoalActionCapabilities = {
    canEdit: true,
    canStop: true,
    canClear: true,
    canConfigureBudget: true,
};

function resolveFromGoalCapabilities(
    capabilities: NonNullable<SessionWorkStateItem['goalCapabilities']>,
): GoalActionCapabilities {
    const canStop = capabilities.canStop === true;
    return {
        canEdit: capabilities.canEdit === true,
        canStop,
        canClear: capabilities.canClear === true,
        canConfigureBudget: canStop,
    };
}

/**
 * Capability-driven visibility for goal actions. The rule is back-compat safe and entirely
 * provider-name-free:
 *  - PRESENT goal-item `goalCapabilities` (e.g. Claude's `{ canEdit, canClear }`) → expose ONLY the
 *    declared controls. Pause/resume/complete and the token budget are gated behind `canStop`, which
 *    Claude does not publish, so Claude shows edit/set + clear only. The goal item always wins when
 *    it carries capabilities.
 *  - NO goal-item capabilities but a provider `fallbackProfile` is supplied → use the provider's
 *    session-level profile. This drives the "Set goal" form BEFORE any goal item exists (e.g. a fresh
 *    Claude session, whose goal item only appears after a native `goal_status`), preventing the
 *    Codex-only budget UI from leaking onto Claude (QA-CHIP-2, found in manual QA).
 *  - ABSENT both (Codex legacy, or no provider profile) → FULL control surface, so existing Codex
 *    behavior is unchanged.
 */
export function resolveGoalActionCapabilities(
    goal: SessionWorkStateItem | null,
    fallbackProfile?: GoalActionCapabilities | null,
): GoalActionCapabilities {
    const capabilities = goal?.goalCapabilities;
    if (capabilities) return resolveFromGoalCapabilities(capabilities);
    if (fallbackProfile) return fallbackProfile;
    return FULL_GOAL_ACTION_CAPABILITIES;
}
