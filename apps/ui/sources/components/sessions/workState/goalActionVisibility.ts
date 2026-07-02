import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';

export function resolveGoalStatusLabelKey(goal: SessionWorkStateItem | null):
    | 'session.workState.goal.statusActive'
    | 'session.workState.goal.statusPaused'
    | 'session.workState.goal.statusComplete'
    | 'session.workState.goal.statusBudgetLimited'
    | 'session.workState.badge.goalBlocked' {
    if (goal?.statusReason === 'budgetLimited') return 'session.workState.goal.statusBudgetLimited';
    if (goal?.status === 'paused') return 'session.workState.goal.statusPaused';
    if (goal?.status === 'complete') return 'session.workState.goal.statusComplete';
    if (goal?.status === 'blocked') return 'session.workState.badge.goalBlocked';
    return 'session.workState.goal.statusActive';
}

export function canPauseOrResumeGoal(goal: SessionWorkStateItem | null): boolean {
    return goal?.status === 'active' || goal?.status === 'paused';
}
