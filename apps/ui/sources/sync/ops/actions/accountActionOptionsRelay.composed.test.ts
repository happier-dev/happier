import { afterAll, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/sessionOpsNetworkBoundary'))
    .createSessionOpsSocketIoClientBoundary(importOriginal));
installApprovalCommonModuleMocks({ storage: original => original() });
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createUiAccountAction } = await import('./accountActionDeps');
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
afterAll(() => network.dispose());

it.each([
    { scenario: 'first valid cold receiver', firstDeclares: true, heldCurrent: false, selected: 'stale', initialReads: ['stale'] },
    { scenario: 'stale first and current second receiver', firstDeclares: false, heldCurrent: false, selected: 'current', initialReads: ['stale', 'current'] },
    { scenario: 'held current receiver before a cold first receiver', firstDeclares: false, heldCurrent: true, selected: 'current', initialReads: ['current'] },
])('routes Account options for $scenario without unrelated declaration reads or activation probes', async ({ firstDeclares, heldCurrent, selected, initialReads }) => {
    network.resetRequests();
    const home = await network.addHome('https://compiled-options.test', 'owner', { serverIdentityId: 'srv_compiled_options' });
    const account = await captureLazyActionAccountContext(home.id);
    const initial = storage.getState();
    const pluginId = 'acme.compiled-options';
    let selectedDeclares = true;
    const projection = (declares: boolean) => PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: {}, agentsById: {}, actionsById: {}, settingsById: {}, diagnostics: [],
        familiesById: { inputTypes: { family: 'inputTypes', entriesById: { [`${pluginId}/account`]: {
            id: `${pluginId}/account`, pluginId, pluginVersion: '1.0.0', definition: { id: 'account', title: 'Account',
                semantic: 'account', valueSchema: { type: 'string' }, options: { resource: 'target-options' } },
        } } } }, resourcesById: declares ? { [`${pluginId}/target-options`]: { pluginId, id: 'target-options',
            resourceKind: 'config', scope: 'global', accountRuntimeDeclared: true,
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
        } } : {},
    });
    const access = { custodian: { accountId: account.accountId, displayName: 'Owner' }, role: 'manage' as const,
        resourceMode: 'plain' as const, accessState: 'ready' as const };
    const machines = ['stale', 'current'].map((id, index) => createMachineFixture({ id, access, activeAt: Date.now(), createdAt: 2 - index }));
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [home.id]: machines }, machineListStatusByServerId: { [home.id]: 'idle' } });
    await publishMachineInventoryForTest(account, machines);
    network.setRpcAckResponder(async request => {
        expect(request.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        return { ok: true, result: { protocolVersion: 1, projection: projection(selectedDeclares
            && (request.targetId === 'current' || firstDeclares)) } };
    });
    const dispatched: string[] = [];
    const execute = createUiAccountAction({ account, transport: async request => {
        dispatched.push(request.machineId);
        return { choices: ['selected-account'] };
    } });
    const call = () => execute({ actionId: 'action.options.resolve', input: { optionsSourceId: `plugin-input:${pluginId}/account` },
        context: { serverId: home.id, runtimeAccountId: account.accountId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } });
    try {
        const startReads = network.requests.length;
        if (heldCurrent) await loadDaemonMergedProjectionCacheEntry({ machineId: 'current', serverId: home.id,
            accountLifetime: account.accountLifetime, sections: ['familiesById.inputTypes', 'actionsById', 'resourcesById'], reuseFreshReady: true });
        expect(await call()).toEqual({ choices: ['selected-account'] });
        expect(dispatched).toEqual([selected]);
        expect(network.requests.slice(startReads).map(request => request.targetId)).toEqual(initialReads);
        const reads = network.requests.length;
        expect(await call()).toEqual({ choices: ['selected-account'] });
        expect(network.requests).toHaveLength(reads);
        selectedDeclares = false;
        publishMachineContributionRegistryProjectionInvalidation({ serverId: home.id, machineId: selected }, 'authority');
        expect(await call()).toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { code: 'target_unavailable', diagnostic: { reason: 'plugin_options_declaration_absent' } } });
        expect(await execute({ actionId: 'action.invoke', input: { action: { pluginId: 'acme.options', localId: 'missing' } },
            context: { serverId: home.id, runtimeAccountId: account.accountId, surface: 'ui', actionCaller: { kind: 'host' } } }))
            .toMatchObject({ ok: false, details: { diagnostic: { reason: 'plugin_action_declaration_absent' } } });
        storage.setState({ machineListByServerId: { [home.id]: [] }, machines: {} });
        expect(await call()).toMatchObject({ ok: false, details: { diagnostic: { reason: 'own_reachable_machine_absent' } } });
        expect(dispatched).toEqual([selected, selected]);
        expect(network.requests).toHaveLength(reads + (firstDeclares || heldCurrent ? 2 : 1));
    } finally {
        account.dispose(); clearDaemonMergedProjectionCacheForTests(); storage.setState(initial, true);
    }
});

it('names the missing own reachable Machine without attempting declaration reads', async () => {
    const home = await network.addHome('https://no-options-machine.test', 'owner', { serverIdentityId: 'srv_no_options_machine' });
    const account = await captureLazyActionAccountContext(home.id);
    const initial = storage.getState();
    try {
        storage.setState({ machineListByServerId: { [home.id]: [] }, machines: {} });
        const execute = createUiAccountAction({ account, transport: async () => { throw new Error('Must not dispatch'); } });
        expect(await execute({ actionId: 'action.options.resolve', input: { optionsSourceId: 'plugin-input:acme.options/account' },
            context: { serverId: home.id, runtimeAccountId: account.accountId, surface: 'ui', actionCaller: { kind: 'host' } } }))
            .toMatchObject({ ok: false, details: { code: 'target_unavailable', diagnostic: { reason: 'own_reachable_machine_absent' } } });
    } finally { account.dispose(); storage.setState(initial, true); }
});
