import { describe, expect, it, vi } from 'vitest';

describe('sessionListKeyNormalization', () => {
    it('normalizes server and session keys from the same canonical parts helper', async () => {
        const { normalizeSessionListKeyParts } = await import('./sessionListKeyNormalization');
        const parts = normalizeSessionListKeyParts('  server-a  ', '  session-1  ');

        expect(parts).toEqual({
            serverId: 'server-a',
            sessionId: 'session-1',
            serverKey: 'server-a',
            sessionKey: 'server-a:session-1',
        });
    });

    it('reuses the same normalized key parts object for repeated canonical inputs', async () => {
        const { normalizeSessionListKeyParts } = await import('./sessionListKeyNormalization');
        const first = normalizeSessionListKeyParts(' server-a ', ' session-1 ');
        const second = normalizeSessionListKeyParts('server-a', 'session-1');

        expect(first).toBe(second);
        expect(first).toEqual({
            serverId: 'server-a',
            sessionId: 'session-1',
            serverKey: 'server-a',
            sessionKey: 'server-a:session-1',
        });
    });

    it('reuses the shared empty server key and omits invalid session keys', async () => {
        const { EMPTY_SESSION_LIST_SERVER_KEY, normalizeSessionListKeyParts } = await import(
            './sessionListKeyNormalization'
        );
        const parts = normalizeSessionListKeyParts('   ', '   ');

        expect(parts).toEqual({
            serverId: '',
            sessionId: '',
            serverKey: EMPTY_SESSION_LIST_SERVER_KEY,
            sessionKey: null,
        });
    });

    it('builds row-scope keys without reusing the tag key separator', async () => {
        const {
            buildSessionListRowScopeKey,
            buildSessionListServerScopedRowKey,
            normalizeSessionListKeyParts,
        } = await import('./sessionListKeyNormalization');

        expect(normalizeSessionListKeyParts(' server-a ', ' session-1 ').sessionKey).toBe('server-a:session-1');
        expect(buildSessionListServerScopedRowKey(' server-a ', ' session-1 ')).toBe('server-a\u0000session-1');
        expect(buildSessionListRowScopeKey(' server-a ', ' session-1 ')).toBe('server-a\u0000session-1');
        expect(buildSessionListServerScopedRowKey(null, ' session-1 ')).toBeNull();
        expect(buildSessionListRowScopeKey(null, ' session-1 ')).toBe('session-1');
    });

    it('bounds the normalized key parts cache via LRU eviction', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SESSION_LIST_KEY_PARTS_CACHE_MAX', '2');
        vi.resetModules();

        try {
            const { normalizeSessionListKeyParts } = await import('./sessionListKeyNormalization');

            const first = normalizeSessionListKeyParts('server-a', 'session-1');
            const second = normalizeSessionListKeyParts('server-a', 'session-2');

            // Touch first so second becomes the LRU entry.
            expect(normalizeSessionListKeyParts('server-a', 'session-1')).toBe(first);

            normalizeSessionListKeyParts('server-a', 'session-3');

            expect(normalizeSessionListKeyParts('server-a', 'session-1')).toBe(first);
            expect(normalizeSessionListKeyParts('server-a', 'session-2')).not.toBe(second);
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });
});
