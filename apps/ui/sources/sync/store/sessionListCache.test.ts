import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'active-server',
        serverUrl: 'https://active.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

import { setActiveServerSessionListCache, setServerSessionListCache } from './sessionListCache';

describe('sessionListCache helpers', () => {
    it('sets cache for explicit server id', () => {
        const current = { existing: null };
        const next = setServerSessionListCache(current, 'server-b', []);
        expect(next).toEqual({ existing: null, 'server-b': [] });
    });

    it('sets cache for active server id', () => {
        const current = { existing: null };
        const next = setActiveServerSessionListCache(current, []);
        expect(next).toEqual({ existing: null, 'active-server': [] });
    });
});
