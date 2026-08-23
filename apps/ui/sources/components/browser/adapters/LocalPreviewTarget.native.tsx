import * as React from 'react';

import { resolveUrlOrigin } from '@/sync/domains/browser/adapters/targets/localPreview';
import {
    WEBVIEW_LOAD_FAILED_ERROR_CODE,
    type BrowserViewLifecycleEmitter,
} from '@/sync/domains/browser/control';

import { BrowserViewFrame } from '../frame/BrowserViewFrame.native';
import type {
    BrowserAutomationEngineBridgeConfig,
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '../frame/types';

export function LocalPreviewTarget(props: Readonly<{
    title: string;
    url: string;
    testID: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    onLoadStart?: () => void;
    onLoadEnd?: () => void;
    onError?: () => void;
    onBlockedNavigation?: (url: string) => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    /** B-2 cause-2: maps native `onLoadStart`/`onLoadEnd`/`onError` to control-reducer lifecycle. */
    onLifecycle?: BrowserViewLifecycleEmitter;
}>): React.ReactElement {
    const onLifecycle = props.onLifecycle;
    const origin = resolveUrlOrigin(props.url);
    if (!origin) {
        return (
            <BrowserViewFrame
                engine={{
                    kind: 'unavailable',
                    reasonCode: 'invalid_url',
                    testID: props.testID,
                }}
            />
        );
    }

    return (
        <BrowserViewFrame
            engine={{
                kind: 'nativeWebView',
                title: props.title,
                url: props.url,
                testID: props.testID,
                navigationCommand: props.navigationCommand,
                originWhitelist: [origin],
                onLoadStart: () => {
                    props.onLoadStart?.();
                    onLifecycle?.({ kind: 'loadStarted', url: props.url });
                },
                onLoadEnd: () => {
                    props.onLoadEnd?.();
                    onLifecycle?.({ kind: 'loadFinished', url: props.url });
                },
                onError: () => {
                    props.onError?.();
                    onLifecycle?.({ kind: 'loadFailed', errorCode: WEBVIEW_LOAD_FAILED_ERROR_CODE, url: props.url });
                },
                // G4: the WebView's own navigation snapshot is the only producer of back/forward
                // history truth for this engine.
                onNavigationStateChange: (navigationState) => onLifecycle?.({
                    kind: 'navigationStateChanged',
                    ...navigationState,
                }),
                onBlockedNavigation: props.onBlockedNavigation,
                diagnostics: props.diagnostics,
                automation: props.automation,
            }}
        />
    );
}
