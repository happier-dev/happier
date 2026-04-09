import { describe, expect, it, vi } from 'vitest';

describe('normalizeSessionListServerScope', () => {
    it('trims the server fields and collapses blank ids to null', async () => {
        const { normalizeSessionListServerScope } = await import('./normalizeSessionListServerScope');
        const first = normalizeSessionListServerScope('  server-a  ', '  Server A  ');
        const second = normalizeSessionListServerScope('server-a', 'Server A');

        expect(first).toBe(second);
        expect(first).toEqual({
            serverId: 'server-a',
            serverName: 'Server A',
        });

        const blankFirst = normalizeSessionListServerScope('   ', '   ');
        const blankSecond = normalizeSessionListServerScope('', null);

        expect(blankFirst).toBe(blankSecond);
        expect(blankFirst).toEqual({
            serverId: null,
            serverName: null,
        });
    });

    it('bounds the normalized server scope cache via LRU eviction', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SESSION_LIST_SERVER_SCOPE_CACHE_MAX', '2');
        vi.resetModules();

        try {
            const { normalizeSessionListServerScope } = await import('./normalizeSessionListServerScope');

            const first = normalizeSessionListServerScope('server-a', 'Server A');
            const second = normalizeSessionListServerScope('server-b', 'Server B');

            // Touch first so second becomes the LRU entry.
            expect(normalizeSessionListServerScope('server-a', 'Server A')).toBe(first);

            normalizeSessionListServerScope('server-c', 'Server C');

            expect(normalizeSessionListServerScope('server-a', 'Server A')).toBe(first);
            expect(normalizeSessionListServerScope('server-b', 'Server B')).not.toBe(second);
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });
});
