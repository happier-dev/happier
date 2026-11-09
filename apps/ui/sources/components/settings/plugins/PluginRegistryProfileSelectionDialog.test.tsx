import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonNpmRegistryProfilesGetResponseV1Schema } from '@happier-dev/protocol/rpc/npmRegistryProfiles';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

// Home HTTP, the daemon's Socket transport and modal presentation are the
// boundaries. Account Registry Actions and profile administration stay real.
const mocks = vi.hoisted(() => ({
    profilesGet: vi.fn(),
    show: vi.fn(),
    prompt: vi.fn(),
    alert: vi.fn(),
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    View: 'View',
    ScrollView: 'ScrollView',
    Text: 'Text',
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
    theme: { colors: { accent: { blue: 'blue' } } },
}));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { show: mocks.show, prompt: mocks.prompt, alert: mocks.alert },
}).module);
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
            || payload.method !== `machine-a:${RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET}`) {
            throw new Error('Unexpected registry profile Socket request');
        }
        return { ok: true, result: await mocks.profilesGet() };
    });
});
const { PluginRegistryProfileSelectionDialog } = await import('./PluginRegistryProfileSelectionDialog');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
let catalog: ReturnType<typeof createPromptLibraryCatalogBoundary>;

const TEAM_SOURCE = {
    id: 'marketplace:team', title: 'Team catalog', sourceUrl: 'https://team.example.test/index.json',
    enabled: true, origin: 'user' as const, addedAtMs: 1, updatedAtMs: 1,
};
const OTHER_SOURCE = {
    id: 'marketplace:other', title: 'Other catalog', sourceUrl: 'https://other.example.test/index.json',
    enabled: true, origin: 'user' as const, addedAtMs: 1, updatedAtMs: 1,
};

async function flush(): Promise<void> {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderDialog() {
    const { resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/useTargetSelection');
    const executionTarget = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: 'srv_plugin_registry', machineId: 'machine-a' });
    if (!executionTarget) throw new Error('Registry selection needs its actual admitted Machine');
    const onResolve = vi.fn();
    const onClose = vi.fn();
    let chrome: Readonly<{ footer?: React.ReactElement }> | null = null;
    const tree = await renderScreen(
            <PluginRegistryProfileSelectionDialog
                requirement={{ registryOrigin: 'https://npm.acme.example', packageName: '@acme/private', registryProfileId: null }}
                pluginName="Private Plugin"
                sourceId="marketplace:team"
                target={{ machine: 'machine-a', server: 'Server A' }}
                daemonOperationsAvailable
                targetSelection={{
                    selectedTarget: executionTarget.target,
                    canExecute: true,
                    resolveExecutionTarget: () => executionTarget,
                }}
                onResolve={onResolve}
                onClose={onClose}
                setChrome={(next: unknown) => { chrome = next as typeof chrome; }}
            />,
    );
    await flush();
    await flush();
    return { tree, onResolve, onClose, footer: () => chrome?.footer ?? null };
}

describe('PluginRegistryProfileSelectionDialog', () => {
    beforeEach(async () => {
        for (const mock of Object.values(mocks)) mock.mockReset();
        mocks.profilesGet.mockResolvedValue(DaemonNpmRegistryProfilesGetResponseV1Schema.parse({
            status: 'success',
            snapshot: {
                protocolVersion: 1, revision: 2, pausedSources: [],
                profiles: [{
                    profileId: 'registry_acme', displayName: 'Acme', origin: 'https://npm.acme.example', scopes: ['@acme'],
                    useAsDefault: false, allowPrivateNetwork: false, hasCredentials: true,
                    authenticationState: 'configured', availability: 'available', lastSuccessfulCheckAtMs: 1, updatedAtMs: 1,
                }],
            },
        }));
        mocks.show.mockReturnValue('npm-registry-profile-editor');
        catalog = createPromptLibraryCatalogBoundary({ records: [{
            key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [TEAM_SOURCE, OTHER_SOURCE].map(source => ({
                id: source.id, title: source.title, url: source.sourceUrl, enabled: true,
                format: 'happier-catalog' as const, kinds: ['plugin' as const], addedAt: 1,
            })) },
        }], revision: 4 });
        const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
        await account.restore({ accountId: 'plugin-registry', serverIdentityId: 'srv_plugin_registry', machines: [machine] });
        const root = '/v1/account/entity-rows/prompt-library';
        account.home.answer(account.serverId, `GET ${root}`, { select: async () => {
            const response = await catalog.handle(root);
            if (!response) throw new Error('Expected Registry catalog read route');
            return { status: response.status, body: await response.json() };
        } });
        account.home.answer(account.serverId, `POST ${root}/registry-sources`, { select: async input => {
            const response = await catalog.handle(`${root}/registry-sources`, { method: 'POST', body: JSON.stringify(input) });
            if (!response) throw new Error('Expected Registry catalog mutation route');
            return { status: response.status, body: await response.json() };
        } });
    });
    afterEach(async () => { standardCleanup(); await account.reset(); });

    it('binds the listing source to a chosen profile through the source registry owner', async () => {
        const { tree } = await renderDialog();

        // Only the source the install resolves through is offered for binding.
        const bindingMenus = () => tree.findAllByType(DropdownMenu).filter(node =>
            String(node.props.testID).startsWith('settings.plugins.registries.marketplaceBinding.'));
        await waitForHomeGovernance(() => expect(bindingMenus()).toHaveLength(1));
        const menus = bindingMenus();
        expect(menus.map((node) => node.props.testID)).toEqual(['settings.plugins.registries.marketplaceBinding.marketplace:team']);
        expect(menus[0]!.props.selectedId).toBe('');

        await act(async () => { menus[0]!.props.onSelect('registry_acme'); });
        await flush();

        await waitForHomeGovernance(() => expect(catalog.read('registry-sources').value).toMatchObject({ sources: [
            expect.objectContaining({ id: 'marketplace:team', npmRegistryProfileId: 'registry_acme' }),
            expect.objectContaining({ id: 'marketplace:other' }),
        ] }));
        // The binding shown is the owner's settled answer, not a local guess.
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.marketplaceBinding.marketplace:team' }).props.selectedId)
            .toBe('registry_acme');
    });

    it('starts a new profile from the registry the daemon named', async () => {
        const { tree } = await renderDialog();

        await act(async () => { await tree.root.findByProps({ testID: 'settings.plugins.registries.add' }).props.onPress(); });

        expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({
                mode: 'create',
                subject: {
                    displayName: 'npm.acme.example',
                    origin: 'https://npm.acme.example',
                    scopes: ['@acme'],
                    useAsDefault: false,
                    allowPrivateNetwork: false,
                },
            }),
        }));
    });

    it('resolves Continue and Cancel as the user answer', async () => {
        /** The footer is card chrome the modal host renders; its buttons are read from it directly. */
        const footerButton = (footer: React.ReactElement | null, testID: string) => (
            React.Children.toArray((footer?.props as Readonly<{ children?: React.ReactNode }>)?.children) as React.ReactElement<{
                testID?: string;
                onPress: () => void;
            }>[]
        ).find((child) => child.props.testID === testID)!;

        const continued = await renderDialog();
        act(() => { footerButton(continued.footer(), 'settings.plugins.registrySelection.continue').props.onPress(); });
        expect(continued.onResolve).toHaveBeenCalledWith(true);
        expect(continued.onClose).toHaveBeenCalled();

        const cancelled = await renderDialog();
        act(() => { footerButton(cancelled.footer(), 'settings.plugins.registrySelection.cancel').props.onPress(); });
        expect(cancelled.onResolve).toHaveBeenCalledWith(false);
    });
});
