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
                        supportedEncodings: featureConfig.serverRoutedSupportedEncodings,
                        preferredEncoding: featureConfig.serverRoutedPreferredEncoding,
                        allowV1Fallback: featureConfig.serverRoutedAllowV1Fallback,
                        maxBinaryHeaderBytes: featureConfig.serverRoutedMaxBinaryHeaderBytes,
                        maxRawPayloadBytes: featureConfig.serverRoutedMaxRawPayloadBytes,
                        maxFramedMessageBytes: featureConfig.serverRoutedMaxFramedMessageBytes,
                        substreams: featureConfig.serverRoutedSubstreams,
                        maxIdleMs: featureConfig.maxIdleMs,
                        maxDurationMs: featureConfig.maxDurationMs,
                        disabledReason: featureConfig.serverRoutedEnabled ? undefined : 'relay_disabled_by_server_policy',
                    },
                },
            },
        },
    };
}
