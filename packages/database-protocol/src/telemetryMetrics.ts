import { z } from 'zod/mini';
import { HealthCheckResultV1ProtocolSchema } from '@happier-dev/protocol/deployments/healthCheckV1';
import { asProtocolZod, projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DatabaseTelemetryMetricIntervalV1Schema } from './databaseTelemetryMetricSeries.js';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

const result = asProtocolZod(HealthCheckResultV1ProtocolSchema);
const text = z.string().check(z.minLength(1));
const time = z.number().check(z.int(), z.nonnegative());
const routeStatistic = z.enum(['p50', 'p95', 'errorRate']);
const route = z.strictObject({ method: text, route: text });
const runtime = z.strictObject({ kind: z.literal('runtime'), metricName: text,
    dimensions: z.optional(z.array(z.strictObject({ name: text, value: z.union([z.string(), z.number(), z.boolean()]) }))),
    statistic: z.enum(['latest', 'sum', 'mean', 'p50', 'p95']) });
/** Saved key flows select emitted routes, runtime metrics or API-equivalent app spend. */
export const TelemetryKeyFlowMeasureV1Schema = z.union([
    z.strictObject({ kind: z.literal('route'), routes: z.array(route).check(z.minLength(1)), statistic: routeStatistic }), runtime,
    z.strictObject({ kind: z.literal('spend'), costMode: z.literal('api_equivalent') }),
]);
/** The saved Key flow health-check kind (D32): one named flow, its routes and threshold, checked on the collector. */
export const TELEMETRY_KEY_FLOW_HEALTH_KIND_V1 = { pluginId: 'happier.telemetry', localId: 'key-flow' } as const;
const selection = { environmentId: text, serviceName: text, serviceVersion: z.optional(text) };
/** The flow's name ("Checkout") names its check on every surface; without one the check is named by its routes. */
export const TelemetryKeyFlowConfigV1Schema = z.strictObject({ name: z.optional(text), ...selection, measure: TelemetryKeyFlowMeasureV1Schema,
    windowMs: z.number().check(z.int(), z.positive()),
    threshold: z.strictObject({ operator: z.enum(['above', 'below']), value: z.number() }) });
/** Whole-service HTTP is a demand read; it does not author a saved route check. */
export const TelemetryMetricsReadInputV1Schema = z.strictObject({ ...selection, serverId: text, since: time, until: time,
    measure: z.union([TelemetryKeyFlowMeasureV1Schema,
        z.strictObject({ kind: z.literal('http'), statistic: z.union([routeStatistic, z.literal('requests')]) })]) });
export const TelemetryMetricsReadResultV1Schema = z.strictObject({ result,
    routes: z.array(z.strictObject({ method: z.string(), route: z.string(), result })),
    trend: z.array(DatabaseTelemetryMetricIntervalV1Schema), usage: z.optional(UsageAnalyticsQueryResponseSchema) });
/** Services rows are Environments: one demand reads every emitted service for the mounted rows. */
export const TELEMETRY_REQUESTS_FIELD_ID_V1 = 'requests-24h' as const;
export const TELEMETRY_REQUESTS_LIST_EXTENSION_ID_V1 = 'service-requests' as const;
export const TELEMETRY_REQUESTS_WINDOW_MS_V1 = 24 * 60 * 60 * 1000;
const environmentBatch = { serverId: text, environmentIds: z.array(text).check(z.minLength(1)) };
export const TelemetryEnvironmentMetricsReadInputV1Schema = z.strictObject({ ...environmentBatch, since: time, until: time,
    measure: z.strictObject({ kind: z.literal('http'), statistic: z.literal('requests') }) });
/** The live Resource advances this duration only when mounted demand reads or the collector pushes. */
export const TelemetryEnvironmentMetricsResourceInputV1Schema = z.strictObject({ ...environmentBatch,
    windowMs: z.number().check(z.int(), z.positive()) });
export const TelemetryEnvironmentMetricsReadResultV1Schema = z.strictObject({ items: z.array(z.strictObject({
    environmentId: text, ...TelemetryMetricsReadResultV1Schema.shape,
})) });
export const TelemetryMetricsActionReadInputV1ProtocolSchema = projectZodProtocolSchema(z.union([
    TelemetryMetricsReadInputV1Schema, TelemetryEnvironmentMetricsReadInputV1Schema,
]));
export const TelemetryMetricsActionReadResultV1ProtocolSchema = projectZodProtocolSchema(z.union([
    TelemetryMetricsReadResultV1Schema, TelemetryEnvironmentMetricsReadResultV1Schema,
]));
export type TelemetryEnvironmentMetricsReadInputV1 = z.infer<typeof TelemetryEnvironmentMetricsReadInputV1Schema>;
export type TelemetryEnvironmentMetricsReadResultV1 = z.infer<typeof TelemetryEnvironmentMetricsReadResultV1Schema>;
export type TelemetryEnvironmentMetricsResourceInputV1 = z.infer<typeof TelemetryEnvironmentMetricsResourceInputV1Schema>;
export const TelemetryMetricsReadResultV1ProtocolSchema = projectZodProtocolSchema(TelemetryMetricsReadResultV1Schema);
export const TelemetryMetricsReadInputV1ProtocolSchema = projectZodProtocolSchema(TelemetryMetricsReadInputV1Schema);
export const TelemetryKeyFlowMeasureV1ProtocolSchema = projectZodProtocolSchema(TelemetryKeyFlowMeasureV1Schema);
export const TelemetryKeyFlowConfigV1ProtocolSchema = projectZodProtocolSchema(TelemetryKeyFlowConfigV1Schema);
export type TelemetryMetricsReadResultV1 = z.infer<typeof TelemetryMetricsReadResultV1Schema>;
export type TelemetryMetricsReadInputV1 = z.infer<typeof TelemetryMetricsReadInputV1Schema>;
export type TelemetryKeyFlowConfigV1 = z.infer<typeof TelemetryKeyFlowConfigV1Schema>;
export type TelemetryKeyFlowMeasureV1 = z.infer<typeof TelemetryKeyFlowMeasureV1Schema>;
