import * as React from 'react';

import {
    WEBVIEW_LOAD_FAILED_ERROR_CODE,
    type BrowserControlViewState,
    type BrowserViewLifecycleEmitter,
} from '@/sync/domains/browser/control';

import { BrowserFrameUnavailable } from '../frame/BrowserFrameUnavailable';
import { BrowserViewFrame } from '../frame/BrowserViewFrame.native';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '../frame/types';

function resolveExternalUrl(view: BrowserControlViewState): string | null {
    if (view.target.kind !== 'externalUrl') {
        return null;
    }
    return view.pendingUrl ?? view.currentUrl ?? view.target.url ?? null;
}

/**
 * The native (ios/android) external-URL frame: a mobile WebView can host arbitrary third-party
 * sites, so an allowed external URL renders inline. `originWhitelist: ['*']` lets the page follow
 * cross-origin links the way a normal browser tab would.
 */
export function ExternalUrlTarget(props: Readonly<{
    testID: string;
    view?: BrowserControlViewState | null;
    profileId?: string | null;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig | null;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    onLifecycle?: BrowserViewLifecycleEmitter;
    nowMs?: () => number;
    reasonCode?: string;
}>): React.ReactElement {
    const view = props.view;
    const isExternalUrl = view?.target.kind === 'externalUrl' && view.adapterKind === 'externalUrl';
    const externalUrl = view && isExternalUrl ? resolveExternalUrl(view) : null;
    const onLifecycle = props.onLifecycle;

    if (view && isExternalUrl && view.engineKind === 'nativeWebView' && externalUrl) {
        return (
            <BrowserViewFrame
                engine={{
                    kind: 'nativeWebView',
                    title: view.title ?? view.target.display?.title ?? externalUrl,
                    url: externalUrl,
                    testID: props.testID,
                    navigationCommand: props.navigationCommand,
                    originWhitelist: ['*'],
                    // B-2 cause-2: native page-load callbacks drive the control-reducer lifecycle.
                    onLoadStart: () => onLifecycle?.({ kind: 'loadStarted', url: externalUrl }),
                    onLoadEnd: () => onLifecycle?.({ kind: 'loadFinished', url: externalUrl }),
                    onError: () => onLifecycle?.({ kind: 'loadFailed', errorCode: WEBVIEW_LOAD_FAILED_ERROR_CODE, url: externalUrl }),
                    ...(props.diagnostics ? { diagnostics: props.diagnostics } : {}),
                }}
            />
        );
    }

    return (
        <BrowserFrameUnavailable
            testID={props.testID}
            reasonCode={props.reasonCode ?? 'external_url_unavailable'}
        />
    );
}
