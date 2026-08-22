import { AgentModelOptionOverrideRuleSchema, type AgentModelOptionOverrideRule } from '@happier-dev/protocol';
import { z } from 'zod';

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
  type: string;
  currentValue: ProbedCatalogOptionValue;
  options?: ReadonlyArray<ProbedCatalogOptionChoice>;
  /** @experimental Producer-declared. See {@link AgentModelOptionOverrideRule}. */
  overridesWhenOn?: AgentModelOptionOverrideRule;
}>;

const ProbeNonEmptyStringSchema = z.string().trim().min(1);
const ProbeDescriptionSchema = z.string();
const ProbeOptionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const ProbedCatalogOptionChoiceInputSchema = z.object({
  value: z.unknown().optional(),
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
});

const ProbedCatalogOptionInputSchema = z.object({
  id: ProbeNonEmptyStringSchema,
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
  type: ProbeNonEmptyStringSchema,
  currentValue: z.unknown().optional(),
  options: z.array(z.unknown()).optional(),
  // A malformed rule must not discard the whole option, so it is parsed separately below.
  overridesWhenOn: z.unknown().optional(),
});

export function normalizeProbedOptionValue(value: unknown): ProbedCatalogOptionValue {
  const parsed = ProbeOptionValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normalizeProbedCatalogOptionChoice(choiceRaw: unknown): ProbedCatalogOptionChoice | null {
  const parsed = ProbedCatalogOptionChoiceInputSchema.safeParse(choiceRaw);
  if (!parsed.success) return null;

  const { value, name, description } = parsed.data;
  return {
    value: normalizeProbedOptionValue(value),
    name,
    ...(description ? { description } : {}),
  };
}

export function normalizeProbedCatalogOption(optionRaw: unknown): ProbedCatalogOption | null {
  const parsed = ProbedCatalogOptionInputSchema.safeParse(optionRaw);
  if (!parsed.success) return null;

  const choices = parsed.data.options
    ?.map((choice) => normalizeProbedCatalogOptionChoice(choice))
    .filter((choice): choice is ProbedCatalogOptionChoice => choice !== null);

  // Parsed through the canonical producer schema so a probe never publishes a rule shape the
  // strict owner-metadata envelope would reject.
  const overridesWhenOn = AgentModelOptionOverrideRuleSchema.safeParse(parsed.data.overridesWhenOn);

  return {
    id: parsed.data.id,
    name: parsed.data.name,
    type: parsed.data.type,
    currentValue: normalizeProbedOptionValue(parsed.data.currentValue),
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
    ...(choices && choices.length > 0 ? { options: choices } : {}),
    ...(overridesWhenOn.success ? { overridesWhenOn: overridesWhenOn.data } : {}),
  };
}
