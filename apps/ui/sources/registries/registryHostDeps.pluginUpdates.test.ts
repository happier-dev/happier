import { afterEach, expect, it } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { REGISTRY_ACTION_INPUT_SCHEMAS_V1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { createPluginAccountAvailabilityReader } = await import('@/sync/domains/plugins/availability/reader');
const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { useStorePluginUpdates } = await import('@/components/store/updates/useStorePluginUpdates');
const { buildStoreUpdates } = await import('@/components/store/updates/storeUpdatesModel');
const { createUiRegistryHostV1 } = await import('./registryHostDeps');
afterEach(async () => { await standardCleanup(); await account.reset(); rpc.reset(); });

it.each([true, false])('keeps Account catalog checks across carriers (first unavailable: %s)', async firstUnavailable => {
    const installedMachine = 'pl50-installed';
    const otherMachine = 'first-empty-carrier';
    const pluginId = 'pl50.fixture';
    const installedVersion = '1.0.0';
    const sourceVersion = '1.1.0';
    const scope = await account.restore({ currentAccount: true, serverIdentityId: 'srv_plugin_update_carriers', machines: [
        createMachineFixture({ id: otherMachine, createdAt: 2, activeAt: Date.now() }),
        createMachineFixture({ id: installedMachine, createdAt: 1, activeAt: Date.now() }),
    ] });
    await account.publishMachines(scope.serverId, [
        createMachineFixture({ id: otherMachine, createdAt: 2, activeAt: Date.now() }),
        createMachineFixture({ id: installedMachine, createdAt: 1, activeAt: Date.now() }),
    ]);
    const reader = createPluginAccountAvailabilityReader({ scope, snapshot: { availabilityCursor: 1, intentReads: [],
        snapshots: [], inventoryComplete: true, materializations: [PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: 'srv_plugin_update_carriers', machineId: installedMachine, materializationId: 'pl50-native',
            pluginId, version: installedVersion, sourceClass: 'registryPackage', portableRelease: false,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
        })] } });
    const admission = reader.readInstalledPlugins();
    if (admission.kind !== 'available') throw new Error('Expected installed plugin inventory');
    const rows = admission.plugins.map(native => ({ kind: 'plugin' as const, scope, native,
        installations: native.installations, key: serverAccountScopedResourceKey(scope, 'plugin', native.pluginId) }));
    const calls: { machineId: string; kind?: string }[] = [];
    // The daemon is a network boundary. Its finite reply uses the actual native plugin key
    // and version ref; the empty carrier has no plugin installed in its own registry.
    await answerExternalActionAccountForHome(account.home, scope.serverId, {
        machineId: otherMachine, additionalMachines: [{ machineId: installedMachine }],
        actionId: 'registries.updates.check', tokenEpoch: 0, requesterInvocation: 'none',
        failure: result => result && typeof result === 'object' && '__placementRefusal' in result
            ? { errorCode: 'machine_unavailable', error: 'External Action placement refused' } : null,
        execute: (input, context) => {
            const filter = REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.updates.check'].parse(input);
            if (firstUnavailable && context.target.machineId === otherMachine) return { __placementRefusal: true, errorClass: 'PlacementRefusal', refusalBranch: 'machine_unavailable', requestId: 'd2-live-request' };
            calls.push({ machineId: context.target.machineId, ...(filter.kind ? { kind: filter.kind } : {}) });
            return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse({ checkedAt: 10,
                results: [
                    ...(context.target.machineId === installedMachine && (!filter.kind || filter.kind === 'plugin') ? [{ kind: 'plugin', key: pluginId, upstream: { state: 'update_available', latest: { kind: 'version', version: sourceVersion } } }] : []),
                    ...(!filter.kind || filter.kind === 'mcpServer' ? [{ kind: 'mcpServer', key: 'retained-mcp', upstream: { state: 'current' } }] : []),
                    ...(!filter.kind || filter.kind === 'agent' ? [{ kind: 'agent', key: 'retained-agent', upstream: { state: 'current' } }] : []),
                    ...(!filter.kind || filter.kind === 'skill' ? [{ kind: 'skill', key: 'retained-skill', upstream: { state: 'current' } }] : []),
                ] });
        },
    });
    const captured = await captureLazyActionAccountContext(scope.serverId);
    try {
        const port = createUiPromptLibraryArtifactStore(captured.workflowArtifacts, captured).organization!;
        const host = await createUiRegistryHostV1(captured, port, {}, { explicitRefresh: true });
        const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(
            await host.execute('registries.updates.check', {}));
        expect(result.results.find(item => item.kind === 'plugin' && item.key === pluginId)).toMatchObject({ kind: 'plugin', key: pluginId,
            upstream: { state: 'update_available', latest: { kind: 'version', version: sourceVersion } } });
        const check = { checking: false, checkedAt: result.checkedAt, failed: false, code: null, results: result.results };
        const hook = await renderHook(() => useStorePluginUpdates({ rows, check }));
        const view = buildStoreUpdates(rows, result.results, check, hook.getCurrent().entries);
        expect(view.freshness.checked).toBe(1);
        expect(view.sections).toMatchObject([{ kind: 'plugin', entries: [{ state: 'available', to: sourceVersion }] }]);
        expect(calls.filter(call => call.kind === undefined)).toHaveLength(1);
        expect(result.results.filter(item => item.kind !== 'plugin')).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'mcpServer', key: 'retained-mcp' }),
            expect.objectContaining({ kind: 'agent', key: 'retained-agent' }),
            expect.objectContaining({ kind: 'skill', key: 'retained-skill' }),
        ]));
    } finally { captured.dispose(); }
});
