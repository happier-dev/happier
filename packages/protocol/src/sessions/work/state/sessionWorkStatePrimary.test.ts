import { describe, expect, it } from 'vitest';

import { resolveSessionWorkStatePrimaryItemId } from './sessionWorkStatePrimary.js';
import type { SessionWorkStateWriteItemV1 } from './sessionWorkStateV1.js';

function item(partial: Partial<SessionWorkStateWriteItemV1> & Readonly<{ id: string; kind: string; status: string }>): SessionWorkStateWriteItemV1 {
    return {
        origin: 'vendor',
        title: partial.id,
        updatedAt: 1,
        ...partial,
    } as SessionWorkStateWriteItemV1;
}

describe('resolveSessionWorkStatePrimaryItemId', () => {
    it('returns null for an empty set', () => {
        expect(resolveSessionWorkStatePrimaryItemId([])).toBe(null);
    });

    it('prefers an active task over an active todo and an active goal regardless of order', () => {
        const items = [
            item({ id: 'goal:1', kind: 'goal', status: 'active' }),
            item({ id: 'todo:1', kind: 'todo', status: 'active' }),
            item({ id: 'task:1', kind: 'task', status: 'active' }),
        ];
        expect(resolveSessionWorkStatePrimaryItemId(items)).toBe('task:1');
        // Source-order independence: shuffling the items yields the same primary.
        expect(resolveSessionWorkStatePrimaryItemId([...items].reverse())).toBe('task:1');
    });

    it('prefers an active todo over an active goal', () => {
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'goal:1', kind: 'goal', status: 'active' }),
            item({ id: 'todo:1', kind: 'todo', status: 'active' }),
        ])).toBe('todo:1');
    });

    it('falls back to an active goal when no active task/todo exists', () => {
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'todo:1', kind: 'todo', status: 'complete' }),
            item({ id: 'goal:1', kind: 'goal', status: 'active' }),
        ])).toBe('goal:1');
    });

    it('falls back to blocked, then paused, then pending, then first', () => {
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'a', kind: 'todo', status: 'pending' }),
            item({ id: 'b', kind: 'todo', status: 'paused' }),
            item({ id: 'c', kind: 'todo', status: 'blocked' }),
        ])).toBe('c');
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'a', kind: 'todo', status: 'pending' }),
            item({ id: 'b', kind: 'todo', status: 'paused' }),
        ])).toBe('b');
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'a', kind: 'todo', status: 'complete' }),
            item({ id: 'b', kind: 'todo', status: 'pending' }),
        ])).toBe('b');
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'a', kind: 'goal', status: 'complete' }),
            item({ id: 'b', kind: 'goal', status: 'cancelled' }),
        ])).toBe('a');
    });

    it('preserves the current primary while it is still a present task/todo (stability)', () => {
        const items = [
            item({ id: 'task:1', kind: 'task', status: 'active' }),
            item({ id: 'task:2', kind: 'task', status: 'active' }),
        ];
        // Without stability the first active task wins; with it the current one is kept.
        expect(resolveSessionWorkStatePrimaryItemId(items, 'task:2')).toBe('task:2');
    });

    it('does NOT preserve a current GOAL primary when a higher-priority active task/todo exists', () => {
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'goal:1', kind: 'goal', status: 'active' }),
            item({ id: 'todo:1', kind: 'todo', status: 'active' }),
        ], 'goal:1')).toBe('todo:1');
    });

    it('does NOT preserve a COMPLETED current task over an active goal (G4 status-rank fix)', () => {
        // The completed task is still present and is a task/todo, but stability is a same-priority
        // tie-break — it must not pin the badge over a higher-priority active goal.
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'task:1', kind: 'task', status: 'complete' }),
            item({ id: 'goal:1', kind: 'goal', status: 'active' }),
        ], 'task:1')).toBe('goal:1');
    });

    it('does NOT preserve a CANCELLED current todo over an active task (G4 status-rank fix)', () => {
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'todo:1', kind: 'todo', status: 'cancelled' }),
            item({ id: 'task:1', kind: 'task', status: 'active' }),
        ], 'todo:1')).toBe('task:1');
    });

    it('does NOT preserve a completed current task over a blocked task (workflow-ready)', () => {
        // Forward-looking guard for workflow support: a completed/terminal current item must never
        // hide a blocked/active item that still needs attention.
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'task:done', kind: 'task', status: 'complete' }),
            item({ id: 'task:blocked', kind: 'task', status: 'blocked' }),
        ], 'task:done')).toBe('task:blocked');
    });

    it('preserves a blocked current task against another blocked task (same-priority tie-break)', () => {
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'task:1', kind: 'task', status: 'blocked' }),
            item({ id: 'task:2', kind: 'task', status: 'blocked' }),
        ], 'task:2')).toBe('task:2');
    });

    it('drops a current primary that is no longer present', () => {
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'task:1', kind: 'task', status: 'active' }),
        ], 'task:gone')).toBe('task:1');
    });

    it('prefers a just-published item within the same priority bucket (recency tie-break)', () => {
        const items = [
            item({ id: 'goal:stale', kind: 'goal', status: 'active' }),
            item({ id: 'goal:fresh', kind: 'goal', status: 'active' }),
        ];
        // Both active goals; the freshly-published one wins the tie.
        expect(resolveSessionWorkStatePrimaryItemId(items, null, { preferItemIds: ['goal:fresh'] })).toBe('goal:fresh');
        // Without the hint, document order decides.
        expect(resolveSessionWorkStatePrimaryItemId(items)).toBe('goal:stale');
    });

    it('never lets the recency tie-break override priority (active task beats a just-set goal)', () => {
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: 'task:active', kind: 'task', status: 'active' }),
            item({ id: 'goal:fresh', kind: 'goal', status: 'active' }),
        ], null, { preferItemIds: ['goal:fresh'] })).toBe('task:active');
    });

    it('ignores items without an id', () => {
        expect(resolveSessionWorkStatePrimaryItemId([
            item({ id: '', kind: 'task', status: 'active' }),
            item({ id: 'task:2', kind: 'task', status: 'active' }),
        ])).toBe('task:2');
    });
});
