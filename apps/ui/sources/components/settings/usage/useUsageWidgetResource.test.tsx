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
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore, invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { normalizeUsageQuery, normalizeUsageQueryBatchInput, getUsageQueryBatchKey, getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { useUsageWidgetResource, useUsageWidgetBodyModel, type UsageWidgetResource, type UsageWidgetBodyModel } from './useUsageWidgetResource';
import type { UsageWidgetQueryPlan } from './usageWidgetQueries';
import { usageAgentTitle, useUsageAnalyticsView, describeUsagePagePendingSources } from './widgets/usageBodyKit';
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
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { CurrentUiContextCommandsProvider, type CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { useUsageWidgetPageContext, usePublishUsageWidgetPageContext } from './useUsageWidgetPageContext';
import { getUsagePeriodDefinition, type UsagePeriod } from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import { useUsageWidgetPageFilters } from './useUsageWidgetPageFilters';
import { UsageDrillProvider, usageDrillFromPageFilters } from './usageDrill';
import { UsageDailyWidget } from './widgets/UsageDailyWidget';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';

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
    it('shows last-known data immediately on a stale remount while one replacement read settles or fails', async () => {
        let hold = false;
        let fail = false;
        const gate = createDeferred<void>();
        const credentials = await mountHome(async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            if (hold) await gate.promise;
            return fail ? new Response('offline', { status: 503 })
                : Response.json({ ...accounting, totals: { ...accounting.totals, eventCount: hold ? 2 : 1 } });
        });
        const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, includeQuota: false,
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false, includeComparison: false });
        const selectedPlan = plan(query);
        const draws: UsageWidgetBodyModel[] = [];
        const mount = () => renderHook(() => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: selectedPlan });
            const model = useUsageWidgetBodyModel(resource, 'first');
            draws.push(model);
            return model;
        });
        const first = await mount();
        await expect.poll(() => first.getCurrent().pending).toBe(false);
        const retained = first.getCurrent().slice!.accounting;
        expect(retained?.totals.eventCount).toBe(1);
        await first.unmount();
        const reads = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const before = reads();
        hold = true;
        const later = Date.now() + 5 * 60_000;
        vi.spyOn(Date, 'now').mockReturnValue(later);
        invalidateUsageQueryResources();
        await flushHookEffects();
        expect(reads(), 'closed views do not re-read').toBe(before);
        draws.length = 0;
        const revisit = await mount();
        try {
            expect(draws[0]?.slice?.accounting, 'the first remount draw keeps the admitted facts').toBe(retained);
            // Readiness is observed at the real mounted consumer, before HTTP answers.
            expect(revisit.getCurrent().slice?.accounting).toBe(retained);
            await expect.poll(reads).toBe(before + 1);
            expect(revisit.getCurrent().refreshing).toBe(true);
            expect(describeUsagePagePendingSources([revisit.getCurrent().slice!]), 'retained observations keep the phone header quiet').toBeNull();
            fail = true;
            gate.resolve();
            await expect.poll(() => revisit.getCurrent().pending).toBe(false);
            expect(revisit.getCurrent().slice?.accounting).toBe(retained);
            expect(revisit.getCurrent().error).not.toBeNull();
            expect(revisit.getCurrent().freshness).toBe('stale');
            fail = false;
            await act(async () => { await revisit.getCurrent().refresh(); });
            await expect.poll(() => revisit.getCurrent().slice?.accounting?.totals.eventCount).toBe(2);
            expect(revisit.getCurrent().error).toBeNull();
            expect(reads(), 'one failed revalidation and one explicit recovery').toBe(before + 2);
        } finally { gate.resolve(); await revisit.unmount(); }
    });

    it('keeps an actual held Daily Agent choice behind Usage Action policy while UI Retry reacquires accounting', async () => {
        const startMs = Date.parse('2024-04-22T00:00:00Z');
        const endMs = startMs + 86_400_000;
        const entry = (key: string) => ({ key, eventCount: 1, tokens: accounting.totals.tokens,
            cost: accounting.totals.cost });
        const leader = (key: string) => ({ ...entry(key), sources: [{ source: 'runtime',
            path: 'runtime' as const, execution: 'happier' as const, eventCount: 1,
            tokens: accounting.totals.tokens, cost: accounting.totals.cost }] });
        const response: UsageAnalyticsQueryResponse = { ...accounting,
            breakdowns: { agent: [entry('codex'), entry('claude')] },
            engineTimeline: [{ bucketStartMs: startMs, bucketEndMs: endMs,
                leaders: [leader('codex:local'), leader('claude:local')] }] };
        const credentials = await mountHome(request => request.path === '/v2/usage/query' ? Response.json(response) : undefined);
        const query = normalizeUsageQuery({ metric: 'tokens', period: { startMs, endMs }, granularity: 'day',
            includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
            includeQuotaHistory: false, includeComparison: false });
        const authority = captureActiveServerAccountScopeLifetime();
        const mounted: { reader: CurrentUiContextReader | null; model?: UsageWidgetBodyModel } = { reader: null };
        function Page() {
            const page = useUsageWidgetPageContext({ authority,
                initialFilters: { period: '7days', metric: 'tokens', costMode: 'auto', focus: null,
                    queryOverrides: readUsageWidgetQueryOverrides(query) } });
            const selectedQuery = React.useMemo(() => normalizeUsageQuery({ ...query, agents: [...page.scope.agents] }), [page.scope.agents]);
            const selectedPlan = React.useMemo(() => plan(selectedQuery), [selectedQuery]);
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: selectedPlan,
                callerContext: page.callerContext, callerQuery: page.callerQuery });
            const model = useUsageWidgetBodyModel(resource, 'first');
            mounted.model = model;
            const slices = React.useMemo(() => model.slice ? [model.slice] : [], [model.slice]);
            const filters = useUsageWidgetPageFilters(page, slices, false, home!.homes.a!.id);
            const commands = filters.flatMap(filter => filter.options.map(option => ({
                field: filter.field, id: option.id, title: `${filter.title}: ${option.label}`,
                invoke: (context?: ActionExecutorContext) => filter.select(option.id, context),
            })));
            const published = usePublishUsageWidgetPageContext({ authority, page, costBasisOptions: [],
                filterCommands: commands, retryRead: model.error ? model.refresh : undefined });
            const admitted = filters.map(filter => ({ ...filter,
                select: (id: string, context?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => published.selectFilter(filter.field, id, context, invocation) }));
            mounted.reader = useOptionalCurrentUiContextReader();
            return <>{published.publication}{model.slice ? <UsageDrillProvider value={usageDrillFromPageFilters(admitted)}>
                <UsageDailyWidget id="usage_daily" query={selectedQuery} slice={model.slice} model={model}
                    serverId={home!.homes.a!.id} testID="held-origin" />
            </UsageDrillProvider> : null}</>;
        }
        const settings = storage.getState().settings;
        const screen = await renderMountedCurrentUiContext(<CurrentUiContextCommandsProvider authority={authority}><Page /></CurrentUiContextCommandsProvider>);
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const invoke = async (id: string, surface: 'agent' | 'ui' = 'agent', input?: { bucket?: number; mode?: string; row?: string }) => {
            const execute = () => createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: id, input },
                surface === 'agent' ? { surface, authority: 'account_automation' }
                    : { surface, authority: 'present_user', actionCaller: { kind: 'host' } });
            let result: Awaited<ReturnType<typeof execute>> | undefined;
            await act(async () => {
                result = await execute();
                expect(result).toMatchObject({ ok: true });
            });
            return result;
        };
        try {
            await expect.poll(() => mounted.model?.slice?.accounting).toBeDefined();
            await expect.poll(() => mounted.model?.pending).toBe(false);
            const initialError = mounted.model?.error;
            expect(initialError?.code, 'the constructed Account has no Connected accounts for its independent quota source').toBe('no_connected_accounts');
            const chart = screen.findHostByTestId('held-origin.chart');
            expect(chart, 'native layout measures the real Daily chart before its plot overlay mounts').toBeTruthy();
            await act(async () => { chart!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 640, height: 240 } } }); });
            const codex = usageAgentTitle('codex');
            const claude = usageAgentTitle('claude');
            const values = mounted.reader!.readCurrentUiContext()!.commands.find(command => command.title === t('usage.board.charts.commandValues'));
            expect(values, 'real Daily chart publishes its structured value lens').toBeDefined();
            const selected = await invoke(values!.id, 'agent', { bucket: 0, mode: 'select' });
            expect(selected).toMatchObject({ ok: true, result: { buckets: [{ rows: expect.arrayContaining([
                expect.objectContaining({ label: codex, selectable: true }), expect.objectContaining({ label: claude, selectable: true }),
            ]) }] } });
            const result = selected?.ok ? selected.result : null;
            if (!result || typeof result !== 'object' || Array.isArray(result) || !('buckets' in result) || !Array.isArray(result.buckets)) throw new Error('Missing Daily bucket values');
            const bucket = result.buckets[0];
            if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket) || !Array.isArray(bucket.rows)) throw new Error('Missing Daily bucket rows');
            const rows: readonly unknown[] = bucket.rows;
            const row = rows.find(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && 'label' in candidate && candidate.label === codex);
            if (!row || typeof row !== 'object' || Array.isArray(row) || !('id' in row) || typeof row.id !== 'string') throw new Error('Missing Codex lens row');
            const choose = mounted.reader!.readCurrentUiContext()!.commands.find(command => command.title === t('usage.board.charts.commandChoose'));
            expect(choose, 'held Daily chart publishes its structured drill choice').toBeDefined();
            storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { [ACTION_ID_FAMILIES_V1.usage[0]]: { disabledSurfaces: ['agent'] } } }) } });
            const beforeChoice = posts();
            await invoke(choose!.id, 'agent', { row: row.id });
            await expect.poll(() => mounted.model?.pending).toBe(false);
            expect(mounted.model?.requestedQuery?.query.agents).toEqual(['codex']);
            expect.soft(mounted.model?.error?.code).toBe('action_disabled');
            expect(posts(), 'held Agent choice cannot reacquire its data under UI authority').toBe(beforeChoice);
            const retry = mounted.reader!.readCurrentUiContext()!.commands.find(command => command.title === t('usage.board.page.retryRead'));
            expect(retry).toBeDefined();
            await invoke(retry!.id, 'ui');
            await expect.poll(() => mounted.model?.pending).toBe(false);
            await expect.poll(() => mounted.model?.slice?.accounting).toBeDefined();
            expect(mounted.model?.error).toEqual(initialError);
            expect(posts()).toBeGreaterThan(beforeChoice);
        } finally { storage.setState({ settings }); await screen.unmount(); }
    });
    it('does not retain an unused agent entry context for a later UI refresh', async () => {
        const credentials = await mountHome(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
        const query = normalizeUsageQuery({ metric: 'cost', period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false });
        const queryPlan = plan(query);
        const hook = await renderHook(() => useUsageWidgetBodyModel(useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan }), 'first'));
        const settings = storage.getState().settings;
        try {
            await expect.poll(() => hook.getCurrent().slice?.accounting).toBeDefined();
            const initialError = hook.getCurrent().error;
            storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { 'usage.query': { disabledSurfaces: ['mcp'] } } }) } });
            const context = captureUiUsageQueryAccountContext(credentials)!;
            getUsageQueryResourceStore(context).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(queryPlan.input) },
                { surface: 'mcp', authority: 'account_automation' });
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(hook.getCurrent().error).toEqual(initialError);
            expect(hook.getCurrent().slice?.accounting?.totals.cost.reportedUsd).toBe(1);
        } finally { storage.setState({ settings }); await hook.unmount(); }
    });
    it('supersedes a running UI read with the agent caller without starting a forbidden replacement', async () => {
        const held = createDeferred<void>();
        const signals: (AbortSignal | null | undefined)[] = [];
        const credentials = await mountHome(async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            signals.push(request.signal);
            await held.promise;
            return Response.json(accounting);
        });
        const query = normalizeUsageQuery({ metric: 'cost', period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false });
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'usage.query': { disabledSurfaces: ['mcp'] } } }) } });
        const queryPlan = plan(query);
        const hook = await renderHook(() => useUsageWidgetBodyModel(
            useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan }), 'first'));
        try {
            await expect.poll(() => signals.length).toBe(1);
            await act(async () => { await hook.getCurrent().refresh({ surface: 'mcp', authority: 'account_automation' }); });
            expect(hook.getCurrent().error?.code).toBe('action_disabled');
            expect(signals).toHaveLength(1);
            expect(signals[0]?.aborted).toBe(true);
            held.resolve();
            await flushHookEffects();
            expect(hook.getCurrent().slice).toBeNull();
        } finally { held.resolve(); storage.setState({ settings }); await hook.unmount(); }
    });
    it('does not change the running UI caller or retain an agent origin when a refresh joins it', async () => {
        const held = createDeferred<void>();
        const credentials = await mountHome(async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            await held.promise;
            return Response.json(accounting);
        });
        const query = normalizeUsageQuery({ metric: 'cost', period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false });
        const queryPlan = plan(query);
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'usage.query': { disabledSurfaces: ['mcp'] } } }) } });
        const hook = await renderHook(() => useUsageWidgetBodyModel(
            useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan }), 'first'));
        try {
            await expect.poll(() => home!.requests.filter(request => request.path === '/v2/usage/query').length).toBe(1);
            const entry = getUsageQueryResourceStore(captureUiUsageQueryAccountContext(credentials)!).getEntry({
                hostRead: 'usage.query', input: projectNativeJsonValueForTransport(queryPlan.input) });
            let joined: ReturnType<typeof entry.refresh> | undefined;
            await act(async () => { joined = entry.refresh({ supersede: false,
                callerContext: { surface: 'mcp', authority: 'account_automation' } }); });
            held.resolve();
            await joined;
            await expect.poll(() => hook.getCurrent().pending).toBe(false);
            expect(hook.getCurrent().error?.code).not.toBe('action_disabled');
            expect(hook.getCurrent().slice?.accounting?.totals.cost.reportedUsd).toBe(1);
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(hook.getCurrent().error?.code).not.toBe('action_disabled');
        } finally { held.resolve(); storage.setState({ settings }); await hook.unmount(); }
    });
    it('keeps agent refresh and query selection behind Usage Action admission while ordinary UI reads succeed', async () => {
        const credentials = await mountHome(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
        const query = normalizeUsageQuery({ metric: 'cost', period: { startMs: 1000, endMs: 2000 },
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false });
        const callerContext = { surface: 'mcp' as const, authority: 'account_automation' as const };
        const selectedQuery = { ...query, period: { startMs: 1000, endMs: 3000 } };
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'usage.query': { disabledSurfaces: ['mcp'] } } }) } });
        const hook = await renderHook((props: Readonly<{ query: UsageQuery; agent: boolean }>) =>
            useUsageWidgetBodyModel(useUsageWidgetResource({ credentials, enabled: true, plan: plan(props.query),
                ...(props.agent ? { callerContext, callerQuery: selectedQuery } : {}) }), 'first'), { initialProps: { query, agent: false } });
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        try {
            await expect.poll(() => hook.getCurrent().slice?.accounting?.totals.cost.reportedUsd).toBe(1);
            const initialError = hook.getCurrent().error;
            expect(posts()).toBe(1);
            await act(async () => { await hook.getCurrent().refresh(callerContext); });
            expect.soft(hook.getCurrent().error?.code).toBe('action_disabled');
            expect.soft(posts(), 'agent Retry cannot issue an HTTP read under UI authority').toBe(1);
            await hook.rerender({ query: selectedQuery, agent: true });
            await expect.poll(() => hook.getCurrent().pending).toBe(false);
            expect.soft(hook.getCurrent().error?.code).toBe('action_disabled');
            expect.soft(posts(), 'agent query changes cannot issue an HTTP read under UI authority').toBe(1);
            // The selection's origin is finite. A subsequent independently
            // observed plan change belongs to the mounted UI reader.
            await hook.rerender({ query: { ...query, period: { startMs: 1000, endMs: 4000 } }, agent: true });
            await expect.poll(() => hook.getCurrent().slice?.accounting?.totals.cost.reportedUsd).toBe(1);
            expect.soft(hook.getCurrent().error).toEqual(initialError);
            expect.soft(posts()).toBe(2);
        } finally { storage.setState({ settings }); await hook.unmount(); }
    });
    it('consumes a same-key page selection before a later independent UI query demand', async () => {
        await mountHome(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'usage.query': { disabledSurfaces: ['agent'] } } }) } });
        const authority = captureActiveServerAccountScopeLifetime();
        const query = normalizeUsageQuery({ period: { relative: '7days' }, includeSessionEvidence: false, includeWorkEvidence: false });
        let reader: CurrentUiContextReader | null = null;
        let inventory: ReturnType<typeof useUsageWidgetBatchInventorySlice>;
        let model: UsageWidgetBodyModel | undefined;
        function Inventory() { inventory = useUsageWidgetBatchInventorySlice(); return null; }
        function Body(props: Readonly<{ agents: readonly string[] }>) {
            model = useUsageWidgetModel({ agents: [...props.agents], period: projectNativeJsonValueForTransport(query.period) }, 'usage_breakdowns').model;
            return null;
        }
        function Page(props: Readonly<{ showBody: boolean }>) {
            const page = useUsageWidgetPageContext({ authority,
                initialFilters: { period: '7days', metric: 'tokens', costMode: 'auto', focus: null,
                    queryOverrides: readUsageWidgetQueryOverrides(query) } });
            const published = usePublishUsageWidgetPageContext({ authority, page, costBasisOptions: [], filterCommands: [{
                field: 'agents', id: 'codex', title: 'Same-key scope selection',
                invoke: context => page.setScope({ agents: ['codex'] }, context),
            }] });
            reader = useOptionalCurrentUiContextReader();
            // Filter inventory deliberately remains unfiltered, including when no body is shown.
            return <UsageWidgetBatchProvider clauses={page.queryOverrides} inventoryQuery={query} inventoryOnly
                callerContext={page.callerContext} callerQuery={page.callerQuery}>
                {published.publication}<Inventory />{props.showBody ? <Body agents={page.scope.agents} /> : null}
            </UsageWidgetBatchProvider>;
        }
        const screen = await renderMountedCurrentUiContext(<CurrentUiContextCommandsProvider authority={authority}><Page showBody={false} /></CurrentUiContextCommandsProvider>);
        const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
        try {
            await expect.poll(() => inventory?.accounting?.totals.cost.reportedUsd).toBe(1);
            const before = posts();
            const command = reader!.readCurrentUiContext()!.commands.find(row => row.title === 'Same-key scope selection')!;
            await act(async () => {
                expect(await createDefaultActionExecutor().execute('ui.current_context.command.invoke',
                    { commandId: command.id }, { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: true });
            });
            await flushHookEffects({ cycles: 20 });
            expect(posts(), 'a scope change reuses the unfiltered inventory').toBe(before);
            await screen.update(<CurrentUiContextCommandsProvider authority={authority}><Page showBody /></CurrentUiContextCommandsProvider>);
            await flushHookEffects({ cycles: 20 });
            await expect.poll(() => model?.pending).toBe(false);
            expect.soft(model?.error?.code, 'the later UI demand has no stale agent refusal').not.toBe('action_disabled');
            expect.soft(model?.slice?.accounting?.totals.cost.reportedUsd).toBe(1);
            expect.soft(posts()).toBeGreaterThan(before);
        } finally { storage.setState({ settings }); await screen.unmount(); }
    });
    it('preserves the agent caller and Resource cancellation after its selection command retires', async () => {
        const { ProviderAccountUsageSnapshotV1Schema, buildProviderAccountUsageRecordId } = await import('@happier-dev/protocol/connect/account-usage-primitives');
        const { ProviderAccountUsagePageProjectionWriteV1Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageHistory');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'resource-origin' };
        const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
        const nowMs = Date.now();
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: nowMs,
            fetchedAtMs: nowMs, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
        const held = createDeferred<void>();
        let holdRead = false;
        let resourceSignal: AbortSignal | null | undefined;
        let projection: ReturnType<typeof ProviderAccountUsagePageProjectionWriteV1Schema.parse> | null = null;
        const credentials = await mountHome(async request => {
            if (request.path === '/v2/usage/query') {
                if (holdRead) { resourceSignal = request.signal; await held.promise; }
                return Response.json(accounting);
            }
            if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({
                source: { bindingKind: 'account', ref }, recordId: snapshot.recordId, providerAccountId: ref.accountId,
                fetchedAt: nowMs, staleAfterMs: 60_000 });
            if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({
                content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: nowMs, staleAfterMs: 60_000, status: 'ok' },
                sources: [{ bindingKind: 'account', ref }] });
            if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
                if (request.method === 'PUT') {
                    projection = ProviderAccountUsagePageProjectionWriteV1Schema.parse(request.body);
                    return Response.json({ success: true });
                }
                const historyQuery: unknown = JSON.parse(request.url.searchParams.get('query') ?? 'null');
                return Response.json(historyQuery && typeof historyQuery === 'object' && 'projection' in historyQuery
                    ? { projection, complete: projection !== null } : { entries: [], nextCursor: null });
            }
            if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
            return undefined;
        });
        storage.setState({ profile: AccountProfileSchema.parse({ ...storage.getState().profile, connectedAccountsV4: [{ ref,
            status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] }) });
        await getServerFeaturesSnapshot({ serverId: home!.homes.a!.id, force: true });
        const query = normalizeUsageQuery({ period: { relative: '7days' }, includeWorkEvidence: false,
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeQuotaHistory: false, includeComparison: false });
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'connectedServices.quota.get': { disabledSurfaces: ['agent'] } } }) } });
        const authority = captureActiveServerAccountScopeLifetime();
        let reader: CurrentUiContextReader | null = null;
        let model: UsageWidgetBodyModel | undefined;
        let receivedContext: ActionExecutorContext | undefined;
        function SelectedBody(props: Readonly<{ agents: readonly string[]; period: UsagePeriod }>) {
            model = useUsageWidgetModel({ agents: [...props.agents], period: { relative: props.period },
                // Plan fit consumes both accounting and allowance; a breakdown
                // intentionally cannot exercise nested quota admission.
                metric: query.metric }, 'usage_plan_fit').model;
            return null;
        }
        function Page() {
            const page = useUsageWidgetPageContext({ authority,
                initialFilters: { period: '7days', metric: 'tokens', costMode: 'auto', focus: null,
                    queryOverrides: readUsageWidgetQueryOverrides(query) } });
            const selected = page.scope.agents.length > 0;
            const published = usePublishUsageWidgetPageContext({ authority, page, costBasisOptions: [], retryRead: context => model?.refresh(context), filterCommands: selected ? [] : [{
                field: 'agents', id: 'codex', title: 'Agent origin selection', invoke: (callerContext?: ActionExecutorContext) => {
                    receivedContext = callerContext;
                    return page.setScope({ agents: ['codex'] }, callerContext);
                },
            }] });
            reader = useOptionalCurrentUiContextReader();
            const inventoryQuery = React.useMemo(() => normalizeUsageQuery({ ...query, ...page.queryOverrides,
                period: { relative: page.period } }), [page.queryOverrides, page.period]);
            return <UsageWidgetBatchProvider clauses={page.queryOverrides} inventoryQuery={inventoryQuery}
                callerContext={page.callerContext} callerQuery={page.callerQuery}>
                {published.publication}<SelectedBody agents={page.scope.agents} period={page.period} />
            </UsageWidgetBatchProvider>;
        }
        const screen = await renderMountedCurrentUiContext(<CurrentUiContextCommandsProvider authority={authority}><Page /></CurrentUiContextCommandsProvider>);
        try {
            await expect.poll(() => model?.pending).toBe(false);
            expect(model?.error).toBeNull();
            const command = reader!.readCurrentUiContext()!.commands.find(row => row.title === 'Agent origin selection')!;
            expect(command).toBeDefined();
            const commandSignal = reader!.resolveCurrentUiCommand(command.id)!.retirementSignal;
            holdRead = true;
            await act(async () => {
                expect(await createDefaultActionExecutor().execute('ui.current_context.command.invoke',
                    { commandId: command.id }, { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: true });
            });
            await expect.poll(() => resourceSignal).toBeDefined();
            expect.soft(receivedContext).toMatchObject({ surface: 'agent', authority: 'account_automation' });
            expect(reader!.resolveCurrentUiCommand(command.id)).toBeNull();
            expect(commandSignal.aborted, 'selection removes and retires its own descriptor').toBe(true);
            expect(resourceSignal?.aborted, 'the page Resource owns the new read cancellation').toBe(false);
            held.resolve();
            await expect.poll(() => model?.pending).toBe(false);
            expect(model?.slice?.accounting?.totals.cost.reportedUsd).toBe(1);
            // The selected accounting scope reuses already admitted allowance.
            // Explicit Retry asks the same owner for fresh allowance as well.
            const retryCommand = reader!.readCurrentUiContext()!.commands.find(row => row.title === t('usage.board.page.retryRead'))!;
            await act(async () => {
                expect(await createDefaultActionExecutor().execute('ui.current_context.command.invoke',
                    { commandId: retryCommand.id }, { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: true });
            });
            await expect.poll(() => model?.pending).toBe(false);
            expect.soft(model?.error?.code, 'nested quota Retry still sees the actual agent caller').toBe('action_disabled');
            // A period changes both the inventory and child registrations.
            // Their complete new cohort belongs to this one command caller.
            storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { 'usage.query': { disabledSurfaces: ['agent'] } } }) } });
            const posts = home!.requests.filter(request => request.path === '/v2/usage/query').length;
            const periodCommand = reader!.readCurrentUiContext()!.commands.find(row => row.title === t(getUsagePeriodDefinition('30days').translationKey))!;
            await act(async () => {
                expect(await createDefaultActionExecutor().execute('ui.current_context.command.invoke',
                    { commandId: periodCommand.id }, { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: true });
            });
            await expect.poll(() => model?.pending).toBe(false);
            expect.soft(model?.error?.code, 'all selected-period reads retain the agent admission').toBe('action_disabled');
            expect.soft(home!.requests.filter(request => request.path === '/v2/usage/query'), 'no inventory or child query can escape under UI authority').toHaveLength(posts);
        } finally { held.resolve(); storage.setState({ settings }); await screen.unmount(); }
    });
    it('shares pending page demand per Resource across twenty two-scope round trips', async () => {
        const { Session: InspectorSession } = await import('node:inspector');
        const usageResources = await import('@/sync/api/account/usageQueryResource');
        const held = createDeferred<void>();
        const signals: (AbortSignal | null | undefined)[] = [];
        const credentials = await mountHome(async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            signals.push(request.signal);
            await held.promise;
            return Response.json(accounting);
        });
        const plans = ['7days', '30days'].map(relative => plan(normalizeUsageQuery({ period: { relative }, includeQuota: false,
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false, includeComparison: false })));
        const getStore = usageResources.getUsageQueryResourceStore;
        const staticListeners: { reference: WeakRef<object>; released: boolean }[] = [];
        // Observe the actual listener functions passed to the real store, not
        // its subscriber counter. No subscription or read logic is replaced.
        const observation = vi.spyOn(usageResources, 'getUsageQueryResourceStore').mockImplementation((...args) => {
            const store = getStore(...args);
            return { ...store, getEntry(...entryArgs) {
                const entry = store.getEntry(...entryArgs);
                return { ...entry, subscribe(listener: () => void, live: boolean) {
                    const observed = { reference: new WeakRef(listener), released: false };
                    if (!live) staticListeners.push(observed);
                    const unsubscribe = entry.subscribe(listener, live);
                    return () => { unsubscribe(); observed.released = true; };
                } };
            } };
        });
        const hook = await renderHook(({ queryPlan }) => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan, retainPendingDemand: true });
            useUsageWidgetBodyModel(resource, 'first');
            return resource;
        }, { initialProps: { queryPlan: plans[0]! }, flushOptions: { cycles: 20 } });
        const context = captureUiUsageQueryAccountContext(credentials)!;
        const store = getStore(context);
        const entries = plans.map(queryPlan => store.getEntry({ hostRead: 'usage.query',
            input: projectNativeJsonValueForTransport(queryPlan.input) }));
        const inspector = new InspectorSession();
        inspector.connect();
        const liveListeners = async () => {
            observation.mockClear();
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
            // React's alternate Fiber may retain a released effect until the
            // next commit. Count only functions still subscribed to the store.
            return new Set(staticListeners.flatMap(row => {
                const listener = !row.released && row.reference.deref();
                return listener ? [listener] : [];
            })).size;
        };
        try {
            await expect.poll(() => signals.length).toBeGreaterThan(0);
            for (let round = 0; round < 20; round++) for (const queryPlan of [plans[1]!, plans[0]!]) {
                await hook.rerender({ queryPlan });
                expect(hook.getCurrent().entry!.getSnapshot().pending).not.toBe('idle');
                publishHomeAccountChange(context.accountLifetime.scope.serverId, [], { changeKinds: ['account'],
                    usageQueryAffects: true, usageAccountingChange: { sessionId: null } });
                await flushHookEffects({ cycles: 5 });
            }
            expect(signals.every(signal => signal?.aborted === false), 'revisiting a scope preserves its original admitted work').toBe(true);
            expect(await liveListeners(), 'pending work retains one real static listener per scope, not per visit').toBe(2);
            held.resolve();
            await expect.poll(async () => {
                await flushHookEffects({ cycles: 20 });
                return entries.every(entry => entry.getSnapshot().pending === 'idle');
            }).toBe(true);
            expect(await liveListeners(), 'settling releases the retired scope borrower').toBe(1);
            await hook.unmount();
            expect(await liveListeners(), 'leaving releases the current page borrower').toBe(0);
        } finally {
            held.resolve();
            await hook.unmount();
            observation.mockRestore();
            inspector.disconnect();
        }
    });
    it('cancels the pending read and withdraws a queued live replacement on hide', async () => {
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
            // USAGE-LEAVE-COST-1107: finite reads that only serve a departed page lose demand.
            expect(signals.filter(signal => signal?.aborted), 'leaving cancels the one pending physical request').toHaveLength(1);
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
            expect(admittedSignal?.aborted, 'hiding releases pending work that only serves the departed page').toBe(true);
            expect(posts() - beforePending, 'a hidden push adds no follow-up to an admitted finite read').toBe(1);
            await screen.update(page(true));
            await expect.poll(() => model?.slice?.accounting?.totals.cost.reportedUsd).toBe(5);
            await expect.poll(() => model?.pending).toBe(false);
            expect(posts() - beforePending, 'showing after the hidden push reads current accounting once').toBe(2);
        } finally { held?.resolve(); await screen.unmount(); }
    });
    it.each(['evidence', 'quota'] as const)('cancels pending %s reads on leave and admits no replacement on the next page', async source => {
        const { UsageSessionEvidenceRequestSchema, USAGE_SESSION_EVIDENCE_PATH } = await import('@happier-dev/protocol/usage/usageSessionEvidence');
        const { ProviderAccountUsageSnapshotV1Schema, buildProviderAccountUsageRecordId } = await import('@happier-dev/protocol/connect/account-usage-primitives');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'leave-cost' };
        const recordKey = { providerId: 'codex', accountSubjectId: 'leave-cost', subjectKind: 'account' as const, quotaScope: 'account' as const };
        const nowMs = Date.now();
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'leave-cost' }, observedAtMs: nowMs,
            fetchedAtMs: nowMs, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
        const held = createDeferred<void>();
        const signals: (AbortSignal | null | undefined)[] = [];
        const historyPath = '/v4/connect/qualified/provider-account-usage/history';
        const credentials = await mountHome(async request => {
            if (request.path === '/v2/usage/query') return Response.json(accounting);
            if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({
                source: { bindingKind: 'account', ref }, recordId: snapshot.recordId, providerAccountId: ref.accountId,
                fetchedAt: nowMs, staleAfterMs: 60_000 });
            if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({
                content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: nowMs, staleAfterMs: 60_000, status: 'ok' },
                sources: [{ bindingKind: 'account', ref }] });
            if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
            if (request.path === (source === 'evidence' ? USAGE_SESSION_EVIDENCE_PATH : historyPath)) {
                signals.push(request.signal);
                await held.promise;
                if (source === 'quota') return Response.json({ entries: [], nextCursor: null });
                const input = UsageSessionEvidenceRequestSchema.parse(request.body);
                return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [] })), results: [] });
            }
            return undefined;
        });
        if (source === 'quota') {
            storage.setState({ profile: AccountProfileSchema.parse({ ...storage.getState().profile, connectedAccountsV4: [{ ref,
                status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
                credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] }) });
            await getServerFeaturesSnapshot({ serverId: home!.homes.a!.id, force: true });
        }
        const queryPlan = plan(normalizeUsageQuery({ period: { relative: '7days' }, includeWorkEvidence: false,
            includeSessionEvidence: source === 'evidence', includeTranscriptEvidence: false,
            includeQuotaHistory: source === 'quota', includeComparison: false }));
        function MountedPage() {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan, retainPendingDemand: true });
            useUsageWidgetBodyModel(resource, 'first');
            return null;
        }
        const page = (shown: boolean) => <PluginSurfaceFocusEligibilityProvider active={shown} presentationActive={shown}>
            <MountedPage />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(page(false));
        try {
            await flushHookEffects({ cycles: 20 });
            expect(signals, 'a hidden Usage page has no cold read').toHaveLength(0);
            await screen.update(page(true));
            await expect.poll(() => signals.length).toBe(1);
            await screen.update(page(false));
            await flushHookEffects({ cycles: 20 });
            expect.soft(signals.filter(signal => signal?.aborted), 'the last page borrower cancels its physical read').toHaveLength(1);
            await act(async () => { publishHomeAccountChange(home!.homes.a!.id, [], { changeKinds: ['account'],
                usageQueryAffects: true, usageAccountingChange: { sessionId: null } }); });
            await flushHookEffects({ cycles: 20 });
            expect(signals, 'a push on the next page starts no Usage history/evidence read').toHaveLength(1);
        } finally { held.resolve(); await screen.unmount(); }
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
    it('shows admitted rich facts from the first remount draw while changed accounting is issued once', async () => {
        let amount = 1;
        let activityPosts = 0;
        let held: ReturnType<typeof createDeferred<Response>> | undefined;
        let cancelled: ReturnType<typeof createDeferred<Response>> | undefined;
        const response = () => Response.json({ ...accounting, totals: { ...accounting.totals,
            cost: { ...accounting.totals.cost, reportedUsd: amount } },
            breakdowns: { agent: [{ key: 'codex', ...accounting.totals,
                cost: { ...accounting.totals.cost, reportedUsd: amount } }] } });
        const credentials = await mountHome(request => {
            if (request.path !== '/v2/usage/query') return undefined;
            activityPosts++;
            return held ? held.promise.then(value => value.clone()) : response();
        });
        const input = { metric: 'cost', period: { startMs: 1_000, endMs: 2_000 }, breakdown: ['agent'] };
        const clauses = readUsageWidgetQueryOverrides(normalizeUsageQuery({ granularity: 'day', timeZoneOffsetMinutes: 0,
            includeCoach: false, includeQuota: false, includeQuotaHistory: false, includeComparison: false,
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false }));
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let observing = false;
        let beforeReopenPosts = 0;
        let preIssueFactBodies = 0;
        // React's Profiler observes the real rich subtree's commit before the
        // enclosing batch's layout-effect subscription can acquire its read.
        const observeFacts: React.ProfilerOnRenderCallback = () => {
            if (observing && activityPosts === beforeReopenPosts)
                preIssueFactBodies += screen?.findAllByType(UsageBreakdownsWidget).length ?? 0;
        };
        function Page(props: Readonly<{ visible: boolean }>) {
            return <InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
                {props.visible ? <UsageWidgetBatchProvider clauses={clauses}>
                    <React.Profiler id="issued-facts" onRender={observeFacts}>
                        <UsageWidgetBody id="usage_breakdowns" input={input} serverId={home!.homes.a!.id} testID="issued-facts" />
                    </React.Profiler>
                </UsageWidgetBatchProvider> : null}
            </CoreCollectionScope></InjectedAuthProvider>;
        }
        const values = () => screen!.findAllByType(RankedRows).flatMap(row => row.props.rows
            .filter((entry: { id: string }) => entry.id === 'codex').map((entry: { value: number }) => entry.value));
        screen = await renderScreen(<Page visible />);
        try {
            await expect.poll(values).toEqual([1]);
            await flushHookEffects({ cycles: 20 });
            await screen.update(<Page visible={false} />);
            amount = 2;
            held = createDeferred<Response>();
            invalidateUsageQueryResources();
            beforeReopenPosts = activityPosts;
            observing = true;
            await screen.update(<Page visible />);
            await expect.poll(() => activityPosts).toBe(beforeReopenPosts + 1);
            expect(preIssueFactBodies, 'last-known facts are visible before the replacement request is issued').toBeGreaterThan(0);
            expect(values(), 'issuance releases retained facts without waiting for the held response').toEqual([1]);
            await flushHookEffects({ cycles: 20 });
            expect(activityPosts, 'fact presentation joins the already issued cohort').toBe(beforeReopenPosts + 1);
            await act(async () => { held!.resolve(response()); });
            await expect.poll(values).toEqual([2]);
            // A cancelled progress snapshot can keep the same admission inputs
            // and pending state. It does not prove the next read has issued.
            held = createDeferred<Response>();
            amount = 3;
            invalidateUsageQueryResources();
            await expect.poll(() => activityPosts).toBe(beforeReopenPosts + 2);
            expect(values(), 'an already presented body retains facts during refresh').toEqual([2]);
            cancelled = held;
            await screen.update(<Page visible={false} />);
            held = createDeferred<Response>();
            beforeReopenPosts = activityPosts;
            preIssueFactBodies = 0;
            await screen.update(<Page visible />);
            await expect.poll(() => activityPosts).toBe(beforeReopenPosts + 1);
            expect(preIssueFactBodies, 'cancelling a replacement does not hide the last-known facts on remount').toBeGreaterThan(0);
            expect(values(), 'replacement issuance releases the retained facts').toEqual([2]);
            await act(async () => { cancelled!.resolve(response()); });
            await flushHookEffects({ cycles: 20 });
            expect(values(), 'the cancelled response cannot replace current facts').toEqual([2]);
            expect(activityPosts, 'the mounted facts keep the one replacement cohort').toBe(beforeReopenPosts + 1);
            await act(async () => { held!.resolve(response()); });
            await expect.poll(values).toEqual([3]);
        } finally { cancelled?.resolve(response()); held?.resolve(response()); await screen.unmount(); }
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
        function Page(props: Readonly<{ visible: boolean; style?: string; colourBy?: string; day?: string }>) {
            return <InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
                <WidgetFrameResourceActivityContext.Provider value={reportActivity}>
                    {props.visible ? <UsageWidgetBatchProvider clauses={clauses}>
                        {bodyIds.map(id => <UsageWidgetBody key={id} id="usage_breakdowns"
                            input={{ ...input, ...(props.style ? { style: props.style } : {}),
                                ...(props.colourBy ? { colourBy: props.colourBy } : {}), ...(props.day ? { day: props.day } : {}) }}
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
            await screen.update(<Page visible style="crew" />);
            await expect.poll(() => screen.findAllByType(UsageBreakdownsWidget)
                .map(body => body.props.presentation?.style), { message: 'a real presentation change still reaches every fact body' })
                .toEqual(bodyIds.map(() => 'crew'));
            await screen.update(<Page visible style="crew" colourBy="agent" />);
            await expect.poll(() => screen.findAllByType(UsageBreakdownsWidget).map(body => body.props.presentation?.colourBy))
                .toEqual(bodyIds.map(() => 'agent'));
            await screen.update(<Page visible style="crew" colourBy="agent" day="2026-11-08" />);
            await expect.poll(() => screen.findAllByType(UsageBreakdownsWidget).map(body => body.props.presentation?.day))
                .toEqual(bodyIds.map(() => '2026-11-08'));
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
        const slowDetail = createDeferred<void>();
        let detailIssued = false;
        let denied = false;
        const credentials = await mountHome(request => {
            if (request.path === '/v2/usage/query') {
                if (denied) return Response.json({ error: 'forbidden' }, { status: 403 });
                const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
                return query.filters?.sessionIds?.includes('slow-session') ? slowAccounting.promise : Response.json(accounting);
            }
            if (request.path === USAGE_SESSION_EVIDENCE_PATH && request.method === 'POST') {
                const input = UsageSessionEvidenceRequestSchema.parse(request.body);
                expect(input.requests[0]?.sessionIds).toEqual(['slow-session']);
                detailIssued = true;
                return slowDetail.promise.then(() => Response.json(UsageSessionEvidenceResponseSchema.parse({
                    requests: input.requests.map(demand => ({ query: demand.query, sessionIds: ['slow-session'] })),
                    results: [{ sessionId: 'slow-session', detail: { status: 404, body: { error: 'not_found' } } }],
                })));
            }
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
            await act(async () => { slowDetail.resolve(); });
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
            slowDetail.resolve();
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

    it('shows a named previous period across its derived granularity, drops independent inputs, and ignores late completion after retirement', async () => {
        const delayed = createDeferred<Response>();
        let held = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held ? delayed.promise : Response.json(accounting) : undefined);
        const hook = await renderHook(({ period, granularity, costBasis, session }: {
            period: '7days' | 'today'; granularity: 'day' | 'hour'; costBasis: 'auto' | 'reported'; session: string | null;
        }) => {
            const resource = useUsageWidgetResource({ credentials, enabled: true,
                plan: plan(normalizeUsageQuery({ period: { relative: period }, granularity, costBasis, session })) });
            return useUsageWidgetBodyModel(resource, 'first');
        }, { initialProps: { period: '7days', granularity: 'day', costBasis: 'auto', session: null }, flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        held = true;
        await hook.rerender({ period: 'today', granularity: 'hour', costBasis: 'auto', session: null });
        expect(hook.getCurrent().updatingPreviousPeriod).toBe(true);
        expect(hook.getCurrent().shownQuery?.query).toMatchObject({ period: { relative: '7days' }, granularity: 'day' });
        expect(hook.getCurrent().requestedQuery?.query).toMatchObject({ period: { relative: 'today' }, granularity: 'hour' });
        await hook.rerender({ period: 'today', granularity: 'hour', costBasis: 'reported', session: null });
        expect(hook.getCurrent().slice).toBeNull();
        await hook.rerender({ period: '7days', granularity: 'day', costBasis: 'auto', session: null });
        expect(hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        await hook.rerender({ period: '7days', granularity: 'hour', costBasis: 'auto', session: null });
        expect(hook.getCurrent().slice, 'independently changing granularity still retires the shown facts').toBeNull();
        await hook.rerender({ period: '7days', granularity: 'day', costBasis: 'auto', session: null });
        expect(hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        await hook.rerender({ period: 'today', granularity: 'hour', costBasis: 'auto', session: 'session-other' });
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
        const detail = createDeferred<void>();
        let issued = false;
        const withDetail: UsageAnalyticsQueryResponse = { ...accounting, contributions: [{ id: 'fact', observedAtMs: 500,
            sessionId: 'slow-session', turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null,
            workspaceId: null, source: null, tokens: accounting.totals.tokens, cost: accounting.totals.cost }] };
        const credentials = await mountHome(request => {
            if (request.path === '/v2/usage/query') return Response.json(withDetail);
            if (request.path === USAGE_SESSION_EVIDENCE_PATH && request.method === 'POST') {
                const input = UsageSessionEvidenceRequestSchema.parse(request.body);
                expect(input.requests[0]?.sessionIds).toEqual(['slow-session']);
                issued = true;
                return detail.promise.then(() => Response.json(UsageSessionEvidenceResponseSchema.parse({
                    requests: input.requests.map(demand => ({ query: demand.query, sessionIds: ['slow-session'] })),
                    results: [{ sessionId: 'slow-session', detail: { status: 404, body: { error: 'not_found' } } }],
                })));
            }
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
            await act(async () => { detail.resolve(); await settled.promise; });
            await flushHookEffects({ cycles: 30 });
            expect(entry.getSnapshot().pending).toBe('idle');
            expect(hook.getCurrent().slice?.sources.find(source => source.source === 'how_you_work')?.status).not.toBe('pending');
            expect(hook.getCurrent().refreshing).toBe(false);
        } finally { release(); detail.resolve(); }
    });
});
