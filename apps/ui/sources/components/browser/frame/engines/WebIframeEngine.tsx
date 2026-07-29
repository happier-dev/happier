import * as React from 'react';
import { View } from 'react-native';

import { browserFrameStyles } from '../styles';
import type {
    BrowserAutomationEngineBridgeConfig,
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
    BrowserWebFrameMessageBridgeConfig,
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

export function WebIframeEngine(props: Readonly<{
    title: string;
    url: string;
    sandbox: string;
    testID: string;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    referrerPolicy?: 'no-referrer';
    csp?: string;
    onLoad?: () => void;
    onError?: () => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    webMessageBridge?: BrowserWebFrameMessageBridgeConfig;
}>): React.ReactElement {
    const iframeRef = React.useRef<HTMLIFrameElement | null>(null);

    React.useEffect(() => {
        const diagnostics = props.diagnostics;
        if (!diagnostics) return;

        const sourceOrigin = normalizePostMessageOrigin(diagnostics.sourceOrigin);
        const webPostMessageTargetOrigin = normalizePostMessageOrigin(diagnostics.webPostMessageTargetOrigin);

        if (!webPostMessageTargetOrigin) {
            diagnostics.onRejectedMessage?.('unsupported_web_post_message');
            return;
        }

        diagnostics.onCollectorScriptReady?.(buildInjectedBrowserDiagnosticsScript({
            browserSessionId: diagnostics.browserSessionId,
            viewId: diagnostics.viewId,
            navigationGeneration: diagnostics.navigationGeneration,
            collectorId: diagnostics.collectorId,
            nonce: diagnostics.nonce,
            version: diagnostics.collectorVersion,
            webPostMessageTargetOrigin,
            ownerConsoleValueCapture: diagnostics.consoleValueCapture === true,
            ownerDiagnosticsValueCapture: diagnostics.valueCapture === true,
        }));

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
    }, [props.diagnostics]);

    React.useEffect(() => {
        const automation = props.automation;
        if (!automation) return;
        if (automation.supportedActions.length === 0) return;
        if (typeof window === 'undefined') return;

        const sourceOrigin = normalizePostMessageOrigin(automation.sourceOrigin);
        if (!sourceOrigin) {
            automation.onRejectedMessage?.('unsupported_web_post_message');
            return;
        }

        const targetWindow = iframeRef.current?.contentWindow ?? null;
        if (!targetWindow) return;

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
            targetWindow,
            targetOrigin: sourceOrigin,
            subscribeToMessages(listener) {
                const handler = (event: MessageEvent) => {
                    if (event.origin !== sourceOrigin) return;
                    if (event.source !== targetWindow) return;
                    if (typeof event.data !== 'string') {
                        automation.onRejectedMessage?.('schema_invalid');
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
            automation.onRegistrationRejected?.(registration.reasonCode);
            return;
        }

        return () => {
            automation.controlService.unregisterOwner({
                ownerId,
                reasonCode: 'owner_disconnected',
            });
        };
    }, [props.automation]);

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

    React.useEffect(() => {
        const bridge = props.webMessageBridge;
        if (!bridge) return;
        if (typeof window === 'undefined') return;

        const listener = (event: MessageEvent) => {
            const expectedSource = iframeRef.current?.contentWindow ?? null;
            if (!expectedSource || event.source !== expectedSource) return;
            Promise.resolve(bridge.onMessage(event)).then((response) => {
                if (response === undefined || response === null) return;
                expectedSource.postMessage(response, event.origin);
            }).catch(() => undefined);
        };

        window.addEventListener('message', listener);
        return () => {
            window.removeEventListener('message', listener);
        };
    }, [props.webMessageBridge]);

    React.useEffect(() => {
        applyWebIframeNavigationCommand(iframeRef.current, props.navigationCommand);
    }, [props.navigationCommand?.commandId, props.navigationCommand?.kind]);

    return (
        <View testID={`${props.testID}-container`} style={browserFrameStyles.root}>
            {React.createElement('iframe', {
                'data-browser-navigation-key': props.navigationKey,
                'data-testid': props.testID,
                key: props.navigationKey,
                onError: props.onError,
                onLoad: props.onLoad,
                ref: iframeRef,
                referrerPolicy: props.referrerPolicy ?? 'no-referrer',
                ...(props.csp ? { csp: props.csp } : {}),
                sandbox: props.sandbox,
                src: props.url,
                style: iframeStyle,
                title: props.title,
            })}
        </View>
    );
}
