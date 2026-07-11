import { describe, expect, it } from 'vitest';

import {
    IDLE_GOAL_CONFIRMATION,
    beginGoalConfirmation,
    goalSignature,
    isNoOpGoalMutation,
    markGoalConfirmationSlow,
    resolveGoalConfirmation,
} from './sessionGoalMutationModel';
import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';

function goal(partial: Partial<SessionWorkStateItem> & Pick<SessionWorkStateItem, 'status'>): SessionWorkStateItem {
    return {
        id: 'goal:claude',
        kind: 'goal',
        origin: 'vendor',
        title: 'Ship goals',
        updatedAt: 10,
        ...partial,
    };
}

describe('goalSignature', () => {
    it('changes when any salient field changes and is empty for no goal', () => {
        expect(goalSignature(null)).toBe('');
        const base = goal({ status: 'active' });
        expect(goalSignature(base)).toBe(goalSignature(goal({ status: 'active' })));
        expect(goalSignature(base)).not.toBe(goalSignature(goal({ status: 'paused' })));
        expect(goalSignature(base)).not.toBe(goalSignature(goal({ status: 'active', title: 'New title' })));
        expect(goalSignature(base)).not.toBe(goalSignature(goal({ status: 'active', updatedAt: 11 })));
    });
});

describe('isNoOpGoalMutation', () => {
    it('treats an identical-objective active request as a no-op (does not strand pending)', () => {
        expect(isNoOpGoalMutation(goal({ status: 'active' }), { objective: '  Ship goals  ' })).toBe(true);
    });

    it('is not a no-op when the objective changes, the status transitions, or a budget is set', () => {
        const active = goal({ status: 'active' });
        expect(isNoOpGoalMutation(active, { objective: 'Different' })).toBe(false);
        expect(isNoOpGoalMutation(active, { objective: 'Ship goals', status: 'paused' })).toBe(false);
        expect(isNoOpGoalMutation(active, { tokenBudget: 1000 })).toBe(false);
    });

    it('treats a same-status-only request as a no-op and a different-status request as a change', () => {
        expect(isNoOpGoalMutation(goal({ status: 'paused' }), { status: 'paused' })).toBe(true);
        expect(isNoOpGoalMutation(goal({ status: 'paused' }), { status: 'active' })).toBe(false);
    });

    it('is never a no-op when there is no existing goal', () => {
        expect(isNoOpGoalMutation(null, { objective: 'Ship goals' })).toBe(false);
    });
});

describe('goal confirmation state machine', () => {
    it('begins pending (not slow) from a captured baseline signature', () => {
        const state = beginGoalConfirmation('goal:1|Ship|active||10');
        expect(state).toEqual({ phase: 'pending', baseline: 'goal:1|Ship|active||10', slow: false });
    });

    it('marks a pending confirmation slow, and is idempotent / a no-op off the pending phase', () => {
        const pending = beginGoalConfirmation('sig');
        const slow = markGoalConfirmationSlow(pending);
        expect(slow).toEqual({ phase: 'pending', baseline: 'sig', slow: true });
        // Idempotent: re-marking an already-slow state returns the same reference.
        expect(markGoalConfirmationSlow(slow)).toBe(slow);
        // Off the pending phase there is nothing to slow.
        expect(markGoalConfirmationSlow(IDLE_GOAL_CONFIRMATION)).toBe(IDLE_GOAL_CONFIRMATION);
    });

    it('resolves to idle only once the work-state signature moves off the pending baseline', () => {
        const pending = beginGoalConfirmation('sig');
        // Signature unchanged → still pending (same reference).
        expect(resolveGoalConfirmation(pending, 'sig')).toBe(pending);
        // Signature changed → confirmed → idle.
        expect(resolveGoalConfirmation(pending, 'sig-2')).toBe(IDLE_GOAL_CONFIRMATION);
        // A slow-pending confirmation still resolves when the signature finally moves.
        expect(resolveGoalConfirmation(markGoalConfirmationSlow(pending), 'sig-2')).toBe(IDLE_GOAL_CONFIRMATION);
        // Idle stays idle regardless of signature.
        expect(resolveGoalConfirmation(IDLE_GOAL_CONFIRMATION, 'anything')).toBe(IDLE_GOAL_CONFIRMATION);
    });
});
