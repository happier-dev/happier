import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeResponseEnvelopeV1,
    PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol';
import * as React from 'react';

import type { PluginHostedWebSandboxPolicy } from '@/components/plugins/hostedWeb/sandbox';
import { createPluginHostedWebNativeMessageBridge } from '@/components/plugins/hostedWeb/nativeMessageBridge';
import { resolveUrlOrigin } from '@/sync/domains/browser/adapters/targets/localPreview';

import { BrowserViewFrame } from '../frame/BrowserViewFrame.native';
import {
    canLoadHostedPluginTargetUrl,
    DEFAULT_HOSTED_PLUGIN_SECURITY,
    isLoopbackHostedWebUrl,
} from './HostedPluginTargetSecurity';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '../frame/types';

const DEFAULT_HOSTED_PLUGIN_SANDBOX: PluginHostedWebSandboxPolicy = {
    scripts: true,
    sameOrigin: false,
    popups: false,
    topNavigation: false,
    mixedContent: false,
};

function resolveNativeMixedContentMode(
    security: PluginHostedWebSecurityPolicyV1,
    url: string,
): 'never' | 'compatibility' {
    return security.mixedContent === 'devLoopbackOnly' && isLoopbackHostedWebUrl(url)
        ? 'compatibility'
        : 'never';
}

export function HostedPluginTarget(props: Readonly<{
    title: string;
    url: string;
    sandbox?: PluginHostedWebSandboxPolicy;
    security?: PluginHostedWebSecurityPolicyV1;
    testID: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    bridge?: Readonly<{
        expectedOrigin: string;
        expectedPluginId: string;
        expectedContributionId: string;
        expectedSurfaceId: string;
        expectedNonce: string;
        expectedSessionId?: string | null;
        allowedMessageKinds: ReadonlySet<string>;
        onMessage: (
            envelope: PluginHostedWebBridgeEnvelopeV1,
        ) => void | PluginHostedWebBridgeResponseEnvelopeV1 | Promise<PluginHostedWebBridgeResponseEnvelopeV1 | void>;
        /** EU-8: this WebView's host->frame delivery primitive, lent while mounted. */
        attachHostMessages?: (send: (message: unknown) => void) => () => void;
    }> | null;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
}>): React.ReactElement {
    const sandbox = props.sandbox ?? DEFAULT_HOSTED_PLUGIN_SANDBOX;
    const security = props.security ?? DEFAULT_HOSTED_PLUGIN_SECURITY;
    const origin = resolveUrlOrigin(props.url);
    const nativeMessageBridge = React.useMemo(() => {
        const bridge = props.bridge;
        if (!bridge) return undefined;
        return {
            ...(bridge.attachHostMessages ? { attachHostMessages: bridge.attachHostMessages } : {}),
            onMessage: createPluginHostedWebNativeMessageBridge({
                bridge,
            }),
        };
    }, [props.bridge]);
    if (!origin || !canLoadHostedPluginTargetUrl({ security, url: props.url })) {
        return (
            <BrowserViewFrame
                engine={{
                    kind: 'unavailable',
                    reasonCode: origin ? 'hosted_plugin_security_policy_blocked' : 'invalid_url',
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
                originWhitelist: [...new Set([
                    origin,
                    ...security.allowedCallbackOrigins,
                    ...security.allowedNavigationOrigins,
                ])],
                javaScriptEnabled: sandbox.scripts,
                mixedContentMode: resolveNativeMixedContentMode(security, props.url),
                diagnostics: props.diagnostics,
                nativeMessageBridge,
            }}
        />
    );
}
