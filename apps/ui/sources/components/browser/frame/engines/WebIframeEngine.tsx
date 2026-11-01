import * as React from 'react';
import { createPortal } from 'react-dom';
import { View } from 'react-native';
import { ARTIFACT_HTML_SHELL_CSP_V1 } from '@happier-dev/protocol/artifacts/artifactHtmlDocumentV1';

import { browserFrameStyles } from '../styles';
import { BrowserFrameUnavailable } from '../BrowserFrameUnavailable';
import type {
    BrowserAutomationEngineBridgeConfig,
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameRecovery,
    BrowserFrameMessageReceipt,
    BrowserFrameNavigationCommand,
    BrowserFrameNavigationState,
    BrowserWebFrameMessageBridgeConfig,
    WebIframeSource,
} from '../types';
import {
    buildInjectedBrowserDiagnosticsElementPickerCommandMessage,
    buildInjectedBrowserDiagnosticsEvalCommandMessage,
    buildInjectedBrowserDiagnosticsGetPropertiesCommandMessage,
    buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandMessage,
    buildInjectedBrowserDiagnosticsScript,
    parseInjectedBrowserDiagnosticsMessage,
} from '../../adapters/diagnostics';
import { createWebIframeAutomationOwner } from '../../adapters/automation';
import {
    COOPERATIVE_COLLECTOR_STATE_QUERY, buildCooperativeCollectorNavigationUrl, buildCooperativeNavigationCommandMessage,
    cooperativeCollectorIdentity, isCooperativeCollectorMessage, parseCooperativeCollectorConfig, parseCooperativeNavigationState,
    isCooperativeNavigationBindRequest, buildCooperativeNavigationBindMessage,
    type CooperativeNavigationCommand,
} from '@happier-dev/peer-mediation/browser/collector/cooperative';
import { withoutPreviewAdmission } from '@/sync/domains/local/services/preview/url';
import { resolveBrowserPreviewRefusal, type BrowserPreviewRefusalReasonCode } from '@/sync/domains/browser/adapters/targets/localPreview';

const iframeStyle: React.CSSProperties = {
    border: 0,
    display: 'block',
    height: '100%',
    width: '100%',
};

function normalizePostMessageOrigin(origin: string | undefined): string | null {
    if (!origin) {
        return null;
    }
    try {
        return new URL(origin).origin;
    } catch {
        return null;
    }
}

function isPermittedPostMessageTargetOrigin(
    origin: string | undefined,
    allowWildcard: boolean | undefined,
): origin is string {
    return origin === '*'
        ? allowWildcard === true
        : normalizePostMessageOrigin(origin) !== null;
}

function applyWebIframeNavigationCommand(
    iframe: HTMLIFrameElement | null,
    command: BrowserFrameNavigationCommand | undefined,
): void {
    if (!iframe || !command) return;
    const targetWindow = iframe.contentWindow;
    if (!targetWindow) return;

    try {
        switch (command.kind) {
            case 'goBack':
                targetWindow.history.back();
                break;
            case 'goForward':
                targetWindow.history.forward();
                break;
            case 'reload':
                targetWindow.location.reload();
                break;
            case 'stop':
                targetWindow.stop();
                break;
        }
    } catch {
        // Cross-origin and sandboxed frames can reject direct navigation control.
    }
}

type WebIframeEngineProps = Readonly<{
    localPreview?: boolean;
    title: string;
    sandbox: string;
    testID: string;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    referrerPolicy?: 'no-referrer';
    csp?: string;
    onLoad?: () => void;
    onError?: () => void;
    /** Reported only by a relay preview, whose documents carry the navigation reporter. */
    onNavigationStateChange?: (navigationState: BrowserFrameNavigationState) => void;
    onPreviewRefused?: (reasonCode: BrowserPreviewRefusalReasonCode) => void;
    recovery?: BrowserFrameRecovery;
    revokeOnUnexpectedNavigation?: boolean;
    onUnexpectedNavigation?: () => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    webMessageBridge?: BrowserWebFrameMessageBridgeConfig;
}> & WebIframeSource;

// The shell contains only trusted markup; authored HTML is assigned to its
// opaque guest's srcdoc, never executed in the shell. Its frame-src policy
// prevents the opaque guest's own navigation before a request can leave; a
// policy inside the guest or an iframe csp attribute cannot do that.
const navigationShellDocument = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_SHELL_CSP_V1.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"><style>html,body,body>div{height:100%;margin:0;overflow:hidden}</style></head><body></body></html>`;

export function WebIframeEngine(props: WebIframeEngineProps): React.ReactElement {
    return props.html !== undefined && props.revokeOnUnexpectedNavigation
        ? <NavigationContainedIframe key={props.navigationKey} {...props} />
        : <WebIframeGuest {...props} />;
}

function NavigationContainedIframe(props: WebIframeEngineProps): React.ReactElement {
    const [shellDocument, setShellDocument] = React.useState<Document | null>(null);
    return <View testID={`${props.testID}-shell-container`} style={browserFrameStyles.root}>
        <iframe title={props.title} data-testid={`${props.testID}-navigation-shell`}
            srcDoc={navigationShellDocument} referrerPolicy="no-referrer" style={iframeStyle}
            onError={props.onError}
            onLoad={event => setShellDocument(event.currentTarget.contentDocument)} />
        {shellDocument?.body ? createPortal(<WebIframeGuest {...props} />, shellDocument.body) : null}
    </View>;
}

function WebIframeGuest(props: WebIframeEngineProps): React.ReactElement {
    const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
    // The host derives the reload key from its latest effect only, so the command after a Reload (Stop, Back)
    // arrives without it. The frame keeps the key of its last reload: dropping it would remount the frame
    // and load the opening page instead of the one the preview is on.
    const retainedNavigationKeyRef = React.useRef(props.navigationKey);
    if (props.navigationKey !== undefined) retainedNavigationKeyRef.current = props.navigationKey;
    const navigationKey = retainedNavigationKeyRef.current;
    const hasLoadedCurrentNavigationRef = React.useRef(false);
    const [loadedDocumentRevision, setLoadedDocumentRevision] = React.useState(0);
    const [cooperativeReadyUrl, setCooperativeReadyUrl] = React.useState<string | null>(null);
    const [previewRefusal, setPreviewRefusal] = React.useState<BrowserPreviewRefusalReasonCode | null>(null);
    const onPreviewRefusedRef = React.useRef(props.onPreviewRefused);
    onPreviewRefusedRef.current = props.onPreviewRefused;
    const cooperativeDocumentRetiredRef = React.useRef(false);
    const onNavigationStateChangeRef = React.useRef(props.onNavigationStateChange);
    onNavigationStateChangeRef.current = props.onNavigationStateChange;
    // The page the relay preview is on now, as its own document last reported it.
    const frameUrlRef = React.useRef<string | null>(null);
    const [navigationSource, setNavigationSource] = React.useState(() => ({ navigationKey, forUrl: props.url, url: props.url }));
    // A reload (the host's fresh navigation key) reloads the page the preview is on, not the one it was
    // opened at. The new identity still arrives in the navigation URL, so the base is chosen before the
    // frame sees any source change.
    if (navigationKey !== undefined && navigationSource.navigationKey !== navigationKey) {
        setNavigationSource({ navigationKey, forUrl: props.url, url: frameUrlRef.current ?? props.url });
    } else if (navigationSource.forUrl !== props.url) {
        // A page's location report updates the owning view and durable tab. Echoing that observed
        // address into src would navigate it again and lose its history/state. Only a new command
        // or an address the physical frame has not reported changes the assigned source.
        const observed = props.url && frameUrlRef.current
            && withoutPreviewAdmission(props.url) === withoutPreviewAdmission(frameUrlRef.current);
        setNavigationSource({ ...navigationSource, forUrl: props.url, url: observed ? navigationSource.url : props.url });
    }
    const navigationUrl = navigationSource.url;
    const diagnosticsRef = React.useRef(props.diagnostics);
    const automationRef = React.useRef(props.automation);
    diagnosticsRef.current = props.diagnostics;
    automationRef.current = props.automation;
    const bridgeDocumentRetiredRef = React.useRef(false);
    const bridgeSendRef = React.useRef<((message: unknown) => void) | null>(null);
    const webMessageBridgeRef = React.useRef(props.webMessageBridge);
    webMessageBridgeRef.current = props.webMessageBridge;
    const reloadCommandId = props.navigationCommand?.kind === 'reload' ? props.navigationCommand.commandId : undefined;
    const bridgeEnabled = props.webMessageBridge !== undefined;
    const bridgeExactDocumentChannel = props.webMessageBridge?.exactDocumentChannel === true;
    const bridgeTargetOrigin = props.webMessageBridge?.targetOrigin;
    const bridgeAllowsWildcardTargetOrigin = props.webMessageBridge?.allowWildcardTargetOrigin === true;
    const bridgeAttachHostMessages = props.webMessageBridge?.attachHostMessages;
    const collectorScript = React.useMemo(() => {
        const diagnostics = props.diagnostics;
        const targetOrigin = normalizePostMessageOrigin(diagnostics?.webPostMessageTargetOrigin);
        if (!diagnostics || !targetOrigin) return null;
        return buildInjectedBrowserDiagnosticsScript({
            browserSessionId: diagnostics.browserSessionId,
            viewId: diagnostics.viewId,
            navigationGeneration: diagnostics.navigationGeneration,
            collectorId: diagnostics.collectorId,
            nonce: diagnostics.nonce,
            version: diagnostics.collectorVersion,
            webPostMessageTargetOrigin: targetOrigin,
            ownerConsoleValueCapture: diagnostics.consoleValueCapture === true,
            ownerDiagnosticsValueCapture: diagnostics.valueCapture === true,
        });
    }, [
        props.diagnostics?.browserSessionId,
        props.diagnostics?.viewId,
        props.diagnostics?.navigationGeneration,
        props.diagnostics?.collectorId,
        props.diagnostics?.nonce,
        props.diagnostics?.collectorVersion,
        props.diagnostics?.webPostMessageTargetOrigin,
        props.diagnostics?.consoleValueCapture,
        props.diagnostics?.valueCapture,
    ]);

    const cooperativeNavigation = React.useMemo(() => {
        const diagnostics = props.diagnostics;
        const sourceOrigin = normalizePostMessageOrigin(diagnostics?.sourceOrigin);
        const parentOrigin = normalizePostMessageOrigin(diagnostics?.webPostMessageTargetOrigin);
        const sandbox = props.sandbox.split(/\s+/);
        if (!navigationUrl || !diagnostics || props.automation?.adapterKind !== 'localPreview'
            || !sourceOrigin || !parentOrigin || sourceOrigin === parentOrigin
            || !sandbox.includes('allow-scripts') || !sandbox.includes('allow-same-origin')) return null;
        try {
            const url = new URL(navigationUrl);
            if (url.origin !== sourceOrigin || !['http:', 'https:'].includes(url.protocol)) return null;
            const config = parseCooperativeCollectorConfig(JSON.stringify({
                browserSessionId: diagnostics.browserSessionId, viewId: diagnostics.viewId,
                navigationGeneration: diagnostics.navigationGeneration,
                collector: { collectorId: diagnostics.collectorId, nonce: diagnostics.nonce, version: diagnostics.collectorVersion },
                webPostMessageTargetOrigin: parentOrigin,
                ...(diagnostics.consoleValueCapture === true ? { ownerConsoleValueCapture: true } : {}),
                ...(diagnostics.valueCapture === true ? { ownerDiagnosticsValueCapture: true } : {}),
            }));
            if (!config) return null;
            return { url: buildCooperativeCollectorNavigationUrl(url.href, config), config, sourceOrigin };
        } catch { return null; }
    }, [navigationUrl, props.sandbox, props.automation?.adapterKind, collectorScript, props.diagnostics?.sourceOrigin]);

    const previewProbeUrl = React.useMemo(() => {
        const href = cooperativeNavigation?.url ?? (props.localPreview ? navigationUrl : undefined);
        if (!href) return null;
        try {
            // The frame's own first request spends the one-use admission for its cookie; the probe rides
            // that cookie. Presenting the admission again would answer with the exchange redirect, which
            // a cross-origin fetch cannot follow, and hide the proxy's typed refusal.
            const url = new URL(withoutPreviewAdmission(href));
            if (!['http:', 'https:'].includes(url.protocol)) return null;
            url.search += `${url.search ? '&' : '?'}${COOPERATIVE_COLLECTOR_STATE_QUERY}=1`;
            return url.href;
        } catch { return null; }
    }, [cooperativeNavigation?.url, props.localPreview, navigationUrl]);

    // Address observations can change props.url without assigning a new document. Readiness,
    // collector custody and document-bound transports follow the same source as the iframe.
    React.useLayoutEffect(() => {
        hasLoadedCurrentNavigationRef.current = false;
        bridgeDocumentRetiredRef.current = false;
        cooperativeDocumentRetiredRef.current = false;
        setCooperativeReadyUrl(null);
        setPreviewRefusal(null);
    }, [navigationKey, navigationUrl, props.html, cooperativeNavigation?.url, reloadCommandId]);

    React.useLayoutEffect(() => {
        if (!cooperativeNavigation || typeof window === 'undefined') return;
        const listener = (event: MessageEvent) => {
            if (cooperativeDocumentRetiredRef.current || event.origin !== cooperativeNavigation.sourceOrigin
                || !iframeRef.current?.contentWindow || event.source !== iframeRef.current.contentWindow || typeof event.data !== 'string') return;
            let message: unknown;
            try { message = JSON.parse(event.data); } catch { return; }
            if (isCooperativeCollectorMessage(message, 'browser.collector.ready', cooperativeNavigation.config)) {
                setCooperativeReadyUrl(cooperativeNavigation.url);
            } else if (isCooperativeCollectorMessage(message, 'browser.collector.retire', cooperativeNavigation.config)) {
                cooperativeDocumentRetiredRef.current = true;
                setCooperativeReadyUrl(null);
            }
        };
        window.addEventListener('message', listener);
        return () => window.removeEventListener('message', listener);
    }, [cooperativeNavigation]);

    // Navigation truth is independent of automation admission: every document of the bound preview
    // reports it, including those that follow an in-frame navigation retired from page automation.
    React.useLayoutEffect(() => {
        if (!cooperativeNavigation || typeof window === 'undefined') return;
        const listener = (event: MessageEvent) => {
            if (event.origin !== cooperativeNavigation.sourceOrigin || !iframeRef.current?.contentWindow
                || event.source !== iframeRef.current.contentWindow || typeof event.data !== 'string') return;
            let message: unknown;
            try { message = JSON.parse(event.data); } catch { return; }
            if (isCooperativeNavigationBindRequest(message)) {
                iframeRef.current.contentWindow.postMessage(buildCooperativeNavigationBindMessage(cooperativeNavigation.config), cooperativeNavigation.sourceOrigin);
                return;
            }
            const state = parseCooperativeNavigationState(message, cooperativeNavigation.config);
            if (!state || normalizePostMessageOrigin(state.url) !== cooperativeNavigation.sourceOrigin) return;
            frameUrlRef.current = state.url;
            onNavigationStateChangeRef.current?.({ loading: state.loading, canGoBack: state.canGoBack, canGoForward: state.canGoForward,
                url: state.url, navigationGeneration: cooperativeNavigation.config.navigationGeneration,
                ...(state.title?.trim() ? { title: state.title.trim() } : {}) });
        };
        window.addEventListener('message', listener);
        return () => window.removeEventListener('message', listener);
    }, [cooperativeNavigation]);

    React.useLayoutEffect(() => {
        frameUrlRef.current = null;
    }, [navigationUrl, props.html]);

    React.useEffect(() => {
        if (!previewProbeUrl || !hasLoadedCurrentNavigationRef.current
            || (cooperativeNavigation && (cooperativeReadyUrl === cooperativeNavigation.url || cooperativeDocumentRetiredRef.current))) return;
        const controller = new AbortController();
        const url = new URL(previewProbeUrl);
        // With script-src 'none' the guest cannot report its own refusal. The same authorized
        // proxy returns its CSP decision or typed transport refusal without exposing page content.
        const rejectUnavailable = () => {
            if (!controller.signal.aborted) automationRef.current?.onRegistrationRejected?.('runtime_unavailable');
        };
        void fetch(url.href, { credentials: 'include', signal: controller.signal }).then(async (response) => {
            if (new URL(response.url).origin !== url.origin) { rejectUnavailable(); return; }
            const result: unknown = await response.json();
            const refusal = resolveBrowserPreviewRefusal(response.status, result);
            if (!controller.signal.aborted && refusal) {
                setPreviewRefusal(refusal);
                onPreviewRefusedRef.current?.(refusal);
                rejectUnavailable();
                return;
            }
            if (!response.ok) { rejectUnavailable(); return; }
            if (!controller.signal.aborted && result && typeof result === 'object' && 'state' in result
                && result.state === 'collector_blocked_by_csp') {
                automationRef.current?.onRegistrationRejected?.('collector_blocked_by_csp');
            } else if (!controller.signal.aborted && result && typeof result === 'object' && 'state' in result
                && result.state === 'runtime_unavailable') {
                rejectUnavailable();
            }
        }).catch(rejectUnavailable);
        return () => controller.abort();
    }, [previewProbeUrl, cooperativeNavigation?.url, cooperativeReadyUrl, loadedDocumentRevision, reloadCommandId]);

    React.useEffect(() => {
        const diagnostics = props.diagnostics;
        if (!diagnostics) return;

        const sourceOrigin = normalizePostMessageOrigin(diagnostics.sourceOrigin);
        const webPostMessageTargetOrigin = normalizePostMessageOrigin(diagnostics.webPostMessageTargetOrigin);

        if (!webPostMessageTargetOrigin) {
            diagnostics.onRejectedMessage?.('unsupported_web_post_message');
            return;
        }

        if (collectorScript) diagnostics.onCollectorScriptReady?.(collectorScript);

        if (typeof window === 'undefined') return;

        const listener = (event: MessageEvent) => {
            if (!sourceOrigin || event.origin !== sourceOrigin) {
                diagnostics.onRejectedMessage?.('origin_mismatch');
                return;
            }
            const expectedSource = iframeRef.current?.contentWindow ?? null;
            if (expectedSource && event.source !== expectedSource) {
                diagnostics.onRejectedMessage?.('source_mismatch');
                return;
            }
            if (typeof event.data !== 'string') {
                diagnostics.onRejectedMessage?.('schema_invalid');
                return;
            }
            // Readiness belongs to the engine admission handshake, not diagnostics ingestion.
            if (cooperativeNavigation) {
                try {
                    const message: unknown = JSON.parse(event.data);
                    if (isCooperativeCollectorMessage(message, 'browser.collector.ready', cooperativeNavigation.config)
                        || isCooperativeCollectorMessage(message, 'browser.collector.retire', cooperativeNavigation.config)
                        || isCooperativeNavigationBindRequest(message)
                        || parseCooperativeNavigationState(message, cooperativeNavigation.config)) return;
                } catch { /* The diagnostics parser reports malformed messages below. */ }
            }

            const parsed = parseInjectedBrowserDiagnosticsMessage(event.data, {
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
        };

        window.addEventListener('message', listener);
        return () => {
            window.removeEventListener('message', listener);
        };
    }, [props.diagnostics, collectorScript, cooperativeNavigation]);

    // Callback/request changes do not reinstall the collector or retire in-flight actions.
    const automationActionsKey = JSON.stringify(props.automation?.supportedActions ?? []);
    React.useEffect(() => {
        const cooperative = cooperativeNavigation !== null;
        if (cooperative ? cooperativeReadyUrl !== cooperativeNavigation.url || cooperativeDocumentRetiredRef.current : !hasLoadedCurrentNavigationRef.current) return;
        if (typeof window === 'undefined') return;
        const diagnostics = diagnosticsRef.current;
        const automation = automationRef.current;
        if (!diagnostics || !collectorScript) {
            automation?.onRegistrationRejected?.('runtime_unavailable');
            return;
        }
        const sourceOrigin = normalizePostMessageOrigin(diagnostics.sourceOrigin);
        const targetWindow = iframeRef.current?.contentWindow ?? null;
        // An opaque or cross-origin guest cannot be injected by its parent. Keep its isolation;
        // a contentWindow/postMessage primitive alone is not evidence of a collector.
        const sandboxTokens = props.sandbox.split(/\s+/);
        if (!sourceOrigin || !targetWindow || !sandboxTokens.includes('allow-scripts') || !sandboxTokens.includes('allow-same-origin')) {
            automation?.onRegistrationRejected?.('cross_origin_frame_unavailable');
            return;
        }
        let targetDocument: Document | undefined;
        let previousRuntime: unknown;
        if (!cooperative) try {
            targetDocument = targetWindow.document;
            if (targetWindow.location.origin !== sourceOrigin) throw new Error('origin_mismatch');
            previousRuntime = Reflect.get(targetWindow, '__happierBrowserRuntime');
        } catch {
            automation?.onRegistrationRejected?.('cross_origin_frame_unavailable');
            return;
        }
        let runtime: unknown;
        if (!cooperative) try {
            if (!targetDocument) throw new Error('runtime_unavailable');
            const script = targetDocument.createElement('script');
            script.textContent = collectorScript;
            try {
                (targetDocument.head ?? targetDocument.documentElement).appendChild(script);
            } finally {
                script.remove();
            }
            runtime = Reflect.get(targetWindow, '__happierBrowserRuntime');
        } catch {
            automation?.onRegistrationRejected?.('runtime_unavailable');
            return;
        }
        if (!cooperative && (!runtime || runtime === previousRuntime || typeof runtime !== 'object'
            || !('browserSessionId' in runtime) || runtime.browserSessionId !== diagnostics.browserSessionId
            || !('viewId' in runtime) || runtime.viewId !== diagnostics.viewId
            || !('navigationGeneration' in runtime) || runtime.navigationGeneration !== diagnostics.navigationGeneration
            || !('teardown' in runtime) || typeof runtime.teardown !== 'function'
            || !('modules' in runtime) || !runtime.modules || typeof runtime.modules !== 'object'
            || !('automation' in runtime.modules) || !runtime.modules.automation || typeof runtime.modules.automation !== 'object'
            || !('execute' in runtime.modules.automation) || typeof runtime.modules.automation.execute !== 'function')) {
            automation?.onRegistrationRejected?.('runtime_unavailable');
            return;
        }
        const teardownRuntime = runtime && typeof runtime === 'object' && 'teardown' in runtime && typeof runtime.teardown === 'function' ? runtime.teardown : null;
        const retireRuntime = () => {
            try {
                if (cooperativeNavigation) {
                    targetWindow.postMessage(JSON.stringify({ v: 1, kind: 'browser.collector.retire', ...cooperativeCollectorIdentity(cooperativeNavigation.config) }), sourceOrigin);
                } else if (teardownRuntime && Reflect.get(targetWindow, '__happierBrowserRuntime') === runtime) teardownRuntime();
            } catch {
                // Navigating away may already have destroyed the guest realm.
            }
        };
        if (!automation || automation.supportedActions.length === 0) return retireRuntime;
        if (automation.browserSessionId !== diagnostics.browserSessionId || automation.viewId !== diagnostics.viewId
            || automation.navigationGeneration !== diagnostics.navigationGeneration
            || automation.collectorId !== diagnostics.collectorId || automation.nonce !== diagnostics.nonce
            || normalizePostMessageOrigin(automation.sourceOrigin) !== sourceOrigin) {
            automation.onRegistrationRejected?.('runtime_unavailable');
            return retireRuntime;
        }

        const ownerId = [
            'browser_automation_owner',
            automation.browserSessionId,
            automation.viewId,
            automation.navigationGeneration,
            'webIframe',
        ].join(':');
        const owner = createWebIframeAutomationOwner({
            ownerId,
            browserSessionId: automation.browserSessionId,
            viewId: automation.viewId,
            navigationGeneration: automation.navigationGeneration,
            adapterKind: automation.adapterKind,
            collectorId: automation.collectorId,
            nonce: automation.nonce,
            capabilityVersion: automation.capabilityVersion,
            supportedActions: automation.supportedActions,
            targetWindow: {
                postMessage(message, origin) {
                    try {
                        if (cooperative ? cooperativeDocumentRetiredRef.current : targetWindow.document !== targetDocument || targetWindow.location.origin !== sourceOrigin) {
                            throw new Error('cross_origin_frame_unavailable');
                        }
                    } catch {
                        throw new Error('cross_origin_frame_unavailable');
                    }
                    targetWindow.postMessage(message, origin);
                },
            },
            targetOrigin: sourceOrigin,
            subscribeToMessages(listener) {
                const handler = (event: MessageEvent) => {
                    if (event.origin !== sourceOrigin) return;
                    if (event.source !== targetWindow) return;
                    if (typeof event.data !== 'string') {
                        automationRef.current?.onRejectedMessage?.('schema_invalid');
                        return;
                    }
                    listener(event.data);
                };
                window.addEventListener('message', handler);
                return () => {
                    window.removeEventListener('message', handler);
                };
            },
            nowMs: automation.nowMs ?? Date.now,
        });
        const registration = automation.controlService.registerOwner(owner);
        if (!registration.ok) {
            automationRef.current?.onRegistrationRejected?.(registration.reasonCode);
            return retireRuntime;
        }

        return () => {
            automation.controlService.unregisterOwner({
                ownerId,
                reasonCode: 'owner_disconnected',
            });
            retireRuntime();
        };
    }, [
        collectorScript,
        cooperativeNavigation,
        cooperativeReadyUrl,
        cooperativeNavigation ? null : loadedDocumentRevision,
        navigationKey,
        navigationUrl,
        props.html,
        props.sandbox,
        props.diagnostics?.sourceOrigin,
        props.automation?.browserSessionId,
        props.automation?.viewId,
        props.automation?.navigationGeneration,
        props.automation?.collectorId,
        props.automation?.nonce,
        props.automation?.capabilityVersion,
        props.automation?.adapterKind,
        props.automation?.sourceOrigin,
        props.automation?.controlService,
        props.automation?.nowMs,
        automationActionsKey,
    ]);

    React.useEffect(() => {
        const diagnostics = props.diagnostics;
        const evalRequest = diagnostics?.evalRequest;
        if (!diagnostics || !evalRequest) return;

        const sourceOrigin = normalizePostMessageOrigin(diagnostics.sourceOrigin);
        if (!sourceOrigin) {
            diagnostics.onRejectedMessage?.('unsupported_web_post_message');
            return;
        }

        const targetWindow = iframeRef.current?.contentWindow;
        if (!targetWindow) return;

        const command = buildInjectedBrowserDiagnosticsEvalCommandMessage({
            browserSessionId: diagnostics.browserSessionId,
            collectorId: diagnostics.collectorId,
            nonce: diagnostics.nonce,
            version: diagnostics.collectorVersion,
            request: evalRequest,
        });
        targetWindow.postMessage(JSON.stringify(command), sourceOrigin);
    }, [props.diagnostics]);

    React.useEffect(() => {
        const diagnostics = props.diagnostics;
        const getPropertiesRequest = diagnostics?.getPropertiesRequest;
        const releaseObjectGroupRequest = diagnostics?.releaseObjectGroupRequest;
        const elementPickerRequest = diagnostics?.elementPickerRequest;
        if (!diagnostics || (!getPropertiesRequest && !releaseObjectGroupRequest && !elementPickerRequest)) return;

        const sourceOrigin = normalizePostMessageOrigin(diagnostics.sourceOrigin);
        if (!sourceOrigin) {
            diagnostics.onRejectedMessage?.('unsupported_web_post_message');
            return;
        }

        const targetWindow = iframeRef.current?.contentWindow;
        if (!targetWindow) return;

        if (getPropertiesRequest) {
            targetWindow.postMessage(JSON.stringify(buildInjectedBrowserDiagnosticsGetPropertiesCommandMessage({
                browserSessionId: diagnostics.browserSessionId,
                collectorId: diagnostics.collectorId,
                nonce: diagnostics.nonce,
                version: diagnostics.collectorVersion,
                request: getPropertiesRequest,
            })), sourceOrigin);
        }

        if (releaseObjectGroupRequest) {
            targetWindow.postMessage(JSON.stringify(buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandMessage({
                browserSessionId: diagnostics.browserSessionId,
                collectorId: diagnostics.collectorId,
                nonce: diagnostics.nonce,
                version: diagnostics.collectorVersion,
                request: releaseObjectGroupRequest,
            })), sourceOrigin);
        }

        if (elementPickerRequest) {
            targetWindow.postMessage(JSON.stringify(buildInjectedBrowserDiagnosticsElementPickerCommandMessage({
                browserSessionId: diagnostics.browserSessionId,
                collectorId: diagnostics.collectorId,
                nonce: diagnostics.nonce,
                version: diagnostics.collectorVersion,
                request: elementPickerRequest,
            })), sourceOrigin);
        }
    }, [props.diagnostics]);

    // EU-8: the host->frame push direction. The engine owns only the delivery
    // primitive and lends it to the bridge owner while the frame is mounted.
    // Opaque hosted documents use their transferred, document-bound port;
    // ordinary frames use the admitted exact target origin. A missing or
    // inadmissible transport fails closed instead of broadcasting host facts.
    //
    // This attachment and the transport below are ONE ordered lifecycle, and
    // the attachment is declared first on purpose. React retires layout effects
    // in declaration order, so the bridge owner's disposer runs while `active`,
    // the installed `send` and the incumbent MessagePort are all still live —
    // which is the only moment its one terminal packet can still reach the
    // incumbent guest. It must also be a LAYOUT effect: passive cleanup happens
    // after React has cleared `iframeRef`, which is already too late to address
    // an ordinary-origin document.
    React.useLayoutEffect(() => {
        if (!bridgeAttachHostMessages || !isPermittedPostMessageTargetOrigin(bridgeTargetOrigin, bridgeAllowsWildcardTargetOrigin)) return;
        return bridgeAttachHostMessages((message: unknown) => {
            bridgeSendRef.current?.(message);
        });
    }, [
        bridgeAttachHostMessages,
        bridgeAllowsWildcardTargetOrigin,
        bridgeTargetOrigin,
    ]);

    React.useLayoutEffect(() => {
        if (!bridgeEnabled) return;
        if (typeof window === 'undefined') return;
        let active = true;
        let documentPort: MessagePort | null = null;
        let transientActivationConsumed = false;
        const messageWindow = iframeRef.current?.ownerDocument?.defaultView ?? window;

        const createMessageReceipt = (): BrowserFrameMessageReceipt => {
            const iframe = iframeRef.current;
            const hostNavigator = Reflect.get(globalThis, 'navigator');
            const userActivation = hostNavigator && typeof hostNavigator === 'object'
                ? Reflect.get(hostNavigator, 'userActivation')
                : null;
            const isActive = Boolean(
                userActivation
                && typeof userActivation === 'object'
                && Reflect.get(userActivation, 'isActive') === true,
            );
            const hostDocument = iframe?.ownerDocument ?? Reflect.get(globalThis, 'document');
            const exactFrameFocused = Boolean(
                iframe
                && hostDocument
                && typeof hostDocument === 'object'
                && Reflect.get(hostDocument, 'activeElement') === iframe,
            );
            // Browser activation has no author-readable host token. Observe its
            // inactive transition to arm the next epoch without a timer.
            if (!isActive) transientActivationConsumed = false;
            let receiptConsumed = false;
            return Object.freeze({
                consumeTransientActivation(): boolean {
                    if (!isActive || !exactFrameFocused || receiptConsumed || transientActivationConsumed) {
                        return false;
                    }
                    receiptConsumed = true;
                    transientActivationConsumed = true;
                    return true;
                },
            });
        };

        const send = (message: unknown): void => {
            if (!active || bridgeDocumentRetiredRef.current) return;
            if (documentPort) {
                documentPort.postMessage(message);
                return;
            }
            if (bridgeExactDocumentChannel) return;
            if (!isPermittedPostMessageTargetOrigin(bridgeTargetOrigin, bridgeAllowsWildcardTargetOrigin)) return;
            iframeRef.current?.contentWindow?.postMessage(message, bridgeTargetOrigin);
        };
        bridgeSendRef.current = send;

        const dispatch = (receivedEvent: MessageEvent, origin: string, expectedSource: WindowProxy): void => {
            let data: unknown = receivedEvent.data;
            if (messageWindow !== window && receivedEvent.isTrusted) {
                // The browser cloned into the shell realm, but the strict host
                // consumer belongs to the app realm. Rehome native deliveries
                // without coercing non-JSON values or touching their authority.
                try { data = window.structuredClone(data); }
                catch { return; }
            }
            const event = { data, origin, source: expectedSource } as MessageEvent;
            const receipt = createMessageReceipt();
            const bridge = webMessageBridgeRef.current;
            if (!bridge) return;
            Promise.resolve(bridge.onMessage(event, receipt)).then((response) => {
                if (!active || bridgeDocumentRetiredRef.current || iframeRef.current?.contentWindow !== expectedSource) return;
                if (response === undefined || response === null) return;
                send(response);
            }).catch(() => undefined);
        };

        const listener = (event: MessageEvent) => {
            const expectedSource = iframeRef.current?.contentWindow ?? null;
            if (!active || bridgeDocumentRetiredRef.current || !expectedSource || event.source !== expectedSource) return;
            if (bridgeExactDocumentChannel) {
                if (documentPort) return;
                const transferredPort = event.ports?.[0];
                if (!transferredPort) return;
                documentPort = transferredPort;
                documentPort.onmessage = (portEvent) => {
                    if (!active || bridgeDocumentRetiredRef.current) return;
                    dispatch(portEvent, event.origin, expectedSource);
                };
                documentPort.start();
            }
            dispatch(event, event.origin, expectedSource);
        };

        // A contained guest addresses its trusted transport shell as parent.
        // Subscribe there directly, preserving the browser's real source and
        // origin instead of relaying messages through another authority.
        messageWindow.addEventListener('message', listener);
        return () => {
            active = false;
            if (bridgeSendRef.current === send) bridgeSendRef.current = null;
            documentPort?.close();
            documentPort = null;
            messageWindow.removeEventListener('message', listener);
        };
    }, [
        bridgeAllowsWildcardTargetOrigin,
        bridgeEnabled,
        bridgeExactDocumentChannel,
        bridgeTargetOrigin,
        navigationKey,
        navigationUrl,
        props.html,
    ]);

    const cooperativeNavigationRef = React.useRef(cooperativeNavigation);
    cooperativeNavigationRef.current = cooperativeNavigation;
    React.useEffect(() => {
        const command = props.navigationCommand;
        if (!command) return;
        const cooperative = cooperativeNavigationRef.current;
        if (!cooperative) {
            applyWebIframeNavigationCommand(iframeRef.current, command);
            return;
        }
        // The frame is cross-origin, so only its own document can act on history. Its reload is the host's
        // fresh navigation key, which has no command of its own.
        if (command.kind === 'reload') return;
        const collectorCommand: CooperativeNavigationCommand = command.kind === 'goBack' ? 'back' : command.kind === 'goForward' ? 'forward' : 'stop';
        iframeRef.current?.contentWindow?.postMessage(buildCooperativeNavigationCommandMessage(cooperative.config, collectorCommand), cooperative.sourceOrigin);
    }, [props.navigationCommand?.commandId, props.navigationCommand?.kind]);

    const handleLoad = React.useCallback(() => {
        if (cooperativeNavigation && hasLoadedCurrentNavigationRef.current) {
            cooperativeDocumentRetiredRef.current = true;
            setCooperativeReadyUrl(null);
        }
        if (props.revokeOnUnexpectedNavigation && hasLoadedCurrentNavigationRef.current) {
            bridgeDocumentRetiredRef.current = true;
            props.onUnexpectedNavigation?.();
            return;
        }
        hasLoadedCurrentNavigationRef.current = true;
        setLoadedDocumentRevision((revision) => revision + 1);
        props.onLoad?.();
    }, [props.onLoad, props.onUnexpectedNavigation, props.revokeOnUnexpectedNavigation, cooperativeNavigation]);

    if (previewRefusal) {
        return <BrowserFrameUnavailable testID={props.testID} reasonCode={previewRefusal}
            recovery={props.recovery} />;
    }

    return (
        <View testID={`${props.testID}-container`} style={browserFrameStyles.root}>
            {React.createElement('iframe', {
                'data-browser-navigation-key': navigationKey,
                'data-testid': props.testID,
                key: navigationKey,
                onError: props.onError,
                onLoad: handleLoad,
                ref: iframeRef,
                referrerPolicy: props.referrerPolicy ?? 'no-referrer',
                ...(props.csp ? { csp: props.csp } : {}),
                sandbox: props.sandbox,
                ...(props.html === undefined ? { src: cooperativeNavigation?.url ?? navigationUrl } : { srcDoc: props.html }),
                style: iframeStyle,
                title: props.title,
            })}
        </View>
    );
}
