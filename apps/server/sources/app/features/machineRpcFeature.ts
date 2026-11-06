import { readMachineRpcFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveMachineRpcFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readMachineRpcFeatureEnv(env);

    return {
        features: {
            machines: {
                enabled: true,
                rpc: {
                    enabled: true,
                    directPeer: {
                        enabled: featureConfig.directPeerEnabled,
                    },
                },
            },
        },
        capabilities: {
            machines: {
                connectedAccountAuthentication: { protocolVersions: [1] },
                sessionSpawn: { protocolVersions: [1, 2, 3, 4] },
            },
        },
    };
}
