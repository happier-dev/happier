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

/** Private Environment content: the selected collector and the fingerprint of its installation key at selection. */
export const DeploymentTelemetryCollectorPinV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: DeploymentIdentifierV1Schema, installationKeyFingerprint: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));
export type DeploymentTelemetryCollectorPinV1 = z.infer<typeof DeploymentTelemetryCollectorPinV1Schema>;

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
/** Typed refusals the host Action raises before any bindings write; presenters recover from each in place. */
export const DEPLOYMENT_TELEMETRY_SET_REFUSALS_V1 = ['telemetry_deletion_confirmation_required', 'collector_required',
    'telemetry_role_inactive', 'machine_unavailable'] as const;
export type DeploymentTelemetrySetRefusalV1 = (typeof DEPLOYMENT_TELEMETRY_SET_REFUSALS_V1)[number];
export function isDeploymentTelemetrySetRefusalV1(code: unknown): code is DeploymentTelemetrySetRefusalV1 {
    return typeof code === 'string' && (DEPLOYMENT_TELEMETRY_SET_REFUSALS_V1 as readonly string[]).includes(code);
}

export const DeploymentTelemetryTokenHashV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[a-f0-9]{64}$/u)));
export const DeploymentTelemetryAssignmentsInputV1Schema = lazyZodSchema(() => z.strictObject({}));
export const DeploymentTelemetryAssignmentsV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.literal(true),
    assignments: z.array(z.strictObject({
        environmentId: DeploymentIdentifierV1Schema,
        tokenHash: z.nullable(DeploymentTelemetryTokenHashV1Schema),
        capabilities: z.optional(DeploymentTelemetryCapabilitiesV1Schema),
        /** The Team owning the Environment's Project; the collector's native issue writer shares new issues with it (D34). */
        teamId: z.optional(DeploymentIdentifierV1Schema),
    })),
}));
export type DeploymentTelemetryAssignmentsV1 = z.infer<typeof DeploymentTelemetryAssignmentsV1Schema>;
