import { describe, expect, it } from 'vitest';

import { isSessionListRuntimePriorityRow } from './sessionListRuntimePriorityRows';

describe('isSessionListRuntimePriorityRow', () => {
    it('prioritizes canonical background activity without sourceClass or timestamp freshness inference', () => {
        const nowMs = 1_000_000;
        const row = {
            id: 'stale-runtime',
            active: false,
            presence: 'online',
            thinking: false,
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: nowMs - 10_000,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 300_000,
            runtimeActivityRevision: nowMs - 1,
        };

        expect(isSessionListRuntimePriorityRow(row, nowMs)).toBe(true);
    });

    it.each([
        ['offline', { presence: 123_456 }],
        ['archived', { archivedAt: 123_456 }],
    ])('does not prioritize %s background activity', (_label, overrides) => {
        const row = {
            active: false,
            presence: 'online',
            thinking: false,
            latestTurnStatus: 'completed' as const,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityRevision: 1,
            ...overrides,
        };

        expect(isSessionListRuntimePriorityRow(row, 1_000_000)).toBe(false);
    });
});
