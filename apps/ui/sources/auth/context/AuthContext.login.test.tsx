import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { AuthProvider, getCurrentAuth } from './AuthContext';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const secureStore = vi.hoisted(() => new Map<string, string>());
const asyncStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => secureStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
        secureStore.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
        secureStore.delete(key);
    },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (key: string) => asyncStorage.get(key) ?? null,
        setItem: async (key: string, value: string) => {
            asyncStorage.set(key, value);
        },
        removeItem: async (key: string) => {
            asyncStorage.delete(key);
        },
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

vi.mock('@/track', () => ({
    trackLogout: vi.fn(),
    initializeTracking: vi.fn(),
    tracking: null,
}));

function buildTokenWithSub(sub: string): string {
    const payload = Buffer.from(JSON.stringify({ sub })).toString('base64');
    return `hdr.${payload}.sig`;
}

describe('AuthContext.login', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        secureStore.clear();
        asyncStorage.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('resolves with the authenticated encryption context ready while initial network sync is pending', async () => {
        // Make sync's initial HTTP work hang so `syncSwitchServer` cannot complete until timers advance.
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: null,
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            await act(async () => {
                const login = auth.loginWithCredentials({ token: buildTokenWithSub('server-test') });
                await vi.advanceTimersByTimeAsync(3000);
                await login;
            });
            const { sync } = await import('@/sync/sync');
            expect(sync.encryption).toBeDefined();
            expect(sync.encryption.hasEncryptionMaterial()).toBe(false);
        } finally {
            await screen.unmount();
        }
    });

    it('reports encryption initialization failures to the sign-in caller', async () => {
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: null,
            children: React.createElement(React.Fragment, null),
        }));
        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            await act(async () => {
                await expect(auth.loginWithCredentials({
                    token: buildTokenWithSub('server-test'),
                    encryption: { publicKey: 'a', machineKey: 'b' },
                })).rejects.toThrow('Invalid dataKey credential key lengths');
            });
        } finally {
            await screen.unmount();
        }
    });

    it.each([
        { previousToken: buildTokenWithSub('current-account'), nextAccount: 'current-account', retained: true },
        { previousToken: buildTokenWithSub('current-account'), nextAccount: 'replacement-account', retained: false },
        { previousToken: 'unparseable-stored-token', nextAccount: 'replacement-account', retained: false },
    ])('keeps pending archives only when reauthenticating the same account: $previousToken -> $nextAccount', async ({ previousToken, nextAccount, retained }) => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53289', scope: 'tab' });
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.setState({ sessionArchiveOperations: {} });
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: { token: previousToken },
            children: React.createElement(React.Fragment, null),
        }));
        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            storage.getState().beginSessionArchive('pending-session', 'original-server');
            await act(async () => {
                const login = auth.loginWithCredentials({ token: buildTokenWithSub(nextAccount) })
                    .catch((error: unknown) => ({ error }));
                await vi.advanceTimersByTimeAsync(3000);
                const failure = await login;
                if (failure) throw failure.error;
            });
            expect(storage.getState().sessionArchiveOperations['original-server']?.['pending-session'] !== undefined).toBe(retained);
        } finally {
            storage.setState({ sessionArchiveOperations: {} });
            await screen.unmount();
        }
    });

    it('keeps the mobile brand hero dismissed after logout', async () => {
        const seenAt = 1_789_222_000_000;
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        const { clearPersistence, loadLocalSettings, saveLocalSettings } = await import('@/sync/domains/state/persistence');
        await clearPersistence();
        saveLocalSettings({
            ...localSettingsDefaults,
            brandHeroSeenAt: seenAt,
        });


        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token: buildTokenWithSub('server-test'), secret: 'secret-test' },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            const { storage } = await import('@/sync/domains/state/storageStore');
            storage.getState().beginSessionArchive('pending-session', 'server-test');
            await act(async () => {
                await auth.logout();
            });

            expect(loadLocalSettings().brandHeroSeenAt).toBe(seenAt);
            expect(storage.getState().sessionArchiveOperations).toEqual({});
        } finally {
            await screen.unmount();
            await clearPersistence();
        }
    });
});
