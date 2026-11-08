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
        // This Home owns protected-operation admission and withdraws retained
        // protection before a newly claimed daemon may receive RPC traffic.
        capabilities: {
            machines: {
                requesterExecutionIsolation: { protocolVersions: [1] },
                connectedAccountAuthentication: { protocolVersions: [1] },
                scmComparisonIndexPaging: { protocolVersions: [1] },
                scmStatusSnapshotPaging: { protocolVersions: [1] },
                sessionSpawn: { protocolVersions: [1, 2, 3, 4] },
            },
        },
    };
}
