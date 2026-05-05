import { z } from 'zod';

import {
  PluginLooseJsonObjectSchema,
  PluginOptionalStringSchema,
  PluginStringArraySchema,
} from './_shared.js';

export const PluginBackendLaunchV1Schema = z.object({
  binaryName: PluginOptionalStringSchema,
  command: PluginOptionalStringSchema,
  args: PluginStringArraySchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  resolutionPolicy: PluginOptionalStringSchema,
}).passthrough();
export type PluginBackendLaunchV1 = z.infer<typeof PluginBackendLaunchV1Schema>;

export const PluginBackendInstallV1Schema = z.object({
  managedInstall: PluginLooseJsonObjectSchema.optional(),
  manualInstall: PluginLooseJsonObjectSchema.optional(),
  sourcePreference: PluginOptionalStringSchema,
}).passthrough();
export type PluginBackendInstallV1 = z.infer<typeof PluginBackendInstallV1Schema>;

export const PluginBackendProbeV1Schema = z.object({
  models: PluginLooseJsonObjectSchema.optional(),
  modes: PluginLooseJsonObjectSchema.optional(),
  configOptions: PluginLooseJsonObjectSchema.optional(),
  authStatus: PluginLooseJsonObjectSchema.optional(),
}).passthrough();
export type PluginBackendProbeV1 = z.infer<typeof PluginBackendProbeV1Schema>;

export const PluginBackendDefinitionV1Schema = z.object({
  kindVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
  launch: PluginBackendLaunchV1Schema.optional(),
  install: PluginBackendInstallV1Schema.optional(),
  capabilities: z.record(z.string(), z.boolean()).default({}),
  runtimeOptionsSchema: PluginLooseJsonObjectSchema.optional(),
  probe: PluginBackendProbeV1Schema.optional(),
}).passthrough();
export type PluginBackendDefinitionV1 = z.infer<typeof PluginBackendDefinitionV1Schema>;
