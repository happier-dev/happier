import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const { applySettings, happierVoiceSupportState } = vi.hoisted(() => ({
    applySettings: vi.fn(),
    happierVoiceSupportState: { current: false as boolean | null },
}));

const mockSettings = {
    voice: {
        providerId: 'realtime_elevenlabs',
        adapters: {
            realtime_elevenlabs: { billingMode: 'happier' },
        },
    },
};

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installRootLayoutRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
            TouchableOpacity: 'TouchableOpacity',
            Text: 'Text',
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: { colors: { surface: '#fff', header: { background: '#fff', tint: '#000' } } },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => ({
            settings: mockSettings,
        }),
    },
    useProfile: () => ({ linkedProviders: [], username: null }),
    useAllSessions: () => [],
    useFriendRequests: () => [],
    useLocalSettings: () => ({ activityBadgesEnabled: false }),
    useSettings: () => mockSettings,
    useSetting: (key: keyof typeof mockSettings) => mockSettings[key],
});
});

vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = (selector: (state: { profile: { linkedProviders: []; username: null } }) => unknown) => selector({ profile: { linkedProviders: [], username: null } });
    return { storage, getStorage: () => storage };
});

vi.mock('@/sync/sync', () => ({
    sync: { applySettings: (delta: Record<string, unknown>) => applySettings(delta) },
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => happierVoiceSupportState.current,
}));

describe('RootLayout voice gating', () => {
    it('disables Happier voice mode when server reports voice unsupported', async () => {
        happierVoiceSupportState.current = false;
        applySettings.mockClear();

        const RootLayout = (await import('@/app/(app)/_layout')).default;

        await renderScreen(React.createElement(RootLayout));

        expect(applySettings).toHaveBeenCalledWith({
            voice: {
                providerId: 'off',
                adapters: {
                    realtime_elevenlabs: { billingMode: 'happier' },
                },
            },
        });
    });

    it('does not permanently disable Happier voice while support is still unknown', async () => {
        happierVoiceSupportState.current = null;
        applySettings.mockClear();

        const RootLayout = (await import('@/app/(app)/_layout')).default;

        await renderScreen(React.createElement(RootLayout));

        expect(applySettings).not.toHaveBeenCalled();
    });

    it('reacts when active server support changes after mount', async () => {
        happierVoiceSupportState.current = true;
        applySettings.mockClear();

        const RootLayout = (await import('@/app/(app)/_layout')).default;
        let tree: renderer.ReactTestRenderer;

        tree = (await renderScreen(React.createElement(RootLayout))).tree;

        expect(applySettings).not.toHaveBeenCalled();

        happierVoiceSupportState.current = false;
        await act(async () => {
            tree!.update(React.createElement(RootLayout));
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
