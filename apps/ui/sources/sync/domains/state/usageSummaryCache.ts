import { z } from 'zod/mini';
import { ConnectedServiceQuotaMeterV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { ConnectedServiceQuotaReportedAmountSchema } from '../connectedServices/accountUsage/presentProviderConnectionUsage';

/**
 * The last usage summary this device saw for the Account (connected accounts' quota windows), with
 * the time it was read, so hubs show last-known usage and its "as of" on a cold start.
 */
export const UsageSummaryCacheV1Schema = z.object({
    v: z.literal(1),
    entries: z.array(z.object({
        key: z.string().check(z.minLength(1)),
        /** Unknown when the producer has no reading time; never inferred from another account. */
        fetchedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
        serviceLabel: z.string(),
        /** Added with per-provider grouping; absent in values saved before it (still readable). */
        serviceGroupKey: z.optional(z.string().check(z.minLength(1))),
        legacyServiceId: z.optional(z.nullable(z.string())),
        accountLabel: z.optional(z.string()),
        /** Added with "Hide account emails and IDs": the raw identity the one presenter formats. */
        accountEmail: z.optional(z.nullable(z.string())),
        accountId: z.optional(z.nullable(z.string())),
        profileLabel: z.nullable(z.string()),
        planLabel: z.nullable(z.string()),
        meters: z.array(z.object({
            meterId: z.string().check(z.minLength(1)),
            label: z.string(),
            remainingPct: z.nullable(z.number()),
            resetsAt: z.nullable(z.number()),
            reportedAmount: z.optional(ConnectedServiceQuotaReportedAmountSchema),
            status: z.optional(ConnectedServiceQuotaMeterV1Schema.shape.status),
        })),
    })),
});

export type UsageSummaryCacheV1 = z.infer<typeof UsageSummaryCacheV1Schema>;
