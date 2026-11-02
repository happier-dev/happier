import { z } from 'zod/mini';
import { HealthCheckStatusV1Schema } from './healthCheckV1.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';

export const DeploymentHealthStatusV1Schema = HealthCheckStatusV1Schema;
export type DeploymentHealthStatusV1 = z.infer<typeof DeploymentHealthStatusV1Schema>;
export const DeploymentHealthRoleV1Schema = z.enum(['runtime', 'edge']);
export type DeploymentHealthRoleV1 = z.infer<typeof DeploymentHealthRoleV1Schema>;

/** Semantic owner evidence; observation clocks remain in the native observer. */
export const DeploymentHealthRoleEvidenceV1Schema = z.strictObject({
    role: DeploymentHealthRoleV1Schema, status: DeploymentHealthStatusV1Schema,
    source: z.enum(['native', 'privateProbe', 'domain', 'presence', 'unobserved']),
    reason: z.optional(id), expectedOperationId: z.optional(id),
    expectedDown: z.optional(z.literal('stop')),
});
export type DeploymentHealthRoleEvidenceV1 = z.infer<typeof DeploymentHealthRoleEvidenceV1Schema>;
export const DeploymentHealthMemberV1Schema = z.strictObject({
    machineId: id, installationId: z.optional(id),
    roles: z.array(DeploymentHealthRoleV1Schema).check(z.minLength(1)),
    status: DeploymentHealthStatusV1Schema,
    evidence: z.array(DeploymentHealthRoleEvidenceV1Schema).check(z.minLength(1)),
});
export type DeploymentHealthMemberV1 = z.infer<typeof DeploymentHealthMemberV1Schema>;

/** P40 alone projects this fact; C1 transports the same typed result. */
export const DeploymentEnvironmentHealthAggregateV1Schema = z.strictObject({
    v: z.literal(1), environmentId: id, targetLinkId: id,
    protection: z.enum(['production', 'nonProduction']), status: DeploymentHealthStatusV1Schema,
    n: z.number().check(z.int(), z.nonnegative()), down: z.number().check(z.int(), z.nonnegative()),
    degraded: z.number().check(z.int(), z.nonnegative()),
    // Production unknown contributes to down once; intentional Stop does not.
    unknown: z.number().check(z.int(), z.nonnegative()),
    members: z.array(DeploymentHealthMemberV1Schema), affectedMachineIds: z.array(id),
    expectedDown: z.optional(z.literal('stop')),
    edgeUnreachable: z.boolean(), authoritativeRecovery: z.boolean(),
});
export type DeploymentEnvironmentHealthAggregateV1 = z.infer<typeof DeploymentEnvironmentHealthAggregateV1Schema>;
