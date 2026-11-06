import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen, standardCleanup, flushHookEffects, createDeferred } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { decodeUsageQueryResource, invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { normalizeUsageQuery, normalizeUsageQueryBatchInput, getUsageQueryBatchKey, getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { useUsageWidgetResource, useUsageWidgetBodyModel, type UsageWidgetResource, type UsageWidgetBodyModel } from './useUsageWidgetResource';
import type { UsageWidgetQueryPlan } from './usageWidgetQueries';
import { useUsageAnalyticsView } from './widgets/usageBodyKit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { WidgetFrameResourceActivityContext } from '@/components/widgets/frame/widgetFrameResourceActivity';
import { RankedRows } from '@happier-dev/plugin-ui/presentation';
import { UsageWidgetBody } from './widgets/UsageWidgetBody';
import { UsageBreakdownsWidget } from './widgets/UsageBreakdownsWidget';
import { UsageWidgetBatchProvider, useUsageWidgetModel, useUsageWidgetBatchInventorySlice, useUsageWidgetBatchSlices } from './widgets/usageWidgetBatch';
import { readUsageWidgetQueryOverrides } from './usageWidgetPageContext';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

// HTTP owns these fake Homes; real Socket.IO dials cannot supply their connection state.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
function plan(query: UsageQuery): UsageWidgetQueryPlan {
    const row = { query, key: getUsageQueryKey(query), resolution: { status: 'ready' as const, input: { metric: query.metric } } };
    const input = normalizeUsageQueryBatchInput({ queries: [query] });
    return { scope: { serverId: home!.homes.a!.id, accountId: 'account-a' },
        input, batchKey: getUsageQueryBatchKey(input), widgets: new Map([['first', row], ['second', row]]) };
}
async function mountHome(route: Parameters<typeof serveAccountHomes>[0]['route']) {
    const sessionBoundary = createSessionReadBatchHttpBoundary(route);
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-widgets.test', accountId: 'account-a' }],
        route: async request => await sessionBoundary.handle(request)
            ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.refreshSessions();
    await sync.refreshMachines();
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' },
        profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    return (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
}
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); invalidateUsageQueryResources(); await home?.dispose(); home = undefined; });

function BodyProbe(props: Readonly<{ resource: UsageWidgetResource; instanceId: string;
    onModel: (instanceId: string, model: UsageWidgetBodyModel) => void }>) {
    const model = useUsageWidgetBodyModel(props.resource, props.instanceId);
    props.onModel(props.instanceId, model);
    return null;
}

describe('Usage widget shared Resource selection', () => {
    it('withdraws a queued live replacement on hide while preserving the finite read already admitted', async () => {
        let amount = 1;
        const held = createDeferred<void>();
        const signals: (AbortSignal | null | undefined)[] = [];
        const credentials = await mountHome(async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            const observed = amount;
            signals.push(request.signal);
            await held.promise;
            return Response.json({ ...accounting, totals: { ...accounting.totals,
                cost: { ...accounting.totals.cost, reportedUsd: observed } } });
        });
        const queryPlan = plan(normalizeUsageQuery({ metric: 'cost', period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false }));
        let model: UsageWidgetBodyModel | undefined;
        function MountedPage() {
            model = useUsageWidgetBodyModel(useUsageWidgetResource({ credentials, enabled: true,
                plan: queryPlan, retainPendingDemand: true }), 'first');
            return null;
        }
        const page = (shown: boolean) => <PluginSurfaceFocusEligibilityProvider active={shown}><MountedPage /></PluginSurfaceFocusEligibilityProvider>;
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const screen = await renderScreen(page(true));
        try {
            await expect.poll(posts).toBe(1);
            amount = 2;
            await act(async () => { publishHomeAccountChange(home!.homes.a!.id, [], { changeKinds: ['account'],
                usageQueryAffects: true, usageAccountingChange: { sessionId: null } }); });
            await flushHookEffects({ cycles: 20 });
            await screen.update(page(false));
            held.resolve();
            await flushHookEffects({ cycles: 30 });
            expect(signals[0]?.aborted, 'withdrawal does not abort the admitted finite request').toBe(false);
            expect(posts(), 'the old live invalidation does not admit a deferred replacement while hidden').toBe(1);
            await screen.update(page(true));
            await expect.poll(() => model?.slice?.accounting?.totals.cost.reportedUsd).toBe(2);
            expect(posts(), 'showing admits the changed facts once').toBe(2);
        } finally { held.resolve(); await screen.unmount(); }
    });
    it.each(['inventory', 'chrome'] as const)('withdraws hidden page %s subscriptions before they can admit accounting', async consumer => {
        let amount = 1;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? Response.json({ ...accounting, totals: { ...accounting.totals,
                cost: { ...accounting.totals.cost, reportedUsd: amount } } }) : undefined);
        const query = normalizeUsageQuery({ metric: 'cost', period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false });
        const clauses = readUsageWidgetQueryOverrides(query);
        let selected: unknown;
        function Inventory() { selected = useUsageWidgetBatchInventorySlice(); return null; }
        function Chrome() { selected = useUsageWidgetBatchSlices(); return null; }
        const page = (shown: boolean) => <PluginSurfaceFocusEligibilityProvider active={shown}>
            <InjectedAuthProvider credentials={credentials}><UsageWidgetBatchProvider clauses={clauses}
                inventoryQuery={query} inventoryOnly>
                {consumer === 'inventory' ? <Inventory /> : <Chrome />}
            </UsageWidgetBatchProvider></InjectedAuthProvider>
        </PluginSurfaceFocusEligibilityProvider>;
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const screen = await renderScreen(page(false));
        try {
            await flushHookEffects({ cycles: 20 });
            expect.soft(posts(), 'hidden page chrome and inventory do not acquire cold accounting').toBe(0);
            await screen.update(page(true));
            await expect.poll(posts).toBe(1);
            await flushHookEffects({ cycles: 20 });
            const retained = selected;
            await screen.update(page(false));
            amount = 2;
            await act(async () => { publishHomeAccountChange(home!.homes.a!.id, [], { changeKinds: ['account'],
                usageQueryAffects: true, usageAccountingChange: { sessionId: null } }); });
            await flushHookEffects({ cycles: 20 });
            expect.soft(posts(), 'hidden page chrome and inventory admit no replacement').toBe(1);
            expect.soft(selected).toBe(retained);
        } finally { await screen.unmount(); }
    });
    it('withdraws live Usage demand while a mounted page is hidden and refreshes changed facts once when shown', async () => {
        let amount = 1;
        let held: ReturnType<typeof createDeferred<void>> | undefined;
        const signals: (AbortSignal | null | undefined)[] = [];
        const credentials = await mountHome(async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            const observed = amount;
            signals.push(request.signal);
            await held?.promise;
            return Response.json({ ...accounting, totals: { ...accounting.totals,
                cost: { ...accounting.totals.cost, reportedUsd: observed } } });
        });
        const query = normalizeUsageQuery({ metric: 'cost', period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false });
        const queryPlan = plan(query);
        let model: UsageWidgetBodyModel | undefined;
        function MountedPage() {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan, retainPendingDemand: true });
            model = useUsageWidgetBodyModel(resource, 'first');
            return null;
        }
        const page = (shown: boolean, focused = shown) => <PluginSurfaceFocusEligibilityProvider active={focused} presentationActive={shown}>
            <MountedPage />
        </PluginSurfaceFocusEligibilityProvider>;
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const push = () => publishHomeAccountChange(home!.homes.a!.id, [], { changeKinds: ['account'],
            usageQueryAffects: true, usageAccountingChange: { sessionId: null } });
        const screen = await renderScreen(page(false));
        try {
            await flushHookEffects({ cycles: 20 });
            expect.soft(posts(), 'a retained hidden page does not acquire its cold accounting').toBe(0);
            await screen.update(page(true));
            await expect.poll(() => model?.slice?.accounting?.totals.cost.reportedUsd).toBe(1);
            await expect.poll(() => model?.pending).toBe(false);
            const beforeUnfocused = posts();
            await screen.update(page(true, false));
            amount = 2;
            push();
            await expect.poll(() => model?.slice?.accounting?.totals.cost.reportedUsd).toBe(2);
            await expect.poll(() => model?.pending).toBe(false);
            expect(posts() - beforeUnfocused, 'a presented unfocused pane remains live').toBe(1);
            const beforeHide = posts();
            const retained = model!.slice;
            await screen.update(page(false));
            amount = 3;
            push();
            await flushHookEffects({ cycles: 20 });
            expect.soft(posts() - beforeHide, 'a genuine push demands no replacement on a hidden retained page').toBe(0);
            expect.soft(model!.slice, 'hidden facts remain the last presented facts').toBe(retained);
            await screen.update(page(true));
            await expect.poll(() => model?.slice?.accounting?.totals.cost.reportedUsd).toBe(3);
            await expect.poll(() => model?.pending).toBe(false);
            expect(posts() - beforeHide, 'showing the changed page admits one real replacement').toBe(1);
            held = createDeferred<void>();
            amount = 4;
            const beforePending = posts();
            let refresh: Promise<void> | undefined;
            await act(async () => { refresh = model!.refresh(); });
            await expect.poll(posts).toBe(beforePending + 1);
            const admittedSignal = signals.at(-1);
            await screen.update(page(false));
            amount = 5;
            push();
            held.resolve();
            held = undefined;
            await refresh;
            await flushHookEffects({ cycles: 20 });
            expect(admittedSignal?.aborted, 'hiding preserves finite work already admitted by the mounted page').toBe(false);
            expect(posts() - beforePending, 'a hidden push adds no follow-up to an admitted finite read').toBe(1);
            await screen.update(page(true));
            await expect.poll(() => model?.slice?.accounting?.totals.cost.reportedUsd).toBe(5);
            await expect.poll(() => model?.pending).toBe(false);
            expect(posts() - beforePending, 'showing after the hidden push reads current accounting once').toBe(2);
        } finally { held?.resolve(); await screen.unmount(); }
    });
    it('does not reparse an unchanged batch on a body rerender and still admits a changed plan', async () => {
        const credentials = await mountHome(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
        const first = plan(normalizeUsageQuery({ period: { startMs: 1000 } }));
        const second = plan(normalizeUsageQuery({ period: { startMs: 2000 } }));
        let firstReads = 0;
        let secondReads = 0;
        let periodReads = 0;
        const firstInput = new Proxy({ queries: first.input!.queries }, { ownKeys(target) { firstReads++; return Reflect.ownKeys(target); } });
        const secondInput = new Proxy({ queries: second.input!.queries }, { ownKeys(target) { secondReads++; return Reflect.ownKeys(target); } });
        const firstRow = first.widgets.get('first')!;
        const countedQuery = new Proxy(firstRow.query!, { get(target, property, receiver) {
            if (property === 'period') periodReads++;
            return Reflect.get(target, property, receiver);
        } });
        const firstPlan: UsageWidgetQueryPlan = { ...first, input: firstInput,
            widgets: new Map(first.widgets).set('first', { ...firstRow, query: countedQuery }) };
        const secondPlan: UsageWidgetQueryPlan = { ...second, input: secondInput };
        const hook = await renderHook(({ queryPlan }: { queryPlan: UsageWidgetQueryPlan }) => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return useUsageWidgetBodyModel(resource, 'first');
        }, { initialProps: { queryPlan: firstPlan }, flushOptions: { cycles: 20 } });
        await expect.poll(() => hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        const before = firstReads;
        await hook.rerender({ queryPlan: firstPlan });
        expect(firstReads - before, 'unchanged body rendering does not reparse every batch member').toBe(0);
        const beforePeriod = periodReads;
        await hook.rerender({ queryPlan: firstPlan });
        expect(periodReads - beforePeriod, 'unchanged body rendering does not rekey the prior period').toBe(0);
        await hook.rerender({ queryPlan: secondPlan });
        await expect.poll(() => hook.getCurrent().requestedQuery?.query.period).toEqual({ startMs: 2000 });
        expect(secondReads).toBeGreaterThan(0);
    });
    it('renders seven admitted fact bodies once on unchanged reopen while frame refresh activity remains truthful', async () => {
        let amount = 1;
        let held: ReturnType<typeof createDeferred<Response>> | undefined;
        const response = () => Response.json({ ...accounting, totals: { ...accounting.totals, eventCount: 6_933,
                cost: { ...accounting.totals.cost, reportedUsd: amount } },
                breakdowns: { agent: [{ key: 'codex', ...accounting.totals,
                    cost: { ...accounting.totals.cost, reportedUsd: amount } }] } });
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held ? held.promise.then(value => value.clone()) : response() : undefined);
        const input = { metric: 'cost', period: { startMs: 1_000, endMs: 2_000 }, breakdown: ['agent'] };
        const clauses = readUsageWidgetQueryOverrides(normalizeUsageQuery({ granularity: 'day', timeZoneOffsetMinutes: 0 }));
        const bodyIds = Array.from({ length: 7 }, (_, index) => `fact-${index}`);
        const views = new Set<NonNullable<ReturnType<typeof useUsageAnalyticsView>>>();
        let selected: UsageWidgetBodyModel | undefined;
        const activity: boolean[] = [];
        const reportActivity = (_key: symbol, refreshing: boolean) => { activity.push(refreshing); };
        function ObserveView(props: Readonly<{ model: UsageWidgetBodyModel; query: UsageQuery }>) {
            const view = useUsageAnalyticsView(props.model.slice!, props.query);
            if (view) views.add(view);
            return null;
        }
        function ObserveFacts() {
            const { model, query } = useUsageWidgetModel(input, 'usage_breakdowns');
            selected = model;
            return model.slice && query ? <ObserveView model={model} query={query} /> : null;
        }
        function Page(props: Readonly<{ visible: boolean; style?: string }>) {
            return <InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
                <WidgetFrameResourceActivityContext.Provider value={reportActivity}>
                    {props.visible ? <UsageWidgetBatchProvider clauses={clauses}>
                        {bodyIds.map(id => <UsageWidgetBody key={id} id="usage_breakdowns"
                            input={{ ...input, ...(props.style ? { style: props.style } : {}) }}
                            serverId={home!.homes.a!.id} testID={id} />)}
                        <ObserveFacts />
                    </UsageWidgetBatchProvider> : null}
                </WidgetFrameResourceActivityContext.Provider>
            </CoreCollectionScope></InjectedAuthProvider>;
        }
        const screen = await renderScreen(<Page visible={false} />);
        // React instrumentation boundary: use the browser probe's PerformedWork +
        // alternate-identity rule, observing real fact component executions.
        type Fiber = { type: unknown; flags: number; alternate: Fiber | null; return: Fiber | null;
            child: Fiber | null; sibling: Fiber | null; stateNode: { current: Fiber } | null;
            memoizedProps: { testID?: string } };
        const current = new WeakMap<Fiber, boolean>();
        const renders = new Map<string, number>();
        const observeCommit = () => {
            let root = (screen.root as unknown as { _fiber: Fiber })._fiber;
            while (root.return) root = root.return;
            const stack = [root.stateNode!.current];
            while (stack.length) {
                const fiber = stack.pop()!;
                if (fiber.type === UsageBreakdownsWidget && current.get(fiber) !== true
                    && (!fiber.alternate || (fiber.flags & 1) === 1)) {
                    const id = fiber.memoizedProps.testID!;
                    renders.set(id, (renders.get(id) ?? 0) + 1);
                }
                current.set(fiber, true);
                if (fiber.alternate) current.set(fiber.alternate, false);
                if (fiber.sibling) stack.push(fiber.sibling);
                if (fiber.child) stack.push(fiber.child);
            }
        };
        const release = screen.subscribe(observeCommit);
        const values = () => screen.findAllByType(RankedRows).flatMap(row =>
            row.props.rows.filter((entry: { id: string }) => entry.id === 'codex').map((entry: { value: number }) => entry.value));
        const settled = () => selected?.pending === false && values().length === bodyIds.length
            && values().every(value => value === amount);
        const totalRenders = () => [...renders.values()].reduce((sum, count) => sum + count, 0);
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        try {
            await screen.update(<Page visible />);
            await expect.poll(settled).toBe(true);
            await flushHookEffects({ cycles: 20 });
            expect([...renders.keys()].sort(), 'the probe observes all seven real fact bodies').toEqual(bodyIds);
            const retainedAccounting = selected!.slice!.accounting;
            const builtViews = views.size;
            expect(builtViews).toBe(1);
            const baselinePosts = posts();
            await screen.update(<Page visible={false} />);
            const beforeReopen = totalRenders();
            activity.length = 0;
            await screen.update(<Page visible />);
            await expect.poll(settled).toBe(true);
            await flushHookEffects({ cycles: 20 });
            const reopenRenders = totalRenders() - beforeReopen;
            expect(selected!.slice!.accounting).toBe(retainedAccounting);
            expect(posts()).toBe(baselinePosts);
            expect(views.size - builtViews).toBe(0);
            expect(activity.at(-1)).toBe(false);
            console.info('usage-real-fact-render-counts', { visibleBodies: bodyIds.length, reopenRenders,
                unchangedNewModels: views.size - builtViews, unchangedPosts: posts() - baselinePosts });
            const beforeChange = new Map(renders);
            amount = 2;
            held = createDeferred<Response>();
            activity.length = 0;
            let refreshing: Promise<void> | undefined;
            await act(async () => { refreshing = selected!.refresh(); });
            await expect.poll(() => activity.includes(true)).toBe(true);
            await flushHookEffects({ cycles: 20 });
            expect(values()).toEqual(bodyIds.map(() => 1));
            const pendingRenders = totalRenders() - [...beforeChange.values()].reduce((sum, count) => sum + count, 0);
            const beforeData = new Map(renders);
            await act(async () => { held!.resolve(response()); await refreshing; });
            await expect.poll(settled).toBe(true);
            await flushHookEffects({ cycles: 20 });
            expect(activity.at(-1)).toBe(false);
            expect(views.size - builtViews).toBe(1);
            expect(posts()).toBeGreaterThan(baselinePosts);
            for (const id of bodyIds) expect(renders.get(id)! - beforeChange.get(id)!, id).toBeGreaterThan(0);
            expect(reopenRenders, 'unchanged source lifecycle adds no fact renders beyond the seven mounts').toBe(bodyIds.length);
            expect(pendingRenders, 'each body renders its actual accounting-source coverage transition').toBe(bodyIds.length);
            for (const id of bodyIds) expect(renders.get(id)! - beforeData.get(id)!, id).toBe(1);
            console.info('usage-real-fact-change-counts', { visibleBodies: bodyIds.length, pendingRenders,
                replacementRenders: totalRenders() - [...beforeData.values()].reduce((sum, count) => sum + count, 0),
                changedNewModels: views.size - builtViews });
        } finally { held?.resolve(response()); release(); await screen.unmount(); }
    });
    it('keeps admitted accounting available to seven mounted bodies while their query batch expands and reopens', async () => {
        let amount = 1;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? Response.json({ ...accounting, totals: { ...accounting.totals,
                eventCount: 6_933, cost: { ...accounting.totals.cost, reportedUsd: amount } } }) : undefined);
        const query = normalizeUsageQuery({ metric: 'cost', period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false });
        const sibling = normalizeUsageQuery({ ...query, includeTranscriptEvidence: true });
        const bodyIds = Array.from({ length: 7 }, (_, index) => `body-${index}`);
        const makePlan = (expanded: boolean): UsageWidgetQueryPlan => ({ ...plan(query),
            input: { queries: expanded ? [query, sibling] : [query] },
            batchKey: getUsageQueryBatchKey({ queries: expanded ? [query, sibling] : [query] }),
            widgets: new Map(bodyIds.map((id, index) => {
                const selected = expanded && index === bodyIds.length - 1 ? sibling : query;
                return [id, { query: selected, key: getUsageQueryKey(selected),
                    resolution: { status: 'ready' as const, input: {} } }] as const;
            })) });
        const models = new Map<string, UsageWidgetBodyModel>();
        const views = new Set<NonNullable<ReturnType<typeof useUsageAnalyticsView>>>();
        const publications: Array<Readonly<{ pending: string; freshness: string; accounting: readonly string[] }>> = [];
        let renders = 0;
        let resource: UsageWidgetResource | undefined;
        function Projection(props: Readonly<{ model: UsageWidgetBodyModel }>) {
            const view = useUsageAnalyticsView(props.model.slice!, props.model.shownQuery?.query ?? query);
            if (view) views.add(view);
            return <>{props.model.slice!.accounting?.totals.cost.reportedUsd}</>;
        }
        function Consumer(props: Readonly<{ instanceId: string }>) {
            const model = useUsageWidgetBodyModel(resource!, props.instanceId);
            models.set(props.instanceId, model);
            renders++;
            return model.slice ? <Projection model={model} /> : null;
        }
        function Page(props: Readonly<{ expanded: boolean }>) {
            resource = useUsageWidgetResource({ credentials, enabled: true, plan: makePlan(props.expanded) });
            const entry = resource.entry;
            // Observe after the body subscriptions establish their real live
            // demand; this probe must not start a competing static baseline.
            React.useEffect(() => entry?.subscribe(() => {
                const snapshot = entry.getSnapshot();
                publications.push({ pending: snapshot.pending, freshness: snapshot.freshness,
                    accounting: snapshot.value ? decodeUsageQueryResource(snapshot.value).results.flatMap(slice =>
                        slice.sources.filter(source => source.source === 'accounting').map(source => source.status)) : [] });
            }, false), [entry]);
            return <>{bodyIds.map(id => <Consumer key={id} instanceId={id} />)}</>;
        }
        const screen = await renderScreen(<Page expanded={false} />);
        const settled = () => bodyIds.every(id => models.get(id)?.pending === false
            && models.get(id)?.slice?.accounting?.totals.cost.reportedUsd === amount);
        await expect.poll(settled).toBe(true);
        await flushHookEffects({ cycles: 20 });
        const retainedAccounting = models.get(bodyIds[0]!)!.slice!.accounting;
        const builtViews = views.size;
        expect(builtViews, 'the seven Costs consumers share one initial analytics model').toBe(1);
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const beforePosts = posts();
        const beforeRenders = renders;
        publications.length = 0;
        await screen.update(<Page expanded />);
        await expect.poll(settled).toBe(true);
        await flushHookEffects({ cycles: 20 });
        expect(publications.flatMap(snapshot => snapshot.accounting).filter(status => status === 'pending'),
            'joining an admitted answer never republishes accounting acquisition to mounted bodies').toHaveLength(0);
        expect(posts()).toBe(beforePosts);
        expect(views.size - builtViews, 'batch expansion retains the Costs analytics model').toBe(0);
        for (const model of models.values()) expect(model.slice!.accounting).toBe(retainedAccounting);
        const expansionRenders = renders - beforeRenders;
        const expansionPublications = publications.length;
        const retainedContent = resource!.entry!.getSnapshot().value;
        await screen.unmount();
        const beforeReopenRenders = renders;
        publications.length = 0;
        const reopened = await renderScreen(<Page expanded />);
        await expect.poll(settled).toBe(true);
        await flushHookEffects({ cycles: 20 });
        expect(resource!.entry!.getSnapshot().value).toBe(retainedContent);
        expect(posts()).toBe(beforePosts);
        expect(views.size - builtViews, 'unchanged reopen builds zero new Costs analytics models').toBe(0);
        expect(publications.flatMap(snapshot => snapshot.accounting).filter(status => status === 'pending')).toHaveLength(0);
        const reopenRenders = renders - beforeReopenRenders;
        const reopenPublications = publications.map(({ pending, freshness }) => ({ pending, freshness }));
        const unchangedNewModels = views.size - builtViews;
        amount = 2;
        await act(async () => { await models.get(bodyIds[0]!)!.refresh(); });
        await expect.poll(settled).toBe(true);
        await flushHookEffects({ cycles: 20 });
        expect(views.size - builtViews, 'one real accounting replacement builds one shared Costs analytics model').toBe(1);
        expect(models.get(bodyIds[0]!)!.slice!.accounting).not.toBe(retainedAccounting);
        expect(reopened.getTextContent()).toContain('2');
        expect(posts()).toBeGreaterThan(beforePosts);
        console.info('usage-mounted-cost-counts', { visibleBodies: bodyIds.length, expansionRenders,
            expansionPublications, reopenRenders, reopenPublications, unchangedNewModels, changedNewModels: views.size - builtViews });
        await reopened.unmount();
    });
    it('selects unchanged body semantics across the pending producer retry on seven-consumer reopen', async () => {
        let amount = 1;
        let nativePending = true;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? Response.json({ ...accounting, totals: { ...accounting.totals,
                cost: { ...accounting.totals.cost, reportedUsd: amount } }, coverage: {
                status: 'partial', reasons: [], sources: [{ source: 'native-history', path: 'native',
                    status: nativePending ? 'pending' : 'available', eventCount: 1 }],
                missingDimensions: [], range: { complete: false }, ranked: [],
            } }) : undefined);
        const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false });
        const bodyIds = Array.from({ length: 7 }, (_, index) => `semantic-${index}`);
        const queryPlan: UsageWidgetQueryPlan = { ...plan(query), widgets: new Map(bodyIds.map(id =>
            [id, plan(query).widgets.get('first')!] as const)) };
        const models = new Map<string, UsageWidgetBodyModel>();
        const views = new Set<NonNullable<ReturnType<typeof useUsageAnalyticsView>>>();
        const publications: string[] = [];
        let renders = 0;
        let resource: UsageWidgetResource | undefined;
        function Projection({ model }: Readonly<{ model: UsageWidgetBodyModel }>) {
            const view = useUsageAnalyticsView(model.slice!, query);
            if (view) views.add(view);
            return <>{model.slice?.accounting?.totals.cost.reportedUsd}</>;
        }
        function Consumer({ id }: Readonly<{ id: string }>) {
            const model = useUsageWidgetBodyModel(resource!, id);
            models.set(id, model);
            renders++;
            return model.slice ? <Projection model={model} /> : null;
        }
        function Page() {
            resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            const entry = resource.entry;
            React.useEffect(() => entry?.subscribe(() => {
                const snapshot = entry.getSnapshot();
                publications.push(`${snapshot.pending}:${snapshot.freshness}`);
            }, false), [entry]);
            return <>{bodyIds.map(id => <Consumer key={id} id={id} />)}</>;
        }
        const admitted = () => models.size === bodyIds.length && [...models.values()].every(model =>
            model.slice?.accounting?.totals.cost.reportedUsd === amount);
        const screen = await renderScreen(<Page />);
        await expect.poll(admitted).toBe(true);
        await expect.poll(() => resource!.entry!.getSnapshot().pending).toBe('idle');
        await flushHookEffects({ cycles: 20 });
        const slice = models.get(bodyIds[0]!)!.slice;
        for (const model of models.values()) {
            expect(model.pending).toBe(true);
            expect(model.refreshing).toBe(false);
            expect(model.freshness).toBe('stale');
            expect(model.error?.code).toBe('no_connected_accounts');
        }
        const builtViews = views.size;
        expect(builtViews).toBe(1);
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const beforePosts = posts();
        await screen.unmount();
        const beforeRenders = renders;
        publications.length = 0;
        const reopened = await renderScreen(<Page />);
        await expect.poll(() => resource!.entry!.getSnapshot().pending).toBe('idle');
        await flushHookEffects({ cycles: 30 });
        const reopenRenders = renders - beforeRenders;
        for (const model of models.values()) {
            expect(model.slice).toBe(slice);
            expect(model.pending).toBe(true);
            expect(model.refreshing).toBe(false);
            expect(model.freshness).toBe('stale');
            expect(model.error?.code).toBe('no_connected_accounts');
        }
        expect(posts()).toBe(beforePosts);
        expect(views.size).toBe(builtViews);
        console.info('usage-semantic-reopen-counts', { visibleBodies: bodyIds.length, reopenRenders,
            publications, unchangedNewModels: views.size - builtViews, unchangedPosts: posts() - beforePosts });
        expect(reopenRenders, 'unchanged model semantics render only the seven mandatory remounts').toBe(bodyIds.length);
        amount = 2;
        nativePending = false;
        await act(async () => { await models.get(bodyIds[0]!)!.refresh(); });
        await expect.poll(admitted).toBe(true);
        await expect.poll(() => [...models.values()].every(model => !model.pending)).toBe(true);
        expect(views.size - builtViews, 'one accounting replacement reaches all consumers through one shared model').toBe(1);
        expect(reopened.getTextContent()).toContain('2');
        expect(posts()).toBeGreaterThan(beforePosts);
        await reopened.unmount();
    });
    it('does not add store-driven body renders when equivalent query objects replace a settled plan', async () => {
        const credentials = await mountHome(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
        const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 },
            includeSessionEvidence: false, includeWorkEvidence: false });
        const bodyIds = Array.from({ length: 7 }, (_, index) => `body-${index}`);
        const makePlan = (): UsageWidgetQueryPlan => ({ ...plan(query), widgets: new Map(bodyIds.map(id => {
            const equivalent = normalizeUsageQuery(query);
            return [id, { query: equivalent, key: getUsageQueryKey(equivalent), resolution: { status: 'ready' as const, input: {} } }] as const;
        })) });
        const models = new Map<string, UsageWidgetBodyModel>();
        let renders = 0;
        let resource: UsageWidgetResource | undefined;
        const onModel = (id: string, model: UsageWidgetBodyModel) => { models.set(id, model); renders++; };
        function Page(props: Readonly<{ queryPlan: UsageWidgetQueryPlan }>) {
            resource = useUsageWidgetResource({ credentials, enabled: true, plan: props.queryPlan });
            return <>{bodyIds.map(id => <BodyProbe key={id} resource={resource!} instanceId={id} onModel={onModel} />)}</>;
        }
        const screen = await renderScreen(<Page queryPlan={makePlan()} />);
        await expect.poll(() => models.get(bodyIds[0]!)?.pending).toBe(false);
        await expect.poll(() => models.get(bodyIds[0]!)?.slice?.accounting).toMatchObject(accounting);
        await flushHookEffects({ cycles: 20 });
        const baseline = renders;
        const entry = resource!.entry;
        let publications = 0;
        const release = entry!.subscribe(() => { publications++; }, false);
        try {
            await screen.update(<Page queryPlan={makePlan()} />);
            await flushHookEffects({ cycles: 20 });
            expect(resource!.entry).toBe(entry);
            expect(publications, 'equivalent plan does not publish Resource activity').toBe(0);
            expect(renders - baseline, 'each visible body renders only for the parent update').toBe(bodyIds.length);
        } finally { release(); }
    });
    it('keeps settled allowance bodies quiet through accounting-only pushes in a mixed page batch', async () => {
        let amount = 1;
        let held: ReturnType<typeof createDeferred<Response>> | undefined;
        const response = () => Response.json({ ...accounting, totals: { ...accounting.totals, eventCount: amount } });
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held ? held.promise.then(value => value.clone()) : response() : undefined);
        const recorded = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeWorkEvidence: false, includeComparison: false });
        const allowance = normalizeUsageQuery({ ...recorded, includeAccounting: false });
        const input = normalizeUsageQueryBatchInput({ queries: [recorded, allowance] });
        const queryPlan = { ...plan(recorded), input, batchKey: getUsageQueryBatchKey(input), widgets: new Map([
            ['first', plan(recorded).widgets.get('first')!], ['second', plan(allowance).widgets.get('second')!],
        ]) };
        const models = new Map<string, UsageWidgetBodyModel>();
        const renders = new Map<string, number>();
        const onModel = (id: string, model: UsageWidgetBodyModel) => {
            models.set(id, model); renders.set(id, (renders.get(id) ?? 0) + 1);
        };
        function Page() {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return <>{['first', 'second'].map(id => <BodyProbe key={id} resource={resource} instanceId={id} onModel={onModel} />)}</>;
        }
        await renderScreen(<Page />);
        await expect.poll(() => models.get('first')?.pending).toBe(false);
        await flushHookEffects({ cycles: 20 });
        const retained = models.get('second')!.slice;
        expect(retained).not.toBeNull();
        const before = renders.get('second');
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const initialPosts = posts();
        try {
            for (amount = 2; amount <= 3; amount++) {
                held = createDeferred<Response>();
                const beforePosts = posts();
                await act(async () => { publishHomeAccountChange(home!.homes.a!.id, [], {
                    changeKinds: ['account'], usageQueryAffects: true,
                    usageAccountingChange: { sessionId: null, observedFromMs: 1500 },
                }); });
                await expect.poll(posts).toBeGreaterThan(beforePosts);
                await flushHookEffects({ cycles: 20 });
                expect.soft(models.get('second')?.pending, 'another source does not make admitted allowance pending').toBe(false);
                expect.soft(models.get('second')?.refreshing, 'another source does not refresh admitted allowance').toBe(false);
                await act(async () => { held!.resolve(response()); });
                await expect.poll(() => models.get('first')?.slice?.accounting?.totals.eventCount).toBe(amount);
                await expect.poll(() => models.get('first')?.pending).toBe(false);
            }
            await flushHookEffects({ cycles: 20 });
            expect(models.get('second')?.slice).toBe(retained);
            expect(renders.get('second')! - before!, 'accounting-only arrivals publish no changed allowance model').toBe(0);
            expect(posts()).toBeGreaterThan(initialPosts);
        } finally { held?.resolve(response()); }
    });
    it('keeps a settled sibling body and its model work stable through another query progress, while forwarding its own activity and authority loss', async () => {
        const slowAccounting = createDeferred<Response>();
        const slowDetail = createDeferred<Response>();
        let detailIssued = false;
        let denied = false;
        const credentials = await mountHome(request => {
            if (request.path === '/v2/usage/query') {
                if (denied) return Response.json({ error: 'forbidden' }, { status: 403 });
                const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
                return query.filters?.sessionIds?.includes('slow-session') ? slowAccounting.promise : Response.json(accounting);
            }
            if (request.path === '/v2/sessions/slow-session') { detailIssued = true; return slowDetail.promise; }
            return undefined;
        });
        const first = normalizeUsageQuery({ session: 'settled-session', period: { startMs: 0, endMs: 1000 },
            includeSessionEvidence: false, includeWorkEvidence: false });
        const second = normalizeUsageQuery({ ...first, session: 'slow-session', includeSessionEvidence: true });
        const queryPlan = { ...plan(first), input: { queries: [first, second] },
            batchKey: getUsageQueryBatchKey({ queries: [first, second] }), widgets: new Map([
            ['first', plan(first).widgets.get('first')!], ['second', plan(second).widgets.get('second')!],
        ]) };
        const models = new Map<string, UsageWidgetBodyModel>();
        const computations = new Map<string, number>();
        const commits = new Map<string, number>();
        const onModel = (id: string, model: UsageWidgetBodyModel) => {
            models.set(id, model); computations.set(id, (computations.get(id) ?? 0) + 1);
        };
        const onRender: React.ProfilerOnRenderCallback = id => { commits.set(id, (commits.get(id) ?? 0) + 1); };
        function Page() {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return <>{['first', 'second'].map(id => <React.Profiler key={id} id={id} onRender={onRender}>
                <BodyProbe resource={resource} instanceId={id} onModel={onModel} />
            </React.Profiler>)}</>;
        }
        await renderScreen(<Page />);
        try {
            await expect.poll(() => models.get('first')?.slice?.accounting).toMatchObject(accounting);
            await flushHookEffects({ cycles: 20 });
            const settledSlice = models.get('first')!.slice;
            const baseline = { computations: computations.get('first'), commits: commits.get('first') };
            const secondComputations = computations.get('second')!;
            const withDetail: UsageAnalyticsQueryResponse = { ...accounting, contributions: [{ id: 'fact', observedAtMs: 500,
                sessionId: 'slow-session', turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null,
                workspaceId: null, source: null, tokens: accounting.totals.tokens, cost: accounting.totals.cost }] };
            await act(async () => { slowAccounting.resolve(Response.json(withDetail)); });
            await expect.poll(() => detailIssued).toBe(true);
            await expect.poll(() => models.get('second')?.slice?.accounting).toMatchObject({ v: 1, totals: withDetail.totals });
            expect(models.get('second')?.slice?.accounting?.contributions).toBeUndefined();
            await flushHookEffects({ cycles: 20 });
            expect(models.get('first')!.slice).toBe(settledSlice);
            expect(computations.get('first')).toBe(baseline.computations);
            expect(commits.get('first')).toBe(baseline.commits);
            expect(computations.get('second')).toBeGreaterThan(secondComputations);
            expect(models.get('second')!.pending).toBe(true);
            expect(models.get('second')!.refreshing).toBe(false);
            await act(async () => { slowDetail.resolve(Response.json({ error: 'not_found' }, { status: 404 })); });
            await expect.poll(() => models.get('second')!.pending).toBe(false);
            expect(models.get('first')!.pending).toBe(false);
            expect(models.get('first')!.slice).toBe(settledSlice);
            denied = true;
            await act(async () => { await models.get('first')!.refresh(); });
            await flushHookEffects({ cycles: 20 });
            for (const model of models.values()) {
                expect(model.slice).toBeNull();
                expect(model.shownQuery).toBeNull();
                expect(model.error).toBeTruthy();
            }
        } finally {
            slowAccounting.resolve(Response.json(accounting));
            slowDetail.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
        }
    });
    it('exposes source-only initial progress to page chrome while bodies retain their first-read placeholder', async () => {
        const held = createDeferred<Response>();
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held.promise.then(response => response.clone()) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, includeSessionEvidence: true, includeWorkEvidence: false }));
        const hook = await renderHook(() => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return { resource, model: useUsageWidgetBodyModel(resource, 'first') };
        });
        try {
            await expect.poll(() => hook.getCurrent().resource.entry?.getSnapshot().value !== undefined).toBe(true);
            const content = hook.getCurrent().resource.entry!.getSnapshot().value!;
            expect(decodeUsageQueryResource(content).results[0]?.sources).toEqual(expect.arrayContaining([
                { source: 'accounting', status: 'pending' }, { source: 'how_you_work', status: 'pending' },
            ]));
            expect(hook.getCurrent().model.slice).toBeNull();
            expect(hook.getCurrent().model.pending).toBe(true);
            await act(async () => { held.resolve(Response.json(accounting)); });
            await flushHookEffects({ cycles: 30 });
            expect(hook.getCurrent().model.slice?.accounting?.totals).toEqual(accounting.totals);
        } finally { held.resolve(Response.json(accounting)); }
    });
    it('does not relabel a foreign Account query intent as the current Account read', async () => {
        const credentials = await mountHome(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, granularity: 'day' }));
        const foreign = { ...queryPlan, scope: { ...queryPlan.scope, accountId: 'account-b' } };
        const hook = await renderHook(() => useUsageWidgetBodyModel(
            useUsageWidgetResource({ credentials, enabled: true, plan: foreign }), 'first'),
        { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice).toBeNull();
        expect(hook.getCurrent().requestedQuery).toBeNull();
    });

    it('shares the exact slice between widget bodies and removes it on Home authority refusal', async () => {
        let denied = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? denied ? Response.json({ error: 'forbidden' }, { status: 403 }) : Response.json(accounting) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, granularity: 'day' }));
        const hook = await renderHook(() => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return { first: useUsageWidgetBodyModel(resource, 'first'), second: useUsageWidgetBodyModel(resource, 'second') };
        }, { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().first.slice?.accounting).toMatchObject(accounting);
        expect(hook.getCurrent().second.slice).toBe(hook.getCurrent().first.slice);
        denied = true;
        await act(async () => { await hook.getCurrent().first.refresh(); });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().first.slice).toBeNull();
        expect(hook.getCurrent().first.shownQuery).toBeNull();
        expect(hook.getCurrent().first.error).toBeTruthy();
    });

    it('shows a named previous period only, drops a basis change, and ignores late completion after retirement', async () => {
        const delayed = createDeferred<Response>();
        let held = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held ? delayed.promise : Response.json(accounting) : undefined);
        const hook = await renderHook(({ startMs, costBasis }: { startMs: number; costBasis: 'auto' | 'reported' }) => {
            const resource = useUsageWidgetResource({ credentials, enabled: true,
                plan: plan(normalizeUsageQuery({ period: { startMs }, granularity: 'day', costBasis })) });
            return useUsageWidgetBodyModel(resource, 'first');
        }, { initialProps: { startMs: 1000, costBasis: 'auto' }, flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        held = true;
        await hook.rerender({ startMs: 2000, costBasis: 'auto' });
        expect(hook.getCurrent().updatingPreviousPeriod).toBe(true);
        expect(hook.getCurrent().shownQuery?.query.period).toEqual({ startMs: 1000 });
        expect(hook.getCurrent().requestedQuery?.query.period).toEqual({ startMs: 2000 });
        await hook.rerender({ startMs: 2000, costBasis: 'reported' });
        expect(hook.getCurrent().slice).toBeNull();
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); delayed.resolve(Response.json(accounting)); });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().slice).toBeNull();
        expect(hook.getCurrent().requestedQuery).toBeNull();
    });

    it('says shown facts are being re-read only while their own read is in flight, not while another source is outstanding', async () => {
        const delayed = createDeferred<Response>();
        let held = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held ? delayed.promise : Response.json(accounting) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, granularity: 'day' }));
        const hook = await renderHook(() => useUsageWidgetBodyModel(
            useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan }), 'first'),
        { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        // Quota, Work and How-you-work have no producer in this Home: their state belongs to their own lines.
        expect(hook.getCurrent().refreshing).toBe(false);
        held = true;
        let refreshed: Promise<void> | undefined;
        await act(async () => { refreshed = hook.getCurrent().refresh(); });
        await flushHookEffects({ cycles: 5 });
        expect(hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        expect(hook.getCurrent().refreshing).toBe(true);
        await act(async () => { delayed.resolve(Response.json(accounting)); await refreshed; });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().refreshing).toBe(false);
    });

    it('releases accounting activity while slow private detail is still being read', async () => {
        const detail = createDeferred<Response>();
        let issued = false;
        const withDetail: UsageAnalyticsQueryResponse = { ...accounting, contributions: [{ id: 'fact', observedAtMs: 500,
            sessionId: 'slow-session', turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null,
            workspaceId: null, source: null, tokens: accounting.totals.tokens, cost: accounting.totals.cost }] };
        const credentials = await mountHome(request => {
            if (request.path === '/v2/usage/query') return Response.json(withDetail);
            if (request.path === '/v2/sessions/slow-session') { issued = true; return detail.promise; }
            return undefined;
        });
        const queryPlan = plan(normalizeUsageQuery({ session: 'slow-session', period: { startMs: 0, endMs: 1000 } }));
        const hook = await renderHook(() => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return { ...useUsageWidgetBodyModel(resource, 'first'), entry: resource.entry };
        },
        { flushOptions: { cycles: 30 } });
        const settled = createDeferred<void>();
        const entry = hook.getCurrent().entry!;
        const release = entry.subscribe(() => { if (entry.getSnapshot().pending === 'idle') settled.resolve(); }, false);
        try {
            await expect.poll(() => issued).toBe(true);
            await expect.poll(() => hook.getCurrent().slice?.sources.find(source => source.source === 'accounting')?.status).toBe('available');
            expect(hook.getCurrent().slice?.accounting).toMatchObject({ v: 1, totals: withDetail.totals });
            expect(hook.getCurrent().slice?.sources.find(source => source.source === 'how_you_work')?.status).toBe('pending');
            expect(hook.getCurrent().pending).toBe(true);
            expect(hook.getCurrent().refreshing).toBe(false);
            await act(async () => { detail.resolve(Response.json({ error: 'not_found' }, { status: 404 })); await settled.promise; });
            await flushHookEffects({ cycles: 30 });
            expect(entry.getSnapshot().pending).toBe('idle');
            expect(hook.getCurrent().slice?.sources.find(source => source.source === 'how_you_work')?.status).not.toBe('pending');
            expect(hook.getCurrent().refreshing).toBe(false);
        } finally { release(); detail.resolve(Response.json({ error: 'not_found' }, { status: 404 })); }
    });
});
