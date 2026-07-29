import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
import {
    applySessionListWorkingPlacementWithinGroups,
    buildSessionListWorkingPlacement,
} from './sessionListAttentionPlacement';

function createRow(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'runtime-activity',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: 1,
        ...overrides,
    };
}

describe('applySessionListWorkingPlacementWithinGroups', () => {
    it('places completed background activity at the front of its group', () => {
        const nowMs = 1_000_000;
        const source = [
            { type: 'session', serverId: 'server-a', sessionId: 'fresh-runtime', groupKey: 'project-a', groupKind: 'project' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        const result = applySessionListWorkingPlacementWithinGroups({
            source,
            options: { mode: 'withinGroups' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'fresh-runtime',
                latestTurnStatusObservedAt: nowMs - 10_000,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 1_000,
                runtimeActivityRevision: nowMs + 60_000,
            }),
        });

        expect(result).toEqual([
            expect.objectContaining({
                type: 'session',
                sessionId: 'fresh-runtime',
                workingPlacementReason: 'working',
                keepVisibleWhenInactive: true,
            }),
        ]);
    });

    it('keeps canonical background activity in working placement without timestamp freshness inference', () => {
        const nowMs = 1_000_000;
        const source = [
            { type: 'session', serverId: 'server-a', sessionId: 'stale-runtime', groupKey: 'project-a', groupKind: 'project' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        const result = applySessionListWorkingPlacementWithinGroups({
            source,
            options: { mode: 'withinGroups' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'stale-runtime',
                active: true,
                presence: 'online',
                latestTurnStatusObservedAt: nowMs - 10_000,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 300_000,
                runtimeActivityRevision: nowMs - 1,
            }),
        });

        expect(result).toEqual([
            expect.objectContaining({
                type: 'session',
                sessionId: 'stale-runtime',
                workingPlacementReason: 'working',
                keepVisibleWhenInactive: true,
            }),
        ]);
    });

    it.each([
        ['offline', { presence: 123_456 }],
        ['archived', { archivedAt: 123_456 }],
    ])('does not place %s background activity in working rows', (_label, overrides) => {
        const nowMs = 1_000_000;
        const source = [
            { type: 'session', serverId: 'server-a', sessionId: 'inactive-runtime', groupKey: 'project-a', groupKind: 'project' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        const result = applySessionListWorkingPlacementWithinGroups({
            source,
            options: { mode: 'withinGroups' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'inactive-runtime',
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityRevision: 1,
                ...overrides,
            }),
        });

        expect(result).toBe(source);
    });
});

describe('buildSessionListWorkingPlacement', () => {
    it('promotes background activity ahead of completed-turn ready placement', () => {
        const nowMs = 1_000_000;
        const source = [
            { type: 'session', serverId: 'server-a', sessionId: 'fresh-runtime', groupKey: 'project-a', groupKind: 'project' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        const result = buildSessionListWorkingPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'fresh-runtime',
                latestTurnStatusObservedAt: nowMs - 10_000,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 1_000,
                runtimeActivityRevision: nowMs + 60_000,
            }),
        });

        expect(result).toMatchObject({
            promotedCount: 1,
            workingItems: [
                expect.objectContaining({ type: 'header', headerKind: 'working' }),
                expect.objectContaining({
                    type: 'session',
                    sessionId: 'fresh-runtime',
                    groupKind: 'working',
                    workingPlacementReason: 'working',
                }),
            ],
            remainder: [],
        });
    });

});
