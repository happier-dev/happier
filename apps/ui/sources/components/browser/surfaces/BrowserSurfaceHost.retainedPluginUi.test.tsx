import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';

import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { defineUiSurface, usePluginHostApi, type PluginUiHostApi } from '@happier-dev/plugin-ui';
import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';
import { flushHookEffects, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { BrowserShell } from '@/components/browser/BrowserShell';
import { createPluginSurfaceActionHostApi } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createRetainedPresentationSlotsStore, RetainedPresentationSlotBinder, RetainedPresentationSlotsProvider } from '@/components/ui/presentation/retainedPresentationSlots';
import { SessionViewerSourceAccountScopeProvider } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { createBrowserViewState, openBrowserTarget } from '@/sync/domains/browser/store';
import { createDefaultRuntimeActionExecutor } from '@/sync/ops/actions/defaultRuntimeActionExecutor';
import { BrowserSurfaceHost } from './BrowserSurfaceHost';
import { BrowserScopedWorkspace } from './BrowserScopedWorkspace';
import { BrowserMobileSurfaceScreen } from './BrowserMobileSurfaceScreen';
import * as machineTransport from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { LocalServicePreviewSnapshot } from '@/sync/domains/local/services/preview/store';
import { getLocalServicePreviewState } from '@/sync/domains/local/services/preview/sharedStore';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { createBrowserViewDetailsTab } from './browserSurfaceDetailsTabModel';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { DetailsTabLifetimeScope } from '@/components/appShell/panes/details/workspace/detailsTabLifetime';
import { selectedPaneDestinationTabKey } from '@/components/appShell/panes/model/selectedPaneDestination';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { executeCurrentUiContextAction } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';

// Public plugin Host API imports reach Socket consumers before route setup.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installTerminalRouteCommonModuleMocks();
await initializeTerminalRouteRuntimeForTests();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let previewAccessReads = 0;
beforeEach(async () => {
    previewAccessReads = 0;
    connection = await restoreServerAccountForTest({ serverUrl: 'https://retained-plugin-ui.example.test',
        serverIdentityId: 'srv_retained_plugin', request: async input => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith('/preview/phone-preview/access')) {
                previewAccessReads++;
                return Response.json({ v: 1, kind: 'server_preview', previewId: 'phone-preview', machineId: 'machine-1',
                    accessUrl: 'https://phone-preview.example.test/', expiresAt: 2_000_000_000_000 });
            }
            if (path === '/v1/account/profile') return Response.json({ profile: AccountProfileSchema.parse({ id: 'account-a' }) });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                browser: { enabled: true, internal: { enabled: true }, automation: { enabled: true }, viewTargets: { enabled: true } },
            } }));
            return null;
        } });
});
afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    clearBrowserRuntimeControlRegistryForTests();
});

function DetailsPresentation(props: Readonly<{
    shown: boolean;
    scopeId: string;
    browserTab: DetailsTab;
    pane: { current?: AppPaneScopeApi };
    renderBrowser: () => React.ReactElement;
    renderSibling: () => React.ReactElement;
}>) {
    const pane = useAppPaneScope(props.scopeId);
    props.pane.current = pane;
    return props.shown && pane.scopeState?.details.isOpen ? <DetailsSplitWorkspace pane={pane}
        testIds={{ tabClose: key => `close-${key}` }}
        renderTabContent={tab => tab.key === props.browserTab.key ? props.renderBrowser() : props.renderSibling()} /> : null;
}

function RetainedSiblingResource(props: Readonly<{ acquire: () => () => void }>) {
    React.useEffect(props.acquire, [props.acquire]);
    return null;
}

function SelectedSlotPresentation(props: Readonly<{
    shown: boolean;
    scopeId: string;
    pane: { current?: AppPaneScopeApi };
    renderBrowser: () => React.ReactElement;
}>) {
    const pane = useAppPaneScope(props.scopeId);
    props.pane.current = pane;
    // PaneTabDestination gives the selected body this canonical synthetic key.
    return props.shown && pane.scopeState?.right.isOpen ? <DetailsTabLifetimeScope
        scopeId={props.scopeId} tabKey={selectedPaneDestinationTabKey('right')}>
        {props.renderBrowser()}
    </DetailsTabLifetimeScope> : null;
}

async function mountRetainedBrowserForPlugin(scopeId?: string, selectedSlot = false) {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !connection) throw new Error('Expected admitted Account lifetime');
    const view = { browserSessionId: 'plugin-browser', viewId: 'plugin-view' };
    const store = createRetainedPresentationSlotsStore();
    const target = {
        kind: 'localServicePreview', targetId: 'plugin-preview', sessionId: 'session-1', machineId: 'machine-1',
        display: { title: 'Preview', addressLabel: 'Preview' },
    } as const;
    const state = openBrowserTarget(createBrowserViewState(), target, { ...view, platform: 'web', currentUrl: 'about:blank' });
    const browserTab = createBrowserViewDetailsTab({ ...view, target });
    const pane: { current?: AppPaneScopeApi } = {};
    let subscriptions = 0;
    // External Browser transport subscription; its unsubscribe must follow the retained runtime.
    const subscribeBrowserEvents = () => { subscriptions += 1; return () => { subscriptions -= 1; }; };
    let siblingSubscriptions = 0;
    const acquireSibling = () => { siblingSubscriptions += 1; return () => { siblingSubscriptions -= 1; }; };
    const renderSibling = () => <RetainedPresentationSlotBinder slotId="sibling-slot">
        <RetainedSiblingResource acquire={acquireSibling} />
    </RetainedPresentationSlotBinder>;
    expect(state.viewsById[view.viewId]).toBeTruthy();
    const renderBrowser = () => <SessionViewerSourceAccountScopeProvider accountLifetime={lifetime}>
            <BrowserSurfaceHost {...view} platform="web" initialBrowserState={state} presentationSlotId="plugin-slot"
                subscribeBrowserEvents={subscribeBrowserEvents}
                visible active measuredRect={{ x: 0, y: 0, width: 640, height: 480 }} keepAliveAboveRouter
                pluginBrowserActionContext={{ machineId: 'machine-1', sessionId: 'session-1' }}
                policy={{ browserEnabled: true, viewTargetsEnabled: true, automationEnabled: true,
                    contextEnabled: false, diagnosticsEnabled: false, recordingEnabled: false }} />
        </SessionViewerSourceAccountScopeProvider>;
    const render = (shown: boolean) => <AppPaneProvider><RetainedPresentationSlotsProvider store={store}>
        {scopeId && selectedSlot ? <SelectedSlotPresentation shown={shown} scopeId={scopeId} pane={pane}
            renderBrowser={renderBrowser} /> : scopeId ? <DetailsPresentation shown={shown} scopeId={scopeId} browserTab={browserTab} pane={pane}
            renderBrowser={renderBrowser} renderSibling={renderSibling} /> : shown ? renderBrowser() : null}
    </RetainedPresentationSlotsProvider></AppPaneProvider>;
    const screen = await renderScreen(render(true), {
        // Native layout is absent from the host renderer. Let the real binder
        // measure its placeholder instead of seeding the portal's internal state.
        createNodeMock: element => typeof element.props.testID === 'string'
            && (element.props.testID.startsWith('browser-keepalive-placeholder-')
                || element.props.testID === 'browser-presentation-portal-host')
            ? { measureInWindow: (publish: (x: number, y: number, width: number, height: number) => void) => publish(0, 0, 640, 480) }
            : null,
    });
    const layoutBrowser = async () => {
        await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('browser-keepalive-placeholder-plugin-slot'), 'onLayout');
        });
        await flushHookEffects();
    };
    if (scopeId) await act(async () => {
        if (selectedSlot) pane.current!.openRight({ tabId: 'browser' });
        else pane.current!.openDetailsTab(browserTab, { intent: 'pinned' });
    });
    await layoutBrowser();
    await flushHookEffects();
    if (selectedSlot) expect(store.getPortalSnapshot().some(entry => entry.slotId === 'plugin-slot')).toBe(true);
    const shell = screen.findByType(BrowserShell);
    const service: BrowserAutomationControlService | undefined = shell.props.browserAutomation?.controlService;
    if (!service) throw new Error('Expected real Browser controller');
    let effects = 0;
    // Only the injected page effect is substituted. Host, registry, controller,
    // Protocol Action policy and both public plugin-UI/SDK projections stay real.
    service.registerOwner({ ownerId: 'plugin-page', ...view, navigationGeneration: 0, authority: 'uiLocal',
        adapterKind: 'localPreview', fidelity: 'injectedPage', trustedInput: false, supportedActions: ['press'],
        executeAction: async () => { effects += 1; return { status: 'succeeded', resultSummary: { pressed: true } }; } });
    const request = { v: 1, ...view, automationRequestId: 'plugin-press', navigationGeneration: 0,
        requestedBy: 'plugin', requesterRef: { kind: 'plugin', id: 'com.acme.fixture' }, timeoutMs: 1000,
        actionKind: 'press', payload: { locator: { kind: 'css', value: '#counter' }, key: 'Enter' } } as const;
    // An explicit Account policy waiver exercises already-admitted runtime dispatch;
    // it does not turn the external Plugin into a present-user caller or bypass policy.
    const actionsSettings = normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'browser.automation.press': ['plugin'] } });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        runtimeActionExecute: createDefaultRuntimeActionExecutor(),
        readActionsSettings: () => actionsSettings,
    }));
    const requestSurface: PluginUiSurfaceContextV1 = { pluginId: 'com.acme.fixture', contributionId: 'surface', surfaceId: 'external-preview-controls',
        sessionId: 'session-1', placement: 'sessionPane', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] };
    const host = createPluginSurfaceActionHostApi({ surfaceContext: requestSurface, isCurrent: lifetime.isCurrent,
        callerBinding: { pluginId: requestSurface.pluginId, contributionLocalId: requestSurface.contributionId,
            occurrenceId: 'external-preview-controls', materializationRef: { pluginId: requestSurface.pluginId,
                machineId: 'machine-1', materializationId: 'external-preview-materialization' } },
        hostAction: { execute: executor.execute, context: { serverId: connection.serverId, runtimeAccountId: 'account-a',
            defaultSessionId: 'session-1', actionsSettings } } });
    const surface = createPluginSurfaceContextFixture({ accountEncryptionMode: 'plain' });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface,
        handleRequest: host.handleRequest,
        installedMethods: host.installedMethods, isCurrent: lifetime.isCurrent });
    const external: { api?: PluginUiHostApi } = {};
    const renderSurface = defineUiSurface(function ExternalBrowserControls() {
        external.api = usePluginHostApi();
        return null;
    });
    const element = await renderSurface({ plugin: { id: requestSurface.pluginId, version: '1.0.0' },
        surface, hostApi: adapter.api, signal: new AbortController().signal });
    if (!React.isValidElement(element)) throw new Error('Expected public plugin surface element');
    await renderScreen(element);
    if (!external.api) throw new Error('Expected public plugin Host API');
    return { screen, shell, service, request, api: external.api, store, browserTab, pane,
        effects: () => effects, subscriptions: () => subscriptions,
        siblingSubscriptions: () => siblingSubscriptions,
        park: async () => { await screen.update(render(false)); await flushHookEffects(); },
        show: async () => { await screen.update(render(true)); await layoutBrowser(); },
        dispose: () => { adapter.dispose(); host.dispose?.(); } };
}

function PhoneWorkspace(props: Readonly<{ shown: boolean; pane: { current?: AppPaneScopeApi }; presentation?: 'phone' | 'workspace' | 'viewer' }>) {
    props.pane.current = useAppPaneScope('session:phone-close');
    return props.shown ? <BrowserScopedWorkspace scopeId="session:phone-close"
        scope={{ kind: 'session', sessionId: 'session-1', serverId: connection!.serverId }}
        localServicePreviewServerId={connection!.serverId}
        openScope="sessionMobile" platform="web"
        collapseSingleTab={props.presentation !== 'workspace'}
        presentation={props.presentation === 'viewer' ? 'viewer' : 'workspace'}
        keepAliveAboveRouter presentationSlotId="phone-slot" /> : null;
}

describe('retained Browser through the external plugin-UI Action API', () => {
    it.each(['phone', 'workspace', 'viewer'] as const)('shows the empty Browser launchpad on first open and after closing the last tab (%s)', async (presentation) => {
        const pane: { current?: AppPaneScopeApi } = {};
        const store = createRetainedPresentationSlotsStore();
        const render = (shown: boolean) => <AppPaneProvider><RetainedPresentationSlotsProvider store={store}>
            <PhoneWorkspace shown={shown} pane={pane} presentation={presentation} />
        </RetainedPresentationSlotsProvider></AppPaneProvider>;
        const screen = await renderScreen(render(true));
        await flushHookEffects();
        expect(screen.findByType(BrowserShell)).not.toBeNull();
        expect(store.getPortalSnapshot()).toHaveLength(1);
        await screen.update(render(false));
        await screen.update(render(true));
        await flushHookEffects();
        expect(screen.findByType(BrowserShell)).not.toBeNull();
        const tab = createBrowserViewDetailsTab({ browserSessionId: 'phone-browser', viewId: 'phone-view',
            target: { kind: 'localServicePreview', targetId: 'phone-preview', sessionId: 'session-1',
                machineId: 'machine-1', display: { title: 'Preview' } } });
        await act(async () => pane.current!.openDetailsTab(tab, { intent: 'pinned' }));
        await flushHookEffects();
        // Opening a real page retires the empty-group body instead of leaking it beside the page.
        expect(store.getPortalSnapshot()).toHaveLength(1);
        await act(async () => screen.findByType(BrowserShell).props.onCloseTab());
        await flushHookEffects();
        expect(pane.current!.scopeState?.details.tabs).toHaveLength(0);
        expect(screen.findByType(BrowserShell)).not.toBeNull();
        expect(store.getPortalSnapshot()).toHaveLength(1);
        await screen.unmount();
    });

    it('keeps the registered phone preview and access while hidden, and releases demand on Close', async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !connection) throw new Error('Expected Account');
        const serverId = connection.serverId;
        const previous = storage.getState();
        storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId,
            computerMachineBinding: { homeId: serverId, machineId: 'machine-1' } }) } });
        const pane: { current?: AppPaneScopeApi } = {};
        const store = createRetainedPresentationSlotsStore();
        const projection = { phase: 'current', machineId: 'machine-1', serverId, accountLifetime: lifetime,
            interactionEnabled: true, platform: 'web', pluginUiProjection: null, pluginBrowserProjection: null } as const;
        function Scene(props: Readonly<{ shown: boolean }>) {
            pane.current = useAppPaneScope('session:phone-demand');
            return <PluginSurfaceFocusEligibilityProvider active={props.shown}>
                <BrowserMobileSurfaceScreen sessionId="session-1" scopeId="session:phone-demand"
                    pluginProjection={projection} keepAliveAboveRouter presentationSlotId="phone-demand-slot" />
            </PluginSurfaceFocusEligibilityProvider>;
        }
        const render = (shown: boolean) => <AppPaneProvider><RetainedPresentationSlotsProvider store={store}>
            <Scene shown={shown} />
        </RetainedPresentationSlotsProvider></AppPaneProvider>;
        const target = { kind: 'localServicePreview', targetId: 'phone-target', sessionId: 'session-1',
            machineId: 'machine-1', display: { title: 'Preview', addressLabel: 'localhost:5173' } } as const;
        const key = { serverId, machineId: 'machine-1', accountId: lifetime.scope.accountId };
        const snapshot = { generatedAt: 100, refreshState: 'idle', diagnostics: [], previews: [{
            previewId: 'phone-preview', accessUrl: 'https://phone-preview.example.test/', expiresAt: null, diagnostics: [],
            resource: { previewId: 'phone-preview', sessionId: 'session-1', machineId: 'machine-1',
                owner: { kind: 'session', id: 'session-1' }, target: { scheme: 'http', host: 'localhost', port: 5173 },
                initialPath: { pathname: '/', search: '' }, display: target.display, originMode: 'host', browserTarget: target },
        }] } satisfies LocalServicePreviewSnapshot;
        let previewReads = 0;
        // Machine RPC is the external transport boundary; domain parsing and stores stay real.
        const transport = vi.spyOn(machineTransport, 'machineRpcWithServerScope').mockImplementation(async <Response,>(input: Parameters<typeof machineTransport.machineRpcWithServerScope>[0]) => {
            if (input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT) {
                previewReads++;
                return { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-1', ...snapshot,
                    resources: snapshot.previews.map(row => row.resource) } } as Response;
            }
            return { error: 'unavailable' } as Response;
        });
        const screen = await renderScreen(render(true), { createNodeMock: () => ({
            measureInWindow: (publish: (x: number, y: number, width: number, height: number) => void) => publish(0, 0, 640, 480),
        }) });
        try {
            await flushHookEffects();
            expect(previewReads).toBe(0);
            await act(async () => pane.current!.openDetailsTab(createBrowserViewDetailsTab({
                browserSessionId: 'phone-browser', viewId: 'phone-view', target,
                currentUrl: 'https://phone-preview.example.test/',
            }), { intent: 'pinned' }));
            await act(async () => invokeTestInstanceHandler(screen.findHostByTestId('browser-keepalive-placeholder-phone-demand-slot'), 'onLayout'));
            await flushHookEffects({ cycles: 40 });
            expect(previewReads).toBe(1);
            expect(getLocalServicePreviewState(key).previewIds).toEqual(['phone-preview']);
            const page = screen.findAllByType('iframe')[0];
            expect(page).toBeDefined();
            const acquired = previewAccessReads;
            expect(acquired).toBeGreaterThan(0);
            await screen.update(render(false));
            await flushHookEffects();
            expect(getLocalServicePreviewState(key).previewIds).toEqual(['phone-preview']);
            expect(screen.findAllByType('iframe')[0]).toBe(page);
            await screen.update(render(true));
            await flushHookEffects();
            expect(screen.findAllByType('iframe')[0]).toBe(page);
            expect(previewReads).toBe(1);
            expect(previewAccessReads).toBe(acquired);
            await act(async () => screen.findByType(BrowserShell).props.onCloseTab());
            await flushHookEffects();
            expect(screen.findAllByType('iframe')).toHaveLength(0);
            expect(getLocalServicePreviewState(key).previewIds).toEqual([]);
        } finally { await screen.unmount(); transport.mockRestore(); storage.setState(previous, true); }
    });

    it('preserves the admitted page while phone Browser switches to Chat and back with membership intact', async () => {
        const pane: { current?: AppPaneScopeApi } = {};
        const parent: { current?: AppPaneScopeApi } = {};
        const store = createRetainedPresentationSlotsStore();
        function PhoneScene(props: Readonly<{ surface: 'browser' | 'chat' }>) {
            parent.current = useAppPaneScope('session:phone-parent');
            return <PluginSurfaceFocusEligibilityProvider active={props.surface === 'browser'}>
                <PhoneWorkspace shown pane={pane} />
            </PluginSurfaceFocusEligibilityProvider>;
        }
        const render = (surface: 'browser' | 'chat') => <AppPaneProvider><RetainedPresentationSlotsProvider store={store}>
            <PhoneScene surface={surface} />
        </RetainedPresentationSlotsProvider></AppPaneProvider>;
        const screen = await renderScreen(render('browser'), { createNodeMock: () => ({
            measureInWindow: (publish: (x: number, y: number, width: number, height: number) => void) => publish(0, 0, 640, 480),
        }) });
        const tab = createBrowserViewDetailsTab({ browserSessionId: 'phone-browser', viewId: 'phone-view',
            currentUrl: 'https://phone-preview.example.test/',
            target: { kind: 'localServicePreview', targetId: 'phone-preview', sessionId: 'session-1',
                machineId: 'machine-1', display: { title: 'Preview' } } });
        await act(async () => { pane.current!.openDetailsTab(tab, { intent: 'pinned' }); });
        await act(async () => invokeTestInstanceHandler(screen.findHostByTestId('browser-keepalive-placeholder-phone-slot'), 'onLayout'));
        await flushHookEffects({ cycles: 40 });
        const page = screen.findAllByType('iframe')[0];
        expect(page).toBeDefined();
        const shell = screen.findByType(BrowserShell);
        // The real cockpit switchSurface('chat') closes the parent right presentation,
        // then the navigator withdraws this Browser scene's focus. It does not close its tab.
        await act(async () => parent.current!.closeRight());
        await screen.update(render('chat'));
        await flushHookEffects();
        expect(pane.current!.scopeState?.details.tabs.map(tab => tab.key)).toEqual([tab.key]);
        expect(screen.findByType(BrowserShell)).toBe(shell);
        expect(screen.findAllByType('iframe')[0]).toBe(page);
        await screen.update(render('browser'));
        await flushHookEffects();
        expect(screen.findAllByType('iframe')[0]).toBe(page);
        await act(async () => shell.props.onCloseTab());
        await flushHookEffects();
        expect(screen.findAllByType('iframe')).toHaveLength(0);
        expect(store.getPortalSnapshot()).toHaveLength(1);
        expect(Object.keys(screen.findByType(BrowserShell).props.state.viewsById)).toHaveLength(0);
    });

    it('retires the collapsed phone workspace page on Close after preserving route recomposition', async () => {
        const pane: { current?: AppPaneScopeApi } = {};
        const store = createRetainedPresentationSlotsStore();
        const render = (shown: boolean) => <AppPaneProvider><RetainedPresentationSlotsProvider store={store}>
            <PhoneWorkspace shown={shown} pane={pane} />
        </RetainedPresentationSlotsProvider></AppPaneProvider>;
        const screen = await renderScreen(render(true), { createNodeMock: () => ({
            measureInWindow: (publish: (x: number, y: number, width: number, height: number) => void) => publish(0, 0, 640, 480),
        }) });
        const tab = createBrowserViewDetailsTab({ browserSessionId: 'phone-browser', viewId: 'phone-view',
            target: { kind: 'localServicePreview', targetId: 'phone-preview', sessionId: 'session-1',
                machineId: 'machine-1', display: { title: 'Preview' } } });
        await act(async () => { pane.current!.openDetailsTab(tab, { intent: 'pinned' }); });
        await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('browser-keepalive-placeholder-phone-slot'), 'onLayout');
        });
        await flushHookEffects();
        const shell = screen.findByType(BrowserShell);
        expect(store.getPortalSnapshot()).toHaveLength(1);
        await screen.update(render(false));
        await flushHookEffects();
        expect(screen.findByType(BrowserShell)).toBe(shell);
        await screen.update(render(true));
        await flushHookEffects();
        expect(screen.findByType(BrowserShell)).toBe(shell);
        await act(async () => { shell.props.onCloseTab(); });
        await flushHookEffects();
        expect(pane.current!.scopeState?.details.tabs).toHaveLength(0);
        expect(store.getPortalSnapshot()).toHaveLength(1);
        expect(screen.findByType(BrowserShell)).not.toBe(shell);
    });

    it('opens and closes launchpad error diagnostics after the Details workspace hands its Browser to the retained portal', async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected admitted Account lifetime');
        const view = { browserSessionId: 'unavailable-browser', viewId: 'unavailable-view' };
        const browserTab = createBrowserViewDetailsTab({ ...view, target: {
            kind: 'localServicePreview', targetId: 'unavailable-preview', sessionId: 'session-1', machineId: 'machine-1',
            display: { title: 'Preview', addressLabel: 'Preview' },
        } });
        const store = createRetainedPresentationSlotsStore();
        const pane: { current?: AppPaneScopeApi } = {};
        let reader: CurrentUiContextReader | null = null;
        const state = createBrowserViewState();
        const renderBrowser = () => <SessionViewerSourceAccountScopeProvider accountLifetime={lifetime}>
            <BrowserSurfaceHost {...view} platform="web" initialBrowserState={state} presentationSlotId="diagnostics-slot"
                testID="browser-view-details-surface" launchpadRefreshStatus="error" launchpadRefreshError="request_failed"
                visible active measuredRect={{ x: 0, y: 0, width: 640, height: 480 }} keepAliveAboveRouter
                policy={{ browserEnabled: true, viewTargetsEnabled: true, automationEnabled: true,
                    contextEnabled: false, diagnosticsEnabled: false, recordingEnabled: false }} />
        </SessionViewerSourceAccountScopeProvider>;
        function Page() {
            reader = useOptionalCurrentUiContextReader();
            const dispatch = useAppPaneContext(value => value.dispatch);
            React.useLayoutEffect(() => {
                dispatch({ type: 'activateScope', scopeId: 'session:browser-diagnostics' });
                dispatch({ type: 'openDetailsTab', scopeId: 'session:browser-diagnostics', tab: browserTab, openAs: 'pinned' });
            }, [dispatch]);
            return <DetailsPresentation shown scopeId="session:browser-diagnostics" browserTab={browserTab}
                pane={pane} renderBrowser={renderBrowser} renderSibling={() => <></>} />;
        }
        const screen = await renderMountedCurrentUiContext(<RetainedPresentationSlotsProvider store={store}>
            <Page />
        </RetainedPresentationSlotsProvider>, {
            // The platform boundary supplies the same geometry as a laid-out Details pane.
            createNodeMock: element => typeof element.props.testID === 'string'
                && (element.props.testID.startsWith('browser-keepalive-placeholder-')
                    || element.props.testID === 'browser-presentation-portal-host')
                ? { measureInWindow: (publish: (x: number, y: number, width: number, height: number) => void) => publish(0, 0, 640, 480) }
                : null,
        });
        await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('browser-keepalive-placeholder-diagnostics-slot'), 'onLayout');
        });
        await flushHookEffects();
        expect(store.getPortalSnapshot().map(entry => entry.slotId)).toEqual(['diagnostics-slot']);
        expect(reader!.readCurrentUiContext()?.navigation.area).toBe('workspace');
        const command = reader!.readCurrentUiContext()?.commands.find(command => command.title === 'Browser targets need attention: Details');
        expect(command).toBeDefined();
        const toggle = 'browser-view-details-surface-launchpad-error-details-toggle';
        const code = 'browser-view-details-surface-launchpad-error-details-code';
        await act(async () => {
            expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
                input: { commandId: command!.id }, context: { surface: 'agent' } })).toMatchObject({ ok: true });
        });
        expect(screen.findByTestId(code)?.props.children).toBe('request_failed');
        await screen.pressByTestIdAsync(toggle);
        await vi.waitFor(() => expect(screen.findByTestId(code)).toBeNull());
        await screen.pressByTestIdAsync(toggle);
        await vi.waitFor(() => expect(screen.findByTestId(code)?.props.children).toBe('request_failed'));
    });

    it('retains a selected-slot Browser across route handoff and retires it when its slot is removed', async () => {
        const mounted = await mountRetainedBrowserForPlugin('session:selected-browser', true);
        try {
            await mounted.park();
            expect(mounted.store.getPortalSnapshot().map(entry => entry.slotId)).toEqual(['plugin-slot']);
            expect(mounted.screen.findByType(BrowserShell)).toBe(mounted.shell);
            expect(mounted.subscriptions()).toBe(1);
            expect(await mounted.api.executeAction('browser.automation.press', mounted.request))
                .toMatchObject({ status: 'succeeded', resultSummary: { pressed: true } });
            await act(async () => { mounted.pane.current!.closeRight(); });
            await flushHookEffects();
            expect(mounted.store.getPortalSnapshot()).toEqual([]);
            expect(mounted.subscriptions()).toBe(0);
            await expect(mounted.api.executeAction('browser.automation.press', { ...mounted.request, automationRequestId: 'removed-slot' }))
                .rejects.toMatchObject({ code: 'runtime_action_disabled', diagnostics: [{ code: 'runtime_action_disabled' }] });
            expect(mounted.effects()).toBe(1);
        } finally { mounted.dispose(); }
    });

    it('keeps hide and route handoff continuous, then retires a Browser closed by the real Details tab strip', async () => {
        const mounted = await mountRetainedBrowserForPlugin('session:details-close');
        try {
            expect(await mounted.api.executeAction('browser.automation.status', { ...mounted.request, actionKind: 'getStatus' }))
                .toMatchObject({ status: 'succeeded' });
            expect(mounted.shell.props.lifecycleState).toBe('visible');
            await act(async () => { mounted.pane.current!.closeDetails(); });
            expect(mounted.screen.findByType(BrowserShell)).toBe(mounted.shell);
            expect(mounted.subscriptions()).toBe(1);
            expect(await mounted.api.executeAction('browser.automation.status', { ...mounted.request, actionKind: 'getStatus' }))
                .toMatchObject({ status: 'succeeded' });
            await act(async () => { mounted.pane.current!.openDetailsTab(mounted.browserTab, { intent: 'pinned' }); });
            await mounted.park();
            expect(mounted.screen.findByType(BrowserShell)).toBe(mounted.shell);
            expect(mounted.screen.findByType(BrowserShell).props.browserAutomation.controlService).toBe(mounted.service);
            expect(mounted.screen.findByType(BrowserShell).props.lifecycleState).toBe('hidden');
            expect(await mounted.api.executeAction('browser.automation.press', mounted.request))
                .toMatchObject({ status: 'succeeded', resultSummary: { pressed: true } });
            expect(mounted.effects()).toBe(1);
            await mounted.show();
            expect(mounted.screen.findByType(BrowserShell)).toBe(mounted.shell);
            expect(mounted.screen.findByType(BrowserShell).props.browserAutomation.controlService).toBe(mounted.service);
            expect(mounted.screen.findByType(BrowserShell).props.lifecycleState).toBe('visible');
            expect(mounted.effects()).toBe(1);
            expect(await mounted.api.executeAction('browser.automation.press', { ...mounted.request, automationRequestId: 'rebound-press' }))
                .toMatchObject({ status: 'succeeded' });
            expect(mounted.effects()).toBe(2);
            // Close while another tab is selected: the closed Browser's binder is inactive.
            await act(async () => { mounted.pane.current!.openDetailsTab({ key: 'other', kind: 'file', title: 'Other',
                resource: { kind: 'file', path: 'other.txt' } }, { intent: 'pinned' }); });
            await mounted.screen.pressByTestIdAsync(`close-${toTestIdSafeValue(mounted.browserTab.key)}`);
            await flushHookEffects();
            expect(mounted.pane.current!.scopeState?.details.tabs.some(tab => tab.key === mounted.browserTab.key)).toBe(false);
            expect(mounted.store.getPortalSnapshot().map(entry => entry.slotId)).toEqual(['sibling-slot']);
            expect(mounted.subscriptions()).toBe(0);
            expect(mounted.siblingSubscriptions()).toBe(1);
            await expect(mounted.api.executeAction('browser.automation.press', { ...mounted.request, automationRequestId: 'closed-press' }))
                .rejects.toMatchObject({ code: 'runtime_action_disabled', diagnostics: [{ code: 'runtime_action_disabled' }] });
            expect(mounted.effects()).toBe(2);
            const siblingTab = mounted.pane.current!.scopeState!.details.tabs.find(tab => tab.kind === 'file');
            expect(siblingTab).toBeDefined();
            await mounted.screen.pressByTestIdAsync(`close-${toTestIdSafeValue(siblingTab!.key)}`);
            await flushHookEffects();
            expect(mounted.store.getPortalSnapshot()).toEqual([]);
            expect(mounted.siblingSubscriptions()).toBe(0);
        } finally { mounted.dispose(); }
    });

    it('retires a parked Browser when its Details group is removed without a binder', async () => {
        const mounted = await mountRetainedBrowserForPlugin('project:details-group-close');
        try {
            const groupId = mounted.pane.current!.scopeState!.details.focusedGroupId!;
            await mounted.park();
            expect(mounted.subscriptions()).toBe(1);
            await act(async () => { mounted.pane.current!.closeDetailsGroup!(groupId); });
            await flushHookEffects();
            expect(mounted.store.getPortalSnapshot()).toEqual([]);
            expect(mounted.subscriptions()).toBe(0);
            await expect(mounted.api.executeAction('browser.automation.press', mounted.request))
                .rejects.toMatchObject({ code: 'runtime_action_disabled', diagnostics: [{ code: 'runtime_action_disabled' }] });
            expect(mounted.effects()).toBe(0);
        } finally { mounted.dispose(); }
    });

    it('does not keep Account authority alive with a parked page', async () => {
        const mounted = await mountRetainedBrowserForPlugin();
        try {
            expect(await mounted.api.executeAction('browser.automation.status', { ...mounted.request, actionKind: 'getStatus' }))
                .toMatchObject({ status: 'succeeded' });
            await mounted.park();
            await act(async () => { retireActiveServerAccountScopeLifetime(); });
            await expect(mounted.api.executeAction('browser.automation.press', mounted.request))
                .rejects.toMatchObject({ code: 'stale_surface' });
            expect(mounted.effects()).toBe(0);
        } finally { mounted.dispose(); }
    });
});
