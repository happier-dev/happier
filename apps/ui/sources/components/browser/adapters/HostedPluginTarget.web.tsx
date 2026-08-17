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
    /**
     * EU-8: lend the bridge owner this frame's host->frame delivery primitive
     * for as long as the frame is mounted. Absent means the surface has no push
     * channel, which the bridge owner reads as "do not advertise a
     * subscription".
     */
    attachHostMessages?: (send: (message: unknown) => void) => () => void;
}>;

/** The embedding document's own origin, or nothing when it cannot be read. */
function resolveHostDocumentOrigin(): readonly string[] {
    const location = Reflect.get(globalThis, 'location');
    if (!location || typeof location !== 'object') return [];
    const origin = Reflect.get(location, 'origin');
    return typeof origin === 'string' && origin.length > 0 && origin !== 'null' ? [origin] : [];
}

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
    /**
     * The selected browser Artifact route intentionally runs in an opaque
     * sandbox. It is a transport property, not an author-selected privilege.
     */
    opaqueArtifactFrame?: boolean;
    onUnexpectedNavigation?: () => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
}>): React.ReactElement {
    const sandbox = props.sandbox ?? DEFAULT_HOSTED_PLUGIN_SANDBOX;
    const security = props.security ?? DEFAULT_HOSTED_PLUGIN_SECURITY;
    const opaqueArtifactFrame = props.opaqueArtifactFrame === true;
    const [artifactFrameRevoked, setArtifactFrameRevoked] = React.useState(false);
    React.useEffect(() => {
        setArtifactFrameRevoked(false);
    }, [opaqueArtifactFrame, props.navigationKey, props.url]);
    const webMessageBridge = React.useMemo(() => {
        const bridge = props.bridge;
        if (!bridge) return undefined;
        return {
            // An opaque sandbox has no addressable guest origin. The caller
            // still verifies exact contentWindow + nonce + destination + bound
            // lifetime before `onMessage`; only then may delivery use `*`.
            targetOrigin: opaqueArtifactFrame ? '*' : bridge.expectedOrigin,
            ...(opaqueArtifactFrame ? { allowWildcardTargetOrigin: true } : {}),
            ...(bridge.attachHostMessages ? { attachHostMessages: bridge.attachHostMessages } : {}),
            onMessage: (event: MessageEvent) => {
            const result = validatePluginHostedWebBridgeMessage({
                message: event.data,
                origin: event.origin,
                expectedOrigin: opaqueArtifactFrame ? 'null' : bridge.expectedOrigin,
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
    }, [opaqueArtifactFrame, props.bridge]);

    const handleUnexpectedNavigation = React.useCallback(() => {
        if (!opaqueArtifactFrame) return;
        setArtifactFrameRevoked(true);
        props.onUnexpectedNavigation?.();
    }, [opaqueArtifactFrame, props.onUnexpectedNavigation]);

    if (artifactFrameRevoked || !canLoadHostedPluginTargetUrl({ security, url: props.url })) {
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

    // Frame-level CSP: defense-in-depth on generic host-rendered plugin frames.
    // Artifact frames instead rely on the canonical Protocol CSP emitted by
    // their selected route. Chromium treats an iframe `csp` attribute as an
    // independently opted-in embedder policy, so duplicating it there rejects
    // an otherwise policy-compliant opaque Artifact response.
    //
    // EU-8: the ancestor is THIS document, so it is named here for the same
    // reason the served header names it — an unconditional `'none'` would have
    // the frame-level policy contradict the response header and refuse the
    // frame Happier is itself rendering.
    const frameCsp = opaqueArtifactFrame
        ? undefined
        : buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security, {
            frameAncestors: resolveHostDocumentOrigin(),
        });
    const resolvedSandbox = resolveHostedPluginWebSandboxPolicy({
        sandbox,
        security,
        url: props.url,
    });

    return (
        <BrowserViewFrame
            engine={{
                kind: 'webIframe',
                title: props.title,
                url: props.url,
                // The selected Artifact route is deliberately opaque even
                // though its URL shares the host's app origin. This removes
                // guest storage/cookie access and prevents a same-origin
                // escape; direct external navigation is retired below.
                sandbox: resolvePluginHostedWebIframeSandbox(opaqueArtifactFrame
                    ? {
                        ...resolvedSandbox,
                        sameOrigin: false,
                        popups: false,
                        topNavigation: false,
                    }
                    : resolvedSandbox),
                testID: props.testID,
                navigationKey: props.navigationKey,
                navigationCommand: props.navigationCommand,
                referrerPolicy: 'no-referrer',
                ...(frameCsp ? { csp: frameCsp } : {}),
                ...(opaqueArtifactFrame
                    ? {
                        revokeOnUnexpectedNavigation: true,
                        onUnexpectedNavigation: handleUnexpectedNavigation,
                    }
                    : {}),
                diagnostics: props.diagnostics,
                webMessageBridge,
            }}
        />
    );
}
