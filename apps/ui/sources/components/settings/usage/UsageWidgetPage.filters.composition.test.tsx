import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol';
import { getStorage } from '@/sync/domains/state/storage';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema,
    WIDGET_SURFACE_ARTIFACT_KIND_V1, type WidgetAreaLayoutV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { WidgetAreaLayoutBar } from '@/components/widgets/area/WidgetAreaLayoutBar';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { UsageWidgetBody } from './widgets/UsageWidgetBody';
import { UsagePeriodSummaryWidget } from './widgets/UsagePeriodSummaryWidget';
import { UsageWidgetPage } from './UsageWidgetPage';
import { UsageFilterBar } from './UsageFilterBar';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { USAGE_WIDGET_PRESET_IDS } from './usageWidgetPresets';
import { t } from '@/text';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildUsageRouteParams, resolveUsagePageInitialFilters } from './usageRouteParams';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createClientActionReverseDispatcher } from '../../../../../cli/src/session/actions/clientActionReverseDispatch';
import { createActionToolExecutorBridge } from '../../../../../cli/src/agent/tools/happierTools/createActionToolExecutorBridge';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { ClientActionReverseRuntime } from '@/components/appShell/runtime/ClientActionReverseRuntime';
import { createMachineFixture, createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { Socket } from 'socket.io-client';
import { currentUiContextCommandClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';

const currentRoute = vi.hoisted(() => ({ segments: ['(app)', 'settings', 'usage'], params: {} as Record<string, string> }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/usage',
        segments: () => currentRoute.segments, params: () => currentRoute.params }).module;
});

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const totals: UsageAnalyticsQueryResponse['totals'] = { eventCount: 1,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } };
const accounting: UsageAnalyticsQueryResponse = { v: 1, totals, breakdowns: {
    machine: ['machine-a', 'machine-b', 'machine-c', ...Array.from({ length: 24 }, (_, index) => `machine-${index}`)].map(key => ({ key, ...totals })),
    source: ['native', 'runtime', 'legacy'].map(key => ({ key, ...totals })),
    project: ['project-a', 'project-b', 'project-c', ...Array.from({ length: 24 }, (_, index) => `project-${index}`)].map(key => ({ key, ...totals })),
}, engineTimeline: [{ bucketStartMs: 1000, bucketEndMs: 2000,
    leaders: ['claude:remote', 'codex:local', 'pi'].map(key => ({ key, ...totals })) }] };
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let reader: CurrentUiContextReader | null = null;
let unregister: (() => void) | undefined;
let socketBoundary: ReturnType<typeof installDisconnectedServerSocketBoundary> | undefined;

// Existing filter journeys keep all cards in their measured viewport; viewport admission has its own journey below.
const visibleContentGeometry = { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 1000, 300) };
const visibleScrollGeometry = { getInnerViewRef: () => visibleContentGeometry };
const visiblePageGeometry = {
    createNodeMock: (node: Readonly<{ props: Record<string, unknown> }>) =>
        node.props.testID === 'usage-page' ? visibleScrollGeometry : visibleContentGeometry,
};

async function renderMeasuredPage(element: React.ReactElement) {
    const screen = await renderScreen(element, visiblePageGeometry);
    await act(async () => screen.findByTestId('usage-page')!.props.onLayout?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 900 } },
    }));
    return screen;
}

function CurrentContextPort() {
    reader = useOptionalCurrentUiContextReader();
    React.useEffect(() => {
        if (!reader) return;
        const current = reader;
        unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            reader: current, invocationSurface: surface, hostAction, readProjection: () => null, readNavigationBinding: () => null,
        }));
        return unregister;
    }, [reader]);
    return null;
}

// Route feedback is a genuine input boundary: both entry routes echo their owned
// filter/view params while an asynchronous mounted command is still settling.
function RoutedUsagePage({ sessionId }: Readonly<{ sessionId?: string }>) {
    const [params, setParams] = React.useState<Record<string, string | undefined>>({ layoutId: 'overview', period: '7days' });
    const initialFilters = React.useMemo(() => resolveUsagePageInitialFilters(params), [params]);
    const onLayoutChange = React.useCallback((layoutId: string) => setParams(current => ({ ...current, layoutId })), []);
    const onFiltersChange = React.useCallback((filters: Parameters<typeof buildUsageRouteParams>[0]) => {
        const { layoutId: _layoutId, ...owned } = buildUsageRouteParams(filters);
        setParams(current => ({ ...current, ...owned }));
    }, []);
    return <UsageWidgetPage sessionId={sessionId} initialFilters={initialFilters}
        onFiltersChange={onFiltersChange} onLayoutChange={onLayoutChange} />;
}

afterEach(async () => {
    currentRoute.segments = ['(app)', 'settings', 'usage'];
    currentRoute.params = {};
    vi.restoreAllMocks();
    standardCleanup(); unregister?.(); unregister = undefined; reader = null;
    retireActiveServerAccountScopeLifetime(); invalidateUsageQueryResources(); await home?.dispose(); home = undefined;
    socketBoundary?.dispose(); socketBoundary = undefined;
});

describe('mounted Usage page scope commands', () => {
    it.each([
        { entry: 'settings', sessionId: undefined, readFails: false, pendingCommandRegistration: false },
        { entry: 'Session', sessionId: 'session-usage-parity', readFails: false, pendingCommandRegistration: false },
        { entry: 'Session with failed document read', sessionId: 'session-usage-parity', readFails: true, pendingCommandRegistration: false },
        { entry: 'Session with pending command registration', sessionId: 'session-usage-parity', readFails: false, pendingCommandRegistration: true },
    ])('publishes and executes view, range and scope commands from the mounted $entry Usage entry', async ({ sessionId, readFails, pendingCommandRegistration }) => {
        currentRoute.segments = sessionId ? ['(app)', 'session', '[id]', 'usage'] : ['(app)', 'settings', 'usage'];
        currentRoute.params = sessionId ? { id: sessionId } : {};
        const sockets: Socket[] = [];
        socketBoundary = installDisconnectedServerSocketBoundary(socket => {
            sockets.push(socket);
            configureConnectedServerSocketBoundary(socket);
        });
        const readGate = createDeferred<void>();
        let holdRead = false;
        let heldReads = 0;
        const machine = createMachineFixture({ id: 'usage-command-machine', activeAt: Date.now() });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-entry-parity.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse())
                : request.path === '/v1/machines' ? Response.json([createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine })])
                : request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? Response.json(accounting)
                : request.path.startsWith('/v1/artifacts/') && holdRead
                    ? (heldReads++, readGate.promise.then(() => readFails
                        ? Response.json({ error: 'database_transaction_timeout' }, { status: 503 }) : undefined))
                : createPlainMachineReadHttpResponseFixture(request.path, { method: request.method, body: JSON.stringify(request.body) }, 'account-a')
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const registered = new Set<string>();
        const register = vi.spyOn(apiSocket, 'registerMachineScopedRpcHandler');
        // Both routes admit this same page; the Session route supplies its hydrated Session id.
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><ClientActionReverseRuntime /><RoutedUsagePage sessionId={sessionId} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        await waitForHomeGovernance(() => expect(screen.findAllByType(WidgetSurface).length).toBeGreaterThan(0));
        await flushHookEffects({ cycles: 40 });
        const socket = sockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
        if (!socket) throw new Error('Mounted Usage has no reverse receiver');
        for (const [machineId, method] of register.mock.calls) registered.add(`${machineId}:${method}`);
        vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
            const payload: unknown = args[0];
            if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
                if (event === SOCKET_RPC_EVENTS.REGISTER) registered.add(payload.method);
                if (event === SOCKET_RPC_EVENTS.UNREGISTER) registered.delete(payload.method);
            }
            return socket;
        });
        // Connected-client RPC is the wire boundary; native MCP argument binding,
        // CLI reverse dispatch and the answering App's Action executor remain real.
        const caller = createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => ({
            hasConnectedClientRpcHandler: method => registered.has(`${machine.id}:${method}`),
            callConnectedClientRpc: async (method, payload, options) => {
                // reload112 seq55–60: this socket answers current-context reads while
                // the command-specific room is unavailable. Hold only that network
                // registration; the mounted publisher and reverse receiver stay real.
                if (pendingCommandRegistration && reader!.readCurrentUiContext()!.commands.some(command =>
                    method === currentUiContextCommandClientRpcMethod(command.id))) {
                    return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
                }
                if (!registered.has(`${machine.id}:${method}`)) return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
                options.onIssued();
                const result = await new Promise<unknown>(resolve => {
                    for (const receive of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) {
                        receive({ method: `${machine.id}:${method}`, params: JSON.parse(JSON.stringify(payload)) }, resolve);
                    }
                });
                return { ok: true, result };
            },
        })) });
        const bridge = createActionToolExecutorBridge({ surface: 'mcp', isActionEnabled: () => true,
            executor: { execute: async (actionId, input, context) => {
                const result = await caller.execute(actionId, input, context);
                return result.ok ? { ok: true, result: result.result ?? null } : result;
            } } });
        const invoke = async (title: string) => {
            const read = await bridge.executeActionByToolName('action_execute', { actionId: 'ui.current_context.read',
                input: { clientId: 'mounted-usage' } }, sessionId ?? 'native-session');
            expect(read).toMatchObject({ ok: true });
            if (!read.ok) throw new Error('Native current-context read failed');
            const command = CurrentUiContextSnapshotV1Schema.parse(read.result).commands.find(command => command.title === title);
            expect(command, `mounted command: ${title}`).toBeDefined();
            let pending!: ReturnType<typeof bridge.executeActionByToolName>;
            act(() => { pending = bridge.executeActionByToolName('action_execute', { actionId: 'ui.current_context.command.invoke',
                input: { clientId: 'mounted-usage', commandId: command!.id } }, sessionId ?? 'native-session'); });
            // Native dispatch does not hold a React act transaction open across
            // the read. Let the effect republish before checking its completion.
            await flushHookEffects({ cycles: 30 });
            if (holdRead) {
                try {
                    expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe('costs');
                    expect(heldReads).toBeGreaterThan(0);
                } finally { readGate.resolve(); }
            }
            const outcome = await pending;
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
            await flushHookEffects({ cycles: 30 });
        };
        const toolbar = () => screen.findByType(UsageFilterBar).props;
        const viewNames = screen.findByType(WidgetAreaLayoutBar).props.layouts.map((view: { name: string }) => view.name);
        expect(reader?.readCurrentUiContext()?.commands.map(command => command.title)).toEqual(expect.arrayContaining(viewNames));
        await invoke(t(getUsagePeriodDefinition('30days').translationKey));
        expect(toolbar().page.period).toBe('30days');
        expect(toolbar().page.scope.session).toBe(sessionId ?? null);
        const filters = toolbar().scopeFilters;
        expect(filters.map((filter: { field: string }) => filter.field)).toEqual(sessionId ? [] : ['sources', 'agents', 'machines', 'projects']);
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(expect.arrayContaining(
            filters.flatMap((filter: { title: string; options: readonly { label: string }[] }) => filter.options.map(option => `${filter.title}: ${option.label}`))));
        if (!sessionId) {
            const sourceFilter = filters.find((filter: { field: string }) => filter.field === 'sources');
            const source = sourceFilter.options.find((option: { id: string }) => option.id === 'native');
            await invoke(`${sourceFilter.title}: ${source.label}`);
            expect(toolbar().page.scope.sources).toEqual(['native']);
        }
        await invoke(t('usage.board.page.costBasisReported'));
        expect(toolbar().page.scope.costBasis).toBe('reported');
        holdRead = true;
        await invoke(t('usage.presets.costs'));
        await waitForHomeGovernance(() => expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe('costs'));
        expect(reader!.readCurrentUiContext()!.detail).toContain('costs');
    });

    it.each(['overview', 'work'])('admits the personalized %s once and selects from a closing menu across a page republish', async layoutId => {
        const selectedRoutes: string[] = [];
        const inventoryRead = createDeferred<void>();
        const inventoryStarted = createDeferred<void>();
        let artifact: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-page-layout-link.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? Response.json(accounting)
                : request.path === '/v1/artifacts' && request.method === 'GET'
                    ? (inventoryStarted.resolve(), inventoryRead.promise.then(() => artifact?.request(request.url, { method: request.method })))
                    : artifact?.request(request.url, { method: request.method }) });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const surface: WidgetSurfaceRefV1 = { serverId: server.id, accountId: 'account-a',
            owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId } };
        const query = normalizeUsageQuery({});
        const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [{ kind: 'widget', instance: {
            v: 1, id: 'work-only', definition: { kind: 'builtin', id: 'usage_period_summary' },
            bindings: Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).map(([path, value]) => [path, { kind: 'value', value }])),
        } }] });
        artifact = createLayoutArtifactHttpBoundary('account-a', { artifactId: buildWidgetSurfaceArtifactIdV1(surface),
            kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, defaultLayout: layout, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        artifact.seed(layout);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage initialFilters={{ layoutId, period: '7days', metric: 'cost', costMode: 'auto', focus: null }}
                    onLayoutChange={layoutId => selectedRoutes.push(layoutId)} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await inventoryStarted.promise;
        await flushHookEffects({ cycles: 10 });
        // The selected document is authoritative independently of the slow inventory.
        expect.soft(screen.findAllByType(WidgetSurface).map(node => node.props.instance.id)).toEqual(['work-only']);
        expect.soft(Boolean(screen.findHostByTestId('usage-area.unavailable'))).toBe(false);
        expect.soft(Boolean(screen.findHostByTestId('usage-area.loading'))).toBe(false);
        expect.soft(screen.findAllByType(WidgetAreaLayoutBar)).toHaveLength(0);
        inventoryRead.resolve();
        await vi.waitFor(() => expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe(layoutId));
        const views = screen.findByType(WidgetAreaLayoutBar).props.layouts;
        expect(views.map((view: { id: string }) => view.id).sort()).toEqual([...USAGE_WIDGET_PRESET_IDS].sort());
        expect(views.every((view: { name: string }) => typeof view.name === 'string' && view.name.length > 0)).toBe(true);
        expect(views.filter((view: { id: string }) => view.id === layoutId)).toEqual([
            expect.objectContaining({ isPreset: true, edited: true }),
        ]);
        expect(screen.findAllByType(WidgetSurface).map(node => node.props.instance.id)).toEqual(['work-only']);
        await act(async () => {
            screen.findHostByTestId('usage-views')!.props.onLayout({ nativeEvent: { layout: { width: 300, height: 40 } } });
            screen.findByTestId('usage-views.tabs:viewport')!.props.onLayout({ nativeEvent: { layout: { width: 200, height: 40 } } });
            screen.findByTestId('usage-views.tabs:strip')!.props.onLayout({ nativeEvent: { layout: { width: 520, height: 40 } } });
        });
        await screen.pressByTestIdAsync('usage-views.current');
        const menu = screen.findAllByType(DropdownMenu).find(node => node.props.items.some((item: { id: string }) => item.id === 'overview'))!;
        const queuedSelection = menu.props.onSelect;
        // DropdownMenu closes before its deferred selection callback. The page can
        // republish in between (for example, after the mounted route binding updates).
        await act(async () => { menu.props.onOpenChange(false); });
        await screen.update(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage initialFilters={{ layoutId, period: '7days', metric: 'cost', costMode: 'auto', focus: null }}
                    onLayoutChange={layoutId => selectedRoutes.push(layoutId)} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const nextLayoutId = layoutId === 'overview' ? 'costs' : 'overview';
        await act(async () => { queuedSelection(nextLayoutId); });
        await vi.waitFor(() => expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe(nextLayoutId));
        expect(selectedRoutes).toEqual([nextLayoutId]);
        // The page's filter bar names the scope its widgets follow; no frame repeats "This page".
        await vi.waitFor(() => expect(screen.findAllByType(WidgetSurface).length).toBeGreaterThan(1));
        expect(screen.findByType(UsageFilterBar).props.metric).toBe('cost');
        expect(screen.getTextContent()).not.toContain(t('widgetAdd.thisPage'));
        await screen.unmount();
    });
    it('retains a large toolbar inventory, toggles dimensions through UI and agent commands and refuses retired descriptors', async () => {
        let artifact: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-page-filters.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? (() => {
                    const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
                    const select = <T extends { key: string }>(rows: readonly T[], selected: readonly string[], engine = false) =>
                        selected.length ? rows.filter(row => selected.includes(engine ? row.key.split(':')[0]! : row.key)) : rows;
                    return Response.json({ ...accounting, breakdowns: {
                        machine: select(accounting.breakdowns!.machine!, query.filters?.machineIds ?? []),
                        source: select(accounting.breakdowns!.source!, query.filters?.sources ?? []),
                        project: select(accounting.breakdowns!.project!, query.filters?.projectKeys ?? []),
                    }, engineTimeline: accounting.engineTimeline!.map(bucket => ({ ...bucket, leaders: select(bucket.leaders, query.filters?.agentIds ?? [], true) })) });
                })()
                : artifact?.request(request.url, { method: request.method }) });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const surface: WidgetSurfaceRefV1 = { serverId: server.id, accountId: 'account-a',
            owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
        const followed = Object.fromEntries(['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis']
            .map(slot => [slot, { kind: 'context' as const, slot }]));
        const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [
            { kind: 'group', id: 'following', children: [{ kind: 'widget', instance: { v: 1, id: 'following-body',
                definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: { ...followed,
                    metric: { kind: 'value', value: 'tokens' }, breakdown: { kind: 'value', value: ['agent'] } } } }] },
            { kind: 'group', id: 'pinned', context: { period: { kind: 'value', value: { startMs: 1000, endMs: 2000 } } }, children: [{ kind: 'widget', instance: { v: 1, id: 'pinned-body',
                definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: { ...followed,
                    metric: { kind: 'value', value: 'cost' }, breakdown: { kind: 'value', value: ['model'] } } } }] },
        ] });
        artifact = createLayoutArtifactHttpBoundary('account-a', { artifactId: buildWidgetSurfaceArtifactIdV1(surface),
            kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, defaultLayout: layout, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        artifact.seed(layout);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await flushHookEffects({ cycles: 40 });
        const published = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'ui' } });
        expect(published).toMatchObject({ ok: true, result: { entity: { kind: 'usage_summary' } } });
        const invoke = async (title: string) => {
            const descriptor = reader?.readCurrentUiContext()?.commands.find(command => command.title === title);
            expect(descriptor, `mounted command: ${title}`).toBeDefined();
            await act(async () => {
                const result = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
                    input: { commandId: descriptor!.id }, context: { surface: 'ui' } });
                expect(result.ok).toBe(true);
            });
            await flushHookEffects({ cycles: 30 });
            return descriptor!.id;
        };
        const chip = (field: string) => screen.findAllByType(SelectionListFilterChip)
            .find(node => node.props.filter.id === field)!.props.filter;
        const choice = (field: string, value: string) => chip(field).options.find((option: { id: string }) => option.id === value)!.label;
        const snapshot = reader!.readCurrentUiContext()!;
        const toolbarTitles = ['agents', 'machines', 'projects', 'sources'].flatMap(field =>
            chip(field).options.map((option: { label: string }) => `${chip(field).label}: ${option.label}`));
        expect(snapshot.commands.map(command => command.title)).toEqual(expect.arrayContaining(toolbarTitles));
        expect(snapshot.commands.length).toBeGreaterThan(32);
        expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeGreaterThan(8_192);
        await invoke(`${chip('machines').label}: ${choice('machines', 'machine-23')}`);
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).machines.includes('machine-23'))).toBe(true);
        await act(async () => { await chip('machines').onChange('machine-23'); });
        await flushHookEffects({ cycles: 30 });
        await act(async () => { await chip('projects').onChange('project-23'); });
        await flushHookEffects({ cycles: 30 });
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).projects.includes('project-23'))).toBe(true);
        await invoke(`${chip('projects').label}: ${choice('projects', 'project-23')}`);
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).projects.length === 0)).toBe(true);
        // UI scope intents must obey the same Action admission as agent commands.
        const settings = getStorage().getState().settings;
        const scope = { serverId: server.id, accountId: 'account-a' };
        const previousInputs = screen.findAllByType(UsageWidgetBody).map(node => normalizeUsageQuery(node.props.input));
        const viewBar = screen.findByType(WidgetAreaLayoutBar);
        const previousLayout = viewBar.props.selectedId;
        await act(async () => {
            getStorage().getState().applySettingsForScope(scope, { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: { 'ui.current_context.command.invoke': { disabledSurfaces: ['ui'] } },
            }) }, 2);
            await chip('agents').onChange('claude');
            chip('costBasis').onChange('reported');
            screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === 'usage-filters.period')!
                .props.onSelectTab('30days');
            viewBar.props.onSelect(viewBar.props.layouts.find((layout: { id: string }) => layout.id !== previousLayout)!.id);
        });
        await flushHookEffects({ cycles: 20 });
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).agents.length === 0)).toBe(true);
        expect(screen.findAllByType(UsageWidgetBody).map(node => normalizeUsageQuery(node.props.input))).toEqual(previousInputs);
        expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe(previousLayout);
        await act(async () => { getStorage().getState().applySettingsForScope(scope, settings, 3); });
        await flushHookEffects({ cycles: 10 });
        // Losing the mounted dispatcher must not fall back to a raw page setter.
        unregister?.();
        await act(async () => { await chip('agents').onChange('claude'); });
        await flushHookEffects({ cycles: 10 });
        expect(screen.findAllByType(UsageWidgetBody).every(node => normalizeUsageQuery(node.props.input).agents.length === 0)).toBe(true);
        const currentReader = reader!;
        unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            reader: currentReader, invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null,
        }));
        const oldId = await invoke(`${chip('agents').label}: ${choice('agents', 'codex')}`);
        expect(chip('agents').options.map((option: { id: string }) => option.id)).toEqual(expect.arrayContaining(['claude', 'codex', 'pi']));
        await act(async () => { await chip('agents').onChange('claude'); });
        await flushHookEffects({ cycles: 30 });
        await invoke(`${chip('machines').label}: ${choice('machines', 'machine-a')}`);
        await invoke(`${chip('sources').label}: ${choice('sources', 'native')}`);
        await invoke(`${chip('projects').label}: ${choice('projects', 'project-a')}`);
        const bodies = () => screen.findAllByType(UsageWidgetBody).map(node => normalizeUsageQuery(node.props.input));
        // Published Actions use the page's semantic cost-basis label, not a raw
        // translation-key interpolation (API-equivalent has no usage.<id> key).
        await invoke(choice('costBasis', 'reported'));
        expect(bodies().every(input => input.costBasis === 'reported')).toBe(true);
        expect(bodies()).toHaveLength(2);
        for (const input of bodies()) expect(input).toMatchObject({ agents: ['claude', 'codex'], machines: ['machine-a'],
            sources: ['native'], projects: ['project-a'] });
        expect(bodies()).toEqual(expect.arrayContaining([
            expect.objectContaining({ period: { startMs: 1000, endMs: 2000 }, metric: 'cost', breakdown: [] }),
            expect.objectContaining({ metric: 'tokens', breakdown: [] }),
        ]));
        const shownQueries = () => screen.findAllByType(UsagePeriodSummaryWidget).map(node => normalizeUsageQuery(node.props.query));
        expect(shownQueries()).toHaveLength(2);
        for (const query of shownQueries()) expect(query).toMatchObject({ agents: ['claude', 'codex'], machines: ['machine-a'],
            sources: ['native'], projects: ['project-a'] });
        const previousFollowingPeriod = shownQueries().find(query => query.metric === 'tokens')!.period;
        await invoke(t(getUsagePeriodDefinition('30days').translationKey));
        expect(shownQueries().find(query => query.metric === 'tokens')!.period).not.toEqual(previousFollowingPeriod);
        expect(shownQueries().find(query => query.metric === 'cost')).toMatchObject({
            period: { startMs: 1000, endMs: 2000 }, metric: 'cost', breakdown: [],
        });
        const allAgents = chip('agents').options[0].label;
        await invoke(`${chip('agents').label}: ${allAgents}`);
        expect(bodies().every(input => input.agents.length === 0)).toBe(true);
        expect(bodies().every(input => input.machines[0] === 'machine-a')).toBe(true);
        await invoke(`${chip('agents').label}: ${choice('agents', 'pi')}`);
        await invoke(`${chip('agents').label}: ${choice('agents', 'pi')}`);
        expect(bodies().every(input => input.agents.length === 0)).toBe(true);
        const stale = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: oldId }, context: { surface: 'ui' } });
        expect(stale).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        expect(bodies().every(input => input.agents.length === 0)).toBe(true);
        const currentId = reader!.readCurrentUiContext()!.commands[0]!.id;
        await act(async () => retireActiveServerAccountScopeLifetime());
        const retired = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: currentId }, context: { surface: 'ui' } });
        expect(retired.ok).toBe(false);
    });
});
