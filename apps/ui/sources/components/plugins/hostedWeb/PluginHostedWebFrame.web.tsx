import type {
    PluginHostedWebSecurityPolicyV1,
    PluginHostedWebBridgeBootstrapConfigV1,
} from '@happier-dev/protocol';
import type { UiSurfaceNetworkOriginV1 } from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import type { ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '@/components/browser/frame/types';
import {
    HostedPluginTarget,
    type HostedPluginBridgeConfig,
} from '@/components/browser/adapters/HostedPluginTarget.web';

import { PluginHostedArtifactDesktopViewHost } from './PluginHostedArtifactDesktopViewHost';
import type { PluginHostedWebSandboxPolicy } from './sandbox';
import type { HostedInlineDocumentFrameUnavailableCode } from './hostedInlineDocumentFrameTypes';

export function PluginHostedWebFrame(props: Readonly<{
    title: string;
    /** Ordinary browser frames require URLs; desktop Artifact frames are direct Wry children. */
    url?: string;
    bundle?: ArtifactHtmlBundleV1;
    networkOrigins?: readonly UiSurfaceNetworkOriginV1[];
    bootstrapConfig?: PluginHostedWebBridgeBootstrapConfigV1;
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
    onLoad?: () => void;
    onError?: () => void;
    externalHttpLinks?: boolean;
    bridge?: HostedPluginBridgeConfig | null;
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
    /** Native-only inline-document failure signal; inert on web. */
    onNativeHostedHtmlUnavailable?: (code: HostedInlineDocumentFrameUnavailableCode) => void;
    /**
     * Compatibility-only fields on the pane's platform-neutral frame surface.
     * The web renderer has no native Artifact route and intentionally does not
     * inspect these native-view lifecycle facts.
     */
    nativeArtifactLoadState?: 'loading' | 'ready';
    presentationEligible?: boolean;
    onNativeArtifactLoadStart?: (event: unknown) => void;
    onNativeArtifactLoadEnd?: (event: unknown) => void;
    onNativeArtifactLoadError?: (event: unknown) => void;
    onNativeArtifactHistoryStateChange?: (canGoBack: boolean) => void;
    onNativeArtifactGoBackResult?: (handled: boolean) => void;
}>): React.ReactElement {
    if (props.desktopArtifact) {
        return (
            <PluginHostedArtifactDesktopViewHost
                title={props.title}
                artifact={props.desktopArtifact}
                bridge={props.bridge}
                testID={props.testID}
                nativeArtifactLoadState={props.nativeArtifactLoadState}
                presentationEligible={props.presentationEligible}
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
    const source = props.bundle !== undefined
        ? { bundle: props.bundle }
        : props.url !== undefined ? { url: props.url } : null;
    if (!source) return <></>;
    return (
        <HostedPluginTarget
            title={props.title}
            {...source}
            networkOrigins={props.networkOrigins}
            bootstrapConfig={props.bootstrapConfig}
            sandbox={props.sandbox}
            security={props.security}
            testID={props.testID}
            navigationKey={props.navigationKey}
            navigationCommand={props.navigationCommand}
            diagnostics={props.diagnostics}
            bridge={props.bridge}
            opaqueArtifactFrame={props.opaqueArtifactFrame}
            onUnexpectedNavigation={props.onUnexpectedNavigation}
            onLoad={props.onLoad}
            onError={props.onError}
            externalHttpLinks={props.externalHttpLinks}
        />
    );
}
