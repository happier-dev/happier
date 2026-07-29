import * as React from 'react';

import { resolveLocalPreviewIframeSandbox } from '@/sync/domains/browser/adapters/targets/localPreview';

import {
    WEBVIEW_LOAD_FAILED_ERROR_CODE,
    type BrowserViewLifecycleEmitter,
} from '@/sync/domains/browser/control';

import { BrowserViewFrame } from '../frame/BrowserViewFrame.web';
import type {
    BrowserAutomationEngineBridgeConfig,
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '../frame/types';

export function LocalPreviewTarget(props: Readonly<{
    title: string;
    url: string;
    testID: string;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    onLoad?: () => void;
    onError?: () => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    automation?: BrowserAutomationEngineBridgeConfig;
    /**
     * B-2 cause-2: the iframe's `onLoad`/`onError` are mapped to page-load lifecycle signals so the
     * control reducer transitions `loading → ready/failed`. The loaded URL is the iframe `src`
     * (`props.url`), so `loadFinished` commits it (an in-place navigate's pending URL becomes current).
     */
    onLifecycle?: BrowserViewLifecycleEmitter;
}>): React.ReactElement {
    const onLifecycle = props.onLifecycle;
    return (
        <BrowserViewFrame
            engine={{
                kind: 'webIframe',
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
                diagnostics: props.diagnostics,
                automation: props.automation,
            }}
        />
    );
}
