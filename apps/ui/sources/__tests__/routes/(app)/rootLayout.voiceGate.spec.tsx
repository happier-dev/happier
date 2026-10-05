import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const { applySettings, happierVoiceSupportState, mockLocalSettings, mockSettings } = await vi.hoisted(async () => {
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    return {
        applySettings: vi.fn(),
        happierVoiceSupportState: { current: false as boolean | null },
        mockLocalSettings: {
            ...localSettingsDefaults,
            activityBadgesEnabled: false,
        } satisfies LocalSettings,
        mockSettings: {
            ...settingsDefaults,
            voice: {
                ...settingsDefaults.voice,
                providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                providers: {
                    ...settingsDefaults.voice.providers,
                    'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: { billingMode: 'happier' } },
                },
            },
        } satisfies Settings,
    };
});


vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installRootLayoutRouteCommonModuleMocks({
    modal: async () => vi.importActual<typeof import('@/modal')>('@/modal'),
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

vi.mock('@/components/pets/runtime/PetAppShellCompanionMount', () => ({
    PetAppShellCompanionMount: () => React.createElement('PetAppShellCompanionMount', {
        testID: 'pet-app-shell-companion-mount',
    }),
}));

vi.mock('@/sync/sync', () => ({
    sync: { applySettings: (delta: Record<string, unknown>) => applySettings(delta) },
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => happierVoiceSupportState.current,
}));

beforeEach(async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ settings: mockSettings, localSettings: mockLocalSettings });
});

describe('RootLayout voice gating', () => {
    it('mounts the in-window pet companion surface for ordinary web clients', async () => {
        const RootLayout = (await import('@/app/(app)/_layout')).default;

        const screen = await renderRootLayout(React.createElement(RootLayout));

        expect(screen.findByTestId('pet-app-shell-companion-mount')).not.toBeNull();
    });

    it('keeps a configured hosted voice selection inert when server reports voice unsupported', async () => {
        happierVoiceSupportState.current = false;
        applySettings.mockClear();

        const RootLayout = (await import('@/app/(app)/_layout')).default;

        await renderRootLayout(React.createElement(RootLayout));

        expect(applySettings).not.toHaveBeenCalled();
    });

    it('does not permanently disable Happier voice while support is still unknown', async () => {
        happierVoiceSupportState.current = null;
        applySettings.mockClear();

        const RootLayout = (await import('@/app/(app)/_layout')).default;

        await renderRootLayout(React.createElement(RootLayout));

        expect(applySettings).not.toHaveBeenCalled();
    });

    it('reacts when active server support changes after mount', async () => {
        happierVoiceSupportState.current = true;
        applySettings.mockClear();

        const RootLayout = (await import('@/app/(app)/_layout')).default;
        const screen = await renderRootLayout(React.createElement(RootLayout));

        expect(applySettings).not.toHaveBeenCalled();

        happierVoiceSupportState.current = false;
        await screen.update(React.createElement(RootLayout));

        expect(applySettings).not.toHaveBeenCalled();
    });
});

async function renderRootLayout(element: React.ReactElement) {
    const { ModalProvider } = await import('@/modal');
    return renderScreen(element, {
        wrapper: ({ children }) => React.createElement(ModalProvider, { children }),
    });
}
