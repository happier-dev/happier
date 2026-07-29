import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeResponseEnvelopeV1,
    PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol';
import { buildPluginHostedWebStaticAssetContentSecurityPolicyV1 } from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';

import {
    resolvePluginHostedWebIframeSandbox,
    type PluginHostedWebSandboxPolicy,
} from '@/components/plugins/hostedWeb/sandbox';
import { validatePluginHostedWebBridgeMessage } from '@/components/plugins/hostedWeb/bridge';

import { BrowserViewFrame } from '../frame/BrowserViewFrame.web';
import {
    canLoadHostedPluginTargetUrl,
    DEFAULT_HOSTED_PLUGIN_SECURITY,
    resolveHostedPluginWebSandboxPolicy,
} from './HostedPluginTargetSecurity';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '../frame/types';

export type HostedPluginBridgeConfig = Readonly<{
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
}>;

const DEFAULT_HOSTED_PLUGIN_SANDBOX: PluginHostedWebSandboxPolicy = {
    scripts: true,
    sameOrigin: false,
    popups: false,
    topNavigation: false,
    mixedContent: false,
};

export function HostedPluginTarget(props: Readonly<{
    title: string;
    url: string;
    sandbox?: PluginHostedWebSandboxPolicy;
    security?: PluginHostedWebSecurityPolicyV1;
    testID: string;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    bridge?: HostedPluginBridgeConfig | null;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
}>): React.ReactElement {
    const sandbox = props.sandbox ?? DEFAULT_HOSTED_PLUGIN_SANDBOX;
    const security = props.security ?? DEFAULT_HOSTED_PLUGIN_SECURITY;
    const webMessageBridge = React.useMemo(() => {
        const bridge = props.bridge;
        if (!bridge) return undefined;
        return {
            onMessage: (event: MessageEvent) => {
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
                return bridge.onMessage(result.envelope);
            }
            return undefined;
            },
        };
    }, [props.bridge]);

    if (!canLoadHostedPluginTargetUrl({ security, url: props.url })) {
        return (
            <BrowserViewFrame
                engine={{
                    kind: 'unavailable',
                    reasonCode: 'hosted_plugin_security_policy_blocked',
                    testID: props.testID,
                }}
            />
        );
    }

    // Frame-level CSP: defense-in-depth on host-rendered plugin frames, derived
    // from the same protocol builder used for the static-asset server response
    // header so the frame and the server agree. This is additive to the sandbox
    // and origin clamps, never a replacement for them.
    const frameCsp = buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security);

    return (
        <BrowserViewFrame
            engine={{
                kind: 'webIframe',
                title: props.title,
                url: props.url,
                sandbox: resolvePluginHostedWebIframeSandbox(resolveHostedPluginWebSandboxPolicy({
                    sandbox,
                    security,
                    url: props.url,
                })),
                testID: props.testID,
                navigationKey: props.navigationKey,
                navigationCommand: props.navigationCommand,
                referrerPolicy: 'no-referrer',
                csp: frameCsp,
                diagnostics: props.diagnostics,
                webMessageBridge,
            }}
        />
    );
}
