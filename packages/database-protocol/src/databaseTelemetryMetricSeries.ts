import { z } from 'zod/mini';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';

/** Shared finite Metric-widget interval: absence of value is unknown, never zero. */
export const DatabaseTelemetryMetricIntervalV1Schema = z.strictObject({
    since: z.number().check(z.nonnegative()), until: z.number().check(z.nonnegative()), unit: z.string(),
    value: z.optional(z.number()), p50: z.optional(z.number()), p95: z.optional(z.number()), count: z.optional(z.number()),
    errorRate: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
});
export type DatabaseTelemetryMetricIntervalV1 = Readonly<z.infer<typeof DatabaseTelemetryMetricIntervalV1Schema>>;
export const DatabaseTelemetryMetricIntervalV1ProtocolSchema = projectZodProtocolSchema(DatabaseTelemetryMetricIntervalV1Schema);
