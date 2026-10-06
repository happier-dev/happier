import { DaemonHostedWebFrameCapabilityV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonHostedWebFrameCapabilityV1, FeatureDecision } from '@happier-dev/protocol';
import type { PluginUiChannelV1, PluginUiPlatformV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiProjectionHostRuntimeContext } from './projection';
import { PLUGIN_UI_HOST_API_VERSION } from './artifactCompatibility';

export { PLUGIN_UI_HOST_API_VERSION } from './artifactCompatibility';

/** Optional display/runtime context; executable admission depends only on the host UI API range. */
export type ReactNativeHostRuntimeReadinessIdentity = Readonly<{
    hostAppVersion?: string;
    platform?: PluginUiPlatformV1;
    channel?: PluginUiChannelV1;
}>;

export function resolvePluginUiProjectionHostRuntime(params: Readonly<{
    hostAppVersion: string;
    reactNativeHostRuntime?: ReactNativeHostRuntimeReadinessIdentity;
    hostedWebFrameCapability?: DaemonHostedWebFrameCapabilityV1;
    hostedWebFeatureDecision?: FeatureDecision;
    reactNativeBundlesFeatureDecision?: FeatureDecision;
}>): PluginUiProjectionHostRuntimeContext {
    const hostedWebFrameCapability = DaemonHostedWebFrameCapabilityV1Schema.safeParse(
        params.hostedWebFrameCapability,
    );
    return Object.freeze({
        hostedWeb: Object.freeze({
            featureEnabled: params.hostedWebFeatureDecision?.state === 'enabled',
            ...(hostedWebFrameCapability.success
                ? { frameCapability: Object.freeze(hostedWebFrameCapability.data) }
                : {}),
        }),
        reactNativeBundles: Object.freeze({
            featureEnabled: params.reactNativeBundlesFeatureDecision?.state === 'enabled',
            hostRuntime: Object.freeze({
                hostAppVersion: params.reactNativeHostRuntime?.hostAppVersion ?? params.hostAppVersion,
                hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION,
                ...(params.reactNativeHostRuntime?.platform
                    ? { platform: params.reactNativeHostRuntime.platform }
                    : {}),
                ...(params.reactNativeHostRuntime?.channel
                    ? { channel: params.reactNativeHostRuntime.channel }
                    : {}),
            }),
        }),
    });
}
