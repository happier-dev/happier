import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-reanimated', async () =>
    (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('@expo/vector-icons', async () =>
    (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1440, height: 900, scale: 2, fontScale: 1 }),
        Dimensions: { get: () => ({ width: 1440, height: 900, scale: 2, fontScale: 1 }) },
    }));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/settings/agents/codex',
        params: { agentId: 'codex', pluginId: 'happier.agent.codex' },
    }).module);
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('expo-image', () => ({ Image: 'Image' }));

import { DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';

const account = createProviderSettingsAccountHarness();
let projection: ReturnType<typeof PluginProjectionV2Schema.parse>;
let cli: ReturnType<typeof MachineAgentInventoryItemSchema.parse>;
const rpcHomes: Array<Readonly<{ method: string; serverUrl?: string }>> = [];
const rpcRequests = installSessionActionRpcBoundary((request, context) => {
    rpcHomes.push({ method: request.method, serverUrl: context.serverUrl });
    const method = request.method.slice(request.method.indexOf(':') + 1);
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection });
    }
    if (method === RPC_METHODS.CAPABILITIES_DETECT) {
        return { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: Date.now(), data: cli } } };
    }
    return { error: 'Method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
});
const { storage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { AppPaneModalProvider } = await import('@/components/appShell/providers/AppPaneModalProvider');
const { SidebarNavigator } = await import('@/components/navigation/shell/SidebarNavigator');
const { SettingsShell } = await import('@/components/settings/shell/SettingsShell');
const { RealtimeProvider } = await import('@/realtime/RealtimeProvider.web');
const PluginAgentSettingsScreen = (await import('@/app/(app)/settings/agents/[agentId]')).default;

let credentials: Awaited<ReturnType<typeof TokenStorage.getCredentials>> = null;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;

async function renderDesktop(children: React.ReactNode) {
    return await renderScreen(<AuthProvider initialCredentials={credentials}>{children}</AuthProvider>);
}

describe('PluginAgentSettingsScreen desktop render', () => {
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://ui.fixture.test/settings/agents/codex' });
        // Both desktop shells expose this native port. Keep detection, credentials,
        // and their teardown on the real desktopHost adapter.
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: createDesktopSecureStorageBoundary().invoke });
        rpcRequests.length = 0;
        rpcHomes.length = 0;
        const readyAgent = createReadyMachineAgentInventoryFixture([{ agentId: 'codex', title: 'Codex' }])
            .projection.agentsById.codex!;
        projection = PluginProjectionV2Schema.parse({
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
            installedPackagesById: { 'happier.agent.codex': { id: 'happier.agent.codex', displayName: 'Codex',
                version: '1.0.0', enabled: true, source: { kind: 'bundled', locator: 'happier.agent.codex' } } },
            agentsById: { codex: { ...readyAgent, id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                title: 'Codex', subtitle: 'Codex Agent', channel: 'stable', isBuiltIn: true,
                catalogAgentId: 'codex', iconAgentId: 'codex', providerOwnedEnvironmentKeys: [],
                cli: { executable: { binaryName: 'codex', sourcePreference: 'system-first' },
                    install: { manual: { kind: 'none' } }, auth: { support: 'unsupported', loginLaunches: [] } } } },
        });
        cli = MachineAgentInventoryItemSchema.parse({ agentId: 'codex', title: 'Codex', installed: true,
            version: '1.0.0', latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'signedOut', loginSupport: 'unsupported' }, platform: { supported: true },
            install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] });
        await account.restore({ serverIdentityId: 'srv_agent_desktop', currentAccount: true,
            machines: [createMachineFixture({ id: 'm1', activeAt: Date.now(),
                metadata: { ...createMachineFixture().metadata!, displayName: 'Machine One', host: 'm1', homeDir: '/Users/m1' } })],
            settings: { backendEnabledByTargetKey: {}, sessionDefaultPermissionModeByTargetKey: {},
                backendCliSourcePreferenceByTargetKey: {}, connectedAccountPurposeBindingsV1: { v: 1, bindings: [] } } });
        await account.selectMachine(account.serverId, 'm1', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
        credentials = await TokenStorage.getCredentials();
        storage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: true, sidebarCollapsed: false,
            sidebarWidthPx: 320, rightPaneWidthPx: 360,
            detailsPaneWidthPx: 420, bottomPaneHeightPx: 320 });
    });

    afterEach(async () => {
        try {
            standardCleanup();
            clearDaemonMergedProjectionCacheForTests();
            await account.reset();
        } finally {
            vi.unstubAllGlobals();
            browser?.restore();
            browser = undefined;
        }
    });

    it('renders the codex provider route with the canonical machine and CLI chrome', async () => {
        const screen = await renderDesktop(<AppPaneProvider><PluginAgentSettingsScreen /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('settings.agents.detail.header')).toBeTruthy());
        await vi.waitFor(() => {
            const who = screen.findHostByTestId('settings.agents.detail.machines:machine:m1:who');
            expect(who).toBeTruthy();
            expect(who?.findAll(node => node.props.children === '1.0.0').length).toBeGreaterThan(0);
        });
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        expect(rpcHomes).toEqual(expect.arrayContaining([expect.objectContaining({
            method: `m1:${RPC_METHODS.CAPABILITIES_DETECT}`,
            serverUrl: getServerProfileById('srv_agent_desktop')!.serverUrl,
        })]));
    });

    it('writes the provider-scoped default permission through the canonical target-key setting', async () => {
        const screen = await renderDesktop(<AppPaneProvider><PluginAgentSettingsScreen /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('settings.agents.detail.header')).toBeTruthy());
        const permissionChoice = screen.find(node => (
            node.props?.testID === 'settings.agents.detail.permissionMode' && typeof node.props?.onChange === 'function'
            || node.props?.itemTrigger?.itemProps?.testID === 'settings.agents.detail.permissionMode' && typeof node.props?.onSelect === 'function'
        ));
        await act(async () => { (permissionChoice.props.onChange ?? permissionChoice.props.onSelect)('read-only'); });
        await vi.waitFor(() => expect(storage.getState().settings.sessionDefaultPermissionModeByTargetKey).toEqual({
            'agent:happier.agent.codex/codex': 'read-only',
        }));
    });

    it('renders the codex provider route inside the desktop settings shell without crashing', async () => {
        const screen = await renderDesktop(<AppPaneProvider><SettingsShell><PluginAgentSettingsScreen /></SettingsShell></AppPaneProvider>);
        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeTruthy();
        await vi.waitFor(() => expect(screen.findByTestId('settings.agents.detail.header')).toBeTruthy());
    });

    it('renders the codex provider route inside the desktop app-shell provider stack without triggering crash recovery', async () => {
        const screen = await renderDesktop(<AppCrashRecoveryBoundary onRestart={() => {}}><AppPaneModalProvider>
            <CommandPaletteProvider><RealtimeProvider><SettingsShell><PluginAgentSettingsScreen /></SettingsShell></RealtimeProvider></CommandPaletteProvider>
        </AppPaneModalProvider></AppCrashRecoveryBoundary>);
        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeTruthy();
        await vi.waitFor(() => expect(screen.findByTestId('settings.agents.detail.header')).toBeTruthy());
        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
    });

    it('renders the codex provider route alongside the authenticated desktop sidebar shell without triggering crash recovery', async () => {
        const screen = await renderDesktop(<AppCrashRecoveryBoundary onRestart={() => {}}><AppPaneModalProvider>
            <CommandPaletteProvider><RealtimeProvider><><SidebarNavigator /><SettingsShell><PluginAgentSettingsScreen /></SettingsShell></></RealtimeProvider></CommandPaletteProvider>
        </AppPaneModalProvider></AppCrashRecoveryBoundary>);
        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(screen.findHostByTestId('app-shell-title-strip')).toBeTruthy();
        await vi.waitFor(() => expect(screen.findByTestId('settings.agents.detail.header')).toBeTruthy());
        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
    });
});
