import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProviderModelDescriptorV1Schema } from '../models/descriptor.js';
import { ProbedCatalogOptionSchema } from './probedCatalogOption.js';
import { SpawnFailureV1Schema } from '../machines/processes/spawnFailureV1.js';
import { z } from '../zodRuntimePolicy.js';
import { NonBlankOpaqueIdentifierSchema } from '../strings/opaqueIdentifier.js';
import { SessionRuntimeFailureCauseV1Schema } from '../sessions/control/runtimeIssueV1.js';

/** Native preflight observations, distinct from the public inventory projection. */
export const AgentProbeModelSchema = lazyZodSchema(() => z.strictObject({
  id: NonBlankOpaqueIdentifierSchema,
  name: NonBlankOpaqueIdentifierSchema,
  description: z.optional(z.string()),
  contextWindowTokens: z.optional(z.number().check(z.int(), z.positive(), z.maximum(100_000_000))),
  /** Native per-input text bound in Unicode scalar values, independent of context tokens. */
  extendedContextModelId: z.optional(NonBlankOpaqueIdentifierSchema),
  modelOptions: z.optional(z.readonly(z.array(ProbedCatalogOptionSchema))),
  capabilities: ProviderModelDescriptorV1Schema.shape.capabilities,
  costTier: ProviderModelDescriptorV1Schema.shape.costTier,
}));
export type AgentProbeModel = z.output<typeof AgentProbeModelSchema>;

// Agent identity and source were not required by the incumbent UI native readers.
// Neither optional field establishes selected-backend membership or runtime custody.
const AgentProbeObservationFields = {
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  source: z.optional(z.enum(['dynamic', 'static', 'unavailable'])),
};

export const AgentModelsProbeObservationSchema = lazyZodSchema(() => z.strictObject({
  ...AgentProbeObservationFields,
  availableModels: z.readonly(z.array(AgentProbeModelSchema)),
  supportsFreeform: z.boolean(),
  observedAt: z.optional(z.number().check(z.nonnegative())),
  refreshError: z.optional(z.boolean()),
  refreshErrorMessage: z.optional(z.string()),
  failureCause: z.optional(SessionRuntimeFailureCauseV1Schema),
  spawnFailure: z.optional(SpawnFailureV1Schema),
  cacheable: z.optional(z.boolean()),
  runtimeDescriptorV1Accepted: z.optional(z.boolean()),
}));
export type AgentModelsProbeObservation = z.output<typeof AgentModelsProbeObservationSchema>;

export const AgentProbeModeSchema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  name: z.string().check(z.trim(), z.minLength(1)),
  description: z.optional(z.string()),
}));
export type AgentProbeMode = z.output<typeof AgentProbeModeSchema>;

export const AgentSessionModesProbeObservationSchema = lazyZodSchema(() => z.strictObject({
  ...AgentProbeObservationFields,
  availableModes: z.readonly(z.array(AgentProbeModeSchema)),
}));
export type AgentSessionModesProbeObservation = z.output<typeof AgentSessionModesProbeObservationSchema>;

export const AgentConfigOptionsProbeObservationSchema = lazyZodSchema(() => z.strictObject({
  ...AgentProbeObservationFields,
  configOptions: z.readonly(z.array(ProbedCatalogOptionSchema)),
  modelConfigOptionId: z.optional(NonBlankOpaqueIdentifierSchema),
  refreshError: z.optional(z.boolean()),
  refreshErrorMessage: z.optional(z.string()),
  failureCause: z.optional(SessionRuntimeFailureCauseV1Schema),
}));
export type AgentConfigOptionsProbeObservation = z.output<typeof AgentConfigOptionsProbeObservationSchema>;
