import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const settingsViewMultiServerMachinesState = vi.hoisted(() => ({
    sharedDeviceInventorySettings: { privacy: { shareDeviceInventory: true } },
    localSettingMutable: [false, vi.fn()] as const,
    settingMutable: [{ v: 1, actions: {} }, vi.fn()] as const,
    profile: {
        id: 'prof_1',
        timestamp: 0,
        firstName: null,
        lastName: null,
        username: null,
        avatar: null,
        linkedProviders: [],
        connectedServices: [],
        connectedServicesV2: [],
    },
}));

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
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => settingsViewMultiServerMachinesState.sharedDeviceInventorySettings,
            useSettings: () => settingsViewMultiServerMachinesState.sharedDeviceInventorySettings,
            useEntitlement: () => false,
            useProfile: () => settingsViewMultiServerMachinesState.profile,
            useLocalSettingMutable: () => settingsViewMultiServerMachinesState.localSettingMutable,
            useSettingMutable: () => settingsViewMultiServerMachinesState.settingMutable,
        });
    },
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

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
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
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) =>
        React.createElement(React.Fragment, null, title ? React.createElement('Title', null, title) : null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/settings/server/hooks/useActiveSelectionMachineGroups', () => ({
    useActiveSelectionMachineGroups: () => activeSelectionMachineGroupsState.value,
}));

vi.mock('@/components/settings/server/sections/ActiveSelectionMachinesSection', () => ({
    ActiveSelectionMachinesSection: ({ visibleMachineGroups }: any) =>
        React.createElement(
            React.Fragment,
            null,
            visibleMachineGroups.flatMap((group: any) =>
                group.machines.map((machine: any) =>
                    React.createElement('Item', {
                        key: `${group.serverId}-${machine.id}`,
                        title: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id,
                    }),
                ),
            ),
        ),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
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

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: 'MachineCliGlyphs',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'gemini'],
    DEFAULT_AGENT_ID: 'agent_default',
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

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: (fn: () => void) => fn(),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (fn: () => void) => fn(),
}));

afterEach(() => {
    routerPushSpy.mockClear();
});

describe('SettingsView (multi-server machines)', () => {
    it('replaces the inline machines list with a dedicated machines settings entry', async () => {
        const { SettingsView } = await import('./SettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(SettingsView))).tree;

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
