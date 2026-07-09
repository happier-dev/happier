export {
    SessionContextUsageSnapshotV1Schema,
    UsageObservationContextSchema,
    UsageObservationCostSchema,
    UsageObservationScopeSchema,
    UsageObservationTokensSchema,
} from '@happier-dev/protocol';
export type {
    SessionContextUsageSnapshotV1,
    UsageObservationContext,
    UsageObservationCost,
    UsageObservationScope,
    UsageObservationTokens,
} from '@happier-dev/protocol';

import type {
    RuntimeOutboundTranscriptPostSendEffectV1,
    RuntimeOutboundTranscriptUsageObservationV1,
} from '@happier-dev/agents';

export type UsageObservationEffectV1 = Extract<
    RuntimeOutboundTranscriptPostSendEffectV1,
    Readonly<{ type: 'usageObservation' }>
>;

export function buildUsageObservationEffect(params: Readonly<{
    observation: RuntimeOutboundTranscriptUsageObservationV1;
    backendMode?: string | null;
    externalKey?: string | null;
}>): UsageObservationEffectV1 {
    return {
        type: 'usageObservation',
        observation: params.observation,
        ...(params.backendMode !== undefined ? { backendMode: params.backendMode } : {}),
        ...(params.externalKey !== undefined ? { externalKey: params.externalKey } : {}),
    };
}
