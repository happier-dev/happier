import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncStatusV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createMachineFixture, createPlainMachineRowFixture } from '../fixtures/machineFixtures';
import { applyProjectAccountRowsFixture } from '../fixtures/projectAccountRows';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from './homeGovernanceHarness';
import { installSessionActionRpcBoundary } from './sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from './syncSingletonLoader';

export type WorkspaceSyncRpcRequest = Readonly<{
    machineId: string;
    method: string;
    payload: unknown;
    signal: AbortSignal;
    /** The Home whose socket carried the RPC. */
    serverUrl?: string;
}>;

/** Daemon relationships-list envelope for status-reader fixtures. */
export function createWorkspaceSyncRelationshipsListFixture(statuses: readonly WorkspaceSyncStatusV1[],
    controllerMachineId = statuses[0]?.controllerMachineId ?? 'machine-a') {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    return { controllerMachineId, sets: [], relationships: statuses.map(status => ({ status, definition: {
        v: 1 as const, relationshipId: status.relationshipId, controllerMachineId: status.controllerMachineId,
        alphaWorkspaceRefId: `${status.relationshipId}-alpha`, betaWorkspaceRefId: `${status.relationshipId}-beta`,
        mode: status.mode, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
        enabled: true, createdAtMs: 1, updatedAtMs: 1,
    } })), remoteRelationships: [], membership: { workspaceRefId: null, found: null }, discoveryAvailable: true };
}

/** Workspace sync fixtures stop at HTTP/Socket transport; scope and domain owners remain real. */
export function createWorkspaceSyncHarness(respond: (request: WorkspaceSyncRpcRequest) => unknown) {
    const home = createHomeGovernanceHarness();
    const accountId = 'workspace-sync-account';
    let serverId = '';
    installHomeGovernanceBoundaries(home);
    const requests = installSessionActionRpcBoundary((request, context) => {
        const separator = request.method.indexOf(':');
        if (separator < 1) throw new Error(`Expected a Machine-addressed RPC: ${request.method}`);
        return respond({ machineId: request.method.slice(0, separator),
            method: request.method.slice(separator + 1), payload: request.params, signal: context.signal,
            ...(context.serverUrl ? { serverUrl: context.serverUrl } : {}) });
    });
    const ready = loadSyncSingletonForTests();

    async function seedProject(options: Readonly<{ includeThirdEndpoint?: boolean; machineDisplayNames?: Readonly<Record<string, string>> }> = {}) {
        const { storage } = await import('@/sync/domains/state/storage');
        const machines = ['machine-a', 'machine-b', 'machine-c', 'machine-z'].map(id => {
            const machine = createMachineFixture({ id, activeAt: Date.now() });
            if (!machine.metadata) throw new Error('Expected hydrated Machine fixture metadata');
            return { ...machine, metadata: { ...machine.metadata, host: id,
                ...(options.machineDisplayNames?.[id] ? { displayName: options.machineDisplayNames[id] } : {}) } };
        });
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId, sourceAccountId: accountId });
        storage.getState().markMachineListSettled(serverId);
        const contentPolicy = { v: 1 as const, selection: 'git_worktree' as const,
            extraIgnorePatterns: [], extraIncludePatterns: [],
            policyDigest: computeWorkspaceSyncPolicyDigest({ v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [] }) };
        const relationship = { v: 1 as const, relationshipId: 'link-1', controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: 'hub', betaWorkspaceRefId: 'spoke', mode: 'keep_both_in_sync' as const,
            contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
        applyProjectAccountRowsFixture(storage, {
            workspaceRefs: [
                { id: 'hub', serverId, machineId: 'machine-a', rootPath: '/hub', createdAtMs: 1 },
                { id: 'spoke', serverId, machineId: 'machine-b', rootPath: '/spoke', createdAtMs: 1 },
                ...(options.includeThirdEndpoint ? [{ id: 'third', serverId, machineId: 'machine-c', rootPath: '/third', createdAtMs: 1 }] : []),
            ],
            relationships: [relationship, ...(options.includeThirdEndpoint ? [{ ...relationship, relationshipId: 'link-2', betaWorkspaceRefId: 'third' }] : [])],
        });
    }

    return {
        home, accountId, get serverId() { return serverId; }, seedProject, ready,
        async reset() {
            await ready;
            await home.reset();
            requests.length = 0;
            const profileId = await home.addHome({ name: 'Workspace Home', serverUrl: 'https://workspace-sync.test',
                accountId, currentAccount: true });
            serverId = profileId;
            for (const id of ['machine-a', 'machine-b', 'machine-c', 'machine-z']) {
                home.answer(profileId, `/v1/machines/${id}`, { body: { machine: createPlainMachineRowFixture({ id, accountId }) } });
            }
            const { storage } = await import('@/sync/domains/state/storage');
            storage.getState().activateProfileScope({ serverId, accountId });
            storage.setState({ settingsScope: { serverId, accountId } });
            await seedProject();
        },
        async dispose() {
            const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
            await serverScopedRpcSocketPool.stopAll();
            const { resetWorkspaceSyncConflictStoreForTests } = await import('@/sync/domains/sessionHandoff/workspaceSyncConflictStore');
            const { resetWorkspaceSyncStatusStoreForTests } = await import('@/sync/domains/sessionHandoff/workspaceSyncStatusStore');
            resetWorkspaceSyncConflictStoreForTests();
            resetWorkspaceSyncStatusStoreForTests();
            await home.reset();
        },
    };
}
