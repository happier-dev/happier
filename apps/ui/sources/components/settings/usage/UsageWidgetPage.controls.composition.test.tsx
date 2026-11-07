import * as React from 'react';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { BurnUpChart, RankedRows, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ConnectedServiceQuotaGetResultV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { CurrentUiContextCommandsProvider } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { t } from '@/text';
import { useUsageWidgetPageContext, usePublishUsageWidgetPageContext } from './useUsageWidgetPageContext';
import { UsageBreakdownsWidget } from './widgets/UsageBreakdownsWidget';
import { UsageDailyWidget } from './widgets/UsageDailyWidget';
import { UsageProjectionsWidget } from './widgets/UsageProjectionsWidget';
import type { UsageWidgetBodyModel } from './useUsageWidgetResource';
import type { UsageHistoryModel } from './useUsageHistory';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { useUsageWorkDisclosures } from './widgets/UsageWorkParts';
import { UsageModelPricesEditor } from './widgets/UsageModelPrices';
import { UsageNightShiftWidget } from './widgets/UsageNightShiftWidget';
import { UsageBodyInsufficient, UsageCoverageLine } from './widgets/usageBodyKit';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/usage', segments: ['(app)', 'settings', 'usage'] }).module;
});

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let reader: CurrentUiContextReader | null = null;
let unregister: (() => void) | undefined;
const NO_COST_BASES = [] as const;
let showExtraFilter = false;
let historyModel: UsageHistoryModel | null = null;
let historyFact: ReturnType<typeof usePublishUsageWidgetPageContext>['history'] = null;
let pageRetryRead: (() => Promise<void>) | undefined;
let publishedRetryRead: ReturnType<typeof usePublishUsageWidgetPageContext>['retryRead'] | null = null;
function Publication(props: Readonly<{ retireOnSelection?: boolean }>) {
    const authority = captureActiveServerAccountScopeLifetime();
    const page = useUsageWidgetPageContext({ authority });
    const [selected, setSelected] = React.useState('overview');
    const published = usePublishUsageWidgetPageContext({ authority, page, costBasisOptions: NO_COST_BASES,
        active: !props.retireOnSelection || selected === 'overview', layoutId: selected,
        layouts: [{ id: 'costs', name: 'Costs' }, { id: 'work', name: 'Work' }],
        selectLayout: async layoutId => { setSelected(layoutId); await Promise.resolve(); return true; },
        filterCommands: [{ field: 'agents', id: 'codex', title: 'Agent: Codex', invoke: () => page.setScope({ agents: ['codex'] }) },
            ...(showExtraFilter ? [{ field: 'agents', id: 'claude', title: 'Agent: Claude', invoke: () => page.setScope({ agents: ['claude'] }) }] : [])],
        history: historyModel, ...(pageRetryRead ? { retryRead: pageRetryRead } : {}) });
    historyFact = published.history;
    publishedRetryRead = published.retryRead;
    reader = useOptionalCurrentUiContextReader();
    React.useEffect(() => {
        if (!reader) return;
        const current = reader;
        unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            reader: current, invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null,
        }));
        return unregister;
    }, [reader]);
    return <Text testID="selected-layout">{selected}</Text>;
}
function ControlsPage(props: Readonly<{ children: React.ReactNode; retireOnSelection?: boolean }>) {
    // Capture inside the authenticated tree, after its Account authority is applied.
    const viewer = useActiveServerAccountScope();
    const authority = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer?.serverId, viewer?.accountId]);
    return <PluginSurfaceFocusEligibilityProvider active currentUiContextActive><CurrentUiContextCommandsProvider authority={authority}>
        <Publication retireOnSelection={props.retireOnSelection} />{props.children}
    </CurrentUiContextCommandsProvider></PluginSurfaceFocusEligibilityProvider>;
}
async function mount(children: React.ReactNode, retireOnSelection = false) {
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-body-controls.test', accountId: 'account-a' }],
        route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    const tree = (content: React.ReactNode) => <InjectedAuthProvider credentials={credentials}>
        <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
            <ControlsPage retireOnSelection={retireOnSelection}>{content}</ControlsPage>
        </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
    </InjectedAuthProvider>;
    const screen = await renderScreen(tree(children));
    return { screen, retire: () => screen.update(tree(null)) };
}
afterEach(async () => {
    showExtraFilter = false; historyModel = null; historyFact = null; pageRetryRead = undefined; publishedRetryRead = null;
    standardCleanup(); unregister?.(); unregister = undefined; reader = null;
    retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined;
});
function bodyProps(input: Parameters<typeof resolveUsagePageAggregation>[0]) {
    const slice = resolveUsagePageAggregation(input).results[0]!;
    const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
        freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
    return { slice, model, query: slice.shownQuery, serverId: 'home' };
}
async function invoke(id: string) {
    await act(async () => {
        expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: id },
            context: { surface: 'agent' } })).toMatchObject({ ok: true });
    });
}

function WorkDetails() {
    const details = useUsageWorkDisclosures([{ id: 'project', title: 'Project details' }, { id: 'branch', title: 'Branch details' }]);
    return <><Text testID="project-details" onPress={() => details.toggle('project')}>{String(details.isOpen('project'))}</Text>
        <Text testID="branch-details">{String(details.isOpen('branch'))}</Text></>;
}

it('publishes visible body recovery and navigation through their mounted owner and retires both', async () => {
    let retried = 0;
    let opened = 0;
    const props = bodyProps({ queries: [normalizeUsageQuery({})], sources: [{ source: 'work', status: 'error' }] });
    const { screen, retire } = await mount(<>
        <UsageCoverageLine slice={props.slice} sources={['work']} onRetry={() => { retried++; }} testID="body-retry" />
        <UsageBodyInsufficient title="No account" testID="body-navigation"
            action={{ label: 'Open account', onPress: () => { opened++; } }} />
    </>);
    const command = (title: string) => reader!.readCurrentUiContext()!.commands.find(row => row.title === title);
    expect(command('Open account')).toBeDefined();
    const retry = command(t('common.retry'))!;
    expect(retry).toBeDefined();
    await invoke(retry.id);
    expect(retried).toBe(1);
    await invoke(command('Open account')!.id);
    expect(opened).toBe(1);
    await screen.pressByTestIdAsync('body-navigation-action');
    expect(opened).toBe(2);
    await retire();
    expect(reader!.resolveCurrentUiCommand(retry.id)).toBeNull();
});

it('opens the exact Work detail from the mounted command and closes it from the same visible control', async () => {
    const { screen, retire } = await mount(<WorkDetails />);
    const command = reader!.readCurrentUiContext()!.commands.find(command => command.title.startsWith('Project details'));
    expect(command).toBeDefined();
    await invoke(command!.id);
    expect(screen.findByTestId('project-details')!.props.children).toBe('true');
    expect(screen.findByTestId('branch-details')!.props.children).toBe('false');
    await screen.pressByTestIdAsync('project-details');
    expect(screen.findByTestId('project-details')!.props.children).toBe('false');
    await retire();
    expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: command!.id },
        context: { surface: 'agent' } })).toMatchObject({ ok: false });
});

it('exposes model price disclosure and its editable draft through the same mounted command owner', async () => {
    const query = normalizeUsageQuery({});
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const props = bodyProps({ queries: [query], accounting: [{ query, status: 'available', value: { v: 1,
        totals: { eventCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [{
            id: 'price-control', sessionId: null, turnId: null, observedAtMs: 1, agentId: null, modelId: 'parity-private-model',
            machineId: null, projectKey: null, workspaceId: null, source: null, tokens,
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
        }] } }] });
    const { screen } = await mount(<UsageModelPricesEditor slice={props.slice} serverId="home" testID="price-controls" />);
    const command = reader!.readCurrentUiContext()!.commands.find(command => command.title.startsWith('parity-private-model'));
    expect(command).toBeDefined();
    await invoke(command!.id);
    expect(screen.findByTestId('price-controls.model.parity-private-model.input')).not.toBeNull();
    const rate = reader!.readCurrentUiContext()!.commands.find(command => command.title === `parity-private-model: ${t('usage.board.page.priceInput')}`);
    expect(rate).toBeDefined();
    await act(async () => {
        expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: rate!.id, input: '2.5' }, context: { surface: 'agent' } })).toMatchObject({ ok: true });
    });
    expect(screen.findByTestId('price-controls.model.parity-private-model.input')!.props.value).toBe('2.5');
    await screen.pressByTestIdAsync('price-controls.model.parity-private-model.cancel');
    expect(screen.findAllByType(ExpandableItem).find(row => row.props.testID === 'price-controls.model.parity-private-model')?.props.expanded).toBe(false);
    expect(reader!.resolveCurrentUiCommand(rate!.id)).toBeNull();
});

it('changes the night-hour draft through the same mounted option as its visible picker', async () => {
    const query = normalizeUsageQuery({});
    const props = bodyProps({ queries: [query], accounting: [] });
    function NightControls() {
        const scope = useActiveServerAccountScope();
        return <UsageNightShiftWidget {...props} serverId={scope!.serverId} id="usage_night_shift" testID="night-controls" />;
    }
    const { screen } = await mount(<NightControls />);
    const command = reader!.readCurrentUiContext()!.commands.find(command => command.title.endsWith(`${t('usage.board.howYouWork.nightStart')}: 22:00`));
    expect(command).toBeDefined();
    await invoke(command!.id);
    const picker = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'night-controls.startHour')!;
    expect(picker().props.selectedId).toBe('22');
    await act(async () => { picker().props.onSelect('21'); });
    expect(picker().props.selectedId).toBe('21');
});

it('settles an acknowledged view switch after its own publication retires and refuses an old command before effects', async () => {
    const { screen } = await mount(null, true);
    const commands = reader!.readCurrentUiContext()!.commands;
    const costs = commands.find(command => command.title === 'Costs')!;
    const work = commands.find(command => command.title === 'Work')!;
    let pending!: ReturnType<typeof executeCurrentUiContextAction>;
    act(() => { pending = executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
        input: { commandId: costs.id }, context: { surface: 'agent' } }); });
    await flushHookEffects({ cycles: 10 });
    expect(screen.findByTestId('selected-layout')!.props.children).toBe('costs');
    expect(await pending).toMatchObject({ ok: true });
    expect(reader!.resolveCurrentUiCommand(work.id)).toBeNull();
    expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
        input: { commandId: work.id }, context: { surface: 'agent' } })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(screen.findByTestId('selected-layout')!.props.children).toBe('costs');
});

it('keeps page command addresses across equivalent callbacks and scope changes, retiring on Account withdrawal', async () => {
    const { retire } = await mount(null);
    const before = reader!.readCurrentUiContext()!;
    await retire();
    const after = reader!.readCurrentUiContext()!;
    expect(after.commands).toEqual(before.commands);
    showExtraFilter = true;
    await retire();
    const withExtra = reader!.readCurrentUiContext()!;
    expect(withExtra.commands.filter(command => command.title !== 'Agent: Claude')).toEqual(before.commands);
    const filter = after.commands.find(command => command.title === 'Agent: Codex')!;
    await invoke(filter.id);
    const detail = reader!.readCurrentUiContext()!.detail;
    if (typeof detail !== 'string') throw new Error('Expected the Usage page detail document');
    expect(JSON.parse(detail).scope.agents).toEqual(['codex']);
    // USAGE-ACTION-CONTEXT-1101 ruling: scope/view revisions do not retire page intents.
    expect(reader!.readCurrentUiContext()!.commands).toEqual(withExtra.commands);
    expect(reader!.resolveCurrentUiCommand(filter.id)?.retirementSignal.aborted).toBe(false);
    await invoke(filter.id);
    await act(async () => retireActiveServerAccountScopeLifetime());
    expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: filter.id },
        context: { surface: 'agent' } })).toMatchObject({ ok: false });
});

it('composes real list and chart disclosures, isolates identical widget copies and retires their commands', async () => {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, metric: 'tokens', breakdown: ['model'] });
    const totals = { eventCount: 1, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } };
    const props = bodyProps({ queries: [query], accounting: [{ query, status: 'available', value: { v: 1, totals,
        breakdowns: { model: Array.from({ length: 9 }, (_, index) => ({ key: `model-${index}`, ...totals })) },
        series: [{ bucketStartMs: 0, bucketEndMs: 86_400_000, ...totals }] } }] });
    const { screen, retire } = await mount(<>
        <UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="list-first" />
        <UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="list-second" />
        <UsageDailyWidget {...props} id="usage_daily" testID="chart-first" />
        <UsageDailyWidget {...props} id="usage_daily" testID="chart-second" />
    </>);
    const lists = () => screen.findAllByType(RankedRows).map(node => node.props.rows.length);
    const listCommands = reader!.readCurrentUiContext()!.commands.filter(command => command.title.includes(t('usage.widgets.usage_breakdowns')));
    expect(listCommands).toHaveLength(2);
    const before = lists();
    await invoke(listCommands[0]!.id);
    expect(lists()).toEqual([9, before[1]]);
    await screen.pressByTestIdAsync('list-first.model.more.toggle');
    expect(lists()).toEqual(before);
    const chartCommands = reader!.readCurrentUiContext()!.commands.filter(command => command.title.includes(t('usage.widgets.usage_daily')));
    expect(chartCommands).toHaveLength(2);
    await invoke(chartCommands[0]!.id);
    expect(screen.findAllByType(StackedSeriesChart).map(node => node.props.valuesExpanded)).toEqual([true, false]);
    await screen.pressByTestIdAsync('chart-first.chart-values-toggle');
    expect(screen.findAllByType(StackedSeriesChart).map(node => node.props.valuesExpanded)).toEqual([false, false]);
    const retired = reader!.readCurrentUiContext()!.commands.find(command => command.title.includes(t('usage.widgets.usage_daily')))!.id;
    await retire();
    expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: retired },
        context: { surface: 'agent' } })).toMatchObject({ ok: false });
});

it('uses the same mounted projection-window intent for agent, picker and small multiples, scoped to one copy', async () => {
    const now = Date.now();
    const hour = 3_600_000;
    const recordKey = { providerId: 'anthropic', accountSubjectId: 'work', subjectKind: 'account', quotaScope: 'account' } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const quota = ConnectedServiceQuotaGetResultV1Schema.parse({ source: { ref: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'work' }, bindingKind: 'account' },
        current: { v: 1, recordId, recordKey, providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: 'work' },
            observedAtMs: now, fetchedAtMs: now, staleAfterMs: hour, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
            meters: ['daily', 'weekly'].map(meterId => ({ meterId, label: meterId, used: null, limit: null, utilizationPct: 40,
                unit: 'count', status: 'ok', resetsAt: now + hour, windowDurationMs: 2 * hour })) },
        pace: ['daily', 'weekly'].map(meterId => ({ meterId, value: { status: 'available',
            window: { recordId, meterId, resetAtMs: now + hour, windowStartAtMs: now - hour, windowDurationMs: 2 * hour },
            usedFraction: 0.4, elapsedFraction: 0.5, evenPaceFraction: 0.5, pace: 0.8, projectedResetUtilizationFraction: 0.8,
            qualification: 'confirmed', sampleCount: 2, observedCurve: [{ observedAtMs: now - hour, usedFraction: 0.1 }, { observedAtMs: now, usedFraction: 0.4 }] } })),
        targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' } });
    const props = bodyProps({ queries: [normalizeUsageQuery({})], nowMs: now, quota: { status: 'available', value: [quota] } });
    const { screen, retire } = await mount(<>
        <UsageProjectionsWidget {...props} id="usage_projections" testID="projection-first" />
        <UsageProjectionsWidget {...props} id="usage_projections" testID="projection-second" />
    </>);
    const picker = () => screen.findAllByType(DropdownMenu).filter(node => node.props.testID?.endsWith('.windowPicker'));
    expect(picker()).toHaveLength(2);
    const openPicker = reader!.readCurrentUiContext()!.commands.find(command => command.title === `${t('usage.board.plans.windowPicker')}: ${t('common.open')}`);
    expect(openPicker).toBeDefined();
    await invoke(openPicker!.id);
    expect(picker()[0]!.props.open).toBe(true);
    const [initial, sibling] = picker().map(node => node.props.selectedId);
    const other = picker()[0]!.props.items.find((row: { id: string }) => row.id !== initial)!;
    const command = reader!.readCurrentUiContext()!.commands.find(command => command.title.includes(t('usage.board.plans.windowPicker')) && command.title.endsWith(other.title));
    expect(command).toBeDefined();
    await invoke(command!.id);
    expect(picker().map(node => node.props.selectedId)).toEqual([other.id, sibling]);
    await act(async () => { picker()[0]!.props.onSelect(initial); });
    expect(picker().map(node => node.props.selectedId)).toEqual([initial, sibling]);
    await screen.pressByTestIdAsync('projection-first.reported-header');
    await screen.pressByTestIdAsync(`projection-first.multiple.work.${other.id.includes('weekly') ? 'weekly' : 'daily'}`);
    expect(picker().map(node => node.props.selectedId)).toEqual([other.id, sibling]);
    const chartCommand = reader!.readCurrentUiContext()!.commands.find(command => command.title.includes(t('usage.widgets.usage_projections')) && command.title.includes(t('common.details')));
    expect(chartCommand).toBeDefined();
    await invoke(chartCommand!.id);
    expect(screen.findAllByType(BurnUpChart).filter(node => node.props.testID?.endsWith('.burnUp')).map(node => node.props.valuesExpanded)).toEqual([true, false]);
    const retired = reader!.readCurrentUiContext()!.commands.find(command => command.title.includes(t('usage.board.plans.windowPicker')))!;
    await retire();
    expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: retired.id },
        context: { surface: 'agent' } })).toMatchObject({ ok: false });
});

it('binds unread Sessions to one Read now fact and page command, cancels the running read and settles when read', async () => {
    const calls: string[] = [];
    const model = (status: NonNullable<UsageHistoryModel['state']>['status'], progress: Partial<NonNullable<UsageHistoryModel['state']>['progress']>): UsageHistoryModel => {
        const state = { status, progress: { selected: 1300, notRead: 0, completed: 0, failed: 0, ...progress } };
        return { state, notRead: state.progress.notRead,
            readNow: async () => { calls.push('read'); return { ok: true, result: state }; },
            cancel: async () => { calls.push('cancel'); return { ok: true, result: state }; } };
    };
    const historyCommand = () => reader!.readCurrentUiContext()!.commands.filter(command =>
        command.title === t('usage.board.page.historyReadCommand') || command.title === t('usage.board.page.historyCancelCommand'));
    historyModel = model('idle', { notRead: 1240 });
    const { retire: rerender } = await mount(null);
    expect(historyFact).toMatchObject({ text: t('usage.board.page.historyNotRead', { count: formatExactCount(1240) }), label: t('usage.board.page.historyReadNow') });
    expect(historyCommand().map(command => command.title)).toEqual([t('usage.board.page.historyReadCommand')]);
    await invoke(historyCommand()[0]!.id);
    expect(calls).toEqual(['read']);

    historyModel = model('reading', { notRead: 1120, completed: 120 });
    await rerender();
    expect(historyFact).toMatchObject({ text: t('usage.board.page.historyReading', { done: formatExactCount(120), total: formatExactCount(1240) }), label: t('common.cancel') });
    expect(historyCommand().map(command => command.title)).toEqual([t('usage.board.page.historyCancelCommand')]);
    await act(async () => { historyFact!.onPress(); });
    await flushHookEffects({ cycles: 4 });
    expect(calls).toEqual(['read', 'cancel']);

    // A cancelled read keeps what it converted; the rest are still not read.
    historyModel = model('cancelled', { notRead: 1120, completed: 120 });
    await rerender();
    expect(historyFact).toMatchObject({ text: t('usage.board.page.historyNotRead', { count: formatExactCount(1120) }), label: t('usage.board.page.historyReadNow') });

    // A failed read remains retryable even when other Sessions have not been read yet.
    historyModel = model('partial', { notRead: 1120, completed: 120, failed: 2 });
    await rerender();
    expect(historyFact).toMatchObject({ label: t('common.retry'), failed: true });
    historyModel = model('partial', { notRead: 3, completed: 1237, failed: 3 });
    await rerender();
    expect(historyFact).toMatchObject({ text: t('usage.board.page.historyFailed', { count: formatExactCount(3) }), failed: true });
    expect(historyFact).toMatchObject({ label: t('common.retry'), onPress: expect.any(Function) });
    expect(historyCommand().map(command => command.title)).toEqual([t('usage.board.page.historyReadCommand')]);
    await invoke(historyCommand()[0]!.id);
    expect(calls).toEqual(['read', 'cancel', 'read']);

    // QA-R122-HIST: all subjects persisted, but the aggregate read failed ten times.
    // There need not be an unread subject for the failed operation to be retryable.
    historyModel = model('partial', { notRead: 0, completed: 33, failed: 10 });
    await rerender();
    expect(historyFact).toMatchObject({ label: t('common.retry'), failed: true, onPress: expect.any(Function) });
    await act(async () => { historyFact!.onPress(); });
    await flushHookEffects({ cycles: 4 });
    await invoke(historyCommand()[0]!.id);
    expect(calls).toEqual(['read', 'cancel', 'read', 'read', 'read']);

    historyModel = model('complete', { completed: 1240 });
    await rerender();
    expect(historyFact).toBeNull();
    expect(historyCommand()).toEqual([]);
});

it('says a page read failure and unreadable Sessions once, with one Retry that rereads both', async () => {
    const calls: string[] = [];
    const state = { status: 'partial' as const, progress: { selected: 40, notRead: 3, completed: 37, failed: 3 } };
    historyModel = { state, notRead: 3,
        readNow: async () => { calls.push('history'); return { ok: true, result: state }; },
        cancel: async () => { calls.push('cancel'); return { ok: true, result: state }; } };
    pageRetryRead = async () => { calls.push('page'); };
    await mount(null);
    // The page failure carries the unreadable Sessions: no second failure fact and no second Retry.
    expect(historyFact).toBeNull();
    const commands = reader!.readCurrentUiContext()!.commands;
    expect(commands.filter(command => command.title === t('usage.board.page.historyReadCommand'))).toEqual([]);
    expect(commands.filter(command => command.title === t('usage.board.page.retryRead'))).toHaveLength(1);
    await act(async () => { await publishedRetryRead!(); });
    await flushHookEffects({ cycles: 4 });
    expect(calls.sort()).toEqual(['history', 'page']);
});
