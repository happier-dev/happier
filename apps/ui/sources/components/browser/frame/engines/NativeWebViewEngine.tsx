import * as React from 'react';
import { WebView } from 'react-native-webview';

import {
    buildInjectedBrowserDiagnosticsElementPickerCommandScript,
    buildInjectedBrowserDiagnosticsEvalCommandScript,
    buildInjectedBrowserDiagnosticsGetPropertiesCommandScript,
    buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScript,
    buildInjectedBrowserDiagnosticsScript,
    createNativeWebViewPageInfoDiagnosticEvent,
    createNativeWebViewUnavailableDiagnosticEvent,
    parseInjectedBrowserDiagnosticsMessage,
} from '../../adapters/diagnostics';
import { createNativeWebViewAutomationOwner } from '../../adapters/automation';
import { createBrowserNativeNavigationGuard } from '@/sync/domains/browser/adapters/nativeNavigation';

import type {
    BrowserAutomationEngineBridgeConfig,
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
    BrowserFrameNavigationState,
    BrowserNativeFrameMessageBridgeConfig,
} from '../types';

/**
 * The `WebViewNavigation` payload `react-native-webview` hands to `onNavigationStateChange`. It is
 * the raw nativeEvent (the library unwraps it before calling), and it fires from the load-start and
 * load-finish paths only — never from the error path.
 */
type NativeWebViewNavigationState = Readonly<{
    canGoBack?: boolean;
    canGoForward?: boolean;
    loading?: boolean;
    title?: string;
    url?: string;
}>;

type NativeWebViewCallbackEvent = Readonly<{
    nativeEvent?: Readonly<{
        code?: number | string;
        data?: string;
        description?: string;
        loading?: boolean;
        title?: string;
        url?: string;
    }>;
}>;

type NativeWebViewInstance = WebView<unknown>;

function readNativeErrorCode(event: NativeWebViewCallbackEvent | undefined, fallback: string): string {
    const code = event?.nativeEvent?.code;
    if (code !== undefined && code !== null && String(code).trim().length > 0) {
        return String(code);
    }

    return fallback;
}

function buildNativeBridgeResponseScript(response: unknown): string {
    const data = JSON.stringify(JSON.stringify(response));
    return [
        '(function(){',
        `var data=${data};`,
        'var event;',
        'try {',
        'event = new MessageEvent("message", { data: data });',
        '} catch (error) {',
        'event = document.createEvent("MessageEvent");',
        'event.initMessageEvent("message", false, false, data, "*", "", null, null);',
        '}',
        'window.dispatchEvent(event);',
        'document.dispatchEvent(event);',
        '})();',
        'true;',
    ].join('');
}

export function NativeWebViewEngine(props: Readonly<{
    title: string;
    url: string;
    testID: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    originWhitelist: readonly string[];
    javaScriptEnabled?: boolean;
    mixedContentMode?: 'never' | 'compatibility' | 'always';
    onLoadStart?: () => void;
    onLoadEnd?: () => void;
    onError?: () => void;
    /**
     * G4: the ONLY producer of back/forward history truth for this engine. `WebView` reports a full
     * navigation snapshot on every load start and load end; the adapter turns it into the
     * `navigationStateChanged` lifecycle signal so the toolbar's Back/Forward can enable.
     */
    onNavigationStateChange?: (navigationState: BrowserFrameNavigationState) => void;
    onBlockedNavigation?: (url: string) => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    nativeMessageBridge?: BrowserNativeFrameMessageBridgeConfig;
}>): React.ReactElement {
    const webViewRef = React.useRef<NativeWebViewInstance | null>(null);
    const automationMessageListenersRef = React.useRef(new Set<(raw: string) => void>());
    const setWebViewRef = React.useCallback((instance: NativeWebViewInstance | null) => {
        webViewRef.current = instance;
    }, []);
    const shouldStartLoad = React.useMemo(() => createBrowserNativeNavigationGuard({
        allowedOrigins: props.originWhitelist,
        onBlockedNavigation: props.onBlockedNavigation,
    }), [props.onBlockedNavigation, props.originWhitelist]);
    const diagnosticsEventSequenceRef = React.useRef(0);

    const nextNativeDiagnosticsEventId = React.useCallback((kind: string): string => {
        const diagnostics = props.diagnostics;
        diagnosticsEventSequenceRef.current += 1;
        return [
            diagnostics?.collectorId ?? 'native',
            diagnostics?.navigationGeneration ?? 0,
            'nativeCallback',
            kind,
            diagnosticsEventSequenceRef.current,
        ].join(':');
    }, [props.diagnostics]);

    const emitNativePageInfo = React.useCallback((
        event: NativeWebViewCallbackEvent | undefined,
        loading: boolean,
    ) => {
        const diagnostics = props.diagnostics;
        if (!diagnostics) return;

        diagnostics.onEvents([
            createNativeWebViewPageInfoDiagnosticEvent({
                eventId: nextNativeDiagnosticsEventId('pageInfo.snapshot'),
                browserSessionId: diagnostics.browserSessionId,
                viewId: diagnostics.viewId,
                navigationGeneration: diagnostics.navigationGeneration,
                capturedAtMs: Date.now(),
                url: event?.nativeEvent?.url ?? props.url,
                loading: event?.nativeEvent?.loading ?? loading,
                title: event?.nativeEvent?.title,
            }),
        ]);
    }, [nextNativeDiagnosticsEventId, props.diagnostics, props.url]);

    const emitNativeUnavailable = React.useCallback((
        event: NativeWebViewCallbackEvent | undefined,
        unavailableReason: 'collector_unavailable' | 'page_crashed',
        fallbackErrorCode: string,
    ) => {
        const diagnostics = props.diagnostics;
        if (!diagnostics) return;

        diagnostics.onEvents([
            createNativeWebViewUnavailableDiagnosticEvent({
                eventId: nextNativeDiagnosticsEventId('diagnostics.unavailable'),
                browserSessionId: diagnostics.browserSessionId,
                viewId: diagnostics.viewId,
                navigationGeneration: diagnostics.navigationGeneration,
                capturedAtMs: Date.now(),
                unavailableReason,
                errorCode: readNativeErrorCode(event, fallbackErrorCode),
            }),
        ]);
    }, [nextNativeDiagnosticsEventId, props.diagnostics]);

    const handleLoadStart = React.useCallback((event: NativeWebViewCallbackEvent) => {
        props.onLoadStart?.();
        emitNativePageInfo(event, true);
    }, [emitNativePageInfo, props.onLoadStart]);

    const handleLoadEnd = React.useCallback((event: NativeWebViewCallbackEvent) => {
        props.onLoadEnd?.();
        emitNativePageInfo(event, false);
    }, [emitNativePageInfo, props.onLoadEnd]);

    const handleLoadError = React.useCallback((event: NativeWebViewCallbackEvent) => {
        props.onError?.();
        emitNativeUnavailable(event, 'collector_unavailable', 'webview_load_failed');
    }, [emitNativeUnavailable, props.onError]);

    const onNavigationStateChangeProp = props.onNavigationStateChange;
    const handleNavigationStateChange = React.useCallback((navigationState: NativeWebViewNavigationState) => {
        onNavigationStateChangeProp?.({
            url: navigationState.url ?? props.url,
            title: navigationState.title ?? null,
            loading: navigationState.loading === true,
            canGoBack: navigationState.canGoBack === true,
            canGoForward: navigationState.canGoForward === true,
        });
    }, [onNavigationStateChangeProp, props.url]);

    const handleProcessCrash = React.useCallback(() => {
        props.onError?.();
        emitNativeUnavailable(undefined, 'page_crashed', 'webview_process_crashed');
    }, [emitNativeUnavailable, props.onError]);

    const injectedJavaScript = React.useMemo(() => {
        const diagnostics = props.diagnostics;
        if (!diagnostics || props.javaScriptEnabled === false) return undefined;

        return buildInjectedBrowserDiagnosticsScript({
            browserSessionId: diagnostics.browserSessionId,
            viewId: diagnostics.viewId,
            navigationGeneration: diagnostics.navigationGeneration,
            collectorId: diagnostics.collectorId,
            nonce: diagnostics.nonce,
            version: diagnostics.collectorVersion,
            ownerConsoleValueCapture: diagnostics.consoleValueCapture === true,
            ownerDiagnosticsValueCapture: diagnostics.valueCapture === true,
        });
    }, [props.diagnostics, props.javaScriptEnabled]);

    // Teardown runs in the layout phase so the bridge owner can send its one
    // terminal message through this exact WebView before React clears the
    // native ref and the delivery primitive is returned.
    React.useLayoutEffect(() => {
        const automation = props.automation;
        if (!automation || props.javaScriptEnabled === false) return;
        if (automation.supportedActions.length === 0) return;

        const ownerId = [
            'browser_automation_owner',
            automation.browserSessionId,
            automation.viewId,
            automation.navigationGeneration,
            'nativeWebView',
        ].join(':');
        const owner = createNativeWebViewAutomationOwner({
            ownerId,
            browserSessionId: automation.browserSessionId,
            viewId: automation.viewId,
            navigationGeneration: automation.navigationGeneration,
            adapterKind: automation.adapterKind,
            collectorId: automation.collectorId,
            nonce: automation.nonce,
            capabilityVersion: automation.capabilityVersion,
            supportedActions: automation.supportedActions,
            injectJavaScript(script) {
                webViewRef.current?.injectJavaScript?.(script);
            },
            subscribeToMessages(listener) {
                automationMessageListenersRef.current.add(listener);
                return () => {
                    automationMessageListenersRef.current.delete(listener);
                };
            },
            nowMs: automation.nowMs ?? Date.now,
        });
        const registration = automation.controlService.registerOwner(owner);
        if (!registration.ok) {
            automation.onRegistrationRejected?.(registration.reasonCode);
            return;
        }

        return () => {
            automation.controlService.unregisterOwner({
                ownerId,
                reasonCode: 'owner_disconnected',
            });
        };
    }, [props.automation, props.javaScriptEnabled]);

    // EU-8: the host->frame push direction on native. The WebView has no
    // `contentWindow`, so the delivery primitive is the SAME injected
    // `MessageEvent` dispatch the response path already uses — one script
    // builder, so a push and a reply cannot arrive in two different shapes.
    // Scripts disabled means nothing can receive the message, so nothing is
    // attached.
    // Keep the lent delivery primitive available through terminal bridge
    // disposal. Passive cleanup runs after React clears the native ref, which
    // would drop the canonical disconnect addressed to this incumbent view.
    React.useLayoutEffect(() => {
        const attach = props.nativeMessageBridge?.attachHostMessages;
        if (!attach || props.javaScriptEnabled === false) return;
        return attach((message: unknown) => {
            webViewRef.current?.injectJavaScript?.(buildNativeBridgeResponseScript(message));
        });
    }, [props.javaScriptEnabled, props.nativeMessageBridge]);

    const handleWebViewMessage = React.useCallback((event: NativeWebViewCallbackEvent) => {
        const diagnostics = props.diagnostics;
        const data = event.nativeEvent?.data;
        if (typeof data === 'string') {
            for (const listener of automationMessageListenersRef.current) {
                listener(data);
            }
        } else if (props.automation) {
            props.automation.onRejectedMessage?.('schema_invalid');
        }
        if (props.nativeMessageBridge) {
            Promise.resolve(props.nativeMessageBridge.onMessage(event)).then((response) => {
                if (response === undefined || response === null) return;
                webViewRef.current?.injectJavaScript?.(buildNativeBridgeResponseScript(response));
            }).catch(() => undefined);
        }
        if (!diagnostics || props.javaScriptEnabled === false || typeof data !== 'string') return;

        const parsed = parseInjectedBrowserDiagnosticsMessage(data, {
            browserSessionId: diagnostics.browserSessionId,
            viewId: diagnostics.viewId,
            navigationGeneration: diagnostics.navigationGeneration,
            collectorId: diagnostics.collectorId,
            nonce: diagnostics.nonce,
        }, {
            consoleValueCapture: diagnostics.consoleValueCapture === true,
            valueCapture: diagnostics.valueCapture === true,
        });
        if (parsed.ok) {
            if (parsed.events) {
                diagnostics.onEvents(parsed.events);
                return;
            }
            if (parsed.evalResult) {
                diagnostics.onEvalResult?.(parsed.evalResult);
                return;
            }
            if (parsed.propertiesResult) {
                diagnostics.onPropertiesResult?.(parsed.propertiesResult);
                return;
            }
            if (parsed.releaseResult) {
                diagnostics.onReleaseObjectGroupResult?.(parsed.releaseResult);
                return;
            }
            if (parsed.elementPickerResult) {
                diagnostics.onElementPickerResult?.(parsed.elementPickerResult);
                return;
            }
            return;
        }
        diagnostics.onRejectedMessage?.(parsed.reasonCode);
    }, [props.automation, props.diagnostics, props.javaScriptEnabled, props.nativeMessageBridge]);

    React.useEffect(() => {
        const diagnostics = props.diagnostics;
        const evalRequest = diagnostics?.evalRequest;
        if (!diagnostics || !evalRequest || props.javaScriptEnabled === false) return;

        webViewRef.current?.injectJavaScript?.(buildInjectedBrowserDiagnosticsEvalCommandScript({
            browserSessionId: diagnostics.browserSessionId,
            collectorId: diagnostics.collectorId,
            nonce: diagnostics.nonce,
            version: diagnostics.collectorVersion,
            request: evalRequest,
        }));
    }, [props.diagnostics, props.javaScriptEnabled]);

    React.useEffect(() => {
        const diagnostics = props.diagnostics;
        const getPropertiesRequest = diagnostics?.getPropertiesRequest;
        const releaseObjectGroupRequest = diagnostics?.releaseObjectGroupRequest;
        const elementPickerRequest = diagnostics?.elementPickerRequest;
        if (!diagnostics || props.javaScriptEnabled === false) return;

        if (getPropertiesRequest) {
            webViewRef.current?.injectJavaScript?.(buildInjectedBrowserDiagnosticsGetPropertiesCommandScript({
                browserSessionId: diagnostics.browserSessionId,
                collectorId: diagnostics.collectorId,
                nonce: diagnostics.nonce,
                version: diagnostics.collectorVersion,
                request: getPropertiesRequest,
            }));
        }

        if (releaseObjectGroupRequest) {
            webViewRef.current?.injectJavaScript?.(buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScript({
                browserSessionId: diagnostics.browserSessionId,
                collectorId: diagnostics.collectorId,
                nonce: diagnostics.nonce,
                version: diagnostics.collectorVersion,
                request: releaseObjectGroupRequest,
            }));
        }

        if (elementPickerRequest) {
            webViewRef.current?.injectJavaScript?.(buildInjectedBrowserDiagnosticsElementPickerCommandScript({
                browserSessionId: diagnostics.browserSessionId,
                collectorId: diagnostics.collectorId,
                nonce: diagnostics.nonce,
                version: diagnostics.collectorVersion,
                request: elementPickerRequest,
            }));
        }
    }, [props.diagnostics, props.javaScriptEnabled]);

    React.useEffect(() => {
        const command = props.navigationCommand;
        if (!command) return;
        switch (command.kind) {
            case 'goBack':
                webViewRef.current?.goBack?.();
                break;
            case 'goForward':
                webViewRef.current?.goForward?.();
                break;
            case 'reload':
                webViewRef.current?.reload?.();
                break;
            case 'stop':
                webViewRef.current?.stopLoading?.();
                break;
        }
    }, [props.navigationCommand?.commandId, props.navigationCommand?.kind]);

    return (
        <WebView
            accessibilityLabel={props.title}
            injectedJavaScript={injectedJavaScript}
            javaScriptEnabled={props.javaScriptEnabled ?? true}
            mixedContentMode={props.mixedContentMode ?? 'never'}
            onContentProcessDidTerminate={handleProcessCrash}
            onError={handleLoadError}
            onHttpError={handleLoadError}
            onLoadEnd={handleLoadEnd}
            onLoadStart={handleLoadStart}
            onMessage={injectedJavaScript || props.nativeMessageBridge ? handleWebViewMessage : undefined}
            onNavigationStateChange={onNavigationStateChangeProp ? handleNavigationStateChange : undefined}
            onRenderProcessGone={handleProcessCrash}
            onShouldStartLoadWithRequest={shouldStartLoad}
            originWhitelist={[...props.originWhitelist]}
            ref={setWebViewRef}
            source={{ uri: props.url }}
            testID={props.testID}
        />
    );
}
