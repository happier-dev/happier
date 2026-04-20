import { z } from 'zod';

import { LooseJsonObjectSchema, OptionalStringSchema, StringArraySchema } from './_shared.js';
import { BackendRuntimeAdapterV1Schema } from './backendRuntimeAdapterV1.js';

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

export const BackendDefinitionV1Schema = z.object({
  kindVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  runtimeKind: z.string().trim().min(1),
  // Optional built-in/provider compatibility identity for producer/UI lookup.
  // This remains additive metadata, not backend-target truth.
  providerAgentId: OptionalStringSchema,
  // Optional built-in icon carrier used for display fallback only.
  iconAgentId: OptionalStringSchema,
  launch: BackendLaunchV1Schema.optional(),
  install: BackendInstallV1Schema.optional(),
  capabilities: z.record(z.string(), z.boolean()).default({}),
  // Runtime-adapter ids remain an internal host dispatch seam in this wave.
  // Keep this field additive for compatibility readers, but do not treat it as
  // a stable external plugin ABI contract yet.
  runtimeAdapters: z.array(BackendRuntimeAdapterV1Schema).default([]),
  runtimeOptionsSchema: LooseJsonObjectSchema.optional(),
  probe: BackendProbeV1Schema.optional(),
  acp: LooseJsonObjectSchema.optional(),
}).passthrough();
export type BackendDefinitionV1 = z.infer<typeof BackendDefinitionV1Schema>;
