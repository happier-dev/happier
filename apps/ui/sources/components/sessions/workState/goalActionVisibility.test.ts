import { describe, expect, it } from 'vitest';

import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';

import { canPauseOrResumeGoal, resolveGoalActionCapabilities, resolveGoalStatusLabelKey } from './goalActionVisibility';

function goal(overrides: Partial<SessionWorkStateItem> = {}): SessionWorkStateItem {
    return {
        id: 'goal:test',
        kind: 'goal',
        origin: 'vendor',
        status: 'active',
        title: 'A goal',
        updatedAt: 1,
        ...overrides,
    };
}

describe('resolveGoalActionCapabilities', () => {
    it('grants the full Codex-style control surface when goalCapabilities is absent', () => {
        expect(resolveGoalActionCapabilities(goal())).toEqual({
            canEdit: true,
            canStop: true,
            canClear: true,
            canConfigureBudget: true,
        });
        expect(resolveGoalActionCapabilities(null)).toEqual({
            canEdit: true,
            canStop: true,
            canClear: true,
            canConfigureBudget: true,
        });
    });

    it('exposes only the declared controls when goalCapabilities is present (Claude = edit/clear only)', () => {
        expect(resolveGoalActionCapabilities(goal({ goalCapabilities: { canEdit: true, canClear: true } }))).toEqual({
            canEdit: true,
            canStop: false,
            canClear: true,
            // Budget configuration follows canStop (a Codex lifecycle affordance Claude does not have).
            canConfigureBudget: false,
        });
    });

    it('ties budget configuration to canStop', () => {
        expect(resolveGoalActionCapabilities(goal({ goalCapabilities: { canStop: true } })).canConfigureBudget).toBe(true);
        expect(resolveGoalActionCapabilities(goal({ goalCapabilities: { canEdit: true } })).canConfigureBudget).toBe(false);
    });

    // QA-CHIP-2: the "Set goal" form has NO goal item yet, so without a provider fallback the resolver
    // returned the full Codex surface → the budget editor leaked onto a fresh Claude session.
    it('uses a provider fallback profile when no goal item carries capabilities (Set-goal form)', () => {
        const claudeProfile = { canEdit: true, canStop: false, canClear: true, canConfigureBudget: false } as const;
        expect(resolveGoalActionCapabilities(null, claudeProfile)).toEqual(claudeProfile);
    });

    it('prefers the goal item capabilities over a supplied fallback profile when both exist', () => {
        const fullProfile = { canEdit: true, canStop: true, canClear: true, canConfigureBudget: true } as const;
        // A Claude goal item present → goal-item capabilities win (edit/clear only), fallback ignored.
        expect(resolveGoalActionCapabilities(goal({ goalCapabilities: { canEdit: true, canClear: true } }), fullProfile)).toEqual({
            canEdit: true,
            canStop: false,
            canClear: true,
            canConfigureBudget: false,
        });
    });

    it('falls back to the full control surface when neither a goal item nor a profile is supplied', () => {
        expect(resolveGoalActionCapabilities(null)).toEqual({
            canEdit: true,
            canStop: true,
            canClear: true,
            canConfigureBudget: true,
        });
        expect(resolveGoalActionCapabilities(null, null)).toEqual({
            canEdit: true,
            canStop: true,
            canClear: true,
            canConfigureBudget: true,
        });
    });
});

describe('canPauseOrResumeGoal', () => {
    it('is true only for active or paused goals', () => {
        expect(canPauseOrResumeGoal(goal({ status: 'active' }))).toBe(true);
        expect(canPauseOrResumeGoal(goal({ status: 'paused' }))).toBe(true);
        expect(canPauseOrResumeGoal(goal({ status: 'complete' }))).toBe(false);
        expect(canPauseOrResumeGoal(null)).toBe(false);
    });
});

describe('resolveGoalStatusLabelKey', () => {
    it('surfaces "Interrupted" for an active goal flagged interrupted (status stays active)', () => {
        expect(resolveGoalStatusLabelKey(goal({ status: 'active', statusReason: 'interrupted' })))
            .toBe('session.workState.goal.statusInterrupted');
    });

    it('prefers budgetLimited over interrupted and falls back to plain status keys', () => {
        expect(resolveGoalStatusLabelKey(goal({ status: 'active', statusReason: 'budgetLimited' })))
            .toBe('session.workState.goal.statusBudgetLimited');
        // interrupted only applies while the goal is still active.
        expect(resolveGoalStatusLabelKey(goal({ status: 'paused', statusReason: 'interrupted' })))
            .toBe('session.workState.goal.statusPaused');
        expect(resolveGoalStatusLabelKey(goal({ status: 'active' })))
            .toBe('session.workState.goal.statusActive');
        expect(resolveGoalStatusLabelKey(goal({ status: 'complete' })))
            .toBe('session.workState.goal.statusComplete');
    });
});
