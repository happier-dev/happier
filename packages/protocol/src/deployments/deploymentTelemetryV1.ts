import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';

/** Deliberate enrichment choices. Older bindings omit these and remain off. */
export const DeploymentTelemetryCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
    metrics: z.optional(z.boolean()), appLlmCost: z.optional(z.boolean()), exceptions: z.optional(z.boolean()),
}));
export type DeploymentTelemetryCapabilitiesV1 = z.infer<typeof DeploymentTelemetryCapabilitiesV1Schema>;
export function resolveDeploymentTelemetryCapabilitiesV1(value?: DeploymentTelemetryCapabilitiesV1) {
    return { metrics: value?.metrics === true, appLlmCost: value?.appLlmCost === true, exceptions: value?.exceptions === true };
}

/** Host intent; placement and the owned bindings settle in the existing bindings CAS. */
export const DeploymentEnvironmentTelemetrySetInputV1Schema = lazyZodSchema(() => z.strictObject({
    serverId: DeploymentIdentifierV1Schema,
    environmentId: DeploymentIdentifierV1Schema,
    expectedRevision: DeploymentRevisionV1Schema,
    collector: z.optional(z.nullable(z.strictObject({ machineId: DeploymentIdentifierV1Schema }))),
    capabilities: z.optional(DeploymentTelemetryCapabilitiesV1Schema),
    rotate: z.optional(z.literal(true)),
    confirmDelete: z.optional(z.literal(true)),
}));
export type DeploymentEnvironmentTelemetrySetInputV1 = z.infer<typeof DeploymentEnvironmentTelemetrySetInputV1Schema>;
export const DeploymentEnvironmentTelemetrySetSuccessV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.literal(true), environmentId: DeploymentIdentifierV1Schema,
    revision: DeploymentRevisionV1Schema, state: z.literal('redeploy_required'),
}));
export type DeploymentEnvironmentTelemetrySetSuccessV1 = z.infer<typeof DeploymentEnvironmentTelemetrySetSuccessV1Schema>;

export const DeploymentTelemetryTokenHashV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[a-f0-9]{64}$/u)));
export const DeploymentTelemetryAssignmentsInputV1Schema = lazyZodSchema(() => z.strictObject({}));
export const DeploymentTelemetryAssignmentsV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.literal(true),
    assignments: z.array(z.strictObject({
        environmentId: DeploymentIdentifierV1Schema,
        tokenHash: z.nullable(DeploymentTelemetryTokenHashV1Schema),
        capabilities: z.optional(DeploymentTelemetryCapabilitiesV1Schema),
    })),
}));
export type DeploymentTelemetryAssignmentsV1 = z.infer<typeof DeploymentTelemetryAssignmentsV1Schema>;
