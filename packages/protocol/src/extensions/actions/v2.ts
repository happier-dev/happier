import { z } from 'zod';

import { LooseJsonObjectSchema, OptionalStringSchema } from '../_shared.js';
import { ExtensionPermissionCapabilityV1Schema } from '../permissions/v1.js';

export const ExtensionActionScopeV2Schema = z.enum([
  'global',
  'settings',
  'provider',
  'backend',
  'session',
  'message',
  'transcript',
  'executionRun',
  'toolResult',
  'workspace',
  'machine',
]);
export type ExtensionActionScopeV2 = z.infer<typeof ExtensionActionScopeV2Schema>;

export const ExtensionActionSurfaceV2Schema = z.enum([
  'settings',
  'providerSettings',
  'backendSettings',
  'sessionMenu',
  'executionRunMenu',
  'commandPalette',
  'agentTool',
  'cli',
]);
export type ExtensionActionSurfaceV2 = z.infer<typeof ExtensionActionSurfaceV2Schema>;

export const ExtensionActionPlacementV2Schema = z.enum([
  'primary',
  'secondary',
  'rowAction',
  'contextMenu',
  'commandPalette',
  'toolbar',
  'detailsPanel',
]);
export type ExtensionActionPlacementV2 = z.infer<typeof ExtensionActionPlacementV2Schema>;

export const ExtensionActionDangerLevelV2Schema = z.enum([
  'safe',
  'writesLocal',
  'writesRemote',
  'externalSideEffect',
  'destructive',
]);
export type ExtensionActionDangerLevelV2 = z.infer<typeof ExtensionActionDangerLevelV2Schema>;

export const ExtensionDaemonHandlerRefV1Schema = z.object({
  target: z.literal('daemon'),
  exportName: OptionalStringSchema,
  registrationId: OptionalStringSchema,
}).strict().superRefine((value, ctx) => {
  if (value.exportName || value.registrationId) return;

  ctx.addIssue({
    code: 'custom',
    path: ['exportName'],
    message: 'Daemon handler references must declare exportName or registrationId.',
  });
});
export type ExtensionDaemonHandlerRefV1 = z.infer<typeof ExtensionDaemonHandlerRefV1Schema>;

export const ExtensionActionAvailabilityV2Schema = z.object({
  features: z.array(z.string().trim().min(1)).default([]),
  agentIds: z.array(z.string().trim().min(1)).default([]),
  backendIds: z.array(z.string().trim().min(1)).default([]),
  sessionStates: z.array(z.string().trim().min(1)).default([]),
  machineCapabilities: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type ExtensionActionAvailabilityV2 = z.infer<typeof ExtensionActionAvailabilityV2Schema>;

export const ExtensionActionConfirmationV2Schema = z.object({
  title: z.string().trim().min(1),
  body: OptionalStringSchema,
  confirmLabel: OptionalStringSchema,
}).strict();
export type ExtensionActionConfirmationV2 = z.infer<typeof ExtensionActionConfirmationV2Schema>;

export const ExtensionActionContributionV2Schema = z.object({
  kind: z.literal('action'),
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: OptionalStringSchema,
  icon: z.string().trim().regex(/^[a-z][a-z0-9.-]*$/i).optional(),
  scopes: z.array(ExtensionActionScopeV2Schema).min(1),
  surfaces: z.array(ExtensionActionSurfaceV2Schema).min(1),
  placement: ExtensionActionPlacementV2Schema,
  inputSchema: LooseJsonObjectSchema.optional(),
  resultSchema: LooseJsonObjectSchema.optional(),
  availability: ExtensionActionAvailabilityV2Schema.optional(),
  permissions: z.array(ExtensionPermissionCapabilityV1Schema).default([]),
  handler: ExtensionDaemonHandlerRefV1Schema,
  priority: z.number().int().optional(),
  dangerLevel: ExtensionActionDangerLevelV2Schema,
  confirmation: ExtensionActionConfirmationV2Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.dangerLevel === 'safe' || value.confirmation) return;

  ctx.addIssue({
    code: 'custom',
    path: ['confirmation'],
    message: 'Non-safe extension actions must declare host confirmation metadata.',
  });
});
export type ExtensionActionContributionV2 = z.infer<typeof ExtensionActionContributionV2Schema>;
