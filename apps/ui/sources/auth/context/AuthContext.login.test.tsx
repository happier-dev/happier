import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const secureStore = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => secureStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
        secureStore.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
        secureStore.delete(key);
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
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('resolves without waiting for syncSwitchServer to finish', async () => {
        // Make sync's initial HTTP work hang so `syncSwitchServer` cannot complete until timers advance.
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');

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
                await auth.login(buildTokenWithSub('server-test'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
            });
            await vi.advanceTimersByTimeAsync(1);
        } finally {
            await screen.unmount();
        }
    });
});
