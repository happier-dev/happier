import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { buildDeferredDaemonProjectionSections, demandedDaemonProjectionSections,
    DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// The daemon RPC behind the real network boundary is the only substitute; Sync, the
// projection loader, its section reader and the catalog hook stay real.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { PLUGIN_UI_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { useWorkflowActionCatalog } = await import('./useWorkflowActionCatalog');
const { useWorkflowTriggerEventOptions } = await import('../triggers/useWorkflowTriggerEventOptions');
afterAll(async () => { await network.dispose(); });

const projection = {
    v: 2 as const, generation: 3,
    installedPackagesById: { 'acme.deploy': { id: 'acme.deploy', displayName: 'Deploy', version: '1.0.0', enabled: true,
        source: { kind: 'path' as const, locator: '/plugins/acme.deploy' } } },
    actionsById: { 'acme.deploy/ship': { id: 'ship', pluginId: 'acme.deploy', occurrenceId: 'occurrence-a', title: 'Ship it',
        scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } },
    agentsById: { 'acme.deploy/agent': { id: 'acme.deploy/agent', identity: { pluginId: 'acme.deploy', localId: 'agent' }, title: 'Agent' } },
    familiesById: {},
};

function releaseEventProjection() {
    const pluginId = 'acme.deploy';
    return buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1, projection, projectionDigest: 'c'.repeat(64), automationEligibleEvents: [{
            event: { id: `${pluginId}/released`, identity: { pluginId, localId: 'released' }, occurrenceId: 'occurrence-a',
                sourceCustody: { kind: 'development', registeredRootId: 'catalog-root' }, title: 'A release ships', description: null,
                automation: { v: 1, eligible: true, source: { sourceContractVersion: 1,
                    supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema: { type: 'object' },
                    setupActionRef: { pluginId, localId: 'setup' } } } },
            setupAction: { id: `${pluginId}/setup`, identity: { pluginId, localId: 'setup' }, occurrenceId: 'occurrence-a',
                title: 'Set up releases', description: null, inputSchema: { type: 'object' }, inputHints: null },
        }],
    }));
}

describe('useWorkflowActionCatalog', () => {
    let serverId: string;
    const sectionsRead = new Set<string>();
    let deferred: ReturnType<typeof buildDeferredDaemonProjectionSections>;

    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        sectionsRead.clear();
        deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projection, projectionDigest: 'b'.repeat(64) }));
        const sectionByIndexDigest = new Map(Object.entries(deferred.manifest.sections).map(([section, digest]) => [digest, section]));
        network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
        const home = await network.addHome('https://workflow-action-catalog.example.test', 'account-a');
        serverId = home.id;
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            const read = (request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            if (!read) return { ok: true, result: deferred.manifest };
            for (const digest of [read.digest, ...read.includeDigests ?? []]) {
                const section = sectionByIndexDigest.get(digest);
                if (section) sectionsRead.add(section);
            }
            return { ok: true, result: deferred.read(read.digest, read.offset, read.includeDigests) };
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        clearDaemonMergedProjectionCacheForTests();
    });
    afterEach(async () => {
        standardCleanup();
        clearDaemonMergedProjectionCacheForTests();
        await disconnectActiveServerConnection();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    });

    it('offers the Machine\'s plugin Actions while hydrating only the plugin UI sections, not the whole catalogue', async () => {
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().specs.some(spec => spec.plugin?.id === 'acme.deploy')).toBe(true));
            expect([...sectionsRead].sort()).toEqual([...demandedDaemonProjectionSections(deferred.manifest, PLUGIN_UI_SECTIONS)].sort());
            expect(sectionsRead.has('agentsById')).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('offers only Actions admitted by the Account discovery read', async () => {
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'machines.command.run': { enabled: false } } });
        network.setHttpResponder(async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (pathname === '/v2/account/settings') return Response.json({
                content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2,
            });
            return null;
        });
        storage.getState().applySettingsLocal({ actionsSettingsV1 });
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
            expect(hook.getCurrent().specs.some(spec => spec.id === 'machines.command.run')).toBe(false);
            expect(hook.getCurrent().specs.some(spec => spec.id === 'notifications.notify_me')).toBe(true);
        } finally { await hook.unmount(); }
    });

    it('keeps an undemanded Event picker idle and honors the canonical Event read admission', async () => {
        deferred = releaseEventProjection();
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'workflow.events.list': { enabled: false } } });
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({ actionsSettingsV1 }), 2);
        const hook = await renderHook((enabled: boolean) => useWorkflowTriggerEventOptions({ machineId: 'machine-1', serverId, enabled }),
            { initialProps: false });
        try {
            expect(hook.getCurrent()).toEqual({ status: 'idle', events: [] });
            expect(sectionsRead.size).toBe(0);
            await hook.rerender(true);
            await vi.waitFor(() => expect(['ready', 'unavailable']).toContain(hook.getCurrent().status));
            expect(hook.getCurrent()).toEqual({ status: 'unavailable', events: [] });
        } finally { await hook.unmount(); }
    });

    it('shares the admitted Event catalog and one Machine projection across demanded menus', async () => {
        deferred = releaseEventProjection();
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({}), 2);
        const hook = await renderHook(() => [
            useWorkflowTriggerEventOptions({ machineId: 'machine-1', serverId, enabled: true }),
            useWorkflowTriggerEventOptions({ machineId: 'machine-1', serverId, enabled: true }),
        ]);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().every(catalog => catalog.status === 'ready')).toBe(true));
            for (const catalog of hook.getCurrent()) expect(catalog.events).toEqual([{
                eventRef: { pluginId: 'acme.deploy', localId: 'released' }, title: 'A release ships', pluginName: 'Deploy',
            }]);
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                && request.payload !== null && typeof request.payload === 'object' && !('sectionRead' in request.payload))).toHaveLength(1);
        } finally { await hook.unmount(); }
    });

    it('offers native Account choices before a Machine is selected without reading a daemon', async () => {
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: null, serverId }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
            expect(hook.getCurrent().specs.some(spec => spec.id === 'wait')).toBe(true);
            expect(hook.getCurrent().specs.some(spec => spec.id === 'notifications.notify_me')).toBe(true);
            expect(sectionsRead.size).toBe(0);
            expect(hook.getCurrent().specs.some(spec => spec.plugin !== undefined)).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('withdraws a pending Account read when that Account retires and admits its successor', async () => {
        let releaseOld: ((response: Response) => void) | undefined;
        const retiredRead = new Promise<Response>(resolve => { releaseOld = resolve; });
        let oldPending = false;
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: { wait: { enabled: false } } });
        network.setHttpResponder(async input => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (pathname !== '/v2/account/settings') return null;
            if (!oldPending) { oldPending = true; return retiredRead; }
            return Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2 });
        });
        const hook = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: null, serverId }));
        try {
            await vi.waitFor(() => expect(oldPending).toBe(true));
            await act(async () => {
                await network.setAccount('https://workflow-action-catalog.example.test', 'account-b');
                // Connection restore precedes settings hydration. Publish the successor's
                // real scoped settings, then wait for its choices rather than an old ready frame.
                storage.getState().applySettingsForScope({ serverId, accountId: 'account-b' }, settingsParse({ actionsSettingsV1 }), 2);
            });
            await vi.waitFor(() => {
                expect(hook.getCurrent().phase).toBe('ready');
                expect(hook.getCurrent().specs.some(spec => spec.id === 'wait')).toBe(false);
            });
            await act(async () => { releaseOld?.(Response.json({ content: { t: 'plain', v: {} }, version: 1 })); });
            expect(hook.getCurrent().specs.some(spec => spec.id === 'wait')).toBe(false);
        } finally {
            releaseOld?.(Response.json({ content: { t: 'plain', v: {} }, version: 1 }));
            await hook.unmount();
        }
    });

    it('shares one discovery admission across Workflow and hook pickers for the same demanded target', async () => {
        const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const hook = await renderHook(() => [
            useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }),
            useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }, 'before'),
            useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }, 'after'),
        ]);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().every(catalog => catalog.phase === 'ready')).toBe(true));
            const entry = readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId, sections: PLUGIN_UI_SECTIONS });
            expect(entry?.workflowActionCatalog.current?.readers).toBe(3);
            const [steps, before, after] = hook.getCurrent();
            expect(steps.specs.some(spec => spec.id === 'wait')).toBe(true);
            expect(steps.specs.some(spec => spec.id === 'workspace.tabs.open')).toBe(false);
            for (const hooks of [before, after]) {
                expect(hooks.specs.some(spec => spec.id === 'wait')).toBe(false);
                expect(hooks.specs.some(spec => spec.id === 'workspace.tabs.open')).toBe(true);
                expect(hooks.specs.some(spec => spec.id === 'transcript.unfollow')).toBe(true);
            }
            const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: { wait: { enabled: false } } });
            await act(async () => {
                storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settingsParse({ actionsSettingsV1 }), 2);
            });
        } finally { await hook.unmount(); }
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId, sections: PLUGIN_UI_SECTIONS })?.workflowActionCatalog.current ?? null).toBeNull();
        const reopened = await renderHook(() => useWorkflowActionCatalog({ kind: 'machine', machineId: 'machine-1', serverId }));
        try {
            await vi.waitFor(() => expect(reopened.getCurrent().phase).toBe('ready'));
            expect(reopened.getCurrent().specs.some(spec => spec.id === 'wait')).toBe(false);
        } finally { await reopened.unmount(); }
    });

    it('reads agent-only Workflow choices through the addressed UI discovery Action', async () => {
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        const result = await execute('action.spec.search', { purpose: 'workflow_step', query: 'wait', limit: 100 }, {
            surface: 'ui', serverId, expectedAccountId: 'account-a',
        });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        const { ActionSpecSearchResultSchema } = await import('@happier-dev/protocol/actions/specs/catalog');
        expect(ActionSpecSearchResultSchema.parse(result.result).actionSpecs.some(spec => spec.id === 'wait')).toBe(true);
        const complete = await execute('action.spec.search', { purpose: 'workflow_step', limit: null }, {
            surface: 'ui', serverId, expectedAccountId: 'account-a',
        });
        expect(complete).toMatchObject({ ok: true });
        if (!complete.ok) return;
        expect(ActionSpecSearchResultSchema.parse(complete.result).actionSpecs.map(spec => spec.id)).toContain('wait');
    });
});
