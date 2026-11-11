import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type {
    TeamCredentialUsageBreakdownDimensionV1,
    TeamCredentialUsageQueryResultV1,
} from './usageV1.js';
import { TeamCredentialUsageQueryInputV1Schema } from './usageV1.js';

import {
    buildUsageCsvDocument,
    buildUsageTextFileResult,
    formatUsageExportFileTimestamp,
    type UsageFileResult,
} from '../../usage/usageExport.js';
import { resolveEffectiveUsageCostUsd, type UsageCostMode } from '../../usage/usageCostFacts.js';

export const TeamCredentialUsageExportInputV1Schema = lazyZodSchema(() => z.strictObject({
    query: TeamCredentialUsageQueryInputV1Schema,
    /** Display-only title; it never selects or authorizes a resource. */
    resourceName: z.string().check(z.minLength(1)),
    /** Explicit ranked-row selection, preserving the UI's loaded-page scope. */
    breakdownRowCount: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type TeamCredentialUsageExportInputV1 = z.output<typeof TeamCredentialUsageExportInputV1Schema>;

/**
 * One shared credential's recorded usage, as a file.
 *
 * The export carries the same measurement provenance the screen shows, because
 * a spreadsheet outlives the screen: a reader who only has the file must still
 * be able to tell a brokered request count from a partial one, and an unpriced
 * period from a free one. Nothing here recomputes a total — every number is the
 * Home's own answer, resolved through the same cost owner the screen uses.
 */
export type TeamCredentialUsageExportInput = Readonly<{
    resourceName: string;
    result: TeamCredentialUsageQueryResultV1;
    startMs: number;
    endMs: number;
    /** The dimension whose ranked slices are in `result.breakdown`, if any. */
    breakdown: TeamCredentialUsageBreakdownDimensionV1 | null;
    /**
     * Whether `result.breakdown` is every slice of the query, or only the pages
     * loaded so far.
     *
     * The total row is always the whole query's total, so a file whose ranked
     * slices stop at the loaded pages would otherwise read as a complete
     * breakdown that simply does not add up. The reader is told which it is
     * instead of being refused the file.
     */
    breakdownComplete: boolean;
    /**
     * The cost mode the Home resolved `cost` under. With the reported and
     * estimated components beside it, an estimate and a Provider-reported
     * amount of the same size stay distinguishable in the file.
     */
    costMode: UsageCostMode;
}>;

function requestCell(result: TeamCredentialUsageQueryResultV1, requestCount: number): string {
    return result.coverage.requestCountCoverage === 'brokered_only' && requestCount === 0
        ? ''
        : String(requestCount);
}

function tokenCell(tokenCount: number | null): string {
    return tokenCount === null ? '' : String(tokenCount);
}

function costCell(
    cost: TeamCredentialUsageQueryResultV1['totals']['cost'],
    mode: UsageCostMode,
): string {
    const resolved = resolveEffectiveUsageCostUsd(cost, mode);
    return resolved === null ? '' : String(resolved);
}

/** Coverage travels in its own columns; NULL alone means this component was not measured. */
function costComponentCell(amountUsd: number | null): string {
    return amountUsd === null ? '' : String(amountUsd);
}

export function buildTeamCredentialUsageCsv(input: TeamCredentialUsageExportInput): string {
    const { result } = input;
    const breakdownScope = input.breakdown === null
        ? ''
        : input.breakdownComplete ? 'complete' : 'loaded_pages';
    const deliveryProvenance = result.coverage.directRecordedUseOnly
        ? 'historical_direct'
        : 'recorded_by_happier';
    const common = [
        deliveryProvenance,
        result.coverage.requestCountCoverage,
        result.coverage.tokenCoverage,
        result.coverage.costCoverage,
        String(result.coverage.requestAdmissionCount),
        String(result.coverage.agentObservationCount),
        String(result.coverage.externalTerminalObservationCount),
        String(result.coverage.unobservedExternalRequestCount),
        breakdownScope,
    ];
    return buildUsageCsvDocument([
        [
            'resource', 'range_start_utc', 'range_end_utc', 'scope', 'dimension', 'key', 'label',
            'requests', 'tokens', 'cost', 'currency', 'cost_mode', 'reported_cost', 'estimated_cost',
            'delivery_provenance', 'request_count_coverage', 'token_coverage', 'cost_coverage',
            'request_admission_count', 'agent_observation_count', 'external_terminal_observation_count',
            'unobserved_external_request_count', 'breakdown_scope',
        ],
        [
            input.resourceName,
            new Date(input.startMs).toISOString(),
            new Date(input.endMs).toISOString(),
            'total',
            '',
            '',
            '',
            requestCell(result, result.coverage.requestAdmissionCount),
            tokenCell(result.totals.tokens.total),
            costCell(result.totals.cost, input.costMode),
            result.totals.cost.currency,
            input.costMode,
            costComponentCell(result.totals.cost.reportedUsd),
            costComponentCell(result.totals.cost.estimatedUsd),
            ...common,
        ],
        ...(input.breakdown === null ? [] : (result.breakdown ?? []).map((entry) => [
            input.resourceName,
            new Date(input.startMs).toISOString(),
            new Date(input.endMs).toISOString(),
            'breakdown',
            input.breakdown ?? '',
            entry.key,
            entry.label ?? '',
            requestCell(result, entry.totals.requestCount),
            tokenCell(entry.totals.tokens.total),
            costCell(entry.totals.cost, input.costMode),
            entry.totals.cost.currency,
            input.costMode,
            costComponentCell(entry.totals.cost.reportedUsd),
            costComponentCell(entry.totals.cost.estimatedUsd),
            ...common,
        ])),
    ]);
}

export function buildTeamCredentialUsageFileResult(
    input: TeamCredentialUsageExportInput,
): UsageFileResult {
    return buildUsageTextFileResult({
        content: buildTeamCredentialUsageCsv(input),
        mediaType: 'text/csv',
        fileName: `team-credential-usage-${formatUsageExportFileTimestamp(new Date())}.csv`,
        fields: ['totals', 'coverage', ...(input.breakdown === null ? [] : ['breakdowns' as const])],
        // The query result publishes no observation watermark. Export time is not freshness.
        asOfMs: null,
    });
}
