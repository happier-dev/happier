import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { PluginPolicyExpressionV2 } from './policyEvaluation.js';
export {
  evaluatePluginPolicyExpressionV2,
  resolveInvocationContributionPolicyFacts,
  evaluateContributionAvailability,
  type PluginPolicyExpressionV2,
  type PluginPolicyFactValueV2,
  type PluginPolicyFactsV2,
  type ContributionAvailabilityOutcome,
  type ContributionAvailabilityDecision,
  type ContributionPolicyFacts,
} from './policyEvaluation.js';

import {
  defineProtocolObject,
  defineProtocolUnion,
} from '../actions/protocolComposableSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  type PluginJsonSchemaV2,
  type PluginJsonValueV2,
} from './jsonSchema.js';

export {
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  type PluginJsonSchemaV2,
  type PluginJsonValueV2,
} from './jsonSchema.js';

export const PluginLocalizedStringV2Schema = lazyZodSchema(() => z.union([
  z.string().check(z.trim(), z.minLength(1)),
  z.strictObject({
    key: z.string().check(z.trim(), z.minLength(1)),
    fallback: z.string().check(z.trim(), z.minLength(1)),
    params: z.optional(z.record(z.string(), z.union([z.string(), z.number()]))),
  }).check(z.superRefine((label, context) => {
    if (!label.params) return;
    const placeholders = new Set([...label.fallback.matchAll(/\{([^{}]+)\}/gu)].map(match => match[1]));
    for (const name of Object.keys(label.params)) {
      if (!placeholders.has(name)) context.addIssue({
        code: 'custom', path: ['params', name], message: 'Parameter must name a fallback placeholder.',
      });
    }
  })),
]));
export type PluginLocalizedStringV2 = z.infer<typeof PluginLocalizedStringV2Schema>;

/** Resolve plain scalar placeholders after a caller has selected its locale text. */
export function resolvePluginLocalizedStringV2Text(value: unknown, translatedText?: string): string {
  if (typeof value === 'string') return value;
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
  const fallback = typeof candidate?.fallback === 'string' ? candidate.fallback : '';
  const text = translatedText ?? fallback;
  if (candidate?.params === undefined) return text;
  const parsed = PluginLocalizedStringV2Schema.safeParse(candidate);
  if (!parsed.success || typeof parsed.data === 'string') return fallback;
  const values = parsed.data.params ?? {};
  const interpolate = (template: string): string | null => {
    const names = new Set<string>();
    let complete = true;
    const rendered = template.replace(/\{([^{}]+)\}/gu, (placeholder, name: string) => {
      names.add(name);
      if (!Object.hasOwn(values, name)) { complete = false; return placeholder; }
      return String(values[name]);
    });
    return complete && Object.keys(values).every(name => names.has(name)) ? rendered : null;
  };
  return interpolate(text) ?? interpolate(fallback) ?? fallback;
}

// Markdown indentation and trailing spaces carry formatting semantics. Keep the
// existing nonblank admission rule without transforming the authored content.
const PluginMarkdownTextV2Schema = lazyZodSchema(() => z.string().check(z.refine((value) => value.trim().length > 0)));
export const PluginLocalizedMarkdownV2Schema = lazyZodSchema(() => z.union([
  PluginMarkdownTextV2Schema,
  z.strictObject({ key: z.string().check(z.trim(), z.minLength(1)), fallback: PluginMarkdownTextV2Schema }),
]));

export const PluginContributionReferenceV2Schema = defineProtocolUnion([
  PluginContributionLocalIdSchema,
  defineProtocolObject({ pluginId: PluginIdSchema, localId: PluginContributionLocalIdSchema }, { policy: 'closed' }),
]);
export type PluginContributionReferenceV2 = ReturnType<typeof PluginContributionReferenceV2Schema.parse>;


export const PluginPolicyExpressionV2Schema: z.ZodMiniType<PluginPolicyExpressionV2> = z.lazy(() => z.union([
  z.strictObject({ fact: z.enum(['plugin.enabled', 'session.exists', 'project.exists', 'browser.exists']), operator: z.literal('equals'), value: z.boolean() }),
  z.strictObject({ fact: z.literal('host.platform'), operator: z.enum(['equals', 'notEquals']), value: z.enum(['web', 'ios', 'android', 'desktop']) }),
  z.strictObject({ fact: z.literal('host.feature'), operator: z.literal('enabled'), value: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ fact: z.enum(['session.agentId', 'session.state', 'project.id', 'machine.id', 'browser.origin']), operator: z.enum(['equals', 'notEquals']), value: z.string() }),
  z.strictObject({ fact: z.literal('session.capability'), operator: z.literal('contains'), value: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ all: z.array(PluginPolicyExpressionV2Schema) }),
  z.strictObject({ any: z.array(PluginPolicyExpressionV2Schema) }),
  z.strictObject({ not: PluginPolicyExpressionV2Schema }),
]));


export const PluginAvailabilityDescriptorV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({ when: z.optional(PluginPolicyExpressionV2Schema), disabledWhen: z.optional(z.never()), disabledReason: z.optional(z.never()) }),
  z.strictObject({ when: z.optional(PluginPolicyExpressionV2Schema), disabledWhen: PluginPolicyExpressionV2Schema, disabledReason: PluginLocalizedStringV2Schema }),
]));
export type PluginAvailabilityDescriptorV2 = z.infer<typeof PluginAvailabilityDescriptorV2Schema>;
