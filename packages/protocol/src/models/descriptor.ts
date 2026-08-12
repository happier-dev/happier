import { z } from 'zod';

import { CapabilitySupportSchema } from '../providers/capabilities/v1.js';
import { ProviderModelIdSchema } from '../providers/ids.js';

export const AgentModelOptionValueIdSchema = z.string().trim().min(1).max(256);
export type AgentModelOptionValueId = string;

/**
 * @experimental
 *
 * Declared by a boolean model option whose ON state overrides other options on the same
 * model: while it is effectively on, `optionIds` are not user-controllable, and — when
 * `forcedValue` is given — the agent actually runs those options at that value regardless
 * of what the user stored. The producing agent owns this fact because only it knows what
 * its own toggle does (e.g. Claude's `ultracode` runs `reasoning_effort` at `xhigh`).
 */
export type AgentModelOptionOverrideRule = Readonly<{
  optionIds: readonly string[];
  forcedValue?: AgentModelOptionValueId;
}>;

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
  /** @experimental See {@link AgentModelOptionOverrideRule}. Boolean options only. */
  overridesWhenOn?: AgentModelOptionOverrideRule;
}>;

/**
 * The producer contract for {@link AgentModelOptionOverrideRule} — the WRITE side. It is
 * `.strict()` because an agent must not author an undeclared field: the owner-metadata envelopes
 * are strict too, and would reject the entire session metadata rather than strip it.
 */
export const AgentModelOptionOverrideRuleSchema = z.object({
  optionIds: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
  forcedValue: AgentModelOptionValueIdSchema.optional(),
}).strict() satisfies z.ZodType<AgentModelOptionOverrideRule>;

/**
 * The READ side of the same rule, and the single owner of the unknown-key policy for reading one
 * back out of persisted metadata.
 *
 * Every reader of an already-persisted rule uses this — the UI's session-control parse and the
 * CLI's fork/spawn catalog inheritance — because a reader that rejects on an unrecognized nested
 * key makes a NEWER producer's added field destroy the rule (and, inside a strict parent, the whole
 * parse) in an OLDER client. Readers degrade to the fields they know instead. Bounds are shared
 * with the strict schema above, so a reader can never accept a rule the producer contract forbids.
 */
export const AgentModelOptionOverrideRuleReadSchema = z.object(
  AgentModelOptionOverrideRuleSchema.shape,
) satisfies z.ZodType<AgentModelOptionOverrideRule>;

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
  overridesWhenOn: AgentModelOptionOverrideRuleSchema.optional(),
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
