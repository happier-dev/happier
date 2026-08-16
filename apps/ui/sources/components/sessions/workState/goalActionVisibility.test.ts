import { describe, expect, it } from 'vitest';

import { resolveGoalActionCapabilities, resolveGoalStatusLabelKey } from './goalActionVisibility';
import type { SessionWorkStateItem } from './sessionWorkStateTypes';

function goal(overrides: Partial<SessionWorkStateItem> = {}): SessionWorkStateItem {
    return {
        id: 'goal:1',
        kind: 'goal',
        origin: 'vendor',
        status: 'active',
        title: 'Ship goals',
        updatedAt: 10,
        ...overrides,
    };
}

describe('resolveGoalActionCapabilities', () => {
    it('grants the full control surface when no capabilities are present (Codex legacy)', () => {
        expect(resolveGoalActionCapabilities(goal())).toEqual({
            canEdit: true,
            canStop: true,
            canClear: true,
            canConfigureBudget: true,
        });
    });

    it('grants the full control surface when there is no goal and no fallback profile', () => {
        expect(resolveGoalActionCapabilities(null)).toEqual({
            canEdit: true,
            canStop: true,
            canClear: true,
            canConfigureBudget: true,
        });
    });

    it('applies the provider fallback profile when there is no goal item yet (set-first-goal form)', () => {
        // Claude's profile: edit/clear only, no pause/resume/complete, no budget. This is the
        // capability used by the "Set goal" form before any goal_status-derived item exists, so the
        // Codex-only budget UI does not leak onto a fresh Claude session.
        expect(resolveGoalActionCapabilities(null, { canEdit: true, canStop: false, canClear: true, canConfigureBudget: false })).toEqual({
            canEdit: true,
            canStop: false,
            canClear: true,
            canConfigureBudget: false,
        });
    });

    it('intersects goal-item capabilities with a supplied runtime capability profile', () => {
        // Provider metadata describes semantic support, while the session profile describes the
        // controls the attached runtime can execute. Neither signal can grant an action alone.
        expect(resolveGoalActionCapabilities(
            goal({ goalCapabilities: { canEdit: true, canStop: true, canClear: true } }),
            { canEdit: false, canStop: false, canClear: true, canConfigureBudget: false },
        )).toEqual({
            canEdit: false,
            canStop: false,
            canClear: true,
            canConfigureBudget: false,
        });
    });

    it('exposes only edit and clear for Claude capabilities ({ canEdit, canClear })', () => {
        expect(resolveGoalActionCapabilities(goal({ goalCapabilities: { canEdit: true, canClear: true } }))).toEqual({
            canEdit: true,
            canStop: false,
            canClear: true,
            canConfigureBudget: false,
        });
    });

    it('ties pause/resume/complete and the token budget to canStop when capabilities are present', () => {
        const caps = resolveGoalActionCapabilities(goal({ goalCapabilities: { canEdit: true, canStop: true, canClear: true } }));
        expect(caps.canStop).toBe(true);
        expect(caps.canConfigureBudget).toBe(true);
    });

    it('treats an empty capabilities object as no declared controls', () => {
        expect(resolveGoalActionCapabilities(goal({ goalCapabilities: {} }))).toEqual({
            canEdit: false,
            canStop: false,
            canClear: false,
            canConfigureBudget: false,
        });
    });
});

describe('resolveGoalStatusLabelKey', () => {
    it('surfaces a muted "Interrupted" label for an active goal flagged interrupted (plan #9)', () => {
        expect(resolveGoalStatusLabelKey(goal({ status: 'active', statusReason: 'interrupted' })))
            .toBe('session.workState.goal.statusInterrupted');
    });

    it('does not override budget-limited with interrupted', () => {
        expect(resolveGoalStatusLabelKey(goal({ status: 'active', statusReason: 'budgetLimited' })))
            .toBe('session.workState.goal.statusBudgetLimited');
    });

    it.each(['blocked', 'usageLimited'] as const)('surfaces the generic blocked label while preserving the %s reason on the item', (statusReason) => {
        const item = goal({ status: 'blocked', statusReason });
        expect(resolveGoalStatusLabelKey(item)).toBe('session.workState.badge.goalBlocked');
        expect(item.statusReason).toBe(statusReason);
    });

    it('falls back to the active label with no status reason', () => {
        expect(resolveGoalStatusLabelKey(goal({ status: 'active' })))
            .toBe('session.workState.goal.statusActive');
    });
});
