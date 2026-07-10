import { z } from 'zod';

import { LooseJsonObjectSchema, OptionalStringSchema, StringArraySchema } from './_shared.js';
import { BackendSurfaceDeclarationV1Schema } from '../plugins/backendSurfaceDeclarationV1.js';

/**
 * Plugin-extension wire contract.
 *
 * This intentionally remains `BackendDefinitionV1` for compatibility with
 * existing plugin manifests. Internal host catalog normalization should use
 * `BackendCatalogDefinition` in `@happier-dev/agents`.
 *
 * The host-side executable/backend model is intentionally narrower and lives in
 * the agents package. This schema is only the contribution wire surface.
 */

export const BackendLaunchV1Schema = z.object({
  binaryName: OptionalStringSchema,
  command: OptionalStringSchema,
  args: StringArraySchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  resolutionPolicy: OptionalStringSchema,
}).passthrough();
export type BackendLaunchV1 = z.infer<typeof BackendLaunchV1Schema>;

export const BackendInstallV1Schema = z.object({
  managedInstall: LooseJsonObjectSchema.optional(),
  manualInstall: LooseJsonObjectSchema.optional(),
  sourcePreference: OptionalStringSchema,
}).passthrough();
export type BackendInstallV1 = z.infer<typeof BackendInstallV1Schema>;

export const BackendProbeV1Schema = z.object({
  models: LooseJsonObjectSchema.optional(),
  modes: LooseJsonObjectSchema.optional(),
  configOptions: LooseJsonObjectSchema.optional(),
  authStatus: LooseJsonObjectSchema.optional(),
}).passthrough();
export type BackendProbeV1 = z.infer<typeof BackendProbeV1Schema>;

export const BackendDefinitionV1BaseSchema = z.object({
  kindVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  runtimeKind: z.string().trim().min(1),
  // Optional built-in/provider compatibility identity for producer/UI lookup.
  // This remains additive metadata, not backend-target truth.
  catalogAgentId: OptionalStringSchema,
  // Optional built-in icon carrier used for display fallback only.
  iconAgentId: OptionalStringSchema,
  launch: BackendLaunchV1Schema.optional(),
  install: BackendInstallV1Schema.optional(),
  capabilities: z.record(z.string(), z.boolean()).default({}),
  surfaceHandlers: z.array(BackendSurfaceDeclarationV1Schema).default([]),
  runtimeOptionsSchema: LooseJsonObjectSchema.optional(),
  probe: BackendProbeV1Schema.optional(),
  acp: LooseJsonObjectSchema.optional(),
}).passthrough();

export const BackendDefinitionV1Schema = BackendDefinitionV1BaseSchema.superRefine((value, ctx) => {
  if (Object.prototype.hasOwnProperty.call(value, 'runtimeAdapters')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtimeAdapters'],
      message: 'Backend surface declarations must use surfaceHandlers; runtimeAdapters is not final SDK vocabulary.',
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, 'runtimeCoreHooks')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtimeCoreHooks'],
      message: 'Backend surface declarations must use surfaceHandlers; runtimeCoreHooks is not final SDK vocabulary.',
    });
  }
});
export type BackendDefinitionV1 = z.infer<typeof BackendDefinitionV1Schema>;
