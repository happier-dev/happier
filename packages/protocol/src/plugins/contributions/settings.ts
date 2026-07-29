import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';

export type PluginSettingFieldSchemaV2 = {
  type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
  title?: string; description?: string; enum?: unknown[]; const?: unknown;
  properties?: Record<string, PluginSettingFieldSchemaV2>; required?: string[];
  additionalProperties?: boolean | PluginSettingFieldSchemaV2; items?: PluginSettingFieldSchemaV2;
  minItems?: number; maxItems?: number; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; pattern?: string;
  anyOf?: PluginSettingFieldSchemaV2[]; oneOf?: PluginSettingFieldSchemaV2[]; allOf?: PluginSettingFieldSchemaV2[];
};
export const PluginSettingFieldSchemaV2Schema: z.ZodType<PluginSettingFieldSchemaV2> = z.lazy(() => z.object({
  type: z.enum(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']).optional(),
  title: z.string().optional(), description: z.string().optional(),
  enum: z.array(PluginJsonValueV2Schema).optional(), const: PluginJsonValueV2Schema.optional(),
  properties: z.record(z.string(), PluginSettingFieldSchemaV2Schema).optional(), required: z.array(z.string()).optional(),
  additionalProperties: z.union([z.boolean(), PluginSettingFieldSchemaV2Schema]).optional(), items: PluginSettingFieldSchemaV2Schema.optional(),
  minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), pattern: z.string().optional(),
  anyOf: z.array(PluginSettingFieldSchemaV2Schema).optional(), oneOf: z.array(PluginSettingFieldSchemaV2Schema).optional(), allOf: z.array(PluginSettingFieldSchemaV2Schema).optional(),
}).strict());

export const PluginSettingFieldIdV2Schema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z][A-Za-z0-9_./-]*$/,
    'Setting field ids must start with a letter and contain only letters, digits, underscores, dots, slashes, or hyphens.',
  );
export type PluginSettingFieldIdV2 = z.infer<typeof PluginSettingFieldIdV2Schema>;

export const PluginSettingOptionV2Schema = z.object({
  value: PluginJsonValueV2Schema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
}).strict();

export const PluginSettingFieldBindingV2Schema = z.union([
  z.object({
    kind: z.literal('direct'),
    settingId: PluginSettingFieldIdV2Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('perActiveServer'),
    fallbackSettingId: PluginSettingFieldIdV2Schema,
    byServerIdSettingId: PluginSettingFieldIdV2Schema,
  }).strict(),
]);

export const PluginSettingFieldPresentationV2Schema = z.object({
  control: z.enum(['auto', 'text', 'textarea', 'switch', 'select', 'multiSelect', 'number', 'json']).optional(),
  placeholder: PluginLocalizedStringV2Schema.optional(),
  options: z.array(PluginSettingOptionV2Schema).optional(),
  step: z.number().positive().optional(),
  binding: PluginSettingFieldBindingV2Schema.optional(),
  hidden: z.boolean().optional(),
  order: z.number().int().optional(),
}).strict();

export const PluginSettingAnalyticsV2Schema = z.object({
  trackCurrentState: z.boolean().optional(),
  trackChanges: z.boolean().optional(),
  valueKind: z.enum(['boolean', 'enum', 'bucket', 'count', 'presence']),
  privacy: z.enum(['safe', 'bucketed', 'count_only', 'presence_only', 'forbidden']),
  identityScope: z.enum(['person', 'device_user']),
  serializeCurrentRule: z.enum(['orderedEnumArrayJoin', 'jsonObjectStringPresence']).optional(),
}).strict();

const PluginSettingFieldBaseV2Schema = z.object({
  id: PluginSettingFieldIdV2Schema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  schema: PluginSettingFieldSchemaV2Schema,
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  presentation: PluginSettingFieldPresentationV2Schema.optional(),
  analytics: PluginSettingAnalyticsV2Schema.optional(),
});
export const PluginSettingFieldV2Schema = z.union([
  PluginSettingFieldBaseV2Schema.extend({ secret: z.literal(true), default: z.never().optional() }).strict(),
  PluginSettingFieldBaseV2Schema.extend({ secret: z.literal(false).optional(), default: PluginJsonValueV2Schema.optional() }).strict(),
]);
export type PluginSettingFieldV2 = z.infer<typeof PluginSettingFieldV2Schema>;
export const PluginConfigurationSettingFieldV2Schema = z.union([
  PluginSettingFieldBaseV2Schema.extend({ secret: z.literal(true), default: z.never().optional(), required: z.boolean().optional() }).strict(),
  PluginSettingFieldBaseV2Schema.extend({ secret: z.literal(false).optional(), default: PluginJsonValueV2Schema.optional(), required: z.boolean().optional() }).strict(),
]);
export type PluginConfigurationSettingFieldV2 =
  z.infer<typeof PluginConfigurationSettingFieldV2Schema>;

export const PluginSettingsIconV2Schema = z.object({
  ionName: z.string().trim().min(1),
  color: z.object({
    kind: z.literal('theme'),
    token: z.string().trim().min(1),
  }).strict(),
}).strict();

export const PluginSettingsSectionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  fields: z.array(PluginSettingFieldIdV2Schema).min(1),
}).strict();

export const PluginSettingsSubagentItemV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  route: z.string().trim().min(1),
  iconIonName: z.string().trim().min(1).optional(),
}).strict();

export const PluginSettingsSubagentSectionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  items: z.array(PluginSettingsSubagentItemV2Schema),
}).strict();

export const PluginSettingsPresentationV2Schema = z.object({
  icon: PluginSettingsIconV2Schema.optional(),
  sections: z.array(PluginSettingsSectionV2Schema).default([]),
  subagentSections: z.array(PluginSettingsSubagentSectionV2Schema).default([]),
}).strict();

function containsJsonValue(values: readonly unknown[], candidate: unknown): boolean {
  return values.some((value) => {
    if (Object.is(value, candidate)) return true;
    if (value === null || candidate === null || typeof value !== typeof candidate) return false;
    if (Array.isArray(value) || Array.isArray(candidate)) {
      return Array.isArray(value)
        && Array.isArray(candidate)
        && value.length === candidate.length
        && value.every((entry, index) => containsJsonValue([entry], candidate[index]));
    }
    if (typeof value !== 'object' || typeof candidate !== 'object') return false;
    const left = value as Readonly<Record<string, unknown>>;
    const right = candidate as Readonly<Record<string, unknown>>;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && containsJsonValue([left[key]], right[key]));
  });
}

export const PluginSettingsContributionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  version: z.literal(1).default(1),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  target: z.union([
    z.object({ kind: z.literal('plugin') }).strict(),
    z.object({ kind: z.literal('agent'), agent: PluginContributionReferenceV2Schema }).strict(),
  ]),
  scope: z.enum(['local', 'synced', 'project', 'session']),
  fields: z.array(PluginSettingFieldV2Schema),
  presentation: PluginSettingsPresentationV2Schema.default({
    sections: [],
    subagentSections: [],
  }),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.fields.forEach((field, fieldIndex) => {
    if (seen.has(field.id)) ctx.addIssue({ code: 'custom', path: ['fields', fieldIndex, 'id'], message: `Duplicate settings field id '${field.id}'.` });
    seen.add(field.id);
    const options = field.presentation?.options;
    if (options) {
      const schemaOptions = field.schema.type === 'array'
        ? field.schema.items?.enum
        : field.schema.enum;
      options.forEach((option, optionIndex) => {
        if (!schemaOptions || !containsJsonValue(schemaOptions, option.value)) {
          ctx.addIssue({
            code: 'custom',
            path: ['fields', fieldIndex, 'presentation', 'options', optionIndex, 'value'],
            message: `Setting option is not accepted by field '${field.id}'.`,
          });
        }
      });
    }
    const binding = field.presentation?.binding;
    if (binding?.kind === 'direct' && binding.settingId && !seen.has(binding.settingId)) {
      // Direct forward references are checked after the complete field inventory below.
    }
  });
  value.presentation.sections.forEach((section, sectionIndex) => {
    const sectionFields = new Set<string>();
    section.fields.forEach((fieldId, fieldIndex) => {
      if (!seen.has(fieldId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['presentation', 'sections', sectionIndex, 'fields', fieldIndex],
          message: `Unknown settings field id '${fieldId}'.`,
        });
      } else if (sectionFields.has(fieldId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['presentation', 'sections', sectionIndex, 'fields', fieldIndex],
          message: `Duplicate settings field id '${fieldId}' in section '${section.id}'.`,
        });
      }
      sectionFields.add(fieldId);
    });
  });
  value.fields.forEach((field, fieldIndex) => {
    const binding = field.presentation?.binding;
    const referencedIds = binding?.kind === 'direct'
      ? (binding.settingId ? [binding.settingId] : [])
      : binding?.kind === 'perActiveServer'
        ? [binding.fallbackSettingId, binding.byServerIdSettingId]
        : [];
    referencedIds.forEach((fieldId) => {
      if (!seen.has(fieldId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'presentation', 'binding'],
          message: `Unknown bound settings field id '${fieldId}'.`,
        });
      }
    });
  });
});
export type PluginSettingsContributionV2 = z.infer<typeof PluginSettingsContributionV2Schema>;
export type PluginSettingsContribution = z.input<typeof PluginSettingsContributionV2Schema>;
