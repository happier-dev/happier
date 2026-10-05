import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { AccountProfileSchema, PluginProjectionV2Schema, PluginUiViewV2Schema, tryWriteServerEnabledBitInPlace, type ActionExecutorDeps } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createPluginWidgetAreaHostPortV1 } from '@happier-dev/protocol/plugins/ui';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary, createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema, WIDGET_SURFACE_ARTIFACT_KIND_V1, type WidgetAreaLayoutV1 } from '@happier-dev/protocol/widgets';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { widgetProjectionEntry, widgetProjectionOf, widgetInstalledPackage } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { AppShellPluginUiProjectionValueProvider, readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { storage } from '@/sync/domains/state/storage';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createWidgetInputActionDepsV1 } from './widgetInputActionDeps';
import { readWidgetActionCandidatesV1 } from './widgetCatalogActionDeps';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createPluginDeclaredResourceStore } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

it('admits a personal connection pin only from the current Account and refuses shared pins', async () => {
    await import('@/sync/syncEngine');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://personal-pin-mount.test', accountId: 'viewer',
        request: createHomeHubArtifactHttpBoundary('viewer').request });
    const previous = storage.getState();
    const restoreExecutorLoader = await installRealActionExecutorModuleLoader();
    try {
        const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
        const surface = { pluginId: 'com.acme.binding', localId: 'connection' };
        const selected = { service: { pluginId: surface.pluginId, localId: 'cloud' }, accountId: 'mine' };
        const foreign = { ...selected, accountId: 'foreign' };
        const profile = AccountProfileSchema.parse({ id: 'viewer', connectedAccountsV4: [{ ref: selected, status: 'connected', authenticationModeId: 'token',
            configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
        storage.setState({ profile, profileScope: { serverId: connection.home.id, accountId: profile.id } });
        const valueSchema = { type: 'object' as const, required: ['service', 'accountId'], additionalProperties: false, properties: {
                service: { type: 'object', required: ['pluginId', 'localId'], additionalProperties: false,
                    properties: { pluginId: { type: 'string' }, localId: { type: 'string' } } }, accountId: { type: 'string' },
            } };
        const inputs = { fields: [{ path: 'connection', title: 'Connection', widget: 'select' as const, connectedAccountOptions: true as const }] };
        const inputSchema = { type: 'object' as const, properties: { connection: valueSchema }, additionalProperties: false };
        const consumer = { pluginId: surface.pluginId, localId: 'metrics' };
        const purposes = { resources: [consumer], connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'read', consumer }] };
        const admitted = PluginUiViewV2Schema.parse({ id: surface.localId, renderer: 'widget-native', container: 'widget', target: { kind: 'app' }, inputs, inputSchema, ...purposes });
        expect(admitted).toMatchObject({ inputs, inputSchema });
        const widget = { ...widgetProjectionEntry({ ...surface, target: 'app', inputs, inputSchema, occurrenceId: 'current' }), ...purposes };
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [surface.pluginId]: { id: surface.pluginId, displayName: 'Binding', enabled: true, occurrenceId: 'current',
                source: { kind: 'local', locator: `/plugins/${surface.pluginId}` } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [widget.id]: widget } } },
            resourcesById: { metrics: { id: consumer.localId, pluginId: consumer.pluginId, resourceKind: 'config', scope: 'global',
                connectedAccountPurposes: [{ purpose: 'read', serviceRefs: [selected.service] }] } },
        }));
        const descriptor = readWidgetDescriptor(projection, surface)!;
        const home = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'home' as const } };
        const hook = await renderHook((props: Readonly<{ value: typeof selected; shared: boolean }>) => useConfiguredWidgetTarget({
            scope: props.shared ? { ...home, owner: { kind: 'sessionBoard', sessionId: 'shared' } } : home,
            descriptor, providedContext: {}, instance: { v: 1, id: 'pin', definition: { kind: 'installed', surface },
                bindings: { connection: { kind: 'value', value: props.value } } },
            appRuntime: { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: 'machine', serverId: home.serverId, platform: 'web' },
        }), { initialProps: { value: selected, shared: false }, wrapper: ({ children }) => React.createElement(AppShellPluginUiProjectionValueProvider,
            { value: { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: 'machine', serverId: home.serverId, platform: 'web', reloadConnectedAccountProjection: () => {},
                clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {} } }, children) });
        const { callWorkflowAction } = await import('@/sync/domains/workflows/callWorkflowAction');
        expect(await callWorkflowAction({ actionId: 'action.options.resolve', input: { consumer: { kind: 'widget', surface: home,
            definition: { kind: 'installed', surface } }, fieldPath: 'connection' }, parseResult: value => value }))
            .toMatchObject({ options: [{ value: selected }] });
        await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().status, JSON.stringify(hook.getCurrent())).toBe('ready')); });
        expect(hook.getCurrent()).toMatchObject({ input: { connection: selected } });
        await hook.rerender({ value: foreign, shared: false });
        expect(hook.getCurrent()).toMatchObject({ status: 'denied' });
        await hook.rerender({ value: selected, shared: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'denied' });
        await hook.unmount();
    } finally { restoreExecutorLoader(); storage.setState(previous, true); await connection.dispose(); }
});

it('validates a mounted schema-only typed pin from its selected origin before exposing a ready Widget target', async () => {
    await import('@/sync/syncEngine');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://typed-widget-mount.test', accountId: 'viewer',
        request: createHomeHubArtifactHttpBoundary('viewer').request });
    const previous = storage.getState();
    try {
        const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
        const inputType = { pluginId: 'com.acme.types', localId: 'repository' };
        const surface = { pluginId: 'com.acme.binding', localId: 'status' };
        const typeOrigin = { serverIdentityId: 'srv_types', materializationRef: {
            machineId: 'machine', materializationId: 'types-materialization', pluginId: inputType.pluginId,
        } };
        const widget = widgetProjectionEntry({ ...surface, target: 'app', inputs: { fields: [
            { path: 'repository', title: 'Repository', widget: 'select', inputType },
        ] }, inputSchema: { type: 'object', properties: { repository: { type: 'object' } }, additionalProperties: false } });
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [surface.pluginId]: { id: surface.pluginId, displayName: 'Binding', enabled: true,
                source: { kind: 'local', locator: `/plugins/${surface.pluginId}` } },
                [inputType.pluginId]: { id: inputType.pluginId, displayName: 'Types', enabled: true, occurrenceId: 'current',
                    source: { kind: 'local', locator: `/plugins/${inputType.pluginId}` } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [widget.id]: widget } },
                inputTypes: { family: 'inputTypes', entriesById: { [`${inputType.pluginId}/${inputType.localId}`]: {
                    id: `${inputType.pluginId}/${inputType.localId}`, pluginId: inputType.pluginId, pluginVersion: '1.0.0', occurrenceId: 'current',
                    ...typeOrigin,
                    definition: { id: inputType.localId, title: 'Repository', semantic: 'repository',
                        valueSchema: { type: 'object', required: ['repositoryId'], additionalProperties: false,
                            properties: { repositoryId: { type: 'string' } } } },
                } } } },
        }));
        const union = unionPluginUiProjections([{ machineId: 'machine', serverId: connection.home.id, projection,
            phase: 'current', interactionEnabled: true }], new Map([[inputType.pluginId, typeOrigin]]));
        if (!union.pluginUiProjection) throw new Error('Expected the current selected projection');
        const descriptor = readWidgetDescriptor(union.pluginUiProjection, surface)!;
        let currentProjection = union.pluginUiProjection;
        const scope = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'home' as const } };
        const hook = await renderHook((repositoryId: string | number) => useConfiguredWidgetTarget({ scope, descriptor,
            providedContext: {}, instance: { v: 1, id: 'typed-copy', definition: { kind: 'installed', surface },
                bindings: { repository: { kind: 'value', value: { repositoryId } } } },
            appRuntime: { pluginUiProjection: currentProjection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: 'machine', serverId: scope.serverId, platform: 'web' },
        }), { initialProps: 42 as string | number });
        expect(hook.getCurrent()).toMatchObject({ status: 'invalid', reasonCode: 'input_type_value_invalid' });
        await hook.rerender('repo');
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', input: { repository: { repositoryId: 'repo' } } });
        currentProjection = { ...projection, inputTypesById: {} };
        await hook.rerender('repo');
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', reasonCode: 'input_type_unavailable' });
        await hook.unmount();
    } finally { storage.setState(previous, true); await connection.dispose(); }
});

installDisconnectedServerSocketBoundary();
const daemon = vi.hoisted(() => ({ projections: new Map<string, unknown>(), resourceRead: vi.fn() }));
// Replace only the machine network transport. Projection admission, Account,
// exact Session hydration, catalog policy and input binding remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: Readonly<{ machineId: string; method: string; payload: unknown; signal?: AbortSignal }>) => {
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) return daemon.resourceRead(request.machineId, request.payload, request.signal);
        if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            throw new Error(`Unexpected daemon RPC: ${request.method}`);
        return { protocolVersion: 1, projection: daemon.projections.get(request.machineId) };
    },
}));

it('admits and refreshes a B-only stored widget using current B inputs and Resource declarations', async () => {
    await import('@/sync/syncEngine');
    const http = createHomeHubArtifactHttpBoundary('viewer');
    let areaHttp: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | null = null;
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Expected canonical Board feature');
    let boardItem: unknown = null;
    const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const record = (kind: string, localId: string, value: unknown) => ({ id: `${kind}-row`,
        address: { owner: 'host', namespace: 'surface', kind, localId }, content: { t: 'plain', v: value }, revision,
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' });
    // Real plain system-record envelopes at the HTTP persistence boundary;
    // canonical repository, Board adapter and Action port open them normally.
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://widget-input-binding.test', accountId: 'viewer', request: async (input, init) => {
        const url = new URL(String(input));
        if (areaHttp && (url.pathname === `/v1/artifacts/${areaHttp.artifactId}` || url.pathname === '/v1/artifacts' && init?.method === 'POST')) return areaHttp.request(input, init);
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(features);
        if (url.pathname === '/v2/sessions/physical-a/system-records/record') return Response.json({ record: url.searchParams.get('kind') === 'layout.v1'
            ? record('layout.v1', 'layout', { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'copy-b', width: 'wide' }] }] })
            : boardItem ? record('item.v1', 'copy-b', boardItem) : null });
        if (url.pathname === '/v2/sessions/physical-a/system-records') return Response.json({ records: boardItem ? [record('item.v1', 'copy-b', boardItem)] : [], nextCursor: null, hasNext: false });
        return http.request(input, init);
    } });
    const previous = storage.getState();
    let tree: renderer.ReactTestRenderer | null = null;
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: account.serverId, snapshot: { status: 'ready', features } });
        const scope = { serverId: account.serverId, accountId: account.accountId };
        const areaSurface = { ...scope, owner: { kind: 'pluginArea' as const, pluginId: 'com.acme.binding', pageId: 'overview', area: 'pinned' } };
        areaHttp = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('viewer', { artifactId: buildWidgetSurfaceArtifactIdV1(areaSurface),
            kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, defaultLayout: { v: 1, surface: areaSurface, instances: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value) });
        const a = createSessionFixture({ id: 'physical-a', serverId: scope.serverId, metadata: { path: '/a', machineId: 'machine-a', host: 'a' } });
        const b = createSessionFixture({ id: 'selected-b', serverId: scope.serverId, metadata: { path: '/b', machineId: 'machine-b', host: 'b' } });
        const machines = [createMachineFixture({ id: 'machine-a' }), createMachineFixture({ id: 'machine-b' })];
        storage.setState({ sessions: { [a.id]: a, [b.id]: b },
            sessionListRowsByServerId: { [scope.serverId]: Object.fromEntries([a, b].map(session => [session.id,
                createSessionListRenderableSessionFixture({ ...session })])) },
            machines: Object.fromEntries(machines.map(machine => [machine.id, machine])), machineListByServerId: { [scope.serverId]: machines } });
        const surface = { pluginId: 'com.acme.binding', localId: 'status' };
        const inputSchema = { type: 'object' as const, required: ['session', 'mode'], additionalProperties: false,
            properties: { session: { type: 'object' as const, required: ['serverId', 'sessionId'], additionalProperties: false,
                properties: { serverId: { type: 'string' as const }, sessionId: { type: 'string' as const } } }, mode: { type: 'string' as const } } };
        const entry = (choice: string) => ({ ...surface, inputSchema, sessionInputPath: 'session', occurrenceId: 'binding-occurrence',
            resources: [{ pluginId: surface.pluginId, localId: `${choice}-state` }], inputs: { fields: [
            { path: 'session', title: 'Session', widget: 'json' as const, required: true },
            { path: 'mode', title: 'Mode', widget: 'select' as const, required: true, options: [{ value: choice, label: choice }] },
        ] } });
        const installed = { [surface.pluginId]: { ...widgetInstalledPackage(surface.pluginId, 'Binding'), occurrenceId: 'binding-occurrence', source: { kind: 'local', locator: `/plugins/${surface.pluginId}` } } };
        const resources = (choice: string) => ({ state: { id: `${choice}-state`, pluginId: surface.pluginId, resourceKind: 'config' as const,
            contentType: 'application/json', scope: 'session' as const } });
        const projection = (choice?: string) => PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: installed, actionsById: {},
            resourcesById: choice ? resources(choice) : {},
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: choice ? { widget: widgetProjectionEntry(entry(choice)) } : {} } } });
        daemon.projections.set('machine-a', projection());
        daemon.projections.set('machine-b', projection('current-b'));
        clearDaemonMergedProjectionCacheForTests();
        const metadata = widgetProjectionOf([entry('metadata-only')], installed, resources('metadata-only'));
        const projected = unionPluginUiProjections([{ machineId: 'machine-b', serverId: scope.serverId, projection: metadata,
            phase: 'current', interactionEnabled: true }], new Map(), 'machine-b');
        await act(async () => { tree = renderer.create(<AppShellPluginUiProjectionValueProvider value={{ ...projected,
            pluginBrowserProjection: null, platform: 'web', clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}><></></AppShellPluginUiProjectionValueProvider>); });
        const physical = { ...scope, owner: { kind: 'sessionBoard' as const, sessionId: a.id } };
        const definition = { kind: 'installed' as const, surface };
        expect(readWidgetDescriptor(readCurrentAppShellPluginUiProjection(), definition)).not.toBeNull();
        expect(readMachineControlTargetForSession({ ...scope, sessionId: b.id })).toMatchObject({ machineId: 'machine-b' });
        const physicalCandidates = await readWidgetActionCandidatesV1(physical, account);
        expect(Array.isArray(physicalCandidates) && physicalCandidates.some(candidate => 'surface' in candidate && candidate.surface.localId === surface.localId)).toBe(false);
        const bCandidates = await readWidgetActionCandidatesV1(physical, account, undefined, { serverId: scope.serverId, sessionId: b.id });
        expect(bCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ surface })]));
        // Static input admission and the public Refresh use real descriptor
        // resolution; only HTTP and daemon network transports are replaced.
        const inputs = createWidgetInputActionDepsV1(account, {} as ActionExecutorDeps).widgetInputs!;
        const instance = { v: 1 as const, id: 'copy-b', definition, bindings: {
            session: { kind: 'value' as const, value: { serverId: scope.serverId, sessionId: b.id } },
            mode: { kind: 'value' as const, value: 'current-b' },
        } };
        const request = { ref: { surface: physical, instanceId: instance.id }, instance, context: { serverId: scope.serverId } };
        boardItem = { v: 1, title: 'Bound B', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance } };
        expect(await inputs.resolve(request)).toEqual({ status: 'ready', input: { session: { serverId: scope.serverId, sessionId: b.id }, mode: 'current-b' } });
        expect(await inputs.resolve({ ...request, instance: { ...instance, bindings: { ...instance.bindings, mode: { kind: 'value', value: 'metadata-only' } } } }))
            .toMatchObject({ status: 'invalid', fields: [{ path: 'mode', reasonCode: 'widget_input_option_unavailable' }] });
        daemon.resourceRead.mockReset();
        const resourceResult = { ok: true, resource: { pluginId: surface.pluginId, localId: 'current-b-state' },
            kind: 'config', contentType: 'application/json', digest: `sha256:${'b'.repeat(64)}`, bytesBase64: 'MQ==' };
        daemon.resourceRead.mockResolvedValue(resourceResult);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { serverId: scope.serverId, expectedAccountId: scope.accountId, surface: 'ui' as const };
        expect(await executor.execute('widgets.instance.refresh', { ref: request.ref }, context)).toEqual({ ok: true, result: { ref: request.ref, status: 'refreshed' } });
        expect(daemon.resourceRead).toHaveBeenCalledTimes(1);
        for (const call of daemon.resourceRead.mock.calls) expect(call.slice(0, 2)).toEqual(['machine-b', expect.objectContaining({
            resource: { pluginId: surface.pluginId, localId: 'current-b-state' }, context: { kind: 'session', sessionId: b.id },
            expectedCallerOccurrenceId: 'binding-occurrence',
        })]);
        const areaPort = createPluginWidgetAreaHostPortV1({ scope, pluginId: surface.pluginId, pageId: 'overview',
            declarations: [{ name: 'pinned', contextSchema: { type: 'object', properties: { session: inputSchema.properties.session },
                required: ['session'], additionalProperties: false } }], isCurrent: account.accountLifetime!.isCurrent,
            execute: (id, input, areaContext) => executor.execute(id, input, { ...context, ...areaContext, bypassApprovals: true }) });
        const areaInstance = { ...instance, bindings: { ...instance.bindings, session: { kind: 'context' as const, slot: 'session' } } };
        const pageContext = { session: { serverId: scope.serverId, sessionId: b.id } };
        expect(await areaPort.execute({ area: 'pinned', context: pageContext, operation: { actionId: 'widgets.instance.add', instance: areaInstance } })).toMatchObject({ ok: true });
        expect(await areaPort.execute({ area: 'pinned', context: pageContext, operation: { actionId: 'widgets.instance.inputs.validate', instanceId: instance.id, bindings: areaInstance.bindings } }))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { session: pageContext.session } } });
        expect(await areaPort.execute({ area: 'pinned', context: pageContext, operation: { actionId: 'widgets.instance.width.set', instanceId: instance.id, width: 'full' } })).toMatchObject({ ok: true });
        expect(await areaPort.execute({ area: 'pinned', context: pageContext, operation: { actionId: 'widgets.instance.refresh', instanceId: instance.id } }))
            .toMatchObject({ ok: true, result: { status: 'refreshed', ref: { surface: { owner: { kind: 'pluginArea' } } } } });
        expect(daemon.resourceRead.mock.calls.at(-1)?.slice(0, 2)).toEqual(['machine-b', expect.objectContaining({
            resource: { pluginId: surface.pluginId, localId: 'current-b-state' }, context: { kind: 'session', sessionId: b.id },
        })]);
        daemon.resourceRead.mockReset();
        daemon.resourceRead.mockResolvedValue(resourceResult);
        const writesAfterAreaEdits = areaHttp.writes.length;
        if (!account.accountLifetime) throw new Error('Expected canonical Account lifetime');
        const mount = createPluginDeclaredResourceStore({ accountLifetime: account.accountLifetime, pluginId: surface.pluginId,
            machineId: 'machine-b', serverId: scope.serverId, expectedCallerOccurrenceId: 'binding-occurrence', sessionId: b.id,
            resourcesById: resources('current-b') })!;
        const mountedEntry = mount.getEntry('current-b-state');
        const releaseMount = mountedEntry.subscribe(() => {}, false);
        try {
            await vi.waitFor(() => { expect(mountedEntry.getSnapshot().digest).toBe(resourceResult.digest); });
            let acknowledge: ((value: typeof resourceResult) => void) | undefined;
            const read = new Promise<typeof resourceResult>(resolve => { acknowledge = resolve; });
            daemon.resourceRead.mockReturnValue(read);
            const pending = executor.execute('widgets.instance.refresh', { ref: request.ref }, context);
            await vi.waitFor(() => { expect(daemon.resourceRead).toHaveBeenCalledTimes(2); });
            releaseMount(); mount.dispose();
            // The Action's static demand protects this requested read after
            // the last physical subscriber and its store lease disappear.
            expect(daemon.resourceRead.mock.calls[1]?.[2]?.aborted).toBe(false);
            acknowledge!(resourceResult);
            expect(await pending).toEqual({ ok: true, result: { ref: request.ref, status: 'refreshed' } });
            expect(daemon.resourceRead).toHaveBeenCalledTimes(2);
        } finally { releaseMount(); mount.dispose(); }
        const copiedDefinition = { v: 1 as const, id: 'copied-declarative', name: 'Copied checks', inputSchema,
            inputs: entry('current-b').inputs, sessionInputPath: 'session', provenance: { source: { kind: 'authored' as const } },
            body: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'metric' as const, label: 'Checks',
                data: { kind: 'resource' as const, resource: { pluginId: surface.pluginId, localId: 'current-b-state' },
                    inputSchema, outputSchema: { type: 'number' as const } }, value: { path: [], type: 'number' as const } } } } };
        const copiedInstance = { ...instance, definition: { kind: 'inline' as const, definition: copiedDefinition } };
        boardItem = { v: 1, title: 'Copied checks', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: copiedInstance } };
        daemon.resourceRead.mockResolvedValue(resourceResult);
        expect(await executor.execute('widgets.instance.refresh', { ref: request.ref }, context))
            .toEqual({ ok: true, result: { ref: request.ref, status: 'refreshed' } });
        expect(daemon.resourceRead.mock.calls.at(-1)?.slice(0, 2)).toEqual(['machine-b', expect.objectContaining({
            resource: { pluginId: surface.pluginId, localId: 'current-b-state' }, context: { kind: 'session', sessionId: b.id },
            expectedCallerOccurrenceId: 'binding-occurrence',
        })]);
        const readsBeforeDenial = daemon.resourceRead.mock.calls.length;
        storage.setState({ sessions: { ...storage.getState().sessions, [b.id]: { ...b, access: { ...b.access!, capabilities: { ...b.access!.capabilities, readTranscript: false } } } } });
        expect(await inputs.resolve(request)).toMatchObject({ status: 'unavailable' });
        expect(await executor.execute('widgets.instance.refresh', { ref: request.ref }, context)).toMatchObject({ ok: false });
        expect(daemon.resourceRead).toHaveBeenCalledTimes(readsBeforeDenial);
        expect(areaHttp.writes).toHaveLength(writesAfterAreaEdits);
        expect(http.writes).toHaveLength(0);
    } finally {
        await act(async () => { tree?.unmount(); });
        account.dispose(); clearDaemonMergedProjectionCacheForTests(); daemon.projections.clear();
        storage.setState(previous, true); await connection.dispose();
    }
});
