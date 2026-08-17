import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeResponseEnvelopeV1,
    PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol';
import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '@/components/browser/frame/types';
import { HostedPluginTarget } from '@/components/browser/adapters/HostedPluginTarget.native';
import { BrowserFrameLoading } from '@/components/browser/frame/BrowserFrameLoading';

import type { PluginHostedWebSandboxPolicy } from './sandbox';
import { HostedArtifactFrame } from './HostedArtifactFrame.native';
import { createPluginHostedWebNativeMessageBridge } from './nativeMessageBridge';

export function PluginHostedWebFrame(props: Readonly<{
    title: string;
    /** Present only for the legacy daemon/session endpoint frame path. */
    url?: string;
    sandbox: PluginHostedWebSandboxPolicy;
    security: PluginHostedWebSecurityPolicyV1;
    testID: string;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    /** Browser-only capability transport; intentionally inert on native. */
    opaqueArtifactFrame?: boolean;
    /** Browser-only opaque-frame retirement hook; intentionally inert on native. */
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
    /**
     * A selected Artifact has already been registered by the native registrar.
     * This branch receives only its opaque token and host-built correlation
     * query; it deliberately has no URL, bytes, or cache locator input.
     */
    nativeArtifact?: Readonly<{
        artifactHandleToken: string;
        initialPathAndQuery: string;
    }> | null;
    /** Platform-neutral surface compatibility; direct Wry exists only on desktop/web. */
    desktopArtifact?: Readonly<{
        artifactHandleToken: string;
        initialPathAndQuery: string;
    }> | null;
    onNativeArtifactUnavailable?: () => void;
    /** Pane-owned presentation state; native only forwards real view events. */
    nativeArtifactLoadState?: 'loading' | 'ready';
    onNativeArtifactLoadStart?: (event: unknown) => void;
    onNativeArtifactLoadEnd?: (event: unknown) => void;
    onNativeArtifactLoadError?: (event: unknown) => void;
    onNativeArtifactHistoryStateChange?: (canGoBack: boolean) => void;
    onNativeArtifactGoBackResult?: (handled: boolean) => void;
}>): React.ReactElement {
    const artifact = props.nativeArtifact;
    if (artifact) {
        const bridge = props.bridge;
        const nativeMessageBridge = bridge
            ? createPluginHostedWebNativeMessageBridge({
                bridge,
            })
            : undefined;
        const loading = props.nativeArtifactLoadState === 'loading';
        const artifactNavigationCommand = props.navigationCommand?.kind === 'goBack'
            ? { commandId: props.navigationCommand.commandId, kind: 'goBack' as const }
            : undefined;
        return (
            <View style={styles.root}>
                <View
                    accessibilityElementsHidden={loading}
                    importantForAccessibility={loading ? 'no-hide-descendants' : 'auto'}
                    style={styles.frame}
                >
                    <HostedArtifactFrame
                        artifactHandleToken={artifact.artifactHandleToken}
                        initialPathAndQuery={artifact.initialPathAndQuery}
                        allowedNavigationOrigins={props.security.allowedNavigationOrigins}
                        {...(bridge?.attachHostMessages ? { attachHostMessages: bridge.attachHostMessages } : {})}
                        {...(nativeMessageBridge ? { onMessage: nativeMessageBridge } : {})}
                        {...(props.onNativeArtifactUnavailable
                            ? { onUnavailable: () => props.onNativeArtifactUnavailable?.() }
                            : {})}
                        onLoadStart={props.onNativeArtifactLoadStart}
                        onLoadEnd={props.onNativeArtifactLoadEnd}
                        onLoadError={props.onNativeArtifactLoadError}
                        onHistoryStateChange={props.onNativeArtifactHistoryStateChange}
                        {...(artifactNavigationCommand
                            ? { navigationCommand: artifactNavigationCommand }
                            : {})}
                        onGoBackResult={props.onNativeArtifactGoBackResult}
                        testID={props.testID}
                    />
                </View>
                {loading ? (
                    <View pointerEvents="auto" style={styles.loadingOverlay}>
                        <BrowserFrameLoading testID={props.testID} />
                    </View>
                ) : null}
            </View>
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
            navigationCommand={props.navigationCommand}
            diagnostics={props.diagnostics}
            bridge={props.bridge}
        />
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    frame: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    loadingOverlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
    },
});
