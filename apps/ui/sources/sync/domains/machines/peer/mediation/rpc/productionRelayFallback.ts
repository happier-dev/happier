import { readMachineLiveStreamRelayCaps } from '@happier-dev/protocol/features/payload/capabilities/machineLiveStreamCapabilities';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { resolveMachineRpcRelayFallbackDecision, type MachineRpcRelayFallbackDecision, type MachineRpcRoutePolicyV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

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
