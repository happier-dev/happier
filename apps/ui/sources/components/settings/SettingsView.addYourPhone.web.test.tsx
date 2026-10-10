import * as React from 'react';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createPassThroughComponent } from '@/dev/testkit/mocks/components';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
let windowDimensions: { width: number; height: number } = { width: 1600, height: 900 };

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

installSettingsViewCommonModuleMocks({
    icons: () => ({
        Ionicons: 'Ionicons',
    }),
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
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Dimensions: {
                get: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
            Platform: {
                OS: 'web',
                select: (options: { web?: unknown; default?: unknown; ios?: unknown; android?: unknown }) =>
                    options.web ?? options.default ?? options.ios ?? options.android,
            },
            Linking: {
                canOpenURL: async () => false,
                openURL: async () => {},
            },
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
    storage: async () => {
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
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
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
    },
});

const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useFocusEffect: () => {} };
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));


vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: createPassThroughComponent('ItemList'),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassThroughComponent('ItemGroup'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassThroughComponent('Item'),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

// The real provider memoizes its context value and holds credentials in state, so consumers see one
// stable object; a fresh object per call would re-run every effect that depends on `credentials`.
const authCredentials = { token: createAccountTokenForTests('account-a') };

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

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
    useLayoutMaxWidth: () => 1024,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1024 }),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/sync/domains/profiles/profile', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/profiles/profile')>(),
    getDisplayName: () => null,
    getAvatarUrl: () => null,
    getBio: () => null,
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
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

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => null,
}));

vi.mock('@/sync/domains/features/featureBuildPolicy', () => ({
    getFeatureBuildPolicyDecision: () => 'allow',
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getActiveServerSnapshot: () => ({ serverId: 'srv', serverUrl: 'https://local.example.test', generation: 0 }),
    listServerProfiles: () => [],
    subscribeActiveServer: (listener: any) => {
        listener({ serverId: 'srv', serverUrl: 'https://local.example.test', generation: 0 });
        return () => {};
    },
}));

vi.mock('@/components/settings/machines/hooks/useActiveSelectionMachineGroups', () => ({
    useActiveSelectionMachineGroups: () => ({
        hasAnyVisibleMachines: false,
        showMachinesGroupedByServer: false,
        visibleMachineGroups: [],
    }),
}));

const { SettingsView } = await import('./SettingsView');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

describe('SettingsView (web)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('hides “Add your phone” on phone-sized web', async () => {
        windowDimensions = { width: 360, height: 800 };
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);
        routerPushSpy.mockClear();

        const screen = await renderSettingsView(<InjectedAuthProvider credentials={authCredentials}><SettingsView /></InjectedAuthProvider>);

        expect(screen.findRow('settings-add-your-phone-shortcut')).toBeNull();
    });

    it('shows “Add your phone” on desktop web even when the viewport is narrow', async () => {
        windowDimensions = { width: 480, height: 700 };
        vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
        vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) } as any);
        routerPushSpy.mockClear();

        const screen = await renderSettingsView(<InjectedAuthProvider credentials={authCredentials}><SettingsView /></InjectedAuthProvider>);

        expect(screen.findRow('settings-add-your-phone-shortcut')).toBeTruthy();
    });
});
