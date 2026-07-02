import type { PluginHostedWebBridgeEnvelopeV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';

import {
    resolvePluginHostedWebIframeSandbox,
    type PluginHostedWebSandboxPolicy,
} from './sandbox';
import { validatePluginHostedWebBridgeMessage } from './bridge';

const iframeStyle: React.CSSProperties = {
    border: 0,
    display: 'block',
    height: '100%',
    width: '100%',
};

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
    React.useEffect(() => {
        const bridge = props.bridge;
        if (!bridge) return;
        if (typeof window === 'undefined') return;

        const listener = (event: MessageEvent) => {
            const result = validatePluginHostedWebBridgeMessage({
                message: event.data,
                origin: event.origin,
                expectedOrigin: bridge.expectedOrigin,
                expectedPluginId: bridge.expectedPluginId,
                expectedContributionId: bridge.expectedContributionId,
                expectedSurfaceId: bridge.expectedSurfaceId,
                expectedNonce: bridge.expectedNonce,
                expectedSessionId: bridge.expectedSessionId,
                allowedMessageKinds: bridge.allowedMessageKinds,
            });
            if (result.ok) {
                bridge.onMessage(result.envelope);
            }
        };

        window.addEventListener('message', listener);
        return () => {
            window.removeEventListener('message', listener);
        };
    }, [props.bridge]);

    return (
        <View testID={`${props.testID}-container`} style={{ flex: 1, minHeight: 0 }}>
            {React.createElement('iframe', {
                'data-testid': props.testID,
                referrerPolicy: 'no-referrer',
                sandbox: resolvePluginHostedWebIframeSandbox(props.sandbox),
                src: props.url,
                style: iframeStyle,
                testID: props.testID,
                title: props.title,
            })}
        </View>
    );
}
