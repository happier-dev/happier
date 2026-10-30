import { z } from 'zod/mini';
import { lazyZodSchema, lazyDefinition } from '../lazyZodSchema.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionInputForgeEvidenceV1Schema } from '../sessions/messages/sessionInputForgeEvidenceV1.js';
import { DeploymentTimestampV1Schema } from './deploymentIdentifiersV1.js';

/** Finite built-ins; installed qualified kinds use the contribution catalog. */
export const HEALTH_CHECK_KINDS_V1 = ['http', 'certificate', 'tcp', 'dns', 'heartbeat'] as const;
export const HealthCheckKindV1Schema = lazyZodSchema(() => z.enum(HEALTH_CHECK_KINDS_V1));
export type HealthCheckKindV1 = z.infer<typeof HealthCheckKindV1Schema>;
export const HealthCheckStatusV1Schema = lazyZodSchema(() => z.enum(['up', 'down', 'degraded', 'unknown']));
export type HealthCheckStatusV1 = z.infer<typeof HealthCheckStatusV1Schema>;

/**
 * Data only. As for incumbent Forge alert evidence, its enclosing Action/Event
 * owns the byte budget. Producers project facts, never bodies or credentials.
 * Request freshness is returned to the requester; equal ticks are not persisted.
 */
export const HealthCheckResultV1Schema = lazyZodSchema(() => z.strictObject({
    status: HealthCheckStatusV1Schema,
    observedAt: DeploymentTimestampV1Schema,
    latencyMs: z.optional(z.number().check(z.nonnegative())),
    evidence: asProtocolZod(SessionInputForgeEvidenceV1Schema),
}));
export type HealthCheckResultV1 = z.infer<typeof HealthCheckResultV1Schema>;
export const HealthCheckResultV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckResultV1Schema));
