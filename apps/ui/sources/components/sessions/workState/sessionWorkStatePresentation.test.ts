import { describe, expect, it } from 'vitest';

import {
    formatSessionWorkStateBadgeLabel,
    resolveSessionWorkStateStatusBadgePresentation,
} from './sessionWorkStatePresentation';

const translate = (key: string, params?: Record<string, unknown>) => `${key}:${params?.title ?? ''}`;

describe('sessionWorkStatePresentation', () => {
    it('keeps the badge hidden when editable goals are unavailable and no work state exists', () => {
        const presentation = (resolveSessionWorkStateStatusBadgePresentation as any)({
            primaryItem: null,
            activeStatusBadgeKey: 'work-state',
            editableGoal: false,
            translate,
        });

        expect(presentation).toBeNull();
    });

    it('keeps a transient editable goal badge anchor when /goal opens without existing work state', () => {
        const presentation = (resolveSessionWorkStateStatusBadgePresentation as any)({
            primaryItem: null,
            activeStatusBadgeKey: 'work-state',
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.goal.title:',
            tone: 'neutral',
            emphasis: 'quiet',
        });
    });

    it('uses quiet emphasis for ordinary active work state so it stays visible without badge chrome', () => {
        const presentation = (resolveSessionWorkStateStatusBadgePresentation as any)({
            primaryItem: {
                id: 'goal:thread-1',
                kind: 'goal',
                origin: 'vendor',
                status: 'active',
                title: 'Ship the release',
                updatedAt: 10,
            },
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.badge.goal:Ship the release',
            tone: 'active',
            emphasis: 'quiet',
        });
    });

    it('uses prominent emphasis for blocked work state that needs attention', () => {
        const presentation = (resolveSessionWorkStateStatusBadgePresentation as any)({
            primaryItem: {
                id: 'goal:thread-1',
                kind: 'goal',
                origin: 'vendor',
                status: 'blocked',
                title: 'Ship the release',
                updatedAt: 10,
            },
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.badge.goalBlocked:',
            tone: 'warning',
            emphasis: 'prominent',
        });
    });

    it('formats budget-limited goal badges distinctly from generic blocked goal badges', () => {
        expect(formatSessionWorkStateBadgeLabel({
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'blocked',
            statusReason: 'budgetLimited',
            title: 'Ship budget display',
            updatedAt: 20,
        }, translate)).toBe('session.workState.badge.goalBudgetLimited:');
    });
});
