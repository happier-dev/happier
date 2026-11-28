import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    devModeEnabled: false,
    connectedServices: [] as string[],
}));

installSettingsViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: shared.routerPushSpy },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSettingMutable: () => [shared.devModeEnabled, vi.fn()],
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
            useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: shared.connectedServices }),
        });
    },
});

vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: (_callback: () => void) => {} }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.0.0-test' } } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
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
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), isLoading: false }),
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null, isAuthenticated: false }),
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(async () => {}),
        refreshProfile: vi.fn(async () => {}),
    },
}));
vi.mock('@/track', () => ({
    trackWhatsNewClicked: vi.fn(),
}));
vi.mock('@/hooks/ui/useMultiClick', () => ({ useMultiClick: (callback: () => void) => callback }));
vi.mock('@/components/ui/layout/layout', () => ({ layout: { maxWidth: 1000 } }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: (handler: () => unknown) => [false, handler] }));
vi.mock('@/sync/api/account/apiVendorTokens', () => ({ disconnectVendorToken: vi.fn(async () => {}) }));
vi.mock('@/sync/domains/profiles/profile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/profiles/profile')>();
    return {
        ...actual,
        getDisplayName: () => 'Test User',
        getAvatarUrl: () => null,
        getBio: () => '',
    };
});
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({ MachineCliGlyphs: 'MachineCliGlyphs' }));
vi.mock('@/agents/catalog/catalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/agents/catalog/catalog')>()),
    DEFAULT_AGENT_ID: 'agent_default',
    getAgentCore: () => ({ uiConnectedService: { serviceId: 'anthropic', label: 'Anthropic', connectRoute: null } }),
    resolveAgentIdFromConnectedServiceId: () => null,
}));
vi.mock('@/utils/system/bugReportActionTrail', () => ({ recordBugReportUserAction: vi.fn() }));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false, discoverable: false, blockedBy: 'server' }),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
vi.mock('@/hooks/auth/useScannedAuthUrlProcessor', () => ({
    useScannedAuthUrlProcessor: () => ({ processAuthUrl: vi.fn() }),
}));
vi.mock('@/utils/system/requestReview', () => ({
    canRequestReview: vi.fn(async () => false),
    requestReview: vi.fn(),
}));
vi.mock('@/utils/platform/tauri', () => ({ isTauriDesktop: () => false }));
vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({ navigateWithBlurOnWeb: (action: () => void) => action() }));
vi.mock('@/utils/platform/deferOnWeb', () => ({ deferOnWeb: (action: () => void) => action() }));

describe('SettingsView keyboard shortcuts entry', () => {
    afterEach(() => {
        standardCleanup();
        shared.routerPushSpy.mockClear();
        shared.devModeEnabled = false;
        shared.connectedServices = [];
    });

    it('routes to keyboard shortcut settings from the general settings group', async () => {
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<SettingsView />);

        expect(screen.findRow('settings-keyboard-shortcuts-row')).not.toBeNull();

        screen.pressRow('settings-keyboard-shortcuts-row');

        expect(shared.routerPushSpy).toHaveBeenCalledWith('/settings/keyboard');
    });

    it('routes a hidden connected projection to the canonical service detail owner', async () => {
        shared.devModeEnabled = true;
        shared.connectedServices = ['anthropic'];
        const { SettingsView } = await import('./SettingsView');
        const screen = await renderSettingsView(<SettingsView />);

        expect(screen.findRowByTitle('Anthropic')).not.toBeNull();
        await screen.pressRowByTitle('Anthropic');

        expect(shared.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/settings/connected-services/[serviceId]',
            params: { serviceId: 'anthropic' },
        });
    });
});
