import * as React from 'react';
import { WebView } from 'react-native-webview';

import type { PluginHostedWebSandboxPolicy } from './sandbox';
import type { PluginHostedWebBridgeEnvelopeV1 } from '@happier-dev/protocol';

export function PluginHostedWebFrame(props: Readonly<{
    title: string;
    url: string;
    sandbox: PluginHostedWebSandboxPolicy;
    testID: string;
    bridge?: Readonly<{
        expectedOrigin: string;
        expectedPluginId: string;
        expectedContributionId: string;
        expectedSurfaceId: string;
        expectedNonce: string;
        expectedSessionId?: string | null;
        allowedMessageKinds: ReadonlySet<string>;
        onMessage: (envelope: PluginHostedWebBridgeEnvelopeV1) => void;
    }> | null;
}>): React.ReactElement {
    const origin = new URL(props.url).origin;
    return (
        <WebView
            accessibilityLabel={props.title}
            javaScriptEnabled={props.sandbox.scripts}
            mixedContentMode={props.sandbox.mixedContent ? 'compatibility' : 'never'}
            originWhitelist={[origin]}
            source={{ uri: props.url }}
            testID={props.testID}
        />
    );
}
