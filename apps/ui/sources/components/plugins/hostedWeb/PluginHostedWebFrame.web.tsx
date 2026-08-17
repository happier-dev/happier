import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeResponseEnvelopeV1,
    PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol';
import * as React from 'react';

import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '@/components/browser/frame/types';
import { HostedPluginTarget } from '@/components/browser/adapters/HostedPluginTarget.web';

import { PluginHostedArtifactDesktopViewHost } from './PluginHostedArtifactDesktopViewHost';
import type { PluginHostedWebSandboxPolicy } from './sandbox';

export function PluginHostedWebFrame(props: Readonly<{
    title: string;
    /** Ordinary browser frames require URLs; desktop Artifact frames are direct Wry children. */
    url?: string;
    sandbox: PluginHostedWebSandboxPolicy;
    security: PluginHostedWebSecurityPolicyV1;
    testID: string;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    /** Browser Artifact capability routes must remain opaque to the host origin. */
    opaqueArtifactFrame?: boolean;
    /** Browser-only retirement hook for an opaque Artifact replacement document. */
    onUnexpectedNavigation?: () => void;
    bridge?: Readonly<{
        expectedOrigin: string;
        expectedPluginId: string;
        expectedContributionId: string;
        expectedSurfaceId: string;
        expectedNonce: string;
        expectedSessionId?: string | null;
        allowedMessageKinds: ReadonlySet<string>;
        attachHostMessages?: (send: (message: unknown) => void) => () => void;
        onMessage: (
            envelope: PluginHostedWebBridgeEnvelopeV1,
        ) => void | PluginHostedWebBridgeResponseEnvelopeV1 | Promise<PluginHostedWebBridgeResponseEnvelopeV1 | void>;
    }> | null;
    /** Compatibility-only native-frame input; desktop uses `desktopArtifact` below. */
    nativeArtifact?: Readonly<{
        artifactHandleToken: string;
        initialPathAndQuery: string;
    }> | null;
    /** Desktop-only direct child input; never routed through the web browser target. */
    desktopArtifact?: Readonly<{
        artifactHandleToken: string;
        initialPathAndQuery: string;
    }> | null;
    onNativeArtifactUnavailable?: () => void;
    /**
     * Compatibility-only fields on the pane's platform-neutral frame surface.
     * The web renderer has no native Artifact route and intentionally does not
     * inspect these native-view lifecycle facts.
     */
    nativeArtifactLoadState?: 'loading' | 'ready';
    onNativeArtifactLoadStart?: (event: unknown) => void;
    onNativeArtifactLoadEnd?: (event: unknown) => void;
    onNativeArtifactLoadError?: (event: unknown) => void;
    onNativeArtifactHistoryStateChange?: (canGoBack: boolean) => void;
    onNativeArtifactGoBackResult?: (handled: boolean) => void;
}>): React.ReactElement {
    if (props.desktopArtifact) {
        return (
            <PluginHostedArtifactDesktopViewHost
                artifact={props.desktopArtifact}
                bridge={props.bridge}
                testID={props.testID}
                nativeArtifactLoadState={props.nativeArtifactLoadState}
                onNativeArtifactUnavailable={props.onNativeArtifactUnavailable}
                onNativeArtifactLoadStart={props.onNativeArtifactLoadStart}
                onNativeArtifactLoadEnd={props.onNativeArtifactLoadEnd}
                onNativeArtifactLoadError={props.onNativeArtifactLoadError}
                navigationCommand={props.navigationCommand}
                onNativeArtifactHistoryStateChange={props.onNativeArtifactHistoryStateChange}
                onNativeArtifactGoBackResult={props.onNativeArtifactGoBackResult}
            />
        );
    }
    if (!props.url) return <></>;
    return (
        <HostedPluginTarget
            title={props.title}
            url={props.url}
            sandbox={props.sandbox}
            security={props.security}
            testID={props.testID}
            navigationKey={props.navigationKey}
            navigationCommand={props.navigationCommand}
            diagnostics={props.diagnostics}
            bridge={props.bridge}
            opaqueArtifactFrame={props.opaqueArtifactFrame}
            onUnexpectedNavigation={props.onUnexpectedNavigation}
        />
    );
}
