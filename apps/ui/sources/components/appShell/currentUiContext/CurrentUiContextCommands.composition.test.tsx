import * as React from 'react';
import { Pressable, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import { type DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { createSessionFixture, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider, useMainAppTabState } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { MainView } from '@/components/navigation/shell/MainView';
import { useCollectionFilterSettingsCommand } from '@/components/settings/session/useCollectionFilterSettingsCommand';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerSnapshot, publishApplyingActiveServerId } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import { sessionInfoDisclosuresState } from '@/sync/domains/state/disclosureUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader, usePublishCurrentUiContext, type CurrentUiContextReader } from './CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort, CurrentUiContextActionHost } from './currentUiContextVoiceToolPort';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from './currentUiContextActionRuntime';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands, useCurrentUiContextLocalCommands, useCurrentUiContextCommandBridge, useCurrentUiContextFocusedCommands, useCurrentUiContextLocalCommandDefinitions } from './CurrentUiContextCommands';
import { ModalProvider, Modal } from '@/modal';
import { t } from '@/text';
import { useCollectionRequestPeek } from '@/components/ui/lists/collection/useCollectionRequestPeek';
import { CollectionSessionRequestPeekData } from '@/components/ui/lists/collection/CollectionSessionRequestPeekData';
import type { CollectionSessionRequestRef } from '@/components/ui/lists/collection/collectionRequestRef';
import { CollectionRequestPeek } from '@/components/ui/lists/collection/CollectionRequestPeek';
import { motionTokens } from '@/components/ui/motion';
import { DiscussionRow } from '@/components/discussions/DiscussionRow';
import { WorkflowRunItemBody } from '@/components/sessions/shell/row/WorkflowRunItemBody';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { WorkflowRunPane } from '@/components/workflows/run/WorkflowRunPane';
import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import { SessionPaneHeader } from '@/components/sessions/shell/view/SessionPaneHeader';
import { useOpenStoreBots } from '@/components/store/catalog/useOpenStoreBots';
import { MultiPaneHost } from '@/components/ui/panels/MultiPaneHost';
import { router } from 'expo-router';
import { ChartTooltip } from '@/components/ui/charts/ChartTooltip';

// The portal is a platform boundary; command admission, request demand and retirement stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 600, maxWidth: 400, placement: 'bottom' }));

vi.mock('@/components/ui/popover/Popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 600, maxWidth: 400, placement: 'bottom' }));

// Radix owns browser focus/event listeners; the renderer has no DOM. Modal admission stays real.
vi.mock('@/utils/web/radixCjs', async importOriginal => {
    const actual = await importOriginal<typeof import('@/utils/web/radixCjs')>();
    const Inline = (props: Readonly<{ children?: React.ReactNode }>) => props.children;
    return { ...actual, requireRadixDismissableLayer: () => ({ Root: Inline, Branch: Inline }),
        requireRadixFocusScope: () => ({ Root: Inline }) };
});

const routeState = vi.hoisted(() => ({ pathname: '/settings/usage', segments: ['(app)', 'settings', 'usage'], params: {} as Record<string, string> }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => routeState.pathname, segments: () => routeState.segments, params: () => routeState.params }).module;
});

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let reader: CurrentUiContextReader | null = null;
let unregister: (() => void) | undefined;
const intents = new Map<string, (key: string) => Promise<boolean>>();
const changes: string[] = [];

function Publication(props: Readonly<{ author?: boolean }> = {}) {
    reader = useOptionalCurrentUiContextReader();
    const commands = useCurrentUiContextComposedCommands();
    const authorCommands = React.useMemo(() => [{ title: 'Author details', command: { kind: 'hostLocal' as const,
        invoke: () => { changes.push('author'); return { ok: true as const }; } } }], []);
    const enrichment = React.useMemo(() => ({ commands: props.author ? authorCommands : commands }), [authorCommands, commands, props.author]);
    usePublishCurrentUiContext(enrichment);
    React.useEffect(() => {
        if (!reader) return;
        const current = reader;
        unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            reader: current, invocationSurface: surface, readProjection: () => null, readNavigationBinding: () => null,
        }));
        return unregister;
    }, [reader]);
    return null;
}

function Descendant(props: Readonly<{ id: string; value: string }>) {
    // Inline callbacks model body renders: publication must not cause a registration loop.
    const commands = useCurrentUiContextLocalCommands([{ key: 'details', title: `${props.id} details`,
        invoke: () => { changes.push(props.value); } }]);
    intents.set(props.id, commands.invoke);
    return null;
}

function ObserveReader() {
    reader = useOptionalCurrentUiContextReader();
    return null;
}

function ComposedPage(props: Readonly<{ authority: ServerAccountScopeLifetime | null; second?: boolean; value?: string }>) {
    return <CurrentUiContextCommandsProvider authority={props.authority}>
        <Publication /><Descendant id="first" value={props.value ?? 'first'} />
        {props.second ? <Descendant id="second" value="second" /> : null}
    </CurrentUiContextCommandsProvider>;
}

afterEach(async () => {
    standardCleanup(); unregister?.(); unregister = undefined; reader = null;
    vi.unstubAllGlobals();
    retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined;
    intents.clear(); changes.length = 0;
    routeState.pathname = '/settings/usage'; routeState.segments = ['(app)', 'settings', 'usage']; routeState.params = {};
});

describe('mounted current-context descendant commands', () => {
    it('releases retired chart definitions across repeated renders and mounts while a native callback survives', async () => {
        const { Session } = await import('node:inspector');
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://chart-command-retention.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const seen = new WeakSet<object>();
        const definitions: WeakRef<object>[] = [];
        let publishedCount = 0;
        let nativeCallback: ReturnType<typeof useCurrentUiContextLocalCommands> | undefined;
        const nativeChartCallbacks: (() => void)[] = [];
        function Observe() {
            const commands = useCurrentUiContextComposedCommands();
            publishedCount = commands.length;
            for (const definition of commands) {
                if (!seen.has(definition)) {
                    seen.add(definition);
                    definitions.push(new WeakRef(definition));
                }
            }
            // An external host may retain one callback beyond its source's unmount.
            // Its empty source must not keep sibling chart definitions alive.
            nativeCallback = useCurrentUiContextLocalCommands([]);
            return null;
        }
        const tree = (generation: number, value: string, visible: boolean) => <InjectedAuthProvider credentials={credentials}>
            <CurrentUiContextCommandsProvider authority={authority}>
                <Observe />{visible ? Array.from({ length: 12 }, (_, index) =>
                    <ChartTooltip key={`${generation}:${index}`} title={`Datum ${index}`} value={value} accentColor="#123456"
                        renderTrigger={interaction => {
                            nativeChartCallbacks.push(interaction.onPress);
                            return <View />;
                        }}>
                        <View />
                    </ChartTooltip>) : null}
            </CurrentUiContextCommandsProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(0, '1', true));
        for (let generation = 0; generation < 4; generation++) {
            await screen.update(tree(generation, '1', true));
            expect(publishedCount).toBe(24);
            await screen.update(tree(generation, '2', true));
            expect(publishedCount).toBe(24);
            await screen.update(tree(generation, '2', false));
            expect(publishedCount).toBe(0);
        }
        await screen.update(tree(4, '3', true));
        expect(publishedCount).toBe(24);
        await screen.unmount();
        const inspector = new Session();
        inspector.connect();
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
            expect(definitions.length).toBeGreaterThanOrEqual(4 * 24);
            expect(definitions.filter(definition => definition.deref() !== undefined).length,
                'an unmounted source and retained callback release every retired chart definition').toBe(0);
            expect(await nativeCallback!.invoke('reveal')).toBe(false);
            expect(nativeChartCallbacks.length).toBeGreaterThanOrEqual(4 * 12);
        } finally { inspector.disconnect(); }
    });
    it('continues the sentence builder in the full editor through its mounted Agent command', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://workflow-builder-command.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected builder Account');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const { WorkflowSentenceBuilder } = await import('@/components/workflows/sentence/WorkflowSentenceBuilder');
        let closed = false;
        await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CurrentUiContextCommandsProvider authority={authority}>
                        <Publication /><WorkflowSentenceBuilder accountLifetime={authority} anchorRef={{ current: null }}
                            intent={{ name: 'Keep this sentence' }} onRequestClose={() => { closed = true; }} />
                    </CurrentUiContextCommandsProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const command = reader!.readCurrentUiContext()!.commands.find(candidate => candidate.title === t('workflows.sentence.builder.openInEditor'));
        expect(command).toBeDefined();
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke',
            { commandId: command!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(closed).toBe(true);
        expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ definitionDraftSeedId: expect.any(String) }) }));
    });

    it('keeps the presented page mount address after Apply closes over its phone details pane', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://page-dialog-binding.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let selected = false;
        function Page() {
            const enrichment = React.useMemo(() => ({
                detail: { mountedAction: { action: { pluginId: 'happier.triage', localId: 'ui/mounted-v1' }, mountId: 'page-mount' } },
                commands: [{ title: 'Select saved view', command: { kind: 'hostLocal' as const,
                    invoke: () => { selected = true; return { ok: true as const }; } } }],
            }), []);
            usePublishCurrentUiContext(enrichment);
            return null;
        }
        const tree = (phone: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><ModalProvider><CurrentUiContextProvider>
                <CurrentUiContextActionHost /><ObserveReader />
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <MultiPaneHost main={<Page />} rightPane={null} detailsPane={<View />}
                        layout={{ main: 'docked', kind: 'twoPane', right: 'hidden', details: phone ? 'overlay' : 'docked' }}
                        rightDockWidthPx={360} detailsDockWidthPx={520}
                        onCloseRight={() => {}} onCloseDetails={() => {}}
                        onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}} />
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></ModalProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(false));
        const address = reader!.readCurrentUiContext()!.detail;
        expect(address).toMatchObject({ mountedAction: { mountId: 'page-mount' } });
        await screen.update(tree(true));
        let decision: Promise<boolean> | undefined;
        await act(async () => { decision = Modal.confirm('Apply saved view', undefined, { confirmText: 'Apply change' }); });
        expect(reader!.readCurrentUiContext()!.navigation.area).toBe('modal');
        expect(reader!.readCurrentUiContext()!.detail).toBeUndefined();
        await screen.pressByTestIdAsync('web-modal-confirm');
        expect(await decision).toBe(true);
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const current = await executor.execute('ui.current_context.read', {}, { surface: 'agent', serverId: server.id });
        expect(current).toMatchObject({ ok: true, result: { detail: address } });
        const command = reader!.readCurrentUiContext()!.commands.find(entry => entry.title === 'Select saved view')!;
        await act(async () => {
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' }))
                .toMatchObject({ ok: true });
        });
        expect(selected).toBe(true);
        await screen.update(tree(false));
        expect(reader!.readCurrentUiContext()!.detail).toEqual(address);
    });
    it('reveals the Session filter search anchor after the root route retained the Projects tab', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://filter-search.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] })
                : request.path === '/v1/kv' && request.method === 'POST' ? Response.json({ success: true, results: [{ key: 'ui:active-tab', version: 1 }] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        routeState.pathname = '/'; routeState.segments = ['(app)'];
        let tabs: ReturnType<typeof useMainAppTabState> | undefined;
        function ObserveTabs() { tabs = useMainAppTabState(); return null; }
        const tree = () => <InjectedAuthProvider credentials={credentials}><MainAppTabStateProvider>
            <AppPaneProvider><ObserveTabs /><MainView key={routeState.params.setting ?? 'home'} variant="phone" /></AppPaneProvider>
        </MainAppTabStateProvider></InjectedAuthProvider>;
        const screen = await renderScreen(tree());
        await act(async () => { await tabs!.setActiveTab('projects'); });
        expect(tabs!.activeTab).toBe('projects');
        routeState.params = { setting: 'session.list.filters' };
        await screen.update(tree());
        expect(tabs!.activeTab).toBe('sessions');
        await act(async () => { await tabs!.setActiveTab('projects'); });
        expect(tabs!.activeTab).toBe('projects');
    });
    it.each(['sessionWork', 'workflow', 'discussion'] as const)('opens only the current %s filter through its Settings declaration and retires prior contexts', async entityKind => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://filter-settings.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const anchor = `${entityKind === 'sessionWork' ? 'session' : entityKind}.list.filters`;
        // The mounted app has applied its Account baseline before Settings admission.
        getStorage().getState().applySettingsForScope(authority!.scope, getStorage().getState().settings, 1);
        function Filters(props: Readonly<{ contextKey: string; accountScope: ServerAccountScope }>) {
            useCollectionFilterSettingsCommand({ entityKind, enabled: true, contextKey: props.contextKey,
                accountScope: props.accountScope,
                openFilter: () => { changes.push(props.contextKey); } });
            return null;
        }
        const tree = (contextKey: string | null, accountScope = authority!.scope) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CurrentUiContextCommandsProvider authority={authority}>
                        <Publication />{contextKey ? <Filters contextKey={contextKey} accountScope={accountScope} /> : null}
                    </CurrentUiContextCommandsProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree('team-a:active'));
        const oldCommand = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('sessionsList.filtersTitle'))!;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const invoke = () => executor.execute('settings.invoke', { anchor }, { surface: 'agent', authority: 'account_automation', serverId: server.id });
        await act(async () => { const result = await invoke(); expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { anchor, status: 'interaction_opened' } }); });
        expect(changes).toEqual(['team-a:active']);
        await screen.update(tree('team-b:archived'));
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: oldCommand.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await act(async () => { expect(await invoke()).toMatchObject({ ok: true, result: { status: 'interaction_opened' } }); });
        expect(changes).toEqual(['team-a:active', 'team-b:archived']);
        await screen.update(tree('other-account:active', { serverId: server.id, accountId: 'other-account' }));
        expect(await invoke()).toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'current_ui_command_unavailable' } });
        expect(changes).toHaveLength(2);
        const otherAnchor = entityKind === 'workflow' ? 'discussion.list.filters' : 'workflow.list.filters';
        expect(await executor.execute('settings.invoke', { anchor: otherAnchor }, { surface: 'agent', serverId: server.id }))
            .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'current_ui_command_unavailable' } });
        await screen.update(tree(null));
        expect(await invoke()).toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'current_ui_command_unavailable' } });
        expect(changes).toHaveLength(2);
    });
    it('invokes the phone Store Bots control through the foreground modal command and withdraws it on dismissal', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://store-bots-phone.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        function PhoneControl(props: Readonly<{ onClose: () => void }>) {
            const open = useOpenStoreBots(props.onClose);
            return <Pressable testID="phone-from-template" onPress={() => void open()} />;
        }
        let show: (() => void) | undefined;
        function Opener() {
            const Bridge = useCurrentUiContextCommandBridge();
            show = () => Modal.show({ component: props => <Bridge><PhoneControl {...props} /></Bridge> });
            return null;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><ModalProvider><CurrentUiContextProvider>
                <CurrentUiContextActionHost /><ObserveReader /><Opener /><Descendant id="background" value="background" />
            </CurrentUiContextProvider></ModalProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await act(async () => { show!(); });
        const command = reader!.readCurrentUiContext()!.commands.find(candidate => candidate.title === t('botTemplates.fromTemplate'))!;
        expect(reader!.readCurrentUiContext()!.navigation.area).toBe('modal');
        expect(command).toBeDefined();
        expect(reader!.readCurrentUiContext()!.commands.map(candidate => candidate.title)).not.toContain('background details');
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        let foregroundId = '';
        await act(async () => { foregroundId = Modal.show({ component: () => null }); });
        expect(reader!.readCurrentUiContext()!.commands).toEqual([]);
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await act(async () => { Modal.hide(foregroundId); });
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(router.navigate).toHaveBeenLastCalledWith('/plugins/bots');
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await act(async () => { show!(); });
        await screen.pressByTestIdAsync('phone-from-template');
        expect(router.navigate).toHaveBeenLastCalledWith('/plugins/bots');
        await act(async () => { Modal.hideAll(); });
        expect(reader!.readCurrentUiContext()!.commands.map(candidate => candidate.title)).toContain('background details');
    });
    it('reads and patches the same mounted draft through UI and Agent commands, then retires its handles', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://draft-command.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        let value = 'Original';
        let local: ReturnType<typeof useCurrentUiContextLocalCommands> | undefined;
        function Draft() {
            local = useCurrentUiContextLocalCommands([
                { key: 'read', title: 'Read draft', invoke: () => ({ ok: true, result: { name: value } }) },
                { key: 'patch', title: 'Patch draft', invoke: input => {
                    if (!isJsonObject(input) || typeof input.name !== 'string') return false;
                    value = input.name;
                    return { ok: true, result: { name: value } };
                } },
            ]);
            return null;
        }
        const tree = (presented: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CurrentUiContextCommandsProvider authority={authority}>
                        <Publication />{presented ? <Draft /> : null}
                    </CurrentUiContextCommandsProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        const inventory = reader!.readCurrentUiContext()!.commands;
        const read = inventory.find(command => command.title === 'Read draft')!;
        const patch = inventory.find(command => command.title === 'Patch draft')!;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const invoke = (commandId: string, input?: { name: string }) => executor.execute('ui.current_context.command.invoke',
            { commandId, ...(input ? { input } : {}) }, { surface: 'agent' });
        expect(await invoke(read.id)).toMatchObject({ ok: true, result: { name: 'Original' } });
        await act(async () => { expect(await invoke(patch.id, { name: 'Agent edit' })).toMatchObject({ ok: true, result: { name: 'Agent edit' } }); });
        expect(await invoke(read.id)).toMatchObject({ ok: true, result: { name: 'Agent edit' } });
        await act(async () => { expect(await local!.invoke('patch', { name: 'UI edit' })).toBe(true); });
        expect(await invoke(read.id)).toMatchObject({ ok: true, result: { name: 'UI edit' } });
        expect(reader!.readCurrentUiContext()!.commands).toEqual(inventory);
        await screen.update(tree(false));
        expect(await invoke(patch.id, { name: 'Retired edit' })).toMatchObject({ ok: false });
        expect(value).toBe('UI edit');
    });
    it('opens Store Bots through the same mounted command for UI and Agent and retires it on close', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://store-bots-command.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const closed = vi.fn();
        let open: (() => Promise<boolean>) | undefined;
        function StoreControl() { open = useOpenStoreBots(closed); return null; }
        const tree = (presented: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CurrentUiContextCommandsProvider authority={authority}>
                        <Publication />{presented ? <StoreControl /> : null}
                    </CurrentUiContextCommandsProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        const command = reader!.readCurrentUiContext()!.commands.find(candidate => candidate.title === t('botTemplates.fromTemplate'))!;
        expect(command).toBeDefined();
        await act(async () => { expect(await open!()).toBe(true); });
        expect(router.navigate).toHaveBeenLastCalledWith('/plugins/bots');
        expect(closed).toHaveBeenCalledTimes(1);
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(closed).toHaveBeenCalledTimes(2);
        await screen.update(tree(false));
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        expect(closed).toHaveBeenCalledTimes(2);
    });
    it.each(['startup', 'restore'] as const)('opens a request through the real AppShell host after same-Account %s', async (phase) => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://peek-runtime-restore.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        const snapshot = { serverId: server.id, serverUrl: server.serverUrl, generation: 0 };
        publishAppliedActiveServerSnapshot(snapshot);
        getStorage().getState().activateProfileScope({ serverId: server.id, accountId: 'account-a' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        if (phase === 'startup') publishApplyingActiveServerId(server.id, 1);
        // Unlike Publication, the production host neither injects nor republishes commands.
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <CurrentUiContextActionHost /><ObserveReader />
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CollectionRequestPeek request={{ kind: 'permission', serverId: server.id,
                        sessionId: 'session', requestId: 'request', turnId: 'turn' }} testID="runtime-request-slot"><View /></CollectionRequestPeek>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const oldCommand = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('approvals.review'));
        if (phase === 'restore') {
            expect(oldCommand).toBeDefined();
            await act(async () => { publishApplyingActiveServerId(server.id, 1); });
        }
        await screen.pressByTestIdAsync('runtime-request-slot');
        expect(screen.findByTestId('runtime-request-slot:peek')).toBeNull();
        await act(async () => { publishAppliedActiveServerSnapshot({ ...snapshot, generation: 1 }); });
        if (oldCommand) expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId: oldCommand.id }, context: { surface: 'agent' } })).toMatchObject({ ok: false });
        await screen.pressByTestIdAsync('runtime-request-slot');
        expect(screen.findByTestId('runtime-request-slot:peek')).not.toBeNull();
    });
    it.each(['workflow', 'discussion'] as const)('opens the mounted %s request by keyboard Action and long-press, retires replacement and refuses inactive authority', async (kind) => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://row-request.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        getStorage().getState().activateProfileScope({ serverId: server.id, accountId: 'account-a' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const discussion: DiscussionOpenedSummaryV1 = {
            id: 'review-discussion', ownerAccountId: 'account-a', encryptionMode: 'plain', anchor: null, access: 'owner',
            keyReadiness: true, dataEncryptionKey: null, creationLocalId: null, title: 'Review the release',
            latestMessage: { id: 'message', localId: null, seq: 1, authorAccountId: 'account-a', accountActor: null, producerV1: null, createdAt: 1 },
            messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
            capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
        };
        const run = createWorkflowRunSummaryFixture({ id: 'review-run', ownerAccountId: 'account-a', state: 'waiting_for_review',
            invocationAttentionRequired: true, heldStep: { invocationId: 'first-request', label: 'Review changes' } });
        getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(run, { kind: 'available', value: { title: 'Review the release' } })]);
        const tree = (requestId: string, active = true) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active={active} currentUiContextActive={active}>
                    <Publication />{kind === 'workflow'
                        ? <WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId={server.id} />
                        : <DiscussionRow discussion={discussion} viewerAccountId="account-a" geometry="column" onOpenDiscussion={() => { throw new Error('Request must not navigate'); }}
                            serverId={server.id} approvalArtifactId={requestId}
                            attentionReason="approval_pending" attentionType="approval" />}
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const slot = kind === 'workflow' ? 'workflow-run-request-peek:review-run' : 'discussion-request-peek:review-discussion';
        const screen = await renderScreen(tree('first-request'));
        expect(screen.findByTestId(`${slot}:peek`)).toBeNull();
        const review = () => reader!.readCurrentUiContext()!.commands.find(command => command.title === t('approvals.review'))!;
        const first = review();
        expect(first).toBeDefined();
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: first.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(screen.findByTestId(`${slot}:peek`)).not.toBeNull();
        if (kind === 'workflow') expect(screen.findByType(WorkflowRunPane).props).toMatchObject({
            runId: run.id, serverId: server.id, invocationId: 'first-request', acknowledgeFailure: false,
        });
        else expect(screen.findByType(ApprovalDetailScreen).props).toMatchObject({ artifactId: 'first-request', serverId: server.id });
        if (kind === 'workflow') await act(async () => getStorage().getState().upsertWorkflowRuns([
            workflowRunRowFromSummary({ ...run, revision: run.revision + 1, heldStep: { invocationId: 'second-request', label: 'Review again' } }),
        ]));
        await screen.update(tree('second-request'));
        expect(screen.findByTestId(`${slot}:peek`)).toBeNull();
        expect(screen.findAllByType(kind === 'workflow' ? WorkflowRunPane : ApprovalDetailScreen)).toHaveLength(0);
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: first.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId(slot)!, 'onLongPress'); });
        expect(screen.findByTestId(`${slot}:peek`)).not.toBeNull();
        if (kind === 'workflow') expect(screen.findByType(WorkflowRunPane).props.invocationId).toBe('second-request');
        else expect(screen.findByType(ApprovalDetailScreen).props.artifactId).toBe('second-request');
        const { Popover } = await import('@/components/ui/popover');
        expect(screen.findByType(Popover).props.phonePresentation).toBe('sheet');
        const second = review();
        await screen.update(tree('second-request', false));
        // The closed/reopened slot must still go through mounted Action admission.
        await screen.pressByTestIdAsync(slot);
        await screen.pressByTestIdAsync(slot);
        expect(screen.findByTestId(`${slot}:peek`)).toBeNull();
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: second.id }, { surface: 'agent' })).toMatchObject({ ok: false });
    });
    it.each(['press', 'hover'] as const)('retires a %s request peek on replacement, hiding and scope loss, then permits a fresh open', async (entry) => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://peek-lifetime.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const tree = (turnId: string, presented = true) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <Publication /><CollectionRequestPeek request={{ kind: 'permission', serverId: server.id,
                        sessionId: 'session', requestId: 'request', turnId }} presented={presented} testID="request-slot">
                        <View />
                    </CollectionRequestPeek>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree('first'));
        const open = async () => {
            if (entry === 'press') await screen.pressByTestIdAsync('request-slot');
            else {
                vi.useFakeTimers();
                try {
                    let anchor = screen.findHostByTestId('request-slot')!.parent;
                    while (anchor && typeof anchor.props.onPointerEnter !== 'function') anchor = anchor.parent;
                    if (!anchor) throw new Error('Request slot has no pointer anchor');
                    await act(async () => { anchor.props.onPointerEnter(); });
                    await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.overlay.popover.hoverOpenDelayMs); });
                } finally { vi.useRealTimers(); }
            }
            expect(screen.findByTestId('request-slot:peek')).not.toBeNull();
        };
        await open();
        if (entry === 'hover') {
            await screen.pressByTestIdAsync('request-slot');
            expect(screen.findByTestId('request-slot:peek')).not.toBeNull();
        }
        await screen.update(tree('second'));
        expect(screen.findByTestId('request-slot:peek')).toBeNull();
        await open();
        await screen.update(tree('second', false));
        expect(screen.findByTestId('request-slot:peek')).toBeNull();
        await screen.update(tree('second'));
        expect(screen.findByTestId('request-slot:peek')).toBeNull();
        await open();
        await act(async () => { await TokenStorage.setCredentialsForServerUrl(server.serverUrl,
            { serverId: server.id }, { ...credentials, secret: 'renewed-peek-test-secret' }); });
        expect(screen.findByTestId('request-slot:peek')).toBeNull();
    });
    it('publishes only admitted About and Developer disclosures and navigation through the same mounted commands', async () => {
        // Exercise the released-build dev-mode admission, not the test runner's development build.
        vi.stubGlobal('__DEV__', false);
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://info-details-commands.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const { SessionInfoAboutSection } = await import('@/components/sessions/info/SessionInfoAboutSection');
        const { SessionInfoDeveloperSection } = await import('@/components/sessions/info/SessionInfoDeveloperSection');
        const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
        const { buildScopedSessionRouteHref } = await import('@/hooks/session/sessionRouteServerScope');
        const { router } = await import('expo-router');
        const session = createSessionFixture({ id: 'info-details', serverId: server.id });
        getStorage().getState().applyLocalSettings({ devModeEnabled: false });
        const tree = (dev: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <Publication />
                    <SessionInfoAboutSection session={session} metadata={session.metadata} serverId={server.id}
                        agentId={null} agentTitle={null} providerDisplayName="Agent" isConnected={false} isCliOutdated={false}
                        vendorResumeId={null} vendorResumeLabel={null} executionMachineId={null} executionMachineLabel={null}
                        machineList={undefined} showUsage />
                    {dev ? <SessionInfoDeveloperSection session={session} metadata={session.metadata} serverId={server.id}
                        providerDisplayName="Agent" status={getSessionStatus(session)} /> : null}
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        const commands = () => reader!.readCurrentUiContext()!.commands;
        const aboutTitle = `${t('common.expand')} · ${t('sessionPages.info.aboutTitle')}`;
        const about = commands().find(command => command.title === aboutTitle);
        expect(about).toBeDefined();
        expect(commands().some(command => command.title === t('sessionPages.info.sessionLog'))).toBe(false);
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: about!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        const usage = commands().find(command => command.title === t('sessionPages.info.usage'))!;
        expect(usage).toBeDefined();
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: usage.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(router.push).toHaveBeenCalledWith(buildScopedSessionRouteHref({ sessionId: session.id, serverId: server.id, suffix: '/usage' }));
        await act(async () => { getStorage().getState().applyLocalSettings({ devModeEnabled: true }); });
        const fullSessionTitle = `${t('common.expand')} · ${t('sessionInfo.fullSessionObject')}`;
        const fullSession = commands().find(command => command.title === fullSessionTitle);
        expect(fullSession).toBeDefined();
        expect(commands().some(command => command.title === `${t('common.expand')} · ${t('sessionInfo.agentState')}`)).toBe(false);
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: fullSession!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(commands().some(command => command.title === `${t('common.collapse')} · ${t('sessionInfo.fullSessionObject')}`)).toBe(true);
        const log = commands().find(command => command.title === t('sessionPages.info.sessionLog'))!;
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: log.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(router.push).toHaveBeenCalledWith(buildScopedSessionRouteHref({ sessionId: session.id, serverId: server.id, suffix: '/log' }));
        await act(async () => { getStorage().getState().applyLocalSettings({ devModeEnabled: false }); });
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: log.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await screen.unmount();
    });

    it('reveals and collapses Info Setup through the mounted UI Action and retires disclosure commands on close', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://info-disclosure-commands.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const { useSessionSetupDisclosure } = await import('@/components/sessions/work/useSessionSetupDisclosure');
        replacePersistentUiStateForTest(sessionInfoDisclosuresState, {});
        const { WorkSection, WorkSectionPlacementProvider, WorkSectionSetupDisclosureProvider } = await import('@/components/sessions/work/WorkSection');
        let disclosure: ReturnType<typeof useSessionSetupDisclosure> | null = null;
        // The real Setup row publishes its own disclosure with the state it shows.
        function SetupControl() {
            disclosure = useSessionSetupDisclosure();
            return <WorkSectionPlacementProvider value="setup">
                <WorkSectionSetupDisclosureProvider value={disclosure}>
                    <WorkSection testID="session-work-memory" anatomy="page" title={t('memoryContext.memory.title')} count="" />
                </WorkSectionSetupDisclosureProvider>
            </WorkSectionPlacementProvider>;
        }
        const tree = (shown: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <Publication />{shown ? <SetupControl /> : null}
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        expect(sessionInfoDisclosuresState.readAll()).toEqual({});
        const find = (verb: 'expand' | 'collapse', title: string) => reader!.readCurrentUiContext()!.commands.find(
            command => command.title === `${t(`common.${verb}`)} · ${title}`);
        const expand = find('expand', t('memoryContext.memory.title'));
        expect(expand).toBeDefined();
        await act(async () => {
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: expand!.id }, { surface: 'agent' })).toMatchObject({ ok: true });
        });
        expect(disclosure!.isExpanded('memory')).toBe(true);
        expect(sessionInfoDisclosuresState.readAll()).toEqual({ memory: true });
        const collapse = find('collapse', t('memoryContext.memory.title'))!;
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: collapse.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(disclosure!.isExpanded('memory')).toBe(false);
        const retired = find('expand', t('memoryContext.memory.title'))!;
        await screen.update(tree(false));
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: retired.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        expect(sessionInfoDisclosuresState.readAll()).toEqual({ memory: false });
    });

    it('retries an opened request through its mounted hydration command and retires it on close', async () => {
        let servedSession: ReturnType<typeof createSessionFixture> | null = null;
        const boundary = createSessionMetadataHttpBoundary(() => servedSession ? { [servedSession.id]: servedSession } : {});
        const sessionReads = createSessionReadBatchHttpBoundary(request => boundary.handle(request.url)
            ?? (request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined));
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://collection-request-retry.test', accountId: 'account-a', currentAccount: true }],
            route: sessionReads.handle });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const session = createSessionFixture({ id: 'request-retry-session', serverId: server.id, encryptionMode: 'plain',
            active: true, agentState: { controlledByUser: null, requests: { permission: {
                tool: 'Bash', kind: 'permission', arguments: { command: 'git status' }, createdAt: 1,
            } }, completedRequests: {} } });
        getStorage().getState().applySessions([session]);
        const tree = (open: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <Publication /><CollectionSessionRequestPeekData open={open}
                        request={{ kind: 'permission', serverId: server.id, sessionId: session.id, requestId: 'permission' }}>
                        {() => null}
                    </CollectionSessionRequestPeekData>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        await vi.waitFor(() => expect(reader!.readCurrentUiContext()!.commands.some(command => command.title === t('common.retry'))).toBe(true));
        // Introduce the server update after startup, so this measures the mounted
        // Retry command rather than startup's legacy-display maintenance read.
        servedSession = createSessionFixture({ ...session, metadata: { ...session.metadata!, name: 'Current request context' },
            metadataVersion: session.metadataVersion + 1 });
        const command = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('common.retry'))!;
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        await vi.waitFor(() => expect(getStorage().getState().sessions[session.id]?.metadata?.name).toBe('Current request context'));
        expect(sessionReads.componentRequests.filter(request => request.path === `/v2/sessions/${session.id}`)).toHaveLength(1);
        await screen.update(tree(false));
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await screen.update(tree(true));
        await vi.waitFor(() => expect(reader!.readCurrentUiContext()!.commands.some(command => command.title === t('common.retry'))).toBe(true));
        expect(sessionReads.componentRequests.filter(request => request.path === `/v2/sessions/${session.id}`)).toHaveLength(1);
    });

    it('reviews a replaced request through the mounted command and retires that command after review', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://collection-request-replacement.test', accountId: 'account-a', currentAccount: true }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const session = createSessionFixture({ id: 'request-replacement-session', serverId: server.id, encryptionMode: 'plain',
            active: true, agentState: { controlledByUser: null, requests: { permission: {
                tool: 'Bash', kind: 'permission', arguments: { command: 'git status' }, createdAt: 1, turnId: 'current',
            } }, completedRequests: {} } });
        getStorage().getState().applySessions([session]);
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <Publication /><CollectionRequestPeek request={{ kind: 'permission', serverId: server.id,
                        sessionId: session.id, requestId: 'permission', turnId: 'previous' }} testID="replacement-slot"><View /></CollectionRequestPeek>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        await screen.pressByTestIdAsync('replacement-slot');
        expect(screen.findByTestId('collection-request-peek.replaced')).not.toBeNull();
        const review = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('sessionsList.requestPeekReviewNew'));
        expect(review, 'the visible Review new control is executable by an agent').toBeDefined();
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: review!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(screen.findByTestId('replacement-slot:peek')).toBeNull();
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: review!.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await screen.pressByTestIdAsync('replacement-slot');
        expect(screen.findByType(CollectionSessionRequestPeekData).props.request.turnId).toBe('current');
        expect(screen.findByTestId('collection-request-peek.replaced')).toBeNull();
    });

    it('opens a request through the mounted command and retires its old address when a row is recycled', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://collection-request-command.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        let open = false;
        const request: CollectionSessionRequestRef = { kind: 'permission', serverId: server.id, sessionId: 'session', requestId: 'request', turnId: 'first' };
        function RequestControl(props: Readonly<{ request: CollectionSessionRequestRef; presented: boolean }>) {
            open = useCollectionRequestPeek(props.request, props.presented).open;
            return null;
        }
        const tree = (turnId: string, presented = true) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <Publication /><RequestControl request={{ ...request, turnId }} presented={presented} />
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree('first'));
        const first = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('approvals.review'))!;
        expect(first).toBeDefined();
        expect(open).toBe(false);
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: first.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(open).toBe(true);
        await screen.update(tree('replacement'));
        expect(open).toBe(false);
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: first.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        const replacement = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('approvals.review'))!;
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: replacement.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(open).toBe(true);
        const close = reader!.readCurrentUiContext()!.commands.find(command => command.title === t('common.close'))!;
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke', { commandId: close.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(open).toBe(false);
        await screen.update(tree('replacement', false));
        expect(reader!.readCurrentUiContext()!.commands).toEqual([]);
    });

    it('mounts a thousand closed request addresses without requesting or projecting any private details', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://collection-request-closed.test', accountId: 'account-a' }], route: () => undefined });
        const server = home.homes.a!;
        const before = home.httpRequests.length;
        let detailProjections = 0;
        await renderScreen(<>{Array.from({ length: 1000 }, (_, index) => <CollectionSessionRequestPeekData key={index} open={false}
            request={{ kind: 'permission', serverId: server.id, sessionId: `session-${index}`, requestId: `request-${index}` }}>
            {() => { detailProjections++; return null; }}
        </CollectionSessionRequestPeekData>)}</>);
        expect(detailProjections).toBe(0);
        // Account bootstrap continues independently; only these Session detail/message demands
        // can read the private addresses mounted above, through either supported HTTP transport.
        expect(home.httpRequests.slice(before).filter(request => request.path === '/v2/sessions/read-batch'
            || /^\/v[12]\/sessions\/session-\d+(?:\/|$)/.test(request.path))).toEqual([]);
    });

    it('copies no existing command registry rows when descendants register, replace or unregister', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://command-registry-copy.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const prefix = 'registry-copy-fixture-';
        const count = 64;
        const tree = (size: number, latest = false, replaceFirst = false) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CurrentUiContextCommandsProvider authority={authority}><Publication />
                        {Array.from({ length: size }, (_, index) => <Descendant key={index}
                            id={`${prefix}${replaceFirst && index === 0 ? 'replacement' : index}`}
                            value={latest ? 'latest' : 'original'} />)}
                    </CurrentUiContextCommandsProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const isFixtureRegistry = (value: unknown): value is unknown[] => Array.isArray(value) && value.length > 0
            && value.every((row: unknown) => typeof row === 'object' && row !== null && 'owner' in row
                && typeof row.owner === 'object' && row.owner !== null && 'commands' in row
                && Array.isArray(row.commands) && row.commands.length > 0
                && row.commands.every((command: unknown) => typeof command === 'object' && command !== null
                    && 'title' in command && typeof command.title === 'string' && command.title.startsWith(prefix)));
        // Observe native copying, retaining the real command producer and Array implementation.
        const filter = vi.spyOn(Array.prototype, 'filter');
        const readCopies = () => {
            let examined = 0;
            let copied = 0;
            for (const [index, receiver] of filter.mock.contexts.entries()) {
                if (!isFixtureRegistry(receiver)) continue;
                examined += receiver.length;
                const result = filter.mock.results[index];
                if (result?.type === 'return' && Array.isArray(result.value)) copied += result.value.length;
            }
            filter.mockClear();
            return { examined, copied };
        };
        try {
            const screen = await renderScreen(tree(count));
            const mounted = readCopies();
            const initial = reader!.readCurrentUiContext()!.commands;
            expect(initial.map(command => command.title)).toEqual(Array.from({ length: count }, (_, index) => `${prefix}${index} details`));
            const firstRetirement = reader!.resolveCurrentUiCommand(initial[0]!.id)!.retirementSignal;
            await screen.update(tree(count, true));
            const unchanged = readCopies();
            expect(reader!.readCurrentUiContext()!.commands.map(command => command.id)).toEqual(initial.map(command => command.id));
            await act(async () => { expect(await intents.get(`${prefix}0`)!('details')).toBe(true); });
            expect(changes).toEqual(['latest']);
            await screen.update(tree(count, true, true));
            const replaced = readCopies();
            const replacement = reader!.readCurrentUiContext()!.commands;
            expect(replacement.map(command => command.title)).toEqual([
                ...initial.slice(1).map(command => command.title), `${prefix}replacement details`,
            ]);
            expect(replacement.slice(0, -1).map(command => command.id)).toEqual(initial.slice(1).map(command => command.id));
            expect(firstRetirement.aborted).toBe(true);
            const lastRetirement = reader!.resolveCurrentUiCommand(replacement.at(-1)!.id)!.retirementSignal;
            // Keep the producer mounted so React executes the unregister state updates.
            await screen.update(tree(0));
            const removed = readCopies();
            expect(reader!.readCurrentUiContext()!.commands).toEqual([]);
            expect(lastRetirement.aborted).toBe(true);
            console.info(JSON.stringify({ registryCopy: true, descendants: count, mounted, unchanged, replaced, removed }));
            expect.soft(mounted.copied, 'mounting controls must not copy each prior registry inventory').toBe(0);
            expect.soft(unchanged.copied, 'unchanged command inventories must not register again').toBe(0);
            expect.soft(replaced.copied, 'replacing one owner must not copy the other owners').toBe(0);
            expect.soft(removed.copied, 'unregistering controls must not copy every remaining inventory').toBe(0);
        } finally { filter.mockRestore(); }
    });

    it('replaces focused commands without retiring ordinary commands or clearing the newer focus', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://command-registry-focus.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime()!;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const controls = new Map<string, Readonly<{ activate(): Promise<boolean>; clear(): void }>>();
        function Focused(props: Readonly<{ id: string }>) {
            const isCurrent = React.useCallback(() => authority.isCurrent(), []);
            const definitions = useCurrentUiContextLocalCommandDefinitions([
                { key: 'details', title: `${props.id} focus`, invoke: () => { changes.push(props.id); } },
            ], isCurrent, props.id);
            const focus = useCurrentUiContextFocusedCommands(props.id);
            controls.set(props.id, { activate: () => focus!.activate(definitions), clear: () => focus!.clear() });
            return null;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CurrentUiContextCommandsProvider authority={authority}><Publication />
                        <Descendant id="ordinary" value="ordinary" /><Focused id="first" /><Focused id="second" />
                    </CurrentUiContextCommandsProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        const ordinary = reader!.readCurrentUiContext()!.commands[0]!;
        const ordinaryRetirement = reader!.resolveCurrentUiCommand(ordinary.id)!.retirementSignal;
        let activation: Promise<boolean> | undefined;
        await act(async () => { activation = controls.get('first')!.activate(); });
        expect(await activation).toBe(true);
        const first = reader!.readCurrentUiContext()!.commands[1]!;
        const firstRetirement = reader!.resolveCurrentUiCommand(first.id)!.retirementSignal;
        await act(async () => { activation = controls.get('second')!.activate(); });
        expect(await activation).toBe(true);
        expect(firstRetirement.aborted).toBe(true);
        await act(async () => { controls.get('first')!.clear(); });
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['ordinary details', 'second focus']);
        expect(reader!.readCurrentUiContext()!.commands[0]!.id).toBe(ordinary.id);
        expect(ordinaryRetirement.aborted).toBe(false);
        await act(async () => { controls.get('second')!.clear(); });
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['ordinary details']);
        await screen.unmount();
        expect(ordinaryRetirement.aborted).toBe(true);
    });

    it('keeps an unchanged local command when its owner adds a sibling and invokes its latest callback', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://local-command-reconcile.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        function Choices(props: Readonly<{ extra: boolean }>) {
            const choices = useCurrentUiContextLocalCommands([
                { key: 'first', title: 'First choice', invoke: () => { changes.push(props.extra ? 'latest' : 'original'); } },
                ...(props.extra ? [{ key: 'second', title: 'Second choice', invoke: () => { changes.push('second'); } }] : []),
            ]);
            intents.set('choices', choices.invoke);
            return <Publication />;
        }
        const tree = (extra: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive><Choices extra={extra} /></PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(false));
        const capturedInvoke = intents.get('choices')!;
        const first = reader!.readCurrentUiContext()!.commands[0]!;
        const retirement = reader!.resolveCurrentUiCommand(first.id)!.retirementSignal;
        await screen.update(tree(true));
        expect(reader!.readCurrentUiContext()!.commands[0]!.id).toBe(first.id);
        expect(retirement.aborted).toBe(false);
        // Deferred native menu selection keeps the callback from before the menu closes.
        await act(async () => { expect(await capturedInvoke('first')).toBe(true); });
        expect(changes).toEqual(['latest']);
        const second = reader!.readCurrentUiContext()!.commands[1]!;
        const secondRetirement = reader!.resolveCurrentUiCommand(second.id)!.retirementSignal;
        await screen.update(tree(false));
        expect(reader!.readCurrentUiContext()!.commands[0]!.id).toBe(first.id);
        expect(reader!.resolveCurrentUiCommand(second.id)).toBeNull();
        expect(secondRetirement.aborted).toBe(true);
        await act(async () => { expect(await capturedInvoke('second')).toBe(false); });
        await act(async () => { expect(await capturedInvoke('first')).toBe(true); });
        expect(changes).toEqual(['latest', 'original']);
        await screen.unmount();
        expect(await capturedInvoke('first')).toBe(false);
        expect(retirement.aborted).toBe(true);
    });

    it('keeps Settings admission out of Session context and publishes the Settings identity on navigation', async () => {
        routeState.pathname = '/session/session-a'; routeState.segments = ['(app)', 'session', '[id]'];
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://current-context-settings-demand.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const governancePaths = new Set((['home.governance.get', 'home.governance.eligibility.get'] as const).map(id =>
            bindHomeDomainActionHttpRequestV1(id, {}).path));
        const priorReads = home.httpRequests.filter(request => governancePaths.has(request.path)).length;
        const tree = () => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><Publication /></CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree());
        expect(reader!.readCurrentUiContext()).not.toBeNull();
        expect(home.httpRequests.filter(request => governancePaths.has(request.path))).toHaveLength(priorReads);
        routeState.pathname = '/settings/usage'; routeState.segments = ['(app)', 'settings', 'usage'];
        await screen.update(tree());
        expect(reader!.readCurrentUiContext()?.navigation).toMatchObject({ area: 'settings', title: t('settings.usage') });
        await screen.unmount();
    });
    it('publishes mounted host commands alongside author commands through the real UI Actions and retires them on unmount', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://mounted-host-commands.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const tree = (show: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <Publication author />{show ? <Descendant id="widget" value="expanded" /> : null}
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
        expect(read.ok).toBe(true);
        const command = reader!.readCurrentUiContext()!.commands.find(command => command.title === 'widget details');
        const author = reader!.readCurrentUiContext()!.commands.find(command => command.title === 'Author details')!;
        const authorRetirement = reader!.resolveCurrentUiCommand(author.id)!.retirementSignal;
        expect(command).toBeDefined();
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['Author details', 'widget details']);
        await act(async () => {
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: command!.id }, { surface: 'agent' })).toMatchObject({ ok: true });
        });
        expect(changes).toEqual(['expanded']);
        await screen.update(tree(false));
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['Author details']);
        expect(reader!.readCurrentUiContext()!.commands[0]!.id).toBe(author.id);
        expect(authorRetirement.aborted).toBe(false);
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command!.id }, { surface: 'agent' })).toMatchObject({ ok: false });
        await screen.unmount();
        expect(authorRetirement.aborted).toBe(true);
    });
    it('keeps a mounted host command\'s address while a surface publication takes and releases the record', async () => {
        // Each command address is one reverse-RPC room per reachable Machine: a re-minted id for an
        // unchanged declaration costs an unregister and a register on every Machine socket.
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://host-command-owner-handoff.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const tree = (surface: boolean) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <ObserveReader /><Descendant id="widget" value="expanded" />{surface ? <Publication author /> : null}
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(false));
        const hostId = () => reader!.readCurrentUiContext()!.commands.find(command => command.title === 'widget details')?.id;
        const original = hostId()!;
        const retirement = reader!.resolveCurrentUiCommand(original)!.retirementSignal;
        await screen.update(tree(true));
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['Author details', 'widget details']);
        expect(hostId()).toBe(original);
        await screen.update(tree(false));
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['widget details']);
        expect(hostId()).toBe(original);
        expect(retirement.aborted).toBe(false);
        expect(reader!.resolveCurrentUiCommand(original)?.retirementSignal).toBe(retirement);
        await screen.unmount();
        expect(retirement.aborted).toBe(true);
    });
    it('composes descendants through Action admission and retires removed, unbound and Account-stale capabilities', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://current-context-composition.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const tree = (second: boolean, value = 'first', scope = authority) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <ComposedPage authority={scope} second={second} value={value} />
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree(true));
        expect(reader?.readCurrentUiContext()?.commands.map(command => command.title)).toEqual(['first details', 'second details']);
        const removed = reader!.readCurrentUiContext()!.commands[1]!;
        const retiredIntent = intents.get('second')!;
        const settings = getStorage().getState().settings;
        await act(async () => {
            getStorage().getState().applySettingsForScope(authority!.scope, { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: { 'ui.current_context.command.invoke': { disabledSurfaces: ['ui'] } },
            }) }, 2);
            expect(await intents.get('first')!('details')).toBe(false);
        });
        expect(changes).toEqual([]);
        await act(async () => { getStorage().getState().applySettingsForScope(authority!.scope, settings, 3); });
        await act(async () => { expect(await intents.get('first')!('details')).toBe(true); });
        expect(changes).toEqual(['first']);
        await screen.update(tree(false, 'updated'));
        expect(reader!.readCurrentUiContext()!.commands.map(command => command.title)).toEqual(['first details']);
        await act(async () => { expect(await retiredIntent('details')).toBe(false); });
        await expect(executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: removed.id },
            context: { surface: 'agent' } })).resolves.toMatchObject({ ok: false });
        await act(async () => { expect(await intents.get('first')!('details')).toBe(true); });
        expect(changes).toEqual(['first', 'updated']);
        unregister?.();
        await act(async () => { expect(await intents.get('first')!('details')).toBe(false); });
        await screen.update(tree(false, 'unbound', null));
        expect(reader!.readCurrentUiContext()!.commands).toEqual([]);
        await act(async () => { expect(await intents.get('first')!('details')).toBe(false); });
        await screen.update(tree(false));
        await act(async () => { retireActiveServerAccountScopeLifetime(); expect(await intents.get('first')!('details')).toBe(false); });
        expect(changes).toEqual(['first', 'updated']);
    });

    it('mounts the session title editor\'s begin and cancel as commands that retire with the editor state', async () => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://title-editor-commands.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const authority = captureActiveServerAccountScopeLifetime();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
        const tree = () => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    <CurrentUiContextCommandsProvider authority={authority}>
                        <Publication />
                        <SessionPaneHeader title="Fix settings modal remount" rename={{ sessionId: 'session-a', serverId: server.id }} />
                    </CurrentUiContextCommandsProvider>
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        const invoke = (commandId: string) => executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
            input: { commandId }, context: { surface: 'agent' } });
        const commands = () => reader!.readCurrentUiContext()!.commands;
        const input = () => screen.findHostByTestId('session-header-title-input');
        const screen = await renderScreen(tree());
        expect(commands().map(command => command.title)).toEqual([t('sessionInfo.renameSession')]);
        const begin = commands()[0]!;
        await act(async () => { expect(await invoke(begin.id)).toMatchObject({ ok: true }); });
        expect(input()?.props.value).toBe('Fix settings modal remount');
        // While editing, Begin is retired and Cancel is the mounted command.
        expect(commands().map(command => command.title)).toEqual([t('sessionInfo.cancelRenameSession')]);
        await act(async () => { expect(await invoke(begin.id)).toMatchObject({ ok: false }); });
        await act(async () => { input()!.props.onChangeText('Draft that is dropped'); });
        const cancel = commands()[0]!;
        await act(async () => { expect(await invoke(cancel.id)).toMatchObject({ ok: true }); });
        expect(input()).toBeNull();
        expect(commands().map(command => command.title)).toEqual([t('sessionInfo.renameSession')]);
        await act(async () => { expect(await invoke(cancel.id)).toMatchObject({ ok: false }); });
        // Cancel dropped the draft: beginning again starts from the title.
        await act(async () => { expect(await invoke(commands()[0]!.id)).toMatchObject({ ok: true }); });
        expect(input()?.props.value).toBe('Fix settings modal remount');
        await screen.unmount();
    });
});
