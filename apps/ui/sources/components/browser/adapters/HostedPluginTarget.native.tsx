import type {
    PluginHostedWebBridgeBootstrapConfigV1} from '@happier-dev/protocol/plugins/ui/hostedWebBridge';
import type {
    PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol/plugins/contributions/ui/hostedWebSecurity';
import type { UiSurfaceNetworkOriginV1 } from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import type { ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

import type { PluginHostedWebSandboxPolicy } from '@/components/plugins/hostedWeb/sandbox';
import { createPluginHostedWebNativeMessageBridge, type PluginHostedWebNativeBridgeConfig } from '@/components/plugins/hostedWeb/nativeMessageBridge';
import { HostedInlineDocumentFrame } from '@/components/plugins/hostedWeb/HostedArtifactFrame.native';
import { resolveUrlOrigin } from '@/sync/domains/browser/adapters/targets/localPreview';

import { BrowserViewFrame } from '../frame/BrowserViewFrame.native';
import {
    canLoadHostedPluginTargetUrl,
    DEFAULT_HOSTED_PLUGIN_SECURITY,
} from './HostedPluginTargetSecurity';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
    BrowserFrameHostMessageAttachment,
} from '../frame/types';

const DEFAULT_HOSTED_PLUGIN_SANDBOX: PluginHostedWebSandboxPolicy = {
    scripts: true,
    sameOrigin: false,
    popups: false,
    topNavigation: false,
    mixedContent: false,
};

export function HostedPluginTarget(props: Readonly<{
    title: string;
    sandbox?: PluginHostedWebSandboxPolicy;
    security?: PluginHostedWebSecurityPolicyV1;
    testID: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    bootstrapConfig?: PluginHostedWebBridgeBootstrapConfigV1;
    onUnexpectedNavigation?: () => void;
    onLoadStart?: () => void;
    onLoad?: () => void;
    onError?: () => void;
    bridge?: (PluginHostedWebNativeBridgeConfig & Partial<BrowserFrameHostMessageAttachment>) | null;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    networkOrigins?: readonly UiSurfaceNetworkOriginV1[];
    network?: 'none' | 'open';
    externalHttpLinks?: boolean;
}> & (Readonly<{ bundle: ArtifactHtmlBundleV1; url?: never }> | Readonly<{ url: string; bundle?: never }>)): React.ReactElement {
    const sandbox = props.sandbox ?? DEFAULT_HOSTED_PLUGIN_SANDBOX;
    const security = props.security ?? DEFAULT_HOSTED_PLUGIN_SECURITY;
    const origin = props.url === undefined ? null : resolveUrlOrigin(props.url);
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
    if (props.bundle !== undefined) {
        return <HostedInlineDocumentFrame
            title={props.title}
            bundle={props.bundle}
            networkOrigins={props.networkOrigins}
            network={props.network}
            bootstrapConfig={props.bootstrapConfig}
            allowedNavigationOrigins={security.allowedNavigationOrigins}
            bridge={props.bridge}
            externalHttpLinks={props.externalHttpLinks}
            onLoadStart={props.onLoadStart}
            onLoadEnd={props.onLoad}
            onLoadError={props.onError}
            onBlockedNavigation={props.onUnexpectedNavigation}
            testID={props.testID}
        />;
    }
    if (!origin || !canLoadHostedPluginTargetUrl({ url: props.url })) {
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
                originWhitelist: ['*'],
                javaScriptEnabled: sandbox.scripts,
                mixedContentMode: sandbox.mixedContent ? 'compatibility' : 'never',
                diagnostics: props.diagnostics,
                nativeMessageBridge,
                onLoadStart: props.onLoadStart,
                onLoadEnd: props.onLoad,
                onError: props.onError,
            }}
        />
    );
}
