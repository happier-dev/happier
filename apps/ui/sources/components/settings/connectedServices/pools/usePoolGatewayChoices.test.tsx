import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary, installProviderConnectionsCatalogHttpBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { t } from '@/text';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const route = vi.hoisted(() => ({ params: {} as Record<string, string | string[] | undefined> }));
const modalConfirm = vi.hoisted(() => vi.fn(async () => true));
installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual('@/text'), router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => route.params }).module;
}, modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalConfirm } }).module;
} });

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { usePoolGatewayChoices } = await import('./usePoolGatewayChoices');
const { PoolGatewaySection } = await import('./PoolGatewaySection');
const { useProviderSettingsTarget } = await import('@/providers/hooks/targetMachine');
const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const target = { kind: 'group' as const, service, groupId: 'pool-a' };

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); route.params = {}; });
beforeEach(() => { modalConfirm.mockReset(); modalConfirm.mockResolvedValue(true); });

async function openGatewayDraft(href: string | null) {
    expect(href).not.toBeNull();
    route.params = Object.fromEntries(new URL(href!, 'https://navigation.test').searchParams);
    const { ConnectedServiceGatewayPage } = await import('../ConnectedServiceGatewayPage');
    const screen = await renderScreen(<ConnectedServiceGatewayPage />);
    await vi.waitFor(() => expect(screen.findByTestId('settings-provider-authoring-connect')).toBeTruthy());
    await vi.waitFor(() => expect(screen.findByTestId('settings-provider-authoring-connect')?.props.loading).not.toBe(true));
    expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled, screen.getTextContent()).toBe(false);
    return screen;
}

describe('pool gateway Action wiring', () => {
    it('confirms first-gateway creation and slot removal inline through the real Account Action family exactly once', async () => {
        const { serverId } = await account.restore({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [], settings: {
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'providers.connections.create_contribution': { approvalRequiredSurfaces: ['ui'] },
                'providers.connections.update': { approvalRequiredSurfaces: ['ui'] },
            } }),
        } });
        await account.selectMachine(account.serverId, null);
        const stored = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
        const resolveTarget = () => null;
        const hook = await renderHook(() => usePoolGatewayChoices({ target, enabled: true, accountServerId: account.serverId, accountAddressAvailable: true, resolveTarget }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().firstGateway).toEqual({ purpose: 'openai-upstream' }));
        const draft = await openGatewayDraft(hook.getCurrent().gatewayDraftRoute());
        expect(account.home.artifacts(serverId).list()).toEqual([]);
        expect(stored.catalog.connections).toEqual([]);
        expect(stored.writes).toBe(0);
        const createConfirmation = createDeferred<boolean>();
        modalConfirm.mockImplementationOnce(() => createConfirmation.promise);
        draft.pressByTestId('settings-provider-authoring-connect');
        await waitForHomeGovernance(() => expect(modalConfirm).toHaveBeenCalledOnce());
        expect(stored.writes).toBe(0);
        expect(account.home.artifacts(serverId).list()).toEqual([]);
        // The explicit Create owns its confirmation; the retained pool has no second write.
        expect(hook.getCurrent().pendingApproval).toBeNull();
        await hook.rerender();
        await act(async () => { createConfirmation.resolve(true); });
        await waitForHomeGovernance(() => expect(stored.writes).toBe(1));
        await draft.unmount();
        expect(stored.writes).toBe(1);
        expect(stored.catalog.connections).toHaveLength(1);
        const created = stored.catalog.connections[0]!;
        expect(created).toMatchObject({ deployment: { kind: 'managedLocal' }, purposeBindingDefaults: { 'openai-upstream': target } });
        expect(stored.catalog.accountGrants.map(grant => grant.connectionId)).toEqual([created.id]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().choices).toEqual([
            expect.objectContaining({ connectionId: created.id, enabled: true }),
        ]));
        expect(hook.getCurrent().pending).toBe(false);
        const slotConfirmation = createDeferred<boolean>();
        modalConfirm.mockImplementationOnce(() => slotConfirmation.promise);
        let removing: Promise<boolean> | undefined;
        await act(async () => { removing = hook.getCurrent().setEnabled(created.id, false); });
        await waitForHomeGovernance(() => expect(modalConfirm).toHaveBeenCalledTimes(2));
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().pendingApproval).toBeNull();
        expect(hook.getCurrent().pending).toBe(true);
        expect(stored.writes).toBe(1);
        expect(stored.catalog.connections[0]?.purposeBindingDefaults).toEqual({ 'openai-upstream': target });
        expect(account.home.artifacts(serverId).list()).toEqual([]);
        await act(async () => { slotConfirmation.resolve(true); });
        await act(async () => { await expect(removing).resolves.toBe(true); });
        expect(stored.writes).toBe(2);
        expect(stored.catalog.connections).toEqual([expect.objectContaining({ id: created.id, purposeBindingDefaults: {} })]);
        expect(hook.getCurrent().pending).toBe(false);
        expect(rpc.state.requests).toEqual([]);
    });
    it.each(['none', 'offline'] as const)('writes the Account slot with %s machine availability despite an unrelated unavailable declaration', async availability => {
        const gateway = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: { 'openai-upstream': { ...target, groupId: 'pool-b' } }, revision: 3, createdAt: 1, updatedAt: 1 });
        const unavailable = ProviderConnectionV1Schema.parse({ ...gateway, id: 'pc_unavailable',
            source: { kind: 'contribution', contributionKey: 'example.unavailable/managed' }, purposeBindingDefaults: {} });
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [gateway, unavailable] });
        let revision = 1;
        await account.restore({ serverIdentityId: 'srv_pool_gateway', catalog, machines: availability === 'offline'
            ? [createMachineFixture({ id: 'machine-a', active: false, activeAt: 1 })] : [],
            waivedActions: ['providers.connections.update'] });
        if (availability === 'offline') await account.selectMachine(account.serverId, 'machine-a');
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account slot write');
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const resolveTarget = () => null;
        const hook = await renderHook(() => usePoolGatewayChoices({ target, enabled: true, accountServerId: account.serverId, accountAddressAvailable: true, resolveTarget }));
        await vi.waitFor(() => expect(hook.getCurrent().choices).toHaveLength(1));
        expect(hook.getCurrent().ready).toBe(true);
        const screen = await renderScreen(<PoolGatewaySection testID="pool-gateway" usage={hook.getCurrent()}
            poolTitle="Work pool" serviceLabel="Codex" nativeAgentTitles={[]} />);
        await act(async () => { screen.findByTestId('pool-gateway:pc_gateway:toggle')?.props.onValueChange(true); });
        await vi.waitFor(() => expect(catalog.connections[0]?.purposeBindingDefaults?.['openai-upstream']).toEqual(target));
        expect(screen.findByTestId('pool-gateway:pc_gateway:replace')).toBeNull();
        expect(catalog.connections[0]?.purposeBindingDefaults?.['openai-upstream']).toEqual(target);
        expect(catalog.connections[0]?.revision).toBe(4);
        expect(catalog.connections[1]).toEqual(unavailable);
        await act(async () => { expect(await hook.getCurrent().setEnabled(gateway.id, false)).toBe(true); });
        expect(catalog.connections[0]?.purposeBindingDefaults).toEqual({});
        expect(rpc.state.requests).toEqual([]);
    });
    it.each([false, true])('P8 gateway capability checklist · Create retains the pool and an independent same-name external source; external=%s', async hasExternal => {
        const half = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_half', source: { kind: 'contribution',
            contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' }, role: 'named',
            displayName: t('settingsProvidersCollection.gateway.mainGatewayName'), displayNameMode: 'custom',
            revision: 0, createdAt: 1, updatedAt: 1 });
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: hasExternal ? [half] : [] });
        let revision = 1;
        await account.restore({ serverIdentityId: 'srv_first_gateway', catalog, machines: [], waivedActions: [
            'providers.connections.create_contribution', 'providers.connections.update', 'providers.connections.enabled.set'] });
        await account.selectMachine(account.serverId, null);
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account write');
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const resolveTarget = () => null;
        const hook = await renderHook(() => usePoolGatewayChoices({ target, enabled: true, accountServerId: account.serverId, accountAddressAvailable: true, resolveTarget }));
        await vi.waitFor(() => expect(hook.getCurrent().firstGateway).toEqual({ purpose: 'openai-upstream' }));
        expect(hook.getCurrent().choices).toEqual([]);
        let href: string | null = null;
        const poolPage = await renderScreen(<PoolGatewaySection testID="pool-gateway" usage={hook.getCurrent()}
            poolTitle="Work pool" serviceLabel="Codex" nativeAgentTitles={[]} onOpenGatewayDraft={value => { href = value; }} />);
        await act(async () => { poolPage.findByTestId('pool-gateway:first:toggle')!.props.onValueChange(false); });
        expect(href).toBeNull();
        await act(async () => { poolPage.findByTestId('pool-gateway:first:toggle')!.props.onValueChange(true); });
        const draft = await openGatewayDraft(href);
        expect(catalog.connections).toEqual(hasExternal ? [half] : []);
        expect(revision).toBe(1);
        await draft.pressByTestIdAsync('settings-provider-authoring-connect');
        await vi.waitFor(() => expect(revision).toBe(2));
        await draft.unmount();
        expect(catalog.connections).toHaveLength(hasExternal ? 2 : 1);
        const created = catalog.connections[hasExternal ? 1 : 0]!;
        if (hasExternal) {
            expect(catalog.connections[0]).toEqual(half);
            expect(created.id).not.toBe(half.id);
        }
        expect(created).toMatchObject({ displayName: t('settingsProvidersCollection.gateway.mainGatewayName'), deployment: { kind: 'managedLocal' },
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            purposeBindingDefaults: { 'openai-upstream': target } });
        expect(catalog.accountGrants.map(grant => grant.connectionId)).toEqual([created.id]);
        expect(revision).toBe(2); // The complete gateway is acknowledged in one Account-row write.
        await vi.waitFor(() => expect(hook.getCurrent().choices).toEqual([
            expect.objectContaining({ connectionId: created.id, title: t('settingsProvidersCollection.gateway.mainGatewayName'), enabled: true })]));
        expect(hook.getCurrent().firstGateway).toBeNull();
        await act(async () => { expect(await hook.getCurrent().setEnabled(created.id, false)).toBe(true); });
        expect(catalog.connections).toEqual([...(hasExternal ? [half] : []), expect.objectContaining({ id: created.id, purposeBindingDefaults: {} })]);
        expect(rpc.state.requests).toEqual([]);
    });
    it('does not offer slots from an unavailable Gateway declaration', async () => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'example.unavailable/managed' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: { 'openai-upstream': { ...target, groupId: 'pool-b' } }, revision: 3, createdAt: 1, updatedAt: 1 });
        await account.restore({ catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] },
            waivedActions: ['providers.connections.update'] });
        const resolveTarget = () => null;
        const hook = await renderHook(() => usePoolGatewayChoices({ target, enabled: true, accountServerId: account.serverId, accountAddressAvailable: true, resolveTarget }));
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().choices).toEqual([]);
        // An existing gateway the app cannot read is not "no gateway": nothing is created beside it.
        expect(hook.getCurrent().firstGateway).toBeNull();
        await expect(hook.getCurrent().setEnabled(saved.id, true)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        expect(rpc.state.requests).toEqual([]);
    });
    it('refuses active Account slot writes and a captured callback when the selected Home becomes foreign or removed', async () => {
        const gateway = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: { 'openai-upstream': { ...target, groupId: 'pool-b' } }, revision: 3, createdAt: 1, updatedAt: 1 });
        const catalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [gateway] };
        await account.restore({ catalog, serverIdentityId: 'srv_pool_active', machines: [],
            waivedActions: ['providers.connections.update'] });
        const hook = await renderHook(() => {
            const providerTarget = useProviderSettingsTarget();
            return usePoolGatewayChoices({ target, enabled: true, resolveTarget: providerTarget.resolveCurrentTarget,
                accountServerId: providerTarget.accountServerId, accountAddressAvailable: providerTarget.accountAddressAvailable });
        });
        await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
        const capturedSetEnabled = hook.getCurrent().setEnabled;
        const peerServerId = await account.addHome({ name: 'Foreign pool Home', serverUrl: 'https://foreign-pool.test',
            serverIdentityId: 'srv_pool_foreign', accountId: 'peer-account', active: false });
        await act(async () => { await account.selectMachine(peerServerId, 'missing-peer-machine'); });
        await hook.rerender();
        expect(hook.getCurrent().ready).toBe(false);
        expect(hook.getCurrent().choices).toEqual([]);
        await act(async () => { expect(await capturedSetEnabled(gateway.id, true)).toBe(false); });
        await expect(hook.getCurrent().setEnabled(gateway.id, true)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        await act(async () => { await profiles.removeServerProfile(profiles.getServerProfileById(peerServerId)!.id); });
        await hook.rerender();
        expect(hook.getCurrent().ready).toBe(false);
        expect(hook.getCurrent().choices).toEqual([]);
        await expect(hook.getCurrent().setEnabled(gateway.id, true)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        expect(account.catalogMutations).toEqual([]);
        expect(account.readCatalogRow()).toMatchObject({ revision: 1, content: { t: 'plain', v: catalog } });
        expect(rpc.state.requests).toEqual([]);
    });

});

describe('pool gateway recovery', () => {
    const gateway = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
        source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
        role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
        purposeBindingDefaults: { 'openai-upstream': { ...target, groupId: 'pool-b' } }, revision: 3, createdAt: 1, updatedAt: 1 });
    function PoolGatewayScreen() {
        const providerTarget = useProviderSettingsTarget();
        const usage = usePoolGatewayChoices({ target, enabled: true, resolveTarget: providerTarget.resolveCurrentTarget,
            accountServerId: providerTarget.accountServerId, accountAddressAvailable: providerTarget.accountAddressAvailable });
        return <PoolGatewaySection testID="pool-gateway" usage={usage} poolTitle="Work pool" serviceLabel="Codex" nativeAgentTitles={[]} />;
    }
    const slot = () => account.readCatalogRow()?.content && 'v' in account.readCatalogRow()!.content!
        ? (account.readCatalogRow()!.content as { v: { connections: typeof gateway[] } }).v.connections[0]?.purposeBindingDefaults?.['openai-upstream']
        : undefined;
    const toggle = async (screen: Awaited<ReturnType<typeof renderScreen>>, value: boolean) => {
        await act(async () => { screen.findByTestId('pool-gateway:pc_gateway:toggle')?.props.onValueChange(value); });
    };

    it('offers Retry after a proven rollback and admits exactly one more update when it is pressed', async () => {
        await account.restore({ serverIdentityId: 'srv_pool_retry', catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [gateway] },
            machines: [], waivedActions: ['providers.connections.update'] });
        let rollbacks = 1;
        account.interceptCatalogMutation((_input, next) => rollbacks-- > 0
            ? { status: 503, body: { error: 'database_transaction_conflict_exhausted' } } : next());
        const screen = await renderScreen(<PoolGatewayScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('pool-gateway:pc_gateway:toggle')?.props.disabled).toBe(false));
        await toggle(screen, true);
        await vi.waitFor(() => expect(screen.findByTestId('provider-error:provider_catalog_unavailable')).toBeTruthy());
        expect(account.catalogMutations).toHaveLength(1);
        expect(slot()).toEqual({ ...target, groupId: 'pool-b' });
        await act(async () => { await screen.pressByTestIdAsync('provider-error-action:provider_catalog_unavailable'); });
        await vi.waitFor(() => expect(slot()).toEqual(target));
        expect(account.catalogMutations).toHaveLength(2);
        expect(screen.findByTestId('provider-error:provider_catalog_unavailable')).toBeNull();
    });

    it('reviews current state after an unknown write without repeating the mutation, and keeps asking while the read fails', async () => {
        await account.restore({ serverIdentityId: 'srv_pool_unknown', catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [gateway] },
            machines: [], waivedActions: ['providers.connections.update'] });
        let readsFail = false;
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { select: () => readsFail
            ? { status: 503, body: { error: 'unavailable' } }
            : { body: { status: 'present', revision: account.readCatalogRow()!.revision, content: account.readCatalogRow()!.content } } });
        account.interceptCatalogMutation(() => { readsFail = true; return { dispatchThenFail: true }; });
        const screen = await renderScreen(<PoolGatewayScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('pool-gateway:pc_gateway:toggle')?.props.disabled).toBe(false));
        await toggle(screen, true);
        const action = 'provider-error-action:provider_rpc_mutation_outcome_unknown';
        await vi.waitFor(() => expect(screen.findByTestId(action)).toBeTruthy());
        expect(account.catalogMutations).toHaveLength(1);
        await act(async () => { await screen.pressByTestIdAsync(action); });
        expect(screen.findByTestId(action)).toBeTruthy(); // the read failed again: still unresolved
        readsFail = false;
        await act(async () => { await screen.pressByTestIdAsync(action); });
        await vi.waitFor(() => expect(screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown')).toBeNull());
        expect(account.catalogMutations).toHaveLength(1);
        await vi.waitFor(() => expect(screen.findByTestId('pool-gateway:pc_gateway:toggle')?.props.disabled).toBe(false));
    });

    it('drops the recovery when the Account that authored the failed write is no longer selected', async () => {
        await account.restore({ serverIdentityId: 'srv_pool_retired', catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [gateway] },
            machines: [], waivedActions: ['providers.connections.update'] });
        account.interceptCatalogMutation(() => ({ status: 503, body: { error: 'database_transaction_conflict_exhausted' } }));
        const screen = await renderScreen(<PoolGatewayScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('pool-gateway:pc_gateway:toggle')?.props.disabled).toBe(false));
        await toggle(screen, true);
        await vi.waitFor(() => expect(screen.findByTestId('provider-error-action:provider_catalog_unavailable')).toBeTruthy());
        const peerServerId = await account.addHome({ name: 'Foreign pool Home', serverUrl: 'https://foreign-pool.test',
            serverIdentityId: 'srv_pool_foreign_retry', accountId: 'peer-account', active: false });
        await act(async () => { await account.selectMachine(peerServerId, 'missing-peer-machine'); });
        await vi.waitFor(() => expect(screen.findByTestId('provider-error-action:provider_catalog_unavailable')).toBeNull());
        expect(account.catalogMutations).toHaveLength(1);
    });
});
