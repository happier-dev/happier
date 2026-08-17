import { z } from 'zod';

import {
  defineProtocolObject,
  defineProtocolUnion,
} from '../actions/jsonSchemaValidation.js';
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

export const PluginLocalizedStringV2Schema = z.union([
  z.string().trim().min(1),
  z.object({ key: z.string().trim().min(1), fallback: z.string().trim().min(1) }).strict(),
]);
export type PluginLocalizedStringV2 = z.infer<typeof PluginLocalizedStringV2Schema>;

export const PluginContributionReferenceV2Schema = defineProtocolUnion([
  PluginContributionLocalIdSchema,
  defineProtocolObject({ pluginId: PluginIdSchema, localId: PluginContributionLocalIdSchema }, { policy: 'closed' }),
]);
export type PluginContributionReferenceV2 = ReturnType<typeof PluginContributionReferenceV2Schema.parse>;


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
