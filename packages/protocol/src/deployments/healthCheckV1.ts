import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema, lazyDefinition } from '../lazyZodSchema.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionInputForgeEvidenceV1Schema } from '../sessions/messages/sessionInputForgeEvidenceV1.js';
import { DeploymentTimestampV1Schema } from './deploymentIdentifiersV1.js';

/** Finite built-ins; installed qualified kinds use the contribution catalog. */
export const HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 = 'happier.machine.services';
/** Public client Action: opens the saved-check editor without executing setup. */
export const HEALTH_CHECK_SETUP_OPEN_ACTION_REF_V1 = {
  pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health/open-setup',
} as const;
export const HEALTH_CHECK_EVENT_REFS_V1 = {
  status: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health-status' },
  failed: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health-check-failed' },
  recovered: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health-check-recovered' },
} as const;
export const HEALTH_CHECK_KINDS_V1 = ['http', 'certificate', 'tcp', 'dns', 'heartbeat'] as const;
export const HealthCheckKindV1Schema = lazyZodSchema(() => z.enum(HEALTH_CHECK_KINDS_V1));
export type HealthCheckKindV1 = z.infer<typeof HealthCheckKindV1Schema>;
export const HealthCheckStatusV1Schema = lazyZodSchema(() => z.enum(['up', 'down', 'degraded', 'unknown']));
export type HealthCheckStatusV1 = z.infer<typeof HealthCheckStatusV1Schema>;

/** Finite producer diagnostics share the health Action's recursively closed
 * publication contract; retained readers own additive-field projection. */
const finiteCause = lazyZodSchema(() => z.strictObject({
    kind: HealthCheckKindV1Schema,
    vantage: z.enum(['sameMachine', 'outside']),
    observerMachineId: z.string(),
    reason: z.optional(z.string()),
    httpStatus: z.optional(z.number().check(z.int())),
    expectStatus: z.optional(z.number().check(z.int())),
    providerCode: z.optional(z.number().check(z.int())),
    keywordMatched: z.optional(z.boolean()),
    recordType: z.optional(z.string()),
    fingerprint256: z.optional(z.string()),
    notBefore: z.optional(z.number()),
    notAfter: z.optional(z.number()),
    disclosure: z.optional(z.string()),
    requiredFact: z.optional(z.string()),
    remedy: z.optional(z.string()),
}));

/**
 * Data only. As for incumbent Forge alert evidence, its enclosing Action/Event
 * owns the byte budget. Producers project facts, never bodies or credentials.
 * Request freshness is returned to the requester; equal ticks are not persisted.
 */
export const HealthCheckResultV1Schema = lazyZodSchema(() => z.strictObject({
    status: HealthCheckStatusV1Schema,
    observedAt: DeploymentTimestampV1Schema,
    latencyMs: z.optional(z.number().check(z.nonnegative())),
    cause: z.optional(finiteCause),
    evidence: asProtocolZod(SessionInputForgeEvidenceV1Schema),
}));
export type HealthCheckResultV1 = z.infer<typeof HealthCheckResultV1Schema>;
export const HealthCheckResultV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckResultV1Schema));
