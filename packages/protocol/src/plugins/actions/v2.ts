import { z } from 'zod';

import { ActionSafetySchema } from '../../actions/actionSpecs.js';
import { PluginOptionalStringSchema } from '../_shared.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../contributions/publicTypes.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
export { PluginJsonSchemaV2Schema, type PluginJsonSchemaV2 as PluginJsonSchema } from '../contributions/publicTypes.js';
export type { PluginJsonValueV2 as PluginJsonValue } from '../contributions/publicTypes.js';

export const PluginActionDefinitionExamplesV1Schema = z
  .object({
    voice: z
      .object({
        argsExample: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    mcp: z
      .object({
        argsExample: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    sdk: z
      .object({
        codeExample: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PluginActionDefinitionExamplesV1 = z.infer<typeof PluginActionDefinitionExamplesV1Schema>;

export const PluginActionScopeV2Schema = z.enum([
  'global',
  'settings',
  'agent',
  'session',
  'message',
  'transcript',
  'executionRun',
  'toolResult',
  'workspace',
  'machine',
]);
export type PluginActionScopeV2 = z.infer<typeof PluginActionScopeV2Schema>;

export const PluginActionSurfaceV2Schema = z.enum([
  'cli',
  'mcp',
  'agent',
  'ui',
]);
export type PluginActionSurfaceV2 = z.infer<typeof PluginActionSurfaceV2Schema>;

const PluginToolSurfaceV2Schema = PluginActionSurfaceV2Schema.exclude(['ui']);

export const PluginActionPlacementV2Schema = z.enum([
  'primary',
  'secondary',
  'rowAction',
  'contextMenu',
  'commandPalette',
  'toolbar',
  'detailsPanel',
]);
export type PluginActionPlacementV2 = z.infer<typeof PluginActionPlacementV2Schema>;

export const PluginActionDangerLevelV2Schema = z.enum([
  'safe',
  'writesLocal',
  'writesRemote',
  'externalSideEffect',
  'destructive',
]);
export type PluginActionDangerLevelV2 = z.infer<typeof PluginActionDangerLevelV2Schema>;

export const PluginActionAvailabilityV2Schema = PluginAvailabilityDescriptorV2Schema;
export type PluginActionAvailabilityV2 = z.infer<typeof PluginActionAvailabilityV2Schema>;

export const PluginActionConfirmationV2Schema = z.object({
  title: PluginLocalizedStringV2Schema,
  body: PluginLocalizedStringV2Schema.optional(),
  confirmLabel: PluginLocalizedStringV2Schema.optional(),
}).strict();
export type PluginActionConfirmationV2 = z.infer<typeof PluginActionConfirmationV2Schema>;

export const PluginActionContributionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  icon: z.string().trim().regex(/^[a-z][a-z0-9.-]*$/i).optional(),
  scopes: z.array(PluginActionScopeV2Schema).min(1),
  surfaces: z.array(PluginActionSurfaceV2Schema).min(1),
  placement: PluginActionPlacementV2Schema,
  inputSchema: PluginJsonSchemaV2Schema.optional(),
  resultSchema: PluginJsonSchemaV2Schema.optional(),
  availability: PluginActionAvailabilityV2Schema.optional(),
  hostAccess: z.array(z.string().regex(/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/)).min(1).superRefine((values, ctx) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) ctx.addIssue({ code: 'custom', path: [index], message: 'Duplicate hostAccess request id.' });
      seen.add(value);
    });
  }).optional(),
  priority: z.number().int().optional(),
  dangerLevel: PluginActionDangerLevelV2Schema,
  confirmation: PluginActionConfirmationV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.dangerLevel === 'safe' && value.confirmation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmation'], message: 'Safe actions cannot request confirmation.' });
    return;
  }
  if (value.dangerLevel === 'safe' || value.confirmation) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['confirmation'],
    message: 'Non-safe plugin actions must declare host confirmation metadata.',
  });
});
export type PluginActionContributionV2 = z.infer<typeof PluginActionContributionV2Schema>;

const PluginActionInputHintOptionV2Schema = z.object({
  value: z.string(),
  label: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  disabled: z.boolean().optional(),
}).strict();

export const PluginActionInputHintsV2Schema = z.object({
  title: PluginLocalizedStringV2Schema.optional(),
  description: PluginLocalizedStringV2Schema.optional(),
  fields: z.array(z.object({
    path: z.string().trim().min(1),
    title: PluginLocalizedStringV2Schema,
    description: PluginLocalizedStringV2Schema.optional(),
    widget: z.enum(['text', 'textarea', 'text_list', 'select', 'multiselect', 'toggle', 'checkbox', 'json']),
    listSeparator: z.enum(['comma', 'newline']).optional(),
    required: z.boolean().optional(),
    requireExplicitSelection: z.boolean().optional(),
    maxSelections: z.number().int().positive().optional(),
    options: z.array(PluginActionInputHintOptionV2Schema).optional(),
    optionsSourceId: z.string().trim().min(1).optional(),
  }).strict()),
}).strict();

const PluginToolJsonObjectSchemaV2Schema = PluginJsonSchemaV2Schema.refine(
  (schema) => schema.type === 'object',
  'Tool schemas must declare type "object" at the root',
);

export const PluginToolContributionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  name: z.string().trim().min(1),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  safety: ActionSafetySchema.default('safe'),
  surfaces: z.array(PluginToolSurfaceV2Schema).default([]),
  inputSchema: PluginToolJsonObjectSchemaV2Schema.optional(),
  outputSchema: PluginToolJsonObjectSchemaV2Schema.optional(),
  inputHints: PluginActionInputHintsV2Schema.optional(),
  compatibility: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  examples: PluginActionDefinitionExamplesV1Schema.optional(),
  promptSnippet: PluginOptionalStringSchema,
  promptGuidelines: z.array(z.string().trim().min(1)).optional(),
  action: z.union([
    z.string().trim().min(1),
    z.object({ pluginId: z.string().trim().min(1), localId: z.string().trim().min(1) }).strict(),
  ]),
  availability: PluginActionAvailabilityV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginToolContributionV2 = z.infer<typeof PluginToolContributionV2Schema>;
