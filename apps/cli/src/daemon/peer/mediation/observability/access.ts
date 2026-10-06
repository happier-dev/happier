import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';

type FeaturePayload = Readonly<{
    features?: unknown;
    capabilities?: unknown;
}>;

export function isDaemonPeerMediationObservabilityReadAvailable(payload: FeaturePayload): boolean {
    const parsed = FeaturesResponseSchema.safeParse(payload);
    return parsed.success
        && readServerEnabledBit(parsed.data, 'machines.peerMediation.observability') === true;
}
