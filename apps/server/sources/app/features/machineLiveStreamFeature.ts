import { readMachineLiveStreamFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveMachineLiveStreamFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readMachineLiveStreamFeatureEnv(env);

    return {
        features: {
            machines: {
                enabled: true,
                liveStream: {
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
                liveStream: {
                    serverRouted: {
                        caps: featureConfig.serverRoutedCaps,
                        disabledReason: featureConfig.serverRoutedCaps
                            ? null
                            : featureConfig.serverRoutedDisabledReason,
                    },
                },
            },
        },
    };
}
