import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

type Group = {
    serverId: string;
    serverName: string;
    status: 'idle' | 'loading' | 'signedOut' | 'error';
    machines: Array<{ id: string; active: boolean; activeAt: number; metadata?: { displayName?: string; host?: string; platform?: string } }>;
};

const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const desktopState = vi.hoisted(() => ({ value: false }));
const viewModelState = vi.hoisted(() => ({
    value: null as unknown as {
        activeServerId: string;
        allMachines: Group['machines'];
        hasMachines: boolean;
        isLoadingMachines: boolean;
        machineRows: unknown[];
        showMachinesGroupedByServer: boolean;
        visibleMachineGroups: Group[];
    },
}));
const syncBoundary = vi.hoisted(() => ({ refreshMachines: vi.fn(async () => undefined) }));
// The sync singleton is the transport boundary; the list only asks it to read the machines again.
vi.mock('@/sync/sync', () => ({ sync: { refreshMachines: syncBoundary.refreshMachines } }));
const poolFeatureState = vi.hoisted(() => ({ value: 'disabled' as 'disabled' | 'enabled' }));
const relayDriftState = vi.hoisted(() => ({ value: null as null | { title: string; description: string } }));

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPushSpy, replace: routerReplaceSpy },
            pathname: '/settings/machines',
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => desktopState.value,
}));
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: 'Icon', ICON_SIZE: { xs: 12 } }));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title, description }: { children?: React.ReactNode; title?: React.ReactNode; description?: React.ReactNode }) =>
        React.createElement('Group', { title, description }, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/components/ui/forms/SelectionTiles', () => ({
    SelectionTiles: (props: Record<string, unknown>) => React.createElement('SelectionTiles', props),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/settings/shell/SettingsPageHeader', () => ({
    SettingsPageHeader: (props: { actions?: React.ReactNode }) => React.createElement('SettingsPageHeader', props, props.actions),
}));
// Detected-CLI glyphs read the machine's capabilities over RPC; this screen only places them.
vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: () => null,
}));
// The Home's pool feature decision and rows come from the network-backed projection owner.
vi.mock('@/sync/engine/machines/useMachinePoolProjections', () => ({
    useMachinePoolProjections: (groups: ReadonlyArray<{ serverId: string }>) => groups.map((group) => ({
        serverId: group.serverId,
        accountId: 'account-a',
        featureStatus: poolFeatureState.value,
        featureEnabled: poolFeatureState.value === 'enabled',
        pools: [],
        status: 'idle',
        ready: true,
    })),
}));
vi.mock('./machinesSettingsViewModel', () => ({
    useMachinesSettingsViewModel: () => viewModelState.value,
}));
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => relayDriftState.value,
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: Record<string, unknown>) => React.createElement('RelayDriftActionCard', props),
}));
vi.mock('@/components/ui/lists/AttentionBanner', () => ({
    AttentionBanner: (props: Record<string, unknown>) => React.createElement('AttentionBanner', props),
}));

function machine(id: string, displayName: string, host: string) {
    // `activeAt: 0` leaves presence to `active`, so a slow run cannot age the machine offline.
    return { id, active: true, activeAt: 0, metadata: { displayName, host, platform: 'darwin' } };
}

function setMachines(groups: Group[], overrides: Partial<typeof viewModelState.value> = {}) {
    const allMachines = groups.flatMap((group) => group.machines);
    viewModelState.value = {
        activeServerId: groups[0]?.serverId ?? 'srv-a',
        allMachines,
        hasMachines: allMachines.length > 0,
        isLoadingMachines: false,
        machineRows: [],
        showMachinesGroupedByServer: groups.length > 1,
        visibleMachineGroups: groups,
        ...overrides,
    };
}

async function renderPage() {
    const { MachinesSettingsView } = await import('./MachinesSettingsView');
    return (await renderScreen(React.createElement(MachinesSettingsView))).tree;
}

function addMenuItemIds(tree: Awaited<ReturnType<typeof renderPage>>): string[] {
    const menu = tree.findByType('DropdownMenu' as never) as unknown as { props: { items: Array<{ id: string }> } };
    return menu.props.items.map((item) => item.id);
}

describe('MachinesSettingsView', () => {
    beforeEach(() => {
        routerPushSpy.mockClear();
        routerReplaceSpy.mockClear();
        desktopState.value = false;
        poolFeatureState.value = 'disabled';
        relayDriftState.value = null;
        setMachines([{ serverId: 'srv-a', serverName: 'Home A', status: 'idle', machines: [machine('machine-a1', 'Machine A1', 'a.local')] }]);
    });

    it('lists the machines and opens a machine in the collection, scoped to its Home', async () => {
        const tree = await renderPage();

        const row = tree.findAll((node) => node.props?.testID === 'settings.machines.row.srv-a.machine-a1')[0]!;
        expect(row.props.title).toBe('Machine A1');
        expect(row.props.subtitle).toBe('settingsOverview.machineOnline · a.local · macOS');
        await act(async () => {
            await pressTestInstanceAsync(row);
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines/machine-a1?serverId=srv-a');
        // No desktop-only row on the web.
        expect(tree.findAll((node) => node.props?.testID === 'settings.machines.thisComputer')).toHaveLength(0);
    });

    it('opens the canonical add-machine draft from both the browser and desktop collection', async () => {
        const webTree = await renderPage();
        expect(addMenuItemIds(webTree)).toEqual(['machine']);

        desktopState.value = true;
        const desktopTree = await renderPage();
        expect(addMenuItemIds(desktopTree)).toEqual(['machine']);
        const menu = desktopTree.findByType('DropdownMenu' as never) as unknown as { props: { onSelect: (id: string) => void } };
        await act(async () => menu.props.onSelect('machine'));
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines/add');
    });

    it('lists this computer in the desktop app and opens its page in the collection', async () => {
        desktopState.value = true;
        const tree = await renderPage();

        const row = tree.findAll((node) => node.props?.testID === 'settings.machines.thisComputer')[0]!;
        await act(async () => {
            await pressTestInstanceAsync(row);
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines/this-computer');
    });

    it('shows the ways to add a machine when there are none, and offers a pool where the Home supports pools', async () => {
        setMachines([{ serverId: 'srv-a', serverName: 'Home A', status: 'idle', machines: [] }]);
        poolFeatureState.value = 'enabled';
        const tree = await renderPage();

        const tiles = tree.findByType('SelectionTiles' as never) as unknown as {
            props: { options: Array<{ id: string }>; onPress: (id: string) => void };
        };
        // The pool is added from its own section, so the tiles do not offer it twice.
        expect(tiles.props.options.map((option) => option.id)).toEqual(['machine']);
        expect(addMenuItemIds(tree)).toEqual(['machine', 'pool']);
        const menu = tree.findByType('DropdownMenu' as never) as unknown as { props: { onSelect: (id: string) => void } };
        await act(async () => menu.props.onSelect('pool'));
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines/pools/new?serverId=srv-a');
    });

    it('holds a loading row while the first machine list loads', async () => {
        setMachines([{ serverId: 'srv-a', serverName: 'Home A', status: 'loading', machines: [] }], { isLoadingMachines: true });
        const tree = await renderPage();

        const titles = tree.findAllByType('Item' as never).map((node) => (node as unknown as { props: { title: string } }).props.title);
        expect(titles).toEqual(['common.loading']);
        expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
    });

    it('ends in a named failure with Retry, not the add tiles, when the Home cannot list its machines', async () => {
        setMachines([{ serverId: 'srv-a', serverName: 'Home A', status: 'error', machines: [] }]);
        const tree = await renderPage();

        expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
        const titles = tree.findAllByType('Item' as never).map((node) => (node as unknown as { props: { title: string } }).props.title);
        expect(titles).not.toContain('common.loading');
        const failure = tree.find((node) => node.props?.testID === 'settings.machines.unreadable') as unknown as {
            props: { title: string; rightElement: { props: { testID: string; onPress: () => void } } };
        };
        expect(failure.props.title).toContain('settingsMachines.unreadableTitle');
        const retry = failure.props.rightElement;
        expect(retry.props.testID).toBe('settings.machines.unreadable.retry');
        await act(async () => retry.props.onPress());
        expect(syncBoundary.refreshMachines).toHaveBeenCalledTimes(1);
    });

    it('groups machines by Home when several Homes are shown, keeping a Home that has none', async () => {
        setMachines([
            { serverId: 'srv-a', serverName: 'Home A', status: 'idle', machines: [machine('machine-a1', 'Machine A1', 'a.local')] },
            { serverId: 'srv-b', serverName: 'Home B', status: 'signedOut', machines: [] },
        ]);
        const tree = await renderPage();

        const groups = tree.findAllByType('Group' as never).map((node) => (node as unknown as { props: { title: string; description?: string } }).props);
        expect(groups.map((group) => group.title)).toEqual(['Home A', 'Home B']);
        expect(groups[1]?.description).toBe('settingsMachines.count · server.signedOut');
    });
});

describe('MachinesRelayDriftBanner', () => {
    beforeEach(() => {
        desktopState.value = false;
        relayDriftState.value = { title: 'Drift', description: 'This computer serves another Home.' };
    });

    it('says so on the web, where it cannot repair, and offers the repair in the desktop app', async () => {
        const { MachinesRelayDriftBanner } = await import('./MachinesRelayDriftBanner');
        const web = (await renderScreen(React.createElement(MachinesRelayDriftBanner))).tree;
        expect(web.findAll((node) => node.props?.testID === 'settings.machines.relayDrift.webNotice')).not.toHaveLength(0);
        expect(web.findAllByType('RelayDriftActionCard' as never)).toHaveLength(0);

        desktopState.value = true;
        const desktop = (await renderScreen(React.createElement(MachinesRelayDriftBanner))).tree;
        expect(desktop.findAllByType('RelayDriftActionCard' as never)).toHaveLength(1);
    });
});
