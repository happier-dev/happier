// @vitest-environment jsdom
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { act, type ReactTestRendererJSON } from 'react-test-renderer';
import { installMessageViewCommonModuleMocks } from '@/components/sessions/transcript/messageViewTestHelpers';

const capture = vi.hoisted(() => ({ dark: process.env.HB2B_CAPTURE_THEME === 'dark', width: Number(process.env.HB2B_CAPTURE_WIDTH ?? 1440) }));
const resource = vi.hoisted(() => ({ read: vi.fn() }));
// Daemon resource transport only: keep packaged-brand admission and rendering real.
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (original) => ({
    ...await original<typeof import('@/sync/ops/machineContributionRegistryProjection')>(),
    machinePluginUiResourceRead: resource.read,
}));
// Window/portal boundary only. Width is constrained by the comparison panel, as a phone sheet is.
vi.mock('@/components/ui/popover', async (original) => {
    const actual = await original<typeof import('@/components/ui/popover')>();
    const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
    const { FloatingOverlaySheetContext } = await import('@/components/ui/overlays/FloatingOverlay');
    const { View } = await vi.importActual<typeof import('react-native')>('react-native-web');
    return { ...actual, Popover: (props: React.ComponentProps<typeof actual.Popover>) => {
        if (!props.open) return null;
        const sheet = capture.width === 390 && props.phonePresentation === 'sheet';
        const body = typeof props.children === 'function' ? props.children({ maxHeight: 640,
            maxWidth: sheet ? 358 : 420, placement: 'bottom', presentation: sheet ? 'sheet' : 'anchored',
            requestClose: () => props.onRequestClose?.() }) : props.children;
        return sheet ? <ModalCardFrame presentation="sheet" title={props.accessibilityLabel} subtitle={props.sheetSubtitle}
            actions={props.sheetHeaderAction} onClose={props.sheetHeaderAction ? undefined : () => props.onRequestClose?.()}>
            <FloatingOverlaySheetContext.Provider value>{body}</FloatingOverlaySheetContext.Provider>
        </ModalCardFrame> : <View style={{ width: '100%', maxWidth: 420 }}>{body}</View>;
    } };
});
// Native animation/image/recycler SDKs cannot draw in JSDOM. Retain their
// canonical testkit behavior while using the real web hosts for source styling.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const web = await vi.importActual<typeof import('react-native')>('react-native-web');
    const animated = { View: web.View, ScrollView: web.ScrollView, Text: web.Text,
        createAnimatedComponent: (component: React.ElementType) => component };
    return { ...createReanimatedModuleMock(), ...animated, default: animated };
});
// Exercise SafeExpoImage's existing React Native fallback on real web Image.
vi.mock('expo-image', () => ({ Image: undefined }));
vi.mock('@legendapp/list/react-native', async (original) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await original<Record<string, unknown>>(), renderItems: true }).module;
});
// Native adapters are replaced with the real web renderer and the canonical theme, not component/domain mocks.
installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const web = await vi.importActual<Record<string, unknown>>('react-native-web');
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ ...web,
            useWindowDimensions: () => ({ width: capture.width, height: 1000, scale: 1, fontScale: 1 }) });
    },
    unistyles: async () => {
        const { lightTheme, darkTheme } = await import('@/theme');
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        const light = await createUnistylesMock({ theme: lightTheme });
        const dark = await createUnistylesMock({ theme: darkTheme });
        const current = () => ({ ...(capture.dark ? dark : light).useUnistyles(),
            rt: { screen: { width: capture.width, height: 1000 }, colorScheme: capture.dark ? 'dark' : 'light' } });
        // Native Unistyles styles follow the active theme. Keep that SDK boundary reactive so
        // four source comparisons can share the expensive module graph, without recolouring DOM.
        return { ...light, useUnistyles: current, StyleSheet: { ...light.StyleSheet,
            create: (input: unknown) => {
                if (typeof input !== 'function') return input;
                const resolve = () => { const { theme, rt } = current(); return input(theme, rt) as Record<string, unknown>; };
                const entries = new Map<PropertyKey, object>();
                return new Proxy(resolve(), { get: (_target, key) => {
                    const value = Reflect.get(resolve(), key);
                    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
                    // Hosts retain style entries (Collection's text roles, for example), not just
                    // the sheet itself. Those entries must follow the SDK's theme too.
                    if (!entries.has(key)) entries.set(key, new Proxy(value, {
                        get: (_entry, field) => Reflect.get(Reflect.get(resolve(), key), field),
                    }));
                    return entries.get(key);
                } });
            } }, UnistylesRuntime: { ...light.UnistylesRuntime, getTheme: () => current().theme } };
    },
    text: async () => vi.importActual('@/text'),
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.unmock('@/components/ui/icons/Icon');
vi.unmock('@/components/ui/avatar/Avatar');
// Select the actual platform adapter; the native switch cannot draw in a serialized web fixture.
vi.mock('@/components/ui/forms/Switch', async () => vi.importActual('@/components/ui/forms/Switch.web'));
vi.mock('react-native-svg', () => {
    const host = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props);
    return Object.fromEntries(['Svg', 'Path', 'Circle', 'Rect', 'Defs', 'RadialGradient', 'LinearGradient', 'Stop',
        'G', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'ClipPath', 'Mask', 'Use', 'Text', 'TSpan'].map(name =>
        [name, host(name === 'Svg' ? 'svg' : name[0]!.toLowerCase() + name.slice(1))]).concat([['default', host('svg')]]));
});
// This capture uses plain prompt text. Native Markdown SDK layout is an explicit capture limitation.
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: (props: Record<string, unknown>) =>
    React.createElement('span', { style: props.style }, props.markdown as string) }));

const { storage } = await import('@/sync/domains/state/storage');
const webHosts = await vi.importActual<typeof import('react-native')>('react-native-web');
afterEach(async () => { (await import('@/dev/testkit')).standardCleanup(); storage.setState(storage.getInitialState(), true); });

function hostTree(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): React.ReactNode {
    if (node === null || typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(hostTree);
    if (node.type === 'LegendList' || node.type === 'LegendListItem') {
        return React.createElement(webHosts.View, { style: node.props.contentContainerStyle }, ...(node.children ?? []).map(hostTree));
    }
    return React.createElement(node.type, node.props, ...(node.children ?? []).map(hostTree));
}

// Module loading belongs to collection, not the existing per-interaction timeout.
const { WorkflowTriggerSetV1Schema } = await import('@happier-dev/protocol');
const { lightTheme, darkTheme } = await import('@/theme');
const { ScheduledWorkflowSectionView } = await import('./ScheduledWorkflowSection');
const { SessionTriggersSectionView } = await import('./SessionTriggersSection');
const { projectScheduledWorkflowRows } = await import('./scheduledWorkflowRows');
const { projectSessionTriggerGroups } = await import('./sessionTriggerGroups');
const { WorkflowRunItemBody } = await import('@/components/sessions/shell/row/WorkflowRunItemBody');
const { WorkSection } = await import('@/components/sessions/work/WorkSection');
const { TriggerPopover } = await import('./TriggerPopover');
const { readScheduleWhen, createDefaultThen } = await import('./sessionTriggerForm');
const { WorkflowTriggerSection } = await import('./WorkflowTriggerSection');
const { InlinePluginEventEditor } = await import('@/components/automations/editor/PluginEventAutomationEditor');
const { WorkflowRunComposer } = await import('@/components/workflows/run/WorkflowRunComposer');
const { t } = await import('@/text');
const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
const { FloatingOverlaySheetContext } = await import('@/components/ui/overlays/FloatingOverlay');
const { BoardCardView } = await import('@/components/boards/cards/BoardCardView');
const { DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema, PluginProjectionInstalledPackageV2Schema } = await import('@happier-dev/protocol');
import type { PluginEventAutomationComposerModel } from '@/components/automations/editor/usePluginEventAutomationComposer';
const { MessageViewWithSessionCommon } = await import('@/components/sessions/transcript/MessageView');
const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');

const variants = process.env.HB2C_CAPTURE_ALL === '1'
    ? [{ dark: false, width: 1440 }, { dark: false, width: 390 }, { dark: true, width: 1440 }, { dark: true, width: 390 }]
    : [{ dark: capture.dark, width: capture.width }];

it.each(variants)('captures D6 source surfaces beside their existing Work-row reference ($dark / $width)', async (variant) => {
    Object.assign(capture, variant);
    // JSDOM has no Web Locks SDK. This single-window fixture retains the real Home mutation owner.
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (_name: string, run: () => Promise<unknown>) => run(),
    } });
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 8, 12).getTime());
    const theme = capture.dark ? darkTheme : lightTheme;
    const home = await upsertServerProfile({ serverUrl: 'https://hb2b-capture.test' });
    storage.setState({ profileScope: { serverId: home.id, accountId: 'account-1' }, sessions: {
        destination: createSessionFixture({ id: 'destination', metadata: { ...createSessionFixture().metadata!, name: 'Release workspace' } }),
    } });
    const run = createWorkflowRunSummaryFixture({ id: 'daily-run', state: 'running',
        stepProgress: { completed: 1, total: 3 } });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run, { kind: 'available', value: { title: 'Daily digest' } })]);
    const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'daily', revision: 1, enabled: true, health: 'available',
        scopeSessionId: 'destination', target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [{ kind: 'step', id: 'review', name: 'Review overnight changes',
            document: { text: 'Review overnight changes', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
        destinations: { targetSessionIds: ['destination'], usesOriginSession: false, unresolvedWorkflowRefs: [],
            leaves: [{ sourceKey: '$root', blockId: 'review', sessionIds: ['destination'], ordinal: 1, name: 'Review overnight changes' }] },
        triggers: [{ id: 'morning', revision: 1, enabled: true, kind: 'schedule', nextRunAt: Date.UTC(2026, 9, 9, 7),
            createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
            schedule: { kind: 'cron', everyMs: null, scheduleExpr: '0 9 * * *', timezone: 'Europe/Zurich' } }] });
    const rows = projectScheduledWorkflowRows([set]);
    const groups = projectSessionTriggerGroups({ sets: [set],
        lastRunAtByAutomationId: { daily: new Date(2026, 9, 7, 9).getTime() },
        lastRunsByAutomationId: { daily: createWorkflowRunSummaryFixture({ state: 'succeeded' }) },
        resolveWorkflowTitle: () => null, formatAge: () => 'yesterday' });
    const noop = () => {};
    const row = <WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId={home.id} isSingle />;
    const workRow = <WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId={home.id} presentation="work" />;
    const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({ event: {
        id: 'happier.scm.forge.github/automation/issue-opened-v1',
        identity: { pluginId: 'happier.scm.forge.github', localId: 'automation/issue-opened-v1' },
        occurrenceId: 'capture-github', sourceCustody: { kind: 'development', registeredRootId: 'capture-root' },
        title: 'GitHub issue opened', description: 'An issue is opened in a repository',
        payloadSchema: { type: 'object', properties: { action: { type: 'string' } }, additionalProperties: false },
        automation: { v: 1, eligible: true, source: { sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema: { type: 'object', additionalProperties: false },
            setupActionRef: { pluginId: 'happier.scm.forge.github', localId: 'setup-source' } } },
    }, setupAction: { id: 'happier.scm.forge.github/setup-source',
        identity: { pluginId: 'happier.scm.forge.github', localId: 'setup-source' }, occurrenceId: 'capture-github',
        title: 'Set up source', description: null, inputSchema: { type: 'object', additionalProperties: false }, inputHints: null } });
    const digest = `sha256:${'b'.repeat(64)}`;
    // The wrapped UI Vitest owner runs at the package root; JSDOM's import.meta URL is not a filesystem URL.
    const repoRoot = resolve(process.cwd(), '../..');
    const brandBytes = readFileSync(join(repoRoot, 'packages/plugins/scm-github/assets/brand.png'));
    resource.read.mockResolvedValue({ supported: true, result: { ok: true, kind: 'asset',
        resource: { pluginId: 'happier.scm.forge.github', localId: 'brand-icon' }, contentType: 'image/png',
        digest, bytesBase64: brandBytes.toString('base64') } });
    const installedPackage = PluginProjectionInstalledPackageV2Schema.parse({ id: 'happier.scm.forge.github', displayName: 'GitHub',
        enabled: true, version: '1.0.0', occurrenceId: 'capture-github', source: { kind: 'localPath', locator: 'capture-root' },
        brand: { state: 'available', resource: { pluginId: 'happier.scm.forge.github', localId: 'brand-icon' }, digest,
            width: 128, height: 128, monochrome: true } });
    const pluginPresentation: ReturnType<PluginEventAutomationComposerModel['getPluginPresentation']> = {
        eventKey: event.event.id, displayName: 'GitHub', availability: 'available',
            installedPackage, expectedOccurrenceId: 'capture-github', machineId: 'capture-machine', serverId: home.id,
            accountLifetime: { scope: { serverId: home.id, accountId: 'account-1' }, isCurrent: () => true,
                onRetire: () => ({ dispose: noop }) }, isCurrent: () => true,
    };
    const model: PluginEventAutomationComposerModel = {
        eligibleEvents: [event], eventCatalogStatus: 'ready', selectedEvent: null, selectEvent: noop,
        getPluginPresentation: () => pluginPresentation,
        sourceStatus: 'idle', sourceFailure: null, sourceDisplayLabel: null, sourceInstanceId: null, configureSource: noop,
        availableObservationTransports: ['checkpointedPull'], observationTransport: 'checkpointedPull', setObservationTransport: noop,
        webhookEndpoint: null, refreshWebhookEndpoint: null, webhookEndpointRefreshing: false, watcherCandidates: [],
        selectedWatcherOrigin: null, selectWatcher: noop, payloadBrowser: { fields: [], samplePayload: null }, filterClauses: [],
        addFilterClause: noop, removeFilterClause: noop, setFilterClauseField: noop, setFilterClauseOperator: noop,
        setFilterClauseValueText: noop, filterValid: true, maximumObservationAgeMsText: '', setMaximumObservationAgeMsText: noop,
        maximumObservationAgeMsValid: true, createDraft: null, invalidateConfiguredSource: noop, revision: 0,
    };
    const eventStep = <InlinePluginEventEditor model={model} onComplete={noop} onCancel={noop} maxHeight={640} />;
    const message = <AppSessionTranscriptSourceProvider sessionId="destination" serverId={home.id}>
        <MessageViewWithSessionCommon sessionId="destination" metadata={null}
            message={{ kind: 'user-text', id: 'injected', localId: null, createdAt: 1, text: 'Review the overnight changes and summarize what needs attention.',
                meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: run.id, invocationRecordId: 'review-attempt', stepOrdinal: '1' } } }}
            forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
            messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
            toolChromeCommon={settingsDefaults} toolRouteCommon={{ messagesById: {}, reducerState: null }} />
    </AppSessionTranscriptSourceProvider>;
    const { renderScreen } = await import('@/dev/testkit');
    const screen = await renderScreen(<main>
        <header><h1>Scheduled work and event authoring</h1><p>DV4-SCHED · source-rendered components · {capture.dark ? 'dark' : 'light'} · {capture.width}px</p></header>
        <div className="comparison">
            <section><h2>Reference · existing R22 Run row</h2>{row}</section>
            <section><h2>Session · habits and destination work</h2>
                <SessionTriggersSectionView groups={groups}
                    status="ready" pendingKeys={new Set()} onToggle={noop} onOpen={noop} onAdd={noop} onRetry={noop} onHistory={noop} />
                <WorkSection testID="capture-writes-here" title="Writes here" count={1} anatomy="page">{workRow}<ScheduledWorkflowSectionView rows={rows} onOpen={noop} sessionId="destination" /></WorkSection>
            </section>
            <section><h2>Work sidebar · upcoming destination</h2><WorkSection testID="capture-scheduled" title="Scheduled" count={1}>
                <ScheduledWorkflowSectionView rows={rows} onOpen={noop} /></WorkSection></section>
            <section><h2>Transcript · injected workflow message</h2>{message}</section>
            <section><h2>Trigger · schedule and footer</h2><TriggerPopover testID="capture-trigger" anchorRef={React.createRef()}
                sessionId={null} initial={{ when: readScheduleWhen({ kind: 'cron', everyMs: null,
                    scheduleExpr: '0 9 * * *', timezone: 'Europe/Zurich' })!, then: createDefaultThen('runWorkflow'), enabled: true }}
                showThen={false} onHistory={noop} onRunNow={async () => {}} onDelete={async () => {}}
                whenKinds={['schedule', 'pluginEvent']} workflowOptions={[]} onRequestClose={noop}
                onSubmit={async () => {}} /></section>
            <section><h2>Event step · packaged plugin identity, search and pinned footer</h2>
                {capture.width === 390 ? <ModalCardFrame presentation="sheet" title="Set up event" onClose={noop}>
                    <FloatingOverlaySheetContext.Provider value>{eventStep}</FloatingOverlaySheetContext.Provider>
                </ModalCardFrame> : <webHosts.View style={{ width: '100%', maxWidth: 420 }}>{eventStep}</webHosts.View>}</section>
            <section><h2>Workflow settings · same next occurrence</h2><WorkflowTriggerSection testIDPrefix="capture-workflow"
                set={set} draft={{ adds: [], updates: {}, removes: [] }} onChangeDraft={noop} status="ready" onRetry={noop}
                runsOn={null} stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} /></section>
            <section><h2>Test run · pending composer (placement requires reload)</h2>
                <WorkflowRunComposer workflowName="Daily digest" inputs={[]} values={{}} pending
                    notice={t('workflows.testRun.savedNotice')}
                    onChangeValues={noop} onRun={noop} onCancel={noop} />
            </section>
            <section><h2>Board · same next occurrence</h2><BoardCardView card={{ key: 'capture-workflow',
                ref: { kind: 'workflow', qualifiedId: { serverId: home.id, id: 'daily' } }, picked: true,
                availability: 'ready', title: 'Daily digest', status: { bucket: 'idle', tone: 'neutral', word: 'Idle' },
                body: { kind: 'workflow', triggerSummary: groups[0]!.title, nextRun: { kind: 'scheduled', at: Date.UTC(2026, 9, 9, 7) },
                    runSummaryAvailable: false, lastRunWord: null, lastRunAt: null, needsYouCount: null } }} /></section>
        </div>
    </main>);
    // The real RN-web PressResponder consumes a DOM gesture, unlike the native test adapter.
    await act(async () => {
        screen.findHostByTestId('automation-event-picker')?.props.onClick(new MouseEvent('click'));
        screen.findHostByTestId('capture-workflow-trigger:saved:morning')?.props.onClick(new MouseEvent('click'));
    });
    const body = renderToStaticMarkup(<>{hostTree(screen.tree.toJSON())}</>);
    expect(body).toContain('From Daily digest');
    expect(body).toContain('Release workspace');
    const captureDir = process.env.HB2B_CAPTURE_DIR;
    if (!captureDir) return;
    // RN-web owns native-style conversion and its emitted CSS; the fixture only lays out the comparison panels.
    const web = await vi.importActual<{ StyleSheet: { getSheet(): { textContent: string } } }>('react-native-web');
    const fonts = ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'IBMPlexMono-Regular'].map(name =>
        `@font-face{font-family:${name};src:url(data:font/ttf;base64,${readFileSync(join(process.cwd(), 'sources/assets/fonts', `${name}.ttf`)).toString('base64')})}`).join('');
    const html = `<!doctype html><html><meta charset="utf-8"><style>${fonts}${web.StyleSheet.getSheet().textContent}
        body{margin:0;background:${theme.colors.surface.base};color:${theme.colors.text.primary};font:14px system-ui}main{padding:24px}h1{font-size:24px;margin:0 0 8px}p{color:${theme.colors.text.secondary}}h2{font-size:13px;font-weight:500;margin:0 0 16px;color:${theme.colors.text.secondary}}.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}section{min-width:0;padding:16px;background:${theme.colors.surface.base}}@media(max-width:600px){main{padding:16px}.comparison{grid-template-columns:1fr;gap:20px}section{padding:0}}</style><body>${body}</body></html>`;
    for (const directory of captureDir.split(',')) {
        const output = resolve(repoRoot, directory);
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, `${capture.dark ? 'dark' : 'light'}-${capture.width}.html`), html);
    }
});
