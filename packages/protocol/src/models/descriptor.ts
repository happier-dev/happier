import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { CapabilitySupportSchema } from '../providers/capabilities/v1.js';
import { ProviderModelIdSchema } from '../providers/ids.js';

export const AgentModelOptionValueIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
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
export const AgentModelOptionOverrideRuleSchema = z.strictObject({
  optionIds: z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))).check(z.minLength(1), z.maxLength(32)),
  forcedValue: z.optional(AgentModelOptionValueIdSchema),
}) satisfies z.ZodMiniType<AgentModelOptionOverrideRule>;

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
) satisfies z.ZodMiniType<AgentModelOptionOverrideRule>;

export const AgentModelOptionSchema = z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  description: z.optional(z.string().check(z.maxLength(1024))),
  type: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  currentValue: AgentModelOptionValueIdSchema,
  options: z.optional(z.array(z.strictObject({
    value: AgentModelOptionValueIdSchema,
    name: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    description: z.optional(z.string().check(z.maxLength(1024))),
  })).check(z.maxLength(128))),
  overridesWhenOn: z.optional(AgentModelOptionOverrideRuleSchema),
}) satisfies z.ZodMiniType<AgentModelOption>;

/** Exact model/template evidence; chat compatibility alone never grants this operation. */
export const ProviderModelInlineCompletionV1Schema = z.strictObject({
  operationId: z.string().check(z.trim(), z.minLength(1)),
  tokenAccounting: z.literal('utf8-bytes'),
  outputTokens: z.optional(z.number().check(z.int(), z.positive())),
  maxOutputTokens: z.optional(z.number().check(z.int(), z.positive())),
  promptOverheadTokens: z.number().check(z.int(), z.nonnegative()),
  rawFimTemplate: z.optional(z.strictObject({ prefix: z.string(), suffix: z.string(), middle: z.string() })),
});
export type ProviderModelInlineCompletionV1 = z.infer<typeof ProviderModelInlineCompletionV1Schema>;
export const ProviderModelNextEditV1Schema = z.omit(ProviderModelInlineCompletionV1Schema, { rawFimTemplate: true });
export type ProviderModelNextEditV1 = z.infer<typeof ProviderModelNextEditV1Schema>;

export type ProviderModelDescriptorV1 = Readonly<{
  id: string;
  name: string;
  /** Catalog-owned relative cost class; absence never implies a low-cost model. */
  costTier?: 'low' | 'standard' | 'premium';
  /** Provider/source-owned request spellings for this exact canonical model. */
  aliases?: readonly string[];
  description?: string;
  contextWindowTokens?: number;
  inlineCompletion?: ProviderModelInlineCompletionV1;
  nextEdit?: ProviderModelNextEditV1;
  extendedContextModelId?: string;
  modelOptions?: readonly AgentModelOption[];
  capabilities?: Readonly<{
    toolRoundTrips?: z.infer<typeof CapabilitySupportSchema>;
    reasoningControls?: z.infer<typeof CapabilitySupportSchema>;
    structuredOutput?: z.infer<typeof CapabilitySupportSchema>;
  }>;
}>;

export const ProviderModelDescriptorV1Schema = z.strictObject({
  id: ProviderModelIdSchema,
  name: z.string().check(z.trim(), z.minLength(1)),
  costTier: z.optional(z.enum(['low', 'standard', 'premium'])),
  aliases: z.optional(z.array(ProviderModelIdSchema)),
  description: z.optional(z.string()),
  contextWindowTokens: z.optional(z.number().check(z.int(), z.positive(), z.maximum(100_000_000))),
  inlineCompletion: z.optional(ProviderModelInlineCompletionV1Schema),
  nextEdit: z.optional(ProviderModelNextEditV1Schema),
  extendedContextModelId: z.optional(ProviderModelIdSchema),
  modelOptions: z.optional(z.array(AgentModelOptionSchema)),
  capabilities: z.optional(z.strictObject({
    toolRoundTrips: z.optional(CapabilitySupportSchema),
    reasoningControls: z.optional(CapabilitySupportSchema),
    structuredOutput: z.optional(CapabilitySupportSchema),
  })),
}).check(z.superRefine((value, context) => {
  if (value.aliases) {
    if (new Set(value.aliases).size !== value.aliases.length) {
      context.addIssue({ code: 'custom', path: ['aliases'], message: 'Model aliases must be unique' });
    }
    if (value.aliases.includes(value.id)) {
      context.addIssue({ code: 'custom', path: ['aliases'], message: 'A canonical model id cannot alias itself' });
    }
  }
})) satisfies z.ZodMiniType<ProviderModelDescriptorV1>;

/** Byte-level BPE cannot produce more tokens than UTF-8 bytes. Only a model
 * producer that has proved that tokenizer may declare this conservative bound.
 * This allocates context, not a guessed characters-per-token approximation. */
export function budgetInlineCompletionContext(
  model: ProviderModelDescriptorV1,
  context: Readonly<{ prefix: string; suffix: string }>,
  outputTokens = model.inlineCompletion?.outputTokens,
): Readonly<{ prefix: string; suffix: string }> | null {
  const operation = model.inlineCompletion;
  const capacity = model.contextWindowTokens;
  if (!operation || !capacity || !outputTokens || !Number.isSafeInteger(outputTokens) || outputTokens <= 0
    || operation.maxOutputTokens !== undefined && outputTokens > operation.maxOutputTokens) return null;
  const budget = capacity - outputTokens - operation.promptOverheadTokens;
  if (budget <= 0) return null;
  const take = (value: string, bytes: number, end: boolean) => {
    let used = 0;
    let boundary = end ? value.length : 0;
    while (end ? boundary > 0 : boundary < value.length) {
      const offset = end ? boundary - 1 : boundary;
      const low = value.charCodeAt(offset);
      const width = end
        ? low >= 0xdc00 && low <= 0xdfff && offset > 0 && value.charCodeAt(offset - 1) >= 0xd800 && value.charCodeAt(offset - 1) <= 0xdbff ? 2 : 1
        : (value.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
      const next = end ? value.slice(boundary - width, boundary) : value.slice(boundary, boundary + width);
      const point = next.codePointAt(0) ?? 0;
      let cost = 0;
      for (const character of next) {
        const value = character.codePointAt(0) ?? point;
        cost += value <= 0x7f ? 1 : value <= 0x7ff ? 2 : value <= 0xffff ? 3 : 4;
      }
      if (used + cost > bytes) break;
      used += cost;
      boundary += end ? -width : width;
    }
    return { text: end ? value.slice(boundary) : value.slice(0, boundary), bytes: used };
  };
  let prefix = take(context.prefix, Math.ceil(budget / 2), true);
  let suffix = take(context.suffix, budget - prefix.bytes, false);
  prefix = take(context.prefix, budget - suffix.bytes, true);
  suffix = take(context.suffix, budget - prefix.bytes, false);
  return { prefix: prefix.text, suffix: suffix.text };
}

/** Connection generation preferences specialize the same descriptor consumed by
 * source pickers and runtime inference; callers do not reconstruct this fact. */
export function projectProviderModelGenerationSettings(
  model: ProviderModelDescriptorV1,
  settings: Readonly<{ maxTokens?: number | null }> | undefined,
): ProviderModelDescriptorV1 {
  if ((!model.inlineCompletion && !model.nextEdit) || settings?.maxTokens == null) return model;
  // Nonpositive retained settings are valid stored intent, but unusable for
  // inference: do not publish an invalid descriptor or silently use a default.
  if (settings.maxTokens <= 0) return { ...model, inlineCompletion: undefined, nextEdit: undefined };
  return { ...model,
    ...(model.inlineCompletion ? { inlineCompletion: { ...model.inlineCompletion, outputTokens: settings.maxTokens } } : {}),
    ...(model.nextEdit ? { nextEdit: { ...model.nextEdit, outputTokens: settings.maxTokens } } : {}),
  };
}

/** Whole-file prediction cannot silently become a near-caret capability. Reuse
 * the tokenizer/context owner, but admit the complete serialized input or none. */
export function fitsNextEditContext(model: ProviderModelDescriptorV1, prompt: string): boolean {
  if (!model.nextEdit) return false;
  const context = budgetInlineCompletionContext({ ...model, inlineCompletion: model.nextEdit }, { prefix: prompt, suffix: '' });
  return context?.prefix === prompt;
}

export type AgentModelDescriptor = ProviderModelDescriptorV1;

/** Display-only lookup over contributed facts; never rewrites a request id or infers an alias. */
export function resolveModelDisplayName(
  model: Readonly<{ id: string; name?: string }>,
  catalog: readonly Pick<ProviderModelDescriptorV1, 'id' | 'name' | 'aliases'>[],
): string {
  const supplied = model.name?.trim();
  if (supplied && supplied !== model.id) return supplied;
  let name: string | undefined;
  for (const candidate of catalog) {
    if (candidate.id !== model.id && !candidate.aliases?.includes(model.id)) continue;
    if (name !== undefined && name !== candidate.name) return model.id;
    name = candidate.name;
  }
  return name ?? model.id;
}

/** Catalog membership and the exact Agent's declared JSON contract establish support.
 * A freeform id never borrows that contract; explicit model evidence always wins.
 * This describes JSON publication with host validation/repair, not native schema enforcement.
 */
export function resolveModelStructuredOutputSupport(params: Readonly<{
  model?: Pick<ProviderModelDescriptorV1, 'capabilities'> | null;
  catalogModel: boolean;
  agentFormats?: readonly string[] | null;
}>): z.infer<typeof CapabilitySupportSchema> {
  const explicit = params.model?.capabilities?.structuredOutput;
  if (explicit !== undefined) return explicit;
  return params.catalogModel && params.agentFormats?.includes('json') === true ? 'supported' : 'unknown';
}
