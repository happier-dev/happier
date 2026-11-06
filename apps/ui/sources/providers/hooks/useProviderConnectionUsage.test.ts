import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, act } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const account = createProviderSettingsAccountHarness();
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
await loadSyncSingletonForTests();
afterEach(async () => { vi.useRealTimers(); standardCleanup(); await account.reset(); rpc.reset(); });

describe('Provider usage presentation demand', () => {
    it('shares the existing settings meter and expanded picker loader and starts no usage requests after both close', async () => {
        const contributionKey = 'happier.provider.vercel-ai-gateway/vercel-ai-gateway';
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey }, role: 'named', displayName: 'Gateway',
                displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }] });
        const { serverId } = await account.restore({ catalog, waivedActions: ['providers.usage.refresh'] });
        installProviderSettingsRpcBoundary(rpc);
        const { ProviderConnectionUsageSection } = await import('@/components/settings/providers/ProviderConnectionUsageSection');
        const { useProviderConnectionUsageForSource } = await import('./useProviderConnectionUsageForSource');
        const { providerConnectionUsageAuthority } = await import('./useProviderConnectionUsage');
        const { readAccountProviderDeclaration } = await import('@/providers/catalog/accountProviderDeclarations');
        const { invalidateProviderConnectionUsage } = await import('@/sync/domains/connectedServices/accountUsage/providerConnectionUsageRefreshResource');
        const { applyProviderCatalogSnapshot } = await import('@/sync/store/settings/providerCatalogSnapshot');
        const declaration = readAccountProviderDeclaration(contributionKey, { kind: 'account' });
        let displayedDeclaration = declaration;
        let connectionRevision = 1;
        expect(declaration?.definition.usageSources?.length).toBeGreaterThan(0);
        const method = RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH;
        const requests = () => rpc.state.requests.filter(request => request.method === method);
        let finish!: (value: unknown) => void;
        rpc.intercept(method, () => new Promise(resolve => { finish = resolve; }));
        let picker!: ReturnType<typeof useProviderConnectionUsageForSource>;
        function Picker() {
            picker = useProviderConnectionUsageForSource({ serverId, machineId: 'machine-a', connectionId: 'pc_a',
                declarationContext: { kind: 'account' }, active: true });
            return null;
        }
        const page = (active: boolean, expanded = false) => React.createElement(React.Fragment, null,
            React.createElement(ProviderConnectionUsageSection, { serverId, scope: { serverId, accountId: 'account-a' },
                machineId: 'machine-a', connectionId: 'pc_a', ...providerConnectionUsageAuthority({
                    sources: displayedDeclaration!.definition.usageSources!, declaration: displayedDeclaration,
                    connection: { ...catalog.connections[0]!, revision: connectionRevision }, machineId: 'machine-a' }),
                providerName: 'Gateway', sources: declaration!.definition.usageSources!, active,
                onChooseBillingKey: null, onChooseApiKey: null }), expanded ? React.createElement(Picker) : null);
        const screen = await renderScreen(page(false));
        expect(requests()).toHaveLength(0);
        await screen.update(page(true));
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(1));
        await screen.update(page(true, true));
        await waitForHomeGovernance(() => expect(picker.supported).toBe(true));
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(requests()).toHaveLength(1);
        await act(async () => { finish({ status: 'success', sources: [] }); });
        await waitForHomeGovernance(() => expect(picker.view?.result.status).toBe('success'));
        expect(screen.findByTestId('provider-connection-usage')).not.toBeNull();
        const beforeRename = picker.view;
        connectionRevision = 2;
        displayedDeclaration = { ...declaration!, definition: { ...declaration!.definition, name: 'Renamed Gateway',
            websiteUrl: 'https://example.com/new-docs' } };
        await act(async () => {
            applyProviderCatalogSnapshot({ serverId, accountId: 'account-a' }, { status: 'ready', revision: 2,
                catalog: { ...catalog, connections: catalog.connections.map(row => ({ ...row, revision: 2,
                    displayName: 'Renamed Gateway', updatedAt: 2 })) } }, true);
        });
        await screen.update(page(true, true));
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(requests()).toHaveLength(1);
        expect(picker.view).toBe(beforeRename);
        vi.useFakeTimers();
        await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
        expect(requests()).toHaveLength(1);
        await screen.update(page(false));
        rpc.state.requests.length = 0;
        invalidateProviderConnectionUsage({ serverId, accountId: 'account-a', connectionId: 'pc_a', machineId: 'machine-a' });
        await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
        expect(requests()).toHaveLength(0);
        await screen.unmount();
    });

    it.each(['endpoint', 'parser', 'key', 'key revision'] as const)('retires and cancels the shared read for a real %s change, then reads the new authority once', async change => {
        const contributionKey = 'happier.provider.vercel-ai-gateway/vercel-ai-gateway';
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey }, role: 'named', displayName: 'Gateway',
                displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }] });
        const { serverId } = await account.restore({ catalog, waivedActions: ['providers.usage.refresh'] });
        installProviderSettingsRpcBoundary(rpc);
        const { useProviderConnectionUsage, providerConnectionUsageAuthority } = await import('./useProviderConnectionUsage');
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const { readAccountProviderDeclaration } = await import('@/providers/catalog/accountProviderDeclarations');
        const { applySavedSecretCatalogPage, applyAcknowledgedSavedSecretCatalogEntry } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        const { SavedSecretCatalogEntryV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretCatalogV1');
        const scope = { serverId, accountId: 'account-a' };
        account.home.answer(serverId, 'GET /v1/account/saved-secrets/resources', { body: { resources: [] } });
        // The metadata read is a genuine Home boundary. Missing key metadata is
        // not materialization authority; the daemon still admits every refresh.
        applySavedSecretCatalogPage({ scope, entries: [], observedAt: 1 });
        const declaration = readAccountProviderDeclaration(contributionKey, { kind: 'account' })!;
        type IdentityInput = Parameters<typeof providerConnectionUsageAuthority>[0];
        const initial: IdentityInput = { sources: declaration.definition.usageSources!, declaration,
            connection: catalog.connections[0], machineId: 'machine-a', secretBindings: { account: { apiKey: 'secret-a', unused: 'unused-a' } } };
        const method = RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH;
        const finishes: Array<(value: unknown) => void> = [];
        const signals: AbortSignal[] = [];
        rpc.intercept(method, () => new Promise(resolve => { finishes.push(resolve); }));
        const hook = await renderHook((authority: IdentityInput) => {
            const client = useProviderActionClient(serverId);
            return useProviderConnectionUsage({ scope, connectionId: 'pc_a', machineId: 'machine-a',
                ...providerConnectionUsageAuthority(authority), active: client.ready,
                invoke: (request, options) => {
                    signals.push(options.signal);
                    return client.refreshProviderConnectionUsage(request, options);
                } });
        }, { initialProps: initial });
        await waitForHomeGovernance(() => expect(finishes).toHaveLength(1));
        await act(async () => { finishes[0]!({ status: 'success', sources: [] }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().view?.result.status).toBe('success'));
        const beforeUnrelatedChange = hook.getCurrent().view;
        await hook.rerender({ ...initial, secretBindings: { account: { apiKey: 'secret-a', unused: 'unused-b' } } });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(finishes).toHaveLength(1);
        expect(hook.getCurrent().view).toBe(beforeUnrelatedChange);
        await act(async () => { hook.getCurrent().refresh!(); });
        await waitForHomeGovernance(() => expect(finishes).toHaveLength(2));
        const sources = change === 'parser' ? initial.sources.map(source => ({ ...source, parser: 'updated-credits' })) : initial.sources;
        const next: IdentityInput = { ...initial, sources,
            declaration: { ...declaration, definition: { ...declaration.definition, usageSources: [...sources] } },
            connection: change === 'endpoint' ? { ...initial.connection!, endpointOverrides: [{
                endpointTemplateId: sources[0]!.endpointTemplateId, baseUrl: 'https://alternate.example/v1',
            }] } : initial.connection,
            secretBindings: change === 'key' ? { account: { apiKey: 'secret-b' } } : initial.secretBindings };
        await hook.rerender(next);
        if (change === 'key revision') await act(async () => {
            applyAcknowledgedSavedSecretCatalogEntry(scope, SavedSecretCatalogEntryV1Schema.parse({
                ref: 'secret-a', source: 'personal', relationship: 'owner', name: 'API key', kind: 'apiKey',
                revision: 2, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
            }), true);
        });
        await waitForHomeGovernance(() => expect(finishes).toHaveLength(3));
        expect(signals[1]!.aborted).toBe(true);
        expect(hook.getCurrent().view).toBeNull();
        await act(async () => { finishes[1]!({ status: 'success', sources: [] }); });
        expect(hook.getCurrent().view).toBeNull();
        await act(async () => { finishes[2]!({ status: 'success', sources: [] }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().view?.result.status,
            JSON.stringify({ requests: finishes.length, aborted: signals.map(signal => signal.aborted),
                refreshing: hook.getCurrent().refreshing, failed: hook.getCurrent().failed })).toBe('success'));
        expect(rpc.state.requests.filter(request => request.method === method)).toHaveLength(3);
        await hook.unmount();
    });

    it('acquires only the expanded supported source through the shared usage owner', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: ['pc_a', 'pc_b'].map(id => ({ v: 1, id, source: { kind: 'contribution',
                contributionKey: 'happier.provider.vercel-ai-gateway/vercel-ai-gateway' }, role: 'named', displayName: id,
                displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 })) });
        const { serverId } = await account.restore({ catalog, waivedActions: ['providers.usage.refresh'] });
        installProviderSettingsRpcBoundary(rpc);
        const { useProviderConnectionUsageForSource } = await import('./useProviderConnectionUsageForSource');
        const method = RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH;
        rpc.setResponse(method, { status: 'success', sources: [] });
        const hook = await renderHook((active: boolean) => useProviderConnectionUsageForSource({ serverId,
            machineId: 'machine-a', connectionId: 'pc_a', active, declarationContext: { kind: 'account' } }), { initialProps: false });
        expect(rpc.state.requests.filter(request => request.method === method)).toHaveLength(0);
        await hook.rerender(true);
        await waitForHomeGovernance(() => expect(hook.getCurrent().presentation.checked).toBe(true));
        expect(rpc.state.requests.filter(request => request.method === method)).toEqual([
            expect.objectContaining({ payload: expect.objectContaining({ connectionId: 'pc_a', machineId: 'machine-a' }) }),
        ]);
    });
    it('does no hidden work and shares visible settings/picker demand beyond the first caller unmount', async () => {
        const { serverId } = await account.restore({ waivedActions: ['providers.usage.refresh'] });
        installProviderSettingsRpcBoundary(rpc);
        const { useProviderConnectionUsage } = await import('./useProviderConnectionUsage');
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const method = RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH;
        const requests = () => rpc.state.requests.filter(request => request.method === method);
        let finish!: (value: unknown) => void;
        rpc.intercept(method, () => new Promise(resolve => { finish = resolve; }));
        const mount = (active: boolean) => renderHook((shown: boolean) => {
            const client = useProviderActionClient(serverId);
            return useProviderConnectionUsage({ scope: { serverId, accountId: 'account-a' }, connectionId: 'pc_a',
                machineId: 'machine-a', identity: 'same-key', active: shown && client.ready,
                invoke: client.refreshProviderConnectionUsage });
        }, { initialProps: active });
        const settings = await mount(false);
        expect(requests()).toHaveLength(0);
        await settings.rerender(true);
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(1));
        const picker = await mount(true);
        expect(requests()).toHaveLength(1);
        await settings.unmount();
        finish({ status: 'success', sources: [] });
        await waitForHomeGovernance(() => expect(picker.getCurrent().view?.result).toEqual({ status: 'success', sources: [] }));
        expect(picker.getCurrent().refreshing).toBe(false);
        const { invalidateProviderConnectionUsage } = await import('@/sync/domains/connectedServices/accountUsage/providerConnectionUsageRefreshResource');
        invalidateProviderConnectionUsage({ serverId, accountId: 'account-a', connectionId: 'pc_a', machineId: 'machine-a' });
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(2));
        await picker.rerender(false);
        finish({ status: 'unsupported' });
        expect(picker.getCurrent().refreshing).toBe(false);
        expect(picker.getCurrent().view?.result).toEqual({ status: 'success', sources: [] });
        expect(requests()).toHaveLength(2);
    });

    it('never prompts automatically, but shares an explicit refresh approval and preserves rejection across reopening', async () => {
        const { serverId } = await account.restore();
        await account.home.requireUiApproval(serverId, 'providers.usage.refresh');
        const { useProviderConnectionUsage } = await import('./useProviderConnectionUsage');
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const { invalidateProviderConnectionUsage } = await import('@/sync/domains/connectedServices/accountUsage/providerConnectionUsageRefreshResource');
        let attempts = 0;
        const mount = () => renderHook((active: boolean) => {
            const client = useProviderActionClient(serverId);
            return useProviderConnectionUsage({ scope: { serverId, accountId: 'account-a' }, connectionId: 'pc_a',
                machineId: 'machine-a', identity: 'same-key', active: active && client.ready,
                invoke: (request, options) => { attempts += 1; return client.refreshProviderConnectionUsage(request, options); } });
        }, { initialProps: true });
        const settings = await mount();
        await waitForHomeGovernance(() => expect(attempts).toBe(1));
        await waitForHomeGovernance(() => expect(settings.getCurrent().refreshing).toBe(false));
        expect(settings.getCurrent().pendingApproval).toBeNull();
        expect(account.home.artifacts(serverId).list()).toHaveLength(0);
        expect(rpc.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH)).toHaveLength(0);
        await act(async () => { settings.getCurrent().refresh!(); });
        await waitForHomeGovernance(() => expect(settings.getCurrent().pendingApproval?.artifactId).toBeTruthy());
        const picker = await mount();
        const pending = settings.getCurrent().pendingApproval;
        expect(picker.getCurrent().pendingApproval).toEqual(pending);
        await settings.unmount();
        expect(picker.getCurrent().pendingApproval).toEqual(pending);
        await act(async () => { await decideApprovalAsInbox(serverId, pending!.artifactId, 'reject'); });
        await waitForHomeGovernance(() => expect(picker.getCurrent().refreshing).toBe(false));
        expect(rpc.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH)).toHaveLength(0);
        invalidateProviderConnectionUsage({ serverId, accountId: 'account-a', connectionId: 'pc_a', machineId: 'machine-a' });
        await picker.rerender(false);
        await picker.rerender(true);
        expect(account.home.artifacts(serverId).list()).toHaveLength(1);
        await account.restore({ accountId: 'account-b' });
        expect(picker.getCurrent().view).toBeNull();
        expect(picker.getCurrent().pendingApproval).toBeNull();
    });

    it('joins a late picker to the same actual credential authority after the settings reader has rebound', async () => {
        const { serverId } = await account.restore({ waivedActions: ['providers.usage.refresh'] });
        installProviderSettingsRpcBoundary(rpc);
        const { useProviderConnectionUsage } = await import('./useProviderConnectionUsage');
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const method = RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH;
        rpc.setResponse(method, { status: 'success', sources: [] });
        const mount = () => renderHook(() => {
            const client = useProviderActionClient(serverId);
            return useProviderConnectionUsage({ scope: { serverId, accountId: 'account-a' }, connectionId: 'pc_a',
                machineId: 'machine-a', identity: 'same-key', active: client.ready,
                invoke: client.refreshProviderConnectionUsage });
        });
        const settings = await mount();
        await waitForHomeGovernance(() => expect(settings.getCurrent().view?.result.status).toBe('success'));
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        await act(async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(getServerProfileById(serverId)!.serverUrl,
                { serverId }, { token: createAccountTokenForTests('account-a') })).toBe(true);
        });
        await waitForHomeGovernance(() => expect(settings.getCurrent().view?.result.status).toBe('success'));
        const before = settings.getCurrent().view;
        const requestCount = rpc.state.requests.filter(request => request.method === method).length;
        const picker = await mount();
        await waitForHomeGovernance(() => expect(picker.getCurrent().view?.result.status).toBe('success'));
        expect(settings.getCurrent().view).toBe(before);
        expect(picker.getCurrent().view).toBe(before);
        expect(rpc.state.requests.filter(request => request.method === method)).toHaveLength(requestCount);
        await picker.unmount();
        expect(settings.getCurrent().view).toBe(before);
    });
});
