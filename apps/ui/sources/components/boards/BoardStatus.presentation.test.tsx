import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactTestRendererJSON } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { installMessageViewCommonModuleMocks } from '@/components/sessions/transcript/messageViewTestHelpers';
import type { WorkBoardEntityBinding } from './model/workBoardEntityBinding';

const capture = vi.hoisted(() => ({ dark: false, width: 1440 }));
// Native adapters only: real Collection, card, status, store and Work-map logic remain beneath them.
installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const web = await vi.importActual<typeof import('react-native-web')>('react-native-web');
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const FlatList = React.forwardRef<unknown, { data: readonly unknown[];
            renderItem: (args: { item: unknown; index: number }) => React.ReactNode;
            keyExtractor: (item: unknown, index: number) => string }>((props, ref) => {
            React.useImperativeHandle(ref, () => ({ scrollToIndex() {}, scrollToOffset() {}, scrollToEnd() {} }));
            return <web.View>{props.data.map((item, index) => <React.Fragment key={props.keyExtractor(item, index)}>
                {props.renderItem({ item, index })}</React.Fragment>)}</web.View>;
        });
        return createReactNativeWebMock({ ...web, FlatList,
            useWindowDimensions: () => ({ width: capture.width, height: 1000, scale: 1, fontScale: 1 }) });
    },
    unistyles: async () => {
        const { lightTheme, darkTheme } = await import('@/theme');
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        const light = await createUnistylesMock({ theme: lightTheme });
        const dark = await createUnistylesMock({ theme: darkTheme });
        const current = () => {
            const active = (capture.dark ? dark : light).useUnistyles();
            return { ...active, rt: { ...active.rt, screen: { width: capture.width, height: 1000 },
                colorScheme: capture.dark ? 'dark' : 'light' } };
        };
        return { ...light, useUnistyles: current, StyleSheet: { ...light.StyleSheet,
            create: (input: unknown) => {
                if (typeof input !== 'function') return input;
                const resolve = () => { const { theme, rt } = current(); return input(theme, rt) as Record<string, unknown>; };
                const entries = new Map<PropertyKey, object>();
                return new Proxy(resolve(), { get: (_target, key) => {
                    const value = Reflect.get(resolve(), key);
                    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
                    if (!entries.has(key)) entries.set(key, new Proxy(value, {
                        get: (_entry, field) => Reflect.get(Reflect.get(resolve(), key), field),
                    }));
                    return entries.get(key);
                } });
            } }, UnistylesRuntime: { ...light.UnistylesRuntime, getTheme: () => current().theme } };
    },
    text: async () => vi.importActual('@/text'),
});
vi.unmock('@/components/ui/icons/Icon');
vi.unmock('@/components/ui/avatar/Avatar');
vi.mock('@/sync/sync', async () => ({ sync: (await import('@/dev/testkit/mocks/sync')).createSessionListHydrationSyncBoundary() }));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const web = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    const boundary = createReanimatedModuleMock();
    return { ...boundary, default: { ...boundary.default, View: web.View, Text: web.Text, ScrollView: web.ScrollView } };
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.mock('react-native-svg', () => {
    const host = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props);
    return { ...Object.fromEntries(['Svg', 'Path', 'Circle', 'Rect', 'Defs', 'RadialGradient', 'LinearGradient', 'Stop',
        'G', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'ClipPath', 'Mask', 'Use', 'Text', 'TSpan'].map(name =>
        [name, host(name === 'Svg' ? 'svg' : name[0]!.toLowerCase() + name.slice(1))]).concat([['default', host('svg')]])),
        SvgXml: ({ xml, width, height }: { xml: string; width: number; height: number }) =>
            <span style={{ display: 'inline-flex', width, height }} dangerouslySetInnerHTML={{ __html: xml }} /> };
});

const { storage } = await import('@/sync/domains/state/storage');
const { renderScreen, standardCleanup, createSessionFixture, createMachineFixture } = await import('@/dev/testkit');
const { BoardByStatus } = await import('./byStatus/BoardByStatus');
const { BoardCanvas } = await import('./canvas/BoardCanvas');
const { createEntityDragDropRuntime } = await import('@/components/ui/treeDragDrop/entityDragDropRuntime');
const { createWorkBoardArtifactBoundary } = await import('@/dev/testkit/harness/workBoardArtifactBoundary');
const { createWorkBoardAccountStore } = await import('./model/workBoardAccountStore');
const { createWorkBoardUiActionPort } = await import('./model/workBoardEntityDrop');
const { WorkflowRunContent } = await import('@/components/workflows/run/WorkflowRunContent');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
const { buildBoardCards } = await import('./model/boardCards');
const { projectBoardMembership } = await import('./model/boardMembership');
const [{ createWorkBoardV1}, { WorkBoardActionInputSchemasV1}] = await Promise.all([import('@happier-dev/protocol/boards/workBoardV1'), import('@happier-dev/protocol/boards/actionsV1')]);
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { projectWork } = await import('@/components/sessions/work/workProjection');
const { toWorkReportSessionSource } = await import('@/components/sessions/work/sessionWorkSources');
const { projectSessionWorkMap } = await import('@/components/sessions/work/workMapProducer');
const { SessionWorkMapView } = await import('@/components/sessions/work/SessionWorkMapView');
const { HubStatusLineView } = await import('@/components/hub/header/HubStatusLine');
const { HubAttentionList } = await import('@/components/hub/HubAttentionSection');
const { NewSessionDraftComposerActions } = await import('@/components/sessions/drafts/NewSessionDraftComposerActions');
const { RunWorkNotifyOperation } = await import('@/components/sessions/work/RunWorkNotifications');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { UniversalSearchRuntimeProvider } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
const { lightTheme, darkTheme } = await import('@/theme');
const { t } = await import('@/text');
const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
const { Text: CaptureText } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
const { buildInboxWorkGroups } = await import('@/activity/presentation/buildInboxWorkGroups');
const { InboxContent } = await import('@/components/inbox/InboxContent');
const { buildInboxItems } = await import('@/components/inbox/inboxItems');
const { createInboxAttentionFixture } = await import('@/dev/testkit/fixtures/inboxFixtures');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { PageHeader } = await import('@/components/ui/layout/PageHeader');
const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); vi.restoreAllMocks(); });
function hostTree(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): React.ReactNode {
    if (node === null || typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(hostTree);
    return React.createElement(node.type, node.props, ...(node.children ?? []).map(hostTree));
}
const variants = [{ dark: false, width: 1440 }, { dark: false, width: 390 }, { dark: true, width: 1440 }, { dark: true, width: 390 }];
it.each(variants)('renders the STATUS source surfaces ($dark / $width)', async variant => {
    Object.assign(capture, variant);
    const now = Date.UTC(2026, 9, 9, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const home = await upsertServerProfile({ serverUrl: 'https://dv3-status-capture.test' });
    const machine = createMachineFixture({ id: 'mac', active: true, activeAt: now,
        metadata: { ...createMachineFixture().metadata!, displayName: 'MacBook Pro' } });
    const pending = createSessionFixture({ id: 'payments', serverId: home.id, active: true, presence: 'online', activeAt: now,
        manager: { sessionId: 'lead' },
        metadata: { ...createSessionFixture().metadata!, name: 'Payments rollout', flavor: 'claude', machineId: machine.id,
            path: '/Users/alice/projects/payments', homeDir: '/Users/alice', host: 'MacBook Pro' },
        agentState: { requests: { approval: { tool: 'Bash', arguments: {}, createdAt: now } }, completedRequests: {} } });
    const locked = createSessionFixture({ ...pending, id: 'locked', metadata: null, agentState: null,
        encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_content_unavailable' });
    const rows = [pending, locked].map(session => buildSessionListRenderableFromSession(session));
    storage.setState({ profileScope: { serverId: home.id, accountId: 'capture-account' },
        sessionListRowsByServerId: { [home.id]: Object.fromEntries(rows.map(row => [row.id, row])) },
        machineListByServerId: { [home.id]: [machine] }, sessions: { [pending.id]: pending, [locked.id]: locked } });
    const refs = [...rows.map(row => ({ kind: 'session' as const, qualifiedId: { serverId: home.id, id: row.id } })),
        { kind: 'workflow' as const, qualifiedId: { serverId: home.id, id: 'nightly' } },
        { kind: 'workflow_run' as const, qualifiedId: { serverId: home.id, id: 'release' } },
        { kind: 'machine' as const, qualifiedId: { serverId: home.id, id: machine.id } }];
    // A held Run (Review) and a Machine running two sessions, one of which needs the person.
    const heldRun = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'release', state: 'waiting_for_review',
        attentionRequired: true, machineId: machine.id, createdAt: new Date(now - 2 * 3_600_000).toISOString(),
        updatedAt: new Date(now - 4 * 60_000).toISOString() }), { kind: 'available', value: { title: 'Prepare the 0.3 release' } } as never);
    const membership = projectBoardMembership({ ...createWorkBoardV1({ id: 'capture', name: 'Overview' }),
        source: { picked: refs } }, { isHomeMounted: () => true, sections: {}, filtered: null });
    const cards = buildBoardCards(membership.members, { nowMs: now, session: ref => rows.find(row => row.id === ref.qualifiedId.id) ?? null,
        workflowRun: ref => ref.qualifiedId.id === 'release' ? heldRun : null, machine: ref => ref.qualifiedId.id === machine.id ? machine : null,
        machineScope: () => ({ serverId: home.id, accountId: 'capture-account' }),
        machineSessionCounts: new Map([[JSON.stringify(['machine', home.id, machine.id]), { running: 2, needsYou: 1 }]]), accountScopedHome: () => true,
        workflow: () => ({ title: 'Nightly release check', summary: { needsYouCount: 0, lastRun: null }, nextRun: { kind: 'unscheduled' },
            triggers: [{ kind: 'schedule', schedule: { kind: 'cron', everyMs: null, scheduleExpr: '0 2 * * *', timezone: 'Europe/Zurich' } }] }) });
    const projection = projectWork({ sessionId: 'lead', serverId: home.id,
        reportSessions: [pending, locked].map(session => toWorkReportSessionSource(session, now)),
        agentEntries: [], workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
        describeAgentStatus: () => '', describeProgress: () => '' });
    const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Release lead', projection });
    const canvasCards = [...cards, ...Array.from({ length: 7 }, (_, index) => ({ ...cards[0]!,
        key: JSON.stringify(['session', home.id, `filtered-${index}`]), title: `Filtered work ${index + 1}`,
        ref: { kind: 'session' as const, qualifiedId: { serverId: home.id, id: `filtered-${index}` } }, picked: false }))];
    const canvasBoard = { ...createWorkBoardV1({ id: 'canvas-capture', name: 'Overview' }), source: { picked: refs },
        positionsByItemRef: { [cards[0]!.key]: { x: 24, y: 24 } } };
    const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [canvasBoard] });
    const accountStore = createWorkBoardAccountStore(boundary.transport, () => true);
    const scope = { serverId: home.id, accountId: 'capture-account' };
    const getContext = () => ({ scope, board: canvasBoard, membership, isHomeMounted: () => true });
    const canvasPort = createWorkBoardUiActionPort(getContext, accountStore.queue, accountStore.readBoardAccess);
    const binding: WorkBoardEntityBinding = { runtime: createEntityDragDropRuntime(), scope, isCurrent: () => true, getContext,
        execute: async effect => {
            const { intent } = WorkBoardActionInputSchemasV1['boards.apply'].parse(effect.input);
            await canvasPort.apply(intent);
            return { status: 'applied' };
        } };
    const definition = createWorkflowDefinitionFixture({ blocks: [
        { kind: 'wait', id: 'confirm', document: { text: 'Confirm the release', references: [], attachments: [] } },
    ] });
    const run = createWorkflowRunSummaryFixture({ state: 'waiting_for_review', machineId: machine.id });
    const invocations = [createWorkflowInvocationIndexFixture({ id: 'root' }), createWorkflowInvocationIndexFixture({
        id: 'held', parentRecordId: 'root', sequence: '1', lifecycle: 'waiting_for_review' })];
    const noop = () => {};
    // Inbox (lab `inbox-I1`, `P4`): a run waiting for review (Needs you), then a stalled worker, two
    // pull requests to land and a snoozed session (Updates). Real work-group builder, item model, sections and rows.
    const inboxSession = (id: string, name: string, extra: Record<string, unknown> = {}) => createSessionFixture({ id, serverId: home.id,
        active: true, presence: 'online', activeAt: now, updatedAt: now - 4 * 60_000, ...extra,
        metadata: { ...createSessionFixture().metadata!, name, flavor: 'claude', machineId: machine.id, path: '/Users/alice/projects/payments',
            homeDir: '/Users/alice', host: 'MacBook Pro' } });
    const inboxLead = inboxSession('rollout', 'Payments v2 rollout', { managedSessions: { total: 3, working: 1, needsYou: 1, stalled: 1, finished: 0, attentionPrimary: null } });
    const inboxStalled = inboxSession('ledger', 'Backfill intent ledger', { manager: { sessionId: 'rollout' }, presence: 'offline', active: false });
    const inboxRunbook = inboxSession('runbook', 'Support runbook for retries', { manager: { sessionId: 'rollout' } });
    const inboxModal = inboxSession('modal', 'Fix settings modal remount');
    const inboxPricing = inboxSession('pricing', 'Pricing page copy');
    const inboxSessions = new Map([inboxLead, inboxStalled, inboxRunbook, inboxModal, inboxPricing].map(session => [session.id, session]));
    const inboxWorkGroups = buildInboxWorkGroups({ sessionEntries: [],
        workflowRuns: [workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'release', state: 'waiting_for_review', machineId: machine.id,
            updatedAt: new Date(now - 6 * 60_000).toISOString() }), { kind: 'available', value: { title: 'Prepare the 0.3 release' } } as never)],
        automationRuns: [], automationServerId: home.id, openApprovals: [], stalledSessions: [inboxStalled],
        landings: [
            { session: inboxRunbook, link: { sessionId: 'runbook', serverId: home.id, number: 2490, url: 'https://github.com/acme/payments/pull/2490', title: 'Support runbook for retries', state: 'open' } },
            { session: inboxModal, link: { sessionId: 'modal', serverId: home.id, number: 2493, url: 'https://github.com/acme/payments/pull/2493', title: 'Keep the settings modal mounted', state: 'open' } },
        ],
        snoozed: [{ session: inboxPricing, remindAt: now + 3 * 3_600_000 }],
        resolveSession: id => inboxSessions.get(id), resolveOriginRunId: () => null });
    const inboxSessionPresentation = { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] };
    const inboxModel = { ...createInboxAttentionFixture(home.id), spansHomes: false, settle: async () => {}, setReminder: async () => {},
        workGroups: inboxWorkGroups, sessionPresentation: inboxSessionPresentation,
        items: buildInboxItems({ workGroups: inboxWorkGroups, sessionPresentation: inboxSessionPresentation,
            workflowServerId: home.id, accountServerId: home.id, notices: [] }),
        openApprovals: [], openUsageNotices: [], friendRequests: [], actionOperationEntries: [], targetBySessionAddress: new Map(),
        pendingReadKeys: new Set(), markAllPending: false, isLoading: false, hasPrimaryAttention: true, showCaughtUp: false,
        readUnavailableReasonBySessionAddress: new Map(), markAllReadUnavailableReason: null,
        markRead: async () => {}, resolveActionOperation: noop, dismissUsageNotice: async () => {} } as never;
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
        <UniversalSearchRuntimeProvider value={{ open: noop, buildCommands: () => [] }}>
            <main>
                <section id="board"><h2>By status</h2><div style={{ height: capture.width === 390 ? 650 : 360 }}>
                    <div style={{ width: capture.width === 390 ? 390 : 980, height: '100%' }}><BoardByStatus cards={cards} stacked={capture.width === 390} onOpen={noop} onAction={noop} /></div></div></section>
                <section id="canvas"><h2>Filtered Canvas</h2><div style={{ height: 850, overflow: 'hidden', width: capture.width === 390 ? 390 : 980 }}>
                    <BoardCanvas cards={canvasCards} positionsByItemRef={canvasBoard.positionsByItemRef} snap={false}
                        binding={binding} onOpen={noop} onAction={noop} /></div></section>
                <section id="work"><h2>Work map</h2><div style={{ width: capture.width === 390 ? 390 : 420 }}>
                    <SessionWorkMapView map={map} projection={projection} showFacts={false} testIDPrefix="capture-work" onOpenItem={noop} /></div></section>
                <section id="inbox"><h2>Inbox</h2><div style={{ width: capture.width === 390 ? 390 : 1000 }}><ItemList testID="capture-inbox">
                    <PageHeader title={t('tabs.inbox')} description={t('inbox.work.pageDescription')} actions={capture.width === 390 ? undefined
                        : <SegmentedTabBar tabs={[{ id: 'needs_you', label: t('inbox.work.tabs.needsYou'), count: '1' },
                            { id: 'updates', label: t('inbox.work.tabs.updates') },
                            { id: 'mentions', label: t('inbox.work.tabs.mentions') }]} activeTabId="needs_you" onSelectTab={noop} />} />
                    <InboxContent model={inboxModel} presentation="screen" view="needs_you" /></ItemList>
                    <ItemList testID="capture-inbox-updates"><InboxContent model={inboxModel} presentation="screen" view="updates" /></ItemList></div></section>
                <section id="home"><h2>Home</h2><HubStatusLineView working={0} needsYou={1} home={() => <CaptureText
                    style={{ color: (capture.dark ? darkTheme : lightTheme).colors.text.secondary }}>Personal Home</CaptureText>} />
                    <HubAttentionList items={[{ key: 'sessions', mark: null, title: t('homeIndex.sessionsAwaitingResponse', { count: 1 }),
                        actionLabel: t('settingsOverview.review'), onAction: noop }]} /></section>
                <section id="draft"><h2>Draft actions</h2><NewSessionDraftComposerActions deleteDisabled={false} onStartAnother={noop} onDelete={async () => {}} /></section>
                <section id="run"><h2>Run detail</h2><AppPaneProvider>
                    <WorkflowRunContent run={run} title="Release check" machineName="MacBook Pro" definition={definition}
                        invocations={invocations} invocationsLoaded invocationHistoryComplete selectedInvocationId={null}
                        firstFailedInvocationId={null} firstFailedInvocationResolution="resolved"
                        onSelectInvocation={noop} view="flow" onChangeView={noop} onCancel={noop} onPause={noop}
                        notificationOperation={<RunWorkNotifyOperation source={{ kind: 'workflow_run', runId: run.id }}
                            read={{ status: 'ready', once: [], pendingIntent: null, errorIntent: null,
                                change: async () => { throw new Error('Capture cannot edit a Follow'); } }} />}
                        sourceAction={{ kind: 'edit', onPress: noop }} />
                </AppPaneProvider></section>
            </main>
        </UniversalSearchRuntimeProvider>
    </InjectedAuthProvider>);
    const layout = screen.tree.root.findAll(node => node.props.testID === 'board-by-status:stage' && typeof node.props.onLayout === 'function');
    expect(layout.length).toBeGreaterThan(0);
    await act(async () => layout[0]!.props.onLayout({ nativeEvent: { layout: { width: capture.width === 390 ? 390 : 980, height: 650 } } }));
    const canvasLayout = screen.tree.root.find(node => node.props.testID === 'board-canvas' && typeof node.props.onLayout === 'function');
    await act(async () => canvasLayout.props.onLayout({ nativeEvent: { layout: {
        width: capture.width === 390 ? 390 : 980, height: 850,
    } } }));
    await act(async () => {
        for (const member of canvasCards) {
            let frame = screen.findHostByTestId(`board-canvas-card:${member.key}`)!;
            while (!frame.props.onLayout) frame = frame.parent!;
            frame.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 154 } } });
        }
    });
    const body = renderToStaticMarkup(<>{hostTree(screen.tree.toJSON())}</>);
    expect(body).toContain('MacBook Pro');
    expect(body).not.toContain('Session·');
    const output = process.env.DV3_STATUS_CAPTURE_DIR;
    if (!output) return;
    const theme = capture.dark ? darkTheme : lightTheme;
    const web = await vi.importActual<{ StyleSheet: { getSheet(): { textContent: string } } }>('react-native-web');
    const fonts = ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold'].map(name =>
        `@font-face{font-family:${name};src:url(data:font/ttf;base64,${readFileSync(new URL(`../../assets/fonts/${name}.ttf`, import.meta.url)).toString('base64')})}`).join('');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${capture.dark ? 'dark' : 'light'}-${capture.width}.html`), `<!doctype html><html><meta charset="utf-8"><style>${fonts}${web.StyleSheet.getSheet().textContent}
        body{margin:0;background:${theme.colors.surface.base};color:${theme.colors.text.primary};font:14px Inter-Regular,system-ui}section{margin-bottom:24px}h2{margin:16px;font-size:20px;font-weight:600}</style><body>${body}</body></html>`);
});
