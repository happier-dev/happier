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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePluginBackendCapabilitiesInput(value: unknown): unknown {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'executionRun') {
      normalized.executionRun = typeof entry === 'boolean' ? { supported: entry } : entry;
      continue;
    }
    if (typeof entry !== 'boolean') {
      normalized[key] = entry;
    }
  }
  return normalized;
}

export const PluginBackendExecutionRunCapabilitiesV1Schema = z.object({
  supported: z.boolean().default(true),
}).passthrough();
export type PluginBackendExecutionRunCapabilitiesV1 = z.infer<typeof PluginBackendExecutionRunCapabilitiesV1Schema>;

export const PluginBackendCapabilitiesV1Schema = z.preprocess(
  normalizePluginBackendCapabilitiesInput,
  z.object({
    executionRun: PluginBackendExecutionRunCapabilitiesV1Schema.default({ supported: true }),
  }).passthrough().default({ executionRun: { supported: true } }),
);
export type PluginBackendCapabilitiesV1 = z.infer<typeof PluginBackendCapabilitiesV1Schema>;

export const PluginBackendDefinitionV1Schema = z.object({
  kindVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  catalogAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
  launch: PluginBackendLaunchV1Schema.optional(),
  install: PluginBackendInstallV1Schema.optional(),
  capabilities: PluginBackendCapabilitiesV1Schema,
  runtimeOptionsSchema: PluginLooseJsonObjectSchema.optional(),
  probe: PluginBackendProbeV1Schema.optional(),
}).passthrough();
export type PluginBackendDefinitionV1 = z.infer<typeof PluginBackendDefinitionV1Schema>;
