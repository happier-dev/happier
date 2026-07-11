import { describe, expect, it } from 'vitest';

import {
    omitGoalItemFromSnapshot,
    resolveCurrentGoalItem,
    resolveEditableGoalItem,
    resolveGoalCreationControlsVisible,
    resolveGoalManagementControlsVisible,
} from './sessionGoalSelectors';
import type {
    SessionWorkStateItem,
    SessionWorkStateSnapshot,
} from '@/sync/domains/session/workState/sessionWorkStateTypes';

function item(partial: Partial<SessionWorkStateItem> & Pick<SessionWorkStateItem, 'id' | 'kind' | 'status'>): SessionWorkStateItem {
    return {
        origin: 'vendor',
        title: partial.title ?? partial.id,
        updatedAt: 1,
        ...partial,
    };
}

function snapshot(items: SessionWorkStateItem[], primaryItemId?: string | null): SessionWorkStateSnapshot {
    return {
        v: 1,
        backendId: 'claude',
        updatedAt: 1,
        items,
        ...(primaryItemId !== undefined ? { primaryItemId } : {}),
    };
}

describe('resolveEditableGoalItem', () => {
    it('returns the first goal item regardless of status (edit target)', () => {
        const goal = item({ id: 'goal:claude', kind: 'goal', status: 'complete', title: 'Done goal' });
        expect(resolveEditableGoalItem(snapshot([goal]))?.id).toBe('goal:claude');
    });

    it('uses the primary goal item instead of the first preserved foreign goal', () => {
        const foreign = item({ id: 'goal:foreign', kind: 'goal', status: 'complete', backendId: 'codex', title: 'Old goal' });
        const current = item({ id: 'goal:claude', kind: 'goal', status: 'active', backendId: 'claude', title: 'Current goal' });

        expect(resolveEditableGoalItem(snapshot([foreign, current], 'goal:claude'))?.id).toBe('goal:claude');
    });

    it('prefers an active goal for the snapshot backend over a completed foreign goal', () => {
        const foreign = item({ id: 'goal:foreign', kind: 'goal', status: 'complete', backendId: 'codex', title: 'Old goal' });
        const current = item({ id: 'goal:claude', kind: 'goal', status: 'active', backendId: 'claude', title: 'Current goal' });

        expect(resolveEditableGoalItem(snapshot([foreign, current]))?.id).toBe('goal:claude');
    });

    it('uses newest updatedAt as a deterministic tie-break inside canonical goal candidates', () => {
        const older = item({ id: 'goal:older', kind: 'goal', status: 'active', backendId: 'claude', updatedAt: 10 });
        const newer = item({ id: 'goal:newer', kind: 'goal', status: 'active', backendId: 'claude', updatedAt: 20 });

        expect(resolveEditableGoalItem(snapshot([older, newer]))?.id).toBe('goal:newer');
    });

    it('returns null when there is no goal item', () => {
        expect(resolveEditableGoalItem(snapshot([item({ id: 'todo:1', kind: 'todo', status: 'active' })]))).toBeNull();
        expect(resolveEditableGoalItem(null)).toBeNull();
    });
});

describe('resolveCurrentGoalItem', () => {
    it('returns only an active goal as current', () => {
        expect(resolveCurrentGoalItem(snapshot([item({ id: 'goal:claude', kind: 'goal', status: 'active', title: 'Ship' })]))?.title).toBe('Ship');
    });

    it('does not treat paused/cancelled/completed goals as current', () => {
        for (const status of ['paused', 'cancelled', 'complete'] as const) {
            expect(resolveCurrentGoalItem(snapshot([item({ id: 'goal:claude', kind: 'goal', status })]))).toBeNull();
        }
    });
});

describe('goal control visibility', () => {
    it('keeps the explicit goal-chip creation surface available whenever goal editing is available', () => {
        expect(resolveGoalCreationControlsVisible({ editableGoal: false })).toBe(false);
        expect(resolveGoalCreationControlsVisible({ editableGoal: true })).toBe(true);
    });

    it('hides goal management controls when there is no goal item', () => {
        expect(resolveGoalManagementControlsVisible({ editableGoal: true, snapshot: null })).toBe(false);
        expect(resolveGoalManagementControlsVisible({ editableGoal: true, snapshot: snapshot([]) })).toBe(false);
    });

    it('renders management controls when a goal item exists', () => {
        expect(resolveGoalManagementControlsVisible({
            editableGoal: true,
            snapshot: snapshot([item({ id: 'goal:1', kind: 'goal', status: 'active' })]),
        })).toBe(true);
    });

    it('does not render management controls when editing is unavailable or no goal exists', () => {
        expect(resolveGoalManagementControlsVisible({
            editableGoal: false,
            snapshot: snapshot([item({ id: 'goal:1', kind: 'goal', status: 'active' })]),
        })).toBe(false);
        expect(resolveGoalManagementControlsVisible({
            editableGoal: true,
            snapshot: snapshot([item({ id: 'task:1', kind: 'task', status: 'active' })], 'task:1'),
        })).toBe(false);
    });
});

describe('omitGoalItemFromSnapshot', () => {
    it('removes only the goal row and preserves the non-goal items', () => {
        const result = omitGoalItemFromSnapshot(
            snapshot([
                item({ id: 'goal:1', kind: 'goal', status: 'active' }),
                item({ id: 'task:1', kind: 'task', status: 'active' }),
                item({ id: 'todo:1', kind: 'todo', status: 'pending' }),
            ], 'goal:1'),
            'goal:1',
        );
        expect(result?.items.map((i) => i.id)).toEqual(['task:1', 'todo:1']);
        // Primary cleared because it pointed at the omitted goal.
        expect(result?.primaryItemId).toBeNull();
    });

    it('keeps primaryItemId when it points at a non-goal item', () => {
        const result = omitGoalItemFromSnapshot(
            snapshot([
                item({ id: 'goal:1', kind: 'goal', status: 'active' }),
                item({ id: 'task:1', kind: 'task', status: 'active' }),
            ], 'task:1'),
            'goal:1',
        );
        expect(result?.primaryItemId).toBe('task:1');
    });

    it('returns the snapshot unchanged when there is nothing to omit', () => {
        const snap = snapshot([item({ id: 'task:1', kind: 'task', status: 'active' })]);
        expect(omitGoalItemFromSnapshot(snap, 'goal:absent')).toBe(snap);
        expect(omitGoalItemFromSnapshot(snap, null)).toBe(snap);
        expect(omitGoalItemFromSnapshot(null, 'goal:1')).toBeNull();
    });
});
