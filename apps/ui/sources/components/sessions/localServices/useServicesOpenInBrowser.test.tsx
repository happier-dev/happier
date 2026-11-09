import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionViewerSourceAccountScopeProvider } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { OpenBrowserTargetScope } from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { useOpenBrowserTargetInWorkspace } from '@/components/browser/surfaces/useOpenBrowserTargetInWorkspace';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';

import { useServicesOpenInBrowser } from './useServicesOpenInBrowser';
import { readLocalServiceActionOutcome } from './localServiceActionOutcome';
import { SessionServicesSurfaceScreen } from '@/components/workspaceCockpit/session/SessionServicesSurfaceScreen';
import { buildLocalServiceInventoryState } from '@/dev/testkit';
import { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } from '@/sync/domains/local/services/launch';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { PanePresentationProvider } from '@/components/appShell/panes/panePresentation';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { LocalServicesSurfaceHost } from './LocalServicesSurfaceHost';
import { DetectedLocalServicesPane } from './DetectedLocalServicesPane';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { useRegisterSessionPaneDriver } from '@/components/sessions/panes/useRegisterSessionPaneDriver';

const machineRpcMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpcMock }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@react-navigation/native', async importOriginal => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(),
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
}));

const openableTarget: LocalServiceLaunchTargetV1 = {
    id: 'preview:open-feed',
    source: 'registered_preview',
    machineId: 'machine-a',
    sessionId: 'session-a',
    title: 'Open feed preview',
    subtitle: 'localhost:5173',
    confidence: 'high',
    state: 'available',
    actions: [],
    browserTarget: {
        kind: 'localServicePreview',
        targetId: 'preview-open',
        sessionId: 'session-a',
        machineId: 'machine-a',
    },
};

const unmappableTarget: LocalServiceLaunchTargetV1 = {
    ...openableTarget,
    id: 'preview:unmappable',
    machineId: '',
    browserTarget: undefined,
};

// Preview access remains valid independently of Services membership. The phone
// row journeys need a real observed Service carrying that access, not a retained
// registration promoted to a running row.
const liveServiceTarget: LocalServiceLaunchTargetV1 = {
    ...openableTarget,
    id: 'inventory:open-feed',
    source: 'inventory_entry',
    sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'open-feed' },
};

type Captured = {
    open: ReturnType<typeof useServicesOpenInBrowser> | null;
};

function HookProbe(props: Readonly<{
    scopeId: string;
    captured: Captured;
    scope?: OpenBrowserTargetScope;
    onAfterOpen?: () => void;
    onAfterDetailsOpen?: () => void;
    phoneServices?: boolean;
}>) {
    useRegisterSessionPaneDriver('session-a', fixture!.home.id, {
        machineId: null, serverId: fixture!.home.id, platform: 'web', accountLifetime: account!.accountLifetime,
        pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
    }, { scopeId: props.scopeId, registerDriver: (props.scope ?? 'sessionDetails') === 'sessionDetails' });
    const pane = useAppPaneScope(props.scopeId);
    const open = useServicesOpenInBrowser({
        scopeId: props.scopeId,
        scope: props.scope ?? 'sessionDetails',
        // The transport is supplied at the machine RPC boundary; keep the real preview store.
        machineId: null,
        serverId: fixture!.home.id,
        sessionId: 'session-a',
        onAfterOpen: props.onAfterOpen,
        onAfterDetailsOpen: props.onAfterDetailsOpen,
    });
    props.captured.open = open ?? null;

    return React.createElement('HookProbe', {
        detailsTabKinds: (pane.scopeState?.details.tabs ?? []).map((tab) => tab.kind),
    }, props.phoneServices ? <SessionServicesSurfaceScreen
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
            v: 1, machineId: 'machine-a', sessionId: 'session-a', updatedAt: 1_000, targets: [liveServiceTarget],
        })}
        onOpenServiceInBrowser={open}
    /> : null);
}

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let account: Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext')['captureLazyActionAccountContext']>> | undefined;
let actionPolicy: Readonly<{ enabled?: boolean; approvalRequiredSurfaces?: readonly ['ui'] }> = {};

async function renderServicesHook(props: Parameters<typeof HookProbe>[0]) {
    const accountLifetime: ServerAccountScopeLifetime = account!.accountLifetime;
    return renderScreen(<SessionViewerSourceAccountScopeProvider accountLifetime={accountLifetime}>
        <AppPaneProvider><HookProbe {...props} /></AppPaneProvider>
    </SessionViewerSourceAccountScopeProvider>);
}

function RetainedBrowserOwner(props: Readonly<{ scopeId: string; platform?: 'web' | 'desktop'; desktopWebViewAvailability?: DesktopWebViewNativeAvailability }>) {
    const pane = useAppPaneScope(props.scopeId);
    useOpenBrowserTargetInWorkspace({ scopeId: props.scopeId, scope: 'sessionMobile', platform: props.platform ?? 'web',
        desktopWebViewAvailability: props.desktopWebViewAvailability,
        accountLifetime: account!.accountLifetime, openDetailsTab: pane.openDetailsTab });
    return null;
}

describe('useServicesOpenInBrowser', () => {
    beforeEach(() => {
        standardCleanup();
        openExternalUrlMock.mockClear();
        const resource = {
            previewId: 'preview-open', sessionId: 'session-a', machineId: 'machine-a',
            owner: { kind: 'session', id: 'session-a' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Open feed preview', addressLabel: 'localhost:5173' },
            originMode: 'host', browserTarget: openableTarget.browserTarget,
        };
        const preview = { previewId: resource.previewId, resource, accessUrl: 'https://preview-open.preview.test/?previewToken=fresh', expiresAt: 61_000, diagnostics: [] };
        machineRpcMock.mockResolvedValue({ protocolVersion: 1, status: 'existing', preview, snapshot: { v: 1, machineId: resource.machineId, generatedAt: 1_000, refreshState: 'idle', resources: [resource], previews: [preview], diagnostics: [] } });
    });
    beforeEach(async () => {
        actionPolicy = {};
        const features = createRootLayoutFeaturesResponse({ features: { browser: { enabled: true } } });
        fixture = await createPlainArtifactHomeFixture('https://services-browser.test', {
            serverFeatures: features,
            handleRequest: async path => path === '/v2/account/settings' ? Response.json({ version: 1,
                content: { t: 'plain', v: { actionsSettingsV1: { v: 1, actions: { 'browser.workspace.open': actionPolicy },
                    approvalWaivedSurfaces: { 'browser.workspace.open': ['ui'] },
                } } } }) : null,
        });
        expect(await setServerProfileIdentityForUrl(fixture.home.serverUrl, 'srv_services_phone_home'))
            .toMatchObject({ serverIdentityId: 'srv_services_phone_home' });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: fixture.home.id, snapshot: { status: 'ready', features } });
        await fixture.hydrateAccountSettings();
        account = await (await import('@/sync/ops/actions/actionAccountContext')).captureLazyActionAccountContext(fixture.home.id);
    });
    afterEach(async () => { standardCleanup(); account?.dispose(); account = undefined; await fixture?.dispose(); fixture = undefined; });

    it.each(['hydrated', 'first-read-pending', 'settled-empty', 'failed-first-read'] as const)('shows truthful Services hydration and retains running inventory through Browser Details open/close (%s)', async hydration => {
        const previewResponse: unknown = await machineRpcMock.getMockImplementation()?.();
        const watchSignals: AbortSignal[] = [];
        let holdReopenedRead = hydration !== 'hydrated';
        const reopenedRead = createDeferred<void>();
        machineRpcMock.mockImplementation(async (request: {
            method: string; signal?: AbortSignal;
        }) => {
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                if (request.signal) watchSignals.push(request.signal);
                return new Promise((resolve) => request.signal?.addEventListener('abort', () => resolve({
                    protocolVersion: 1, changed: false,
                }), { once: true }));
            }
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
                || request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT) return {
                protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000,
                    refreshState: 'idle', entries: [], diagnostics: [] },
            };
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
                if (holdReopenedRead) await reopenedRead.promise;
                if (hydration === 'failed-first-read') throw new Error('Launcher transport unavailable');
                return { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', sessionId: 'session-a',
                    updatedAt: 1_000, targets: hydration === 'settled-empty' ? [] : [liveServiceTarget] } };
            }
            return previewResponse;
        });
        let pane: ReturnType<typeof useAppPaneScope> | undefined;
        function ProjectServices() {
            pane = useAppPaneScope('project:services-continuity');
            const open = useServicesOpenInBrowser({ scopeId: 'project:services-continuity', scope: 'workspaceDetails',
                machineId: null, serverId: fixture!.home.id, accountLifetime: account!.accountLifetime });
            // The layout withdraws demand while Details covers Services, without unmounting it.
            return <PluginSurfaceFocusEligibilityProvider active={!pane.scopeState?.details.isOpen}>
                <LocalServicesSurfaceHost machineId="machine-a" serverId={fixture!.home.id} sessionId="session-a"
                    scope="workspace" workspaceRoot={`/source-${hydration}`}
                    onOpenServiceInBrowser={open} testID="retained-services" />
            </PluginSurfaceFocusEligibilityProvider>;
        }
        const screen = await renderScreen(<AppPaneProvider><ProjectServices /></AppPaneProvider>);
        try {
            if (hydration !== 'hydrated') {
                await vi.waitFor(() => expect(machineRpcMock.mock.calls.some(([request]) =>
                    request?.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)).toBe(true));
                await flushHookEffects();
                // A completed listener scan cannot settle the still-pending launcher projection.
                // This is a different contract from retaining a previously admitted running row.
                expect(screen.root.findByType(DetectedLocalServicesPane).props.launcherState).toMatchObject({
                    updatedAt: null, refreshStatus: 'refreshing', targetIds: [],
                });
                expect.soft(screen.root.findAll(node => node.props.testID === 'retained-services-loading').length).toBeGreaterThan(0);
                expect.soft(screen.root.findAll(node => node.props.testID === 'retained-services-empty')).toHaveLength(0);
                holdReopenedRead = false;
                reopenedRead.resolve();
            }
            if (hydration === 'settled-empty' || hydration === 'failed-first-read') {
                await vi.waitFor(() => expect(screen.root.findByType(DetectedLocalServicesPane).props.launcherState.refreshStatus)
                    .toBe(hydration === 'settled-empty' ? 'idle' : 'error'));
                expect(screen.root.findAll(node => node.props.testID === 'retained-services-loading')).toHaveLength(0);
                expect(screen.root.findAll(node => node.props.testID === `retained-services-${hydration === 'settled-empty' ? 'empty' : 'error'}`).length)
                    .toBeGreaterThan(0);
                if (hydration === 'failed-first-read') expect(screen.root.findAll(node => node.props.testID === 'retained-services-empty')).toHaveLength(0);
                return;
            }
            await vi.waitFor(() => expect(screen.findByTestId('retained-services-row:inventory:open-feed-open')).toBeTruthy());
            expect(screen.getTextContent()).toContain('Running');
            await screen.pressByTestIdAsync('retained-services-row:inventory:open-feed-open');
            expect(pane!.scopeState?.details.isOpen).toBe(true);
            expect(pane!.scopeState?.details.tabs.map(tab => tab.kind)).toEqual(['browser-view']);
            expect(watchSignals.length).toBeGreaterThan(0);
            expect(watchSignals.every(signal => signal.aborted)).toBe(true);
            holdReopenedRead = true;
            await act(async () => { pane!.closeDetails(); });
            await flushHookEffects();
            expect(pane!.scopeState?.details.isOpen).toBe(false);
            expect(screen.getTextContent()).toContain('Running');
            expect(screen.findByTestId('retained-services-row:inventory:open-feed-open')).toBeTruthy();
        } finally { reopenedRead.resolve(); }
    });

    it.each(['sessionDetails', 'workspaceDetails', 'sessionMobile'] as const)('opens a browser-surface details tab in the %s pane scope', async scope => {
        const captured: Captured = { open: null };
        const screen = await renderServicesHook({ scopeId: `scope:${scope}`, scope, captured });

        expect(captured.open).toBeTypeOf('function');
        await act(async () => {
            const result = await captured.open?.(openableTarget);
            expect(readLocalServiceActionOutcome(result)).toEqual({ kind: 'succeeded' });
        });

        const probe = screen.tree.findByType('HookProbe' as never);
        expect(probe.props.detailsTabKinds).toContain('browser-view');
    });

    it('opens the real phone Services row through a profile alias into the Home-qualified Browser workspace', async () => {
        expect(account!.accountLifetime.scope.serverId).toBe('srv_services_phone_home');
        expect(fixture!.home.id).not.toBe(account!.accountLifetime.scope.serverId);
        const onAfterOpen = vi.fn();
        const captured: Captured = { open: null };
        const screen = await renderServicesHook({ scopeId: 'session:phone:browser', scope: 'sessionMobile',
            captured, phoneServices: true, onAfterOpen });
        await screen.pressByTestIdAsync('session-mobile-services-row:inventory:open-feed-open');
        expect(screen.tree.findByType('HookProbe' as never).props.detailsTabKinds).toEqual(['browser-view']);
        expect(onAfterOpen).toHaveBeenCalledOnce();
    });

    it('keeps a phone Service open current when cockpit presentation changes during preview registration', async () => {
        const captured: Captured = { open: null };
        const onAfterOpen = vi.fn();
        const previewResponse: unknown = machineRpcMock.getMockImplementation()?.();
        const registration = createDeferred<unknown>();
        machineRpcMock.mockImplementation(() => registration.promise);
        const render = (present: () => void) => <SessionViewerSourceAccountScopeProvider accountLifetime={account!.accountLifetime}>
            <AppPaneProvider><PanePresentationProvider value={present}>
                <HookProbe scopeId="session:phone:rebind:browser" scope="sessionMobile" captured={captured} onAfterOpen={onAfterOpen} />
            </PanePresentationProvider></AppPaneProvider>
        </SessionViewerSourceAccountScopeProvider>;
        const screen = await renderScreen(render(() => {}));
        let opening!: ReturnType<NonNullable<Captured['open']>>;
        await act(async () => { opening = captured.open!(liveServiceTarget); });
        const present = vi.fn();
        await act(async () => { screen.update(render(present)); });
        await act(async () => { registration.resolve(await previewResponse); });
        expect(await opening).toEqual({ status: 'succeeded' });
        expect(screen.tree.findByType('HookProbe' as never).props.detailsTabKinds).toEqual(['browser-view']);
        expect(present).toHaveBeenCalledOnce();
        expect(onAfterOpen).toHaveBeenCalledOnce();
    });

    it('shows the exact Browser refusal in the real phone row Details when its workspace owner is absent', async () => {
        const onAfterOpen = vi.fn();
        const captured: Captured = { open: null };
        const screen = await renderServicesHook({ scopeId: 'session:phone:unavailable:browser', scope: 'sessionMobile',
            captured, phoneServices: true, onAfterOpen });
        // Remove the real registration, rather than substituting an Action or opener implementation.
        clearBrowserRuntimeControlRegistryForTests();
        await screen.pressByTestIdAsync('session-mobile-services-row:inventory:open-feed-open');
        await screen.pressByTestIdAsync('session-mobile-services-row:inventory:open-feed-failure.details');
        expect(screen.getTextContent()).toContain('browser_view_unavailable');
        expect(screen.getTextContent()).not.toContain('runtime_action_disabled');
        expect(screen.tree.findByType('HookProbe' as never).props.detailsTabKinds).toEqual([]);
        expect(onAfterOpen).not.toHaveBeenCalled();
    });

    it('invokes onAfterOpen only when the target is mappable', async () => {
        const onAfterOpen = vi.fn();
        const onAfterDetailsOpen = vi.fn();
        const captured: Captured = { open: null };
        await renderServicesHook({ scopeId: 'session:s2:details', captured, onAfterOpen, onAfterDetailsOpen });

        await act(async () => {
            const result = await captured.open?.(unmappableTarget);
            expect(result).toMatchObject({ status: 'denied' });
            expect(readLocalServiceActionOutcome(result).kind).toBe('failed');
        });
        expect(onAfterOpen).not.toHaveBeenCalled();
        expect(onAfterDetailsOpen).not.toHaveBeenCalled();

        await act(async () => {
            await captured.open?.(openableTarget);
        });
        expect(onAfterOpen).toHaveBeenCalledTimes(1);
        expect(onAfterDetailsOpen).toHaveBeenCalledTimes(1);
    });

    it('does not open a tab for an unmappable target', async () => {
        const captured: Captured = { open: null };
        const screen = await renderServicesHook({ scopeId: 'session:s3:details', captured });

        await act(async () => {
            await captured.open?.(unmappableTarget);
        });

        const probe = screen.tree.findByType('HookProbe' as never);
        expect(probe.props.detailsTabKinds).not.toContain('browser-view');
    });

    it('leaves desktop and mobile surfaces unchanged when workspace opening is disabled', async () => {
        actionPolicy = { enabled: false };
        await fixture!.hydrateAccountSettings();
        const onAfterOpen = vi.fn();
        const onAfterDetailsOpen = vi.fn();
        const captured: Captured = { open: null };
        const screen = await renderServicesHook({ scopeId: 'session:disabled:browser', captured, onAfterOpen, onAfterDetailsOpen });
        await act(async () => {
            expect(await captured.open!(openableTarget)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        });
        expect(screen.tree.findByType('HookProbe' as never).props.detailsTabKinds).toEqual([]);
        expect(onAfterOpen).not.toHaveBeenCalled();
        expect(onAfterDetailsOpen).not.toHaveBeenCalled();
    });

    it.each(['reject', 'approve'] as const)('keeps surfaces unchanged while approval is pending and follows the %s decision', async decision => {
        actionPolicy = { approvalRequiredSurfaces: ['ui'] };
        await fixture!.hydrateAccountSettings();
        const onAfterOpen = vi.fn();
        const onAfterDetailsOpen = vi.fn();
        const captured: Captured = { open: null };
        const screen = await renderServicesHook({ scopeId: `session:${decision}:browser`, scope: 'sessionMobile', captured, onAfterOpen, onAfterDetailsOpen });
        let pendingOpen: ReturnType<NonNullable<Captured['open']>> | undefined;
        await act(async () => {
            pendingOpen = captured.open!(openableTarget);
            await vi.waitFor(() => expect(fixture!.boundary.list().some(row =>
                fixture!.boundary.readPlainBody(row.id)?.includes('browser.workspace.open'))).toBe(true));
        });
        expect(screen.tree.findByType('HookProbe' as never).props.detailsTabKinds).toEqual([]);
        expect(onAfterOpen).not.toHaveBeenCalled();
        expect(onAfterDetailsOpen).not.toHaveBeenCalled();
        const approval = fixture!.boundary.list().find(row => fixture!.boundary.readPlainBody(row.id)?.includes('browser.workspace.open'));
        expect(approval).toBeDefined();
        await act(async () => {
            expect(await decideApprovalAsInbox(fixture!.home.id, approval!.id, decision)).toMatchObject({ ok: true });
        });
        expect(readLocalServiceActionOutcome(await pendingOpen!)).toMatchObject({ kind: decision === 'approve' ? 'succeeded' : 'cancelled' });
        expect(screen.tree.findByType('HookProbe' as never).props.detailsTabKinds).toEqual(decision === 'approve' ? ['browser-view'] : []);
        expect(onAfterOpen).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0);
        expect(onAfterDetailsOpen).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0);
    });

    it('switches the Services surface after a retained Browser scene commits the same workspace tab', async () => {
        const captured: Captured = { open: null };
        const onAfterOpen = vi.fn();
        const onAfterDetailsOpen = vi.fn();
        const scopeId = 'session:retained:browser';
        const screen = await renderScreen(<SessionViewerSourceAccountScopeProvider accountLifetime={account!.accountLifetime}>
            <AppPaneProvider>
                <HookProbe scopeId={scopeId} scope="sessionMobile" captured={captured}
                    onAfterOpen={onAfterOpen} onAfterDetailsOpen={onAfterDetailsOpen} />
                <RetainedBrowserOwner scopeId={scopeId} />
            </AppPaneProvider>
        </SessionViewerSourceAccountScopeProvider>);
        await act(async () => {
            expect(await captured.open!(openableTarget)).toEqual({ status: 'succeeded' });
        });
        expect(screen.tree.findByType('HookProbe' as never).props.detailsTabKinds).toEqual(['browser-view']);
        expect(onAfterOpen).toHaveBeenCalledTimes(1);
        expect(onAfterDetailsOpen).toHaveBeenCalledTimes(1);
    });

    it('does not switch surfaces after the retained Browser owner hands an external URL to the OS', async () => {
        const captured: Captured = { open: null };
        const onAfterOpen = vi.fn();
        const onAfterDetailsOpen = vi.fn();
        const scopeId = 'session:external:browser';
        const screen = await renderScreen(<SessionViewerSourceAccountScopeProvider accountLifetime={account!.accountLifetime}>
            <AppPaneProvider>
                <HookProbe scopeId={scopeId} scope="sessionMobile" captured={captured}
                    onAfterOpen={onAfterOpen} onAfterDetailsOpen={onAfterDetailsOpen} />
                <RetainedBrowserOwner scopeId={scopeId} platform="desktop" desktopWebViewAvailability={{
                    available: false, platform: 'windows', primitive: 'windowsHwndWebView2',
                    renderEngine: 'unavailable', producer: 'none', privilegedIpc: false,
                    supports: { navigation: false, goBackForward: false, reload: false, stop: false,
                        pageInfoDiagnostics: false, nativeDevtools: false, capture: false, recording: false, automation: false },
                    disabledReasons: ['desktop_webview_child_view_unverified'],
                }} />
            </AppPaneProvider>
        </SessionViewerSourceAccountScopeProvider>);
        await act(async () => {
            expect(await captured.open!({ ...openableTarget, source: 'terminal_url', browserTarget: {
                kind: 'externalUrl', targetId: 'external-service', url: 'https://external.test/',
            } })).toEqual({ status: 'succeeded' });
        });
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://external.test/');
        expect(screen.tree.findByType('HookProbe' as never).props.detailsTabKinds).toEqual([]);
        expect(onAfterOpen).not.toHaveBeenCalled();
        expect(onAfterDetailsOpen).not.toHaveBeenCalled();
    });
});
