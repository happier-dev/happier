import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const stableApplyLocalSettings = vi.fn();

vi.mock('@/sync/sync', () => ({
    syncSwitchServer: vi.fn(async () => {}),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: '', serverUrl: '', generation: 0 }),
    subscribeActiveServer: () => () => {},
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => null),
}));
vi.mock('@/sync/runtime/orchestration/concurrentSessionCache', () => ({
    startConcurrentSessionCacheSync: vi.fn(),
    stopConcurrentSessionCacheSync: vi.fn(),
}));
vi.mock('@/sync/runtime/orchestration/authCredentialsInvalidation', () => ({
    subscribeAuthCredentialsInvalidation: () => () => {},
}));
vi.mock('@/sync/domains/state/persistence', () => ({
    loadLocalSettings: () => ({}),
    saveLocalSettings: vi.fn(),
}));
vi.mock('@/sync/domains/state/persistenceLifecycle', () => ({
    clearPersistence: vi.fn(),
}));
vi.mock('@/sync/domains/settings/localSettings', () => ({
    localSettingsDefaults: {},
}));
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => stableApplyLocalSettings,
}));
vi.mock('@/track', () => ({
    trackLogout: vi.fn(),
}));
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        setCredentials: vi.fn(async () => true),
        removeCredentials: vi.fn(async () => {}),
    },
}));

import { AuthProvider, useAuth } from './AuthContext';

type AuthValue = ReturnType<typeof useAuth>;

describe('AuthContext provider value identity', () => {
    beforeEach(() => {
        stableApplyLocalSettings.mockClear();
    });

    it('keeps the provider value identity stable across unrelated provider re-renders', async () => {
        const identities: AuthValue[] = [];
        let bump: () => void = () => {};

        function Probe(): null {
            identities.push(useAuth());
            return null;
        }

        function Harness(): React.ReactElement {
            const [, forceRender] = React.useReducer((x: number) => x + 1, 0);
            bump = forceRender;
            return React.createElement(AuthProvider, {
                initialCredentials: null,
                children: React.createElement(Probe, null),
            });
        }

        const screen = await renderScreen(React.createElement(Harness, null));

        try {
            expect(identities.length).toBeGreaterThanOrEqual(1);

            await act(async () => {
                bump();
            });
            await act(async () => {
                bump();
            });

            // The consumer re-rendered on each unrelated parent re-render…
            expect(identities.length).toBeGreaterThanOrEqual(3);
            // …but the auth state never changed, so the provider value must be identity-stable.
            for (const identity of identities) {
                expect(identity).toBe(identities[0]);
            }
            // Callback identities must also be stable (they gate effect dependencies across the app).
            expect(identities[identities.length - 1].login).toBe(identities[0].login);
            expect(identities[identities.length - 1].logout).toBe(identities[0].logout);
            expect(identities[identities.length - 1].loginWithCredentials).toBe(identities[0].loginWithCredentials);
            expect(identities[identities.length - 1].refreshFromActiveServer).toBe(identities[0].refreshFromActiveServer);
        } finally {
            await screen.unmount();
        }
    });
});
