import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const activeSelectionMachineGroupsState = vi.hoisted(() => ({
    value: {
        hasAnyVisibleMachines: true,
        showMachinesGroupedByServer: true,
        visibleMachineGroups: [
            {
                serverId: 'srv-a',
                serverName: 'Server A',
                status: 'idle',
                machines: [
                    {
                        id: 'mach-a1',
                        metadata: { displayName: 'Machine A1', host: 'a.local' },
                    },
                ],
            },
            {
                serverId: 'srv-b',
                serverName: 'Server B',
                status: 'idle',
                machines: [
                    {
                        id: 'mach-b1',
                        metadata: { displayName: 'Machine B1', host: 'b.local' },
                    },
                ],
            },
        ],
    },
}));

installSettingsViewCommonModuleMocks({
    icons: async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
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
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Text: 'Text',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
                select: (options: any) => (options && 'default' in options ? options.default : undefined),
            },
            Linking: {
                canOpenURL: async () => false,
                openURL: async () => {},
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: routerPushSpy },
        });
        return routerMock.module;
    },
    storage: async (importOriginal) => await importOriginal<typeof import('@/sync/domains/state/storage')>(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useFocusEffect: () => {} };
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));


vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) =>
        React.createElement(React.Fragment, null, title ? React.createElement('Title', null, title) : null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/settings/machines/hooks/useActiveSelectionMachineGroups', () => ({
    useActiveSelectionMachineGroups: () => activeSelectionMachineGroupsState.value,
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
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
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: 'MachineCliGlyphs',
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

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: (fn: () => void) => fn(),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (fn: () => void) => fn(),
}));

afterEach(() => {
    routerPushSpy.mockClear();
});

beforeEach(async () => {
    await loadSyncSingletonForTests();
});

describe('SettingsView (multi-server machines)', () => {
    it('replaces the inline machines list with a dedicated machines settings entry', async () => {
        const { SettingsView } = await import('./SettingsView');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<InjectedAuthProvider credentials={null}><SettingsView /></InjectedAuthProvider>)).tree;

        const items = tree!.findAllByType('Item' as any);
        const itemTitles = items.map((item: any) => String(item.props.title ?? ''));

        expect(itemTitles).not.toContain('Machine A1');
        expect(itemTitles).not.toContain('Machine B1');
        expect(itemTitles).toContain('settings.machines');

        const machinesEntry = items.find((item: any) => item.props.title === 'settings.machines');
        expect(machinesEntry).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(machinesEntry!);
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines');
    });
});
