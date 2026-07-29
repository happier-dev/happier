import * as React from 'react';

import { BrowserFrameError } from './BrowserFrameError';
import { BrowserFrameLoading } from './BrowserFrameLoading';
import { BrowserFrameUnavailable } from './BrowserFrameUnavailable';
import { WebIframeEngine } from './engines/WebIframeEngine';
import type { BrowserFrameEngineConfig } from './types';

export function BrowserViewFrame(props: Readonly<{
    engine: BrowserFrameEngineConfig;
}>): React.ReactElement {
    switch (props.engine.kind) {
        case 'webIframe':
            return (
                <WebIframeEngine
                    title={props.engine.title}
                    url={props.engine.url}
                    sandbox={props.engine.sandbox}
                    testID={props.engine.testID}
                    navigationKey={props.engine.navigationKey}
                    navigationCommand={props.engine.navigationCommand}
                    referrerPolicy={props.engine.referrerPolicy}
                    csp={props.engine.csp}
                    onLoad={props.engine.onLoad}
                    onError={props.engine.onError}
                    diagnostics={props.engine.diagnostics}
                    automation={props.engine.automation}
                    webMessageBridge={props.engine.webMessageBridge}
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
        case 'nativeWebView':
            return <BrowserFrameUnavailable testID={props.engine.testID} />;
        case 'unavailable':
            return <BrowserFrameUnavailable testID={props.engine.testID} reasonCode={props.engine.reasonCode} />;
    }
}
