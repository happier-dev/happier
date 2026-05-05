import { afterEach, describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import type { SessionListRenderableSession } from './sessionListRenderable';
import { computeVisibleSessionListIndex } from './computeVisibleSessionListIndex';

type OrderingMode = 'custom' | 'created' | 'updated';

function makeSessionRow(id: string, partial?: Partial<SessionListRenderableSession>): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        pendingVersion: undefined,
        pendingCount: undefined,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        owner: undefined,
        accessLevel: undefined,
        canApprovePermissions: undefined,
        hasPendingPermissionRequests: undefined,
        hasPendingUserActionRequests: undefined,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...(partial ?? {}),
    };
}

function makeResolver(rowsByKey: Record<string, SessionListRenderableSession>) {
    return (serverId: string | null | undefined, sessionId: string) => {
        const key = `${String(serverId ?? '').trim()}:${String(sessionId ?? '').trim()}`;
        return rowsByKey[key] ?? null;
    };
}

describe('computeVisibleSessionListIndex', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('returns the original array when custom ordering inputs are no-ops', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 20 }),
            's1:b': makeSessionRow('b', { createdAt: 20, updatedAt: 30 }),
        });

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [g]: [] },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result).toBe(source);
    });

    it('records visible compute telemetry with index counts', () => {
        syncPerformanceTelemetry.configure({ enabled: true });
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 20 }),
            's1:b': makeSessionRow('b', { createdAt: 20, updatedAt: 30 }),
        });

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result).toBe(source);
        expect(syncPerformanceTelemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.sessions.list.visible.compute',
                count: 1,
                fields: expect.objectContaining({
                    items: 3,
                    sessions: 2,
                    headers: 1,
                    fastPath: 1,
                    hideInactive: 0,
                    pins: 0,
                    customOrder: 0,
                    presentationEnabled: 0,
                    storageFilter: 0,
                }),
            }),
        ]);
    });

    it('keeps pinned sessions in their existing list order and normalizes pinned variants to default', () => {
        const g = 'server:s1:project:m1:/repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'project', variant: 'no-path' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'project', variant: 'no-path' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a'),
            's1:b': makeSessionRow('b'),
        });

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:a', 's1:b'],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result[0]).toMatchObject({ type: 'header', headerKind: 'pinned' });
        const pinnedSessions = result.filter((i) => i.type === 'session' && i.pinned === true) as Array<Extract<SessionListIndexItem, { type: 'session' }>>;
        expect(pinnedSessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
        expect(pinnedSessions.map((s) => s.variant)).toEqual(['default', 'default']);
    });

    it('orders sessions by updatedAt descending (with stable tie-breaks) when ordering mode is updated', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'd', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'c', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 200 }),
            's1:b': makeSessionRow('b', { createdAt: 30, updatedAt: 100 }),
            's1:c': makeSessionRow('c', { createdAt: 20, updatedAt: 100 }),
            's1:d': makeSessionRow('d', { createdAt: 20, updatedAt: 100 }),
        });

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [g]: ['s1:c', 's1:b'] },
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
        })!;

        const sessions = result.filter((i) => i.type === 'session') as Array<Extract<SessionListIndexItem, { type: 'session' }>>;
        expect(sessions.map((s) => s.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    });
});
