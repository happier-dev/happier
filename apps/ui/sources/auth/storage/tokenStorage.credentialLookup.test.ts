import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';

/**
 * Cold boot blocks on the credential read, and on native every scope probe is a keychain round trip.
 * These tests pin the two things that matter there: the legacy scopes are probed together rather
 * than one round trip at a time, and the primary scope alone still answers the common case.
 */
const secureStoreState = vi.hoisted(() => {
    const values = new Map<string, string>();
    const readOrder: string[] = [];
    const state = {
        values,
        readOrder,
        inFlightReads: 0,
        maxConcurrentReads: 0,
        readLatencyMs: 5,
        getItemAsync: vi.fn(async (key: string) => {
            readOrder.push(key);
            state.inFlightReads += 1;
            state.maxConcurrentReads = Math.max(state.maxConcurrentReads, state.inFlightReads);
            try {
                await new Promise((resolve) => setTimeout(resolve, state.readLatencyMs));
                return values.get(key) ?? null;
            } finally {
                state.inFlightReads -= 1;
            }
        }),
        setItemAsync: vi.fn(async (key: string, value: string) => {
            values.set(key, value);
        }),
        deleteItemAsync: vi.fn(async (key: string) => {
            values.delete(key);
        }),
    };
    return state;
});

installTokenStorageWebPlatformMocks({
    reactNative: async () => {
        const stub = await import('../../dev/reactNativeStub');
        return {
            ...stub,
            Platform: {
                ...(stub.Platform ?? {}),
                OS: 'ios',
                select: (options: Record<string, unknown>) =>
                    options.ios ?? options.native ?? options.default ?? options.web ?? options.android,
            },
        };
    },
    secureStore: async () => secureStoreState,
});

const SERVER_URL = 'https://api.example.test';

function installServerProfilesMockWithLegacyScopes(): void {
    vi.doMock('@/sync/domains/server/serverProfiles', () => ({
        getActiveServerId: () => 'srv-identity',
        getActiveServerUrl: () => SERVER_URL,
        listServerProfiles: () => [
            {
                id: 'srv-legacy-a',
                serverIdentityId: 'srv-identity',
                serverUrl: SERVER_URL,
                legacyServerIds: ['srv-legacy-b'],
            },
        ],
        areServerProfileIdentifiersEquivalent: () => true,
    }));
}

describe('TokenStorage credential lookup (native keychain)', () => {
    beforeEach(() => {
        vi.resetModules();
        secureStoreState.values.clear();
        secureStoreState.readOrder.length = 0;
        secureStoreState.inFlightReads = 0;
        secureStoreState.maxConcurrentReads = 0;
        secureStoreState.readLatencyMs = 5;
        secureStoreState.getItemAsync.mockClear();
        secureStoreState.setItemAsync.mockClear();
        secureStoreState.deleteItemAsync.mockClear();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('probes every legacy scope concurrently instead of one keychain round trip at a time', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');

        // Nothing is stored anywhere: the lookup has to probe the primary scope and then every
        // legacy scope, which is the worst case that used to serialise on the boot gate.
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();

        const legacyReadCount = secureStoreState.getItemAsync.mock.calls.length - 1;
        expect(legacyReadCount).toBeGreaterThan(1);
        expect(secureStoreState.maxConcurrentReads).toBe(legacyReadCount);
    });

    it('does not probe legacy scopes at all when the primary scope answers', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');

        await expect(TokenStorage.setCredentials({ token: 'token-1', secret: 'secret-1' })).resolves.toBe(true);
        const primaryKey = [...secureStoreState.values.keys()].find((key) => key.includes('auth_credentials'));
        expect(primaryKey).toBeDefined();

        vi.resetModules();
        secureStoreState.readOrder.length = 0;
        secureStoreState.getItemAsync.mockClear();
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage: FreshTokenStorage } = await import('./tokenStorage');

        await expect(FreshTokenStorage.getCredentials()).resolves.toEqual({ token: 'token-1', secret: 'secret-1' });
        expect(secureStoreState.readOrder).toEqual([primaryKey]);
    });

    it('keeps legacy scope precedence and still migrates the winner onto the primary scope', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');

        // Discover the scope layout by asking for a lookup with nothing stored.
        await TokenStorage.getCredentials();
        const [primaryKey, ...legacyKeys] = [...secureStoreState.readOrder];
        expect(primaryKey).toBeDefined();
        expect(legacyKeys.length).toBeGreaterThan(1);

        secureStoreState.values.set(legacyKeys[0]!, JSON.stringify({ token: 'legacy-first', secret: 's1' }));
        secureStoreState.values.set(legacyKeys[1]!, JSON.stringify({ token: 'legacy-second', secret: 's2' }));

        vi.resetModules();
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage: FreshTokenStorage } = await import('./tokenStorage');

        await expect(FreshTokenStorage.getCredentials()).resolves.toEqual({ token: 'legacy-first', secret: 's1' });
        expect(secureStoreState.values.get(primaryKey!)).toBe(JSON.stringify({ token: 'legacy-first', secret: 's1' }));
        expect(secureStoreState.values.has(legacyKeys[0]!)).toBe(false);
        // Losing legacy scopes are left alone; only the migrated one is retired.
        expect(secureStoreState.values.has(legacyKeys[1]!)).toBe(true);
    });

    it('applies the same lookup to an explicitly requested server URL', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');

        await expect(
            TokenStorage.getCredentialsForServerUrl(SERVER_URL, { serverId: 'srv-identity' }),
        ).resolves.toBeNull();

        const legacyReadCount = secureStoreState.getItemAsync.mock.calls.length - 1;
        expect(legacyReadCount).toBeGreaterThan(1);
        expect(secureStoreState.maxConcurrentReads).toBe(legacyReadCount);
    });
});
