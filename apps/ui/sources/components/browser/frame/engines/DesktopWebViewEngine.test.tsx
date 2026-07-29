import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type {
    DesktopBrowserCommandResult,
    DesktopBrowserPageInfoResult,
} from '@/sync/domains/browser/adapters/desktopWebViewBridge';

import { DesktopWebViewEngine, type DesktopWebViewEngineBridge } from './DesktopWebViewEngine';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const availableDesktopWebView = {
    available: true,
    platform: 'macos',
    primitive: 'macosNsViewWebKit',
    renderEngine: 'desktopWebView',
    producer: 'tauriWryNativeChildView',
    privilegedIpc: false,
    supports: {
        navigation: true,
        goBackForward: false,
        reload: false,
        stop: false,
        pageInfoDiagnostics: true,
        nativeDevtools: true,
        capture: false,
        recording: false,
        automation: false,
    },
    disabledReasons: [],
} as const;

function createExternalDesktopView(overrides: Partial<BrowserControlViewState> = {}): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_external_1',
        target: {
            kind: 'externalUrl',
            targetId: 'external_1',
            url: 'https://example.com/',
            display: { title: 'Example' },
        },
        platform: 'desktop',
        adapterKind: 'externalUrl',
        engineKind: 'desktopWebView',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['desktopWebView'],
            desktopWebViewSupport: availableDesktopWebView.supports,
        }),
        currentUrl: 'https://example.com/',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Example',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: 0,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: 'https://example.com',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
        ...overrides,
    };
}

function createBridge(): DesktopWebViewEngineBridge {
    const commandResult = { ok: true, availability: availableDesktopWebView } satisfies DesktopBrowserCommandResult;
    const pageInfoResult = {
        ok: true,
        availability: availableDesktopWebView,
        pageInfo: {
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            requestedUrl: 'https://example.com/dashboard?token=secret#panel',
            currentUrl: 'https://example.com/dashboard?token=secret#panel',
            title: 'Example dashboard',
            loadingState: 'finished',
        },
    } satisfies DesktopBrowserPageInfoResult;
    return {
        openView: vi.fn(async () => commandResult),
        navigateView: vi.fn(async () => commandResult),
        setBounds: vi.fn(async () => commandResult),
        setPointerPassthrough: vi.fn(async () => commandResult),
        closeView: vi.fn(async () => commandResult),
        openDevtools: vi.fn(async () => commandResult),
        readPageInfo: vi.fn(async () => pageInfoResult),
        drainDiagnostics: vi.fn(async () => ({ ok: true, availability: availableDesktopWebView, messages: [] })),
        evalScript: vi.fn(async () => commandResult),
        dispatchNavigation: vi.fn(async () => commandResult),
    };
}

describe('DesktopWebViewEngine', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('opens, bounds, navigates, omits the occluded in-frame devtools button, emits page-info diagnostics, and closes the native view', async () => {
        const bridge = createBridge();
        const onDiagnosticsEvents = vi.fn();
        const diagnostics = {
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            navigationGeneration: 0,
            collectorId: 'desktop_collector_1',
            nonce: 'desktop_nonce_1',
            collectorVersion: '1.0.0',
            onEvents: onDiagnosticsEvents,
        };

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnostics}
                bridge={bridge}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // With a diagnostics bridge, the canonical collector is injected as the Wry document-start
        // init script (full in-page console/network/resource devtools over the `window.ipc` channel).
        expect(bridge.openView).toHaveBeenCalledWith(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            profileId: 'profile_external_1',
            url: 'https://example.com/',
            diagnosticsInitScript: expect.stringContaining('desktop_collector_1'),
        }));
        expect(bridge.drainDiagnostics).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
        });
        expect(bridge.readPageInfo).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
        });
        expect(onDiagnosticsEvents).toHaveBeenCalledWith([
            expect.objectContaining({
                eventId: 'desktop_collector_1:0:desktopPageInfo:1',
                family: 'pageInfo',
                kind: 'pageInfo.snapshot',
                fidelity: 'nativeCallback',
                trusted: true,
                capturedAtMs: 5_000,
                data: {
                    url: 'https://example.com/dashboard',
                    loading: false,
                    title: 'Example dashboard',
                },
            }),
        ]);

        // Bounds now flow through `useDesktopWebViewSurfaceSync` (rAF + occlusion + stable-frame
        // early-out), exercised directly in useDesktopWebViewSurfaceSync.test.tsx. `onLayout` is a
        // sync-request trigger here, not a one-shot bounds push.
        expect(screen.findByTestId('desktop-webview')?.props.onLayout).toBeTypeOf('function');

        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView({
                    pendingUrl: 'https://example.com/docs',
                    loadingState: 'loading',
                    navigationGeneration: 1,
                })}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                nowMs={() => 5_001}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(bridge.navigateView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            url: 'https://example.com/docs',
        });

        // A5a (F1-ui): the engine no longer renders an in-frame devtools button (it was permanently
        // occluded by the native Wry child view). Devtools is owned solely by the BrowserShell toolbar.
        expect(screen.findByTestId('desktop-webview-open-devtools')).toBeNull();

        await screen.unmount();
        expect(bridge.closeView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
        });
    });

    it('engages pointer passthrough while a host drag signal is active', async () => {
        const bridge = createBridge();
        let dragActive = false;
        const dragListeners = new Set<() => void>();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                dragSignal={{
                    isActive: () => dragActive,
                    subscribe: (cb) => {
                        dragListeners.add(cb);
                        return () => dragListeners.delete(cb);
                    },
                }}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        vi.mocked(bridge.setPointerPassthrough).mockClear();

        await act(async () => {
            dragActive = true;
            dragListeners.forEach((cb) => cb());
            await Promise.resolve();
        });

        expect(bridge.setPointerPassthrough).toHaveBeenLastCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            ignore: true,
        });

        await screen.unmount();
    });

    it('does not close the native view on a hide-only lifecycle transition (keep-mounted)', async () => {
        const bridge = createBridge();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                lifecycleState="visible"
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                lifecycleState="hidden"
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(bridge.closeView).not.toHaveBeenCalled();

        // A genuine unmount while hide-latched is the tab/split-canvas owner's teardown, not the
        // engine's — so the engine still does not close here.
        await screen.unmount();
        expect(bridge.closeView).not.toHaveBeenCalled();
    });

    it('keeps the native view mounted when page-info diagnostics are unavailable after open succeeds', async () => {
        const bridge = createBridge();
        vi.mocked(bridge.readPageInfo).mockResolvedValue({
            ok: false,
            availability: {
                ...availableDesktopWebView,
                supports: {
                    ...availableDesktopWebView.supports,
                    pageInfoDiagnostics: false,
                },
                disabledReasons: ['desktop_webview_native_command_unavailable'],
            },
        } satisfies DesktopBrowserPageInfoResult);
        const onDiagnosticsEvents = vi.fn();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_external_1',
                    navigationGeneration: 0,
                    collectorId: 'desktop_collector_1',
                    nonce: 'desktop_nonce_1',
                    collectorVersion: '1.0.0',
                    onEvents: onDiagnosticsEvents,
                }}
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(screen.findByTestId('desktop-webview')).not.toBeNull();
        expect(screen.findByTestId('desktop-webview-unavailable')).toBeNull();
        expect(onDiagnosticsEvents).toHaveBeenCalledWith([
            expect.objectContaining({
                kind: 'diagnostics.unavailable',
                data: expect.objectContaining({
                    errorCode: 'desktop_webview_native_command_unavailable',
                }),
            }),
        ]);
    });

    it('injects location.reload() into the native view for a reload navigation command', async () => {
        const bridge = createBridge();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        vi.mocked(bridge.dispatchNavigation).mockClear();

        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                navigationCommand={{ commandId: 'cmd_reload_1', kind: 'reload' }}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(bridge.dispatchNavigation).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            kind: 'reload',
            script: 'location.reload()',
        });
    });

    it('injects window.stop() into the native view for a stop navigation command', async () => {
        const bridge = createBridge();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                navigationCommand={{ commandId: 'cmd_stop_1', kind: 'stop' }}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(bridge.dispatchNavigation).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            kind: 'stop',
            script: 'window.stop()',
        });
    });

    it('renders a recoverable crash surface and reloads the last URL when the render process crashes', async () => {
        const bridge = createBridge();
        const crashedPageInfo = {
            ok: true,
            availability: availableDesktopWebView,
            pageInfo: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_external_1',
                requestedUrl: 'https://example.com/',
                currentUrl: 'https://example.com/',
                title: 'Example',
                loadingState: 'crashed',
            },
        } satisfies DesktopBrowserPageInfoResult;
        // First read after open reports a crash; subsequent reads (after reload) report finished.
        vi.mocked(bridge.readPageInfo)
            .mockResolvedValueOnce(crashedPageInfo)
            .mockResolvedValue({
                ok: true,
                availability: availableDesktopWebView,
                pageInfo: {
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_external_1',
                    requestedUrl: 'https://example.com/',
                    currentUrl: 'https://example.com/',
                    title: 'Example',
                    loadingState: 'finished',
                },
            } satisfies DesktopBrowserPageInfoResult);

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // A crashed render process surfaces a recoverable frame with a Reload affordance — not a
        // frozen page and not the generic unavailable frame.
        expect(screen.findByTestId('desktop-webview-crashed')).not.toBeNull();
        const reload = screen.findByTestId('desktop-webview-crashed-reload');
        expect(reload).not.toBeNull();

        vi.mocked(bridge.navigateView).mockClear();
        await screen.pressByTestIdAsync('desktop-webview-crashed-reload');
        await flushHookEffects({ cycles: 2, turns: 2 });

        // Reload re-issues navigation to the last good URL and clears the crashed surface.
        expect(bridge.navigateView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            url: 'https://example.com/',
        });
        expect(screen.findByTestId('desktop-webview-crashed')).toBeNull();
        expect(screen.findByTestId('desktop-webview')).not.toBeNull();
    });

    it('B-2 cause-2: feeds native page-info load lifecycle back to the control reducer via onLifecycle', async () => {
        const bridge = createBridge();
        const onLifecycle = vi.fn();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                onLifecycle={onLifecycle}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // The bridge reports a finished load; publishPageInfo maps it to a loadFinished lifecycle
        // signal so the reducer can leave `loading` — independent of any diagnostics bridge being
        // attached. Unlike the diagnostics event (which is redacted for telemetry egress), the
        // lifecycle carries the REAL current URL so the view's address/navigation stay accurate.
        expect(onLifecycle).toHaveBeenCalledWith({
            kind: 'loadFinished',
            url: 'https://example.com/dashboard?token=secret#panel',
        });

        await screen.unmount();
    });

    it('B-2 cause-2: reports a load failure to the reducer when a native navigate command fails', async () => {
        const bridge = createBridge();
        const onLifecycle = vi.fn();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                onLifecycle={onLifecycle}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        onLifecycle.mockClear();
        vi.mocked(bridge.navigateView).mockResolvedValue({
            ok: false,
            availability: {
                ...availableDesktopWebView,
                disabledReasons: ['desktop_webview_native_command_unavailable'],
            },
        });

        // A same-viewKey in-place URL set drives navigateView; its failure is a load failure for the
        // reducer (harden §15 Δ2 — the in-place URL set is dispatched, not swallowed).
        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView({
                    pendingUrl: 'https://example.com/docs',
                    loadingState: 'loading',
                    navigationGeneration: 1,
                })}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                onLifecycle={onLifecycle}
                nowMs={() => 5_001}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(bridge.navigateView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            url: 'https://example.com/docs',
        });
        expect(onLifecycle).toHaveBeenCalledWith({
            kind: 'loadFailed',
            errorCode: 'desktop_webview_native_command_unavailable',
        });

        await screen.unmount();
    });

    it('B-2 cause-2: polls page-info to settle the load lifecycle even with no diagnostics bridge', async () => {
        // Regression: the page-info poll (which transitions loading → ready, syncs the URL after an
        // in-webview link click, and surfaces native devtools) was gated on a diagnostics bridge.
        // A desktop view with diagnostics unavailable therefore opened in `loading` and never left it
        // — the toolbar reload stayed a disabled "stop" and link clicks never settled. The poll must
        // run whenever the native view is active, independent of diagnostics.
        vi.useFakeTimers();
        try {
            const bridge = createBridge();
            // First (post-open) read still loading; the next poll reports the finished load.
            vi.mocked(bridge.readPageInfo).mockResolvedValueOnce({
                ok: true,
                availability: availableDesktopWebView,
                pageInfo: {
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_external_1',
                    requestedUrl: 'https://example.com/',
                    currentUrl: 'https://example.com/',
                    title: 'Example',
                    loadingState: 'loading',
                },
            } satisfies DesktopBrowserPageInfoResult);
            const onLifecycle = vi.fn();

            const screen = await renderScreen(
                <DesktopWebViewEngine
                    view={createExternalDesktopView({ loadingState: 'loading' })}
                    profileId="profile_external_1"
                    testID="desktop-webview"
                    bridge={bridge}
                    // No `diagnostics` prop: this is the diagnostics-unavailable desktop case.
                    pageInfoPollIntervalMs={2_000}
                    onLifecycle={onLifecycle}
                    nowMs={() => 5_000}
                />,
            );
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(onLifecycle).toHaveBeenCalledWith({ kind: 'loadStarted', url: 'https://example.com/' });
            onLifecycle.mockClear();

            // Advance past the poll interval: the page-info poll must fire (diagnostics-independent)
            // and move the reducer out of `loading`.
            await flushHookEffects({ cycles: 1, turns: 3, advanceTimersMs: 2_000 });
            expect(vi.mocked(bridge.readPageInfo).mock.calls.length).toBeGreaterThanOrEqual(2);
            expect(onLifecycle).toHaveBeenCalledWith({
                kind: 'loadFinished',
                url: 'https://example.com/dashboard?token=secret#panel',
            });

            await screen.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('evals the canonical eval command script into the page when the diagnostics bridge sets an eval request', async () => {
        const bridge = createBridge();
        const diagnostics = {
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            navigationGeneration: 0,
            collectorId: 'desktop_collector_1',
            nonce: 'desktop_nonce_1',
            collectorVersion: '1.0.0',
            onEvents: vi.fn(),
            evalRequest: {
                v: 1,
                evalRequestId: 'eval_req_1',
                viewId: 'view_external_1',
                navigationGeneration: 0,
                tier: 'injectedPage',
                expression: 'document.title',
                timeoutMs: 2_000,
                objectGroupId: 'group_1',
                diagnosticsInteractionEnabled: true,
            },
        } as const;

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnostics}
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // The interactive eval REPL pushes the canonical command script through the host eval command
        // (bound to the injected collector); its result returns over the ipc/drain channel.
        expect(bridge.evalScript).toHaveBeenCalledWith(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            script: expect.stringContaining('desktop_collector_1'),
        }));

        await screen.unmount();
    });

    it('does not re-inject the same navigation command on unrelated re-renders', async () => {
        const bridge = createBridge();
        const command = { commandId: 'cmd_reload_stable', kind: 'reload' } as const;

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                navigationCommand={command}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(bridge.dispatchNavigation).toHaveBeenCalledTimes(1);

        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                navigationCommand={command}
                nowMs={() => 6_000}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(bridge.dispatchNavigation).toHaveBeenCalledTimes(1);
    });

    it('A5b: dispatches a navigation command through the LATEST bridge after the bridge prop changes', async () => {
        const firstBridge = createBridge();
        const secondBridge = createBridge();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={firstBridge}
                pageInfoPollIntervalMs={null}
                navigationCommand={{ commandId: 'cmd_1', kind: 'reload' }}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(firstBridge.dispatchNavigation).toHaveBeenCalledTimes(1);

        // The bridge instance changes, then a NEW command id fires. The ref-based callback must read
        // the live bridge — the latest instance — not a render-time captured closure.
        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={secondBridge}
                pageInfoPollIntervalMs={null}
                navigationCommand={{ commandId: 'cmd_2', kind: 'stop' }}
                nowMs={() => 6_000}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(secondBridge.dispatchNavigation).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            kind: 'stop',
            script: 'window.stop()',
        });
        // The first bridge was only used for the first command, never the post-swap one.
        expect(firstBridge.dispatchNavigation).toHaveBeenCalledTimes(1);
    });

    it('A5c: keeps early post-navigation events tagged with the prior collector generation (N-1)', async () => {
        const bridge = createBridge();
        const onEvents = vi.fn();
        const diagnosticsForGeneration = (navigationGeneration: number, collectorId: string) => ({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            navigationGeneration,
            collectorId,
            nonce: `nonce_${collectorId}`,
            collectorVersion: '1.0.0',
            onEvents,
        });
        const priorGenerationBatch = JSON.stringify({
            v: 1,
            kind: 'browser.diagnostics.events',
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            navigationGeneration: 0,
            collector: { collectorId: 'collector_gen0', nonce: 'nonce_collector_gen0', version: '1.0.0' },
            events: [{
                v: 1,
                eventId: 'evt_prior_gen_1',
                browserSessionId: 'browser_session_1',
                viewId: 'view_external_1',
                navigationGeneration: 0,
                capturedAtMs: 2_000,
                family: 'console',
                kind: 'console.entry',
                fidelity: 'injectedPage',
                trusted: false,
                collector: { collectorId: 'collector_gen0', nonce: 'nonce_collector_gen0', version: '1.0.0' },
                data: { level: 'log', textPreview: 'early-post-nav' },
                redaction: { level: 'metadataOnly' },
            }],
        });

        // Open at generation 0 (collector_gen0).
        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView({ currentUrl: 'https://example.com/a', pendingUrl: 'https://example.com/a' })}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnosticsForGeneration(0, 'collector_gen0')}
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // A navigation rotates the collector identity to generation 1 (collector_gen1); the prior
        // generation (collector_gen0) is remembered.
        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView({ currentUrl: 'https://example.com/a', pendingUrl: 'https://example.com/a' })}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnosticsForGeneration(1, 'collector_gen1')}
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                nowMs={() => 5_001}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        onEvents.mockClear();

        // Now an early post-navigation drain delivers an event still tagged with the prior collector.
        vi.mocked(bridge.drainDiagnostics).mockResolvedValueOnce({
            ok: true,
            availability: availableDesktopWebView,
            messages: [priorGenerationBatch],
        });

        // Trigger a drain via an in-place navigation (the navigate effect drains after it resolves).
        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView({ currentUrl: 'https://example.com/b', pendingUrl: 'https://example.com/b' })}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnosticsForGeneration(1, 'collector_gen1')}
                bridge={bridge}
                pageInfoPollIntervalMs={null}
                nowMs={() => 5_002}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // The prior-generation event was accepted, not dropped as collector_mismatch/navigation_stale.
        // (The parser re-derives a sanitized eventId, so match on the stable family/preview instead.)
        expect(onEvents).toHaveBeenCalled();
        const deliveredEvents = onEvents.mock.calls.flatMap(([events]) => events as Array<{
            family: string;
            navigationGeneration: number;
            data?: { textPreview?: string };
        }>);
        // The prior-generation (N-1) console event was delivered rather than dropped — it carries the
        // prior navigationGeneration (0), proving the drain accepted the immediately-prior collector.
        const priorGenConsoleEvent = deliveredEvents.find((event) => event.family === 'console');
        expect(priorGenConsoleEvent).toBeDefined();
        expect(priorGenConsoleEvent?.navigationGeneration).toBe(0);
    });
});
