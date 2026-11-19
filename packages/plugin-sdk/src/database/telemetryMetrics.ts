import { z } from 'zod/mini';
import { HealthCheckResultV1ProtocolSchema } from '@happier-dev/protocol/deployments/healthCheckV1';
import { asProtocolZod, projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DatabaseTelemetryMetricIntervalV1Schema } from './databaseTelemetryMetricSeries.js';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { ProtocolComposableSchema, ProtocolJsonValue } from '../protocol/protocolFacade.js';
import { projectNativeJsonValueForTransport } from '../protocol/strictJsonValue.js';

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
const environmentBatch = { serverId: text, environmentIds: z.array(text).check(z.minLength(1)) };
export const TelemetryEnvironmentMetricsReadInputV1Schema = z.strictObject({ ...environmentBatch, since: time, until: time,
    measure: z.strictObject({ kind: z.literal('http'), statistic: z.literal('requests') }) });
/** The live Resource advances this duration only when mounted demand reads or the collector pushes. */
export const TelemetryEnvironmentMetricsResourceInputV1Schema = z.strictObject({ ...environmentBatch,
    windowMs: z.number().check(z.int(), z.positive()) });
export const TelemetryEnvironmentMetricsReadResultV1Schema = z.strictObject({ items: z.array(z.strictObject({
    environmentId: text, ...TelemetryMetricsReadResultV1Schema.shape,
})) });
const telemetryMetricsActionReadInputV1Schema = z.union([
    TelemetryMetricsReadInputV1Schema, TelemetryEnvironmentMetricsReadInputV1Schema,
]);
export const TelemetryMetricsActionReadInputV1ProtocolSchema: ProtocolComposableSchema<
    z.input<typeof telemetryMetricsActionReadInputV1Schema>,
    (TelemetryMetricsReadInputV1 | TelemetryEnvironmentMetricsReadInputV1) & ProtocolJsonValue
> = projectZodProtocolSchema(telemetryMetricsActionReadInputV1Schema);
const telemetryMetricsActionReadResultV1Schema = z.union([
    TelemetryMetricsReadResultV1Schema, TelemetryEnvironmentMetricsReadResultV1Schema,
]);
export const TelemetryMetricsActionReadResultV1ProtocolSchema: ProtocolComposableSchema<
    z.input<typeof telemetryMetricsActionReadResultV1Schema>,
    (TelemetryMetricsReadResultV1 | TelemetryEnvironmentMetricsReadResultV1) & ProtocolJsonValue
> = projectZodProtocolSchema(telemetryMetricsActionReadResultV1Schema);

/** Usage retains exact-money metadata in process. Parse the native result before JSON admission. */
export function projectTelemetryMetricsActionReadResultV1(input: z.input<typeof telemetryMetricsActionReadResultV1Schema>) {
    return projectNativeJsonValueForTransport(telemetryMetricsActionReadResultV1Schema.parse(input));
}
export type TelemetryEnvironmentMetricsReadInputV1 = z.infer<typeof TelemetryEnvironmentMetricsReadInputV1Schema>;
export type TelemetryEnvironmentMetricsReadResultV1 = z.infer<typeof TelemetryEnvironmentMetricsReadResultV1Schema>;
export type TelemetryEnvironmentMetricsResourceInputV1 = z.infer<typeof TelemetryEnvironmentMetricsResourceInputV1Schema>;
export const TelemetryMetricsReadResultV1ProtocolSchema: ProtocolComposableSchema<
    z.input<typeof TelemetryMetricsReadResultV1Schema>, TelemetryMetricsReadResultV1 & ProtocolJsonValue
> = projectZodProtocolSchema(TelemetryMetricsReadResultV1Schema);
export const TelemetryMetricsReadInputV1ProtocolSchema: ProtocolComposableSchema<
    z.input<typeof TelemetryMetricsReadInputV1Schema>, TelemetryMetricsReadInputV1 & ProtocolJsonValue
> = projectZodProtocolSchema(TelemetryMetricsReadInputV1Schema);
export const TelemetryKeyFlowMeasureV1ProtocolSchema: ProtocolComposableSchema<
    z.input<typeof TelemetryKeyFlowMeasureV1Schema>, TelemetryKeyFlowMeasureV1 & ProtocolJsonValue
> = projectZodProtocolSchema(TelemetryKeyFlowMeasureV1Schema);
export const TelemetryKeyFlowConfigV1ProtocolSchema: ProtocolComposableSchema<
    z.input<typeof TelemetryKeyFlowConfigV1Schema>, TelemetryKeyFlowConfigV1 & ProtocolJsonValue
> = projectZodProtocolSchema(TelemetryKeyFlowConfigV1Schema);
export type TelemetryMetricsReadResultV1 = z.infer<typeof TelemetryMetricsReadResultV1Schema>;
export type TelemetryMetricsReadInputV1 = z.infer<typeof TelemetryMetricsReadInputV1Schema>;
export type TelemetryKeyFlowConfigV1 = z.infer<typeof TelemetryKeyFlowConfigV1Schema>;
export type TelemetryKeyFlowMeasureV1 = z.infer<typeof TelemetryKeyFlowMeasureV1Schema>;

export const TelemetryEnvironmentMetricsReadInputV1ProtocolSchema: ProtocolComposableSchema<
    z.input<typeof TelemetryEnvironmentMetricsReadInputV1Schema>, TelemetryEnvironmentMetricsReadInputV1 & ProtocolJsonValue
> = projectZodProtocolSchema(TelemetryEnvironmentMetricsReadInputV1Schema);

export const TelemetryEnvironmentMetricsResourceInputV1ProtocolSchema: ProtocolComposableSchema<
    z.input<typeof TelemetryEnvironmentMetricsResourceInputV1Schema>, TelemetryEnvironmentMetricsResourceInputV1 & ProtocolJsonValue
> = projectZodProtocolSchema(TelemetryEnvironmentMetricsResourceInputV1Schema);

export const TelemetryEnvironmentMetricsReadResultV1ProtocolSchema: ProtocolComposableSchema<
    z.input<typeof TelemetryEnvironmentMetricsReadResultV1Schema>, TelemetryEnvironmentMetricsReadResultV1 & ProtocolJsonValue
> = projectZodProtocolSchema(TelemetryEnvironmentMetricsReadResultV1Schema);
