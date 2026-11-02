import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeResponseEnvelopeV1,
    PluginHostedWebSecurityPolicyV1,
    PluginUiHostApiWireIdentityV1,
    PluginHostedWebBridgeBootstrapConfigV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    buildPluginHostedWebStaticAssetContentSecurityPolicyV1,
    type UiSurfaceNetworkOriginV1,
} from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import type { ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

import {
    resolvePluginHostedWebIframeSandbox,
    type PluginHostedWebSandboxPolicy,
} from '@/components/plugins/hostedWeb/sandbox';
import { validatePluginHostedWebBridgeMessage } from '@/components/plugins/hostedWeb/bridge';
import { useHostedHtmlDocument } from '@/components/plugins/hostedWeb/useHostedHtmlDocument';
import { BrowserFrameLoading } from '../frame/BrowserFrameLoading';

import { BrowserViewFrame } from '../frame/BrowserViewFrame.web';
import {
    canLoadHostedPluginTargetUrl,
    DEFAULT_HOSTED_PLUGIN_SECURITY,
} from './HostedPluginTargetSecurity';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameMessageReceipt,
    BrowserFrameNavigationCommand,
    WebIframeSource,
} from '../frame/types';

export type HostedPluginBridgeConfig = Readonly<{
    expectedOrigin: string;
    identity: PluginUiHostApiWireIdentityV1;
    allowedMessageKinds: ReadonlySet<string>;
        onMessage: (
            envelope: PluginHostedWebBridgeEnvelopeV1,
            receipt: BrowserFrameMessageReceipt,
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
    bootstrapConfig?: PluginHostedWebBridgeBootstrapConfigV1;
    /** Only selected, verified generated Artifact bundles use the nonce profile. */
    generatedArtifact?: boolean;
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
    onLoad?: () => void;
    onError?: () => void;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    networkOrigins?: readonly UiSurfaceNetworkOriginV1[];
    network?: 'none' | 'open';
    externalHttpLinks?: boolean;
    /** Trusted plugin UI: no Artifact egress ceiling (owner ruling 2026-10-29). */
    pluginAuthored?: boolean;
}> & (Readonly<{ bundle: ArtifactHtmlBundleV1; url?: never }> | Readonly<{ url: string; bundle?: never }>)): React.ReactElement {
    const sandbox = props.sandbox ?? DEFAULT_HOSTED_PLUGIN_SANDBOX;
    const security = props.security ?? DEFAULT_HOSTED_PLUGIN_SECURITY;
    const opaqueArtifactFrame = props.opaqueArtifactFrame === true || props.bundle !== undefined;
    // Never fall back to caller HTML's broader profile if a generated mount
    // lacks the host-owned identity needed to authorize its bootstrap.
    const document = useHostedHtmlDocument(props.generatedArtifact && !props.bootstrapConfig
        ? null : props.bundle ?? null, props.bootstrapConfig, {
        networkOrigins: props.networkOrigins, network: props.network, externalHttpLinks: props.externalHttpLinks,
        generatedArtifactNonce: props.generatedArtifact ? props.bootstrapConfig?.identity.mountNonce : undefined,
        pluginAuthored: props.pluginAuthored,
    });
    const onErrorRef = React.useRef(props.onError);
    onErrorRef.current = props.onError;
    React.useEffect(() => {
        if (document.kind === 'error') onErrorRef.current?.();
    }, [document]);
    const source = React.useMemo<WebIframeSource | null>(() => props.bundle === undefined
        ? { url: props.url }
        : document.kind === 'ready' ? { html: document.document } : null,
    [props.url, props.bundle, document]);
    const [artifactFrameRevoked, setArtifactFrameRevoked] = React.useState(false);
    React.useEffect(() => {
        setArtifactFrameRevoked(false);
    }, [opaqueArtifactFrame, props.navigationKey, props.url, props.bundle]);
    const webMessageBridge = React.useMemo(() => {
        const bridge = props.bridge;
        if (!bridge) return undefined;
        return {
            // An opaque sandbox has no addressable guest origin. The caller
            // still verifies exact contentWindow + nonce + destination + bound
            // lifetime before `onMessage`; only then may delivery use `*`.
            targetOrigin: opaqueArtifactFrame ? '*' : bridge.expectedOrigin,
            ...(opaqueArtifactFrame ? { allowWildcardTargetOrigin: true } : {}),
            ...(opaqueArtifactFrame ? { exactDocumentChannel: true } : {}),
            ...(bridge.attachHostMessages ? { attachHostMessages: bridge.attachHostMessages } : {}),
            onMessage: (event: MessageEvent, receipt: BrowserFrameMessageReceipt) => {
            const result = validatePluginHostedWebBridgeMessage({
                message: event.data,
                origin: event.origin,
                expectedOrigin: opaqueArtifactFrame ? 'null' : bridge.expectedOrigin,
                identity: bridge.identity,
                allowedMessageKinds: bridge.allowedMessageKinds,
            });
            if (result.ok) {
                return bridge.onMessage(result.envelope, receipt);
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

    if (document.kind === 'error' || artifactFrameRevoked || (props.bundle === undefined && !canLoadHostedPluginTargetUrl({ url: props.url }))) {
        return (
            <BrowserViewFrame
                engine={{
                    kind: 'unavailable',
                    reasonCode: document.kind === 'error' ? 'hosted_html_document_load_failed' : 'hosted_plugin_security_policy_blocked',
                    testID: props.testID,
                }}
            />
        );
    }

    if (source === null) return <BrowserFrameLoading testID={props.testID} host={props.title} />;

    // The shared plugin policy keeps host embedding/transport boundaries only.
    // Opaque Artifacts keep their separate document policy and navigation shell.
    const frameCsp = opaqueArtifactFrame
        ? undefined
        : buildPluginHostedWebStaticAssetContentSecurityPolicyV1(security, {
            frameAncestors: resolveHostDocumentOrigin(),
        });
    // URL admission already established https or loopback. Its addressable
    // origin is required for exact-origin bridge delivery (EU-8).
    const resolvedSandbox = props.bundle !== undefined
        ? DEFAULT_HOSTED_PLUGIN_SANDBOX
        : { ...sandbox, sameOrigin: true };

    return (
        <BrowserViewFrame
            engine={{
                kind: 'webIframe',
                title: props.title,
                ...source,
                // The selected Artifact route is deliberately opaque even
                // though its URL shares the host's app origin. This removes
                // guest storage/cookie access and prevents a same-origin
                // escape. Bundle self-navigation is blocked by the engine's
                // enclosing shell policy before egress; load retirement also
                // withdraws the bridge after any unexpected document change.
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
                onLoad: props.onLoad,
                onError: props.onError,
                diagnostics: props.diagnostics,
                webMessageBridge,
            }}
        />
    );
}
