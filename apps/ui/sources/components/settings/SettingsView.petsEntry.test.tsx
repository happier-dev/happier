import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    petsCompanionEnabled: false,
    petsSyncEnabled: false,
}));

installSettingsViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const {
            createStorageModuleMock,
            createUseLocalSettingMock,
            createUseLocalSettingMutableMock,
        } = await import('@/dev/testkit/mocks/storage');
        const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const useLocalSetting = createUseLocalSettingMock({ values: { devModeEnabled: false } });
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                ...actual,
                useEntitlement: () => false,
                useLocalSetting,
                useLocalSettingMutable: createUseLocalSettingMutableMock(useLocalSetting),
                useSetting: (key: string) => {
                    if (key === 'serverSelectionGroups') return [];
                    if (key === 'serverSelectionActiveTargetKind') return null;
                    if (key === 'serverSelectionActiveTargetId') return null;
                    if (key === 'experiments') return false;
                    if (key === 'featureToggles') return {};
                    if (key === 'useProfiles') return false;
                    if (key === 'sessionUseTmux') return false;
                    return null;
                },
                useAllMachines: () => [],
                useMachineListByServerId: () => ({}),
                useMachineListStatusByServerId: () => ({}),
                useProfile: () => ({ ...profileDefaults, id: 'prof_1', firstName: '', connectedServices: [] }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: shared.routerPushSpy },
        }).module;
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (_callback: () => void) => {},
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null, isAuthenticated: false }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(async () => {}),
        presentPaywall: vi.fn(async () => ({ success: false, error: 'paywall unavailable' })),
        refreshProfile: vi.fn(async () => {}),
    },
}));

vi.mock('@/track', () => ({
    trackPaywallButtonClicked: vi.fn(),
    trackWhatsNewClicked: vi.fn(),
}));

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (callback: () => void) => callback,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (handler: () => unknown) => [false, handler],
}));

vi.mock('@/sync/api/account/apiVendorTokens', () => ({
    disconnectVendorToken: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/profiles/profile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/profiles/profile')>();
    return {
        ...actual,
        getDisplayName: () => 'Test User',
        getAvatarUrl: () => null,
        getBio: () => '',
    };
});

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: 'MachineCliGlyphs',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'agent_default',
    getAgentCore: () => ({ uiConnectedService: { serviceId: 'anthropic', label: 'Anthropic', connectRoute: null } }),
    resolveAgentIdFromConnectedServiceId: () => null,
}));

vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false, discoverable: false, blockedBy: 'server' }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'pets.companion') return shared.petsCompanionEnabled;
        if (featureId === 'pets.sync') return shared.petsSyncEnabled;
        return false;
    },
}));

vi.mock('@/hooks/auth/useScannedAuthUrlProcessor', () => ({
    useScannedAuthUrlProcessor: () => ({ processAuthUrl: vi.fn() }),
}));

vi.mock('@/utils/system/requestReview', () => ({
    canRequestReview: vi.fn(async () => false),
    requestReview: vi.fn(),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

describe('SettingsView pets entry', () => {
    afterEach(() => {
        standardCleanup();
        shared.routerPushSpy.mockClear();
        shared.petsCompanionEnabled = false;
        shared.petsSyncEnabled = false;
    });

    it('hides the Pets row when the companion feature is denied', async () => {
        shared.petsCompanionEnabled = false;

        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<SettingsView />);

        expect(screen.findRow('settings-pets-row')).toBeNull();
    });

    it('shows the Pets row when the companion feature is enabled', async () => {
        shared.petsCompanionEnabled = true;

        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<SettingsView />);

        expect(screen.findRow('settings-pets-row')).not.toBeNull();
    });

    it('shows the Pets row when sync is enabled even if the companion feature is denied', async () => {
        shared.petsCompanionEnabled = false;
        shared.petsSyncEnabled = true;

        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<SettingsView />);

        expect(screen.findRow('settings-pets-row')).not.toBeNull();
    });

    it('navigates to the Pets settings screen from the row', async () => {
        shared.petsCompanionEnabled = true;

        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<SettingsView />);

        screen.pressRow('settings-pets-row');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/pets');
    });
});
