import type { BrowserDiagnosticEventV1, BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createNativeWebViewPageInfoDiagnosticEvent } from '@/components/browser/adapters/diagnostics';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { selectBrowserDiagnosticsForView } from '@/sync/domains/browser/diagnostics';
import type { BrowserDiagnosticsSnapshotClientResult } from '@/sync/domains/browser/diagnostics/machineRpc';

import { useBrowserDiagnosticsRuntime } from './useBrowserDiagnosticsRuntime';

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
});

function stubCryptoRandomUuid(): void {
    let sequence = 0;
    vi.stubGlobal('crypto', {
        randomUUID: vi.fn(() => {
            sequence += 1;
            return `uuid_${sequence}`;
        }),
    });
}

function createLocalPreviewView(
    overrides: Partial<Pick<
        BrowserControlViewState,
        'adapterKind' | 'currentUrl' | 'engineKind' | 'navigationGeneration' | 'securityOrigin' | 'viewId'
    >> = {},
): BrowserControlViewState {
    const adapterKind = overrides.adapterKind ?? 'localPreview';
    const engineKind = overrides.engineKind ?? 'webIframe';
    return {
        browserSessionId: 'browser_session_1',
        viewId: overrides.viewId ?? 'view_1',
        target: {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: {
                title: 'Preview',
                addressLabel: 'localhost:5173',
            },
        },
        platform: 'web',
        adapterKind,
        engineKind,
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind,
            supportedTargetKinds: ['localServicePreview'],
            supportedRenderEngines: [engineKind],
        }),
        currentUrl: overrides.currentUrl ?? 'https://preview.happier.test/dashboard?token=redacted',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Preview',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: overrides.navigationGeneration ?? 7,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: overrides.securityOrigin ?? 'https://preview.happier.test/',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function createSimulatorView(): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_simulator_1',
        target: {
            kind: 'simulatorPreview',
            targetId: 'simulator_1',
            deviceId: 'device_1',
            display: {
                title: 'iPhone 16',
            },
        },
        platform: 'web',
        adapterKind: 'simulatorPreview',
        engineKind: 'streamedSurface',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'simulatorPreview',
            supportedTargetKinds: ['simulatorPreview'],
            supportedRenderEngines: ['streamedSurface'],
        }),
        currentUrl: null,
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'iPhone 16',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: 0,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: null,
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function createDaemonConsoleEvent(
    overrides: Partial<BrowserDiagnosticEventV1> = {},
): BrowserDiagnosticEventV1 {
    return {
        v: 1,
        eventId: 'evt_daemon_console_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 7,
        capturedAtMs: 3_000,
        family: 'console',
        kind: 'console.entry',
        fidelity: 'cdp',
        trusted: true,
        data: {
            level: 'log',
            textPreview: 'daemon console entry',
        },
        redaction: {
            level: 'metadataOnly',
            queryRedacted: true,
            headersRedacted: true,
            truncated: false,
        },
        ...overrides,
    };
}

function createDaemonDiagnosticsSnapshot(
    events: readonly BrowserDiagnosticEventV1[],
): BrowserDiagnosticsSnapshotV1 {
    return {
        v: 1,
        machineId: 'machine_1',
        generatedAt: 3_100,
        refreshState: 'idle',
        events: [...events],
        diagnostics: [{
            code: 'daemon_browser_diagnostics_snapshot_ready',
        }],
    };
}

describe('useBrowserDiagnosticsRuntime', () => {
    it('fails closed when diagnostics runtime is not explicitly enabled', async () => {
        stubCryptoRandomUuid();
        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: createDaemonDiagnosticsSnapshot([createDaemonConsoleEvent()]),
        }));

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: null,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView(),
                },
            },
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent()).toBeNull();
        expect(snapshotClient).not.toHaveBeenCalled();
    });

    it('creates a scoped injected diagnostics bridge for supported local preview views and applies events', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test/',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        const runtime = hook.getCurrent();
        expect(runtime?.bridge).toEqual(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            collectorId: 'browser_diagnostics:view_1:7:uuid_1',
            nonce: 'uuid_2',
            collectorVersion: '1.0.0',
            sourceOrigin: 'https://preview.happier.test',
            webPostMessageTargetOrigin: 'https://app.happier.test',
        }));

        const bridge = runtime?.bridge;
        expect(bridge).toBeTruthy();
        if (!bridge) return;

        const event: BrowserDiagnosticEventV1 = {
            v: 1,
            eventId: 'evt_console_1',
            browserSessionId: bridge.browserSessionId,
            viewId: bridge.viewId,
            navigationGeneration: bridge.navigationGeneration,
            capturedAtMs: 2_000,
            family: 'console',
            kind: 'console.entry',
            fidelity: 'injectedPage',
            trusted: false,
            collector: {
                collectorId: bridge.collectorId,
                nonce: bridge.nonce,
                version: bridge.collectorVersion,
            },
            data: {
                level: 'info',
                argCount: 1,
                textAvailable: true,
            },
            redaction: {
                level: 'metadataOnly',
                queryRedacted: true,
                headersRedacted: true,
                truncated: false,
            },
        };

        await act(async () => {
            bridge.onEvents([event]);
        });

        const projection = selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
        expect(projection.eventCount).toBe(1);
        expect(projection.fidelity).toBe('injectedPage');
        expect(projection.families.find((family) => family.family === 'console')).toEqual(expect.objectContaining({
            status: 'available',
            fidelity: 'injectedPage',
            trusted: false,
        }));
    });

    it('does not create a fake injected bridge for local-preview web iframes but still ingests daemon snapshots', async () => {
        stubCryptoRandomUuid();
        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: createDaemonDiagnosticsSnapshot([createDaemonConsoleEvent()]),
        }));

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: null,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView(),
                },
            },
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent()?.bridge).toBeNull();
        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'unavailable',
            pickerState: 'unavailable',
        }));
        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
        }));
        expect(selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }).events).toEqual([
            expect.objectContaining({ eventId: 'evt_daemon_console_1' }),
        ]);
    });

    it('keeps unsupported streamed simulator views visible but without an injected diagnostics bridge', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createSimulatorView(),
                },
            },
        );

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            bridge: null,
        }));
    });

    it('attaches a full injected diagnostics bridge for the desktop Wry engine (no web origin handshake, interaction supported via host eval)', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({
                        adapterKind: 'externalUrl',
                        engineKind: 'desktopWebView',
                        currentUrl: 'https://example.com/dashboard',
                        securityOrigin: 'https://example.com',
                    }),
                },
            },
        );

        const runtime = hook.getCurrent();
        const bridge = runtime?.bridge;
        // Desktop Wry has no CDP/injection, so the bridge carries native page-info only: it is
        // present (events flow) but has NO injected-collector origin handshake.
        expect(bridge).toBeTruthy();
        if (!bridge) return;
        expect(bridge.sourceOrigin).toBeUndefined();
        expect(bridge.webPostMessageTargetOrigin).toBeUndefined();
        // Interactive eval / element-picker IS supported on desktop (host evals the command scripts);
        // it starts disabled-but-enableable, exactly like the other injected surfaces.
        expect(runtime?.interaction).toEqual(expect.objectContaining({
            state: 'disabled',
            canEnable: true,
            pickerState: 'idle',
        }));

        // The native page-info channel flows real events into the diagnostics store.
        const event = createNativeWebViewPageInfoDiagnosticEvent({
            eventId: 'evt_pageinfo_1',
            browserSessionId: bridge.browserSessionId,
            viewId: bridge.viewId,
            navigationGeneration: bridge.navigationGeneration,
            capturedAtMs: 2_000,
            url: 'https://example.com/dashboard',
            loading: false,
            title: 'Example dashboard',
        });
        await act(async () => {
            bridge.onEvents([event]);
        });

        const projection = selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
        expect(projection.eventCount).toBe(1);
        expect(projection.families.find((family) => family.family === 'pageInfo')).toEqual(expect.objectContaining({
            status: 'available',
        }));
    });

    it('ingests daemon diagnostics snapshots for the active machine-scoped view', async () => {
        stubCryptoRandomUuid();
        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: createDaemonDiagnosticsSnapshot([
                createDaemonConsoleEvent(),
                createDaemonConsoleEvent({
                    eventId: 'evt_other_view',
                    viewId: 'view_2',
                    capturedAtMs: 3_001,
                }),
            ]),
        }));

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: null,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView(),
                },
            },
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
        }));
        const projection = selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
        expect(projection.eventCount).toBe(1);
        expect(projection.fidelity).toBe('cdp');
        expect(projection.events).toEqual([
            expect.objectContaining({ eventId: 'evt_daemon_console_1' }),
        ]);
    });

    it('keeps local frame diagnostics when daemon snapshots are unavailable or invalid', async () => {
        stubCryptoRandomUuid();
        const deferred = createDeferred<BrowserDiagnosticsSnapshotClientResult>();
        const snapshotClient = vi.fn(() => deferred.promise);

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: null,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        const bridge = hook.getCurrent()?.bridge;
        expect(bridge).toBeTruthy();
        if (!bridge) return;

        await act(async () => {
            bridge.onEvents([{
                ...createDaemonConsoleEvent({
                    eventId: 'evt_local_console_1',
                    fidelity: 'injectedPage',
                    trusted: false,
                    capturedAtMs: 2_000,
                    collector: {
                        collectorId: bridge.collectorId,
                        nonce: bridge.nonce,
                        version: bridge.collectorVersion,
                    },
                    data: {
                        level: 'info',
                        argCount: 1,
                        textAvailable: true,
                    },
                }),
            }]);
        });
        expect(selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }).events).toEqual([
            expect.objectContaining({ eventId: 'evt_local_console_1' }),
        ]);

        deferred.resolve({ ok: false, reason: 'invalid_response' });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const projection = selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
        expect(projection.events).toEqual([
            expect.objectContaining({ eventId: 'evt_local_console_1' }),
        ]);
    });

    it('cancels daemon diagnostics refreshes on active view changes and unmount', async () => {
        vi.useFakeTimers();
        stubCryptoRandomUuid();
        const firstRefresh = createDeferred<BrowserDiagnosticsSnapshotClientResult>();
        const secondRefresh = createDeferred<BrowserDiagnosticsSnapshotClientResult>();
        const signals: AbortSignal[] = [];
        const snapshotClient = vi.fn((input: { signal?: AbortSignal }) => {
            if (input.signal) signals.push(input.signal);
            return snapshotClient.mock.calls.length === 1
                ? firstRefresh.promise
                : secondRefresh.promise;
        });

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: 5_000,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView(),
                },
            },
        );

        expect(snapshotClient).toHaveBeenCalledTimes(1);

        await hook.rerender({
            view: createLocalPreviewView({ viewId: 'view_2' }),
        });

        expect(snapshotClient).toHaveBeenCalledTimes(2);
        expect(signals[0]?.aborted).toBe(true);

        firstRefresh.resolve({
            ok: true,
            snapshot: createDaemonDiagnosticsSnapshot([createDaemonConsoleEvent()]),
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }).eventCount).toBe(0);

        await hook.unmount();

        expect(signals[1]?.aborted).toBe(true);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(snapshotClient).toHaveBeenCalledTimes(2);
    });

    it('keeps diagnostics interaction default-off and publishes nonce-bound injected command requests after explicit enablement', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'disabled',
            ownerOnly: true,
            canEnable: true,
            pickerState: 'idle',
        }));
        expect(hook.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        expect(hook.getCurrent()?.requestEval({
            expression: 'window.location.href',
        })).toBe(false);

        await act(async () => {
            hook.getCurrent()?.interaction?.onEnableInteraction?.();
        });

        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'enabled',
            ownerOnly: true,
            pickerState: 'idle',
        }));

        await act(async () => {
            expect(hook.getCurrent()?.requestEval({
                expression: 'window.location.href',
            })).toBe(true);
            expect(hook.getCurrent()?.requestGetProperties({
                objectId: 'object_1',
                objectGroupId: 'group_1',
            })).toBe(true);
            expect(hook.getCurrent()?.requestReleaseObjectGroup({
                objectGroupId: 'group_1',
            })).toBe(true);
            hook.getCurrent()?.interaction?.onStartElementPicker?.();
        });

        expect(hook.getCurrent()?.bridge).toEqual(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            collectorId: 'browser_diagnostics:view_1:7:uuid_1',
            nonce: 'uuid_2',
            evalRequest: expect.objectContaining({
                evalRequestId: 'eval:view_1:7:1',
                viewId: 'view_1',
                navigationGeneration: 7,
                tier: 'injectedPage',
                expression: 'window.location.href',
                objectGroupId: 'browser_diagnostics:view_1:7',
                diagnosticsInteractionEnabled: true,
            }),
            getPropertiesRequest: expect.objectContaining({
                propertyRequestId: 'properties:view_1:7:2',
                objectId: 'object_1',
                objectGroupId: 'group_1',
                diagnosticsInteractionEnabled: true,
            }),
            releaseObjectGroupRequest: expect.objectContaining({
                releaseRequestId: 'release:view_1:7:3',
                objectGroupId: 'group_1',
                diagnosticsInteractionEnabled: true,
            }),
            elementPickerRequest: expect.objectContaining({
                pickerRequestId: 'picker:view_1:7:4',
                action: 'start',
                diagnosticsInteractionEnabled: true,
            }),
        }));
        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'enabled',
            pickerState: 'active',
        }));

        await act(async () => {
            hook.getCurrent()?.bridge?.onEvalResult?.({
                v: 1,
                evalRequestId: 'eval:view_1:7:1',
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                result: {
                    type: 'string',
                    value: 'https://preview.happier.test/dashboard',
                    preview: [],
                },
            });
            hook.getCurrent()?.bridge?.onPropertiesResult?.({
                v: 1,
                propertyRequestId: 'properties:view_1:7:2',
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                objectId: 'object_1',
                properties: [],
            });
            hook.getCurrent()?.bridge?.onReleaseObjectGroupResult?.({
                v: 1,
                releaseRequestId: 'release:view_1:7:3',
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                objectGroupId: 'group_1',
            });
            hook.getCurrent()?.bridge?.onElementPickerResult?.({
                v: 1,
                pickerRequestId: 'picker:view_1:7:4',
                viewId: 'view_1',
                navigationGeneration: 7,
                tier: 'injectedPage',
                status: 'cancelled',
                audited: true,
            });
        });

        expect(hook.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        expect(hook.getCurrent()?.bridge?.getPropertiesRequest).toBeUndefined();
        expect(hook.getCurrent()?.bridge?.releaseObjectGroupRequest).toBeUndefined();
        expect(hook.getCurrent()?.bridge?.elementPickerRequest).toBeUndefined();
        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'enabled',
            pickerState: 'idle',
        }));
    });

    it('fails closed without cryptographic token support', async () => {
        vi.stubGlobal('crypto', {});

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            bridge: null,
        }));
    });

    it('stores eval results and expanded object properties for the local-owner console instead of discarding them', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        await act(async () => {
            hook.getCurrent()?.interaction?.onEnableInteraction?.();
        });

        // The console submits an expression through the eval-console control surface (DEV-3).
        await act(async () => {
            expect(hook.getCurrent()?.interaction?.evalConsole?.onSubmitExpression('document.title')).toBe(true);
        });

        // Before the result arrives the entry is pending and reachable from the projection.
        expect(hook.getCurrent()?.interaction?.evalConsole?.entries).toEqual([
            expect.objectContaining({
                evalRequestId: 'eval:view_1:7:1',
                expression: 'document.title',
                status: 'pending',
            }),
        ]);

        await act(async () => {
            hook.getCurrent()?.bridge?.onEvalResult?.({
                v: 1,
                evalRequestId: 'eval:view_1:7:1',
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                result: {
                    type: 'object',
                    objectId: 'object_42',
                    className: 'HTMLDocument',
                    description: '#document',
                    preview: [{ name: 'title', valuePreview: 'Dashboard', truncated: false }],
                },
            });
        });

        // DEV-3: the completed result is STORED and rendered, not discarded.
        const completedEntry = hook.getCurrent()?.interaction?.evalConsole?.entries?.[0];
        expect(completedEntry).toEqual(expect.objectContaining({
            evalRequestId: 'eval:view_1:7:1',
            expression: 'document.title',
            status: 'completed',
            result: expect.objectContaining({
                type: 'object',
                objectId: 'object_42',
                className: 'HTMLDocument',
            }),
        }));

        // DEV-4: expanding the remote object loads its properties through getProperties and stores them.
        await act(async () => {
            expect(
                hook.getCurrent()?.interaction?.evalConsole?.onExpandObject(
                    'object_42',
                    completedEntry!.objectGroupId,
                ),
            ).toBe(true);
        });

        expect(hook.getCurrent()?.interaction?.evalConsole?.objectProperties?.object_42).toEqual(
            expect.objectContaining({ status: 'loading' }),
        );
        expect(hook.getCurrent()?.bridge?.getPropertiesRequest).toEqual(expect.objectContaining({
            objectId: 'object_42',
            objectGroupId: completedEntry!.objectGroupId,
        }));

        await act(async () => {
            hook.getCurrent()?.bridge?.onPropertiesResult?.({
                v: 1,
                propertyRequestId: hook.getCurrent()!.bridge!.getPropertiesRequest!.propertyRequestId,
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                objectId: 'object_42',
                properties: [
                    {
                        name: 'title',
                        value: { type: 'string', value: 'Dashboard', preview: [] },
                        enumerable: true,
                    },
                ],
            });
        });

        expect(hook.getCurrent()?.interaction?.evalConsole?.objectProperties?.object_42).toEqual(
            expect.objectContaining({
                status: 'loaded',
                properties: [
                    expect.objectContaining({
                        name: 'title',
                        value: expect.objectContaining({ type: 'string', value: 'Dashboard' }),
                    }),
                ],
            }),
        );

        // Navigation/clear releases the stored objects so they cannot leak across generations (DEV-4):
        // interaction resets to disabled and, when re-enabled on the new generation, the console is empty.
        await act(async () => {
            await hook.rerender({ view: createLocalPreviewView({ engineKind: 'nativeWebView', navigationGeneration: 8 }) });
        });
        expect(hook.getCurrent()?.interaction?.state).toBe('disabled');
        await act(async () => {
            hook.getCurrent()?.interaction?.onEnableInteraction?.();
        });
        expect(hook.getCurrent()?.interaction?.evalConsole?.entries).toEqual([]);
        expect(hook.getCurrent()?.interaction?.evalConsole?.objectProperties).toEqual({});
    });
});
