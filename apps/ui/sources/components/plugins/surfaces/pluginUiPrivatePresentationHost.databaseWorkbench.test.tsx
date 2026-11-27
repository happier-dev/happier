import * as React from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { DatabaseStatsObservationV1, DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { DATABASE_RELATIONS_LIST_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import { computeSha256HexDigest } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkitExecuteActionInput } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiHostApi, RenderContext } from '@happier-dev/plugin-sdk/ui';
import * as hostApi from '@happier-dev/plugin-ui/hostApi';
import { PluginUiPresentationHostProviderInternal } from '../../../../../../packages/plugin-ui/src/presentationHost/context';
import { createWorkbenchInstance, workbenchTargetKey } from '../../../../../../packages/plugins/database-workbench/src/ui/workbench';
import { useWorkbenchMount } from '../../../../../../packages/plugins/database-workbench/src/ui/surface/mount';
import { act, createMachineFixture, renderHook } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginAccountSettingsMutationRequestV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPlainAccountEncryptionCurrentnessHttpResponse } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { storage } from '@/sync/domains/state/storage';
import { useDatabaseActivity, WorkbenchProvider } from '../../../../../../packages/plugins/database-workbench/src/ui/hooks';
import type { WorkbenchClient } from '../../../../../../packages/plugins/database-workbench/src/ui/models';
import { clearPersistenceStorage, getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';

installDisconnectedServerSocketBoundary();

const scope = { serverId: 'home', accountId: 'viewer' };
const target: DatabaseTargetV1 = {
    kind: 'deployment_service', environment: { serverId: 'home', projectSourceId: 'source', environmentId: 'env' },
    deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'app',
};
function observation(calls: string, observedAtMs: number): Extract<DatabaseStatsObservationV1, { status: 'available'; group: 'statements' }> {
    return {
        v: 1, engineId: 'postgresql', status: 'available', group: 'statements', observedAtMs,
        scope: { database: 'app' }, intervalBasis: { bindingKey: 'binding', databaseIdentity: 'database', selectionKey: 'statements' },
        coverage: { status: 'complete' }, completeness: { complete: true },
        data: [{ key: 'shown', database: 'app', shape: 'SELECT private_shape', calls, totalTimeMs: Number(calls) * 2, rows: calls, nativeTimeUnit: 'milliseconds' }],
    };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); clearPersistenceStorage(); });

describe('mounted database workbench host owners', () => {
    it('wires the shared mount to Activity and isolates last look by its viewer instead of the launch scope', async () => {
        const host = createPluginUiPrivatePresentationHost(undefined);
        const descriptor = { ...createDatabaseDescriptorV1Fixture(), target };
        host.databaseWorkbench.lastLook(scope, target).observe(observation('5', 500), ['shown']);
        const targetKey = workbenchTargetKey(target);
        const launch = { descriptor, scope: {
            kind: 'worktree' as const, accountId: 'launch-owner', installationId: 'installation', projectKey: 'project',
            workspace: { serverId: 'launch-home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/repo' },
        } };
        // Only the external Host API is substituted. This no-demand mount must never read it.
        const unexpectedRead = () => { throw new Error('An unpresented mount must not read the Host API'); };
        const boundary = { readResource: unexpectedRead, watchResource: unexpectedRead, executeAction: unexpectedRead,
            setUnsavedChanges: async () => {} } satisfies Pick<PluginUiHostApi, 'readResource' | 'watchResource' | 'executeAction' | 'setUnsavedChanges'>;
        const mount = (viewer: typeof scope) => {
            const context: RenderContext = {
                plugin: { id: 'happier.database', version: '0.0.0' }, signal: new AbortController().signal,
                surface: createSurfaceContextFixture({ accountScope: viewer }),
                // The boundary fixture supplies only the external methods this flow can reach.
                hostApi: boundary as PluginUiHostApi,
            };
            return renderHook(() => useWorkbenchMount(context, launch, {
                targetKey, mode: 'overview', sort: [], columns: [], page: { rows: 50, offset: 0 }, fkTrail: [],
            }, { pageLocation: false }), {
                wrapper: ({ children }) => <PluginUiPresentationHostProviderInternal host={host}>{children}</PluginUiPresentationHostProviderInternal>,
            });
        };
        const first = await mount(scope);
        try {
            const instance = first.getCurrent()!;
            const activity = instance.activity(targetKey, { kind: 'stats.read', group: 'activity', selection: { page: { rows: 50 } } });
            await activity.refresh();
            expect(activity.getSnapshot()).toEqual({ value: null, loading: false, error: null });
            expect(instance.lastLook(targetKey).observe(observation('10', 1000), ['shown']).comparison)
                .toMatchObject({ status: 'available', fromMs: 500, rows: [{ key: 'shown', calls: '5' }] });
        } finally { await first.unmount(); }
        const reopened = await mount(scope);
        try {
            expect(reopened.getCurrent()!.lastLook(targetKey).observe(observation('30', 3000), ['shown']).comparison)
                .toMatchObject({ status: 'available', fromMs: 1000, rows: [{ key: 'shown', calls: '20' }] });
        } finally { await reopened.unmount(); }
        const otherViewer = await mount({ ...scope, accountId: 'other-viewer' });
        try {
            expect(otherViewer.getCurrent()!.lastLook(targetKey).observe(observation('40', 4000), ['shown']).comparison)
                .toEqual({ status: 'unavailable', reason: 'previous_sample_required' });
        } finally { await otherViewer.unmount(); }
    });

    it('keeps loaded relation names when the same page opens a table and receives new presentation bindings', async () => {
        const descriptor = { ...createDatabaseDescriptorV1Fixture(), target };
        const targetKey = workbenchTargetKey(target);
        const relation = { schema: 'public', name: 'invoices' };
        const text = JSON.stringify({ descriptor, ownWriteRevision: 0, relationRevisions: [] });
        const digest = `sha256:${computeSha256HexDigest(text)}`;
        const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
            expect(action).toBe(databaseActionLocalIdV1(DATABASE_RELATIONS_LIST_ACTION_ID_V1));
            return { ok: true, operation: 'relations.list', relations: [{ relation, kind: 'table' }], completeness: { complete: true } };
        });
        const surface = await createPluginUiTestkit({
            identity: { instanceId: 'workbench-rail', mountNonce: 'workbench-rail' },
            authorPlugin: { id: 'happier.database', version: '0.0.0' },
            surface: null, surfaceContext: createSurfaceContextFixture({ accountScope: scope }),
            // renderHook mounts the Workbench below. Here only the transport needs a fixture.
            adapter: { async mount() { return {
                async snapshot() { return { revision: 1, nodes: [] }; }, async update() {}, async invoke() {}, async dispose() {},
            }; } },
            handlers: {
                executeAction,
                readResource: () => ({ contentType: 'application/json', digest, bytes: new TextEncoder().encode(text) }),
                watchResource: () => ({ digest }),
            },
        });
        let host = createPluginUiPrivatePresentationHost(undefined, { direction: 'ltr' });
        const launch = { descriptor, scope: { kind: 'environment' as const, environment: target.environment } };
        const mount = await renderHook((mode: 'overview' | 'data') => useWorkbenchMount(surface.context, launch, {
            targetKey, mode, ...(mode === 'data' ? { relation } : {}), sort: [], columns: [], page: { rows: 50, offset: 0 }, fkTrail: [],
        }, { pageLocation: false }), {
            initialProps: 'overview',
            wrapper: ({ children }) => <PluginUiPresentationHostProviderInternal host={host}>{children}</PluginUiPresentationHostProviderInternal>,
        });
        try {
            const instance = mount.getCurrent()!;
            const initial = instance.schemaRelations(targetKey, relation.schema);
            await initial.demand();
            expect(initial.get().data?.relations.map(item => item.name)).toEqual(['invoices']);
            await instance.navigate({ mode: 'data', relation });
            host = createPluginUiPrivatePresentationHost(undefined, { direction: 'ltr' });
            const opened = (await mount.rerender('data'))!.schemaRelations(targetKey, relation.schema);
            expect(opened.get().data?.relations.map(item => item.name)).toEqual(['invoices']);
            await opened.demand();
            expect(executeAction).toHaveBeenCalledTimes(1);
        } finally { await mount.unmount(); await surface.dispose(); }
    });

    it('uses the declared Account cadence and resumes after reconnect and reopen', async () => {
        const bridge = await loadSyncSingletonForTests();
        let revision = 1;
        let interval = 12_000;
        let settingsReads = 0;
        const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-database-workbench/manifest');
        const declaration = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
        const { id: pluginId, version } = declaration;
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://workbench-settings.test', serverIdentityId: 'srv_workbench_settings', accountId: 'viewer',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path !== `/v1/account/plugin-settings/${pluginId}`) {
                    return createPlainAccountEncryptionCurrentnessHttpResponse(path);
                }
                if (init?.method === 'POST') {
                    if (typeof init.body !== 'string') throw new Error('Expected a JSON mutation');
                    const mutation = PluginAccountSettingsMutationRequestV1Schema.parse(JSON.parse(init.body));
                    if (mutation.expectedRevision !== revision) return Response.json({ status: 'conflict', revision });
                    if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain Account record');
                    interval = Number(mutation.content.v.values.activityRefreshIntervalMs);
                    return Response.json({ status: 'updated', revision: ++revision });
                }
                settingsReads += 1;
                return Response.json({ status: 'present', revision,
                    content: { t: 'plain', v: { v: 1, values: { activityRefreshIntervalMs: interval } } } });
            },
        });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        onTestFinished(async () => { clearPluginAccountAvailabilityProjection(); await connection.dispose(); bridge.dispose(); });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected an active Account');
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: { availabilityCursor: 1,
            materializations: [], snapshots: [], intentReads: [{ pluginId, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId, desiredVersion: version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId, version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest: declaration, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } }] } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { createUiPluginSettingsAdministrationAction } = await import('@/sync/ops/actions/pluginSettingsAdministrationAction');
        const account = await captureLazyActionAccountContext(connection.home.id);
        onTestFinished(() => account.dispose());
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            pluginSettingsAdministrationAction: createUiPluginSettingsAdministrationAction(account),
        }));
        vi.useFakeTimers();
        const initial = storage.getState();
        const host = createPluginUiPrivatePresentationHost(undefined, { pluginId,
            automations: { accountLifetime: lifetime, target: { kind: 'app' }, isCurrent: () => lifetime.isCurrent() } });
        const descriptor = { ...createDatabaseDescriptorV1Fixture(), target };
        const targetKey = workbenchTargetKey(target);
        const { machineId, serverId } = descriptor.placement;
        const updatePresence = (active: boolean, id = machineId) => storage.getState().applyMachineActivityUpdates(
            [{ id, active, activeAt: Date.now() }], { sourceServerId: serverId });
        storage.getState().applyMachines([machineId, 'neighbor'].map(id => createMachineFixture({
            id, active: true, activeAt: Date.now(), presenceProtocolVersion: 1,
        })), false, { sourceServerId: serverId });
        updatePresence(true);
        updatePresence(true, 'neighbor');
        const operation = vi.fn<WorkbenchClient['operation']>(async () => ({
            ok: true, operation: 'stats.read',
            observation: { ...observation('1', 1000), group: 'activity', data: [] },
        }));
        const instance = createWorkbenchInstance({
            scope: { kind: 'environment', environment: target.environment },
            location: { targetKey, mode: 'overview', sort: [], columns: [], page: { rows: 10, offset: 0 }, fkTrail: [] },
            selectedTarget: descriptor, cataloguePageRows: 10, activityResource: host.databaseWorkbench.activityResource,
            consoleStorage: () => ({ read: async () => null, write: async () => {} }), statementRanges: () => [],
            client: { operation, targets: async () => ({ targets: [], completeness: { complete: true } }),
                commit: async () => ({ ok: false, status: 'cancelled', code: 'database_cancelled' }),
                access: async () => { throw new Error('Not requested'); }, subscribeOwnWrites: () => () => {},
                cancel: async () => {}, navigate: async () => {}, setUnsavedChanges: async () => {}, presentDeviceStorageError: () => {} },
        });
        const activity = await renderHook((presented: boolean) => useDatabaseActivity(targetKey,
            { kind: 'stats.read', group: 'activity', selection: { page: { rows: 10 } } }, presented), {
            initialProps: false,
            wrapper: ({ children }) => <PluginUiPresentationHostProviderInternal host={host}>
                <WorkbenchProvider instance={instance}>{children}</WorkbenchProvider>
            </PluginUiPresentationHostProviderInternal>,
        });
        const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
        try {
            await advance(60_000);
            expect(operation).not.toHaveBeenCalled();
            expect(settingsReads).toBe(0);
            await activity.rerender(true);
            await vi.waitFor(() => {
                expect(settingsReads).toBeGreaterThan(0);
                expect(activity.getCurrent().autoRefreshEnabled).toBe(true);
            });
            await advance(0);
            expect(operation).toHaveBeenCalledTimes(1);
            await advance(60_000);
            expect(operation).toHaveBeenCalledTimes(6);
            await act(async () => updatePresence(false, 'neighbor'));
            await advance(12_000);
            expect(operation).toHaveBeenCalledTimes(7);
            await act(async () => updatePresence(false));
            await act(async () => { await activity.getCurrent().refresh(); });
            await advance(60_000);
            expect(operation).toHaveBeenCalledTimes(7);
            await act(async () => updatePresence(true));
            await advance(0);
            expect(operation).toHaveBeenCalledTimes(8);
            await act(async () => {
                expect(await executor.execute('plugins.settings.set', {
                    pluginId, scope: { kind: 'account' }, target: { kind: 'account' },
                    localId: 'activityRefreshIntervalMs', expectedRevision: String(revision), value: 0,
                }, { surface: 'agent', bypassApprovals: true })).toMatchObject({ ok: true });
                expect(interval).toBe(0);
            });
            await vi.waitFor(() => expect(activity.getCurrent().autoRefreshEnabled).toBe(false));
            await advance(0);
            const beforeManual = operation.mock.calls.length;
            await advance(60_000);
            expect(operation).toHaveBeenCalledTimes(beforeManual);
            await act(async () => { await activity.getCurrent().refresh(); });
            expect(operation).toHaveBeenCalledTimes(beforeManual + 1);
            await activity.rerender(false);
            await act(async () => { await activity.getCurrent().refresh(); });
            await advance(60_000);
            expect(operation).toHaveBeenCalledTimes(beforeManual + 1);
            await activity.rerender(true);
            await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(beforeManual + 2));
        } finally {
            await activity.unmount();
            instance.close();
            storage.setState(initial, true);
        }
    });

    it('exposes one callable binding and leaves activity reads asleep without presented demand', async () => {
        const host = createPluginUiPrivatePresentationHost(undefined);
        expect(host.databaseWorkbench).toBeDefined();
        const hook = await renderHook(hostApi.useHostDatabaseWorkbench, {
            wrapper: ({ children }) => <PluginUiPresentationHostProviderInternal host={host}>{children}</PluginUiPresentationHostProviderInternal>,
        });
        vi.useFakeTimers();
        const read = vi.fn(async () => ({ backends: 1 }));
        const controller = hook.getCurrent()!.activityResource({ read });
        try {
            await controller.refresh();
            expect(read).not.toHaveBeenCalled();
            const release = controller.retainAutoRefresh({ intervalMs: 0 });
            await vi.advanceTimersByTimeAsync(0);
            expect(controller.getSnapshot()).toEqual({ value: { backends: 1 }, loading: false, error: null });
            expect(read).toHaveBeenCalledTimes(1);
            release();
            await controller.refresh();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(read).toHaveBeenCalledTimes(1);
        } finally { controller.dispose(); vi.useRealTimers(); await hook.unmount(); }
    });

    it('reuses the device last-look owner across opens with explicit viewer isolation and no SQL persistence', () => {
        const host = createPluginUiPrivatePresentationHost(undefined);
        expect(host.databaseWorkbench).toBeDefined();
        const binding = host.databaseWorkbench!;
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        const first = binding.lastLook(scope, target);
        expect(writes).not.toHaveBeenCalled();
        expect(first.observe(observation('10', 1000), ['shown']).comparison).toEqual({ status: 'unavailable', reason: 'previous_sample_required' });
        first.observe(observation('20', 2000), ['shown']);
        expect(writes).toHaveBeenCalledTimes(1);
        expect(binding.lastLook(scope, target).observe(observation('30', 3000), ['shown']).comparison)
            .toMatchObject({ status: 'available', fromMs: 1000, rows: [{ key: 'shown', calls: '20' }] });
        expect(binding.lastLook({ ...scope, accountId: 'other' }, target).observe(observation('40', 4000), ['shown']).comparison)
            .toEqual({ status: 'unavailable', reason: 'previous_sample_required' });
        expect(writes.mock.calls.every(([, value]) => !String(value).includes('private_shape'))).toBe(true);
    });
});
