import * as React from 'react';
import {
    AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import {
    BrowserEventV1Schema,
    type BrowserEventV1} from '@happier-dev/protocol/browser/events/v1';
import {
    type BrowserAdapterCapabilitiesV1} from '@happier-dev/protocol/browser/adapters/v1';
import {
    type BrowserCommandV1} from '@happier-dev/protocol/browser/control/v1';
import {
    type BrowserViewTargetV1,
} from '@happier-dev/protocol/browser/target/v1';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import type { BrowserDaemonControlCommandSender } from '@/sync/domains/browser/control/machineRpc';
import { BrowserShell } from '@/components/browser/BrowserShell';
import type { BrowserToolbarOverflowItem } from '@/components/browser/toolbar/BrowserToolbarOverflowMenu';
import { BrowserPresenceCapsule } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { BrowserAutomationActionRequestV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import {
    applyBrowserControlEvent,
    createBrowserControlState,
    type BrowserControlState,
} from '@/sync/domains/browser/control';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { createDefaultRuntimeActionExecutor } from '@/sync/ops/actions/defaultRuntimeActionExecutor';
import { createRetainedPresentationSlotsStore, RetainedPresentationSlotBinder, RetainedPresentationSlotsProvider } from '@/components/ui/presentation/retainedPresentationSlots';
import { handleUiBrowserAutomationDispatchRequest } from '@/sync/domains/browser/automation/reverseDispatchHandler';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation/controlService';
import { BrowserSurfaceHost } from './BrowserSurfaceHost';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { createBrowserWorkspaceOpeningFixture } from '@/dev/testkit/fixtures/browserWorkspaceOpening';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveBrowserViewTargetOpenTab } from './openBrowserTargetInWorkspace';
import { applyLocalServicePreviewSnapshot, createLocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServicePreviewServerAccessV1Schema } from '@happier-dev/protocol/local/services/preview/nativeDirect';

installTerminalRouteCommonModuleMocks();
// Native event registration is an OS transport boundary. Node has no WebView
// callback registry; keep the real Browser subscription/open path below it.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
await initializeTerminalRouteRuntimeForTests();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let actionRequest: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response | null>) | undefined;
beforeEach(async () => {
    actionRequest = undefined;
    connection = await restoreServerAccountForTest({ serverUrl: 'https://browser-control-home.example.test', serverIdentityId: 'srv_browser_fresh',
        credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-a', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature` },
        request: async (input, init) => {
        const actionResponse = await actionRequest?.(input, init);
        if (actionResponse) return actionResponse;
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-a' }));
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { browser: { enabled: true, internal: { enabled: true }, automation: { enabled: true }, viewTargets: { enabled: true } } } }));
        return new Response('{}', { status: 404 });
    } });
});

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Preview',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

function stateFromEvents(events: readonly BrowserEventV1[]): BrowserControlState {
    return events.reduce(
        (nextState, event) => applyBrowserControlEvent(nextState, event),
        createBrowserControlState(),
    );
}

function openViewState(input: Readonly<{
    browserSessionId: string;
    viewId: string;
    target: BrowserViewTargetV1;
    capabilities: BrowserAdapterCapabilitiesV1;
    currentUrl: string;
}>): BrowserControlState {
    return stateFromEvents([{
        kind: 'sessionCreated',
        eventId: 'event_session',
        browserSessionId: input.browserSessionId,
        profileId: 'profile_1',
        occurredAt: 1_000,
    }, {
        kind: 'viewOpened',
        eventId: 'event_view',
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        target: input.target,
        platform: 'web',
        currentUrl: input.currentUrl,
        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: input.capabilities,
        occurredAt: 1_001,
    }, {
        kind: 'viewFocused',
        eventId: 'event_focus',
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        occurredAt: 1_002,
    }]);
}

describe('BrowserSurfaceHost runtime control registration', () => {
    it.each(['running', 'external-navigation', 'stopped', 'failed', 'revoked', 'admission-denied'] as const)(
        'resolves an ended preview external-browser escape from current Service and admission facts (%s)', async condition => {
        // Replace only this web browser's OS boundary; native cases retain their real Tauri adapter.
        const systemOpen = vi.fn();
        vi.stubGlobal('open', systemOpen);
        let admissionDenied = false;
        let admissions = 0;
        const accessUrl = 'https://viewer.example.test/start?previewToken=fresh-external-admission';
        actionRequest = async input => {
            if (!new URL(String(input)).pathname.endsWith('/access')) return null;
            admissions += 1;
            return admissionDenied ? Response.json({ error: 'preview_access_denied' }, { status: 403 })
                : Response.json(LocalServicePreviewServerAccessV1Schema.parse({ v: 1, kind: 'server_preview',
                    previewId: target.targetId, machineId: target.machineId, accessUrl, expiresAt: 2_000_000_000_000 }));
        };
        const service = LocalServiceLaunchTargetV1Schema.parse({ id: 'lumen-service', machineId: target.machineId,
            source: 'managed_service', title: 'Lumen', confidence: 'high', state: 'available',
            serviceState: condition === 'stopped' || condition === 'failed' ? condition : 'running', actions: ['open'], browserTarget: target });
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000, refreshState: 'idle', diagnostics: [], previews: condition === 'revoked' ? [] : [{
                previewId: target.targetId, accessUrl, expiresAt: null, diagnostics: [],
                resource: { previewId: target.targetId, machineId: target.machineId, sessionId: target.sessionId,
                    owner: { kind: 'session', id: target.sessionId }, browserTarget: target,
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/start', search: '' }, display: target.display, originMode: 'host' },
            }],
        });
        const browserSessionId = 'ended-browser';
        const viewId = 'ended-view';
        const opened = openViewState({ browserSessionId, viewId, target, currentUrl: 'http://127.0.0.1:42123/docs?tab=2&previewToken=retired-admission#heading',
            capabilities: buildBrowserAdapterCapabilities({ adapterKind: 'localPreview',
                supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['webIframe'] }) });
        const initialBrowserState = { ...opened, viewsById: { ...opened.viewsById,
            [viewId]: { ...opened.viewsById[viewId]!, loadingState: 'failed' as const, lastError: 'preview_ended' } } };
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId={browserSessionId} platform="web"
            initialBrowserState={initialBrowserState} localServicePreviewState={previewState} localServiceTargets={[service]}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                contextEnabled: false, automationEnabled: false, recordingEnabled: false }} />);
        await flushHookEffects();
        if (condition === 'external-navigation') {
            // An in-page navigation reports its document without retargeting the Service view.
            await act(async () => screen.findByType(BrowserShell).props.onViewLifecycle({ browserSessionId, viewId }, {
                kind: 'navigationStateChanged', url: 'https://example.com/help?tab=2#heading', loading: false,
                canGoBack: true, canGoForward: false,
            }));
            expect(screen.findByType(BrowserShell).props.state.viewsById[viewId].target).toEqual(target);
        }
        const beforeAction = admissions;
        admissionDenied = condition === 'admission-denied';
        let result: unknown;
        await act(async () => { result = await screen.findByType(BrowserShell).props.onOpenInSystemBrowser({ browserSessionId, viewId }); });
        if (condition === 'running' || condition === 'external-navigation') {
            expect(result).toMatchObject({ ok: true, result: { status: 'dispatched' } });
            const openedUrl = new URL(systemOpen.mock.calls[0]![0]);
            expect(openedUrl.origin).toBe(condition === 'running' ? 'https://viewer.example.test' : 'https://example.com');
            expect(openedUrl.pathname + openedUrl.hash).toBe(condition === 'running' ? '/docs#heading' : '/help#heading');
            expect(openedUrl.searchParams.get('tab')).toBe('2');
            expect(openedUrl.searchParams.get('previewToken')).toBe(condition === 'running' ? 'fresh-external-admission' : null);
            expect(admissions - beforeAction).toBe(1);
            expect(screen.findByType(BrowserShell).props.openExternalAvailability).toEqual({ enabled: true });
        } else {
            const reasonCode = condition === 'stopped' ? 'service_stopped' : condition === 'failed' ? 'service_failed' : 'preview_ended';
            expect(result).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled',
                error: expect.stringContaining(reasonCode) });
            expect(systemOpen).not.toHaveBeenCalled();
            expect(admissions - beforeAction).toBe(condition === 'admission-denied' ? 1 : 0);
            if (condition !== 'admission-denied') {
                // The stopped refusal names its Service, in the ended card's own sentence.
                expect(screen.findByType(BrowserShell).props.openExternalAvailability)
                    .toEqual(condition === 'stopped' ? { enabled: false, reasonCode, serviceName: 'Lumen' } : { enabled: false, reasonCode });
                const { BrowserToolbarOverflowMenu } = await import('../toolbar/BrowserToolbarOverflowMenu');
                const items: readonly BrowserToolbarOverflowItem[] = screen.findByType(BrowserToolbarOverflowMenu).props.items;
                const item = items.find(item => item.id === 'open-in-your-browser');
                expect(item).toMatchObject({ disabled: true, disabledReason: expect.any(String) });
                expect(item?.disabledReason).not.toBe('');
                if (condition === 'stopped') expect(item?.disabledReason).toContain('browserShell.unavailable.previewEndedServiceStopped');
            }
        }
        await screen.unmount();
    });

    it('navigates a displayed Service address through the admitted preview without retargeting', async () => {
        const { LocalServicePreviewServerAccessV1Schema } = await import('@happier-dev/protocol/local/services/preview/nativeDirect');
        const viewerOrigin = 'https://viewer.example.test';
        let admissions = 0;
        actionRequest = async (input) => {
            if (!new URL(String(input)).pathname.endsWith('/access')) return null;
            admissions += 1;
            return Response.json(LocalServicePreviewServerAccessV1Schema.parse({ v: 1, kind: 'server_preview',
                previewId: target.targetId, machineId: target.machineId, accessUrl: `${viewerOrigin}/a`, expiresAt: 2_000_000_000_000 }));
        };
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000, refreshState: 'idle', diagnostics: [], previews: [{
                previewId: target.targetId, accessUrl: `${viewerOrigin}/a`, expiresAt: null, diagnostics: [],
                resource: { previewId: target.targetId, machineId: target.machineId, sessionId: target.sessionId,
                    owner: { kind: 'session', id: target.sessionId }, browserTarget: target,
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/a', search: '' }, display: target.display, originMode: 'host' },
            }],
        });
        const browserSessionId = 'admitted-browser';
        const viewId = 'admitted-view';
        const initialBrowserState = openViewState({ browserSessionId, viewId, target, currentUrl: `${viewerOrigin}/a`,
            capabilities: buildBrowserAdapterCapabilities({ adapterKind: 'localPreview',
                supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['webIframe'] }) });
        const onViewTargetChange = vi.fn();
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId={browserSessionId} platform="web"
            initialBrowserState={initialBrowserState} localServicePreviewState={previewState}
            onViewTargetChange={onViewTargetChange} testID="admitted-preview"
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                contextEnabled: false, automationEnabled: false, recordingEnabled: false }} />);
        await vi.waitFor(() => expect(screen.findByType('iframe').props.src).toBe(`${viewerOrigin}/a`));
        await act(async () => { screen.findByType('iframe').props.onLoad(); });
        await act(async () => { screen.changeTextByTestId('admitted-preview-address', 'http://localhost:5173/b?tab=2#heading'); });
        await act(async () => { screen.findByTestId('admitted-preview-address')?.props.onSubmitEditing?.(); });
        await vi.waitFor(() => expect(screen.findByType('iframe').props.src).toBe(`${viewerOrigin}/b?tab=2#heading`));
        expect(screen.findByType(BrowserShell).props.state.viewsById[viewId]).toMatchObject({
            target, engineKind: 'webIframe', pendingUrl: 'http://localhost:5173/b?tab=2#heading',
        });
        expect(onViewTargetChange).not.toHaveBeenCalled();
        expect(admissions).toBe(1);
        await screen.unmount();
    });

    it('reopens a Service at its address in the retained view after cross-origin navigation', async () => {
        const accessUrl = 'https://service.preview.test/';
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000, refreshState: 'idle', diagnostics: [], previews: [{
                previewId: target.targetId, accessUrl, expiresAt: null, diagnostics: [],
                resource: { previewId: target.targetId, machineId: 'machine_1', sessionId: 'session_1',
                    owner: { kind: 'session', id: 'session_1' }, browserTarget: target,
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' }, display: { title: 'Preview', addressLabel: 'localhost:5173' },
                    originMode: 'host' },
            }],
        });
        const resolved = resolveBrowserViewTargetOpenTab({ scope: 'sessionDetails', platform: 'web',
            localServicePreviewState: previewState }, target);
        const initialBrowserState = openViewState({ ...resolved, target, currentUrl: 'https://example.com/elsewhere',
            capabilities: buildBrowserAdapterCapabilities({ adapterKind: 'localPreview',
                supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['webIframe'] }) });
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId={resolved.browserSessionId}
            platform="web" initialBrowserState={initialBrowserState}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                contextEnabled: false, automationEnabled: false, recordingEnabled: false }} />);
        await flushHookEffects();
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime?.isCurrent()).toBe(true);
        // Two connected Homes may retain the same Home-local Session/target ids.
        // The most recently mounted controller must not capture another Home's open.
        const foreign = await renderScreen(<BrowserSurfaceHost browserSessionId={resolved.browserSessionId}
            platform="web" initialBrowserState={initialBrowserState}
            pluginAccountLifetime={{ scope: { serverId: 'other-home', accountId: 'other-account' },
                isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                contextEnabled: false, automationEnabled: false, recordingEnabled: false }} />);
        await flushHookEffects();
        const tabs: unknown[] = [];
        const workspace = createBrowserWorkspaceOpeningFixture({ scope: 'sessionDetails', platform: 'web',
            accountLifetime, localServicePreviewState: previewState, openDetailsTab: tab => { tabs.push(tab); } });
        try {
            await act(async () => expect(await workspace.open(target)).toMatchObject({ ok: true,
                result: { status: 'dispatched', outcome: 'workspaceTab' } }));
            const state = screen.findByType(BrowserShell).props.state;
            expect(state.viewsById[resolved.viewId]).toMatchObject({ target, currentUrl: accessUrl, pendingUrl: null });
            expect(Object.keys(state.viewsById)).toEqual([resolved.viewId]);
            expect(foreign.findByType(BrowserShell).props.state.viewsById[resolved.viewId].currentUrl)
                .toBe('https://example.com/elsewhere');
            expect(tabs).toHaveLength(1);
        } finally { workspace.dispose(); await foreign.unmount(); await screen.unmount(); }
    });

    it('opens native DevTools and reloads through the real mounted control owner without automation', async () => {
        const browserSessionId = 'native-browser';
        const viewId = 'native-view';
        const availability: DesktopWebViewNativeAvailability = {
            available: true, platform: 'macos', primitive: 'macosNsViewWebKit', renderEngine: 'desktopWebView',
            producer: 'tauriWryNativeChildView', privilegedIpc: false, disabledReasons: [],
            supports: { navigation: true, goBackForward: true, reload: true, stop: true,
                pageInfoDiagnostics: true, nativeDevtools: true, capture: true, recording: false, automation: true },
        };
        // Substitute only the desktop OS transport; keep the SurfaceHost, Action front door,
        // mounted registration, capability decision and native bridge normalization real.
        const secureStorage = new Map<string, string>();
        const nativeInvoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            // Recognizing a desktop host also selects native credential custody. Model
            // that OS boundary so the real credential owner can migrate and verify it.
            if (command === 'desktop_secure_storage_read') {
                return typeof args?.key === 'string' ? secureStorage.get(args.key) ?? null : null;
            }
            if (command === 'desktop_secure_storage_write') {
                if (typeof args?.key !== 'string' || typeof args.value !== 'string') {
                    throw new Error('Invalid native secure-storage write');
                }
                secureStorage.set(args.key, args.value);
                return null;
            }
            if (command === 'desktop_secure_storage_remove') {
                if (typeof args?.key === 'string') secureStorage.delete(args.key);
                return null;
            }
            return command === 'desktop_browser_get_availability' ? availability : { ok: true, availability };
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: nativeInvoke });
        const pageUrl = new URL('/help/example-domains', 'https:' + '//example.com').href;
        const pageTarget = { kind: 'externalUrl', targetId: 'native-page', url: pageUrl } satisfies BrowserViewTargetV1;
        const initial = openViewState({ browserSessionId, viewId, target: pageTarget, currentUrl: pageUrl,
            capabilities: buildBrowserAdapterCapabilities({ adapterKind: 'externalUrl',
                supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['desktopWebView'],
                desktopWebViewSupport: availability.supports }) });
        const initialBrowserState = { ...initial, viewsById: { ...initial.viewsById,
            [viewId]: { ...initial.viewsById[viewId]!, adapterKind: 'externalUrl' as const,
                engineKind: 'desktopWebView' as const, platform: 'desktop' as const } } };
        // The Details renderer supplies a slot id but no measuredRect. The retained
        // presentation owner already has the real placement; native visibility must use it.
        const geometry = { x: 32, y: 120, width: 800, height: 600 };
        const store = createRetainedPresentationSlotsStore();
        let contentCommits = 0;
        const countContentCommit = () => { contentCommits += 1; };
        const render = (visible: boolean, placement: Readonly<{
            slotId?: string;
            measuredRect?: typeof geometry | null;
            clip?: typeof geometry;
        }> = {}) => <RetainedPresentationSlotsProvider store={store}>
            <RetainedPresentationSlotBinder slotId="native-slot" enabled visible={visible} windowGeometry={geometry}
                windowClipGeometry={placement.clip}>
                <React.Profiler id="native-content" onRender={countContentCommit}><BrowserSurfaceHost browserSessionId={browserSessionId} platform="desktop"
                    presentationSlotId={placement.slotId ?? 'native-slot'} measuredRect={placement.measuredRect}
                    keepAliveAboveRouter={false} active
                    initialBrowserState={initialBrowserState} desktopWebViewAvailability={availability}
                    pluginBrowserActionContext={{ machineId: 'machine_1', sessionId: 'session_1' }}
                    policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                        contextEnabled: false, automationEnabled: false, recordingEnabled: false }} /></React.Profiler>
            </RetainedPresentationSlotBinder>
        </RetainedPresentationSlotsProvider>;
        const screen = await renderScreen(render(true), { createNodeMock: () => ({
            getBoundingClientRect: () => geometry,
            measureInWindow: (publish: (x: number, y: number, width: number, height: number) => void) =>
                publish(geometry.x, geometry.y, geometry.width, geometry.height),
        }) });
        await flushHookEffects();
        const lastBounds = () => nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_browser_set_bounds').at(-1)?.[1];
        expect(screen.findByType(BrowserShell).props.lifecycleState).toBe('visible');
        await vi.waitFor(() => expect(lastBounds()).toMatchObject({ request: { visible: true } }));
        await screen.update(render(false));
        expect(screen.findByType(BrowserShell).props.lifecycleState).toBe('hidden');
        await vi.waitFor(() => expect(lastBounds()).toMatchObject({ request: { visible: false } }));
        await screen.update(render(true));
        await vi.waitFor(() => expect(lastBounds()).toMatchObject({ request: { visible: true } }));
        // A different retained body arriving must not re-publish this slot's
        // unchanged clipped geometry and wake its whole Browser subtree.
        await screen.update(render(true, { clip: geometry }));
        contentCommits = 0;
        await act(async () => {
            store.upsertPortalEntry({ slotId: 'other-slot', node: React.createElement('View'), geometry, visible: true });
        });
        expect(contentCommits).toBe(0);
        await act(async () => { store.removePortalEntry('other-slot'); });
        await screen.update(render(true, { measuredRect: null }));
        await vi.waitFor(() => expect(lastBounds()).toMatchObject({ request: { visible: false } }));
        await screen.update(render(true, { slotId: 'different-slot' }));
        await vi.waitFor(() => expect(lastBounds()).toMatchObject({ request: { visible: false } }));
        await screen.update(render(true, { clip: { x: 0, y: 0, width: 10, height: 10 } }));
        await vi.waitFor(() => expect(lastBounds()).toMatchObject({ request: { visible: false } }));
        await screen.update(render(true));
        await vi.waitFor(() => expect(lastBounds()).toMatchObject({ request: { visible: true } }));
        expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_browser_open_view')).toHaveLength(1);
        const view = { browserSessionId, viewId };
        let uiResult: unknown;
        await act(async () => { uiResult = await screen.findByType(BrowserShell).props.onOpenDevtools(view); });
        expect(uiResult, JSON.stringify(uiResult)).toMatchObject({ ok: true, result: { status: 'dispatched' } });
        expect(await handleUiBrowserAutomationDispatchRequest({ v: 1, sessionId: 'session_1',
            actionId: 'browser.view.openDevtools', input: { ...view, commandId: 'agent-devtools' },
            authority: 'account_automation' }, { ...view, sessionId: 'session_1' }))
            .toMatchObject({ status: 'dispatched', commandId: 'agent-devtools' });
        expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_browser_open_devtools')).toHaveLength(2);
        let externalResult: unknown;
        await act(async () => {
            externalResult = await screen.findByType(BrowserShell).props.onOpenInSystemBrowser(view);
        });
        expect(externalResult).toMatchObject({ ok: true, result: { status: 'dispatched' } });
        expect(nativeInvoke.mock.calls.filter(([command]) => command === 'plugin:opener|open_url'))
            .toEqual([['plugin:opener|open_url', { url: pageUrl }]]);
        let reloaded: unknown;
        await act(async () => {
            reloaded = await handleUiBrowserAutomationDispatchRequest({ v: 1, sessionId: 'session_1',
                actionId: 'browser.reload', input: { ...view, kind: 'reload', commandId: 'approved-reload' },
                authority: 'account_automation' }, { ...view, sessionId: 'session_1' });
        });
        expect(reloaded).toMatchObject({ status: 'dispatched', commandId: 'approved-reload' });
        await vi.waitFor(() => expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_browser_dispatch_navigation'))
            .toEqual([['desktop_browser_dispatch_navigation', expect.objectContaining({ request: expect.objectContaining({ ...view, kind: 'reload' }) })]]));
        expect(await handleUiBrowserAutomationDispatchRequest({ v: 1, sessionId: 'other-session',
            actionId: 'browser.reload', input: { ...view, kind: 'reload', commandId: 'wrong-session' } },
            { ...view, sessionId: 'session_1' })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        await screen.unmount();
        expect(await handleUiBrowserAutomationDispatchRequest({ v: 1, sessionId: 'session_1',
            actionId: 'browser.reload', input: { ...view, kind: 'reload', commandId: 'retired' } },
            { ...view, sessionId: 'session_1' })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_browser_dispatch_navigation')).toHaveLength(1);
    });

    it('keeps the exact Action controller with a retained page when its presentation leaves, until explicit close', async () => {
        const browserSessionId = 'retained-browser';
        const viewId = 'retained-view';
        const view = { browserSessionId, viewId, sessionId: 'session_1' };
        const store = createRetainedPresentationSlotsStore();
        const initialBrowserState = openViewState({ browserSessionId, viewId, target,
            currentUrl: 'about:blank', capabilities: buildBrowserAdapterCapabilities({
                adapterKind: 'localPreview', supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['webIframe'],
            }) });
        const render = (visible: boolean) => <RetainedPresentationSlotsProvider store={store}>
            {visible ? <BrowserSurfaceHost browserSessionId={browserSessionId} platform="web"
                initialBrowserState={initialBrowserState} presentationSlotId="retained-slot" keepAliveAboveRouter
                pluginBrowserActionContext={{ machineId: 'machine_1', sessionId: view.sessionId }}
                policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                    contextEnabled: false, automationEnabled: true, recordingEnabled: false }} /> : null}
        </RetainedPresentationSlotsProvider>;
        const screen = await renderScreen(render(true));
        await flushHookEffects();
        const shell = screen.findByType(BrowserShell);
        const service: BrowserAutomationControlService | undefined = shell.props.browserAutomation?.controlService;
        if (!service) throw new Error('Expected mounted automation controller');
        let effects = 0;
        // The injected page is the system boundary. Keep retention, Action dispatch,
        // the exact-view registry and the controller real.
        service.registerOwner({ ownerId: 'page', browserSessionId, viewId, navigationGeneration: 0,
            authority: 'uiLocal', adapterKind: 'localPreview', fidelity: 'injectedPage', trustedInput: false,
            supportedActions: ['press'], executeAction: async () => { effects += 1; return { status: 'succeeded' }; } });
        const request = { v: 1, browserSessionId, viewId, automationRequestId: 'retained-press', navigationGeneration: 0,
            requestedBy: 'agent', requesterRef: { kind: 'agent', id: view.sessionId }, timeoutMs: 1000,
            actionKind: 'press', payload: { locator: { kind: 'css', value: '#counter' }, key: 'Enter' } } as const;
        const invoke = (actionId: 'browser.automation.status' | 'browser.automation.press') =>
            handleUiBrowserAutomationDispatchRequest({ v: 1, sessionId: view.sessionId, authority: 'account_automation',
                actionId, input: actionId === 'browser.automation.status' ? { ...request, actionKind: 'getStatus' } : request }, view);
        expect(await invoke('browser.automation.status')).toMatchObject({ status: 'succeeded' });
        await screen.update(render(false));
        await flushHookEffects();
        expect(screen.findByType(BrowserShell)).toBe(shell);
        expect(store.getPortalSnapshot()).toMatchObject([{ visible: false }]);
        expect(await invoke('browser.automation.press')).toMatchObject({ status: 'succeeded' });
        expect(effects).toBe(1);
        await act(async () => { store.removePortalEntry('retained-slot'); });
        expect(await invoke('browser.automation.press')).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(effects).toBe(1);
    });

    it('observes the current daemon page through the captured Account Action transport and waits for authoritative recovery', async () => {
        const requests: unknown[] = [];
        actionRequest = async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/machines/read-batch') {
                expect(MachineReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body))))
                    .toEqual({ machineIds: ['machine-fresh'] });
                return Response.json(MachineReadBatchResponseV1Schema.parse({ results: [{ machineId: 'machine-fresh', status: 'found',
                    machine: { id: 'machine-fresh', managedMachineRef: null, kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
                        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
                        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                        access: { custodian: { accountId: 'account-a', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } },
                }] }));
            }
            if (url.pathname !== '/v1/actions/browser.automation.snapshot') return null;
            expect(url.origin).toBe('https://browser-control-home.example.test');
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const request = BrowserAutomationActionRequestV1Schema.parse(envelope.input);
            requests.push({ target: envelope.target, request });
            return Response.json({ v: 1, actionId: 'browser.automation.snapshot', requestId: envelope.requestId,
                execution: { ok: true, result: { v: 1, automationRequestId: request.automationRequestId, status: 'succeeded',
                    adapterKind: 'chromiumSidecar', fidelity: 'cdp', trustedInput: true, durationMs: 0,
                    navigationGenerationBefore: 7, navigationGenerationAfter: 7, controlEpochBefore: 3, controlEpochAfter: 3 } } });
        };
        const local = openViewState({ browserSessionId: 'browser_fresh', viewId: 'view_fresh', target,
            currentUrl: 'https://preview.happier.test/', capabilities: buildBrowserAdapterCapabilities({
                adapterKind: 'chromiumSidecar', supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['desktopWebView'],
            }) });
        const current = { ...local.viewsById.view_fresh!, adapterKind: 'chromiumSidecar' as const, engineKind: 'desktopWebView' as const,
            navigationGeneration: 7, automationController: { browserSessionId: 'browser_fresh', viewId: 'view_fresh',
                controller: 'human' as const, controlEpoch: 3, uncertain: true } };
        let publish: ((event: BrowserEventV1) => void) | undefined;
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_fresh" platform="desktop"
            initialBrowserState={{ ...local, viewsById: { view_fresh: current } }}
            pluginBrowserActionContext={{ machineId: 'machine-fresh', sessionId: 'session-fresh' }}
            subscribeBrowserEvents={listener => { publish = listener; return () => { publish = undefined; }; }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                contextEnabled: false, automationEnabled: true, recordingEnabled: false }} testID="browser-fresh" />);
        const checkAgain = screen.findByType(BrowserShell).props.onCheckAgain;
        let observation: unknown;
        await act(async () => { observation = await checkAgain({ browserSessionId: 'browser_fresh', viewId: 'view_fresh' }); });
        expect(observation, JSON.stringify(observation)).toMatchObject({ ok: true, result: { status: 'succeeded' } });
        expect(requests).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'machine-fresh' },
            request: expect.objectContaining({ browserSessionId: 'browser_fresh', viewId: 'view_fresh', navigationGeneration: 7,
                actionKind: 'snapshot', requestedBy: 'user' }) })]);
        expect(screen.findByType(BrowserPresenceCapsule).props.presence).toMatchObject({ kind: 'human', interruptedCompletion: 'unknown' });
        await act(async () => publish?.({ kind: 'controllerChanged', eventId: 'observed', occurredAt: 1003,
            browserSessionId: 'browser_fresh', viewId: 'view_fresh', navigationGeneration: 7,
            state: { ...current.automationController, uncertain: false } }));
        expect(screen.findByType(BrowserPresenceCapsule).props.presence).toMatchObject({ kind: 'human', interruptedCompletion: null });
        await screen.unmount();
        expect(await checkAgain({ browserSessionId: 'browser_fresh', viewId: 'view_fresh' }))
            .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(requests).toHaveLength(1);
    });
    it('refuses a fresh observation of a disappeared page without replaying a command', async () => {
        const initialBrowserState = openViewState({ browserSessionId: 'browser_fresh', viewId: 'view_fresh', target,
            currentUrl: 'https://preview.happier.test/', capabilities: buildBrowserAdapterCapabilities({
                adapterKind: 'localPreview', supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['webIframe'],
            }) });
        const sendDaemonCommand = vi.fn<BrowserDaemonControlCommandSender>();
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_fresh" platform="web"
            initialBrowserState={initialBrowserState} sendDaemonCommand={sendDaemonCommand}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                contextEnabled: false, automationEnabled: true, recordingEnabled: false }} testID="browser-fresh" />);
        const shell = screen.findByType(BrowserShell);
        let result: unknown;
        await act(async () => { result = await shell.props.onCheckAgain({ browserSessionId: 'browser_fresh', viewId: 'gone' }); });
        expect(result).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(sendDaemonCommand).not.toHaveBeenCalled();
        expect(screen.findByType(BrowserShell).props.state).toEqual(initialBrowserState);
    });
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        clearBrowserRuntimeControlRegistryForTests();
        vi.unstubAllGlobals();
    });

    it('registers its control adapter so browser.navigate can execute through the default runtime bridge', async () => {
        const browserSessionId = 'browser_session_surface';
        const viewId = 'view_surface';
        const initialBrowserState = openViewState({
            browserSessionId,
            viewId,
            target,
            currentUrl: 'https://preview.happier.test/',
            capabilities: {
                ...buildBrowserAdapterCapabilities({
                    adapterKind: 'localPreview',
                    supportedTargetKinds: ['localServicePreview'],
                    supportedRenderEngines: ['webIframe'],
                }),
                navigation: {
                    canNavigate: true,
                    canGoBack: false,
                    canGoForward: false,
                    canReload: true,
                    canStop: true,
                },
            },
        });
        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId={browserSessionId}
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                    automationEnabled: false,
                    recordingEnabled: false,
                }}
                testID="browser-surface"
            />,
        );
        await flushHookEffects();

        const execute = createDefaultRuntimeActionExecutor();
        let result: unknown;
        const command = {
            kind: 'navigate',
            commandId: 'command_surface_navigate',
            browserSessionId,
            viewId,
            url: 'https://preview.happier.test/surface',
        } satisfies BrowserCommandV1;
        await act(async () => {
            result = await execute({
                actionId: 'browser.navigate',
                input: command,
                context: {},
            });
        });
        await flushHookEffects();

        expect(result).toMatchObject({
            v: 1,
            commandId: 'command_surface_navigate',
            status: 'dispatched',
            adapterKind: 'localPreview',
            events: [],
        });
        const shell = screen.findByType(BrowserShell);
        expect(shell?.props.state.viewsById[viewId]?.pendingUrl).toBe('https://preview.happier.test/surface');
        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/surface');
    });

    it('routes daemon navigation and retains Close when unrelated Browser catalogs fail', async () => {
        const browserSessionId = 'browser_session_sidecar';
        const viewId = 'view_sidecar';
        const externalTarget = {
            kind: 'externalUrl',
            targetId: 'external_1',
            url: 'https://browser.example.test/start',
            display: { title: 'Browser', addressLabel: 'browser.example.test' },
        } satisfies BrowserViewTargetV1;
        const sidecarCapabilities = {
            ...buildBrowserAdapterCapabilities({
                adapterKind: 'chromiumSidecar',
                supportedTargetKinds: ['externalUrl'],
                supportedRenderEngines: ['desktopWebView'],
            }),
            navigation: {
                canNavigate: true,
                canGoBack: true,
                canGoForward: true,
                canReload: true,
                canStop: true,
            },
        } satisfies BrowserAdapterCapabilitiesV1;
        const initialBrowserState = stateFromEvents([{
            kind: 'sessionCreated',
            eventId: 'event_session',
            browserSessionId,
            profileId: 'profile_1',
            occurredAt: 1_000,
        }, {
            kind: 'viewOpened',
            eventId: 'event_view',
            browserSessionId,
            viewId,
            target: externalTarget,
            platform: 'desktop',
            currentUrl: 'https://browser.example.test/start',
            adapterKind: 'chromiumSidecar',
            engineKind: 'desktopWebView',
            adapterCapabilities: sidecarCapabilities,
            occurredAt: 1_001,
        }, {
            kind: 'viewFocused',
            eventId: 'event_focus',
            browserSessionId,
            viewId,
            occurredAt: 1_002,
        }]);

        const daemonReply = createDeferred<void>();
        const sendDaemonCommand = vi.fn<BrowserDaemonControlCommandSender>(async (command, onEvents) => {
            // The real sender awaits its daemon RPC before publishing response
            // events; hold that external reply until local dispatch has settled.
            await daemonReply.promise;
            const events = [BrowserEventV1Schema.parse(command.kind === 'closeView'
                ? { kind: 'viewClosed', eventId: 'event_closed', browserSessionId, viewId, occurredAt: 1_004 }
                : { kind: 'navigationCommitted', eventId: 'event_committed', browserSessionId, viewId,
                    currentUrl: command.kind === 'navigate' ? command.url : '', occurredAt: 1_003 })];
            onEvents?.(events);
            return { ok: true, result: { v: 1, commandId: command.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events } };
        });
        const renderHost = (catalogFailed: boolean) => (
            <BrowserSurfaceHost
                browserSessionId={browserSessionId}
                platform="desktop"
                initialBrowserState={initialBrowserState}
                sendDaemonCommand={sendDaemonCommand}
                launchpadRefreshStatus={catalogFailed ? 'error' : 'idle'}
                launchpadRefreshError={catalogFailed ? 'local_service_preview_refresh_failed' : null}
                pluginUiInteractionEnabled={!catalogFailed}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                    automationEnabled: false,
                    recordingEnabled: false,
                }}
                testID="browser-surface"
            />
        );
        const screen = await renderScreen(renderHost(false));
        await flushHookEffects();

        const execute = createDefaultRuntimeActionExecutor();
        const command = {
            kind: 'navigate',
            commandId: 'command_sidecar_navigate',
            browserSessionId,
            viewId,
            url: 'https://browser.example.test/next',
        } satisfies BrowserCommandV1;
        let result: unknown;
        await act(async () => {
            const dispatched = execute({ actionId: 'browser.navigate', input: command, context: {} });
            daemonReply.resolve();
            result = await dispatched;
        });
        await flushHookEffects();

        expect(result).toMatchObject({
            v: 1,
            commandId: 'command_sidecar_navigate',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
            events: [expect.objectContaining({ kind: 'navigationCommitted' })],
        });
        expect(result).not.toMatchObject({ error: 'runtime_action_disabled:browser:browser_control_route_unavailable' });
        expect(sendDaemonCommand).toHaveBeenCalledWith(command, expect.any(Function));
        await act(async () => {
            daemonReply.resolve();
            await sendDaemonCommand.mock.results[0]?.value;
        });
        await flushHookEffects();
        expect(screen.findByType(BrowserShell).props.state.viewsById[viewId]).toMatchObject({
            currentUrl: 'https://browser.example.test/next', pendingUrl: null,
        });
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('browser.example.test/next');

        await screen.update(renderHost(true));
        expect(screen.findByType(BrowserShell).props.state.viewsById[viewId]).toMatchObject({
            currentUrl: 'https://browser.example.test/next',
        });
        const close = { kind: 'closeView', commandId: 'command_sidecar_close', browserSessionId, viewId } satisfies BrowserCommandV1;
        let closed: unknown;
        await act(async () => { closed = await execute({ actionId: 'browser.view.close', input: close, context: {} }); });
        await flushHookEffects();
        expect(closed).toMatchObject({ status: 'dispatched', events: [expect.objectContaining({ kind: 'viewClosed' })] });
        expect(screen.findByType(BrowserShell).props.state.viewsById[viewId]).toBeUndefined();
    });
});
