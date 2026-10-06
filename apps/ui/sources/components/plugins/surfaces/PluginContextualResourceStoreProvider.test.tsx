import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createPluginSurfaceActionHostApi } from './pluginSurfaceActionDispatch';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { useLivePluginResource, usePluginResource } from '@happier-dev/plugin-ui/hostApi';
import { createPluginUiResourceStore, createPluginUiHostApiResourceClient } from '@happier-dev/plugin-ui/advanced';
import { widgetProjectionOf, widgetInstalledPackage } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';
import { DeclarativeWidgetDocument } from '@/components/widgets/DeclarativeWidgetDocument';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { PluginDeclarativeDocumentV1Schema, createWorkBoardV1, buildWorkBoardWidgetKeyV1, type WorkBoardWidgetPlacementV1 } from '@happier-dev/protocol';
import { BoardCanvas, type BoardCanvasWidgetRender } from '@/components/boards/canvas/BoardCanvas';
import { projectBoardMembership } from '@/components/boards/model/boardMembership';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import type { WorkBoardEntityBinding } from '@/components/boards/model/workBoardEntityBinding';
import { resolveDeclarativeDataResourceBinding } from './declarativeDataSource';
import { HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { createWidgetSnapshotCaptureSlot, WidgetSnapshotCaptureContext } from '@/components/widgets/definitions/widgetSnapshotCapture';

installDisconnectedServerSocketBoundary();
const connections: Awaited<ReturnType<typeof restoreServerAccountForTest>>[] = [];
afterEach(async () => {
    for (const connection of connections.splice(0).reverse()) await connection.dispose();
});

const machineResourceRpc = vi.hoisted(() => ({
    read: vi.fn(),
    open: vi.fn(),
    next: vi.fn(),
    close: vi.fn(),
}));

// Mock only the daemon network boundary. Keep RPC request/response admission,
// contextual clients, Resource store, and watch pump real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: Readonly<{
        machineId: string;
        method: string;
        payload: Readonly<Record<string, unknown>>;
        signal?: AbortSignal;
    }>) => {
        const options = { ...request.payload, signal: request.signal };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) {
            await machineResourceRpc.close(request.machineId, options);
            return { ok: true };
        }
        const call = request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ
            ? machineResourceRpc.read
            : request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN
                ? machineResourceRpc.open
                : request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT
                    ? machineResourceRpc.next
                    : null;
        if (!call) throw new Error(`Unexpected daemon RPC: ${request.method}`);
        const response = await call(request.machineId, options);
        if (!response.supported) throw Object.assign(new Error(response.reason), { name: 'AbortError' });
        return response.result;
    },
}));

import {
    PluginContextualResourceState,
    PluginContextualResourceStoreProvider,
    type PluginContextualResourceBinding,
    usePluginContextualResourceStoreOwner,
    type PluginContextualResourceStoreOwner,
    acquirePluginContextualResourceStore,
    createPluginDeclaredResourceStore,
} from './PluginContextualResourceStoreProvider';

type AccountLifetime = PluginContextualResourceBinding['accountLifetime'];

const RESOURCE_ID = 'control-state';

function resourceResponse(marker: string) {
    return {
        supported: true as const,
        result: {
            ok: true as const,
            resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
            kind: 'config' as const,
            contentType: 'application/json',
            digest: `sha256:${marker.repeat(64)}`,
            bytesBase64: 'MQ==',
        },
    };
}

function watchOpenResponse(subscriptionId: string, marker: string) {
    return {
        supported: true as const,
        result: {
            ok: true as const,
            subscriptionId,
            digest: `sha256:${marker.repeat(64)}`,
        },
    };
}

function invalidatedResponse(subscriptionId: string, marker: string) {
    return {
        supported: true as const,
        result: {
            ok: true as const,
            status: 'event' as const,
            event: {
                version: 1 as const,
                subscriptionId,
                kind: 'invalidated' as const,
                digest: `sha256:${marker.repeat(64)}`,
            },
        },
    };
}

async function createAccountLifetime(input: Readonly<{
    accountId: string;
}>): Promise<Readonly<{
    lifetime: AccountLifetime;
    http: ReturnType<typeof createHomeHubArtifactHttpBoundary>;
    retire(): void;
}>> {
    await import('@/sync/syncEngine');
    const http = createHomeHubArtifactHttpBoundary(input.accountId);
    connections.push(await restoreServerAccountForTest({ serverUrl: 'http://contextual-resource.test',
        accountId: input.accountId, request: http.request }));
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected real captured Account lifetime');
    return Object.freeze({
        lifetime,
        http,
        retire: retireActiveServerAccountScopeLifetime,
    });
}

function binding(
    accountLifetime: AccountLifetime,
    expectedCallerOccurrenceId = 'occurrence-42',
): PluginContextualResourceBinding {
    return Object.freeze({
        accountLifetime,
        pluginId: 'acme.composer',
        machineId: 'machine-1',
        serverId: accountLifetime.scope.serverId,
        expectedCallerOccurrenceId,
        context: Object.freeze({ kind: 'session' as const, sessionId: 'session-1' }),
    });
}

function installLiveResourceRpc(input?: Readonly<{
    read?: (call: number) => ReturnType<typeof resourceResponse>;
    openMarker?: (options: Readonly<{ subscriptionId: string; expectedCallerOccurrenceId: string }>) => string;
    onNext?: (options: Readonly<{ subscriptionId: string; signal: AbortSignal }>) => Promise<unknown>;
}>) {
    const nextSignals: AbortSignal[] = [];
    let reads = 0;
    machineResourceRpc.read.mockReset();
    machineResourceRpc.open.mockReset();
    machineResourceRpc.next.mockReset();
    machineResourceRpc.close.mockReset();
    machineResourceRpc.read.mockImplementation(async () => (
        input?.read?.(++reads) ?? resourceResponse('a')
    ));
    machineResourceRpc.open.mockImplementation(async (
        _machineId: string,
        options: Readonly<{ subscriptionId: string; expectedCallerOccurrenceId: string }>,
    ) => watchOpenResponse(options.subscriptionId, input?.openMarker?.(options) ?? 'a'));
    machineResourceRpc.next.mockImplementation(async (
        _machineId: string,
        options: Readonly<{ subscriptionId: string; signal: AbortSignal }>,
    ) => {
        nextSignals.push(options.signal);
        if (input?.onNext) return await input.onNext(options);
        return await new Promise((resolve) => {
            options.signal.addEventListener('abort', () => {
                resolve({ supported: false as const, reason: 'aborted' as const });
            }, { once: true });
        });
    });
    machineResourceRpc.close.mockResolvedValue(undefined);
    return { nextSignals };
}

function ResourceProbe(props: Readonly<{
    binding: PluginContextualResourceBinding;
    onSnapshot(snapshot: PluginUiResourceSnapshot | null): void;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): React.ReactElement {
    return (
        <PluginContextualResourceState
            binding={props.binding}
            resource={RESOURCE_ID}
            {...(props.signal === undefined ? {} : { signal: props.signal })}
            {...(props.isCurrent === undefined ? {} : { isCurrent: props.isCurrent })}
        >
            {(snapshot) => {
                props.onSnapshot(snapshot);
                return null;
            }}
        </PluginContextualResourceState>
    );
}

describe('PluginContextualResourceStoreProvider', () => {
    it('measures Canvas read/watch demand before and after viewport deferral through the real Resource transport', async () => {
        const a = await createAccountLifetime({ accountId: 'account-a' });
        const surface = { ...a.lifetime.scope, owner: { kind: 'workBoard', boardId: 'demand' } } as const;
        const widgets: WorkBoardWidgetPlacementV1[] = ['top', 'bottom', 'right'].map(id => ({ kind: 'widget', width: 1,
            ref: { surface, instanceId: id }, instance: { v: 1, id, definition: { kind: 'installed', surface: { pluginId: 'acme.composer', localId: 'widget' } }, bindings: {} } }));
        const positions = { [buildWorkBoardWidgetKeyV1(widgets[0]!.ref)]: { x: 0, y: 0 },
            [buildWorkBoardWidgetKeyV1(widgets[1]!.ref)]: { x: 0, y: 4000 },
            [buildWorkBoardWidgetKeyV1(widgets[2]!.ref)]: { x: 4000, y: 0 } };
        const board = { ...createWorkBoardV1({ id: 'demand', name: 'Demand' }), widgets, positionsByItemRef: positions };
        const entityRuntime = createEntityDragDropRuntime();
        const entityBinding: WorkBoardEntityBinding = { scope: a.lifetime.scope, runtime: entityRuntime, isCurrent: a.lifetime.isCurrent,
            getContext: () => ({ scope: a.lifetime.scope, board, membership: projectBoardMembership(board, { sections: {}, filtered: null, isHomeMounted: () => true }), isHomeMounted: () => true }),
            execute: async () => { throw new Error('This read-demand workload performs no move'); } };
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'number' } }, value: { path: [], type: 'number' } } });
        const projection = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app' }],
            { 'acme.composer': { ...widgetInstalledPackage('acme.composer', 'Composer'), occurrenceId: 'occurrence-42' } },
            { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config', contentType: 'application/json', scope: 'session' } });
        const runtime = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: 'machine-1', serverId: a.lifetime.scope.serverId, platform: 'web' as const };
        async function run(mode: 'eager' | 'demanded') {
            installLiveResourceRpc();
            const renderWidget: BoardCanvasWidgetRender = (widget, state) => <WidgetFrame testID={`demand-frame:${widget.title}`}
                frameStyle="card" placement="board" title={widget.title} menu={state.grip} body={{ kind: 'content',
                    children: mode === 'eager' || state.active ? <DeclarativeWidgetDocument document={document} input={{}} runtime={runtime}
                        accountLifetime={a.lifetime} sessionId={widget.title} isCurrent={a.lifetime.isCurrent} testID={`demand-data:${widget.title}`} /> : null }} />;
            const screen = await renderScreen(<BoardCanvas cards={[]} widgets={widgets.map(placement => ({ key: buildWorkBoardWidgetKeyV1(placement.ref), title: placement.instance.id, placement }))}
                renderWidget={renderWidget} positionsByItemRef={positions} snap binding={entityBinding} onOpen={() => {}} />);
            await act(async () => {
                screen.findHostByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout: { width: 900, height: 200 } } });
                for (const placement of widgets) {
                    let node = screen.findHostByTestId(`board-canvas-widget:${buildWorkBoardWidgetKeyV1(placement.ref)}`)!;
                    while (!node.props.onLayout) node = node.parent!;
                    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 100 } } });
                }
            });
            const count = mode === 'eager' ? 3 : 1;
            await vi.waitFor(() => expect(machineResourceRpc.open.mock.calls).toHaveLength(count));
            expect(machineResourceRpc.read.mock.calls).toHaveLength(count);
            expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(count);
            expect(widgets.every(placement => screen.findHostByTestId(`demand-frame:${placement.instance.id}`))).toBe(true);
            if (mode === 'demanded') {
                await act(async () => { screen.findHostByTestId('board-canvas')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 4000 } } }); });
                await vi.waitFor(() => expect(machineResourceRpc.open.mock.calls).toHaveLength(2));
                expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(1);
                expect(machineResourceRpc.close.mock.calls).toHaveLength(1);
                await act(async () => {
                    screen.findHostByTestId('board-canvas')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
                    screen.findHostByTestId('board-canvas-horizontal')!.props.onScroll({ nativeEvent: { contentOffset: { x: 4000, y: 0 } } });
                });
                await vi.waitFor(() => expect(machineResourceRpc.open.mock.calls).toHaveLength(3));
                expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(1);
                expect(machineResourceRpc.close.mock.calls).toHaveLength(2);
            }
            await act(async () => { screen.tree.unmount(); });
            await vi.waitFor(() => expect(machineResourceRpc.close.mock.calls).toHaveLength(3));
        }
        await run('eager');
        await run('demanded');
    });

    it('renders declared typed Resource data and removes the previous viewer bytes on Account retirement', async () => {
        const firstWatch = installLiveResourceRpc();
        const a = await createAccountLifetime({ accountId: 'account-a' });
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'number' } },
            value: { path: [], type: 'number' } } });
        const projection = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app' }], { 'acme.composer': { ...widgetInstalledPackage('acme.composer', 'Composer'),
            occurrenceId: 'occurrence-42' } }, { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config',
                contentType: 'application/json', scope: 'session' } });
        const runtime = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: 'machine-1', serverId: a.lifetime.scope.serverId, platform: 'web' as const };
        const retained = unionPluginUiProjections([{ machineId: 'machine-1', serverId: a.lifetime.scope.serverId,
            projection, phase: 'retainedOffline', interactionEnabled: false }], new Map(), 'machine-1');
        expect(Object.values(retained.pluginUiProjection!.resourcesById)).toEqual(expect.arrayContaining([expect.objectContaining({ id: RESOURCE_ID })]));
        if (document.root.kind !== 'metric') throw new Error('Expected metric');
        expect(resolveDeclarativeDataResourceBinding({ projection: retained.pluginUiProjection, input: {},
            machineId: 'machine-1', serverId: a.lifetime.scope.serverId, accountLifetime: a.lifetime,
            sessionId: 'session-1', isCurrent: a.lifetime.isCurrent, requireReadAuthority: true }, document.root)).toBeNull();
        const renderA = (pluginUiProjection: typeof projection) => <DeclarativeWidgetDocument document={document} input={{}}
            runtime={{ ...runtime, pluginUiProjection }} accountLifetime={a.lifetime} sessionId="session-1"
            isCurrent={a.lifetime.isCurrent} testID="typed-a" />;
        // Another origin can keep AppShell's coarse state current. Demand for
        // this source must still follow its own exact retained-offline origin.
        const screenA = await renderScreen(renderA(retained.pluginUiProjection!));
        let screenB: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            expect(machineResourceRpc.read).not.toHaveBeenCalled();
            await act(async () => { screenA.tree.update(renderA(projection)); });
            await vi.waitFor(() => { expect(JSON.stringify(screenA.tree.toJSON())).toContain('"1"'); });
            expect(machineResourceRpc.read.mock.calls[0]?.[1]).toMatchObject({ resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                context: { kind: 'session', sessionId: 'session-1' }, expectedCallerOccurrenceId: 'occurrence-42' });
            await act(async () => { a.retire(); });
            const b = await createAccountLifetime({ accountId: 'account-b' });
            installLiveResourceRpc({ read: () => ({ ...resourceResponse('b'), result: { ...resourceResponse('b').result, bytesBase64: 'Mg==' } }) });
            await act(async () => {});
            expect(JSON.stringify(screenA.tree.toJSON())).not.toContain('"1"');
            expect(firstWatch.nextSignals.every(signal => signal.aborted)).toBe(true);
            screenB = await renderScreen(<DeclarativeWidgetDocument document={document} input={{}} runtime={runtime}
                accountLifetime={b.lifetime} sessionId="session-1" isCurrent={b.lifetime.isCurrent} testID="typed-b" />);
            await vi.waitFor(() => { expect(JSON.stringify(screenB!.tree.toJSON())).toContain('"2"'); });
            expect(a.http.writes).toHaveLength(0);
            expect(b.http.writes).toHaveLength(0);
        } finally { await act(async () => { screenA.tree.unmount(); screenB?.tree.unmount(); }); }
    });
    it.each(['transport failure', 'malformed success'] as const)('keeps the same data node and its last good value through %s, says so once and retries', async (failure) => {
        installLiveResourceRpc();
        const a = await createAccountLifetime({ accountId: 'account-a' });
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'number' } },
            value: { path: [], type: 'number' } } });
        const projection = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app' }], { 'acme.composer': { ...widgetInstalledPackage('acme.composer', 'Composer'),
            occurrenceId: 'occurrence-42' } }, { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config',
                contentType: 'application/json', scope: 'session' } });
        const runtime = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: 'machine-1', serverId: a.lifetime.scope.serverId, platform: 'web' as const };
        const captureSlot = createWidgetSnapshotCaptureSlot();
        const screen = await renderScreen(<WidgetFrame testID="kept-frame" frameStyle="card" placement="home" title="Checks" source="Composer"
            meta="As of today" body={{ kind: 'content', children: <WidgetSnapshotCaptureContext.Provider value={captureSlot}>
                <DeclarativeWidgetDocument document={document} input={{}} runtime={runtime}
                    accountLifetime={a.lifetime} sessionId="session-1" isCurrent={a.lifetime.isCurrent} testID="kept" />
            </WidgetSnapshotCaptureContext.Provider> }} />);
        const lease = acquirePluginContextualResourceStore(binding(a.lifetime))!;
        try {
            await vi.waitFor(() => { expect(JSON.stringify(screen.tree.toJSON())).toContain('"1"'); });
            const metric = screen.tree.root.findByType(HappierDataMetric);
            expect(screen.tree.root.findAll(node => node.props.testID === 'kept-freshness')).toHaveLength(0);

            let finishRead!: (value: unknown) => void;
            machineResourceRpc.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
            let refreshing!: Promise<PluginUiResourceSnapshot>;
            await act(async () => { refreshing = lease.store.getEntry(RESOURCE_ID).refresh(); });
            await vi.waitFor(() => expect(screen.findAllByTestId('kept-frame.refreshing').length).toBeGreaterThan(0));
            expect(screen.tree.root.findByType(HappierDataMetric)).toBe(metric);
            expect(screen.getTextContent()).toContain('Refreshing');
            expect(screen.getTextContent()).toContain('Composer');
            await act(async () => {
                finishRead(failure === 'transport failure'
                    ? { supported: true, result: { ok: false, reason: 'unavailable', code: 'plugin_resource_unavailable' } }
                    : { ...resourceResponse('b'), result: { ...resourceResponse('b').result, bytesBase64: 'Indyb25nIg==' } });
                await refreshing;
            });
            expect(screen.findAllByTestId('kept-frame.refreshing')).toHaveLength(0);
            await vi.waitFor(() => { expect(screen.tree.root.findAll(node => node.props.testID === 'kept-freshness-action').length).toBeGreaterThan(0); });
            // The retained value stays at full strength in the very same component: no skeleton, no remount.
            expect(screen.tree.root.findByType(HappierDataMetric)).toBe(metric);
            expect(JSON.stringify(screen.tree.toJSON())).toContain('"1"');
            expect(screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'kept-freshness')).toHaveLength(1);
            expect(captureSlot.capture()).toMatchObject({ current: false, digests: [`sha256:${'a'.repeat(64)}`] });
            expect([...captureSlot.capture()!.frozenByPath.values()]).toMatchObject([{ data: { kind: 'value', value: 1 } }]);

            machineResourceRpc.read.mockResolvedValue({ ...resourceResponse('c'), result: { ...resourceResponse('c').result, bytesBase64: 'Mw==' } });
            const retry = screen.tree.root.findAll(node => node.props.testID === 'kept-freshness-action')[0]!;
            await act(async () => { retry.props.onPress(); });
            await vi.waitFor(() => { expect(JSON.stringify(screen.tree.toJSON())).toContain('"3"'); });
            expect(screen.tree.root.findAll(node => node.props.testID === 'kept-freshness')).toHaveLength(0);
            expect(screen.tree.root.findByType(HappierDataMetric)).toBe(metric);
        } finally { lease.dispose(); await act(async () => { screen.tree.unmount(); }); }
    });

    it('removes private typed content on server authority loss before the local projection retires', async () => {
        installLiveResourceRpc();
        const a = await createAccountLifetime({ accountId: 'account-a' });
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'number' } },
            value: { path: [], type: 'number' } } });
        const projection = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app' }],
            { 'acme.composer': { ...widgetInstalledPackage('acme.composer', 'Composer'), occurrenceId: 'occurrence-42' } },
            { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config', contentType: 'application/json', scope: 'session' } });
        const runtime = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: 'machine-1', serverId: a.lifetime.scope.serverId, platform: 'web' as const };
        const captureSlot = createWidgetSnapshotCaptureSlot();
        const renderDocument = (sessionId: string) => <WidgetFrame testID="private-frame" frameStyle="card" placement="home" title="Checks"
            body={{ kind: 'content', children: <WidgetSnapshotCaptureContext.Provider value={captureSlot}>
                <DeclarativeWidgetDocument document={document} input={{}} runtime={runtime}
                    accountLifetime={a.lifetime} sessionId={sessionId} isCurrent={a.lifetime.isCurrent} testID="private-data" />
            </WidgetSnapshotCaptureContext.Provider> }} />;
        const screen = await renderScreen(renderDocument('session-1'));
        const lease = acquirePluginContextualResourceStore(binding(a.lifetime))!;
        try {
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(1));
            // The contextual adapter exposes this exact daemon refusal code;
            // the Account and local declaration remain current.
            machineResourceRpc.read.mockResolvedValue({ supported: true,
                result: { ok: false, reason: 'unavailable', code: 'plugin_resource_session_access_unavailable' } });
            await act(async () => { await lease.store.getEntry(RESOURCE_ID).refresh(); });
            expect(a.lifetime.isCurrent()).toBe(true);
            expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(0);
            expect(screen.findAllByTestId('private-frame').length).toBeGreaterThan(0);
            expect(captureSlot.capture()?.frozenByPath.size).toBe(0);
            expect(captureSlot.capture()?.digests).toEqual([]);

            machineResourceRpc.read.mockResolvedValue(resourceResponse('c'));
            await act(async () => { await lease.store.getEntry(RESOURCE_ID).refresh(); });
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(1));
            // An exact Session identity change must also clear validated LKG
            // immediately, before the new authority's first read settles.
            machineResourceRpc.read.mockImplementation(() => new Promise(() => {}));
            await act(async () => { screen.tree.update(renderDocument('session-2')); });
            expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(0);
            expect(captureSlot.capture()?.frozenByPath.size).toBe(0);
        } finally { lease.dispose(); await act(async () => { screen.tree.unmount(); }); }
    });
    it('refreshes an actual Home instance through the public Action front door and reports real Resource failure', async () => {
        installLiveResourceRpc({ read: call => resourceResponse(call === 1 ? 'a' : 'b') });
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const instance = { v: 1 as const, id: 'configured-widget', definition: { kind: 'installed' as const,
            surface: { pluginId: 'acme.composer', localId: 'widget' } }, bindings: {} };
        account.http.seed({ v: 1, instances: [instance], order: [instance.id], hidden: [] });
        const resources = { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config' as const,
            contentType: 'application/json', scope: 'global' as const } };
        const model = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app',
            occurrenceId: 'occurrence-42', resources: [{ pluginId: 'acme.composer', localId: RESOURCE_ID }] }],
            { 'acme.composer': widgetInstalledPackage('acme.composer', 'Composer') }, resources);
        const projected = unionPluginUiProjections([{ machineId: 'machine-1', serverId: account.lifetime.scope.serverId,
            projection: model, phase: 'current', interactionEnabled: true }], new Map(), 'machine-1');
        const store = createPluginDeclaredResourceStore({ ...binding(account.lifetime), resourcesById: model.resourcesById })!;
        const entry = store.getEntry(RESOURCE_ID);
        const release = entry.subscribe(() => {}, false);
        await vi.waitFor(() => { expect(entry.getSnapshot().digest).toBe(`sha256:${'a'.repeat(64)}`); });
        let tree: renderer.ReactTestRenderer | null = null;
        try {
            await act(async () => { tree = renderer.create(<AppShellPluginUiProjectionValueProvider value={{ ...projected,
                pluginBrowserProjection: null, platform: 'web', clientExecutableActivation: { status: 'ready' },
                reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}><></></AppShellPluginUiProjectionValueProvider>); });
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const executor = createDefaultActionExecutor();
            const ref = { surface: { ...account.lifetime.scope, owner: { kind: 'home' as const } }, instanceId: instance.id };
            const context = { serverId: account.lifetime.scope.serverId, expectedAccountId: 'account-a', surface: 'ui' as const };
            expect(await executor.execute('widgets.instance.refresh', { ref }, context)).toEqual({ ok: true, result: { ref, status: 'refreshed' } });
            expect(entry.getSnapshot().digest).toBe(`sha256:${'b'.repeat(64)}`);
            machineResourceRpc.read.mockResolvedValue({ supported: true, result: { ok: false, reason: 'unavailable', code: 'plugin_resource_unavailable' } });
            expect(await executor.execute('widgets.instance.refresh', { ref }, context)).toMatchObject({ ok: false, errorCode: 'plugin_resource_unavailable' });
            expect(entry.getSnapshot().error?.code).toBe('plugin_resource_unavailable');
            expect(account.http.writes).toHaveLength(0);
        } finally { await act(async () => { tree?.unmount(); }); release(); store.dispose(); }
    });
    it.each([['shared', 'snapshot'], ['shared', 'live'], ['fallback', 'snapshot'], ['fallback', 'live']] as const)('reports native %s %s Resource refresh in the retained frame through the generated surface provider without extra demand or publishing its store', async (owner, mode) => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const lease = owner === 'shared' ? acquirePluginContextualResourceStore(binding(account.lifetime)) : null;
        const entry = lease?.store.getEntry(RESOURCE_ID);
        const release = entry?.subscribe(() => {}, false);
        if (entry) await vi.waitFor(() => { expect(entry.getSnapshot().digest).toBeDefined(); });
        const requestSurface = { pluginId: 'acme.composer', contributionId: 'widget', surfaceId: 'widget-native',
            placement: 'appSurface' as const, platform: 'ios' as const, channel: 'internal' as const,
            resourceScope: [], diagnostics: [] };
        const projected = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app' }],
            { 'acme.composer': widgetInstalledPackage('acme.composer', 'Composer') },
            { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config',
                contentType: 'application/json', ...(owner === 'shared' ? { scope: 'session' as const } : {}) } });
        const controller = createBoundPluginSurfaceController({ facts: { ...requestSurface,
            accountLifetime: account.lifetime, machineId: 'machine-1', serverId: account.lifetime.scope.serverId,
            sessionId: 'session-1', occurrenceId: 'occurrence-42', projectionGeneration: 1,
            resourceCapability: { readable: true, dynamic: true }, pluginUiProjection: projected,
            interactionEnabled: true, daemonInteractionEnabled: true } });
        expect(controller.resourceStore !== undefined).toBe(owner === 'shared');
        const host = controller.hostApi;
        const surface = createPluginSurfaceContextFixture();
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface, requestSurface, requestIdPrefix: 'shared-native',
            handleRequest: host.handleRequest, installedMethods: host.installedMethods });
        let snapshot: PluginUiResourceSnapshot | null = null;
        const readSnapshot = (): PluginUiResourceSnapshot | null => snapshot;
        let refresh = () => {};
        let privateStore: unknown;
        const useResource = mode === 'live' ? useLivePluginResource : usePluginResource;
        function NativeResourceBody() {
            const resource = useResource(RESOURCE_ID);
            snapshot = resource.resource;
            refresh = resource.refresh;
            return <Text>{snapshot.digest}</Text>;
        }
        const renderSurface = defineUiSurface(context => {
            privateStore = Reflect.get(context, 'resourceStore');
            return <NativeResourceBody />;
        });
        const { PluginReactNativeSurface } = await import('@/components/plugins/reactNative/PluginReactNativeSurface');
        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => { tree = renderer.create(<WidgetFrame testID="native-frame" frameStyle="card" placement="board"
                title="Native checks" source="Composer" meta="As of today" body={{ kind: 'content', children: <PluginReactNativeSurface surfaceId="widget-native"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{ renderSurface: context => {
                    const result = renderSurface(context);
                    if (result === null || React.isValidElement(result)) return result;
                    throw new Error('Expected a React element from the native surface boundary');
                } }} interactionEnabled
                privateHostBindings={{ resourceStore: controller.resourceStore, resourceStoreGeneration: 'occurrence-42',
                    accountLifetime: { isCurrent: account.lifetime.isCurrent, onRetire: account.lifetime.onRetire } }}
                renderContext={{ plugin: { id: 'acme.composer', version: '1.0.0' },
                    surface, hostApi: adapter.api, signal: new AbortController().signal }} /> }} />); });
            await vi.waitFor(() => { expect(snapshot?.digest).toBe(`sha256:${'a'.repeat(64)}`); });
            if (mode === 'live') await vi.waitFor(() => { expect(snapshot).toMatchObject({ subscription: 'live', pending: 'idle' }); });
            expect(privateStore).toBeUndefined();
            if (mode === 'snapshot') expect(machineResourceRpc.read).toHaveBeenCalledTimes(1);
            const baselineReads = machineResourceRpc.read.mock.calls.length;
            const body = tree.root.findByType(NativeResourceBody);
            let finishRead = (_value: ReturnType<typeof resourceResponse>) => {};
            machineResourceRpc.read.mockImplementationOnce(() => new Promise<ReturnType<typeof resourceResponse>>(resolve => { finishRead = resolve; }));
            await act(async () => { refresh(); });
            await vi.waitFor(() => { expect(tree!.root.findAll(node => node.props.testID === 'native-frame.refreshing').length).toBeGreaterThan(0); });
            expect(readSnapshot()?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            expect(tree.root.findByType(NativeResourceBody)).toBe(body);
            expect(JSON.stringify(tree.toJSON())).toContain('Refreshing');
            expect(JSON.stringify(tree.toJSON())).toContain('Composer');
            await act(async () => { finishRead(resourceResponse('b')); });
            await vi.waitFor(() => { expect(snapshot?.digest).toBe(`sha256:${'b'.repeat(64)}`); });
            expect(tree.root.findAll(node => node.props.testID === 'native-frame.refreshing')).toHaveLength(0);
            expect(tree.root.findByType(NativeResourceBody)).toBe(body);
            expect(machineResourceRpc.read).toHaveBeenCalledTimes(baselineReads + 1);
            expect(machineResourceRpc.open).toHaveBeenCalledTimes(mode === 'live' ? 1 : 0);
        } finally { await act(async () => { tree?.unmount(); }); adapter.dispose(); controller.dispose(); release?.(); lease?.dispose(); }
    });
    it('does not bind shared transport to its first Action invocation signal', async () => {
        const rpc = installLiveResourceRpc({ read: call => resourceResponse(call === 1 ? 'a' : 'b') });
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const signal = new AbortController();
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const action = await captureLazyActionAccountContext(account.lifetime.scope.serverId, signal.signal);
        if (!action.accountLifetime) throw new Error('Expected real Action lifetime');
        const actionLease = acquirePluginContextualResourceStore(binding(action.accountLifetime))!;
        const entry = actionLease.store.getEntry(RESOURCE_ID);
        const releaseAction = entry.subscribe(() => {}, true);
        await vi.waitFor(() => { expect(entry.getSnapshot().digest).toBe(`sha256:${'a'.repeat(64)}`); });
        const mountLease = acquirePluginContextualResourceStore(binding(account.lifetime))!;
        const mounted = mountLease.store.getEntry(RESOURCE_ID);
        const releaseMount = mounted.subscribe(() => {}, true);
        try {
            signal.abort(); action.dispose(); releaseAction(); actionLease.dispose();
            expect(rpc.nextSignals[0]?.aborted).toBe(false);
            expect((await mounted.refresh()).digest).toBe(`sha256:${'b'.repeat(64)}`);
            account.retire();
            expect(mounted.getSnapshot().value).toBeUndefined();
        } finally { releaseAction(); actionLease.dispose(); releaseMount(); mountLease.dispose(); action.dispose(); }
    });
    it('shares declared global bytes across app and Session mounts while keeping Session A and B distinct', async () => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const resources = { global: { id: 'global-state', pluginId: 'acme.composer', resourceKind: 'config' as const,
            path: 'global-state', contentType: 'application/json', scope: 'global' as const },
            session: { id: 'session-state', pluginId: 'acme.composer', resourceKind: 'config' as const,
                path: 'session-state', contentType: 'application/json', scope: 'session' as const } };
        const base = { ...binding(account.lifetime), resourcesById: resources };
        const app = createPluginDeclaredResourceStore(base)!;
        const sessionA = createPluginDeclaredResourceStore({ ...base, sessionId: 'session-a' })!;
        const sessionB = createPluginDeclaredResourceStore({ ...base, sessionId: 'session-b' })!;
        try {
            const global = app.getEntry('global-state');
            const release = global.subscribe(() => {}, false);
            await vi.waitFor(() => { expect(global.getSnapshot().digest).toBeDefined(); });
            expect(sessionA.getEntry('global-state').getSnapshot()).toBe(global.getSnapshot());
            expect(sessionB.getEntry('global-state').getSnapshot()).toBe(global.getSnapshot());
            machineResourceRpc.read.mockImplementation(async (_machine: string, options: Readonly<{ context: { kind: string; sessionId?: string } }>) =>
                resourceResponse(options.context.sessionId === 'session-a' ? 'a' : 'b'));
            const a = sessionA.getEntry('session-state');
            const b = sessionB.getEntry('session-state');
            const releaseA = a.subscribe(() => {}, false);
            const releaseB = b.subscribe(() => {}, false);
            await vi.waitFor(() => {
                expect(a.getSnapshot().digest).toBe(`sha256:${'a'.repeat(64)}`);
                expect(b.getSnapshot().digest).toBe(`sha256:${'b'.repeat(64)}`);
            });
            expect((await global.refresh()).digest).toBe(`sha256:${'b'.repeat(64)}`);
            expect(sessionA.getEntry('global-state').getSnapshot().digest).toBe(`sha256:${'b'.repeat(64)}`);
            expect(sessionB.getEntry('global-state').getSnapshot().digest).toBe(`sha256:${'b'.repeat(64)}`);
            expect(() => app.getEntry('session-state')).toThrow(expect.objectContaining({ code: 'plugin_resource_context_unavailable' }));
            expect(() => app.getEntry('undeclared')).toThrow(expect.objectContaining({ code: 'plugin_resource_not_found' }));
            release();
            releaseA(); releaseB();
        } finally { app.dispose(); sessionA.dispose(); sessionB.dispose(); }
    });
    it('shares completed refresh bytes through the mounted read/watch IPC bridge without a second daemon read', async () => {
        installLiveResourceRpc({ read: (call) => resourceResponse(call === 1 ? 'a' : 'b') });
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        const lease = acquirePluginContextualResourceStore(exactBinding)!;
        const entry = lease.store.getEntry(RESOURCE_ID);
        const release = entry.subscribe(() => {}, true);
        await vi.waitFor(() => { expect(entry.getSnapshot().digest).toBe(`sha256:${'a'.repeat(64)}`); });
        const events: unknown[] = [];
        const requestSurface = { pluginId: 'acme.composer', contributionId: 'widget', surfaceId: 'widget-one',
            sessionId: 'session-1', placement: 'sessionPane' as const, platform: 'ios' as const,
            channel: 'internal' as const, resourceScope: [], diagnostics: [] };
        const host = createPluginSurfaceActionHostApi({ surfaceContext: requestSurface,
            resource: { machineId: exactBinding.machineId, serverId: exactBinding.serverId,
                expectedCallerOccurrenceId: exactBinding.expectedCallerOccurrenceId, context: exactBinding.context, store: lease.store },
            resourceInvalidation: { deliver: (event) => { adapter.publishResourceSubscriptionEvent(event); } },
            isCurrent: account.lifetime.isCurrent });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({ mount: { kind: 'destination',
                destination: { pluginId: 'acme.composer', localId: 'widget' }, container: 'rightPane' },
                target: { kind: 'session', sessionId: 'session-1' } }),
            requestSurface, requestIdPrefix: 'shared-resource', handleRequest: host.handleRequest,
            installedMethods: host.installedMethods });
        // These are the actual guest Resource stores over the public IPC API,
        // not a substituted watcher/reducer. Only daemon/network is replaced.
        const guests = [1, 2].map(() => createPluginUiResourceStore({
            client: createPluginUiHostApiResourceClient(adapter.api), pluginId: 'acme.composer', accountLifetime: account.lifetime }));
        const guestEntries = guests.map(store => store.getEntry(RESOURCE_ID));
        const guestReleases = guestEntries.map(guest => guest.subscribe(() => {}, true));
        try {
            expect((await adapter.api.readResource(RESOURCE_ID)).digest).toBe(`sha256:${'a'.repeat(64)}`);
            await vi.waitFor(() => { for (const guest of guestEntries) expect(guest.getSnapshot()).toMatchObject({ digest: `sha256:${'a'.repeat(64)}`, pending: 'idle' }); });
            const watch = await adapter.api.watchResource(RESOURCE_ID, (event) => { events.push(event); });
            expect((await entry.refresh()).digest).toBe(`sha256:${'b'.repeat(64)}`);
            await vi.waitFor(() => { expect(events).toContainEqual(expect.objectContaining({ kind: 'invalidated', digest: `sha256:${'b'.repeat(64)}` })); });
            expect((await adapter.api.readResource(RESOURCE_ID)).digest).toBe(`sha256:${'b'.repeat(64)}`);
            await vi.waitFor(() => { for (const guest of guestEntries) expect(guest.getSnapshot()).toMatchObject({ digest: `sha256:${'b'.repeat(64)}`, pending: 'idle' }); });
            expect(machineResourceRpc.read).toHaveBeenCalledTimes(2);
            expect(machineResourceRpc.open).toHaveBeenCalledTimes(1);
            const eventsBeforeSameDigest = events.length;
            await entry.refresh();
            await Promise.resolve();
            expect(events).toHaveLength(eventsBeforeSameDigest);
            expect(machineResourceRpc.read).toHaveBeenCalledTimes(3);
            machineResourceRpc.read.mockResolvedValue({ supported: true, result: { ok: false, reason: 'unavailable', code: 'plugin_resource_unavailable' } });
            expect((await entry.refresh()).error?.code).toBe('plugin_resource_unavailable');
            await vi.waitFor(() => { for (const guest of guestEntries) expect(guest.getSnapshot()).toMatchObject({ pending: 'idle', error: { code: 'unavailable' } }); });
            expect(machineResourceRpc.read).toHaveBeenCalledTimes(4);
            watch.dispose();
            account.retire();
            for (const guest of guestEntries) expect(guest.getSnapshot().value).toBeUndefined();
            await expect(adapter.api.readResource(RESOURCE_ID)).rejects.toMatchObject({ code: 'stale_surface' });
        } finally { guestReleases.forEach(release => release()); guests.forEach(store => store.dispose());
            adapter.dispose(); host.dispose?.(); release(); lease.dispose(); }
    });
    it('keeps only visible panes watching while retained hidden panes keep their snapshots and resume fresh', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const bindings = Array.from({ length: 12 }, (_, index) => Object.freeze({ ...binding(account.lifetime),
            context: Object.freeze({ kind: 'session' as const, sessionId: `session-${index}` }) }));
        const snapshots = new Map<number, PluginUiResourceSnapshot | null>();
        function App(props: Readonly<{ visibleCount: number }>) {
            return <PluginContextualResourceStoreProvider>{bindings.map((exactBinding, index) =>
                <PluginSurfaceFocusEligibilityProvider key={index} active={index === 0} presentationActive={index < props.visibleCount}>
                    <ResourceProbe binding={exactBinding} onSnapshot={(snapshot) => { snapshots.set(index, snapshot); }} />
                </PluginSurfaceFocusEligibilityProvider>)}
            </PluginContextualResourceStoreProvider>;
        }
        let tree: renderer.ReactTestRenderer | null = null;
        try {
            await act(async () => { tree = renderer.create(<App visibleCount={12} />); });
            await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(12); });
            await act(async () => { tree?.update(<App visibleCount={2} />); });
            expect(rpc.nextSignals.filter((signal) => !signal.aborted)).toHaveLength(2);
            await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(10); });
            expect(snapshots.get(11)?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            const opens = machineResourceRpc.open.mock.calls.length;
            await act(async () => { tree?.update(<App visibleCount={2} />); });
            expect(machineResourceRpc.open.mock.calls.length).toBe(opens);
            await act(async () => { tree?.update(<App visibleCount={3} />); });
            await vi.waitFor(() => { expect(rpc.nextSignals.filter((signal) => !signal.aborted)).toHaveLength(3); });
            expect(machineResourceRpc.open.mock.calls.length).toBe(opens + 1);
        } finally { await act(async () => { tree?.unmount(); }); }
    });
    it('reuses its nearest contextual owner instead of creating a nested Resource store owner', async () => {
        let outerOwner: PluginContextualResourceStoreOwner | null = null;
        let innerOwner: PluginContextualResourceStoreOwner | null = null;

        function OwnerProbe(props: Readonly<{ location: 'outer' | 'inner' }>) {
            const owner = usePluginContextualResourceStoreOwner();
            if (props.location === 'outer') outerOwner = owner;
            else innerOwner = owner;
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <OwnerProbe location="outer" />
                    <PluginContextualResourceStoreProvider>
                        <OwnerProbe location="inner" />
                    </PluginContextualResourceStoreProvider>
                </PluginContextualResourceStoreProvider>,
            );
        });

        expect(outerOwner).not.toBeNull();
        expect(innerOwner).toBe(outerOwner);

        await act(async () => { tree?.unmount(); });
    });

    it('shares one exact context across independent providers and disposes its real watch only after the final release', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'ab516d49-4112-4459-857e-7560beffb41a' });
        // Ordinary UUID coordinates must fit the actual daemon watch contract;
        // transport identity must not grow with the serialized context.
        const exactBinding = Object.freeze({
            ...binding(account.lifetime),
            machineId: 'fb489c9b-54f3-4093-9055-70c496253d48',
        });
        let first: PluginUiResourceSnapshot | null = null;
        let second: PluginUiResourceSnapshot | null = null;

        function App(props: Readonly<{ showFirst: boolean; showSecond: boolean }>) {
            return (
                <>
                    <PluginContextualResourceStoreProvider>
                        {props.showFirst ? <ResourceProbe binding={exactBinding} onSnapshot={(snapshot) => { first = snapshot; }} /> : null}
                    </PluginContextualResourceStoreProvider>
                    <PluginContextualResourceStoreProvider>
                        {props.showSecond ? <ResourceProbe binding={exactBinding} onSnapshot={(snapshot) => { second = snapshot; }} /> : null}
                    </PluginContextualResourceStoreProvider>
                </>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<App showFirst showSecond />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(first?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            expect(second?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            expect(first?.error).toBeUndefined();
            expect(first).toMatchObject({ subscription: 'live' });
        });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(1);
        expect(machineResourceRpc.open).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree?.update(<App showFirst showSecond={false} />);
            await Promise.resolve();
        });
        expect(machineResourceRpc.close).not.toHaveBeenCalled();
        expect(rpc.nextSignals[0]?.aborted).toBe(false);

        await act(async () => {
            tree?.update(<App showFirst={false} showSecond={false} />);
            await Promise.resolve();
        });
        expect(rpc.nextSignals[0]?.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });

        await act(async () => { tree?.unmount(); });
    });

    it('keeps Account A and B isolated and fences a late A watch event after synchronous retirement', async () => {
        let resolveLateA: ((value: ReturnType<typeof invalidatedResponse>) => void) | null = null;
        let accountASubscriptionId: string | null = null;
        const rpc = installLiveResourceRpc({
            read: (call) => call === 1 ? resourceResponse('a') : resourceResponse('b'),
            openMarker: (options) => {
                accountASubscriptionId ??= options.subscriptionId;
                return options.subscriptionId === accountASubscriptionId ? 'a' : 'b';
            },
            onNext: async (options) => {
                if (options.subscriptionId === accountASubscriptionId) {
                    return await new Promise<ReturnType<typeof invalidatedResponse>>((resolve) => {
                        resolveLateA = resolve;
                    });
                }
                return await new Promise((resolve) => {
                    options.signal.addEventListener('abort', () => {
                        resolve({ supported: false as const, reason: 'aborted' as const });
                    }, { once: true });
                });
            },
        });
        const accountA = await createAccountLifetime({ accountId: 'account-a' });
        let a: PluginUiResourceSnapshot | null = null;
        const b = { current: null as PluginUiResourceSnapshot | null };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe binding={binding(accountA.lifetime)} onSnapshot={(snapshot) => { a = snapshot; }} />
                </PluginContextualResourceStoreProvider>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(a?.digest).toBe(`sha256:${'a'.repeat(64)}`);
        });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });

        await act(async () => {
            accountA.retire();
            const accountB = await createAccountLifetime({ accountId: 'account-b' });
            tree?.update(<PluginContextualResourceStoreProvider>
                <ResourceProbe binding={binding(accountA.lifetime)} onSnapshot={(snapshot) => { a = snapshot; }} />
                <ResourceProbe binding={binding(accountB.lifetime)} onSnapshot={(snapshot) => { b.current = snapshot; }} />
            </PluginContextualResourceStoreProvider>);
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(a).toBeNull(); });
        await vi.waitFor(() => { expect(b.current?.digest).toBe(`sha256:${'b'.repeat(64)}`); });
        expect(machineResourceRpc.close).toHaveBeenCalledTimes(1);
        const readsBeforeLateA = machineResourceRpc.read.mock.calls.length;

        await act(async () => {
            resolveLateA!(invalidatedResponse(accountASubscriptionId!, 'c'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(a).toBeNull();
        expect(b.current?.digest).toBe(`sha256:${'b'.repeat(64)}`);
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(readsBeforeLateA);

        await act(async () => { tree?.unmount(); });
    });

    it('replaces an observed generation family before an old consumer releases its read and watch', async () => {
        const rpc = installLiveResourceRpc({
            read: (call) => call === 1 ? resourceResponse('a') : resourceResponse('b'),
            openMarker: (options) => options.expectedCallerOccurrenceId === '7' ? 'a' : 'b',
        });
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const generationSeven = binding(account.lifetime, '7');
        const generationEight = binding(account.lifetime, '8');
        let oldSnapshot: PluginUiResourceSnapshot | null = null;
        let newSnapshot: PluginUiResourceSnapshot | null = null;

        function App(props: Readonly<{ showNew: boolean }>) {
            return (
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe binding={generationSeven} onSnapshot={(snapshot) => { oldSnapshot = snapshot; }} />
                    {props.showNew ? <ResourceProbe binding={generationEight} onSnapshot={(snapshot) => { newSnapshot = snapshot; }} /> : null}
                </PluginContextualResourceStoreProvider>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<App showNew={false} />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(oldSnapshot?.digest).toBe(`sha256:${'a'.repeat(64)}`); });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });
        const oldWatchSignal = rpc.nextSignals[0]!;

        await act(async () => {
            tree?.update(<App showNew />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(newSnapshot?.digest).toBe(`sha256:${'b'.repeat(64)}`); });
        expect(oldWatchSignal.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(2);
        expect(machineResourceRpc.open).toHaveBeenCalledTimes(2);

        await act(async () => { tree?.unmount(); });
    });

    it('returns no lease for a retired captured Account', async () => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        account.retire();
        const ownerRef = { current: null as PluginContextualResourceStoreOwner | null };

        function OwnerProbe() {
            ownerRef.current = usePluginContextualResourceStoreOwner();
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <OwnerProbe />
                </PluginContextualResourceStoreProvider>,
            );
        });

        expect(ownerRef.current).not.toBeNull();
        if (ownerRef.current === null) throw new Error('expected contextual Resource store owner');
        expect(ownerRef.current.acquire(binding(account.lifetime))).toBeNull();
        expect(machineResourceRpc.read).not.toHaveBeenCalled();
        expect(machineResourceRpc.open).not.toHaveBeenCalled();
        expect(machineResourceRpc.next).not.toHaveBeenCalled();
        expect(machineResourceRpc.close).not.toHaveBeenCalled();

        await act(async () => { tree?.unmount(); });
    });

    it('aborts the real mounted read/watch client when its caller aborts', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const controller = new AbortController();
        let observed: PluginUiResourceSnapshot | null = null;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe
                        binding={binding(account.lifetime)}
                        signal={controller.signal}
                        onSnapshot={(snapshot) => { observed = snapshot; }}
                    />
                </PluginContextualResourceStoreProvider>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed?.value).toBeDefined(); });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });

        await act(async () => {
            controller.abort();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed).toBeNull(); });
        expect(rpc.nextSignals[0]?.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });

        await act(async () => { tree?.unmount(); });
    });

    it('withholds a snapshot and releases the real lease when caller currentness turns false', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        let current = true;
        let observed: PluginUiResourceSnapshot | null = null;

        function App() {
            return (
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe
                        binding={exactBinding}
                        isCurrent={() => current}
                        onSnapshot={(snapshot) => { observed = snapshot; }}
                    />
                </PluginContextualResourceStoreProvider>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed?.value).toBeDefined(); });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });

        current = false;
        await act(async () => {
            tree?.update(<App />);
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed).toBeNull(); });
        expect(rpc.nextSignals[0]?.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });

        await act(async () => { tree?.unmount(); });
    });
});
