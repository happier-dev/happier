import { describe, expect, it } from 'vitest';

import {
    readSessionWorkStateFromMetadata,
    resolvePrimarySessionWorkStateItem,
} from './readSessionWorkState';

describe('readSessionWorkStateFromMetadata', () => {
    it('reads canonical sessionWorkStateV1 metadata and resolves primaryItemId first', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:codex',
                items: [
                    { id: 'todo:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Run tests', updatedAt: 9 },
                    { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Migrate plugin support', updatedAt: 10 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('goal:codex');
    });

    it('falls back defensively when primaryItemId is stale', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'opencode',
                updatedAt: 10,
                primaryItemId: 'missing',
                items: [
                    { id: 'goal:1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Goal text', updatedAt: 8 },
                    { id: 'todo:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Update permissions', updatedAt: 9 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('todo:1');
    });

    it('does not pick paused or completed items as compact fallback badges', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'missing',
                items: [
                    { id: 'task:paused', kind: 'task', origin: 'vendor', status: 'paused', title: 'Paused work', updatedAt: 9 },
                    { id: 'todo:done', kind: 'todo', origin: 'vendor', status: 'complete', title: 'Done work', updatedAt: 8 },
                    { id: 'goal:cancelled', kind: 'goal', origin: 'vendor', status: 'cancelled', title: 'Cancelled goal', updatedAt: 7 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)).toBeNull();
    });

    it('ignores malformed canonical metadata safely', () => {
        expect(readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                items: [
                    { id: '', kind: 'goal', origin: 'vendor', status: 'active', title: 'Missing id', updatedAt: 10 },
                ],
            },
        })).toBeNull();
    });

    it('normalizes legacy goal metadata only at the read edge', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            flavor: 'codex',
            sessionGoalV1: {
                objective: 'Ship goals',
                status: 'paused',
                updatedAt: 12,
            },
        });

        expect(snapshot?.backendId).toBe('codex');
        expect(snapshot?.items[0]).toEqual(expect.objectContaining({
            id: 'goal:legacy',
            kind: 'goal',
            status: 'paused',
            title: 'Ship goals',
        }));
    });

    it('keeps displayable canonical items when future items are preserved in metadata', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:thread-1',
                items: [
                    { id: 'future:1', kind: 'milestone', origin: 'future', status: 'waiting', title: 'Future item', updatedAt: 10 },
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('goal:thread-1');
    });

    it('keeps displayable canonical items when future items use a different item shape', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:thread-1',
                items: [
                    { id: 'future:1', label: 'Future item', state: 'waiting' },
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('goal:thread-1');
    });

    it('ignores canonical metadata with invalid root timestamps', () => {
        expect(readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: -1,
                items: [
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        })).toBeNull();
    });

    it('uses the canonical protocol reader for integer timestamp validation', () => {
        expect(readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10.5,
                items: [
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        })).toBeNull();
    });

    it('preserves precise budget-limited status reason and time fields from canonical metadata', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 20,
                primaryItemId: 'goal:thread-1',
                items: [
                    {
                        id: 'goal:thread-1',
                        kind: 'goal',
                        origin: 'vendor',
                        status: 'blocked',
                        statusReason: 'budgetLimited',
                        title: 'Ship budget display',
                        createdAt: 11,
                        startedAt: 12,
                        completedAt: 19,
                        updatedAt: 20,
                    },
                ],
            },
        });

        expect(snapshot?.items[0]).toEqual(expect.objectContaining({
            status: 'blocked',
            statusReason: 'budgetLimited',
            createdAt: 11,
            startedAt: 12,
            completedAt: 19,
        }));
    });
});
