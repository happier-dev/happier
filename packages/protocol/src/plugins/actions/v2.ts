import { z } from 'zod';

import { ActionInputHintsSchema, ActionSafetySchema } from '../../actions/actionSpecs.js';
import { PluginLooseJsonObjectSchema, PluginOptionalStringSchema } from '../_shared.js';
import { PluginPermissionCapabilityV1Schema } from '../permissions/v1.js';

export const PluginActionDefinitionExamplesV1Schema = z
  .object({
    voice: z
      .object({
        argsExample: z.string().min(1).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    mcp: z
      .object({
        argsExample: z.string().min(1).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    sdk: z
      .object({
        codeExample: z.string().min(1).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
  .nullable();
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
]);
export type PluginActionSurfaceV2 = z.infer<typeof PluginActionSurfaceV2Schema>;

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

const PLUGIN_ACTION_PERMISSIONS_FIELD = 'permissions' as const;

export const PluginExecutableHandlerRefV1Schema = z.object({
  target: z.enum(['daemon', 'plugin']),
  exportName: PluginOptionalStringSchema,
  registrationId: PluginOptionalStringSchema,
}).strict().superRefine((value, ctx) => {
  if (value.exportName || value.registrationId) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['exportName'],
    message: 'Plugin handler references must declare exportName or registrationId.',
  });
});
export type PluginExecutableHandlerRefV1 = z.infer<typeof PluginExecutableHandlerRefV1Schema>;

export const PluginActionAvailabilityV2Schema = z.object({
  features: z.array(z.string().trim().min(1)).default([]),
  agentIds: z.array(z.string().trim().min(1)).default([]),
  sessionStates: z.array(z.string().trim().min(1)).default([]),
  machineCapabilities: z.array(z.string().trim().min(1)).default([]),
}).passthrough();
export type PluginActionAvailabilityV2 = z.infer<typeof PluginActionAvailabilityV2Schema>;

export const PluginActionConfirmationV2Schema = z.object({
  title: z.string().trim().min(1),
  body: PluginOptionalStringSchema,
  confirmLabel: PluginOptionalStringSchema,
}).strict();
export type PluginActionConfirmationV2 = z.infer<typeof PluginActionConfirmationV2Schema>;

export const PluginActionContributionV2Schema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  icon: z.string().trim().regex(/^[a-z][a-z0-9.-]*$/i).optional(),
  scopes: z.array(PluginActionScopeV2Schema).min(1),
  surfaces: z.array(PluginActionSurfaceV2Schema).min(1),
  placement: PluginActionPlacementV2Schema,
  inputSchema: PluginLooseJsonObjectSchema.optional(),
  resultSchema: PluginLooseJsonObjectSchema.optional(),
  availability: PluginActionAvailabilityV2Schema.optional(),
  [PLUGIN_ACTION_PERMISSIONS_FIELD]: z.array(PluginPermissionCapabilityV1Schema).default([]),
  handler: PluginExecutableHandlerRefV1Schema,
  priority: z.number().int().optional(),
  dangerLevel: PluginActionDangerLevelV2Schema,
  confirmation: PluginActionConfirmationV2Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.dangerLevel === 'safe' || value.confirmation) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['confirmation'],
    message: 'Non-safe plugin actions must declare host confirmation metadata.',
  });
});
export type PluginActionContributionV2 = z.infer<typeof PluginActionContributionV2Schema>;

export const PluginToolContributionV2Schema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  safety: ActionSafetySchema.default('safe'),
  surfaces: z.array(PluginActionSurfaceV2Schema).default([]),
  inputSchema: PluginLooseJsonObjectSchema.optional(),
  outputSchema: PluginLooseJsonObjectSchema.optional(),
  inputHints: ActionInputHintsSchema.nullable().optional(),
  compatibility: PluginLooseJsonObjectSchema.optional(),
  examples: PluginActionDefinitionExamplesV1Schema.nullable().optional(),
  promptSnippet: PluginOptionalStringSchema,
  promptGuidelines: z.array(z.string().trim().min(1)).optional(),
  handler: PluginExecutableHandlerRefV1Schema,
}).passthrough();
export type PluginToolContributionV2 = z.infer<typeof PluginToolContributionV2Schema>;
