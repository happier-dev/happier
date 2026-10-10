import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProviderModelDescriptorV1Schema } from '../models/descriptor.js';
import { ProbedCatalogOptionSchema } from './probedCatalogOption.js';
import { z } from 'zod';

/** Native preflight observations, distinct from the public inventory projection. */
export const AgentProbeModelSchema = lazyZodSchema(() => z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().optional(),
  contextWindowTokens: z.number().int().positive().max(100_000_000).optional(),
  extendedContextModelId: z.string().trim().min(1).optional(),
  modelOptions: z.array(ProbedCatalogOptionSchema).readonly().optional(),
  capabilities: ProviderModelDescriptorV1Schema.shape.capabilities,
}).strict());
export type AgentProbeModel = z.output<typeof AgentProbeModelSchema>;

// Agent identity and source were not required by the incumbent UI native readers.
// Neither optional field establishes selected-backend membership or runtime custody.
const AgentProbeObservationFields = {
  agentId: z.string().trim().min(1).optional(),
  source: z.enum(['dynamic', 'static', 'unavailable']).optional(),
};

export const AgentModelsProbeObservationSchema = lazyZodSchema(() => z.object({
  ...AgentProbeObservationFields,
  availableModels: z.array(AgentProbeModelSchema).readonly(),
  supportsFreeform: z.boolean(),
  observedAt: z.number().finite().nonnegative().optional(),
  refreshError: z.boolean().optional(),
  cacheable: z.boolean().optional(),
  runtimeDescriptorV1Accepted: z.boolean().optional(),
}).strict());
export type AgentModelsProbeObservation = z.output<typeof AgentModelsProbeObservationSchema>;

export const AgentProbeModeSchema = lazyZodSchema(() => z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().optional(),
}).strict());
export type AgentProbeMode = z.output<typeof AgentProbeModeSchema>;

export const AgentSessionModesProbeObservationSchema = lazyZodSchema(() => z.object({
  ...AgentProbeObservationFields,
  availableModes: z.array(AgentProbeModeSchema).readonly(),
}).strict());
export type AgentSessionModesProbeObservation = z.output<typeof AgentSessionModesProbeObservationSchema>;

export const AgentConfigOptionsProbeObservationSchema = lazyZodSchema(() => z.object({
  ...AgentProbeObservationFields,
  configOptions: z.array(ProbedCatalogOptionSchema).readonly(),
}).strict());
export type AgentConfigOptionsProbeObservation = z.output<typeof AgentConfigOptionsProbeObservationSchema>;
