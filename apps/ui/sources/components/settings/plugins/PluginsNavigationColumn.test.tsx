import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { act, createMachineFixture, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { createInstalledPluginCapabilityFixture } from '@/dev/testkit/fixtures/pluginCapabilityFixtures';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const route = vi.hoisted(() => ({ pathname: '/plugins', params: {} as Record<string, string>, replace: vi.fn(), setParams: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => route.pathname, params: () => route.params,
    router: { replace: route.replace, setParams: route.setParams },
}).module);
const installedPlugins = {
    value: [
        createInstalledPluginCapabilityFixture({ pluginId: 'happier.codex', title: 'Codex', source: { kind: 'bundled', locator: 'x' } }),
        createInstalledPluginCapabilityFixture({ pluginId: 'happier.claude', title: 'Claude', source: { kind: 'bundled', locator: 'x' } }),
        createInstalledPluginCapabilityFixture({ pluginId: 'acme.notes', title: 'Notes', enabled: false }),
    ],
};
let capabilityRequests = 0;
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const account = createProviderSettingsAccountHarness();
installDisconnectedServerSocketBoundary(socket => {
    socket.connect = vi.fn<typeof socket.connect>(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event: string, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || payload.method !== `machine-1:${RPC_METHODS.CAPABILITIES_DETECT}`) {
            throw new Error('Unexpected Plugins column Socket request');
        }
        capabilityRequests += 1;
        return { ok: true, result: { protocolVersion: 1, results: {
            'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: installedPlugins.value } },
        } } };
    });
});
await import('./PluginsNavigationColumn');
beforeEach(async () => {
    capabilityRequests = 0;
    const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
    const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now() });
    await account.restore({ accountId: 'plugin-navigation', serverIdentityId: 'srv_plugin_navigation', machines: [machine] });
    await account.selectMachine(account.serverId, machine.id, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins);
});

afterEach(async () => {
    standardCleanup();
    await account.reset();
    route.replace.mockReset();
    route.setParams.mockReset();
    route.pathname = '/plugins';
    route.params = {};
});

const rowIds = (screen: Awaited<ReturnType<typeof renderSettingsView>>, prefix: string) => [...new Set(screen
    .findAll((node) => typeof node.props?.testID === 'string' && node.props.testID.startsWith(prefix) && typeof node.props.title === 'string')
    .map((node) => String(node.props.testID)))];

describe('PluginsNavigationColumn', () => {
    it('does not acquire native installed inventory for the presented Browse destination', async () => {
        const { PluginsNavigationColumn } = await import('./PluginsNavigationColumn');
        route.params = { view: 'browse' };
        await renderSettingsView(<PluginsNavigationColumn />);
        expect(capabilityRequests).toBe(0);
    });
    it('keeps destination navigation without rendering a second installed collection or search', async () => {
        const { PluginsNavigationColumn } = await import('./PluginsNavigationColumn');
        const screen = await renderSettingsView(<PluginsNavigationColumn />);
        expect(rowIds(screen, 'plugins-column:plugin:')).toEqual([]);
        expect(screen.findByTestId('plugins-column:search')).toBeNull();
        expect(screen.findByTestId('plugins-column:installed')).not.toBeNull();
        expect(capabilityRequests).toBe(0);
        expect(screen.findByTestId('plugins-column:developers.trigger')).not.toBeNull();
    });
    it('opens Discover by default and each Store kind as its own page', async () => {
        const { PluginsNavigationColumn } = await import('./PluginsNavigationColumn');
        const screen = await renderSettingsView(<PluginsNavigationColumn />);

        const row = (testID: string) => screen.findAll((node) => node.props?.testID === testID && typeof node.props.selected === 'boolean')[0];
        expect(row('plugins-column:discover')?.props.selected).toBe(true);
        expect(row('plugins-column:installed')?.props.selected).toBe(false);
        for (const kind of ['app', 'mcpServer', 'skill', 'agent', 'provider', 'plugin']) expect(row(`plugins-column:${kind}`)).toBeDefined();
        screen.pressByTestId('plugins-column:app');
        expect(route.replace).toHaveBeenCalledWith('/plugins?view=kind&kind=app');
        screen.pressByTestId('plugins-column:skill');
        expect(route.replace).toHaveBeenCalledWith('/plugins?view=kind&kind=skill');
        screen.pressByTestId('plugins-column:installed');
        expect(route.replace).toHaveBeenCalledWith('/plugins?view=installed');
    });
    it('marks the page a Store link opened: a job belongs to Discover, Browse to Plugins', async () => {
        const { PluginsNavigationColumn } = await import('./PluginsNavigationColumn');
        route.params = { view: 'job', job: 'browser' };
        const job = await renderSettingsView(<PluginsNavigationColumn />);
        const selectedIn = (screen: typeof job) => screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('plugins-column:') && node.props.selected === true).map(node => node.props.testID);
        expect([...new Set(selectedIn(job))]).toEqual(['plugins-column:discover']);
        standardCleanup();
        route.params = { view: 'browse' };
        const browse = await renderSettingsView(<PluginsNavigationColumn />);
        expect([...new Set(selectedIn(browse))]).toEqual(['plugins-column:plugin']);
        route.params = {};
    });
    it('leaves its rows untouched when a Store search rewrites only the route query', async () => {
        const { PluginsNavigationColumn } = await import('./PluginsNavigationColumn');
        const { router } = await import('expo-router');
        route.params = { view: 'kind', kind: 'mcpServer' };
        const screen = await renderSettingsView(<PluginsNavigationColumn />);
        const press = () => screen.findByTestId('plugins-column:installed')?.props.onPress;
        const before = press();
        expect(before).toBeTypeOf('function');
        await act(async () => { router.setParams({ q: 'git' }); });
        expect(press()).toBe(before);
    });
    it('selects exactly one Store row for every Store view', async () => {
        const { PluginsNavigationColumn } = await import('./PluginsNavigationColumn');
        const cases: readonly (readonly [Record<string, string>, string])[] = [
            [{}, 'discover'], [{ view: 'discover' }, 'discover'], [{ view: 'installed' }, 'installed'],
            [{ view: 'updates' }, 'updates'], [{ view: 'search', q: 'git' }, 'discover'],
            [{ view: 'category', category: 'x' }, 'discover'], [{ view: 'job', job: 'browser' }, 'discover'],
            ...['app', 'mcpServer', 'skill', 'agent', 'provider', 'plugin'].map((kind): readonly [Record<string, string>, string] => [{ view: 'kind', kind }, kind]),
        ];
        for (const [params, expected] of cases) {
            standardCleanup();
            route.params = params;
            const screen = await renderSettingsView(<PluginsNavigationColumn />);
            const selected = new Set(screen.findAll((node) => typeof node.props?.testID === 'string'
                && node.props.testID.startsWith('plugins-column:') && node.props.selected === true).map(node => node.props.testID));
            expect([...selected], JSON.stringify(params)).toEqual([`plugins-column:${expected}`]);
        }
    });
    it('shows the Updates count only for a known positive count, never as 0 or for an unchecked Account', async () => {
        const { PluginsNavigationColumn } = await import('./PluginsNavigationColumn');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { publishStoreUpdatesCount } = await import('@/components/store/updates/storeUpdatesSummary');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the restored Account lifetime');
        const badge = async (count: number | null) => {
            standardCleanup();
            publishStoreUpdatesCount(lifetime, count);
            const screen = await renderSettingsView(<PluginsNavigationColumn />);
            return screen.findAll((node) => node.props?.testID === 'plugins-column:updates' && 'count' in node.props)[0]?.props.count ?? null;
        };
        expect(await badge(null)).toBeNull();
        expect(await badge(0)).toBeNull();
        expect(await badge(3)).toBe(3);
    });
});
