import * as React from 'react';
import { expect, it, vi, onTestFinished } from 'vitest';
import { act, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import type { RegistryFetchRequestV1 } from '@happier-dev/protocol/registries';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Machine RPC is the process boundary; registry routing, Actions, supplier admission and REACH remain real.
const transport = vi.hoisted(() => ({ calls: [] as ServerScopedMachineRpcParams<RegistryFetchRequestV1>[], unreachableList: false, nextCursor: null as string | null }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: ServerScopedMachineRpcParams<RegistryFetchRequestV1>) => {
        transport.calls.push(request);
        const { RegistryFetchRequestV1Schema } = await import('@happier-dev/protocol/registries');
        const input = RegistryFetchRequestV1Schema.parse(request.payload);
        if (input.op !== 'list') throw new Error('Fixture serves registry lists');
        if (transport.unreachableList) return { op: 'error', status: { state: 'unreachable' } };
        return { op: 'list', page: { sourceId: input.sourceId, status: { state: 'ok', fetchedAt: 1 },
            items: [{ sourceId: input.sourceId, itemId: 'supplier-skill', kind: 'skill', title: 'Supplier skill', version: 'a'.repeat(40) }], nextCursor: transport.nextCursor } };
    },
}));
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { storage } = await import('@/sync/domains/state/storageStore');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { projectPluginRegistrySourceDeclarationV1 } = await import('@happier-dev/protocol/registries');
const { normalizePluginInstalledUiDeclarations } = await import('@/sync/domains/plugins/ui/projection');
const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { createConnectedAccountDescriptorProjectionLoadingState } = await import('@/sync/domains/connectedServices/connectedAccountDescriptorProjection');
const { recordMachineRequestFailed, recordMachineRequestSucceeded, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/executionTarget');
const { useRegistryItems } = await import('./useRegistryItems');

it('recovers a supplier catalog when its Machine arrives after another carrier, and retains an offline supplier on page reopen until explicit Retry', async () => {
    await homes.reset();
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-late-supplier.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); clearMachineRequestReachabilityForTest(); transport.unreachableList = false; transport.nextCursor = null; });
    await setServerProfileIdentityForUrl(fixture.home.serverUrl, 'srv_registry_late_supplier');
    const account = await captureLazyActionAccountContext(fixture.home.id);
    onTestFinished(() => account.dispose());
    storage.setState({ settingsScope: account.accountLifetime.scope, profileScope: account.accountLifetime.scope });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected Account lifetime');
    const pluginId = 'com.acme.late-supplier';
    const entry = projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
        id: 'team', title: 'Team skills', format: 'git', kinds: ['skill'], url: 'https://git.example.test/skills',
    } });
    const executionOrigin = { serverIdentityId: 'srv_registry_late_supplier', materializationRef: {
        machineId: 'late-supplier', pluginId, materializationId: 'late-supplier' } };
    const projection = normalizePluginInstalledUiDeclarations({}, undefined, { id: pluginId, displayName: 'Acme', version: '1.0.0',
        enabled: true, occurrenceId: 'late-supplier', source: { kind: 'path', locator: '/plugins/acme' } },
        [{ ...entry, occurrenceId: 'late-supplier', executionOrigin }]);
    const pluginUiProjection = unionPluginUiProjections([{ machineId: 'late-supplier', serverId: fixture.home.id,
        phase: 'retainedOffline', interactionEnabled: false, projection }]).pluginUiProjection;
    function Wrapper({ children }: React.PropsWithChildren) {
        return React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
        pluginUiProjection, pluginBrowserProjection: null, phase: 'retainedOffline', interactionEnabled: false,
        machineId: 'late-supplier', serverId: fixture.home.id, platform: 'web', accountLifetime: lifetime,
        reloadConnectedAccountProjection: () => {}, connectedAccountProjectionState: createConnectedAccountDescriptorProjectionLoadingState('fixture'),
        clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        }, children });
    }
    const previous = storage.getState();
    onTestFinished(() => storage.setState({ machines: previous.machines, machineListByServerId: previous.machineListByServerId,
        machineListStatusByServerId: previous.machineListStatusByServerId }));
    const general = createMachineFixture({ id: 'general-carrier', activeAt: Date.now() });
    const supplier = createMachineFixture({ id: 'late-supplier', activeAt: Date.now() });
    const publish = (machines: typeof supplier[]) => publishMachineInventoryForTest(lifetime.scope, machines);
    await publish([]);
    transport.calls.length = 0;
    const hook = await renderHook((enabled: boolean) => useRegistryItems({ kind: 'skill', sourceIds: [entry.id] }, enabled), { initialProps: true, wrapper: Wrapper });
    await waitForHomeGovernance(() => expect({ error: hook.getCurrent().error, status: hook.getCurrent().status,
        failures: hook.getCurrent().sourceFailures.map(f => f.status.state) }).toEqual({ error: null, status: null, failures: ['needs_machine'] }));
    await act(async () => { await publish([general]); });
    await waitForHomeGovernance(() => {
        expect(hook.getCurrent().loading).toBe(false);
        expect(hook.getCurrent().sourceFailures.map(f => f.status.state)).toEqual(['needs_machine']);
    });
    expect(transport.calls).toHaveLength(0);
    await act(async () => { await publish([general, supplier]); });
    expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: 'srv_registry_late_supplier', machineId: supplier.id },
        { accountScope: lifetime.scope })?.machine.id).toBe(supplier.id);
    await waitForHomeGovernance(() => expect(hook.getCurrent().sourceFailures).toEqual([]));
    expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(['supplier-skill']);
    expect(transport.calls.map(call => call.machineId)).toEqual([supplier.id]);
    // A genuine outage settles visibly. Warm navigation retains it until the person chooses Retry (e6f660b4eaf).
    recordMachineRequestFailed({ serverId: fixture.home.id, accountId: lifetime.scope.accountId, machineId: supplier.id });
    transport.unreachableList = true;
    await act(async () => { await hook.getCurrent().refresh(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sourceFailures.map(f => f.status.state)).toEqual(['unreachable']));
    const failedCalls = transport.calls.length;
    await act(async () => {});
    await act(async () => {});
    expect(transport.calls).toHaveLength(failedCalls);
    transport.unreachableList = false;
    await hook.rerender(false);
    await hook.rerender(true);
    await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
    expect(hook.getCurrent().sourceFailures.map(failure => failure.status.state)).toEqual(['unreachable']);
    expect(transport.calls).toHaveLength(failedCalls);
    await act(async () => { await hook.getCurrent().refresh(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sourceFailures).toEqual([]));
    expect(transport.calls).toHaveLength(failedCalls + 1);
    recordMachineRequestSucceeded({ serverId: fixture.home.id, accountId: lifetime.scope.accountId, machineId: supplier.id });
    // Paging can replace a successful first page with a newer supplier failure.
    transport.nextCursor = 'next';
    await act(async () => { await hook.getCurrent().refresh(); });
    expect(hook.getCurrent().hasNextPage).toBe(true);
    await act(async () => { await publish([general]); await hook.getCurrent().nextPage(); });
    expect(hook.getCurrent().sourceFailures.map(f => f.status.state)).toEqual(['needs_machine']);
    await act(async () => { await publish([general, supplier]); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sourceFailures).toEqual([]));
    await hook.unmount();
});


