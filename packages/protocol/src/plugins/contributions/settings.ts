import { z } from 'zod';

import {
  PluginDescriptorBaseV1Schema,
  PluginDescriptorClearWhenEmptyV1Schema,
} from './_descriptors.js';

export const PluginSettingsControlKindV1Schema = z.enum(['text', 'password', 'textarea', 'switch']);
export type PluginSettingsControlKindV1 = z.infer<typeof PluginSettingsControlKindV1Schema>;

export const PluginSettingsValueSchemaV1Schema = z.object({
  type: z.enum(['string', 'boolean', 'number', 'integer', 'object', 'array', 'null']),
  enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).passthrough();
export type PluginSettingsValueSchemaV1 = z.infer<typeof PluginSettingsValueSchemaV1Schema>;

export const PluginSettingsFieldDescriptorV1Schema = PluginDescriptorBaseV1Schema.safeExtend({
  kind: z.literal('settings.field'),
  valueSchema: PluginSettingsValueSchemaV1Schema,
  control: PluginSettingsControlKindV1Schema,
  displayKey: z.string().trim().min(1),
  clearWhenEmpty: PluginDescriptorClearWhenEmptyV1Schema.default('persist'),
  defaultBooleanValue: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.control === 'switch' && value.valueSchema.type !== 'boolean') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['valueSchema', 'type'],
      message: 'Switch settings fields require a boolean value schema.',
    });
  }
  if (value.defaultBooleanValue !== undefined && value.control !== 'switch') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultBooleanValue'],
      message: 'defaultBooleanValue is only valid for switch settings fields.',
    });
  }
});
export type PluginSettingsFieldDescriptorV1 = z.infer<typeof PluginSettingsFieldDescriptorV1Schema>;

export const PluginSettingsContributionV2Schema = z.object({
  id: z.string().trim().min(1),
  fields: z.array(PluginSettingsFieldDescriptorV1Schema).default([]),
}).passthrough().superRefine((value, ctx) => {
  const seenFieldIds = new Set<string>();
  value.fields.forEach((field, index) => {
    if (seenFieldIds.has(field.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', index, 'id'],
        message: `Duplicate settings field id '${field.id}'.`,
      });
      return;
    }
    seenFieldIds.add(field.id);
  });
});
export type PluginSettingsContributionV2 = z.infer<typeof PluginSettingsContributionV2Schema>;
