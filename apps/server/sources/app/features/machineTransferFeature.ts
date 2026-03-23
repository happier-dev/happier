import { readMachineTransferFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveMachineTransferFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readMachineTransferFeatureEnv(env);

    return {
        features: {
            machines: {
                enabled: true,
                transfer: {
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
                transfer: {
                    serverRouted: {
                        maxBytes: featureConfig.serverRoutedMaxBytes,
                    },
                },
            },
        },
    };
}
