import { z } from 'zod';

import { LooseJsonObjectSchema, OptionalStringSchema, StringArraySchema } from './_shared.js';
import { BackendRuntimeAdapterV1Schema } from './backendRuntimeAdapterV1.js';

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
  launch: BackendLaunchV1Schema.optional(),
  install: BackendInstallV1Schema.optional(),
  capabilities: z.record(z.string(), z.boolean()).default({}),
  runtimeAdapters: z.array(BackendRuntimeAdapterV1Schema).default([]),
  runtimeOptionsSchema: LooseJsonObjectSchema.optional(),
  probe: BackendProbeV1Schema.optional(),
  acp: LooseJsonObjectSchema.optional(),
}).passthrough();
export type BackendDefinitionV1 = z.infer<typeof BackendDefinitionV1Schema>;
