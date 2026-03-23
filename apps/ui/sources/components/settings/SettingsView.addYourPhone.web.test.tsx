import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstance, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
let windowDimensions: { width: number; height: number } = { width: 1600, height: 900 };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: 'View',
                                    Pressable: 'Pressable',
                                    Dimensions: {
                                        get: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
                                    },
                                    useWindowDimensions: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
                                    Platform: {
                                        OS: 'web',
                                        select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
                                    },
                                    Linking: {
                                        canOpenURL: async () => false,
                                        openURL: async () => {},
                                    },
                                    ActivityIndicator: 'ActivityIndicator',
                                }
    );
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: routerPushSpy },
    });
    return routerMock.module;
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (cb: () => void) => cb(),
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
    useAuth: () => ({ isAuthenticated: true, credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useEntitlement: () => false,
    useLocalSettingMutable: () => [false, vi.fn()],
    useSetting: () => null,
    useAllMachines: () => [],
    useMachineListByServerId: () => ({}),
    useMachineListStatusByServerId: () => ({}),
    useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: [] }),
});
});

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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            confirm: vi.fn(async () => false),
            prompt: vi.fn(async () => null),
        },
    }).module;
});

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (cb: () => void) => cb,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            dark: false,
            colors: {
                accent: { blue: 'blue', indigo: 'indigo', orange: 'orange' },
                status: { connected: 'green', disconnected: 'red' },
                text: 'black',
                textSecondary: 'gray',
                surface: 'white',
                divider: '#ddd',
                groupped: { background: 'white', sectionTitle: 'gray' },
                header: { background: 'white', tint: 'black' },
            },
        },
    });
});

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/sync/api/account/apiVendorTokens', () => ({
    disconnectVendorToken: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/profiles/profile', () => ({
    getDisplayName: () => null,
    getAvatarUrl: () => null,
    getBio: () => null,
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'agent',
    getAgentCore: () => ({ connectedService: null }),
    getAgentIconSource: () => 1,
    getAgentIconTintColor: () => null,
    resolveAgentIdFromConnectedServiceId: () => null,
}));

vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/domains/features/featureBuildPolicy', () => ({
    getFeatureBuildPolicyDecision: () => 'allow',
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'srv', generation: 0 }),
    listServerProfiles: () => [],
}));

vi.mock('@/components/settings/server/hooks/useActiveSelectionMachineGroups', () => ({
    useActiveSelectionMachineGroups: () => ({
        hasAnyVisibleMachines: false,
        showMachinesGroupedByServer: false,
        visibleMachineGroups: [],
    }),
}));

vi.mock('@/components/settings/server/sections/ActiveSelectionMachinesSection', () => ({
    ActiveSelectionMachinesSection: () => null,
}));

describe('SettingsView (web)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function findAddYourPhoneItems(screen: Awaited<ReturnType<typeof renderScreen>>) {
        return screen.findAllByType('Item').filter(
            (node: any) => node?.props?.title === 'settings.addYourPhone' && typeof node?.props?.onPress === 'function',
        );
    }

    it('renders an “Add your phone” shortcut that routes to /settings/add-phone', async () => {
        windowDimensions = { width: 1600, height: 900 };
        vi.resetModules();
        routerPushSpy.mockClear();
        const { SettingsView } = await import('./SettingsView');

        const screen = await renderScreen(<SettingsView />);

        const items = findAddYourPhoneItems(screen);
        expect(items.length).toBeGreaterThan(0);

        pressTestInstance(items[0], 'settings.addYourPhone');
        expect(routerPushSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/add-phone');
    });

    it('hides “Add your phone” on phone-sized web', async () => {
        windowDimensions = { width: 360, height: 800 };
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);
        vi.resetModules();
        routerPushSpy.mockClear();

        const { SettingsView } = await import('./SettingsView');

        const screen = await renderScreen(<SettingsView />);

        const items = findAddYourPhoneItems(screen);
        expect(items).toHaveLength(0);
    });

    it('shows “Add your phone” on desktop web even when the viewport is narrow', async () => {
        windowDimensions = { width: 480, height: 700 };
        vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
        vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) } as any);
        vi.resetModules();
        routerPushSpy.mockClear();

        const { SettingsView } = await import('./SettingsView');

        const screen = await renderScreen(<SettingsView />);

        const items = findAddYourPhoneItems(screen);
        expect(items.length).toBeGreaterThan(0);
    });
});
