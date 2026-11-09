import * as React from 'react';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { router } from 'expo-router';
import { BurnUpChart, RankedRows, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import { ChangesResponseSchema, CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ConnectedServiceQuotaGetResultV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { CurrentUiContextCommandsProvider, useCurrentUiContextCommandBridge } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
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
import { UsageModelPricesEditor, UsageModelPricesLine } from './widgets/UsageModelPrices';
import { UsageSourcesMachines } from './widgets/UsageSourcesWidget';
import { UsageNightShiftWidget } from './widgets/UsageNightShiftWidget';
import { UsageBodyInsufficient, UsageCoverageLine } from './widgets/usageBodyKit';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { Modal, ModalProvider } from '@/modal';
import { BaseModal } from '@/modal/components/BaseModal';
import { dispatchEscapeToLayerStack } from '@/keyboard/escape';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// These controls are exercised after disclosure motion settles, including Cancel discarding its mounted draft.
vi.mock('react-native-reanimated', async () =>
    (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({ settleTimingCallbacks: true }));

const routeBoundary = vi.hoisted(() => ({ push: undefined as ((value: unknown) => void) | undefined }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/usage', segments: ['(app)', 'settings', 'usage'],
        router: { push: value => routeBoundary.push?.(value) } }).module;
});

// Portals and browser focus/event listeners are platform boundaries; modal and command owners stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('@/utils/web/radixCjs', async importOriginal => {
    const actual = await importOriginal<typeof import('@/utils/web/radixCjs')>();
    const Inline = (props: Readonly<{ children?: React.ReactNode }>) => props.children;
    return { ...actual, requireRadixDismissableLayer: () => ({ Root: Inline, Branch: Inline }),
        requireRadixFocusScope: () => ({ Root: Inline }) };
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
const publicationContentCounter = createRenderCommitCounter();
function PublicationContent(props: Readonly<{ selected: string }>) {
    useRenderCommitCounter(publicationContentCounter);
    return <Text testID="selected-layout">{props.selected}</Text>;
}
function Publication(props: Readonly<{ retireOnSelection?: boolean; initialLayout?: string }>) {
    const authority = captureActiveServerAccountScopeLifetime();
    const page = useUsageWidgetPageContext({ authority });
    const [selected, setSelected] = React.useState(props.initialLayout ?? 'overview');
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
    return <>{published.publication}<PublicationContent selected={selected} /></>;
}
function ControlsPage(props: Readonly<{ children: React.ReactNode; retireOnSelection?: boolean; initialLayout?: string }>) {
    // Capture inside the authenticated tree, after its Account authority is applied.
    const viewer = useActiveServerAccountScope();
    const authority = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer?.serverId, viewer?.accountId]);
    return <PluginSurfaceFocusEligibilityProvider active currentUiContextActive><CurrentUiContextCommandsProvider authority={authority}>
        <Publication retireOnSelection={props.retireOnSelection} initialLayout={props.initialLayout} />{props.children}
    </CurrentUiContextCommandsProvider></PluginSurfaceFocusEligibilityProvider>;
}
async function mount(children: React.ReactNode, retireOnSelection = false, withModalProvider = false,
    wrapPage?: (content: React.ReactNode) => React.ReactNode, route?: Parameters<typeof serveActionHomes>[0]['route']) {
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-body-controls.test', accountId: 'account-a' }],
        route: async request => await route?.(request) ?? (request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined) });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    const tree = (content: React.ReactNode) => {
        const context = <CurrentUiContextProvider>
            {wrapPage ? wrapPage(content) : <ControlsPage retireOnSelection={retireOnSelection}>{content}</ControlsPage>}
        </CurrentUiContextProvider>;
        return <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider>
                {withModalProvider ? <ModalProvider>{context}</ModalProvider> : context}
            </AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
    };
    const screen = await renderScreen(tree(children));
    return { screen, retire: () => screen.update(tree(null)) };
}
afterEach(async () => {
    showExtraFilter = false; historyModel = null; historyFact = null; pageRetryRead = undefined; publishedRetryRead = null;
    routeBoundary.push = undefined; installDisconnectedServerSocketBoundary();
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

function CardOpener() {
    const bridge = useCurrentUiContextCommandBridge();
    return <Text testID="open-card" onPress={() => Modal.show({ commandBridge: bridge,
        component: () => <Text>Card content</Text>, chrome: { kind: 'card', title: 'Shared card' } })}>Open card</Text>;
}

it.each(['button', 'escape', 'scrim', 'agent'] as const)('dismisses a page-opened card through its shared %s command and retires it', async surface => {
    const { screen } = await mount(<CardOpener />, false, true);
    await screen.pressByTestIdAsync('open-card');
    const visibleCards = () => screen.findAllByType(BaseModal).filter(node => node.props.visible);
    expect(visibleCards()).toHaveLength(1);
    expect(reader!.readCurrentUiContext()!.commands.some(command => command.title === 'Agent: Codex')).toBe(false);
    const close = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('common.close'));
    if (surface === 'button') await screen.pressByTestIdAsync('modal-card-close');
    else if (surface === 'escape') {
        await act(async () => { expect(dispatchEscapeToLayerStack({ key: 'Escape' })).toBe(true); });
    } else if (surface === 'scrim') {
        const shell = screen.findAllByType('div').find(node => node.props.role === 'dialog')!;
        await act(async () => { shell.props.onClick({ target: null, preventDefault() {}, stopPropagation() {} }); });
    } else {
        expect(close).toBeDefined();
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: close!.id },
            { surface: 'agent', serverId: home!.homes.a!.id })).toMatchObject({ ok: true }); });
    }
    await flushHookEffects({ cycles: 10 });
    expect(visibleCards()).toHaveLength(0);
    expect(close).toBeDefined();
    expect(reader!.resolveCurrentUiCommand(close!.id)).toBeNull();
    expect(reader!.readCurrentUiContext()!.commands.some(command => command.title === 'Agent: Codex')).toBe(true);
});

function ReconnectingSources(props: Readonly<{ calls: string[] }>) {
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const executor = React.useMemo(() => {
        // Machine RPC is the external boundary; Action parsing/admission, hook and controller stay real.
        const deps = { usageSourceAction: createUsageSourceActionPort({
            serverId: lifetime.scope.serverId,
            assertCurrent: context => { context.signal?.throwIfAborted(); if (!lifetime.isCurrent()) throw new Error('retired'); },
            rpc: async request => {
                props.calls.push(request.actionId);
                return { sources: Array.from({ length: 49 }, (_, index) => ({
                    serverId: lifetime.scope.serverId, machineId: 'machine', sourceId: `source-${index}`,
                    agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    root: { kind: 'default', path: index < 4 ? `/sources/${index}` : null },
                    consent: 'disabled', status: index < 4 ? 'found' : 'unavailable',
                    coverage: 'unknown', pendingCount: 0, asOfMs: null,
                })) };
            },
        }) } satisfies Partial<ActionExecutorDeps>;
        // Unrelated executor ports are unused by this Machine-RPC slice.
        return createActionExecutor(deps as ActionExecutorDeps);
    }, [lifetime, props.calls]);
    return <UsageSourcesMachines lifetime={lifetime} serverId={lifetime.scope.serverId} executor={executor}
        testID="reconnecting-sources" machines={[{ id: 'machine', name: 'Machine', online: true }]}
        input={{ agents: [], machines: [], sources: [] }} />;
}

function RetainedUsageRoutes(props: Readonly<{ slice: ReturnType<typeof bodyProps>['slice']; sourceCalls: string[] }>) {
    const [routes, setRoutes] = React.useState(['/settings/usage?layoutId=costs&period=today']);
    React.useLayoutEffect(() => {
        // Expo's external navigator retains prior route trees; focus decides their current publisher.
        const push = (value: unknown) => {
            if (typeof value !== 'string') throw new Error('This route fixture accepts URL pushes');
            setRoutes(current => [...current, value]);
        };
        routeBoundary.push = push;
        return () => { if (routeBoundary.push === push) routeBoundary.push = undefined; };
    }, []);
    return routes.map((route, index) => {
        const layout = new URL(route, 'https://usage-body-controls.test').searchParams.get('layoutId')!;
        return <PluginSurfaceFocusEligibilityProvider key={index} active={index === routes.length - 1}
            currentUiContextActive={index === routes.length - 1}>
            <ControlsPage initialLayout={layout}>{layout === 'costs'
                ? <UsageModelPricesLine slice={props.slice} serverId="home" testID={`reopened-prices-${index}`} />
                : index === routes.length - 1 ? <ReconnectingSources calls={props.sourceCalls} /> : null}</ControlsPage>
        </PluginSurfaceFocusEligibilityProvider>;
    });
}

it.each(['button', 'escape', 'scrim', 'agent'] as const)('dismisses reopened Prices through %s after successful Sources reconnect and a retained Costs route', async surface => {
    const sockets: Socket[] = [];
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        if (typeof socket.auth === 'object' && socket.auth.clientType === 'user-scoped') sockets.push(socket);
    });
    const query = normalizeUsageQuery({});
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const props = bodyProps({ queries: [query], accounting: [{ query, status: 'available', value: { v: 1,
        totals: { eventCount: 4, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
        contributions: ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'].map(modelId => ({
            id: modelId, sessionId: null, turnId: null, observedAtMs: 1, agentId: null, modelId,
            machineId: null, projectKey: null, workspaceId: null, source: null, tokens,
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
        })) } }] });
    const sourceCalls: string[] = [];
    const { screen } = await mount(<RetainedUsageRoutes slice={props.slice} sourceCalls={sourceCalls} />, false, true,
        content => content, request => {
            if (request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
            if (request.path === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (request.path === '/v2/changes') return Response.json(ChangesResponseSchema.parse({ changes: [], nextCursor: 0 }));
            if (request.path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
            if (request.path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
                snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0, pins: [], folders: [],
                    folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
            }));
            if (request.path === '/v1/machines') return Response.json({ machines: [] });
            if (request.path === '/v2/sessions' || request.path === '/v2/sessions/active') return Response.json({
                sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            });
            return undefined;
        });
    const visibleCards = () => screen.findAllByType(BaseModal).filter(node => node.props.visible);
    const pressVisibleClose = async () => {
        const button = visibleCards()[0]!.findAll(node => node.props.testID === 'modal-card-close'
            && typeof node.props.onPress === 'function')[0]!;
        await act(async () => { button.props.onPress(); });
        await flushHookEffects({ cycles: 10 });
    };
    await screen.pressByTestIdAsync('reopened-prices-0.open');
    expect(visibleCards()).toHaveLength(1);
    await pressVisibleClose();
    expect(visibleCards()).toHaveLength(0);
    const authority = captureActiveServerAccountScopeLifetime();
    await act(async () => { router.push('/settings/usage?layoutId=sources&period=today'); });
    await vi.waitFor(() => expect(screen.findByTestId('reconnecting-sources.machine.machine.source.source-0.add')).toBeTruthy());
    expect(sourceCalls).toContain('usage.sources.discover');
    const socket = sockets.at(-1)!;
    expect(socket).toBeDefined();
    expect(socket.connected).toBe(true);
    await act(async () => { socket.disconnect(); });
    expect(socket.connected).toBe(false);
    await act(async () => { socket.connect(); });
    expect(socket.connected).toBe(true);
    await vi.waitFor(() => expect(sourceCalls).toContain('usage.sources.get'));
    const { sync } = await import('@/sync/sync');
    await act(async () => { await sync.resumeSync('socket-reconnect'); });
    expect(home!.requests.some(request => request.path === '/v2/changes')).toBe(true);
    expect(captureActiveServerAccountScopeLifetime()).toBe(authority);
    await act(async () => { router.push('/settings/usage?layoutId=costs&period=7days'); });
    await screen.pressByTestIdAsync('reopened-prices-2.open');
    expect(visibleCards()).toHaveLength(1);
    const rowId = 'reopened-prices-2.editor.model.gpt-5.6-luna';
    await screen.pressByTestIdAsync(`${rowId}.set`);
    const originalRate = screen.findByTestId(`${rowId}.input`)!.props.value;
    await act(async () => { screen.findByTestId(`${rowId}.input`)!.props.onChangeText('0.0135'); });
    expect(screen.findByTestId(`${rowId}.input`)!.props.value).toBe('0.0135');
    await screen.pressByTestIdAsync(`${rowId}.cancel`);
    expect(screen.findAllByType(ExpandableItem).find(row => row.props.testID === rowId)?.props.expanded).toBe(false);
    await screen.pressByTestIdAsync(`${rowId}.set`);
    expect(screen.findByTestId(`${rowId}.input`)!.props.value).toBe(originalRate);
    const close = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('common.close'));
    expect(close).toBeDefined();
    if (surface === 'button') await pressVisibleClose();
    else if (surface === 'escape') {
        await act(async () => { expect(dispatchEscapeToLayerStack({ key: 'Escape' })).toBe(true); });
    } else if (surface === 'scrim') {
        const shell = visibleCards()[0]!.findAll(node => node.type === 'div' && node.props.role === 'dialog')[0]!;
        await act(async () => { shell.props.onClick({ target: null, preventDefault() {}, stopPropagation() {} }); });
    } else await invoke(close!.id);
    await flushHookEffects({ cycles: 10 });
    expect(visibleCards()).toHaveLength(0);
    expect(reader!.resolveCurrentUiCommand(close!.id)).toBeNull();
});

it('publishes descendant command changes without rerendering unchanged page content', async () => {
    const { screen } = await mount(<WorkDetails />);
    const before = reader!.readCurrentUiContext()!.commands;
    const project = before.find(command => command.title.startsWith('Project details'))!;
    const branch = before.find(command => command.title.startsWith('Branch details'))!;
    expect(project).toBeDefined();
    expect(branch).toBeDefined();
    publicationContentCounter.reset();

    await screen.pressByTestIdAsync('project-details');

    expect(screen.findByTestId('project-details')!.props.children).toBe('true');
    const after = reader!.readCurrentUiContext()!.commands;
    expect(after.find(command => command.title.startsWith('Project details'))?.title).not.toBe(project.title);
    expect(after.find(command => command.title === branch.title)?.id).toBe(branch.id);
    expect(reader!.resolveCurrentUiCommand(project.id)).toBeNull();
    expect(publicationContentCounter.read()).toEqual({ renders: 0, commits: 0 });
});

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

it.each(['page', 'sheet'] as const)('exposes model price disclosure and its editable draft through the same mounted command owner (%s)', async entry => {
    const query = normalizeUsageQuery({});
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const props = bodyProps({ queries: [query], accounting: [{ query, status: 'available', value: { v: 1,
        totals: { eventCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [{
            id: 'price-control', sessionId: null, turnId: null, observedAtMs: 1, agentId: null, modelId: 'parity-private-model',
            machineId: null, projectKey: null, workspaceId: null, source: null, tokens,
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
        }] } }] });
    const { screen } = await mount(entry === 'sheet'
        ? <UsageModelPricesLine slice={props.slice} serverId="home" testID="price-controls" />
        : <UsageModelPricesEditor slice={props.slice} serverId="home" testID="price-controls" />, false, entry === 'sheet');
    if (entry === 'sheet') await screen.pressByTestIdAsync('price-controls.open');
    const rowId = `${entry === 'sheet' ? 'price-controls.editor' : 'price-controls'}.model.parity-private-model`;
    await screen.pressByTestIdAsync(`${rowId}.set`);
    expect(screen.findByTestId(`${rowId}.input`)).not.toBeNull();
    const rate = reader!.readCurrentUiContext()!.commands.find(command => command.title === `parity-private-model: ${t('usage.board.page.priceInput')}`);
    expect(rate).toBeDefined();
    await act(async () => {
        expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: rate!.id, input: '2.5' }, context: { surface: 'agent' } })).toMatchObject({ ok: true });
    });
    expect(screen.findByTestId(`${rowId}.input`)!.props.value).toBe('2.5');
    await screen.pressByTestIdAsync(`${rowId}.cancel`);
    expect(screen.findAllByType(ExpandableItem).find(row => row.props.testID === rowId)?.props.expanded).toBe(false);
    expect(reader!.resolveCurrentUiCommand(rate!.id)).toBeNull();
    const reopen = reader!.readCurrentUiContext()!.commands.find(command => command.title.startsWith('parity-private-model'));
    const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
    await act(async () => {
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: reopen!.id },
            { surface: 'agent', serverId: home!.homes.a!.id })).toMatchObject({ ok: true });
    });
    expect(screen.findByTestId(`${rowId}.input`)).not.toBeNull();
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

    // A failed request has no failed Session identity, but both entry points can retry it.
    const partial = model('partial', { notRead: 0 });
    historyModel = { ...partial, state: { ...partial.state!, errorCode: 'database_transaction_timeout' } };
    await rerender();
    expect(historyFact).toMatchObject({ label: t('common.retry'), failed: true, onPress: expect.any(Function) });
    expect(historyCommand().map(command => command.title)).toEqual([t('usage.board.page.historyReadCommand')]);
    const beforeRetry = calls.length;
    await act(async () => { historyFact!.onPress(); });
    await flushHookEffects({ cycles: 4 });
    await invoke(historyCommand()[0]!.id);
    expect(calls.slice(beforeRetry)).toEqual(['read', 'read']);

    // Unreadable coverage alone has no useful retry, even after the request recovers.
    historyModel = { ...partial, state: { ...partial.state!, errorCode: 'forbidden' } };
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
