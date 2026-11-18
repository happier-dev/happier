import { UsageModelPriceOverridesV1Schema as canonicalUsageModelPriceOverridesV1Schema } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { UsageModelPriceReadResultSchema as canonicalUsageModelPriceReadResultSchema } from '@happier-dev/protocol/usage/usageModelPriceDelivery';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';

export const UsageModelPriceOverridesV1Schema: ProtocolComposableSchema<
    unknown,
    ReturnType<typeof canonicalUsageModelPriceOverridesV1Schema.parse>
> = projectZodProtocolSchema(canonicalUsageModelPriceOverridesV1Schema);
export const UsageModelPriceReadResultSchema: ProtocolComposableSchema<
    unknown,
    ReturnType<typeof canonicalUsageModelPriceReadResultSchema.parse>
> = projectZodProtocolSchema(canonicalUsageModelPriceReadResultSchema);

export { SessionContextUsageSnapshotV1Schema } from '@happier-dev/protocol/usage/contextUsage';
export type { UsagePromptCache } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
export { UsageObservationContextSchema, UsageObservationCostSchema, UsageObservationScopeSchema, UsageObservationTokensSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
/** Pure reducers shared by private/public and external chart producers; no Session access. */
export { summarizeUsageRunLengthObservations } from '@happier-dev/protocol/usage/usageWorkIntervals';
export type { UsageRunLengthObservation, UsageRunLengthObservationSummary, UsageRunLengthSummary } from '@happier-dev/protocol/usage/usageWorkIntervals';
export { resolveUsageCalendarInstant } from '@happier-dev/protocol/usage/usageCalendar';
export { formatUsageDurationCompact } from '@happier-dev/protocol/usage/usageFormatting';
export type { PublicProfileSnapshotV1, PublicUsageFactsV1 } from '@happier-dev/protocol/account/publicProfile';
export { PUBLIC_PROFILE_FACT_FIELDS_V1 } from '@happier-dev/protocol/account/projectPublicProfile';
export type { PublicProfileReadResultV1, PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';
export type { BuiltinUsagePublicPresentationV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
export type {
    SessionContextUsageSnapshotV1,
    UsageObservationContext,
    UsageObservationCost,
    UsageObservationScope,
    UsageObservationTokens,
} from '@happier-dev/protocol/runtime';

import type {
    RuntimeOutboundTranscriptUsageObservationV1,
} from '@happier-dev/agents';

export type UsageObservationEffectV1 = Readonly<{
    type: 'usageObservation';
    observation: RuntimeOutboundTranscriptUsageObservationV1;
    backendMode?: string | null;
    externalKey?: string | null;
}>;

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

export type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
export { projectUsagePageCost } from '@happier-dev/protocol/usage/usageCostFacts';

export { projectAppCallsUsageV1, projectAppCallsUsageSourcesV1, projectAppCallsCostMetricSeriesV1 } from './appCallsUsage.js';
export type { AppCallsUsageV1, AppCallsUsagePartV1, AppCallsUsageWindowV1, AppCallsUsageCoverageV1, AppCallsCostMetricIntervalV1 } from './appCallsUsage.js';
