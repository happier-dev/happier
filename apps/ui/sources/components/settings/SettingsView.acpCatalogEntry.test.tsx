import * as React from 'react';
import { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAcpCatalogSettingsCommonModuleMocks } from './acpCatalog/acpCatalogSettingsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();

installAcpCatalogSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Dimensions: {
                get: () => ({ width: 1600, height: 900, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1600, height: 900, scale: 2, fontScale: 1 }),
            Platform: {
                OS: 'web',
                select: (options: any) => (options && 'default' in options ? options.default : undefined),
            },
            Linking: {
                canOpenURL: vi.fn(async () => false),
                openURL: vi.fn(async () => {}),
            },
            Text: 'Text',
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: routerPushSpy },
        });
        return routerMock.module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => false),
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useEntitlement: () => false,
            useLocalSettingMutable: () => [false, vi.fn()],
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
            useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: [] }),
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'StyledText',
    TextInput: 'TextInput',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (_cb: () => void) => {},
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
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(async () => {}),
        presentPaywall: vi.fn(async () => ({ success: false, error: 'nope' })),
        refreshProfile: vi.fn(async () => {}),
    },
}));

vi.mock('@/track', () => ({
    trackPaywallButtonClicked: vi.fn(),
    trackWhatsNewClicked: vi.fn(),
}));

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (cb: () => void) => cb,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => false,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/sync/api/account/apiVendorTokens', () => ({
    disconnectVendorToken: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/profiles/profile', () => ({
    getDisplayName: () => 'Test User',
    getAvatarUrl: () => null,
    getBio: () => '',
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: 'MachineCliGlyphs',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'kiro', 'customAcp'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: () => ({ uiConnectedService: { serviceId: 'anthropic', label: 'Anthropic', connectRoute: null } }),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => null,
    resolveAgentIdFromConnectedServiceId: () => null,
}));

vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 }),
    listServerProfiles: () => [],
    subscribeActiveServer: (listener: any) => {
        listener({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 });
        return () => {};
    },
}));

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: vi.fn(),
    canRequestReview: vi.fn(async () => true),
}));

afterEach(() => {
    routerPushSpy.mockClear();
});

describe('SettingsView ACP catalog entry', () => {
    it('does not include a detached ACP backends entry in the main settings screen', async () => {
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(SettingsView))).tree;

        const items = tree.findAllByType('Item' as any);
        const acpItem = items.find((item: any) => item?.props?.title === 'settings.acpCatalog');
        expect(acpItem).toBeFalsy();
        expect(routerPushSpy).not.toHaveBeenCalled();
    });
});
