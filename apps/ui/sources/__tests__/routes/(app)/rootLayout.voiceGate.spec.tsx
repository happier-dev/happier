import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit/rootLayoutTestkit';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const applySettings = vi.fn();

vi.mock('react-native-reanimated', () => ({}));

vi.mock('expo-router', () => ({
    Stack: Object.assign(
        ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
        { Screen: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children) }
    ),
    router: { replace: vi.fn() },
    useSegments: () => ['(app)'],
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    TouchableOpacity: 'TouchableOpacity',
    Text: 'Text',
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
    useUnistyles: () => ({ theme: { colors: { surface: '#fff', header: { background: '#fff', tint: '#000' } } } }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/components/navigation/Header', () => ({
    createHeader: () => null,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            settings: {
                voice: {
                    providerId: 'realtime_elevenlabs',
                    adapters: {
                        realtime_elevenlabs: { billingMode: 'happier' },
                    },
                },
            },
        }),
    },
    useProfile: () => ({ linkedProviders: [], username: null }),
}));

vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = (selector: (state: { profile: { linkedProviders: []; username: null } }) => unknown) => selector({ profile: { linkedProviders: [], username: null } });
    return { storage, getStorage: () => storage };
});

vi.mock('@/sync/sync', () => ({
    sync: { applySettings: (delta: Record<string, unknown>) => applySettings(delta) },
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: async () =>
        createRootLayoutFeaturesResponse({
            features: { voice: { enabled: true, happierVoice: { enabled: false } } },
            capabilities: { voice: { configured: false, provider: null, requested: true, disabledByBuildPolicy: false } },
        }),
}));

describe('RootLayout voice gating', () => {
    it('disables Happier voice mode when server reports voice unsupported', async () => {
        const RootLayout = (await import('./_layout')).default;

        await act(async () => {
            renderer.create(React.createElement(RootLayout));
        });

        expect(applySettings).toHaveBeenCalledWith({
            voice: {
                providerId: 'off',
                adapters: {
                    realtime_elevenlabs: { billingMode: 'happier' },
                },
            },
        });
    });
});
