import * as React from 'react';

import { BrowserFrameError } from './BrowserFrameError';
import { BrowserFrameLoading } from './BrowserFrameLoading';
import { BrowserFrameUnavailable } from './BrowserFrameUnavailable';
import { NativeWebViewEngine } from './engines/NativeWebViewEngine';
import type { BrowserFrameEngineConfig } from './types';

export function BrowserViewFrame(props: Readonly<{
    engine: BrowserFrameEngineConfig;
}>): React.ReactElement {
    switch (props.engine.kind) {
        case 'nativeWebView':
            return (
                <NativeWebViewEngine
                    title={props.engine.title}
                    url={props.engine.url}
                    testID={props.engine.testID}
                    navigationCommand={props.engine.navigationCommand}
                    originWhitelist={props.engine.originWhitelist}
                    javaScriptEnabled={props.engine.javaScriptEnabled}
                    mixedContentMode={props.engine.mixedContentMode}
                    onLoadStart={props.engine.onLoadStart}
                    onLoadEnd={props.engine.onLoadEnd}
                    onError={props.engine.onError}
                    onNavigationStateChange={props.engine.onNavigationStateChange}
                    onBlockedNavigation={props.engine.onBlockedNavigation}
                    diagnostics={props.engine.diagnostics}
                    automation={props.engine.automation}
                    nativeMessageBridge={props.engine.nativeMessageBridge}
                />
            );
        case 'loading':
            return <BrowserFrameLoading testID={props.engine.testID} />;
        case 'error':
            return (
                <BrowserFrameError
                    testID={props.engine.testID}
                    errorCode={props.engine.errorCode}
                    onReload={props.engine.onReload}
                />
            );
        case 'webIframe':
            return <BrowserFrameUnavailable testID={props.engine.testID} />;
        case 'unavailable':
            return <BrowserFrameUnavailable testID={props.engine.testID} reasonCode={props.engine.reasonCode} />;
    }
}
