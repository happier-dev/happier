import * as React from 'react';
import { NavigationContext, useNavigation } from '@react-navigation/native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';

installSettingsViewCommonModuleMocks({ storage: 'real' });
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useIsFocused: () => true };
});
// Native recycler geometry is external; actual Detail/model rows remain real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
// Cold graph compilation is collection setup, outside the behavioral hook deadline.
await loadSyncSingletonForTests();
afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

function NavigationBoundary(props: React.PropsWithChildren) {
    return <NavigationContext.Provider value={useNavigation()}>{props.children}</NavigationContext.Provider>;
}

describe('Provider Detail addressed Account custody', () => {
    it.each(['Home selection', 'peer Account replacement', 'Home removal'] as const)(
        'retires native name and manual-model drafts on %s without sending them to another Account', async change => {
        const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
            name: 'Private draft source', baseUrl: 'https://private-draft.test/v1', requiresApiKey: false });
        const catalog = (displayName: string) => ProviderConnectionsCatalogV1Schema.parse({
            ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_colliding', source: { kind: 'custom', template }, role: 'named',
                displayName, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const activeCatalog = catalog('Active Account name');
        await account.restore({ catalog: activeCatalog, serverIdentityId: 'srv_draft_active', machines: [],
            waivedActions: ['providers.connections.update', 'providers.models.manual.add'] });
        const peerUrl = 'https://draft-peer.test';
        const peerServerId = await account.addHome({ name: 'Draft peer', serverUrl: peerUrl,
            serverIdentityId: 'srv_draft_peer', accountId: 'peer-a', active: false });
        account.home.answer(peerServerId, 'GET /v2/account/settings', { body: { version: 1,
            content: { t: 'plain', v: { actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: {}, approvalWaivedSurfaces: {
                    'providers.connections.update': ['ui'], 'providers.models.manual.add': ['ui'],
                },
            }) } },
        } });
        account.home.answer(peerServerId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog('Peer Account A name') } },
        });
        const [{ useProviderCatalog }, { useServerCredentialAccountScopeBinding }] = await Promise.all([
            import('@/sync/store/useProviderCatalog'), import('@/sync/domains/scope/useServerCredentialAccountScopes'),
        ]);
        const peerCatalog = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(peerServerId);
            return useProviderCatalog(binding?.scope ?? null);
        });
        await waitForHomeGovernance(() => expect(peerCatalog.getCurrent()).toMatchObject({ status: 'ready', revision: 1 }));
        await account.selectMachine(change === 'Home selection' ? account.serverId : peerServerId, 'missing-draft-machine');
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const { ProviderConnectionModelsScreen } = await import('./models/ProviderConnectionModelsScreen');
        const screen = await renderScreen(<NavigationBoundary>
            <ProviderConnectionDetailScreen connectionId="pc_colliding" />
        </NavigationBoundary>);
        const modelsScreen = await renderScreen(<NavigationBoundary>
            <ProviderConnectionModelsScreen connectionId="pc_colliding" startAdding />
        </NavigationBoundary>);
        const field = (id: string) => [screen, modelsScreen].flatMap(view => view.findAllByTestId(id))
            .find(node => typeof node.props.onChangeText === 'function');
        await waitForHomeGovernance(() => expect(field('provider-manual-model-ids')).toBeDefined());
        await React.act(async () => {
            field('provider-connection-name')!.props.onChangeText('Private draft name');
            field('provider-manual-model-ids')!.props.onChangeText('private-draft-model');
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const selectedProfile = profiles.getServerProfileById(change === 'Home selection' ? account.serverId : peerServerId)!;
        await React.act(async () => { await profiles.upsertServerProfile({ serverUrl: selectedProfile.serverUrl, name: 'Renamed same Account Home' }); });
        expect(field('provider-connection-name')!.props.value).toBe('Private draft name');
        expect(field('provider-manual-model-ids')!.props.value).toBe('private-draft-model');
        if (change === 'Home selection') {
            await React.act(async () => { await account.selectMachine(peerServerId, 'missing-draft-machine'); });
        } else if (change === 'peer Account replacement') {
            account.home.answer(peerServerId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
                body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog('Peer Account B name') } },
            });
            await React.act(async () => { await account.home.switchAccount(peerServerId, 'peer-b'); });
        } else {
            await React.act(async () => { await profiles.removeServerProfile(selectedProfile.id); });
        }
        if (change === 'Home removal') {
            await waitForHomeGovernance(() => expect(screen.findByTestId('settings.providers.administration.target.state')).not.toBeNull());
            expect(field('provider-connection-name')).toBeUndefined();
            expect(field('provider-manual-model-ids')).toBeUndefined();
        } else {
            const expectedName = change === 'Home selection' ? 'Peer Account A name' : 'Peer Account B name';
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(expectedName));
            // The separate Models page reads the newly addressed Account independently of Detail.
            await waitForHomeGovernance(() => expect(field('provider-manual-model-ids')?.props.value).toBe(''));
            await React.act(async () => {
                field('provider-connection-name')!.props.onBlur?.();
                await flushHookEffects({ cycles: 2, turns: 3 });
            });
            expect({ name: field('provider-connection-name')?.props.value,
                manualModels: field('provider-manual-model-ids')?.props.value,
                writes: account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
                    .filter(request => ProviderConnectionsRowMutationV1Schema.safeParse(request.input).success),
            }).toEqual({ name: expectedName, manualModels: '', writes: [] });
        }
        expect(account.catalogMutations).toEqual([]);
        expect(account.readCatalogRow()).toMatchObject({ revision: 1, content: { t: 'plain', v: activeCatalog } });
        expect(rpc.state.requests).toEqual([]);
    });
    it.each(['same', 'foreign', 'removed', 'ambiguous'] as const)('preserves the selected missing %s Home instead of adopting an active colliding connection', async home => {
        const privateTitle = 'Private active Detail connection';
        const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
            name: 'Private source', baseUrl: 'https://private-models.test/v1', requiresApiKey: false });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_colliding', source: { kind: 'custom', template }, role: 'named',
                displayName: privateTitle, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const { serverId } = await account.restore({ catalog, serverIdentityId: 'srv_detail_active', machines: [] });
        const { useProviderCatalogForServer } = await import('@/sync/store/useProviderCatalog');
        const catalogReader = await renderHook(() => useProviderCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(catalogReader.getCurrent()).toMatchObject({ status: 'ready', revision: 1 }));
        const selectedServerId = home === 'same' ? serverId : await account.addHome({
            name: 'Foreign Detail Home', serverUrl: 'https://foreign-detail-home.test', accountId: 'peer-account',
            serverIdentityId: 'srv_detail_foreign', active: false,
        });
        await account.selectMachine(selectedServerId, 'missing-detail-machine');
        const profiles = await import('@/sync/domains/server/serverProfiles');
        if (home === 'foreign') {
            const peerCatalog = ProviderConnectionsCatalogV1Schema.parse({ ...catalog,
                connections: catalog.connections.map(row => ({ ...row, displayName: 'Addressed peer Detail connection' })),
            });
            account.home.answer(selectedServerId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
                body: { status: 'present', revision: 1, content: { t: 'plain', v: peerCatalog } },
            });
            const [{ useProviderCatalog }, { useServerCredentialAccountScopeBinding }] = await Promise.all([
                import('@/sync/store/useProviderCatalog'), import('@/sync/domains/scope/useServerCredentialAccountScopes'),
            ]);
            const peerReader = await renderHook(() => {
                const { binding } = useServerCredentialAccountScopeBinding(selectedServerId);
                return useProviderCatalog(binding?.scope ?? null);
            });
            await waitForHomeGovernance(() => expect(peerReader.getCurrent()).toMatchObject({ status: 'ready', revision: 1 }));
        } else if (home === 'removed') {
            const selectedProfile = profiles.getServerProfileById(selectedServerId);
            expect(selectedProfile).not.toBeNull();
            await profiles.removeServerProfile(selectedProfile!.id);
            expect(profiles.resolveServerProfileForPortableIdentity('srv_detail_foreign').kind).toBe('missing');
        } else if (home === 'ambiguous') {
            // Persisted device profile storage is the genuine boundary. Keep the real
            // profile parser/resolver, including its explicitly supported ambiguity refusal.
            const [{ MMKV }, { scopedStorageId, readStorageScopeFromEnv }] = await Promise.all([
                import('react-native-mmkv'), import('@/utils/system/storageScope'),
            ]);
            const device = new MMKV({ id: scopedStorageId('server-profiles', readStorageScopeFromEnv()) });
            const persisted = JSON.parse(device.getString('server-state-v1')!) as {
                servers: Record<string, import('@/sync/domains/server/serverProfiles').ServerProfile>;
            };
            const selectedProfile = profiles.getServerProfileById(selectedServerId)!;
            persisted.servers['duplicate-foreign-profile'] = { ...selectedProfile, id: 'duplicate-foreign-profile',
                serverIdentityId: 'srv_detail_duplicate', legacyServerIds: ['srv_detail_foreign'],
                serverUrl: 'https://ambiguous-foreign-detail-home.test', canonicalServerUrl: 'https://ambiguous-foreign-detail-home.test' };
            device.set('server-state-v1', JSON.stringify(persisted));
            expect(profiles.resolveServerProfileForPortableIdentity('srv_detail_foreign').kind).toBe('ambiguous');
        }
        const { useProviderSettingsTarget } = await import('@/providers/hooks/targetMachine');
        const target = await renderHook(() => useProviderSettingsTarget());
        expect(target.getCurrent().selection.selectedTarget).toEqual({
            serverIdentityId: home === 'same' ? 'srv_detail_active' : 'srv_detail_foreign', machineId: 'missing-detail-machine',
        });
        expect(target.getCurrent().selection.state.kind).not.toBe('online');
        expect(target.getCurrent().selectedTargetServerMatchesActiveAccount).toBe(home === 'same');
        expect(target.getCurrent().resolveCurrentTarget()).toBeNull();
        expect(target.getCurrent().accountAddressAvailable).toBe(home === 'same' || home === 'foreign');
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<NavigationBoundary><ProviderConnectionDetailScreen connectionId="pc_colliding" /></NavigationBoundary>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-header')
            ?? screen.findByTestId('settings.providers.administration.target.state')).not.toBeNull());
        expect(account.catalogMutations).toEqual([]);
        expect(rpc.state.requests).toEqual([]);
        expect(account.readCatalogRow()).toMatchObject({ revision: 1, content: { t: 'plain', v: catalog } });
        if (home === 'same') expect(screen.getTextContent()).toContain(privateTitle);
        else {
            expect(screen.getTextContent()).not.toContain(privateTitle);
            if (home === 'foreign') expect(screen.getTextContent()).toContain('Addressed peer Detail connection');
        }
    });

    it('forwards explicit unavailable address admission to the existing Account mutation client', async () => {
        const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
            name: 'Active mutation source', baseUrl: 'https://active-mutation.test/v1', requiresApiKey: false });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_colliding', source: { kind: 'custom', template }, role: 'named',
                displayName: 'Retained active connection', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const { serverId } = await account.restore({ catalog, machines: [], waivedActions: ['providers.connections.delete'] });
        const [{ useProviderActionClient }, { useProviderConnectionMutation }] = await Promise.all([
            import('@/providers/actions/useProviderActionClient'), import('@/providers/hooks/useProviderConnectionMutation'),
        ]);
        const input = { resolveTarget: () => null, serverId, refresh: async () => undefined, initiatingLifetime: null };
        const mutation = await renderHook(() => ({ ...useProviderConnectionMutation(input),
            ready: useProviderActionClient(serverId).ready }));
        await waitForHomeGovernance(() => expect(mutation.getCurrent().ready).toBe(true));
        await React.act(async () => { await mutation.getCurrent().run({ action: 'delete', connectionId: 'pc_colliding' }); });
        expect(account.catalogMutations).toEqual([]);
        expect(account.readCatalogRow()).toMatchObject({ revision: 1, content: { t: 'plain', v: catalog } });
        expect(mutation.getCurrent().error).toMatchObject({ code: 'provider_authorization_changed' });
        expect(rpc.state.requests).toEqual([]);
    });

    it('refuses a captured peer write after its Home is removed without adopting an active colliding connection', async () => {
        const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
            name: 'Private source', baseUrl: 'https://private-models.test/v1', requiresApiKey: false });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_colliding', source: { kind: 'custom', template }, role: 'named',
                displayName: 'Private active connection', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        await account.restore({ catalog, serverIdentityId: 'srv_detail_active', machines: [], waivedActions: ['providers.connections.delete'] });
        const peerServerId = await account.addHome({ name: 'Peer Detail Home', serverUrl: 'https://peer-detail-home.test',
            serverIdentityId: 'srv_detail_peer', accountId: 'peer-account', active: false });
        account.home.answer(peerServerId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        await account.selectMachine(peerServerId, 'missing-peer-machine');
        const [{ useProviderSettingsTarget }, { useProviderConnectionMutation }, { useProviderActionClient }, profiles] = await Promise.all([
            import('@/providers/hooks/targetMachine'), import('@/providers/hooks/useProviderConnectionMutation'),
            import('@/providers/actions/useProviderActionClient'), import('@/sync/domains/server/serverProfiles'),
        ]);
        const refresh = async () => undefined;
        const mutation = await renderHook(() => {
            const target = useProviderSettingsTarget();
            const initiatingLifetime = target.accountAddressAvailable ? undefined : null;
            return { ...useProviderConnectionMutation({ resolveTarget: target.resolveCurrentTarget,
                serverId: target.accountServerId, initiatingLifetime, refresh }),
                ready: useProviderActionClient(target.accountServerId, initiatingLifetime).ready };
        });
        await waitForHomeGovernance(() => expect(mutation.getCurrent().ready).toBe(true));
        const capturedRun = mutation.getCurrent().run;
        await React.act(async () => { await profiles.removeServerProfile(profiles.getServerProfileById(peerServerId)!.id); });
        await mutation.rerender();
        await waitForHomeGovernance(() => expect(mutation.getCurrent().ready).toBe(false));
        await React.act(async () => { await expect(capturedRun({ action: 'delete', connectionId: 'pc_colliding' })).resolves.toBeNull(); });
        expect(account.catalogMutations).toEqual([]);
        expect(account.readCatalogRow()).toMatchObject({ revision: 1, content: { t: 'plain', v: catalog } });
        expect(account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
            .filter(request => ProviderConnectionsRowMutationV1Schema.safeParse(request.input).success)).toEqual([]);
        expect(rpc.state.requests).toEqual([]);
    });
});
