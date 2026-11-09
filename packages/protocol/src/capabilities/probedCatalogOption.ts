import { AgentModelOptionOverrideRuleSchema, type AgentModelOptionOverrideRule } from '../models/descriptor.js';
import { z } from 'zod/mini';
import type { AgentModelsProbeObservation } from './agentProbeObservation.js';
import { NonBlankOpaqueIdentifierSchema } from '../strings/opaqueIdentifier.js';

/**
 * The single normalizer for a probed session-control option.
 *
 * The models probe and the config-options probe receive the same option shape from a plugin's
 * preflight probe and both used to rebuild it field-by-field. A producer-declared field added to
 * one enumeration and forgotten in the other vanishes with no type error and no failing test, so
 * both probes share this owner.
 */

export type ProbedCatalogOptionValue = string | number | boolean | null;

export type ProbedCatalogOptionChoice = Readonly<{
  value: ProbedCatalogOptionValue;
  name: string;
  description?: string;
}>;

export type ProbedCatalogOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: ProbedCatalogOptionValue;
  options?: ReadonlyArray<ProbedCatalogOptionChoice>;
  groups?: readonly Readonly<{ id: string; name: string; options: readonly ProbedCatalogOptionChoice[] }>[];
  /** @experimental Producer-declared. See {@link AgentModelOptionOverrideRule}. */
  overridesWhenOn?: AgentModelOptionOverrideRule;
}>;

const ProbeNonEmptyStringSchema = NonBlankOpaqueIdentifierSchema;
const ProbeDescriptionSchema = z.string();
export const ProbedCatalogOptionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ProbedCatalogOptionChoiceSchema = z.strictObject({
  value: ProbedCatalogOptionValueSchema,
  name: ProbeNonEmptyStringSchema,
  description: z.optional(ProbeDescriptionSchema),
});

/** Normalized catalog shared by native preflight and Session runtime observations. */
export const ProbedCatalogOptionSchema: z.ZodMiniType<ProbedCatalogOption> = z.strictObject({
  id: ProbeNonEmptyStringSchema,
  name: ProbeNonEmptyStringSchema,
  description: z.optional(ProbeDescriptionSchema),
  category: z.optional(z.string()),
  type: ProbeNonEmptyStringSchema,
  currentValue: ProbedCatalogOptionValueSchema,
  options: z.optional(z.readonly(z.array(ProbedCatalogOptionChoiceSchema))),
  groups: z.optional(z.readonly(z.array(z.strictObject({
    id: ProbeNonEmptyStringSchema,
    name: ProbeNonEmptyStringSchema,
    options: z.readonly(z.array(ProbedCatalogOptionChoiceSchema)),
  })))),
  overridesWhenOn: z.optional(AgentModelOptionOverrideRuleSchema),
});

const ProbedCatalogOptionChoiceInputSchema = z.object({
  value: z.optional(z.unknown()),
  name: ProbeNonEmptyStringSchema,
  description: z.optional(ProbeDescriptionSchema),
});

const ProbedCatalogOptionInputSchema = z.object({
  id: ProbeNonEmptyStringSchema,
  name: ProbeNonEmptyStringSchema,
  description: z.optional(ProbeDescriptionSchema),
  category: z.optional(z.string()),
  type: ProbeNonEmptyStringSchema,
  currentValue: z.optional(z.unknown()),
  options: z.optional(z.array(z.unknown())),
  groups: z.optional(z.array(z.object({
    id: ProbeNonEmptyStringSchema,
    name: ProbeNonEmptyStringSchema,
    options: z.array(z.unknown()),
  }))),
  // A malformed rule must not discard the whole option, so it is parsed separately below.
  overridesWhenOn: z.optional(z.unknown()),
});

export function normalizeProbedOptionValue(value: unknown): ProbedCatalogOptionValue {
  const parsed = ProbedCatalogOptionValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normalizeProbedCatalogOptionChoice(choiceRaw: unknown): ProbedCatalogOptionChoice | null {
  const parsed = ProbedCatalogOptionChoiceInputSchema.safeParse(choiceRaw);
  if (!parsed.success) return null;

  const { value, name, description } = parsed.data;
  return {
    value: normalizeProbedOptionValue(value),
    name,
    ...(description !== undefined ? { description } : {}),
  };
}

export function normalizeProbedCatalogOption(optionRaw: unknown): ProbedCatalogOption | null {
  const parsed = ProbedCatalogOptionInputSchema.safeParse(optionRaw);
  if (!parsed.success) return null;

  const choices = parsed.data.options
    ?.map((choice) => normalizeProbedCatalogOptionChoice(choice))
    .filter((choice): choice is ProbedCatalogOptionChoice => choice !== null);
  const groups = parsed.data.groups?.map(group => ({
    id: group.id,
    name: group.name,
    options: group.options.map(normalizeProbedCatalogOptionChoice).filter((choice): choice is ProbedCatalogOptionChoice => choice !== null),
  }));

  // Parsed through the canonical producer schema so a probe never publishes a rule shape the
  // strict owner-metadata envelope would reject.
  const overridesWhenOn = AgentModelOptionOverrideRuleSchema.safeParse(parsed.data.overridesWhenOn);

  return {
    id: parsed.data.id,
    name: parsed.data.name,
    type: parsed.data.type,
    currentValue: normalizeProbedOptionValue(parsed.data.currentValue),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
    ...(choices && choices.length > 0 ? { options: choices } : {}),
    ...(groups ? { groups } : {}),
    ...(overridesWhenOn.success ? { overridesWhenOn: overridesWhenOn.data } : {}),
  };
}

export type ConfigOptionDefinition = Readonly<{
  id: string;
  label: string;
  type: string;
  description?: string;
  options?: readonly Readonly<{
    value: ProbedCatalogOptionValue;
    label: string;
    description?: string;
  }>[];
}>;

/** Public discovery combines only the selected model's controls with session-wide controls. */
export function projectProbedConfigOptionDefinitions(args: Readonly<{
  configOptions: readonly unknown[];
  source: 'static' | 'dynamic' | 'unavailable';
  modelId?: string;
  models?: Pick<AgentModelsProbeObservation, 'availableModels' | 'source'> | null;
}>): Readonly<{ items: readonly ConfigOptionDefinition[]; source: 'static' | 'dynamic' | 'unavailable' }> {
  const modelOptions = args.modelId
    ? args.models?.availableModels.find(model => model.id === args.modelId)?.modelOptions ?? [] : [];
  const items: ConfigOptionDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of [...modelOptions, ...args.configOptions]) {
    const option = normalizeProbedCatalogOption(raw);
    if (!option || seen.has(option.id)) continue;
    seen.add(option.id);
    // Definition reads must never disclose the current selection from either native probe.
    items.push({
      id: option.id,
      label: option.name,
      type: option.type,
      ...(option.description ? { description: option.description } : {}),
      ...(option.options?.length ? { options: option.options.map(choice => ({
        value: choice.value,
        label: choice.name,
        ...(choice.description ? { description: choice.description } : {}),
      })) } : {}),
    });
  }
  return { items, source: (modelOptions.length ? args.models?.source : args.source) ?? 'unavailable' };
}
