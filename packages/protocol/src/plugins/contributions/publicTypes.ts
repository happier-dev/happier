import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';

export const PluginLocalizedStringV2Schema = z.union([
  z.string().trim().min(1),
  z.object({ key: z.string().trim().min(1), fallback: z.string().trim().min(1) }).strict(),
]);
export type PluginLocalizedStringV2 = z.infer<typeof PluginLocalizedStringV2Schema>;

export const PluginContributionReferenceV2Schema = z.union([
  PluginContributionLocalIdSchema,
  z.object({ pluginId: PluginIdSchema, localId: PluginContributionLocalIdSchema }).strict(),
]);
export type PluginContributionReferenceV2 = z.infer<typeof PluginContributionReferenceV2Schema>;

export type PluginJsonValueV2 = null | boolean | number | string | PluginJsonValueV2[] | { [key: string]: PluginJsonValueV2 };
export const PluginJsonValueV2Schema: z.ZodType<PluginJsonValueV2> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(PluginJsonValueV2Schema),
  z.record(z.string(), PluginJsonValueV2Schema),
]));

export type PluginJsonSchemaV2 = {
  type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
  title?: string;
  description?: string;
  default?: PluginJsonValueV2;
  enum?: PluginJsonValueV2[];
  const?: PluginJsonValueV2;
  properties?: Record<string, PluginJsonSchemaV2>;
  required?: string[];
  additionalProperties?: boolean | PluginJsonSchemaV2;
  items?: PluginJsonSchemaV2;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: PluginJsonSchemaV2[];
  oneOf?: PluginJsonSchemaV2[];
  allOf?: PluginJsonSchemaV2[];
};
export const PluginJsonSchemaV2Schema: z.ZodType<PluginJsonSchemaV2> = z.lazy(() => z.object({
  type: z.enum(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']).optional(),
  title: z.string().optional(), description: z.string().optional(),
  default: PluginJsonValueV2Schema.optional(), enum: z.array(PluginJsonValueV2Schema).optional(), const: PluginJsonValueV2Schema.optional(),
  properties: z.record(z.string(), PluginJsonSchemaV2Schema).optional(), required: z.array(z.string()).optional(),
  additionalProperties: z.union([z.boolean(), PluginJsonSchemaV2Schema]).optional(), items: PluginJsonSchemaV2Schema.optional(),
  minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), pattern: z.string().optional(),
  anyOf: z.array(PluginJsonSchemaV2Schema).optional(), oneOf: z.array(PluginJsonSchemaV2Schema).optional(), allOf: z.array(PluginJsonSchemaV2Schema).optional(),
}).strict());

type PluginPolicyExpressionV2 =
  | { fact: string; operator: string; value: boolean | string }
  | { all: PluginPolicyExpressionV2[] }
  | { any: PluginPolicyExpressionV2[] }
  | { not: PluginPolicyExpressionV2 };
export const PluginPolicyExpressionV2Schema: z.ZodType<PluginPolicyExpressionV2> = z.lazy(() => z.union([
  z.object({ fact: z.enum(['plugin.enabled', 'session.exists', 'project.exists', 'browser.exists']), operator: z.literal('equals'), value: z.boolean() }).strict(),
  z.object({ fact: z.literal('host.platform'), operator: z.enum(['equals', 'notEquals']), value: z.enum(['web', 'ios', 'android', 'desktop']) }).strict(),
  z.object({ fact: z.literal('host.feature'), operator: z.literal('enabled'), value: z.string().trim().min(1) }).strict(),
  z.object({ fact: z.enum(['session.agentId', 'session.state', 'project.id', 'machine.id', 'browser.origin']), operator: z.enum(['equals', 'notEquals']), value: z.string() }).strict(),
  z.object({ fact: z.literal('session.capability'), operator: z.literal('contains'), value: z.string().trim().min(1) }).strict(),
  z.object({ all: z.array(PluginPolicyExpressionV2Schema) }).strict(),
  z.object({ any: z.array(PluginPolicyExpressionV2Schema) }).strict(),
  z.object({ not: PluginPolicyExpressionV2Schema }).strict(),
]));
export const PluginAvailabilityDescriptorV2Schema = z.union([
  z.object({ when: PluginPolicyExpressionV2Schema.optional(), disabledWhen: z.never().optional(), disabledReason: z.never().optional() }).strict(),
  z.object({ when: PluginPolicyExpressionV2Schema.optional(), disabledWhen: PluginPolicyExpressionV2Schema, disabledReason: PluginLocalizedStringV2Schema }).strict(),
]);
export type PluginAvailabilityDescriptorV2 = z.infer<typeof PluginAvailabilityDescriptorV2Schema>;
