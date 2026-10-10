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
const { createWorkBoardV1, WorkBoardActionInputSchemasV1 } = await import('@happier-dev/protocol');
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
        reportsTo: { sessionId: 'lead' },
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
        { kind: 'workflow' as const, qualifiedId: { serverId: home.id, id: 'nightly' } }];
    const membership = projectBoardMembership({ ...createWorkBoardV1({ id: 'capture', name: 'Overview' }),
        source: { picked: refs } }, { isHomeMounted: () => true, sections: {}, filtered: null });
    const cards = buildBoardCards(membership.members, { nowMs: now, session: ref => rows.find(row => row.id === ref.qualifiedId.id) ?? null,
        workflowRun: () => null, machine: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        workflow: () => ({ title: 'Nightly release check', summary: { needsYouCount: 0, lastRun: null }, nextRun: { kind: 'unscheduled' },
            triggers: [{ kind: 'schedule', schedule: { kind: 'cron', everyMs: null, scheduleExpr: '0 2 * * *', timezone: 'Europe/Zurich' } }] }) });
    const projection = projectWork({ sessionId: 'lead', serverId: home.id,
        reportSessions: [pending, locked].map(session => toWorkReportSessionSource(session, now)),
        agentEntries: [], workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
        describeAgentStatus: () => '', describeProgress: () => '' });
    const map = projectSessionWorkMap({ leadSessionId: 'lead', leadTitle: 'Release lead', projection });
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
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
        <UniversalSearchRuntimeProvider value={{ open: noop, buildCommands: () => [] }}>
            <main>
                <section id="board"><h2>By status</h2><div style={{ height: capture.width === 390 ? 650 : 360 }}>
                    <div style={{ width: capture.width === 390 ? 390 : 980, height: '100%' }}><BoardByStatus cards={cards} stacked={capture.width === 390} onOpen={noop} /></div></div></section>
                <section id="canvas"><h2>Filtered Canvas</h2><div style={{ height: 850, width: capture.width === 390 ? 390 : 980 }}>
                    <BoardCanvas cards={canvasCards} positionsByItemRef={canvasBoard.positionsByItemRef} snap={false}
                        binding={binding} onOpen={noop} /></div></section>
                <section id="work"><h2>Work map</h2><SessionWorkMapView map={map} projection={projection} testIDPrefix="capture-work" onOpenItem={noop} /></section>
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
                            project={{ machineId: machine.id, directory: '/Users/alice/projects/payments' }}
                            read={{ status: 'ready', sets: [], add: async () => { throw new Error('Capture cannot write a trigger'); },
                                remove: async () => { throw new Error('Capture cannot remove a trigger'); } }} />}
                        sourceAction={{ kind: 'edit', onPress: noop }} />
                </AppPaneProvider></section>
            </main>
        </UniversalSearchRuntimeProvider>
    </InjectedAuthProvider>);
    const layout = screen.tree.root.findAll(node => node.props.testID === 'board-by-status:stage' && typeof node.props.onLayout === 'function');
    expect(layout.length).toBeGreaterThan(0);
    await act(async () => layout[0]!.props.onLayout({ nativeEvent: { layout: { width: capture.width === 390 ? 390 : 980, height: 650 } } }));
    await act(async () => screen.findHostByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout: {
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
