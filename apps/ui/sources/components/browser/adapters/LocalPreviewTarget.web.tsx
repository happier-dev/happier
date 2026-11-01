import * as React from 'react';

import { resolveLocalPreviewIframeSandbox } from '@/sync/domains/browser/adapters/targets/localPreview';

import {
    WEBVIEW_LOAD_FAILED_ERROR_CODE,
    type BrowserViewLifecycleEmitter,
} from '@/sync/domains/browser/control';

import { BrowserViewFrame } from '../frame/BrowserViewFrame.web';
import { DesktopWebViewEngine, type DesktopWebViewEngineBridge } from '../frame/engines/DesktopWebViewEngine';
import type { BrowserControlViewState } from '@/sync/domains/browser/control/state';
import type { BrowserSurfaceLifecycleState } from '../surfaces/browserSurfaceLifecycle';
import type {
    BrowserAutomationEngineBridgeConfig,
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameRecovery,
    BrowserFrameNavigationCommand,
} from '../frame/types';

export function LocalPreviewTarget(props: Readonly<{
    title: string;
    url: string;
    testID: string;
    view?: BrowserControlViewState;
    profileId?: string | null;
    bridge?: DesktopWebViewEngineBridge;
    lifecycleState?: BrowserSurfaceLifecycleState;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    onLoad?: () => void;
    onError?: () => void;
    /** What the ended-preview state offers (last page, Open again, Close tab). */
    recovery?: BrowserFrameRecovery;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    /**
     * B-2 cause-2: the iframe's `onLoad`/`onError` are mapped to page-load lifecycle signals so the
     * control reducer transitions `loading → ready/failed`. The loaded URL is the iframe `src`
     * (`props.url`), so `loadFinished` commits it (an in-place navigate's pending URL becomes current).
     */
    onLifecycle?: BrowserViewLifecycleEmitter;
}>): React.ReactElement {
    const onLifecycle = React.useCallback<BrowserViewLifecycleEmitter>((signal) => {
        if (signal.kind === 'loadFailed') {
            // A failed preview document is a transport refusal; retain more specific native and proxy reasons.
            props.onLifecycle?.({
                ...signal,
                errorCode: signal.errorCode === WEBVIEW_LOAD_FAILED_ERROR_CODE
                    ? 'preview_transport_unavailable' : signal.errorCode,
            });
        } else {
            props.onLifecycle?.(signal);
        }
    }, [props.onLifecycle]);
    if (props.view?.engineKind === 'desktopWebView') {
        if (!props.profileId) {
            return <BrowserViewFrame engine={{ kind: 'unavailable', reasonCode: 'browser_profile_missing', testID: props.testID }} />;
        }
        return <DesktopWebViewEngine
            view={props.view}
            url={props.url}
            profileId={props.profileId}
            testID={props.testID}
            bridge={props.bridge}
            lifecycleState={props.lifecycleState}
            diagnostics={props.diagnostics}
            automation={props.automation}
            navigationCommand={props.navigationCommand}
            onLifecycle={onLifecycle}
        />;
    }
    return (
        <BrowserViewFrame
            engine={{
                kind: 'webIframe',
                localPreview: true,
                title: props.title,
                url: props.url,
                sandbox: resolveLocalPreviewIframeSandbox(props.url),
                testID: props.testID,
                navigationKey: props.navigationKey,
                navigationCommand: props.navigationCommand,
                onLoad: () => {
                    props.onLoad?.();
                    onLifecycle?.({ kind: 'loadFinished', url: props.url });
                },
                onError: () => {
                    props.onError?.();
                    onLifecycle?.({ kind: 'loadFailed', errorCode: WEBVIEW_LOAD_FAILED_ERROR_CODE, url: props.url });
                },
                // The preview's own documents are the only source of its history truth.
                onNavigationStateChange: (navigationState) => onLifecycle?.({
                    kind: 'navigationStateChanged',
                    ...navigationState,
                }),
                // The proxy's refusal is the page's outcome: the view settles as failed with that reason.
                onPreviewRefused: (reasonCode) => {
                    props.onError?.();
                    onLifecycle?.({ kind: 'loadFailed', errorCode: reasonCode, url: props.url });
                },
                recovery: props.recovery,
                diagnostics: props.diagnostics,
                automation: props.automation,
            }}
        />
    );
}
