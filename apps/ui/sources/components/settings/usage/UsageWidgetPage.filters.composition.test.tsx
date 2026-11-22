import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { aggregateUsageContributionCosts } from '@happier-dev/protocol/usage/usageAggregation';
import { projectUsageContributionTotals } from '@happier-dev/protocol/usage/usageActivityProjectionFacts';
import { getStorage } from '@/sync/domains/state/storage';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getUsageQueryBatchKey, getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { ProviderAccountUsagePageProjectionWriteV1Schema, QualifiedProviderAccountUsageHistoryRequestV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, readBuiltinWidgetDescriptorV1, WidgetAreaLayoutV1Schema,
    WIDGET_SURFACE_ARTIFACT_KIND_V1, type WidgetAreaLayoutV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { createServedHomeAccountToken, serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { planSyncActionsFromChanges, plannedChangesAffectUsageAccounting, plannedChangesAffectUsageQuery } from '@/sync/runtime/orchestration/changesPlanner';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import * as usageResources from '@/sync/api/account/usageQueryResource';
import * as homeChanges from '@/sync/runtime/orchestration/homeAccountChange';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { Text } from '@/components/ui/text/Text';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { WidgetAreaLayoutBar } from '@/components/widgets/area/WidgetAreaLayoutBar';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { usageSourceTitle } from '@/sync/domains/usage/usageLabels';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { UsagePeriodSummaryWidget } from './widgets/UsagePeriodSummaryWidget';
import { UsageCoachWidget } from './widgets/UsageCoachWidget';
import { UsageWidgetPage } from './UsageWidgetPage';
import { buildUsageRouteParams, resolveUsagePageInitialFilters } from './usageRouteParams';
import { describeUsageWidgetSlotValue, type UsageWidgetPageScope } from './usageWidgetPageContext';
import { USAGE_SESSION_WIDGET_PRESET_ID, USAGE_WIDGET_PRESET_IDS } from './usageWidgetPresets';
import * as usageAnalytics from '@/sync/api/account/usageAnalytics';
import * as usageWidgetResource from './useUsageWidgetResource';
import { UsageCostFactsWidget } from './widgets/UsageCostFactsWidget';
import { UsageRhythmWidget } from './widgets/UsageRhythmWidget';
import { UsageFilterBar } from './UsageFilterBar';
import { UsageProjectLedgerWidget } from './widgets/UsageProjectLedgerWidget';
import { HappierDataRows } from '@happier-dev/plugin-ui/presentation';
import * as pluginResource from '@happier-dev/plugin-ui/advanced';
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createClientActionReverseDispatcher } from '../../../../../cli/src/session/actions/clientActionReverseDispatch';
import { createActionToolExecutorBridge } from '../../../../../cli/src/agent/tools/happierTools/createActionToolExecutorBridge';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, getUsageSessionEvidenceDemandKey } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { ClientActionReverseRuntime } from '@/components/appShell/runtime/ClientActionReverseRuntime';
import { createMachineFixture, createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { Socket } from 'socket.io-client';
import { currentUiContextCommandClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';

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
    // These journeys choose named Projects; R140 folds nameless anchors into one option.
    project: ['project-a', 'project-b', 'project-c', ...Array.from({ length: 24 }, (_, index) => `project-${index}`)]
        .map(key => ({ key, label: `Project ${key}`, ...totals })),
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


/** The page scope one filter shows: its chip's selection, which the bar reads from the mounted page context. */
function shownScope(filters: React.ComponentProps<typeof UsageFilterBar>['scopeFilters'], field: string): readonly string[] {
    return filters.find((filter) => filter.field === field)?.selected ?? [];
}

describe('mounted Usage page scope commands', () => {
    it('keeps Overview entries, projections and subscriptions bounded across twenty settled period and filter switches', async () => {
        const { Session: InspectorSession } = await import('node:inspector');
        const { createPlainSessionWithDisplayRecordFixture } = await import('@/dev/testkit/fixtures/sessionDisplayFixtures');
        const { SessionSystemRecordStoredUpsertRequestSchema } = await import('@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes');
        vi.spyOn(Date, 'now').mockReturnValue(1_791_749_300_000);
        const fixture = usageQaAccountingFixture();
        let observationRevision = 0;
        const fixtureSessionIds = [...new Set(fixture.contributions!.flatMap(row => row.sessionId ? [row.sessionId] : []))];
        const fixtureMachineIds = [...new Set(fixture.contributions!.flatMap(row => row.machineId ? [row.machineId] : []))];
        const machines = Array.from({ length: 62 }, (_, index) => createMachineFixture({
            id: fixtureMachineIds[index] ?? `retention-machine-${index}`, activeAt: Date.now(),
        }));
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-overview-retention.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v1/machines') return Response.json(machines.map(machine =>
                    createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine })));
                if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) {
                    const { address, content } = SessionSystemRecordStoredUpsertRequestSchema.parse(request.body);
                    return Response.json({ record: { address, content, id: 'sysrec_1', revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
                        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } });
                }
                if (request.path === '/v2/usage/query') return Response.json({ ...fixture,
                    // A corrected observation timestamp changes the facts without
                    // changing the captured cohort's dimensions, totals or buckets.
                    contributions: fixture.contributions!.map((row, index) => index === 0
                        ? { ...row, observedAtMs: row.observedAtMs + observationRevision } : row),
                });
                if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
                    const input = UsageSessionEvidenceRequestSchema.parse(request.body);
                    const requests = input.requests.map(demand => ({ query: demand.query,
                        sessionIds: demand.sessionIds ?? fixtureSessionIds }));
                    return Response.json({ requests, results: [...new Set(requests.flatMap(demand => demand.sessionIds))].map(id => ({
                        sessionId: id,
                        detail: { status: 200, body: { session: createPlainSessionWithDisplayRecordFixture({ id, seq: 1 }) } },
                        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: Date.now(), turns: [] } },
                        messageEvidence: { acceptedInputs: [] }, messagesComplete: true,
                    })) });
                }
                return artifacts.handle(request.url.toString(), { method: request.method })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const entries: WeakRef<object>[] = [];
        const projections: WeakRef<object>[] = [];
        const results: WeakRef<object>[] = [];
        const accountingGenerations: WeakRef<object>[] = [];
        const subscriptions: WeakRef<object>[] = [];
        const resourceKeys = new Set<string>();
        const seen = new WeakSet<object>();
        const observe = (values: WeakRef<object>[], value: object) => {
            if (!seen.has(value)) { seen.add(value); values.push(new WeakRef(value)); }
        };
        // Observation only: execute every real owner and retain only weak handles.
        // Clear spy histories before GC; they otherwise retain arguments/results themselves.
        const getStore = usageResources.getUsageQueryResourceStore;
        const resourceObservation = vi.spyOn(usageResources, 'getUsageQueryResourceStore').mockImplementation((...args) => {
            const store = getStore(...args);
            return { ...store, getEntry(...entryArgs) {
                const reference = entryArgs[0];
                const isUsageQuery = typeof reference !== 'string' && 'hostRead' in reference && reference.hostRead === 'usage.query';
                if (isUsageQuery)
                    resourceKeys.add(getUsageQueryBatchKey(reference.input));
                const entry = store.getEntry(...entryArgs);
                observe(entries, entry);
                return { ...entry, getSnapshot() {
                    const snapshot = entry.getSnapshot();
                    if (isUsageQuery && snapshot.value) {
                        observe(results, snapshot.value);
                        for (const slice of usageResources.decodeUsageQueryResource(snapshot.value).results)
                            if (slice.accounting) observe(accountingGenerations, slice.accounting);
                    }
                    return snapshot;
                } };
            } };
        });
        const buildView = usageAnalytics.buildUsageAnalyticsViewModel;
        const projectionObservation = vi.spyOn(usageAnalytics, 'buildUsageAnalyticsViewModel').mockImplementation((...args) => {
            const view = buildView(...args);
            observe(projections, view);
            return view;
        });
        const subscribe = homeChanges.subscribeHomeAccountChange;
        const subscriptionObservation = vi.spyOn(homeChanges, 'subscribeHomeAccountChange').mockImplementation((...args) => {
            observe(subscriptions, args[0]);
            return subscribe(...args);
        });
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><RoutedUsagePage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const summary = () => screen.findAllByType(UsagePeriodSummaryWidget)[0]?.props.slice;
        const settle = async (period: string) => {
            try {
                await waitForHomeGovernance(() => {
                    expect(summary()?.requestedQuery.period.relative).toBe(period);
                    expect(summary()?.shownQuery?.period.relative).toBe(period);
                    expect(summary()?.requestedQuery.machines).toEqual(shownScope(screen.findByType(UsageFilterBar).props.scopeFilters, 'machines'));
                    expect(summary()?.shownQuery?.machines).toEqual(summary()?.requestedQuery.machines);
                    expect(summary()?.pending).toBe(false);
                    expect(summary()?.accounting).toBeDefined();
                });
            } catch (error) {
                console.info('USAGE-OVERVIEW-UNSETTLED', JSON.stringify({ wantedPeriod: period,
                    period: summary()?.requestedQuery.period.relative, machineFilters: summary()?.requestedQuery.machines.length,
                    pending: summary()?.pending, accounting: !!summary()?.accounting,
                    sources: summary()?.sources.map((state: { source: string; status: string }) => ({
                        sourceKind: state.source.split(':')[0], status: state.status })),
                    accountingReads: home!.httpRequests.filter(request => request.path === '/v2/usage/query').length,
                    evidenceReads: home!.httpRequests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH).length }));
                throw error;
            }
            await flushHookEffects({ cycles: 20 });
            return getUsageQueryKey(summary()!.requestedQuery);
        };
        const inspector = new InspectorSession();
        inspector.connect();
        const counts: Array<{ switch: number; resourceKeys: number; entries: number; results: number; accounting: number; projections: number; subscriptions: number }> = [];
        try {
            let requestId = await settle('7days');
            for (let index = 1; index <= 20; index++) {
                const period = index % 2 ? '30days' : '7days';
                await act(async () => { await screen.findByType(UsageFilterBar).props.onPeriodChange(period); });
                // The mounted chooser toggles an actual fixture Machine every second
                // visit, exercising four warmed period/scope combinations.
                if (index % 2 === 0) {
                    const filter = screen.findByType(UsageFilterBar).props.scopeFilters
                        .find((filter: { field: string }) => filter.field === 'machines');
                    await act(async () => { await filter.select(fixtureMachineIds[0]!); });
                }
                const settledRequest = await settle(period);
                console.info('USAGE-OVERVIEW-SETTLED', index);
                expect(settledRequest, 'a completed control invocation must settle its replacement query').not.toBe(requestId);
                requestId = settledRequest;
                const prior = new WeakRef(summary()!.accounting);
                // Replacing facts prevents a cached revisit from hiding a retired
                // result/projection lifetime. Refresh goes through the widget's owner.
                observationRevision++;
                await act(async () => { await screen.findAllByType(UsagePeriodSummaryWidget)[0]!.props.model.refresh(); });
                await settle(period);
                expect(summary()!.accounting).not.toBe(prior.deref());
                if (index % 5 !== 0) continue;
                resourceObservation.mockClear(); projectionObservation.mockClear(); subscriptionObservation.mockClear();
                await new Promise<void>(resolve => setImmediate(resolve));
                await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
                counts.push({ switch: index, resourceKeys: resourceKeys.size, entries: entries.filter(value => value.deref() !== undefined).length,
                    results: results.filter(value => value.deref() !== undefined).length,
                    accounting: accountingGenerations.filter(value => value.deref() !== undefined).length,
                    projections: projections.filter(value => value.deref() !== undefined).length,
                    subscriptions: subscriptions.filter(value => value.deref() !== undefined).length });
            }
            console.info('USAGE-OVERVIEW-RETENTION', JSON.stringify({ machines: machines.length, contributions: fixture.contributions?.length,
                events: fixture.totals.eventCount, counts }));
            const warmed = counts[1]!;
            for (const current of counts.slice(2)) {
                expect(current.resourceKeys, 'the repeated Overview workload must reuse its warmed query entries').toBe(warmed.resourceKeys);
                expect(current.entries, 'retired Overview Resource facades must not accumulate').toBeLessThanOrEqual(warmed.entries);
                expect(current.results, 'superseded Overview Resource results must not accumulate').toBeLessThanOrEqual(warmed.results);
                expect(current.accounting, 'superseded Overview accounting generations must not accumulate').toBeLessThanOrEqual(warmed.accounting);
                expect(current.projections, 'superseded Overview analytics projections must not accumulate').toBeLessThanOrEqual(warmed.projections);
                expect(current.subscriptions, 'retired Overview source subscriptions must not accumulate').toBeLessThanOrEqual(warmed.subscriptions);
            }
        } finally {
            inspector.disconnect();
            resourceObservation.mockRestore(); projectionObservation.mockRestore(); subscriptionObservation.mockRestore();
            await screen.unmount();
        }
    // Twenty mounted reads with the captured cohort exceed the suite's
    // single-journey 60s deadline (the initial run completed four switches).
    }, 300_000);

    it.each(['agents', 'named', 'unnamed', 'unnamed-omitted', 'unnamed-ranked'] as const)('selects Agents and folded Projects after route feedback and updates the Work ledger (%s)', async selection => {
        const fixture = usageQaAccountingFixture();
        const unnamed = ['a'.repeat(64), 'b'.repeat(64)];
        // A ranked response is not a name registry: keep its one named anchor visible.
        const projects = ['named-project', ...unnamed, ...(selection === 'unnamed-ranked' ? [] : ['other-project']), null];
        const unfilteredProjectCount = selection === 'unnamed-ranked' ? 2 : 3;
        const contributions = projects.map((projectKey, index) => ({ ...fixture.contributions![0]!,
            id: `selection-${index}`, projectKey, agentId: index === 3 ? 'codex' : 'claude',
            // Keep the named bucket above the truncated chart's token frontier.
            ...(selection === 'unnamed-ranked' ? { tokens: { input: index === 0 ? 100 : 10,
                output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: index === 0 ? 100 : 10 },
                tokenCategories: undefined } : {}),
            observedAtMs: Date.now(), sessionId: null, turnId: null }));
        const totalsFor = (rows: typeof contributions) => projectUsageContributionTotals(rows, aggregateUsageContributionCosts(rows, 'auto'));
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-route-filter-selection.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') {
                    const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
                    // The HTTP contract indexes absent Project keys as "unknown" (usageQueryFilters).
                    const rows = contributions.filter(row => (!query.filters?.projectKeys?.length || query.filters.projectKeys.includes(row.projectKey ?? 'unknown'))
                        && (!query.filters?.agentIds?.length || query.filters.agentIds.includes(row.agentId)));
                    return Response.json({ v: 1, totals: totalsFor(rows), contributions: rows,
                        scopeKeys: [{ dimension: 'project', keys: [...new Set(rows.map(row => row.projectKey ?? 'unknown'))] }], breakdowns: {
                        agent: [...new Set(rows.map(row => row.agentId))].map(key => ({ key, ...totalsFor(rows.filter(row => row.agentId === key)) })),
                        // The ranked chart omits an unnamed key and the absent-Project bucket.
                        project: [...new Set(rows.map(row => row.projectKey))].flatMap(projectKey =>
                            projectKey === null && selection === 'unnamed-omitted'
                                || selection === 'unnamed-ranked' && (projectKey === unnamed[1] || projectKey === null) ? [] : [{ key: projectKey ?? 'unknown', ...totalsFor(rows.filter(row => row.projectKey === projectKey)),
                                ...(projectKey === null ? { label: 'Unknown project' } : !unnamed.includes(projectKey)
                                    ? { label: projectKey === 'named-project' ? 'Named project' : 'Other project' } : {}) }]),
                    }, engineTimeline: [{ bucketStartMs: 1000, bucketEndMs: 2000,
                        leaders: [...new Set(rows.map(row => row.agentId))].map(key => ({ key, ...totalsFor(rows.filter(row => row.agentId === key)) })) }] });
                }
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        function Page() {
            const [params, setParams] = React.useState<Record<string, string | undefined>>({ layoutId: 'work', period: '7days' });
            const initialFilters = React.useMemo(() => resolveUsagePageInitialFilters(params), [params]);
            const onFiltersChange = React.useCallback((filters: Parameters<typeof buildUsageRouteParams>[0]) => {
                const { layoutId: _layoutId, ...owned } = buildUsageRouteParams(filters);
                setParams(current => ({ ...current, ...owned }));
            }, []);
            return <UsageWidgetPage initialFilters={initialFilters} onFiltersChange={onFiltersChange} />;
        }
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><Page />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const chip = (field: string) => screen.findAllByType(SelectionListFilterChip).find(node => node.props.filter.id === field)!.props.filter;
        const ledger = () => screen.findByType(UsageProjectLedgerWidget).findAllByType(HappierDataRows)[0]!.props.rows;
        await waitForHomeGovernance(() => expect(ledger()).toHaveLength(unfilteredProjectCount));
        // A period selection echoes through the real route/state owner before any scope selection.
        await act(async () => { await screen.findByType(UsageFilterBar).props.onPeriodChange('30days'); });
        await flushHookEffects({ cycles: 40 });
        await waitForHomeGovernance(() => expect(chip('agents').options.some((row: { id: string }) => row.id === 'claude')).toBe(true));
        const unnamedRow = ledger().find((row: readonly unknown[]) => row[0] === t('usage.board.work.unknownProject'));
        expect(unnamedRow).toBeDefined();
        for (const [field, label, count, keys] of [
            ['agents', 'Claude', 2, ['claude']],
            ['projects', 'Named project', 1, ['named-project']],
            ['projects', t('usage.board.work.unknownProject'), 1, [...unnamed, 'unknown']],
        ] as const) {
            if ((field === 'agents' ? 'agents' : label === t('usage.board.work.unknownProject') ? 'unnamed' : 'named') !== selection.replace(/-(omitted|ranked)$/, '')) continue;
            const option = chip(field).options.find((row: { id: string; label: string }) => field === 'agents' ? row.id === 'claude' : row.label === label)!;
            expect(option, JSON.stringify(chip(field).options.map(({ id, label }: { id: string; label: string }) => ({ id, label })))).toBeDefined();
            await screen.pressByTestIdAsync(chip(field).testID);
            await flushHookEffects({ cycles: 10 });
            expect(reader!.readCurrentUiContext()!.commands.some(command => command.title === `${chip(field).label}: ${option.label}`),
                'The foreground menu withholds the page descriptor').toBe(false);
            if (selection === 'agents') {
                const scope = { serverId: server.id, accountId: 'account-a' };
                const settings = getStorage().getState().settings;
                await act(async () => getStorage().getState().applySettingsForScope(scope, { ...settings,
                    actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                        actions: { 'ui.current_context.command.invoke': { disabledSurfaces: ['ui'] } } }),
                }, 2));
                await screen.pressByTestIdAsync(`${chip(field).testID}:${option.id}`);
                await flushHookEffects({ cycles: 10 });
                expect(chip(field).active, 'The menu still requires ordinary Action admission').toBe(false);
                expect(ledger()).toHaveLength(3);
                await act(async () => getStorage().getState().applySettingsForScope(scope, settings, 3));
            }
            await screen.pressByTestIdAsync(`${chip(field).testID}:${option.id}`);
            await flushHookEffects({ cycles: 40 });
            expect(chip(field).valueLabel).toBe(option.label);
            expect(chip(field).selectedIds.has(option.id)).toBe(true);
            await waitForHomeGovernance(() => expect(ledger()).toHaveLength(count));
            if (selection.startsWith('unnamed')) expect(ledger()[0], 'Selecting the folded group preserves its entire unfiltered row total').toEqual(unnamedRow);
            // The page scope carries the exact keys (a folded Project group expands to every key in it); the widgets read it.
            expect(screen.findByType(UsageProjectLedgerWidget).props.query[field]).toEqual([...keys]);
            const all = chip(field).options[0]!;
            await screen.pressByTestIdAsync(`${chip(field).testID}:${all.id}`);
            await screen.pressByTestIdAsync(chip(field).testID);
            await flushHookEffects({ cycles: 40 });
            await waitForHomeGovernance(() => expect(ledger()).toHaveLength(unfilteredProjectCount));
        }
    });
    it('I-B5 renders the same Project titles as the Usage Action for the same accounting and checkout facts', async () => {
        const { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
        const { createProjectAccountRowCipherV1 } = await import('@happier-dev/protocol/projects/projectAccountRowCipherV1');
        const { WorkspaceRefV1Schema } = await import('@happier-dev/protocol/workspaces/workspaceRefV1');
        const dev = '3ca2700f-c0a8-440f-be06-cb4f3f51cb01';
        const build = 'eadc2422-b42b-478d-97b1-af9b530d5f08';
        const machines = [[dev, 'Dev'], [build, 'Build']].map(([id, displayName]) => {
            const machine = createMachineFixture({ id });
            return createPlainMachineRowFixture({ id, accountId: 'account-a', machine: {
                ...machine, metadata: machine.metadata && { ...machine.metadata, displayName },
            } });
        });
        const unnamed = 'unknown';
        const projectKeys = ['tmp-dev', 'tmp-build-dev', 'tmp-build-other', 'app', unnamed];
        const value: UsageAnalyticsQueryResponse = { v: 1, totals,
            scopeKeys: [{ dimension: 'project', keys: projectKeys, projectMachines: [
                { key: projectKeys[0]!, machineIds: [dev] }, { key: projectKeys[1]!, machineIds: [build] },
                { key: projectKeys[2]!, machineIds: [build] }, { key: projectKeys[3]!, machineIds: [dev] },
            ] }], breakdowns: { project: projectKeys.map((key, index) => ({ key, ...totals,
                label: index < 3 ? 'tmp' : key === 'app' ? 'App' : 'Unknown project',
            })) } };
        const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: length => new Uint8Array(length) });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-project-titles.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v1/machines') return Response.json(machines);
                if (request.path === '/v2/usage/query') return Response.json(value);
                if (request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
                    const serverId = home!.homes.a!.id;
                    const rows = [[projectKeys[1], build, '/work/Dev/tmp'], [projectKeys[2], build, '/work/Other/tmp'], ['app', dev, '/work/repo']]
                        .map(([projectKey, machineId, rootPath]) => {
                            const ref = WorkspaceRefV1Schema.parse({ id: `checkout-${projectKey}`, projectKey, serverId, machineId, rootPath, createdAtMs: 1 });
                            const key = { kind: 'workspace-ref' as const, serverId, id: ref.id };
                            return { key, revision: 1, content: cipher.seal({ key, value: ref }) };
                        });
                    return Response.json({ status: 'listed', coverage: 'complete', rows });
                }
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><RoutedUsagePage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const chip = () => screen.findAllByType(SelectionListFilterChip).map(node => node.props.filter).find(filter => filter.id === 'projects')!;
        await waitForHomeGovernance(() => {
            expect(chip().options).toHaveLength(projectKeys.length + 1);
            expect(getStorage().getState().projectAccountRows?.workspaceRefs).toHaveLength(3);
            expect(getStorage().getState().machines[dev]?.metadata?.displayName).toBe('Dev');
        });
        await screen.pressByTestIdAsync(chip().testID);
        await flushHookEffects({ cycles: 10 });
        const pageTitles = chip().options.slice(1).map((option: { id: string }) => {
            const row = screen.findHostByTestId(`${chip().testID}:${option.id}`)!;
            return React.Children.toArray(row.findAllByType(Text)[0]!.props.children).join('');
        });
        const action = await createDefaultActionExecutor().execute('action.options.resolve',
            { actionId: 'usage.query', optionsSourceId: 'usage.filters.projects' },
            { surface: 'agent', authority: 'account_automation', serverId: server.id });
        expect(action.ok).toBe(true);
        if (!action.ok) throw new Error(action.error);
        const choices = (action.result as { options: { value: string; label: string }[] }).options;
        expect.soft(pageTitles).toEqual(['tmp · Dev', 'tmp · /work/Dev/tmp', 'tmp · Other', 'App', t('usage.board.work.unknownProject')]);
        expect.soft(choices.map(choice => choice.label)).toEqual(pageTitles);
        expect(choices.map(choice => choice.value)).toEqual(projectKeys);
    });

    it('applies foreground cost-basis choices to the page query through route feedback', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-cost-basis-selection.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return Response.json({ ...accounting,
                    totals: { ...totals, cost: { ...totals.cost, estimatedUsd: 2, apiEquivalentUsd: 3 } } });
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><RoutedUsagePage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const chip = () => screen.findAllByType(SelectionListFilterChip).find(node => node.props.filter.id === 'costBasis')!.props.filter;
        const bodyQueries = () => screen.findAllByType(UsagePeriodSummaryWidget).map(node => normalizeUsageQuery(node.props.query));
        await waitForHomeGovernance(() => expect(chip().options.map((option: { id: string }) => option.id))
            .toEqual(['auto', 'reported', 'estimated', 'api_equivalent']));
        expect(chip().selectedId).toBe('auto');
        expect(bodyQueries().length).toBeGreaterThan(0);
        expect(bodyQueries().every(query => query.costBasis === 'auto')).toBe(true);
        for (const basis of ['estimated', 'reported', 'api_equivalent', 'auto'] as const) {
            await screen.pressByTestIdAsync(chip().testID);
            await flushHookEffects({ cycles: 10 });
            const pageTitle = describeUsageWidgetSlotValue('costBasis', basis, screen.findByType(UsageFilterBar).props.period);
            expect(reader!.readCurrentUiContext()!.commands.some(command => command.title === pageTitle),
                'The foreground chooser withholds the page command').toBe(false);
            await screen.pressByTestIdAsync(`${chip().testID}:${basis}`);
            await flushHookEffects({ cycles: 40 });
            expect(chip().selectedId).toBe(basis);
            expect(screen.findByType(UsageFilterBar).props.costBasis).toBe(basis);
            expect(screen.findByType(UsageWidgetPage).props.initialFilters.costMode).toBe(basis);
            await waitForHomeGovernance(() => {
                const queries = bodyQueries();
                expect(queries.length).toBeGreaterThan(0);
                expect(queries.every(query => query.costBasis === basis)).toBe(true);
            });
        }
    });
    it.each([{ selection: 'period' }, { selection: 'filter' }] as const)('retains native $selection callers through actual page layout admission', async ({ selection }) => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-origin-layout.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return Response.json(accounting);
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><RoutedUsagePage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const machineFilter = () => screen.findAllByType(SelectionListFilterChip).map(node => node.props.filter)
            .find(filter => filter.id === 'machines');
        await waitForHomeGovernance(() => expect(machineFilter()?.options.some((option: { id: string }) => option.id === 'machine-a')).toBe(true));
        await flushHookEffects({ cycles: 40 });
        const settings = getStorage().getState().settings;
        getStorage().setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'usage.query': { disabledSurfaces: ['agent'] } } }) } });
        const posts = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query' || request.path === '/v2/usage/query-batch').length;
        const before = posts();
        const invoke = async (title: string) => {
            const command = reader!.readCurrentUiContext()!.commands.find(row => row.title === title);
            expect(command).toBeDefined();
            await act(async () => {
                expect(await createDefaultActionExecutor().execute('ui.current_context.command.invoke',
                    { commandId: command!.id }, { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: true });
            });
            await flushHookEffects({ cycles: 40 });
        };
        try {
            if (selection === 'period') {
                await invoke(t(getUsagePeriodDefinition('30days').translationKey));
                expect(screen.findByType(UsageFilterBar).props.period).toBe('30days');
            } else {
                const filter = machineFilter()!;
                const option = filter.options.find((value: { id: string }) => value.id === 'machine-a')!;
                await invoke(`${filter.label}: ${option.label}`);
                expect(shownScope(screen.findByType(UsageFilterBar).props.scopeFilters, 'machines')).toEqual(['machine-a']);
            }
            expect.soft(posts(), `${selection} layout admission cannot acquire under UI authority`).toBe(before);
            expect.soft(screen.findAllByType(SurfaceStateCard).some(node => node.props.diagnosticCode === 'action_disabled')).toBe(true);
        } finally { getStorage().setState({ settings }); }
    });
    it('retains unchanged offered filter command IDs while a new period read is pending', async () => {
        let readStarted = createDeferred<void>();
        let readGate = createDeferred<void>();
        let holdRead = false;
        let responseAccounting = accounting;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-period-command-continuity.test', accountId: 'account-a' }],
            route: async request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') {
                    if (holdRead) { readStarted.resolve(); await readGate.promise; }
                    return Response.json(responseAccounting);
                }
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let rerender = () => {};
        function Page() {
            const [, setRevision] = React.useState(0);
            rerender = () => setRevision(revision => revision + 1);
            return <RoutedUsagePage />;
        }
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><Page />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const filters = () => screen.findAllByType(SelectionListFilterChip).map(node => node.props.filter);
        await waitForHomeGovernance(() => expect(filters().find(filter => filter.id === 'machines')?.options
            .some((option: { id: string }) => option.id === 'machine-a')).toBe(true));
        await flushHookEffects({ cycles: 40 });
        // Field and option ID establish meaning; titles only locate that option's public descriptor.
        const offered = () => [...filters().filter(filter => ['agents', 'machines', 'projects', 'sources'].includes(filter.id))
            .flatMap(filter => filter.options.map((option: { id: string; label: string }) => ({
                key: JSON.stringify([filter.id, option.id]), title: `${filter.label}: ${option.label}`,
            }))), ...screen.findByType(UsageFilterBar).props.costBasisOptions.map((basis: UsageWidgetPageScope['costBasis']) => ({
                key: JSON.stringify(['costBasis', basis]),
                title: describeUsageWidgetSlotValue('costBasis', basis, screen.findByType(UsageFilterBar).props.period),
            }))];
        const ids = (choices: ReturnType<typeof offered>) => {
            const seen = new Map<string, number>();
            return Object.fromEntries(choices.map(choice => {
                const index = seen.get(choice.title) ?? 0;
                seen.set(choice.title, index + 1);
                return [choice.key, reader!.readCurrentUiContext()!.commands.filter(command => command.title === choice.title)[index]?.id ?? null];
            }));
        };
        const choices = offered();
        const initial = ids(choices);
        expect(Object.values(initial).every(id => id !== null)).toBe(true);
        const registrations = new Map<string, { title: string; description?: string }>();
        const initialCommands = reader!.readCurrentUiContext()!.commands;
        const initialCommandIds = new Set(initialCommands.map(command => command.id));
        const stop = reader!.subscribe(() => {
            for (const command of reader!.readCurrentUiContext()?.commands ?? []) {
                if (!initialCommandIds.has(command.id)) registrations.set(command.id, {
                    title: command.title, ...(command.description ? { description: command.description } : {}),
                });
            }
        });
        try {
            for (let count = 0; count < 3; count++) {
                await act(async () => rerender());
                await flushHookEffects({ cycles: 10 });
            }
            expect(registrations.size, 'unchanged page rerenders create zero new executable command addresses').toBe(0);
            expect(ids(choices)).toEqual(initial);
            holdRead = true;
            let refreshed: Promise<void> | undefined;
            try {
                await act(async () => { refreshed = screen.findAllByType(UsagePeriodSummaryWidget)[0]!.props.model.refresh(); });
                await readStarted.promise;
                await flushHookEffects({ cycles: 20 });
                expect(ids(choices), 'same-period pending refresh preserves offered command IDs').toEqual(initial);
            } finally {
                holdRead = false;
                await act(async () => { readGate.resolve(); await refreshed; });
            }
            await waitForHomeGovernance(() => expect(ids(choices)).toEqual(initial));
            expect(registrations.size, `unchanged refreshed facts create zero new executable command addresses: ${JSON.stringify({
                added: [...registrations.values()], initial: initialCommands.filter(command => [...registrations.values()]
                    .some(added => added.title === command.title)).map(({ title, description }) => ({ title, description })),
            })}`).toBe(0);
            readStarted = createDeferred<void>();
            readGate = createDeferred<void>();
            holdRead = true;
            let pending: ReturnType<typeof ids>;
            let pendingPublicIds = new Set<string>();
            try {
                await act(async () => { screen.findByType(UsageFilterBar).props.onPeriodChange('today'); });
                await readStarted.promise;
                await flushHookEffects({ cycles: 20 });
                pending = ids(choices);
                pendingPublicIds = new Set(reader!.readCurrentUiContext()!.commands.map(command => command.id));
            } finally {
                holdRead = false;
                await act(async () => readGate.resolve());
            }
            await waitForHomeGovernance(() => expect(offered()).toEqual(choices));
            const settled = ids(choices);
            const settledPublicIds = new Set(reader!.readCurrentUiContext()!.commands.map(command => command.id));
            const counts = { before: initialCommandIds.size, pending: pendingPublicIds.size, settled: settledPublicIds.size,
                removedWhilePending: [...initialCommandIds].filter(id => !pendingPublicIds.has(id)).length,
                newAfterSettled: [...settledPublicIds].filter(id => !initialCommandIds.has(id)).length };
            expect({ withdrawn: choices.filter(choice => pending[choice.key] !== initial[choice.key]).length,
                reminted: choices.filter(choice => settled[choice.key] !== initial[choice.key]).length },
            `unchanged offered choices survive pending and settled period reads; public IDs ${JSON.stringify(counts)}`)
                .toEqual({ withdrawn: 0, reminted: 0 });
            // A settled empty inventory is a genuine membership change, not a pending read.
            responseAccounting = { ...accounting, breakdowns: {}, engineTimeline: [] };
            await act(async () => { await screen.findByType(UsageFilterBar).props.onPeriodChange('30days'); });
            await waitForHomeGovernance(() => expect(filters().filter(filter => ['agents', 'machines', 'projects', 'sources'].includes(filter.id))
                .every(filter => filter.options.length === 1)).toBe(true));
            expect(reader!.resolveCurrentUiCommand(initial[JSON.stringify(['machines', 'machine-a'])]!)).toBeNull();
        } finally {
            stop();
            readGate.resolve();
        }
    });

    it.each([
        { entry: 'settings', sessionId: undefined, readFails: false, pendingCommandRegistration: false },
        { entry: 'Session', sessionId: 'session-usage-parity', readFails: false, pendingCommandRegistration: false },
        { entry: 'settings with failed document read', sessionId: undefined, readFails: true, pendingCommandRegistration: false },
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
            expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
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
        // R134 (895758270b): a Session owns one dedicated view; Account view switching belongs to settings.
        const viewNames = sessionId ? [t('usage.sessionUsage')]
            : screen.findByType(WidgetAreaLayoutBar).props.layouts.map((view: { name: string }) => view.name);
        expect(reader?.readCurrentUiContext()?.commands.map(command => command.title)).toEqual(expect.arrayContaining(viewNames));
        if (sessionId) {
            expect(screen.findAllByType(WidgetAreaLayoutBar)).toHaveLength(0);
            expect(reader!.readCurrentUiContext()!.detail).toContain(USAGE_SESSION_WIDGET_PRESET_ID);
            expect(reader!.readCurrentUiContext()!.commands.some(command => command.title === t('usage.presets.costs'))).toBe(false);
        }
        await invoke(t(getUsagePeriodDefinition('30days').translationKey));
        expect(toolbar().period).toBe('30days');
        const filters = toolbar().scopeFilters;
        expect(filters.map((filter: { field: string }) => filter.field)).toEqual(sessionId ? [] : ['sources', 'agents', 'machines', 'projects']);
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(expect.arrayContaining(
            filters.flatMap((filter: { title: string; options: readonly { label: string }[] }) => filter.options.map(option => `${filter.title}: ${option.label}`))));
        if (!sessionId) {
            const sourceFilter = filters.find((filter: { field: string }) => filter.field === 'sources');
            const source = sourceFilter.options.find((option: { id: string }) => option.id === 'native');
            await invoke(`${sourceFilter.title}: ${source.label}`);
            expect(shownScope(toolbar().scopeFilters, 'sources')).toEqual(['native']);
        }
        await invoke(t('usage.board.page.costBasisReported'));
        expect(toolbar().costBasis).toBe('reported');
        if (!sessionId) {
            holdRead = true;
            await invoke(t('usage.presets.costs'));
            await waitForHomeGovernance(() => expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe('costs'));
            expect(reader!.readCurrentUiContext()!.detail).toContain('costs');
        }
    });

    it('says once, under the page chrome, that the Home cannot be reached while bodies have nothing to show', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-unreachable.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return Response.json({ error: 'unavailable' }, { status: 503 });
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        publishAppliedActiveServerRuntimeAvailability(true);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <UsageWidgetPage initialFilters={{ layoutId: 'costs', period: '7days', metric: 'cost', costMode: 'auto', focus: null }} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('usage-page.header.failed')).not.toBeNull());
        await act(async () => { getStorage().setState({ endpointStatus: 'offline', socketStatus: 'disconnected', endpointReason: null, syncError: null }); });
        await waitForHomeGovernance(() => expect(screen.findAllByTestId('home-unreachable').length).toBeGreaterThan(0));
        expect(screen.findAllByTestId('home-unreachable-retry').length).toBeGreaterThan(0);
        // The line takes the header's facts slot: no card is inserted between the header and the views, so the tabs
        // and the last-read bodies keep their place (acceptance #16, 60 px push).
        const header = screen.findAllByType(PageHeader).find(node => node.props.testID === 'usage-page.header')!;
        expect(header.findAll(node => node.props?.testID === 'home-unreachable').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('home-unreachable').filter(node => !header.findAll(inner => inner === node).length)).toHaveLength(0);
        expect(screen.findAllHostsByTestId('usage-page.header.failed')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('usage-page.header.retry')).toHaveLength(0);
        // The cause is said once: the views bar and the area defer to the line.
        expect(screen.findAllByTestId('usage-views.readFailed')).toHaveLength(0);
        expect(screen.findAllByTestId('usage-area.unavailable')).toHaveLength(0);
    });

    it.each([['sources', 'usage-area.widget.sources:group:0:widget:1'], ['plans', 'usage-area.widget.plans:group:0:widget:3']] as const)(
        'holds the cost-basis chip from first paint until accounting answers (%s: N4 at 390, the 40 px drop at 1440)', async (layoutId, widgetTestId) => {
        // The chip followed only Tokens/Cost widgets while pending, but its choices follow every usage read: on Sources it
        // arrived with the first read and pushed the whole page down a phone line (42 px). On Plans, the allowance-only
        // widgets (Capacity, Projections, Resets) said "accounting answered" before Plan fit's accounting had: the row
        // dropped 40 px and came back with the choices. The choices' own owner decides both.
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: `https://usage-basis-hold-${layoutId}.test`, accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return new Promise<Response>(() => {});
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        publishAppliedActiveServerRuntimeAvailability(true);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <UsageWidgetPage initialFilters={{ layoutId, period: '7days', metric: 'tokens', costMode: 'auto', focus: null }} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await waitForHomeGovernance(() => expect(screen.findAllByTestId(widgetTestId).length).toBeGreaterThan(0));
        await flushHookEffects({ cycles: 20 });
        expect(screen.findByType(UsageFilterBar).props.costBasisPending).toBe(true);
    });

    it('publishes the failed page read Retry and recovers through the agent command', async () => {
        let readFails = true;
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-read-retry.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse())
                : request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? readFails
                    ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(accounting)
                : request.path === '/v2/usage/query-batch' ? undefined
                : artifacts.handle(request.url.toString(), { method: request.method })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage initialFilters={{ layoutId: 'costs', period: '7days', metric: 'cost', costMode: 'auto', focus: null }} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        // One notice under the purpose says what failed, when, and offers the one Retry (D23): never loose facts.
        const retryFact = () => screen.findHostByTestId('usage-page.header.retry');
        await waitForHomeGovernance(() => expect(retryFact()).not.toBeNull());
        expect(screen.findAllHostsByTestId('usage-page.header.failed')).toHaveLength(1);
        expect(screen.findByType(PageHeader).props.meta, 'the notice replaces the facts line').toBeUndefined();
        const command = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('usage.board.page.retryRead'));
        expect(command, 'the visible read Retry has a mounted command').toBeDefined();
        readFails = false;
        await act(async () => {
            expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
                input: { commandId: command!.id }, context: { surface: 'agent' } })).toMatchObject({ ok: true });
        });
        await waitForHomeGovernance(() => expect(screen.findAllByType(UsageCostFactsWidget)[0]?.props.slice.accounting?.totals).toEqual(totals));
        expect(retryFact()).toBeNull();
        expect(reader!.readCurrentUiContext()!.commands.find(row => row.id === command!.id)).toBeUndefined();
    });

    it.each(['quota', 'quota and accounting', 'ownership refusal', 'ownership refusal and saved Views failure'] as const)('owns the Plans read notice for %s', async (cause) => {
        let failed = true;
        const accountingFails = cause === 'quota and accounting';
        const viewsFail = cause === 'ownership refusal and saved Views failure';
        const ownershipRefused = cause === 'ownership refusal' || viewsFail;
        let savedViewsFailed = viewsFail;
        let savedViewsReads = 0;
        const nowMs = Date.now();
        const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
        const source = { bindingKind: 'account' as const, ref };
        const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
        const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: nowMs, fetchedAtMs: nowMs,
            staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-plans-read-retry.test', accountId: 'account-a',
            profile: { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
                credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] } }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                    features: { connectedServices: { enabled: true, quotas: { enabled: true } } },
                }));
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return failed && accountingFails
                    ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(accounting);
                if (request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1 || request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1)
                    return Response.json({ status: 'deleted', revision: 1 });
                if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return ownershipRefused
                    ? Response.json({ error: 'ownership_unproven' }, { status: 409 })
                    : Response.json({ source, recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: nowMs, staleAfterMs: 600_000 });
                if (request.path === '/v4/connect/qualified/provider-account-usage/record') return failed
                    ? Response.json({ error: 'provider_account_usage_read_failed' }, { status: 503 })
                    : Response.json({ content: { t: 'plain', v: record }, metadata: { fetchedAt: nowMs, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
                if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
                    if (request.method === 'PUT') {
                        ProviderAccountUsagePageProjectionWriteV1Schema.parse(request.body);
                        return Response.json({ success: true });
                    }
                    const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
                        request.url.searchParams.get('query'));
                    return 'projection' in query ? Response.json({ projection: null, complete: false }) : Response.json({ entries: [], nextCursor: null });
                }
                if (request.path === '/v4/connect/qualified/provider-account-usage/day-summaries') return Response.json({ summaries: [], missingDays: [] });
                if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
                if (request.path === '/v1/artifacts' && request.method === 'GET' && request.url.searchParams.get('kind') === 'widget_area_layout') {
                    savedViewsReads += 1;
                    if (savedViewsFailed) return Response.json({ error: 'database_transaction_timeout' }, { status: 503 });
                }
                return artifacts.handle(request.url.toString(), { method: request.method })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        publishAppliedActiveServerRuntimeAvailability(true);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage initialFilters={{ layoutId: 'plans', period: '7days', metric: 'tokens', costMode: 'auto', focus: null }} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const retryControls = () => screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === t('common.retry'));
        const noticeId = 'usage-page.header.failed';
        if (viewsFail) {
            // The ownership refusal's Retry is the page's one Retry, which rereads the saved Views too (acceptance 11-22 #20).
            await waitForHomeGovernance(() => {
                expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toContain(t('usage.board.page.retryRead'));
            });
            expect(retryControls().map(node => node.props.testID)).toEqual(['usage-page.header.retry']);
            // The one notice discloses both failures: the ownership consequence and the unread saved views (J-B8).
            const both = screen.findHostByTestId(`${noticeId}-text`)?.props.accessibilityLabel;
            expect(both).toContain(t('connectedServices.errors.quotaOwnershipUnproven', {}));
            expect(both).toContain(t('usage.board.page.viewsReadFailed'));
            const readsBeforeRetry = savedViewsReads;
            savedViewsFailed = false;
            await screen.pressByTestIdAsync('usage-page.header.retry');
            await waitForHomeGovernance(() => {
                expect(savedViewsReads).toBeGreaterThan(readsBeforeRetry);
                expect(screen.findHostByTestId('usage-page.header.viewsFailed')).toBeNull();
            });
        }
        await waitForHomeGovernance(() => {
            const notice = screen.findHostByTestId(noticeId);
            expect(notice).not.toBeNull();
            const diagnosis = screen.findHostByTestId(`${noticeId}-text`)?.props.accessibilityLabel;
            expect(diagnosis).toContain(ownershipRefused ? t('connectedServices.errors.quotaOwnershipUnproven', {}) : usageSourceTitle('quota'));
            if (accountingFails) expect(diagnosis).toContain(usageSourceTitle('accounting'));
        });
        // An ownership refusal holds the switching order back and offers the page's one Retry too (acceptance 11-22 #20).
        expect(retryControls().map(node => node.props.testID)).toEqual(['usage-page.header.retry']);
        if (ownershipRefused) return;
        failed = false;
        await screen.pressByTestIdAsync('usage-page.header.retry');
        await waitForHomeGovernance(() => expect(screen.findHostByTestId(`${noticeId}-text`)?.props.accessibilityLabel).toBeUndefined());
        expect(retryControls()).toHaveLength(0);
    });

    it('keeps populated Usage values through an offline refresh and warm return, then refreshes on recovery', async () => {
        let offline = false;
        let response = accounting;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-offline-return.test', accountId: 'account-a' }],
            route: request => {
                if (offline) throw new TypeError('Failed to fetch');
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return Response.json(response);
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let show!: (visible: boolean) => void;
        function Journey() {
            const [visible, setVisible] = React.useState(true);
            show = setVisible;
            return visible ? <UsageWidgetPage initialFilters={{ layoutId: 'costs', period: '7days', metric: 'cost', costMode: 'auto', focus: null }} /> : null;
        }
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><Journey />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const cost = () => screen.findAllByType(UsageCostFactsWidget)[0];
        await waitForHomeGovernance(() => expect(cost()?.props.slice.accounting?.totals).toEqual(totals));
        offline = true;
        await act(async () => { await cost()!.props.model.refresh(); });
        expect(cost()?.props.slice.accounting?.totals).toEqual(totals);
        await act(async () => { show(false); });
        await act(async () => { show(true); });
        await act(async () => screen.findByTestId('usage-page')!.props.onLayout?.({
            nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 900 } },
        }));
        await flushHookEffects({ cycles: 20 });
        expect(screen.findByTestId('usage-area.unavailable')).toBeNull();
        expect(cost()?.props.slice.accounting?.totals).toEqual(totals);
        offline = false;
        response = { ...accounting, totals: { ...totals, eventCount: 2 } };
        await act(async () => { publishHomeAccountChange(server.id, undefined, { source: 'connected' }); });
        await vi.waitFor(() => expect(cost()?.props.slice.accounting?.totals.eventCount).toBe(2));
    });

    it('settles a cold target accounting refusal after one viewport read', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now());
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-viewport-refusal.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query-batch') return Response.json({ error: 'denied' }, { status: 403 });
                return artifacts.handle(request.url.toString(), { method: request.method })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const posts = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch');
        type MeasureDone = (x: number, y: number, width: number, height: number) => void;
        const positions = new Map<string, number>();
        const content = { measureInWindow: (done: MeasureDone) => done(0, 0, 1000, 6000) };
        const scroll = { getInnerViewRef: () => content };
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <UsageWidgetPage initialFilters={{ layoutId: 'how-you-work', period: '7days', metric: 'tokens', costMode: 'auto', focus: null }} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>, {
            // Geometry and HTTP are external boundaries; mounted query demand and Resource remain real.
            createNodeMock: node => {
                const id = node.props.testID;
                if (id === 'usage-page') return scroll;
                if (typeof id !== 'string' || !/^usage-area\.widget\.[^.]+$/.test(id)) return null;
                return { measureInWindow: (done: MeasureDone) => {
                    if (!positions.has(id)) positions.set(id, 410 + positions.size * 400);
                    done(0, positions.get(id)!, 1000, 300);
                } };
            },
        });
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        await waitForHomeGovernance(() => expect(screen.findByType(UsageFilterBar).props.metricPending).toBe(false));
        await flushHookEffects({ cycles: 10 });
        expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe('how-you-work');
        expect(posts(), 'a cold target waits for viewport demand').toHaveLength(0);
        expect(screen.findAllByType(WidgetSurface)).toHaveLength(0);
        await act(async () => screen.findByTestId('usage-page')!.props.onLayout?.({
            nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 900 } },
        }));
        await vi.waitFor(() => expect(screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('usage-area.widget.how-you-work:')
            && node.props.diagnosticCode === 'denied').length).toBeGreaterThan(0));
        await flushHookEffects({ cycles: 30 });
        expect(posts(), 'a settled refusal does not cause an automatic second accounting read').toHaveLength(1);
        act(() => screen.findByType(UsageFilterBar).props.onMetricChange('cost'));
        expect(screen.findByType(UsageFilterBar).props.metricPending).toBe(true);
        expect(screen.findByType(UsageFilterBar).props.metric).toBe('cost');
    });

    it('admits the captured Plans All Sources selections through the canonical widget queries', async () => {
        const [{ UsageCapacityWidget }, { UsageProjectionsWidget }, { UsageResetPlannerWidget }, { UsagePlanFitWidget }] = await Promise.all([
            import('./widgets/UsageCapacityWidget'), import('./widgets/UsageProjectionsWidget'),
            import('./widgets/UsageResetPlannerWidget'), import('./widgets/UsagePlanFitWidget'),
        ]);
        // B2-R198-SETTLED-SCOPE-MISMATCH: these exact source IDs, All, Plans,
        // cost/auto and otherwise empty scope. Synthetic scoped amounts deliberately
        // differ from the inventory rows: choices cannot supply the selected total.
        const sources = ['claude-sdk-result', 'pi-session-stats'];
        const [{ encodeBase64 }, { createAccountEncryptionCurrentnessFixtureForCredentials }] = await Promise.all([
            import('@/encryption/base64'), import('@/dev/testkit/fixtures/accountEncryptionCurrentness'),
        ]);
        const credentials = { token: createServedHomeAccountToken('account-a'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        const reads: ReturnType<typeof UsageAnalyticsQueryRequestSchema.parse>[] = [];
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'e2ee' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-plans-sources.test', accountId: 'account-a',
            credentials, accountMode: 'e2ee', encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') {
                    const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
                    reads.push(query);
                    const selected = query.filters?.sources ?? [];
                    const amount = selected.length ? selected.includes(sources[0]!) ? 2 : 0.5 : 4;
                    return Response.json({ ...accounting,
                        totals: { ...totals, cost: { ...totals.cost, reportedUsd: amount } },
                        breakdowns: { source: sources.filter(key => !selected.length || selected.includes(key)).map(key => ({ key, ...totals,
                            cost: { ...totals.cost, reportedUsd: selected.length ? amount : key === sources[0] ? 3 : 1 } })) },
                    });
                }
                return artifacts.handle(request.path + request.url.search, { method: request.method, headers: request.headers,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        let routeSources: readonly string[] = [];
        function RoutedPlans() {
            const [filters, setFilters] = React.useState<NonNullable<React.ComponentProps<typeof UsageWidgetPage>['initialFilters']>>({
                layoutId: 'plans', period: 'all', metric: 'cost', costMode: 'auto', focus: null,
                queryOverrides: { includeAccounting: true, includeContributions: false, includeComparison: true, includeQuotaHistory: true, includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: true, workProjection: "detail", modelIds: [], workspaceIds: [], backendModes: [], population: "all_personal_history", granularity: "month", timeZoneOffsetMinutes: 60, includeSeries: true, includeInsights: true, includeActivity: true, includeLeaders: true, includeModelTimeline: true, includeMessageStats: true, activityResolution: "both", topLimit: 20 },
            });
            return <UsageWidgetPage initialFilters={filters} onFiltersChange={next => {
                routeSources = next.scope?.sources ?? [];
                setFilters(current => ({ ...current, ...next }));
            }} />;
        }
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><RoutedPlans />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const bodies = () => [UsageCapacityWidget, UsageProjectionsWidget, UsageResetPlannerWidget, UsagePlanFitWidget]
            .flatMap(component => screen.findAllByType(component));
        const sourceFilter = () => screen.findAllByType(SelectionListFilterChip)
            .find(node => node.props.filter.id === 'sources')!.props.filter;
        await waitForHomeGovernance(() => {
            expect(bodies()).toHaveLength(4);
            expect(bodies().every(node => node.props.slice.pending === false)).toBe(true);
            expect(screen.findByType(UsagePlanFitWidget).props.slice.accounting?.totals.cost.reportedUsd).toBe(4);
        });
        for (const [index, source] of sources.entries()) {
            if (index) await act(async () => { await sourceFilter().onChange(sourceFilter().options[0].id); });
            await waitForHomeGovernance(() => expect(sourceFilter().options.some((option: { id: string }) => option.id === source)).toBe(true));
            await act(async () => { await sourceFilter().onChange(source); });
            await waitForHomeGovernance(() => {
                expect(routeSources).toEqual([source]);
                expect(bodies().map(node => node.props.query.sources)).toEqual([[source], [source], [source], [source]]);
                expect(bodies().every(node => node.props.slice.pending === false)).toBe(true);
                expect(screen.findByType(UsagePlanFitWidget).props.slice.accounting?.totals.cost.reportedUsd).toBe(index === 0 ? 2 : 0.5);
            });
            expect(reads.some(query => query.filters?.sources?.includes(source))).toBe(true);
        }
    });

    it('retains Cost across acknowledged E2EE widget input publications', async () => {
        const [{ encodeBase64 }, { createAccountEncryptionCurrentnessFixtureForCredentials }] = await Promise.all([
            import('@/encryption/base64'), import('@/dev/testkit/fixtures/accountEncryptionCurrentness'),
        ]);
        const credentials = { token: createServedHomeAccountToken('account-a'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'e2ee' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-metric-retention.test', accountId: 'account-a',
            credentials, accountMode: 'e2ee', encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return Response.json(accounting);
                return artifacts.handle(request.path + request.url.search, { method: request.method, headers: request.headers,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const frames: unknown[] = [];
        let observe: (() => void) | undefined;
        const screen = await renderMeasuredPage(<React.Profiler id="metric-retention" onRender={() => observe?.()}>
            <InjectedAuthProvider credentials={credentials}>
                <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                    <UsageWidgetPage initialFilters={{ layoutId: 'how-you-work', period: 'all', metric: 'tokens', costMode: 'auto', focus: null }} />
                </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
            </InjectedAuthProvider>
        </React.Profiler>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const bar = () => screen.findByType(UsageFilterBar);
        await waitForHomeGovernance(() => {
            expect(screen.findAllByType(WidgetSurface)).toHaveLength(8);
            expect(bar().props.metricPending).toBe(false);
        });
        // The default layout mixes fixed Cost and Tokens bindings. Establish the
        // incident's all-Tokens control through the same real toolbar writer.
        await flushHookEffects({ cycles: 20 });
        act(() => bar().props.onMetricChange('tokens'));
        await waitForHomeGovernance(() => {
            expect(bar().props.metricPending).toBe(false);
            expect(bar().props.metric).toBe('tokens');
        });
        observe = () => frames.push(bar().props.metric);
        act(() => bar().props.onMetricChange('cost'));
        await waitForHomeGovernance(() => {
            expect(bar().props.metricPending).toBe(false);
            expect(bar().props.metric).toBe('cost');
        });
        await flushHookEffects({ cycles: 20 });
        observe = undefined;
        expect(frames.length).toBeGreaterThan(0);
        expect(frames, 'every committed frame retains the selected Cost while acknowledged inputs are admitted').toEqual(frames.map(() => 'cost'));
    });

    it.each(['period', 'sources'] as const)('finishes Cost edits across a %s change before the first write acknowledges', async change => {
        const [{ encodeBase64 }, { createAccountEncryptionCurrentnessFixtureForCredentials }] = await Promise.all([
            import('@/encryption/base64'), import('@/dev/testkit/fixtures/accountEncryptionCurrentness'),
        ]);
        const credentials = { token: createServedHomeAccountToken('account-a'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'e2ee' });
        const releaseWrite = createDeferred<void>();
        let layoutArtifactId = '';
        let holdNextWrite = false;
        let writeHeld = false;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-metric-inflight-filter.test', accountId: 'account-a',
            credentials, accountMode: 'e2ee', encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) }],
            route: async request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return Response.json(accounting);
                const response = await artifacts.handle(request.path + request.url.search, { method: request.method, headers: request.headers,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
                // The real server boundary has committed the first edit, but its caller
                // cannot acknowledge it or issue the remaining edits until released.
                if (holdNextWrite && request.path === `/v1/artifacts/${layoutArtifactId}` && request.method === 'POST' && response?.ok) {
                    holdNextWrite = false;
                    writeHeld = true;
                    await releaseWrite.promise;
                }
                return response
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const frames: unknown[] = [];
        let observe: (() => void) | undefined;
        const screen = await renderMeasuredPage(<React.Profiler id="metric-inflight-filter" onRender={() => observe?.()}>
            <InjectedAuthProvider credentials={credentials}>
                <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                    <CurrentContextPort /><UsageWidgetPage initialFilters={{ layoutId: 'how-you-work', period: 'all', metric: 'tokens', costMode: 'auto', focus: null }} />
                </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
            </InjectedAuthProvider>
        </React.Profiler>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const bar = () => screen.findByType(UsageFilterBar);
        const metricWidgets = () => screen.findAllByType(WidgetSurface)
            .filter(node => readBuiltinWidgetDescriptorV1(node.props.instance.definition)?.inputs?.fields.some(field => field.path === 'metric'));
        const sourceFilter = () => screen.findAllByType(SelectionListFilterChip)
            .find(node => node.props.filter.id === 'sources')!.props.filter;
        await waitForHomeGovernance(() => {
            expect(screen.findAllByType(WidgetSurface)).toHaveLength(8);
            expect(bar().props.metricPending).toBe(false);
        });
        await flushHookEffects({ cycles: 20 });
        // Establish a persisted all-Tokens control through this same toolbar and HTTP path.
        act(() => bar().props.onMetricChange('tokens'));
        await waitForHomeGovernance(() => {
            expect(metricWidgets().length).toBeGreaterThan(1);
            expect(metricWidgets().every(node => node.props.instance.bindings.metric?.value === 'tokens')).toBe(true);
            expect(bar().props.metricPending).toBe(false);
            expect(bar().props.metric).toBe('tokens');
        });
        layoutArtifactId = buildWidgetSurfaceArtifactIdV1({ serverId: server.id, accountId: 'account-a',
            owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'how-you-work' } });
        holdNextWrite = true;
        observe = () => frames.push(bar().props.metric);
        try {
            try {
                act(() => bar().props.onMetricChange('cost'));
                await waitForHomeGovernance(() => {
                    expect(writeHeld).toBe(true);
                    expect(bar().props.metricPending).toBe(true);
                    expect(bar().props.metric).toBe('cost');
                });
                if (change === 'period') {
                    await act(async () => { await bar().props.onPeriodChange('30days'); });
                    expect(bar().props.period).toBe('30days');
                    await act(async () => { await bar().props.onPeriodChange('7days'); });
                    expect(bar().props.period).toBe('7days');
                } else {
                    await act(async () => { await sourceFilter().onChange('native'); });
                    expect(shownScope(bar().props.scopeFilters, 'sources')).toEqual(['native']);
                }
            } finally {
                await act(async () => { releaseWrite.resolve(); });
            }
            await waitForHomeGovernance(() => {
                expect(metricWidgets().length).toBeGreaterThan(1);
                expect(metricWidgets().every(node => node.props.instance.bindings.metric?.value === 'cost')).toBe(true);
                expect(bar().props.metricPending).toBe(false);
                expect(bar().props.metric).toBe('cost');
            });
            await flushHookEffects({ cycles: 20 });
            expect(frames.length).toBeGreaterThan(0);
            expect(frames, 'filter changes retain Cost through the pending write and its admitted publication').toEqual(frames.map(() => 'cost'));
        } finally {
            observe = undefined;
        }
    });

    it.each(['period', 'sources', 'dashboard'] as const)('hands off acknowledged Cost during a %s change with layout admission held', async change => {
        const [{ encodeBase64 }, { createAccountEncryptionCurrentnessFixtureForCredentials }] = await Promise.all([
            import('@/encryption/base64'), import('@/dev/testkit/fixtures/accountEncryptionCurrentness'),
        ]);
        const credentials = { token: createServedHomeAccountToken('account-a'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'e2ee' });
        const releaseRead = createDeferred<void>();
        let layoutArtifactId = '';
        let remainingCostWrites = 0;
        let holdCostRead = false;
        let readHeld = false;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-metric-delayed-publication.test', accountId: 'account-a',
            credentials, accountMode: 'e2ee', encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) }],
            route: async request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return Response.json(accounting);
                const response = await artifacts.handle(request.path + request.url.search, { method: request.method, headers: request.headers,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
                const layoutPath = `/v1/artifacts/${layoutArtifactId}`;
                if (request.path === layoutPath && request.method === 'POST' && response?.ok && remainingCostWrites > 0) {
                    holdCostRead = --remainingCostWrites === 0;
                }
                if (holdCostRead && request.path === '/v1/artifacts/read') {
                    const read = ArtifactReadBatchHttpInputV1Schema.parse(request.body);
                    if (read.artifactIds.includes(layoutArtifactId)) {
                        readHeld = true;
                        await releaseRead.promise;
                    }
                }
                return response
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const frames: string[] = [];
        let observe: (() => void) | undefined;
        const screen = await renderMeasuredPage(<React.Profiler id="metric-delayed-publication" onRender={() => observe?.()}>
            <InjectedAuthProvider credentials={credentials}>
                <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                    <CurrentContextPort /><UsageWidgetPage initialFilters={{ layoutId: 'how-you-work', period: 'all', metric: 'tokens', costMode: 'auto', focus: null }} />
                </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
            </InjectedAuthProvider>
        </React.Profiler>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const bar = () => screen.findByType(UsageFilterBar);
        await waitForHomeGovernance(() => {
            expect(screen.findAllByType(WidgetSurface)).toHaveLength(8);
            expect(bar().props.metricPending).toBe(false);
        });
        await flushHookEffects({ cycles: 20 });
        act(() => bar().props.onMetricChange('tokens'));
        await waitForHomeGovernance(() => {
            expect(bar().props.metricPending).toBe(false);
            expect(bar().props.metric).toBe('tokens');
        });

        const metricWidgets = () => screen.findAllByType(WidgetSurface)
            .filter(node => readBuiltinWidgetDescriptorV1(node.props.instance.definition)?.inputs?.fields.some(field => field.path === 'metric'));
        const sourceFilter = () => screen.findAllByType(SelectionListFilterChip)
            .find(node => node.props.filter.id === 'sources')!.props.filter;
        layoutArtifactId = buildWidgetSurfaceArtifactIdV1({ serverId: server.id, accountId: 'account-a',
            owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'how-you-work' } });
        remainingCostWrites = metricWidgets().length;
        expect(remainingCostWrites).toBeGreaterThan(0);
        // Withhold only the server's read of the final revision. The real write,
        // acknowledgement and local Artifact publication can all finish.
        try {
            act(() => bar().props.onMetricChange('cost'));
            await waitForHomeGovernance(() => {
                expect(readHeld).toBe(true);
                expect(bar().props.metricPending).toBe(false);
            });
            expect(bar().props.metric).toBe('cost');
            expect(metricWidgets().some(node => node.props.instance.bindings.metric?.value !== 'cost')).toBe(true);
            if (change === 'dashboard') {
                const layoutBar = () => screen.findByType(WidgetAreaLayoutBar);
                observe = () => { if (layoutBar().props.selectedId === 'overview') frames.push(bar().props.metric); };
                await act(async () => { layoutBar().props.onSelect('overview'); });
                await waitForHomeGovernance(() => {
                    expect(layoutBar().props.selectedId).toBe('overview');
                    expect(bar().props.metricPending).toBe(false);
                });
                expect(bar().props.metric).toBe('tokens');
                expect(frames).not.toContain('cost');
            } else {
                observe = () => frames.push(bar().props.metric);
                if (change === 'period') {
                    await act(async () => { await bar().props.onPeriodChange('30days'); });
                    expect(bar().props.period).toBe('30days');
                } else {
                    await act(async () => { await sourceFilter().onChange('native'); });
                    expect(shownScope(bar().props.scopeFilters, 'sources')).toEqual(['native']);
                }
                expect(metricWidgets().some(node => node.props.instance.bindings.metric?.value !== 'cost')).toBe(true);
            }
        } finally {
            await act(async () => { releaseRead.resolve(); });
        }
        if (change !== 'dashboard') {
            await waitForHomeGovernance(() => {
                expect(metricWidgets().length).toBeGreaterThan(0);
                expect(metricWidgets().every(node => node.props.instance.bindings.metric?.value === 'cost')).toBe(true);
            });
            expect(frames.length).toBeGreaterThan(0);
            expect(frames).toEqual(frames.map(() => 'cost'));
        }
        observe = undefined;
    });

    it('defers never-near widgets and keeps admitted content mounted through partial visibility and scroll return', async () => {
        // Change viewport demand without also advancing the accounting period's end.
        const observedAt = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(observedAt);
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-viewport.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse())
                : request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? Response.json(accounting)
                : request.path === '/v2/usage/query-batch' ? undefined
                : artifacts.handle(request.url.toString(), { method: request.method })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const positions = new Map<string, number>();
        let offset = 0;
        type MeasureDone = (x: number, y: number, width: number, height: number) => void;
        const content = { measureInWindow: (done: MeasureDone) => done(0, -offset, 1000, 6000) };
        const scroll = { getInnerViewRef: () => content };
        const nodes = new Map<string, Readonly<{ measureInWindow: (done: MeasureDone) => void }>>();
        const shownAccounting: Array<number | null> = [];
        let renderCount = 0;
        let observeContent: (() => void) | undefined;
        const screen = await renderScreen(<React.Profiler id="usage-scroll" onRender={() => {
            renderCount++;
            if (renderCount > 200) throw new Error(`usage WidgetArea render guard exceeded: ${renderCount}`);
            observeContent?.();
        }}><InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <UsageWidgetPage initialFilters={{ layoutId: 'how-you-work', period: '7days', metric: 'tokens', costMode: 'auto', focus: null }} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider></React.Profiler>, {
            // DOM/native geometry is the external boundary; mount policy and widget bodies stay real.
            createNodeMock: node => {
                const id = node.props.testID;
                if (id === 'usage-page') return scroll;
                if (typeof id !== 'string' || !/^usage-area\.widget\.[^.]+$/.test(id)) return null;
                if (!positions.has(id)) positions.set(id, 410 + positions.size * 400);
                if (!nodes.has(id)) nodes.set(id, { measureInWindow: (done: MeasureDone) => done(0, positions.get(id)! - offset, 1000, 300) });
                return nodes.get(id)!;
            },
        });
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const scroller = () => screen.findByTestId('usage-page')!;
        expect(home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch'),
            'cold admission waits for the physical viewport').toHaveLength(0);
        await act(async () => scroller().props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 900 } } }));
        await waitForHomeGovernance(() => expect(positions.size).toBe(8));
        const bodies = () => screen.findAllByType(WidgetSurface).map(node => node.props.testID as string);
        const ids = [...positions.keys()];
        await vi.waitFor(() => expect(bodies()).toEqual(ids.slice(0, 4).map(id => `${id}.body`)));
        const firstBody = screen.root.findAllByType(WidgetSurface)[0]!;
        let presentationFlipCount = 0;
        let lastPresented: boolean | undefined;
        const presentedFirst = () => {
            const owning = screen.root.findAllByType(PluginSurfaceFocusEligibilityProvider).filter(node => node.findAllByType(WidgetSurface).includes(firstBody));
            return owning.at(-1)?.props.presentationActive as boolean | undefined;
        };
        const recordPresentation = () => {
            const next = presentedFirst();
            if (next === undefined) return;
            if (lastPresented !== undefined && next !== lastPresented) presentationFlipCount++;
            lastPresented = next;
        };
        await flushHookEffects({ cycles: 20 });
        recordPresentation();
        const batches = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch');
        expect(batches(), 'cold visible widgets and inventory share one mount batch').toHaveLength(1);
        const firstContent = () => screen.root.findAllByType(UsageRhythmWidget)[0]!;
        await vi.waitFor(() => expect(firstContent().props.slice.accounting?.totals.tokens.total).toBe(15));
        const loadedContent = firstContent();
        observeContent = () => shownAccounting.push(firstContent()?.props.slice.accounting?.totals.tokens.total ?? null);
        // The fifth card starts at 2010; one pixel enters the physical viewport,
        // while its quantized zero-margin window ends at 2000.
        // Scroll quantization must never leave even a partly visible card blank.
        await act(async () => {
            offset = 1111;
            scroller().props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } });
        });
        await vi.waitFor(() => expect(bodies()).toContain(`${ids[4]}.body`));
        expect(screen.root.findAllByType(WidgetSurface)[0]).toBe(firstBody);
        await act(async () => {
            offset = 2400;
            scroller().props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } });
        });
        await vi.waitFor(() => expect(bodies()).toEqual(ids.map(id => `${id}.body`)));
        recordPresentation();
        expect(screen.root.findAllByType(WidgetSurface)[0], 'scrolling away keeps the loaded body mounted').toBe(firstBody);
        // Retained content remains presented after admission; proximity only controls the one-time body admit.
        await vi.waitFor(() => expect(presentedFirst(), 'an offscreen retained body stays presented').toBe(true));
        await flushHookEffects({ cycles: 20 });
        expect(firstContent() === loadedContent, 'scrolling away preserves the loaded inner body').toBe(true);
        expect(firstContent().props.slice.accounting?.totals.tokens.total).toBe(15);
        const requestsBeforeReturn = home!.httpRequests.length;
        expect(batches().filter(request => request.signal?.aborted), 'scrolling never cancels admitted batches').toHaveLength(0);
        await act(async () => {
            offset = 0;
            scroller().props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } });
        });
        await vi.waitFor(() => expect(bodies()).toEqual(ids.map(id => `${id}.body`)));
        recordPresentation();
        expect(screen.root.findAllByType(WidgetSurface)[0], 'scrolling back retains the same body').toBe(firstBody);
        await vi.waitFor(() => expect(presentedFirst(), 'a returned body is presented again').toBe(true));
        await flushHookEffects({ cycles: 20 });
        expect(firstContent() === loadedContent, 'scroll return preserves the loaded inner body').toBe(true);
        expect(firstContent().props.slice.accounting?.totals.tokens.total).toBe(15);
        expect(home!.httpRequests.length, 'returning to admitted widgets adds no request').toBe(requestsBeforeReturn);
        // Once every body has been admitted, both directions are warm: no read
        // is needed for either leaving or returning to an already loaded body.
        for (const nextOffset of [2400, 0]) {
            await act(async () => {
                offset = nextOffset;
                scroller().props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } });
            });
            await flushHookEffects({ cycles: 20 });
            recordPresentation();
            expect(bodies()).toEqual(ids.map(id => `${id}.body`));
            expect(firstContent() === loadedContent, 'warm scrolling preserves the inner body').toBe(true);
            expect(firstContent().props.slice.accounting?.totals.tokens.total).toBe(15);
            expect(home!.httpRequests.length, 'a warm scroll round trip makes zero requests').toBe(requestsBeforeReturn);
        }
        expect(screen.findByType(WidgetAreaLayoutBar).props.readFailure,
            'scroll admission and return never retire the page view inventory').toBeUndefined();
        observeContent = undefined;
        expect(renderCount, 'multi-widget proximity/presentation settles instead of oscillating').toBeLessThan(200);
        expect(presentationFlipCount, 'one-time admission never feeds proximity back into presentation').toBe(0);
        expect(shownAccounting).toContain(15);
        expect(shownAccounting, 'every committed scroll frame retains the loaded facts').not.toContain(null);
    });

    it("defers the default Overview Coach until near and reuses the visible Summary's transcript facts", async () => {
        const nowMs = 1_710_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const { createPlainSessionWithDisplayRecordFixture } = await import('@/dev/testkit/fixtures/sessionDisplayFixtures');
        const id = 'overview-visible-summary';
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-overview-viewport.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return Response.json(accounting);
                if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
                    const demand = UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!;
                    return Response.json({ requests: [{ query: demand.query, sessionIds: [id] }], results: [{ sessionId: id,
                        detail: { status: 200, body: { session: createPlainSessionWithDisplayRecordFixture({ id, seq: 1 }) } },
                        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs, turns: [{
                            turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: nowMs - 900,
                            terminalAt: nowMs - 600, updatedAt: nowMs,
                        }] } }, ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
                    }] });
                }
                return artifacts.handle(request.url.toString(), { method: request.method })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const positions = new Map<string, number>();
        let offset = 0;
        type MeasureDone = (x: number, y: number, width: number, height: number) => void;
        const content = { measureInWindow: (done: MeasureDone) => done(0, -offset, 1000, 6000) };
        const nodes = new Map<string, Readonly<{ measureInWindow: (done: MeasureDone) => void }>>();
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <UsageWidgetPage initialFilters={{ layoutId: 'overview', period: 'today', metric: 'tokens', costMode: 'auto', focus: null }} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>, { createNodeMock: node => {
            const testId = node.props.testID;
            if (testId === 'usage-page') return { getInnerViewRef: () => content };
            if (typeof testId !== 'string' || !/^usage-area\.widget\.[^.]+$/.test(testId)) return null;
            if (!positions.has(testId)) positions.set(testId, 410 + positions.size * 400);
            if (!nodes.has(testId)) nodes.set(testId, { measureInWindow: (done: MeasureDone) => done(0, positions.get(testId)! - offset, 1000, 300) });
            return nodes.get(testId)!;
        } });
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const evidence = () => home!.httpRequests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
            .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
        const coachEvidence = () => evidence().filter(demand => demand.query.includeTranscriptEvidence
            && !demand.query.includeWorkEvidence);
        expect(evidence(), 'the cold page has not admitted a physical viewport').toHaveLength(0);
        await act(async () => screen.findByTestId('usage-page')!.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 900 } } }));
        await waitForHomeGovernance(() => expect(screen.findAllByType(UsagePeriodSummaryWidget)[0]?.props.slice.howYouWork?.intervals?.agentTimeMs).toBe(300));
        const coachFrame = 'usage-area.widget.overview:group:0:widget:4';
        expect(positions.get(coachFrame), 'Coach is physically below the canonical viewport build window').toBe(2_010);
        expect(screen.findHostByTestId(`${coachFrame}.deferred`), 'Coach frame remains deferred before the scroll').not.toBeNull();
        expect(screen.findHostByTestId(`${coachFrame}.bodyHeight`), 'Coach has no mounted body before the scroll').toBeNull();
        expect(screen.findAllByType(UsageCoachWidget), 'never-near Coach has no body or transcript demand').toHaveLength(0);
        expect(evidence().length, 'visible Summary still consumes its real interval facts').toBeGreaterThan(0);
        expect(evidence().filter(demand => demand.query.includeTranscriptEvidence && demand.query.includeWorkEvidence
            && demand.query.workProjection === 'summary'), 'visible Summary owns the shared Today history conversion').toHaveLength(1);
        expect(coachEvidence(), 'a far Coach adds no private evidence request').toHaveLength(0);
        await act(async () => {
            offset = 1111;
            screen.findByTestId('usage-page')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } });
        });
        await waitForHomeGovernance(() => expect(screen.findAllByType(UsageCoachWidget)[0]?.props.slice.sources)
            .toContainEqual({ source: 'how_you_work:transcripts', status: 'available' }));
        expect(coachEvidence(), 'near Coach reuses the Summary transcript admission without another request').toHaveLength(0);
    });

    it.each([false, true])('acquires each demanded fact scope once through the cold Today Overview entry (quota arrival: %s)', async connected => {
        const nowMs = 1_710_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const releaseEvidence = createDeferred<void>();
        const accountingStarted = createDeferred<void>();
        const releaseAccounting = createDeferred<void>();
        const quotaStarted = createDeferred<void>();
        const releaseQuota = createDeferred<void>();
        const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
        const source = { bindingKind: 'account' as const, ref };
        const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
        const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: nowMs, fetchedAtMs: nowMs,
            staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-cold-overview-evidence.test', accountId: 'account-a',
            profile: { connectedAccountsV4: connected ? [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
                credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] : [] } }],
            route: async request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                    features: { connectedServices: { enabled: true, quotas: { enabled: true } } },
                }));
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') {
                    accountingStarted.resolve();
                    if (connected) await releaseAccounting.promise;
                    return Response.json(accounting);
                }
                if (request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1 || request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1)
                    return Response.json({ status: 'deleted', revision: 1 });
                if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({ source,
                    recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: nowMs, staleAfterMs: 600_000 });
                if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
                    quotaStarted.resolve();
                    await releaseQuota.promise;
                    return Response.json({ content: { t: 'plain', v: record }, metadata: { fetchedAt: nowMs, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
                }
                if (request.path === '/v4/connect/qualified/provider-account-usage/history') return Response.json({ entries: [], nextCursor: null });
                if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
                if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
                    const input = UsageSessionEvidenceRequestSchema.parse(request.body);
                    await releaseEvidence.promise;
                    return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [] })), results: [] });
                }
                return artifacts.handle(request.url.toString(), { method: request.method })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <UsageWidgetPage initialFilters={{ layoutId: 'overview', period: 'today', metric: 'tokens', costMode: 'auto', focus: null }} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const evidenceReads = () => home!.httpRequests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH);
        try {
            await waitForHomeGovernance(() => expect(screen.findAllByType(WidgetSurface)).toHaveLength(7));
            if (connected) {
                await accountingStarted.promise;
                await quotaStarted.promise;
                releaseQuota.resolve();
                await flushHookEffects({ cycles: 40 });
                releaseAccounting.resolve();
            }
            await waitForHomeGovernance(() => {
                expect(screen.findAllByType(UsagePeriodSummaryWidget)).toHaveLength(1);
                expect(screen.findAllByType(UsageCoachWidget)).toHaveLength(1);
            });
            await vi.waitFor(() => expect(evidenceReads().length).toBeGreaterThan(0));
            await flushHookEffects({ cycles: 40 });
        } finally { releaseQuota.resolve(); releaseAccounting.resolve(); releaseEvidence.resolve(); }
        await flushHookEffects({ cycles: 40 });
        const demands = evidenceReads().flatMap(request => {
            const input = UsageSessionEvidenceRequestSchema.parse(request.body);
            return input.requests.map(demand => ({ ...demand, workFactKinds: input.workFactKinds,
                key: getUsageSessionEvidenceDemandKey({ ...demand.query, includeCoach: input.workFactKinds?.includes('coach') }, input.nowMs, demand.sessionIds) }));
        });
        // Membership is shared; an empty work cohort has no private Coach payload to acquire.
        expect(demands.map(demand => demand.workFactKinds)).toEqual([['work']]);
        expect(new Set(demands.map(demand => demand.key)).size, 'one shared empty membership serves both fact scopes').toBe(1);
        expect(evidenceReads(), 'duplicate cards, Coach and quota arrival do not rediscover the empty cohort').toHaveLength(1);
        await vi.waitFor(() => expect(screen.findByType(UsageCoachWidget).props.slice.coach?.sessionCoverage).toMatchObject({ selected: 0 }));
    });

    it.each(['summary', 'transcript'] as const)('projects each opaque Overview %s record before the remaining cohort arrives without publishing an incomplete cohort', async phase => {
        const [{ Encryption }, { encodeBase64 }, { sealEncryptedDataKeyEnvelopeV1 }, { createSessionFixture },
            { createPlainSessionWithDisplayRecordFixture }, { createAccountEncryptionCurrentnessFixtureForCredentials },
            { syncPerformanceTelemetry }] = await Promise.all([
            import('@/sync/encryption/encryption'), import('@/encryption/base64'), import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1'),
            import('@/dev/testkit/fixtures/sessionFixtures'), import('@/dev/testkit/fixtures/sessionDisplayFixtures'),
            import('@/dev/testkit/fixtures/accountEncryptionCurrentness'), import('@/sync/runtime/syncPerformanceTelemetry'),
        ]);
        const nowMs = 1_710_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const ids = ['overview-opaque-first', 'overview-opaque-last'];
        const secret = new Uint8Array(32).fill(7);
        const sessionKey = new Uint8Array(32).fill(9);
        const encryption = await Encryption.create(secret);
        await encryption.initializeSessions(new Map(ids.map(id => [id, sessionKey])));
        const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey,
            recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64');
        const records = await Promise.all(ids.map(async id => {
            const { ownerMetadata: _owner, displayProjectionV1: _display, ...base } = createPlainSessionWithDisplayRecordFixture({ id, seq: 1 });
            return { ...base, metadataLayoutVersion: 0, encryptionMode: 'e2ee' as const, dataEncryptionKey,
                metadata: await encryption.getSessionEncryption(id)!.encryptMetadata(createSessionFixture({ id }).metadata!), agentState: null };
        }));
        const ciphertext = await Promise.all(ids.map(id => encryption.getSessionEncryption(id)!.encryptRawRecord({
            role: 'user', content: { type: 'text', text: `private ${id}` },
        })));
        const credentials = { token: createServedHomeAccountToken('account-a'), secret: encodeBase64(secret, 'base64url') };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'e2ee' });
        const firstRecord = createDeferred<void>();
        const releaseTail = createDeferred<void>();
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-incremental-overview.test', accountId: 'account-a',
            credentials, accountMode: 'e2ee', encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v1/account/project-rows/list') return Response.json({ status: 'listed', coverage: 'complete', rows: [] });
                if (request.path === '/v2/usage/query') return Response.json(accounting);
                if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
                    const input = UsageSessionEvidenceRequestSchema.parse(request.body);
                    const demand = input.requests[0]!;
                    const selectedIds = demand.sessionIds ?? ids;
                    const rows = selectedIds.map(id => ({ sessionId: id, detail: { status: 200 as const, body: { session: records[ids.indexOf(id)]! } },
                        turns: { status: 200 as const, body: { v: 1 as const, sessionId: id, updatedAt: nowMs - 100, turns: [
                            { turnId: 'turn', agentId: 'codex', status: 'completed' as const, startedAt: nowMs - 900, terminalAt: nowMs - 600, updatedAt: nowMs - 100 },
                        ] } }, ...(demand.query.includeTranscriptEvidence ? { messages: { status: 200 as const, body: { messages: [{
                            id: `message-${id}`, localId: null, seq: 1, createdAt: nowMs - 800, updatedAt: nowMs - 800,
                            content: { t: 'encrypted' as const, c: ciphertext[ids.indexOf(id)]! },
                        }], hasMore: false } } } : {}) }));
                    if (demand.query.includeTranscriptEvidence !== (phase === 'transcript'))
                        return Response.json({ requests: [{ query: demand.query, sessionIds: selectedIds }], results: rows });
                    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
                        const encoder = new TextEncoder();
                        controller.enqueue(encoder.encode(`${JSON.stringify({ requests: [{ query: demand.query, sessionIds: selectedIds }] })}\n${JSON.stringify(rows[0])}\n`));
                        firstRecord.resolve();
                        await releaseTail.promise;
                        controller.enqueue(encoder.encode(`${JSON.stringify(rows[1])}\n`));
                        controller.close();
                    } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
                }
                return artifacts.handle(request.url.toString(), { method: request.method, headers: request.headers,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        syncPerformanceTelemetry.configure({ enabled: true });
        syncPerformanceTelemetry.reset();
        try {
            const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
                <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                    <UsageWidgetPage initialFilters={{ layoutId: 'overview', period: 'today', metric: 'tokens', costMode: 'auto', focus: null }} />
                </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
            </InjectedAuthProvider>);
            const { sync } = await import('@/sync/sync');
            await sync.awaitBootstrapForegroundAcquisition();
            await waitForHomeGovernance(() => expect(screen.findAllByType(WidgetSurface)).toHaveLength(7));
            await vi.waitFor(() => expect(home!.httpRequests.some(request => request.path === USAGE_SESSION_EVIDENCE_PATH
                && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence === (phase === 'transcript')))).toBe(true));
            await firstRecord.promise;
            await vi.waitFor(() => expect(syncPerformanceTelemetry.snapshot().events
                .filter(event => event.name === (phase === 'transcript' ? 'sync.encryption.decryptMessages.batchDecrypt' : 'sync.encryption.decryptMetadata'))
                .reduce((count, event) => count + event.count, 0),
                'the real crypto owner consumes the first opaque row while the network still holds the rest').toBeGreaterThan(0));
            expect(screen.findAllByType(UsageCoachWidget)[0]?.props.slice.sources).toContainEqual({
                source: phase === 'transcript' ? 'how_you_work:transcripts' : 'how_you_work', status: 'pending' });
            if (phase === 'summary') expect(screen.findAllByType(UsagePeriodSummaryWidget)[0]?.props.slice.howYouWork?.intervals?.agentTimeMs).toBeUndefined();
            releaseTail.resolve();
            await waitForHomeGovernance(() => {
                expect(screen.findAllByType(UsageCoachWidget)[0]?.props.slice.sources)
                    .toContainEqual({ source: 'how_you_work:transcripts', status: 'available' });
                expect(screen.findAllByType(UsagePeriodSummaryWidget)[0]?.props.slice.howYouWork?.intervals?.agentTimeMs).toBe(600);
            });
            expect(home.httpRequests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(0);
            const reads = home.httpRequests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
                .map(request => UsageSessionEvidenceRequestSchema.parse(request.body));
            const demands = reads.flatMap(input => input.requests);
            expect(reads.filter(input => input.readWorkFacts).map(input => input.workFactKinds))
                .toEqual(expect.arrayContaining([['work'], ['work', 'coach']]));
            expect(demands.filter(demand => !demand.query.includeTranscriptEvidence),
                'Summary and Coach each acquire their demanded fact scope exactly once').toHaveLength(2);
            expect(demands.filter(demand => demand.query.includeTranscriptEvidence)).toHaveLength(1);
        } finally { releaseTail.resolve(); syncPerformanceTelemetry.configure({ enabled: false }); }
    });

    it('reuses settled opened E2EE Session facts across How-you-work Today route projections', async () => {
        const [{ Encryption }, { encodeBase64 }, { sealEncryptedDataKeyEnvelopeV1 }, { createSessionFixture },
            { createPlainSessionWithDisplayRecordFixture }, { createAccountEncryptionCurrentnessFixtureForCredentials },
            { normalizeSessionAccessProjection }] = await Promise.all([
            import('@/sync/encryption/encryption'), import('@/encryption/base64'), import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1'),
            import('@/dev/testkit/fixtures/sessionFixtures'), import('@/dev/testkit/fixtures/sessionDisplayFixtures'),
            import('@/dev/testkit/fixtures/accountEncryptionCurrentness'),
            import('@/sync/engine/sessions/normalizeSessionAccessProjection'),
        ]);
        const nowMs = 1_710_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const id = 'how-today-opened';
        const secret = new Uint8Array(32).fill(7);
        const sessionKey = new Uint8Array(32).fill(9);
        const encryption = await Encryption.create(secret);
        await encryption.initializeSessions(new Map([[id, sessionKey]]));
        const { ownerMetadata: _owner, displayProjectionV1: _display, ...base } = createPlainSessionWithDisplayRecordFixture({ id, seq: 6 });
        const session = { ...base, metadataLayoutVersion: 0, encryptionMode: 'e2ee' as const,
            dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey,
                recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64'),
            metadata: await encryption.getSessionEncryption(id)!.encryptMetadata(createSessionFixture({ id }).metadata!), agentState: null };
        const credentials = { token: createServedHomeAccountToken('account-a'), secret: encodeBase64(secret, 'base64url') };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'e2ee' });
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-how-today-settled.test', accountId: 'account-a',
            credentials, accountMode: 'e2ee', encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v1/account/project-rows/list') return Response.json({ status: 'listed', coverage: 'complete', rows: [] });
                if (request.path === '/v2/usage/query') return Response.json(accounting);
                if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
                    const demand = UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!;
                    return Response.json({ requests: [{ query: demand.query, sessionIds: [id] }], results: [{ sessionId: id,
                        detail: { status: 200, body: { session } },
                        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [{
                            turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: nowMs - 900,
                            terminalAt: nowMs - 600, updatedAt: nowMs - 100,
                        }] } }, ...(demand.query.includeTranscriptEvidence ? { messages: { status: 200,
                            body: { messages: [], hasMore: false } } } : {}),
                    }] });
                }
                return artifacts.handle(request.url.toString(), { method: request.method, headers: request.headers,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) })
                    ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        let changeMetric: (metric: 'tokens' | 'cost') => void = () => {};
        function RoutePage() {
            const [metric, setMetric] = React.useState<'tokens' | 'cost'>('tokens');
            changeMetric = setMetric;
            return <UsageWidgetPage initialFilters={{ layoutId: 'how-you-work', period: 'today', metric, costMode: 'auto', focus: null }} />;
        }
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><RoutePage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const facts = () => screen.findAllByType(UsageRhythmWidget).map(node => node.props.slice.howYouWork?.intervals?.agentTimeMs);
        await waitForHomeGovernance(() => expect(facts()).toContain(300));
        await flushHookEffects({ cycles: 40 });
        const reads = () => home!.httpRequests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH);
        const admittedReads = reads().length;
        expect(admittedReads).toBeGreaterThan(0);
        // The ordinary Session hydration path can publish after Usage has
        // already opened the same server revision. Exercise its real store
        // action, without replacing any Resource or admission helper.
        await act(async () => getStorage().getState().applySessions([createSessionFixture({ id,
            serverId: server.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
            metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion,
            metadataLayoutVersion: session.metadataLayoutVersion, encryptionMode: session.encryptionMode,
            access: normalizeSessionAccessProjection(session) ?? undefined,
            sessionTurns: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [{
                turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: nowMs - 900,
                terminalAt: nowMs - 600, updatedAt: nowMs - 100,
            }] },
        })]));
        await flushHookEffects({ cycles: 40 });
        expect(facts()).toContain(300);
        expect(reads(), 'late local hydration of the already opened revision adds no evidence request').toHaveLength(admittedReads);
        for (const metric of ['cost', 'tokens'] as const) {
            await act(async () => changeMetric(metric));
            await flushHookEffects({ cycles: 40 });
            expect(facts()).toContain(300);
            expect(reads(), 'a new presentation of already opened unchanged Session facts adds no evidence request').toHaveLength(admittedReads);
        }
        const demands = reads().flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
        expect(demands.filter(demand => !demand.query.includeTranscriptEvidence)).toHaveLength(1);
        expect(demands.filter(demand => demand.query.includeTranscriptEvidence)).toHaveLength(1);
    });

    it('executes each real How you work body only for registration and content on a warm return', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(Math.floor(Date.now() / 60_000) * 60_000 + 1_000);
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-warm-body.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
                if (request.path === '/v2/usage/query') return Response.json(accounting);
                if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
                    const { requests } = UsageSessionEvidenceRequestSchema.parse(request.body);
                    return Response.json({ requests: requests.map(({ query, sessionIds }) => ({ query, sessionIds: sessionIds ?? [] })), results: [] });
                }
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            } });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let warmAcquisition: { reads: number; watches: number; confirmed: number } | undefined;
        const createStore = pluginResource.createPluginUiResourceStore;
        vi.spyOn(pluginResource, 'createPluginUiResourceStore').mockImplementation(input => {
            const { client } = input;
            const { readResource, watchResource } = client;
            const isUsage = (reference: Parameters<typeof readResource>[0]) =>
                typeof reference !== 'string' && 'hostRead' in reference && reference.hostRead === 'usage.query';
            return createStore({ ...input, client: { ...client,
                readResource(reference, options) {
                    if (warmAcquisition && isUsage(reference)) warmAcquisition.reads++;
                    return readResource(reference, options);
                },
                ...(watchResource ? { watchResource(reference: Parameters<typeof watchResource>[0],
                    listener: Parameters<typeof watchResource>[1], options?: Parameters<typeof watchResource>[2]) {
                    const observed = isUsage(reference) ? warmAcquisition : undefined;
                    if (observed) observed.watches++;
                    const result = watchResource(reference, listener, options);
                    if (observed) void result.then(admission => {
                        if (admission.admittedIdentity !== undefined) observed.confirmed++;
                    }, () => {});
                    return result;
                } } : {}),
            } });
        });
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><RoutedUsagePage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        await waitForHomeGovernance(() => {
            expect(screen.findAllByType(UsagePeriodSummaryWidget)[0]?.props.slice.accounting).toBeDefined();
        });
        const bodyModel = vi.spyOn(usageWidgetResource, 'useUsageWidgetBodyModel');
        const select = async (id: 'coach' | 'how-you-work') => {
            await act(async () => screen.findByType(WidgetAreaLayoutBar).props.onSelect(id));
            await waitForHomeGovernance(() => {
                expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe(id);
                const instances = screen.findAllByType(WidgetSurface).map(node => node.props.instance.id as string);
                expect(instances).toHaveLength(id === 'coach' ? 1 : 8);
                const models = new Map(bodyModel.mock.calls.map(([, instanceId], index) =>
                    [instanceId, bodyModel.mock.results[index]?.value] as const));
                for (const instanceId of instances)
                    expect(models.get(instanceId)).toMatchObject({ slice: expect.any(Object), pending: false, refreshing: false });
            });
            await flushHookEffects({ cycles: 4 });
        };
        await select('coach');
        await select('how-you-work');
        await select('coach');
        bodyModel.mockClear();
        const before = home.requests.length;
        warmAcquisition = { reads: 0, watches: 0, confirmed: 0 };
        await select('how-you-work');
        const reads = home.requests.slice(before).map(request => request.path).filter(path => path === '/v2/usage/query'
            || path === '/v2/usage/query-batch' || path === USAGE_SESSION_EVIDENCE_PATH);
        const phases = new Map<string, string[]>();
        bodyModel.mock.calls.forEach(([, id], index) => {
            const { requestedQuery, slice, pending, refreshing } = bodyModel.mock.results[index]!.value;
            const runs = phases.get(id) ?? [];
            runs.push(!requestedQuery ? 'registration' : pending || refreshing ? 'reading' : slice ? 'content' : 'unavailable');
            phases.set(id, runs);
        });
        expect(reads, 'returning to admitted facts makes no usage read').toEqual([]);
        expect(phases.size).toBe(8);
        expect(warmAcquisition, 'unchanged admitted content is reused by one live watch without a read')
            .toEqual({ reads: 0, watches: 1, confirmed: 1 });
        expect(Object.fromEntries([...phases].filter(([, runs]) => runs.length > 2 || runs.at(-1) !== 'content')),
            'each occurrence runs at most twice and settles on its admitted content').toEqual({});
    });

    it('follows the route-selected view and converges on the last selection', async () => {
        const observedAt = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(observedAt);
        let shownAccounting = accounting;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-view-paint.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse())
                : request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? Response.json(
                    UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.machineIds?.length ? shownAccounting : accounting)
                    : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let navigate: (id: string) => void = () => {};
        function RoutePage() {
            const [layoutId, setLayoutId] = React.useState('overview');
            navigate = setLayoutId;
            return <UsageWidgetPage initialFilters={{ layoutId, period: '7days', metric: 'cost', costMode: 'auto', focus: null,
                scope: { period: { relative: '7days' }, agents: [], machines: ['machine-a'], projects: [], sources: [], session: null, costBasis: 'auto' } }}
                onLayoutChange={setLayoutId} />;
        }
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><RoutePage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const widgetIds = () => screen.findAllByType(WidgetSurface).map(node => node.props.instance.id as string);
        await waitForHomeGovernance(() => expect(widgetIds().length).toBeGreaterThan(0));
        await flushHookEffects({ cycles: 40 });
        expect(home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch'),
            'Overview admits its visible widgets and inventory in one cold batch').toHaveLength(1);
        const overview = widgetIds();
        await act(async () => { screen.findByType(WidgetAreaLayoutBar).props.onSelect('costs'); });
        await vi.waitFor(() => expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe('costs'));
        await vi.waitFor(() => expect(widgetIds()).not.toEqual(overview));
        const costs = widgetIds();
        await vi.waitFor(() => expect(screen.findAllByType(UsageCostFactsWidget)[0]?.props.slice.accounting).toBeDefined());
        await flushHookEffects({ cycles: 40 });
        const admittedAccounting = screen.findAllByType(UsageCostFactsWidget)[0]!.props.slice.accounting;
        const models = vi.spyOn(usageAnalytics, 'buildUsageAnalyticsViewModel');
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query'
            || request.path === '/v2/usage/query-batch').length;
        // Route changes (history/deep links) and tab intents consume the same owner.
        await act(async () => { navigate('plans'); });
        await vi.waitFor(() => expect(widgetIds()).not.toEqual(costs));
        await flushHookEffects({ cycles: 40 });
        models.mockClear();
        const postsBeforeRevisit = posts();
        await act(async () => {
            const changes = [
                { kind: 'share', entityId: 'session-one', cursor: 12, changedAt: 1 },
                { kind: 'machineRecipientAccess', entityId: 'machine-one', cursor: 13, changedAt: 1 },
                { kind: 'account', entityId: 'self', cursor: 14, changedAt: 1, hint: { settingsVersion: 8758 } },
                { kind: 'session', entityId: 'session-one', cursor: 15, changedAt: 1, hint: { lastMessageSeq: 14 } },
            ] satisfies Parameters<typeof planSyncActionsFromChanges>[0];
            const planned = planSyncActionsFromChanges(changes, { afterCursor: 10, isSessionListMember: () => true });
            publishHomeAccountChange(server.id, changes.map(change => change.entityId), {
                changeKinds: changes.map(change => change.kind), usageQueryAffects: plannedChangesAffectUsageQuery(planned),
                usageAccountingAffects: plannedChangesAffectUsageAccounting(planned),
            });
        });
        await flushHookEffects({ cycles: 40 });
        await act(async () => { navigate('costs'); });
        await vi.waitFor(() => expect(widgetIds()).toEqual(costs));
        await vi.waitFor(() => expect(screen.findAllByType(UsageCostFactsWidget)[0]?.props.slice.accounting).toBeDefined());
        await flushHookEffects({ cycles: 40 });
        expect(posts() - postsBeforeRevisit, 'an unchanged route revisit creates no accounting request').toBe(0);
        expect(models, 'an unchanged route revisit builds no analytics models').toHaveBeenCalledTimes(0);
        expect(screen.findAllByType(UsageCostFactsWidget)[0]!.props.slice.accounting).toBe(admittedAccounting);
        models.mockRestore();
        // A displayed amount can change without changing the page's header,
        // cost choices, coverage or unfiltered scope inventory.
        // The header says its facts as one line, or as the one notice that replaces them.
        const headerFacts = () => screen.findByType(PageHeader).props.meta ?? screen.findByType(PageHeader).props.details;
        const beforeFacts = headerFacts();
        const beforeToolbar = screen.findByType(UsageFilterBar).props;
        shownAccounting = { ...accounting, totals: { ...totals, eventCount: 2 } };
        await act(async () => { await screen.findAllByType(UsageCostFactsWidget)[0]!.props.model.refresh(); });
        await vi.waitFor(() => expect(screen.findAllByType(UsageCostFactsWidget)[0]!.props.slice.accounting.totals.eventCount).toBe(2));
        expect(headerFacts(), 'unchanged page facts retain the header projection').toBe(beforeFacts);
        expect(screen.findByType(UsageFilterBar).props, 'body-only changes do not republish the page toolbar').toBe(beforeToolbar);
        clock.mockReturnValue(observedAt + 1_000);
        await act(async () => { await screen.findAllByType(UsageCostFactsWidget)[0]!.props.model.refresh(); });
        expect(headerFacts(), 'a raw as-of change within the displayed minute keeps the header projection').toBe(beforeFacts);
        expect(screen.findByType(UsageFilterBar).props).toBe(beforeToolbar);
        const beforeInventoryRefresh = posts();
        await act(async () => { publishHomeAccountChange(server.id, [], { usageAccountingChange: { sessionId: null } }); });
        await vi.waitFor(() => expect(posts()).toBeGreaterThan(beforeInventoryRefresh));
        await flushHookEffects({ cycles: 40 });
        expect(screen.findByType(UsageFilterBar).props, 'equal inventory and sub-minute as-of changes do not rerender page chrome').toBe(beforeToolbar);
        // A real header fact still reaches the mounted page.
        clock.mockReturnValue(observedAt + 60_000);
        await act(async () => { await screen.findAllByType(UsageCostFactsWidget)[0]!.props.model.refresh(); });
        await vi.waitFor(() => expect(headerFacts()).not.toEqual(beforeFacts));
        clock.mockRestore();
        await act(async () => {
            const select = screen.findByType(WidgetAreaLayoutBar).props.onSelect;
            select('costs'); select('coach');
        });
        await vi.waitFor(() => expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe('coach'));
        await vi.waitFor(() => expect(widgetIds().length > 0 && widgetIds().every(id => id.startsWith('coach:'))).toBe(true));
        const coach = widgetIds();
        await act(async () => { navigate('overview'); });
        await vi.waitFor(() => expect(widgetIds()).toEqual(overview));
        await act(async () => { navigate('coach'); });
        await vi.waitFor(() => expect(widgetIds()).toEqual(coach));
        expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe('coach');
    });
    it.each(['overview', 'work'])('admits the personalized %s once and selects from a closing menu across a page republish', async layoutId => {
        socketBoundary = installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary, {
            serverUrl: 'https://usage-page-layout-link.test', token: createServedHomeAccountToken('account-a'),
        });
        const selectedRoutes: string[] = [];
        let inventoryFails = layoutId === 'overview';
        const inventoryRead = createDeferred<void>();
        const inventoryStarted = createDeferred<void>();
        let artifact: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-page-layout-link.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse())
                : request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? Response.json(accounting)
                : request.path === '/v2/usage/query-batch' ? undefined
                // Refuse only the named-layout read; Account bootstrap must still establish a reachable Home.
                : request.path === '/v1/artifacts' && request.method === 'GET' && request.url.searchParams.get('kind') === 'widget_area_layout'
                    ? (inventoryStarted.resolve(), inventoryRead.promise.then(() => inventoryFails
                        ? Response.json({ error: 'database_transaction_timeout' }, { status: 503 })
                        : artifact?.request(request.url, { method: request.method })))
                    : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method })
                        ?? artifact?.request(request.url, { method: request.method }) });
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
        const screen = await renderMeasuredPage(<InjectedAuthProvider credentials={credentials}>
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
        // The owner request at 18:59Z requires navigable presets even before inventory settles.
        expect.soft(screen.findAllByType(WidgetAreaLayoutBar)).toHaveLength(1);
        expect.soft(screen.findByTestId('usage-views.loading')).toBeNull();
        inventoryRead.resolve();
        if (inventoryFails) {
            // The views' failure is said once, by the page header, not as a second failure line under it.
            await vi.waitFor(() => expect(screen.findHostByTestId('usage-page.header.viewsFailed')).not.toBeNull());
            await vi.waitFor(() => expect(screen.findByType(WidgetAreaLayoutBar).props.layouts.map((view: { id: string }) => view.id).sort())
                .toEqual([...USAGE_WIDGET_PRESET_IDS].sort()));
            expect(screen.findAllHostsByTestId('usage-views.readFailed')).toHaveLength(0);
            expect(screen.findByType(WidgetAreaLayoutBar).props.readFailure).toBeUndefined();
            expect(screen.findAllByType(WidgetSurface).map(node => node.props.instance.id)).toEqual(['work-only']);
            // The header's one Retry rereads the views: their own command, or the page Retry when a page read failed too.
            const retryCommand = reader!.readCurrentUiContext()!.commands.find(command =>
                command.title === `${t('usage.board.page.viewsLabel')}: ${t('common.retry')}`)
                ?? reader!.readCurrentUiContext()!.commands.find(command => command.title === t('usage.board.page.retryRead'));
            expect(retryCommand, `the visible view inventory Retry has a mounted command; published: ${reader!.readCurrentUiContext()!.commands
                .map(command => command.title).filter(title => title.includes(t('common.retry')) || title === t('usage.board.page.retryRead')).join(' | ')}; all: ${reader!.readCurrentUiContext()!.commands.length}; header: ${
                screen.findHostByTestId('usage-page.header.viewsFailed') ? 'views' : screen.findHostByTestId('usage-page.header.failed') ? 'failed' : 'none'}`).toBeDefined();
            inventoryFails = false;
            await act(async () => {
                expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
                    input: { commandId: retryCommand!.id }, context: { surface: 'agent' } })).toMatchObject({ ok: true });
            });
            await vi.waitFor(() => expect(screen.findHostByTestId('usage-page.header.viewsFailed')).toBeNull());
        }
        await vi.waitFor(() => expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe(layoutId));
        // A rendered preset is immediately available; its personal edited marker arrives with inventory.
        await vi.waitFor(() => expect(screen.findByType(WidgetAreaLayoutBar).props.layouts.find((view: { id: string }) => view.id === layoutId))
            .toMatchObject({ isPreset: true, edited: true }));
        const views = screen.findByType(WidgetAreaLayoutBar).props.layouts;
        expect(screen.findByType(WidgetAreaLayoutBar).props.actions).toBeNull();
        expect(views.find((view: { id: string }) => view.id === 'costs')).toMatchObject({ icon: 'currency-dollar' });
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
        let cost = totals.cost;
        let holdUsageReads = false;
        const heldUsageRead = createDeferred<void>();
        let holdLayoutReads = false;
        const heldLayoutRead = createDeferred<void>();
        const layoutReadStarted = createDeferred<void>();
        const accountingReads: ReturnType<typeof UsageAnalyticsQueryRequestSchema.parse>[] = [];
        let artifact: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | undefined;
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-page-filters.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse())
                : request.path === '/v2/usage/query-batch' ? undefined
                : request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v2/usage/query' ? (async () => {
                    if (holdUsageReads) await heldUsageRead.promise;
                    const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
                    accountingReads.push(query);
                    const select = <T extends { key: string }>(rows: readonly T[], selected: readonly string[], engine = false) =>
                        selected.length ? rows.filter(row => selected.includes(engine ? row.key.split(':')[0]! : row.key)) : rows;
                    return Response.json({ ...accounting, totals: { ...totals, cost }, breakdowns: {
                        machine: select(accounting.breakdowns!.machine!, query.filters?.machineIds ?? []),
                        source: select(accounting.breakdowns!.source!, query.filters?.sources ?? []),
                        project: select(accounting.breakdowns!.project!, query.filters?.projectKeys ?? []),
                    }, engineTimeline: accounting.engineTimeline!.map(bucket => ({ ...bucket, leaders: select(bucket.leaders, query.filters?.agentIds ?? [], true) })) });
                })()
                : holdLayoutReads && request.path.startsWith('/v1/artifacts') ? (async () => {
                    layoutReadStarted.resolve();
                    await heldLayoutRead.promise;
                    return artifact!.request(request.url, { method: request.method });
                })()
                : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method })
                    ?? artifact?.request(request.url, { method: request.method }) });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        getStorage().setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
            settingsScope: { serverId: server.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
        const surface: WidgetSurfaceRefV1 = { serverId: server.id, accountId: 'account-a',
            owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
        const followed = Object.fromEntries(['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis']
            .map(slot => [slot, { kind: 'context' as const, slot }]));
        const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, items: [
            { kind: 'group', id: 'pinned', context: { period: { kind: 'value', value: { startMs: 1000, endMs: 2000 } } }, children: [{ kind: 'widget', instance: { v: 1, id: 'pinned-body',
                definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: { ...followed,
                    metric: { kind: 'value', value: 'cost' }, breakdown: { kind: 'value', value: ['model'] } } } }] },
            { kind: 'group', id: 'following', children: [{ kind: 'widget', instance: { v: 1, id: 'following-body',
                definition: { kind: 'builtin', id: 'usage_period_summary' }, bindings: { ...followed,
                    metric: { kind: 'value', value: 'tokens' }, breakdown: { kind: 'value', value: ['agent'] } } } }] },
        ] });
        artifact = createLayoutArtifactHttpBoundary('account-a', { artifactId: buildWidgetSurfaceArtifactIdV1(surface),
            kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, defaultLayout: layout, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
            buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
        artifact.seed(layout);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let observePinnedBody: (() => void) | undefined;
        const screen = await renderMeasuredPage(<React.Profiler id="usage-pinned-body" onRender={() => observePinnedBody?.()}><InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentContextPort /><UsageWidgetPage />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider></React.Profiler>);
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        await flushHookEffects({ cycles: 40 });
        const published = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'ui' } });
        expect(published).toMatchObject({ ok: true, result: { entity: { kind: 'usage_summary' } } });
        const invoke = async (title: string, occurrence = 0) => {
            const descriptor = reader?.readCurrentUiContext()?.commands.filter(command => command.title === title)[occurrence];
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
        const invokeFilter = (field: string, value: string) => {
            const options: readonly { id: string; label: string }[] = chip(field).options;
            const index = options.findIndex(option => option.id === value);
            expect(index, `offered filter option: ${field}/${value}`).toBeGreaterThanOrEqual(0);
            const label = options[index]!.label;
            // Opaque Projects share a human fallback label; each option still owns its own command.
            const occurrence = options.slice(0, index).filter(option => option.label === label).length;
            return invoke(`${chip(field).label}: ${label}`, occurrence);
        };
        const snapshot = reader!.readCurrentUiContext()!;
        const toolbarTitles = ['agents', 'machines', 'projects', 'sources'].flatMap(field =>
            chip(field).options.map((option: { label: string }) => `${chip(field).label}: ${option.label}`));
        expect(snapshot.commands.map(command => command.title)).toEqual(expect.arrayContaining(toolbarTitles));
        expect(snapshot.commands.length).toBeGreaterThan(32);
        expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeGreaterThan(8_192);
        // Observe the query the real body consumes after platform binding and page clauses settle.
        const bodies = () => screen.findAllByType(UsagePeriodSummaryWidget).map(node => normalizeUsageQuery(node.props.query));
        await invokeFilter('machines', 'machine-23');
        await waitForHomeGovernance(() => expect(bodies().map(input => input.machines)).toEqual([['machine-23'], ['machine-23']]));
        await act(async () => { await chip('machines').onChange('machine-23'); });
        await flushHookEffects({ cycles: 30 });
        await act(async () => { await chip('projects').onChange('project-23'); });
        await flushHookEffects({ cycles: 30 });
        await waitForHomeGovernance(() => expect(bodies().map(input => input.projects)).toEqual([['project-23'], ['project-23']]));
        await invokeFilter('projects', 'project-23');
        await waitForHomeGovernance(() => expect(bodies().map(input => input.projects)).toEqual([[], []]));
        // UI scope intents must obey the same Action admission as agent commands.
        const settings = getStorage().getState().settings;
        const scope = { serverId: server.id, accountId: 'account-a' };
        const previousInputs = bodies();
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
        expect(bodies().map(input => input.agents)).toEqual([[], []]);
        expect(bodies()).toEqual(previousInputs);
        expect(screen.findByType(WidgetAreaLayoutBar).props.selectedId).toBe(previousLayout);
        await act(async () => { getStorage().getState().applySettingsForScope(scope, settings, 3); });
        await flushHookEffects({ cycles: 10 });
        // Losing the mounted dispatcher must not fall back to a raw page setter.
        unregister?.();
        await act(async () => { await chip('agents').onChange('claude'); });
        await flushHookEffects({ cycles: 10 });
        expect(bodies().map(input => input.agents)).toEqual([[], []]);
        const currentReader = reader!;
        unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            reader: currentReader, invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null,
        }));
        const oldId = await invokeFilter('agents', 'codex');
        expect(chip('agents').options.map((option: { id: string }) => option.id)).toEqual(expect.arrayContaining(['claude', 'codex', 'pi']));
        await act(async () => { await chip('agents').onChange('claude'); });
        await flushHookEffects({ cycles: 30 });
        await invokeFilter('machines', 'machine-a');
        await invokeFilter('sources', 'native');
        await invokeFilter('projects', 'project-a');
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
        await flushHookEffects({ cycles: 40 });
        const beforePeriodReads = accountingReads.length;
        holdLayoutReads = true;
        try {
            await invoke(t(getUsagePeriodDefinition('all').translationKey));
            await layoutReadStarted.promise;
            await flushHookEffects({ cycles: 30 });
            expect(shownQueries().find(query => query.metric === 'tokens')!.period).toEqual(previousFollowingPeriod);
            expect(accountingReads, 'pending layout admission must not acquire a mixed old-widget/new-page cohort').toHaveLength(beforePeriodReads);
        } finally {
            holdLayoutReads = false;
            await act(async () => { heldLayoutRead.resolve(); });
        }
        await flushHookEffects({ cycles: 30 });
        await waitForHomeGovernance(() => expect(shownQueries().find(query => query.metric === 'tokens')!.period).toEqual({ relative: 'all' }));
        await waitForHomeGovernance(() => expect(accountingReads.slice(beforePeriodReads).some(query => query.dateRange?.startMs === 0)).toBe(true));
        expect(accountingReads.slice(beforePeriodReads).every(query => (query.dateRange?.startMs ?? 0) <= 1000),
            'admitted All and pinned ranges must not acquire the obsolete page range').toBe(true);
        expect(shownQueries().find(query => query.metric === 'tokens')!.period).not.toEqual(previousFollowingPeriod);
        expect(shownQueries().find(query => query.metric === 'cost')).toMatchObject({
            period: { startMs: 1000, endMs: 2000 }, metric: 'cost', breakdown: [],
        });
        // Resume the existing day-granularity continuity journey after the All admission control.
        await invoke(t(getUsagePeriodDefinition('30days').translationKey));
        const allAgents = chip('agents').options[0].label;
        await invoke(`${chip('agents').label}: ${allAgents}`);
        await waitForHomeGovernance(() => expect(bodies().map(input => input.agents)).toEqual([[], []]));
        expect(bodies().every(input => input.machines[0] === 'machine-a')).toBe(true);
        await invokeFilter('agents', 'pi');
        await invokeFilter('agents', 'pi');
        await waitForHomeGovernance(() => expect(bodies().map(input => input.agents)).toEqual([[], []]));
        const retainedCommand = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: oldId }, context: { surface: 'ui' } });
        expect(retainedCommand).toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(bodies().map(input => input.agents)).toEqual([['codex'], ['codex']]));
        await invokeFilter('agents', 'codex');
        await waitForHomeGovernance(() => expect(bodies().map(input => input.agents)).toEqual([[], []]));
        // The first mounted body is pinned: changing only the page period must not
        // traverse its chart, ranked, or contribution rows just to name cost bases.
        await flushHookEffects({ cycles: 40 });
        const pinnedBody = () => screen.findAllByType(UsagePeriodSummaryWidget)
            .find(node => normalizeUsageQuery(node.props.query).metric === 'cost')!;
        const retainedAccounting: UsageAnalyticsQueryResponse = pinnedBody().props.slice.accounting;
        expect(screen.findByType(UsageFilterBar).props.costBasisOptions).toEqual(['auto', 'reported']);
        let rowReads = 0;
        const restoreRows: (() => void)[] = [];
        const observeRead = (target: object, field: string) => {
            const descriptor = Object.getOwnPropertyDescriptor(target, field);
            const value: unknown = Reflect.get(target, field);
            Object.defineProperty(target, field, { configurable: true, enumerable: descriptor?.enumerable ?? false,
                get: () => { rowReads += 1; return value; } });
            restoreRows.push(() => { if (descriptor) Object.defineProperty(target, field, descriptor); else Reflect.deleteProperty(target, field); });
        };
        // Header length reads and Resource reference reconciliation are legitimate.
        // Observe actual row content consumed by analytics/chart derivation instead.
        observeRead(retainedAccounting, 'series');
        for (const rows of Object.values(retainedAccounting.breakdowns ?? {})) {
            for (const row of rows ?? []) observeRead(row, 'tokens');
        }
        for (const bucket of retainedAccounting.engineTimeline ?? []) {
            for (const row of bucket.leaders) observeRead(row, 'tokens');
        }
        holdUsageReads = true;
        const committedAccounting: unknown[] = [];
        observePinnedBody = () => committedAccounting.push(pinnedBody()?.props.slice.accounting ?? null);
        try {
            await invoke(t(getUsagePeriodDefinition('7days').translationKey));
            expect(pinnedBody().props.slice.accounting).toBe(retainedAccounting);
            expect(committedAccounting.length).toBeGreaterThan(0);
            expect(committedAccounting.every(value => value === retainedAccounting),
                'a range change keeps the pinned body populated at every committed frame').toBe(true);
            expect(screen.findByType(UsageFilterBar).props.costBasisOptions).toEqual(['auto', 'reported']);
            expect(rowReads, 'page cost-basis choices do not traverse pinned accounting rows').toBe(0);
        } finally {
            observePinnedBody = undefined;
            restoreRows.forEach(restore => restore());
            holdUsageReads = false;
            heldUsageRead.resolve();
        }
        cost = { ...totals.cost, reportedUsd: 0, estimatedUsd: 2, apiEquivalentUsd: 3 };
        await act(async () => { await pinnedBody().props.model.refresh(); });
        await vi.waitFor(() => expect(screen.findByType(UsageFilterBar).props.costBasisOptions)
            .toEqual(['auto', 'estimated', 'api_equivalent']));
        const currentId = reader!.readCurrentUiContext()!.commands[0]!.id;
        await act(async () => retireActiveServerAccountScopeLifetime());
        const retired = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: currentId }, context: { surface: 'ui' } });
        expect(retired.ok).toBe(false);
    });
});
