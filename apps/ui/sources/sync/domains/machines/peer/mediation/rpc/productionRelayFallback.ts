import {
    readMachineLiveStreamRelayCaps,
    readServerEnabledBit,
    resolveMachineRpcRelayFallbackDecision,
    type FeaturesResponse,
    type MachineRpcRelayFallbackDecision,
    type MachineRpcRoutePolicyV1,
} from '@happier-dev/protocol';

import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';

export function resolveProductionMachineRpcRelayFallback(input: Readonly<{
    policy: Pick<MachineRpcRoutePolicyV1, 'relayFallback'>;
    features: FeaturesResponse | null;
}>): MachineRpcRelayFallbackDecision {
    return resolveMachineRpcRelayFallbackDecision({
        policy: input.policy,
        deploymentKind: 'shared_server',
        relayEnabled: input.features
            ? readServerEnabledBit(input.features, 'machines.liveStream.serverRouted') === true
            : false,
        caps: readMachineLiveStreamRelayCaps(input.features),
    });
}

export async function resolveProductionMachineRpcRelayFallbackForServer(input: Readonly<{
    policy: Pick<MachineRpcRoutePolicyV1, 'relayFallback'>;
    serverId?: string | null;
    timeoutMs?: number;
}>): Promise<MachineRpcRelayFallbackDecision> {
    const features = await getReadyServerFeatures({
        serverId: input.serverId ?? undefined,
        timeoutMs: input.timeoutMs,
    });
    return resolveProductionMachineRpcRelayFallback({
        policy: input.policy,
        features,
    });
}
