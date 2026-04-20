import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';

import {
    resolveServerIdForSessionIdFromLocalState,
    resolveServerIdForSessionIdFromSessionListCache,
} from './resolveServerIdForSessionIdFromLocalCache';

function createSession(id: string, serverId?: string) {
    return {
        id,
        serverId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        pendingVersion: 1,
        pendingCount: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
    };
}

function createRenderableSession(id: string, serverId: string) {
    return buildSessionListRenderableFromSession(createSession(id, serverId));
}

describe('resolveServerIdForSessionIdFromSessionListCache', () => {
    const makeIndexSessionItem = (sessionId: string, serverId: string): SessionListIndexItem => ({
        type: 'session',
        sessionId,
        serverId,
        serverName: serverId,
    });

    it('returns the matching serverId when the session appears in the cached index', () => {
        const indexByServerId: Record<string, SessionListIndexItem[] | null> = {
            'server-a': [makeIndexSessionItem('s1', 'server-a')],
            'server-b': [makeIndexSessionItem('s2', 'server-b')],
        };

        expect(resolveServerIdForSessionIdFromSessionListCache(indexByServerId, 's1')).toBe('server-a');
        expect(resolveServerIdForSessionIdFromSessionListCache(indexByServerId, 's2')).toBe('server-b');
    });

    it('returns null when the cache is empty or the session id is not found', () => {
        expect(resolveServerIdForSessionIdFromSessionListCache({}, 's1')).toBeNull();
        expect(resolveServerIdForSessionIdFromSessionListCache({ 'server-a': null }, 's1')).toBeNull();
    });
});

describe('resolveServerIdForSessionIdFromLocalState', () => {
    it('prefers the session map serverId when available', () => {
        const state = {
            sessions: {
                s1: { serverId: 'server-a' },
            },
            sessionListIndexByServerId: {
                'server-b': [{ type: 'session', sessionId: 's1', serverId: 'server-b', serverName: 'B' }],
            },
            concurrentSessionListCacheByServerId: null,
        } satisfies Parameters<typeof resolveServerIdForSessionIdFromLocalState>[0];

        expect(resolveServerIdForSessionIdFromLocalState(state, 's1')).toBe('server-a');
    });

    it('falls back to the concurrent session cache when the session map is missing', () => {
        const concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId = {
            'server-c': {
                serverName: 'C',
                sessions: {
                    s3: createRenderableSession('s3', 'server-c'),
                },
            },
        };

        const state = {
            sessions: {},
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId,
        } satisfies Parameters<typeof resolveServerIdForSessionIdFromLocalState>[0];

        expect(resolveServerIdForSessionIdFromLocalState(state, 's3')).toBe('server-c');
    });

    it('falls back to the session list index when both the session map and concurrent cache are missing', () => {
        const state = {
            sessions: {},
            sessionListIndexByServerId: {
                'server-d': [{ type: 'session', sessionId: 's4', serverId: 'server-d', serverName: 'D' }],
            },
            concurrentSessionListCacheByServerId: {},
        } satisfies Parameters<typeof resolveServerIdForSessionIdFromLocalState>[0];

        expect(resolveServerIdForSessionIdFromLocalState(state, 's4')).toBe('server-d');
    });
});
