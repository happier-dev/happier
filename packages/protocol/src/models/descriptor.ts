import { z } from 'zod';

import { CapabilitySupportSchema } from '../providers/capabilities/v1.js';
import { ProviderModelIdSchema } from '../providers/ids.js';

export const AgentModelOptionValueIdSchema = z.string().trim().min(1).max(256);
export type AgentModelOptionValueId = string;

export type AgentModelOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  type: string;
  currentValue: AgentModelOptionValueId;
  options?: readonly Readonly<{
    value: AgentModelOptionValueId;
    name: string;
    description?: string;
  }>[];
}>;

export const AgentModelOptionSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256),
  description: z.string().max(1024).optional(),
  type: z.string().trim().min(1).max(128),
  currentValue: AgentModelOptionValueIdSchema,
  options: z.array(z.object({
    value: AgentModelOptionValueIdSchema,
    name: z.string().trim().min(1).max(256),
    description: z.string().max(1024).optional(),
  }).strict()).max(128).optional(),
}).strict() satisfies z.ZodType<AgentModelOption>;

export type ProviderModelDescriptorV1 = Readonly<{
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  extendedContextModelId?: string;
  modelOptions?: readonly AgentModelOption[];
  capabilities?: Readonly<{
    toolRoundTrips?: z.infer<typeof CapabilitySupportSchema>;
    reasoningControls?: z.infer<typeof CapabilitySupportSchema>;
  }>;
}>;

export const ProviderModelDescriptorV1Schema = z.object({
  id: ProviderModelIdSchema,
  name: z.string().trim().min(1).max(256),
  description: z.string().max(1024).optional(),
  contextWindowTokens: z.number().int().positive().max(100_000_000).optional(),
  extendedContextModelId: ProviderModelIdSchema.optional(),
  modelOptions: z.array(AgentModelOptionSchema).max(64).optional(),
  capabilities: z.object({
    toolRoundTrips: CapabilitySupportSchema.optional(),
    reasoningControls: CapabilitySupportSchema.optional(),
  }).strict().optional(),
}).strict() satisfies z.ZodType<ProviderModelDescriptorV1>;

export type AgentModelDescriptor = ProviderModelDescriptorV1;
