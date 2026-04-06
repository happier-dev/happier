import { describe, expect, it, vi } from 'vitest';

import {
    clearServerSessionListCache,
    setServerSessionListCache,
} from './sessionListCache';

describe('sessionListCache helpers', () => {
    it('sets cache for explicit server id', () => {
        const current = { existing: null };
        const next = setServerSessionListCache(current, 'server-b', []);
        expect(next).toEqual({ existing: null, 'server-b': [] });
    });

    it('keeps the cache reference when setting the same list reference for a server', () => {
        const shared = [] as const;
        const current = { existing: null, 'server-b': shared };

        expect(setServerSessionListCache(current, 'server-b', shared as unknown as []))
            .toBe(current);
    });

    it('keeps the cache reference when setting a structurally identical list for a server', () => {
        const currentList = [
            {
                type: 'header',
                title: 'Server B',
                headerKind: 'server',
                serverId: 'server-b',
                serverName: 'Server B',
            },
            {
                type: 'session',
                session: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    pendingVersion: 1,
                    pendingCount: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    optimisticThinkingAt: null,
                    thinkingGraceUntil: null,
                    owner: null,
                    accessLevel: null,
                    canApprovePermissions: false,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
                serverId: 'server-b',
                serverName: 'Server B',
            },
        ] as const;
        const nextList = [
            { ...currentList[0] },
            {
                ...currentList[1],
                session: { ...currentList[1].session },
            },
        ];
        const current = { existing: null, 'server-b': currentList as unknown as [] };

        expect(setServerSessionListCache(current, 'server-b', nextList as unknown as []))
            .toBe(current);
    });

    it('clears a server cache entry when present', () => {
        const current = { existing: null, 'server-b': [] };
        expect(clearServerSessionListCache(current, 'server-b')).toEqual({ existing: null });
    });

    it('reuses the shared empty cache reference when clearing the last server entry', () => {
        const current = { 'server-b': [] };
        const cleared = clearServerSessionListCache(current, 'server-b');

        expect(cleared).toEqual({});
        expect(cleared).toBe(clearServerSessionListCache(undefined, 'server-b'));
    });

    it('keeps the cache reference when clearing a missing or blank server id', () => {
        const current = { existing: null };
        expect(clearServerSessionListCache(current, '')).toBe(current);
        expect(clearServerSessionListCache(current, 'missing')).toBe(current);
    });

    it('treats a missing cache object as empty when clearing a server id', () => {
        expect(clearServerSessionListCache(undefined, 'server-b')).toEqual({});
    });

    it('reuses the shared empty cache reference when clearing a missing cache object repeatedly', () => {
        const first = clearServerSessionListCache(undefined, 'server-b');
        const second = clearServerSessionListCache(undefined, 'server-b');

        expect(first).toBe(second);
    });
});
