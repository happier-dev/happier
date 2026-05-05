import { readMachineTunnelFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveMachineTunnelFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readMachineTunnelFeatureEnv(env);

    return {
        features: {
            machines: {
                enabled: true,
                tunnel: {
                    enabled: true,
                    directPeer: {
                        enabled: featureConfig.directPeerEnabled,
                    },
                    serverRouted: {
                        enabled: featureConfig.serverRoutedEnabled,
                    },
                },
            },
        },
        capabilities: {
            machines: {
                tunnel: {
                    directPeer: {
                        allowedPorts: featureConfig.allowedPorts,
                        maxIdleMs: featureConfig.maxIdleMs,
                        maxDurationMs: featureConfig.maxDurationMs,
                    },
                    serverRouted: {
                        maxBytes: featureConfig.serverRoutedMaxBytes,
                        maxActiveTunnelsPerSocket: featureConfig.serverRoutedMaxActiveTunnelsPerSocket,
                        maxFrameBytes: featureConfig.serverRoutedMaxFrameBytes,
                        maxIdleMs: featureConfig.maxIdleMs,
                        maxDurationMs: featureConfig.maxDurationMs,
                        disabledReason: featureConfig.serverRoutedEnabled ? undefined : 'relay_disabled_by_server_policy',
                    },
                },
            },
        },
    };
}
