import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    applyBrowserDiagnosticEvents,
    createBrowserDiagnosticsUiStore,
    selectBrowserDiagnosticsForView,
} from '@/sync/domains/browser/diagnostics';

let lastWebViewProps: Readonly<Record<string, unknown>> | null = null;
let injectJavaScriptSpy: ReturnType<typeof vi.fn>;
let clearWebViewRefOnUnmount = false;

vi.mock('react-native-webview', () => ({
    WebView: React.forwardRef((props: Readonly<Record<string, unknown>>, ref: React.ForwardedRef<unknown>) => {
        lastWebViewProps = props;
        const instance = React.useMemo(() => ({ injectJavaScript: injectJavaScriptSpy }), []);
        if (typeof ref === 'function') {
            ref(instance);
        } else if (ref) {
            ref.current = instance;
        }
        React.useLayoutEffect(() => () => {
            if (!clearWebViewRefOnUnmount) return;
            if (typeof ref === 'function') ref(null);
            else if (ref) ref.current = null;
        }, [ref]);
        return React.createElement('WebView', props);
    }),
}));

describe('NativeWebViewEngine', () => {
    it.each(['unmount', 'source replacement', 'navigation'] as const)('does not inject a pending reply after %s', async (retirement) => {
        clearWebViewRefOnUnmount = true;
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        let finish!: (value: unknown) => void;
        const pending = new Promise((resolve) => { finish = resolve; });
        const bridge = { onMessage: () => pending };
        const render = (html: string) => <NativeWebViewEngine title="Inline" html={html} testID="inline-frame" originWhitelist={[]} nativeMessageBridge={bridge} />;
        const screen = await renderScreen(render('<p>First</p>'));
        const message = lastWebViewProps?.onMessage as (event: unknown) => void;
        await act(async () => message({ nativeEvent: { data: 'request', url: 'about:blank' } }));
        if (retirement === 'unmount') {
            await screen.unmount();
        } else if (retirement === 'source replacement') {
            await screen.update(render('<p>Replacement</p>'));
        } else {
            const loadEnd = lastWebViewProps?.onLoadEnd as (event: unknown) => void;
            const loadStart = lastWebViewProps?.onLoadStart as (event: unknown) => void;
            await act(async () => {
                loadEnd({ nativeEvent: { url: 'about:blank' } });
                loadStart({ nativeEvent: { url: 'about:blank' } });
            });
        }
        await act(async () => { finish({ result: 'retired-data' }); });
        expect(injectJavaScriptSpy).not.toHaveBeenCalled();
    });

    it('loads inline documents without permitting external navigation or file access', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        await renderScreen(<NativeWebViewEngine title="Inline" html="<p>Hello</p>" testID="inline-frame" originWhitelist={[]} />);
        expect(lastWebViewProps?.source).toEqual({ html: '<p>Hello</p>', baseUrl: 'about:blank' });
        // RNWebView otherwise invokes Linking.openURL before the custom guard.
        expect(lastWebViewProps?.originWhitelist).toEqual(['*']);
        const guard = lastWebViewProps?.onShouldStartLoadWithRequest as (request: { url: string }) => boolean;
        expect(guard({ url: 'about:blank' })).toBe(true);
        expect(guard({ url: 'about:blank#section' })).toBe(true);
        for (const url of ['about:blank?query', 'about:srcdoc', 'https://external.example', 'file:///private/item', 'javascript:alert(1)', 'data:text/html,unsafe']) {
            expect(guard({ url })).toBe(false);
        }
        expect(lastWebViewProps).toMatchObject({ allowFileAccess: false, allowFileAccessFromFileURLs: false, allowUniversalAccessFromFileURLs: false, domStorageEnabled: false, cacheEnabled: false });
    });
    it('retires an inline guest on replacement navigation after its initial load completes', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const onUnexpectedNavigation = vi.fn();
        await renderScreen(<NativeWebViewEngine title="Inline" html="<p>Hello</p>" testID="inline-frame" originWhitelist={[]} onUnexpectedNavigation={onUnexpectedNavigation} />);
        const loadStart = lastWebViewProps?.onLoadStart as (event: unknown) => void;
        const loadEnd = lastWebViewProps?.onLoadEnd as (event: unknown) => void;
        const event = { nativeEvent: { url: 'about:blank' } };
        loadStart(event);
        loadEnd(event);
        expect(onUnexpectedNavigation).not.toHaveBeenCalled();
        loadStart(event);
        expect(onUnexpectedNavigation).toHaveBeenCalledTimes(1);
    });
    it('preserves inline fragment navigation but retires a reload after a fragment change', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const onUnexpectedNavigation = vi.fn();
        await renderScreen(<NativeWebViewEngine title="Inline" html="<p id=section>Hello</p>" testID="inline-frame" originWhitelist={[]} onUnexpectedNavigation={onUnexpectedNavigation} />);
        const loadStart = lastWebViewProps?.onLoadStart as (event: unknown) => void;
        const loadEnd = lastWebViewProps?.onLoadEnd as (event: unknown) => void;
        loadEnd({ nativeEvent: { url: 'about:blank' } });
        for (const url of ['about:blank#section', 'about:blank', 'about:blank#section']) {
            loadStart({ nativeEvent: { url } });
            loadEnd({ nativeEvent: { url } });
            expect(onUnexpectedNavigation).not.toHaveBeenCalled();
        }
        loadStart({ nativeEvent: { url: 'about:blank#section' } });
        expect(onUnexpectedNavigation).toHaveBeenCalledTimes(1);
    });
    beforeEach(() => {
        lastWebViewProps = null;
        injectJavaScriptSpy = vi.fn();
        clearWebViewRefOnUnmount = false;
    });

    it('applies an origin allowlist and blocks navigation outside the allowlist', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const onBlockedNavigation = vi.fn();

        await renderScreen(
            <NativeWebViewEngine
                title="Preview"
                url="https://preview.example.test/app"
                testID="browser-native-frame"
                originWhitelist={['https://preview.example.test']}
                onBlockedNavigation={onBlockedNavigation}
            />,
        );

        expect(lastWebViewProps?.originWhitelist).toEqual(['https://preview.example.test']);
        expect(lastWebViewProps?.source).toEqual({ uri: 'https://preview.example.test/app' });

        const guard = lastWebViewProps?.onShouldStartLoadWithRequest;
        expect(guard).toBeTypeOf('function');

        expect((guard as (request: { url: string }) => boolean)({
            url: 'https://preview.example.test/next',
        })).toBe(true);
        expect((guard as (request: { url: string }) => boolean)({
            url: 'https://evil.example.test/',
        })).toBe(false);
        expect(onBlockedNavigation).toHaveBeenCalledWith('https://evil.example.test/');
    });

    it('injects native bridge responses back into the WebView page', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');

        await renderScreen(
            <NativeWebViewEngine
                title="Preview"
                url="https://preview.example.test/app"
                testID="browser-native-frame"
                originWhitelist={['https://preview.example.test']}
                nativeMessageBridge={{
                    onMessage: () => ({
                        version: 1,
                        kind: 'ack',
                        payload: { accepted: true },
                    }),
                }}
            />,
        );

        const onMessage = lastWebViewProps?.onMessage as (event: {
            nativeEvent: { data: string; url: string };
        }) => void;
        await act(async () => {
            onMessage({
                nativeEvent: {
                    data: JSON.stringify({ kind: 'ready' }),
                    url: 'https://preview.example.test/app',
                },
            });
            await Promise.resolve();
        });

        expect(injectJavaScriptSpy).toHaveBeenCalledWith(expect.stringContaining('\\\"kind\\\":\\\"ack\\\"'));
        expect(injectJavaScriptSpy).toHaveBeenCalledWith(expect.stringContaining('\\\"accepted\\\":true'));
    });

    it('issues one activation only after a touch on the exact mounted WebView', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const receipts: Array<Readonly<{ consumeTransientActivation(): boolean }>> = [];

        await renderScreen(
            <NativeWebViewEngine
                title="Inline"
                html="<button>Send</button>"
                testID="inline-frame"
                originWhitelist={[]}
                nativeMessageBridge={{
                    onMessage: (...args: unknown[]) => {
                        receipts.push(args[1] as Readonly<{ consumeTransientActivation(): boolean }>);
                    },
                }}
            />,
        );
        const onMessage = lastWebViewProps?.onMessage as (event: unknown) => void;
        const onFocus = lastWebViewProps?.onFocus as (() => void) | undefined;
        const onTouchStart = lastWebViewProps?.onTouchStart as (() => void) | undefined;
        const onBlur = lastWebViewProps?.onBlur as (() => void) | undefined;

        onFocus?.();
        await act(async () => onMessage({ nativeEvent: { data: 'programmatic-focus', url: 'about:blank' } }));
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(false);

        onTouchStart?.();
        await act(async () => onMessage({ nativeEvent: { data: 'genuine-touch', url: 'about:blank' } }));
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(true);
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(false);
        await act(async () => onMessage({ nativeEvent: { data: 'replay', url: 'about:blank' } }));
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(false);

        onBlur?.();
        onTouchStart?.();
        await act(async () => onMessage({ nativeEvent: { data: 'next-genuine-touch', url: 'about:blank' } }));
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(true);
    });

    it.each(['url', 'html'] as const)('keeps the host-message attachment live through native %s view teardown', async (sourceKind) => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const attachHostMessages = vi.fn<(send: (message: unknown) => void) => () => void>();
        attachHostMessages.mockImplementation((send) => () => {
            send({ kind: 'hostApi', payload: { kind: 'disconnected' } });
        });
        clearWebViewRefOnUnmount = true;

        const screen = await renderScreen(
            <NativeWebViewEngine
                title="Preview"
                {...(sourceKind === 'html' ? { html: '<p>Hello</p>' } : { url: 'https://preview.example.test/app' })}
                testID="browser-native-frame"
                originWhitelist={['https://preview.example.test']}
                nativeMessageBridge={{
                    onMessage: () => undefined,
                    attachHostMessages,
                }}
            />,
        );

        await screen.unmount();

        expect(attachHostMessages).toHaveBeenCalledTimes(1);
        expect(injectJavaScriptSpy).toHaveBeenCalledWith(expect.stringContaining('\\\"disconnected\\\"'));
    });

    it('wires injected diagnostics messages into the shared browser diagnostics store only for the current collector', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const rejectedMessages: string[] = [];
        let store = createBrowserDiagnosticsUiStore();

        await renderScreen(
            <NativeWebViewEngine
                title="Preview"
                url="https://preview.example.test/app"
                testID="browser-native-frame"
                originWhitelist={['https://preview.example.test']}
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 4,
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    collectorVersion: '1.0.0',
                    onEvents: (events) => {
                        store = applyBrowserDiagnosticEvents(store, { events });
                    },
                    onRejectedMessage: (reasonCode) => {
                        rejectedMessages.push(reasonCode);
                    },
                }}
            />,
        );

        expect(lastWebViewProps?.injectedJavaScript).toEqual(expect.stringContaining('"nonce":"nonce_1"'));
        expect(lastWebViewProps?.injectedJavaScript).toEqual(expect.stringContaining('__happierBrowserDiagnostics'));
        expect(lastWebViewProps?.onMessage).toBeTypeOf('function');

        const onMessage = lastWebViewProps?.onMessage as (event: { nativeEvent: { data: string } }) => void;
        onMessage({
            nativeEvent: {
                data: JSON.stringify({
                    v: 1,
                    kind: 'browser.diagnostics.events',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 4,
                    collector: {
                        collectorId: 'collector_1',
                        nonce: 'nonce_1',
                        version: '1.0.0',
                    },
                    events: [
                        {
                            v: 1,
                            eventId: 'evt_console_1',
                            browserSessionId: 'browser_session_1',
                            viewId: 'view_1',
                            navigationGeneration: 4,
                            capturedAtMs: 2_000,
                            family: 'console',
                            kind: 'console.entry',
                            fidelity: 'injectedPage',
                            trusted: false,
                            collector: {
                                collectorId: 'collector_1',
                                nonce: 'nonce_1',
                                version: '1.0.0',
                            },
                            data: {
                                level: 'log',
                                textPreview: 'ready',
                            },
                            redaction: {
                                level: 'metadataOnly',
                            },
                        },
                    ],
                }),
            },
        });
        onMessage({
            nativeEvent: {
                data: JSON.stringify({
                    v: 1,
                    kind: 'browser.diagnostics.events',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 3,
                    collector: {
                        collectorId: 'collector_1',
                        nonce: 'nonce_1',
                        version: '1.0.0',
                    },
                    events: [],
                }),
            },
        });
        onMessage({
            nativeEvent: {
                data: JSON.stringify({
                    v: 1,
                    kind: 'browser.diagnostics.events',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 4,
                    collector: {
                        collectorId: 'collector_1',
                        nonce: 'wrong_nonce',
                        version: '1.0.0',
                    },
                    events: [],
                }),
            },
        });

        expect(selectBrowserDiagnosticsForView(store, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).toMatchObject({
            status: 'available',
            eventCount: 1,
            fidelity: 'injectedPage',
            trusted: false,
        });
        expect(rejectedMessages).toEqual(['navigation_stale', 'collector_mismatch']);
    });

    it('emits redacted nativeCallback page-info and unavailable diagnostics from WebView callbacks', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const onDiagnosticsEvents = vi.fn();

        await renderScreen(
            <NativeWebViewEngine
                title="Preview"
                url="https://preview.example.test/app"
                testID="browser-native-frame"
                originWhitelist={['https://preview.example.test']}
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 5,
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    collectorVersion: '1.0.0',
                    onEvents: onDiagnosticsEvents,
                }}
            />,
        );

        const onLoadEnd = lastWebViewProps?.onLoadEnd as (event: {
            nativeEvent: { url: string; loading: boolean; title?: string };
        }) => void;
        onLoadEnd({
            nativeEvent: {
                url: 'https://preview.example.test/app?token=secret#panel',
                loading: false,
                title: 'Preview',
            },
        });

        const onError = lastWebViewProps?.onError as (event: {
            nativeEvent: { code?: string; description?: string };
        }) => void;
        onError({
            nativeEvent: {
                code: 'ERR_FAILED',
                description: 'Load failed',
            },
        });

        expect(onDiagnosticsEvents).toHaveBeenNthCalledWith(1, [
            expect.objectContaining({
                family: 'pageInfo',
                kind: 'pageInfo.snapshot',
                fidelity: 'nativeCallback',
                trusted: true,
                data: {
                    url: 'https://preview.example.test/app',
                    loading: false,
                    title: 'Preview',
                },
            }),
        ]);
        expect(onDiagnosticsEvents).toHaveBeenNthCalledWith(2, [
            expect.objectContaining({
                family: 'pageInfo',
                kind: 'diagnostics.unavailable',
                fidelity: 'nativeCallback',
                trusted: true,
                unavailableReason: 'collector_unavailable',
                data: {
                    errorCode: 'ERR_FAILED',
                },
            }),
        ]);
    });

    it('injects eval requests and routes nonce-bound eval results through diagnostics', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const onEvalResult = vi.fn();
        const onPropertiesResult = vi.fn();
        const onReleaseObjectGroupResult = vi.fn();
        const onElementPickerResult = vi.fn();

        await renderScreen(
            <NativeWebViewEngine
                title="Preview"
                url="https://preview.example.test/app"
                testID="browser-native-frame"
                originWhitelist={['https://preview.example.test']}
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 5,
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    collectorVersion: '1.0.0',
                    evalRequest: {
                        v: 1,
                        evalRequestId: 'eval_1',
                        viewId: 'view_1',
                        navigationGeneration: 5,
                        tier: 'injectedPage',
                        expression: '({ ok: true })',

                        objectGroupId: 'group_1',
                        diagnosticsInteractionEnabled: true,
                    },
                    getPropertiesRequest: {
                        v: 1,
                        propertyRequestId: 'props_1',
                        viewId: 'view_1',
                        navigationGeneration: 5,
                        tier: 'injectedPage',
                        objectId: 'obj_1',
                        objectGroupId: 'group_1',
                        diagnosticsInteractionEnabled: true,
                    },
                    releaseObjectGroupRequest: {
                        v: 1,
                        releaseRequestId: 'release_1',
                        viewId: 'view_1',
                        navigationGeneration: 5,
                        tier: 'injectedPage',
                        objectGroupId: 'group_1',
                        diagnosticsInteractionEnabled: true,
                    },
                    elementPickerRequest: {
                        v: 1,
                        pickerRequestId: 'picker_1',
                        viewId: 'view_1',
                        navigationGeneration: 5,
                        tier: 'injectedPage',
                        action: 'start',
                        diagnosticsInteractionEnabled: true,
                    },
                    onEvents: vi.fn(),
                    onEvalResult,
                    onPropertiesResult,
                    onReleaseObjectGroupResult,
                    onElementPickerResult,
                }}
            />,
        );

        expect(injectJavaScriptSpy).toHaveBeenCalledWith(expect.stringContaining('__happierBrowserDiagnostics.evaluate'));
        expect(injectJavaScriptSpy).toHaveBeenCalledWith(expect.stringContaining('__happierBrowserDiagnostics.getProperties'));
        expect(injectJavaScriptSpy).toHaveBeenCalledWith(expect.stringContaining('__happierBrowserDiagnostics.releaseObjectGroup'));
        expect(injectJavaScriptSpy).toHaveBeenCalledWith(expect.stringContaining('__happierBrowserDiagnostics.elementPicker'));

        const onMessage = lastWebViewProps?.onMessage as (event: { nativeEvent: { data: string } }) => void;
        onMessage({
            nativeEvent: {
                data: JSON.stringify({
                    v: 1,
                    kind: 'browser.diagnostics.evalResult',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 5,
                    collector: {
                        collectorId: 'collector_1',
                        nonce: 'nonce_1',
                        version: '1.0.0',
                    },
                    result: {
                        v: 1,
                        evalRequestId: 'eval_1',
                        viewId: 'view_1',
                        navigationGeneration: 5,
                        status: 'completed',
                        tier: 'injectedPage',
                        audited: true,
                        result: {
                            type: 'object',
                            objectId: 'obj_1',
                            className: 'Object',
                            description: 'Object',
                        },
                    },
                }),
            },
        });

        expect(onEvalResult).toHaveBeenCalledWith(expect.objectContaining({
            evalRequestId: 'eval_1',
            status: 'completed',
        }));

        onMessage({
            nativeEvent: {
                data: JSON.stringify({
                    v: 1,
                    kind: 'browser.diagnostics.getPropertiesResult',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 5,
                    collector: {
                        collectorId: 'collector_1',
                        nonce: 'nonce_1',
                        version: '1.0.0',
                    },
                    result: {
                        v: 1,
                        propertyRequestId: 'props_1',
                        viewId: 'view_1',
                        navigationGeneration: 5,
                        tier: 'injectedPage',
                        status: 'completed',
                        audited: true,
                        objectId: 'obj_1',
                        properties: [{ name: 'ok', value: { type: 'boolean', value: true }, enumerable: true }],
                    },
                }),
            },
        });
        onMessage({
            nativeEvent: {
                data: JSON.stringify({
                    v: 1,
                    kind: 'browser.diagnostics.releaseObjectGroupResult',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 5,
                    collector: {
                        collectorId: 'collector_1',
                        nonce: 'nonce_1',
                        version: '1.0.0',
                    },
                    result: {
                        v: 1,
                        releaseRequestId: 'release_1',
                        viewId: 'view_1',
                        navigationGeneration: 5,
                        tier: 'injectedPage',
                        status: 'completed',
                        audited: true,
                        objectGroupId: 'group_1',
                    },
                }),
            },
        });
        onMessage({
            nativeEvent: {
                data: JSON.stringify({
                    v: 1,
                    kind: 'browser.diagnostics.elementPickerResult',
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 5,
                    collector: {
                        collectorId: 'collector_1',
                        nonce: 'nonce_1',
                        version: '1.0.0',
                    },
                    result: {
                        v: 1,
                        pickerRequestId: 'picker_1',
                        viewId: 'view_1',
                        navigationGeneration: 5,
                        tier: 'injectedPage',
                        status: 'selected',
                        audited: true,
                        backendNodeRef: 'node_1',
                        selectorPath: 'html > body > main:nth-of-type(1)',
                        rect: { x: 10, y: 20, width: 300, height: 40 },
                        accessibleName: 'Run',
                    },
                }),
            },
        });

        expect(onPropertiesResult).toHaveBeenCalledWith(expect.objectContaining({
            propertyRequestId: 'props_1',
            properties: [expect.objectContaining({ name: 'ok' })],
        }));
        expect(onReleaseObjectGroupResult).toHaveBeenCalledWith(expect.objectContaining({
            releaseRequestId: 'release_1',
            objectGroupId: 'group_1',
        }));
        expect(onElementPickerResult).toHaveBeenCalledWith(expect.objectContaining({
            pickerRequestId: 'picker_1',
            backendNodeRef: 'node_1',
            selectorPath: 'html > body > main:nth-of-type(1)',
        }));
    });

    it('does not publish raw native WebView error descriptions as diagnostics error codes', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const onDiagnosticsEvents = vi.fn();

        await renderScreen(
            <NativeWebViewEngine
                title="Preview"
                url="https://preview.example.test/app"
                testID="browser-native-frame"
                originWhitelist={['https://preview.example.test']}
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 5,
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    collectorVersion: '1.0.0',
                    onEvents: onDiagnosticsEvents,
                }}
            />,
        );

        const onError = lastWebViewProps?.onError as (event: {
            nativeEvent: { code?: string; description?: string };
        }) => void;
        onError({
            nativeEvent: {
                description: 'Failed to load https://preview.example.test/app?token=secret',
            },
        });

        expect(onDiagnosticsEvents).toHaveBeenCalledWith([
            expect.objectContaining({
                kind: 'diagnostics.unavailable',
                data: {
                    errorCode: 'webview_load_failed',
                },
            }),
        ]);
        expect(JSON.stringify(onDiagnosticsEvents.mock.calls)).not.toContain('secret');
        expect(JSON.stringify(onDiagnosticsEvents.mock.calls)).not.toContain('token');
    });

    it('reports native history state so the toolbar can enable Back after a navigation', async () => {
        const { NativeWebViewEngine } = await import('./NativeWebViewEngine');
        const {
            applyBrowserControlEvent,
            browserViewLifecycleEvent,
            createBrowserControlState,
        } = await import('@/sync/domains/browser/control');
        const { selectBrowserToolbarModel } = await import('@/sync/domains/browser/shell');
        const { buildBrowserAdapterCapabilities } = await import('@/sync/domains/browser/adapters/capabilities');

        let state = applyBrowserControlEvent(createBrowserControlState(), {
            kind: 'viewOpened',
            eventId: 'event_view',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            target: {
                kind: 'externalUrl',
                targetId: 'external_example',
                url: 'https://example.test/',
            },
            platform: 'ios',
            currentUrl: 'https://example.test/',
            adapterKind: 'externalUrl',
            engineKind: 'nativeWebView',
            adapterCapabilities: buildBrowserAdapterCapabilities({
                adapterKind: 'externalUrl',
                supportedTargetKinds: ['externalUrl'],
                supportedRenderEngines: ['nativeWebView'],
            }),
            occurredAt: 1,
        });
        // The engine declares back/forward as a capability, but no history state has been reported
        // yet, so the toolbar must stay disabled.
        expect(state.viewsById.view_1.adapterCapabilities.navigation.canGoBack).toBe(true);
        expect(selectBrowserToolbarModel(state.viewsById.view_1).canGoBack).toBe(false);

        await renderScreen(
            <NativeWebViewEngine
                title="Example"
                url="https://example.test/"
                testID="browser-native-frame"
                originWhitelist={['*']}
                onNavigationStateChange={(navigationState) => {
                    const event = browserViewLifecycleEvent(
                        { browserSessionId: 'browser_session_1', viewId: 'view_1' },
                        { kind: 'navigationStateChanged', ...navigationState },
                    );
                    if (event) {
                        state = applyBrowserControlEvent(state, event);
                    }
                }}
            />,
        );

        const onNavigationStateChange = lastWebViewProps?.onNavigationStateChange;
        expect(onNavigationStateChange).toBeTypeOf('function');

        act(() => {
            (onNavigationStateChange as (navigationState: Readonly<Record<string, unknown>>) => void)({
                url: 'https://example.test/page-2',
                title: 'Page 2',
                loading: false,
                canGoBack: true,
                canGoForward: false,
            });
        });

        const toolbar = selectBrowserToolbarModel(state.viewsById.view_1);
        expect(toolbar.canGoBack).toBe(true);
        expect(toolbar.canGoForward).toBe(false);
        expect(state.viewsById.view_1.currentUrl).toBe('https://example.test/page-2');
        expect(state.viewsById.view_1.loadingState).toBe('ready');
    });
});
