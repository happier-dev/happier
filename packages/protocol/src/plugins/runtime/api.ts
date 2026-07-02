import { z } from 'zod';

export const PluginRuntimeCapabilityFamilyV1Schema = z.enum([
  'agents',
  'backends',
  'actions',
  'tools',
  'commands',
  'hooks',
  'resources',
  'uiDescriptors',
  'settings',
  'executionRunProfiles',
  'mcp',
  'notifications',
  'sessionHooks',
  'scmHostingProviders',
  'scmBackends',
  'connectedAccountDescriptors',
  'terminalHost',
  'lifecycle',
  'reload',
]);
export type PluginRuntimeCapabilityFamilyV1 = z.infer<typeof PluginRuntimeCapabilityFamilyV1Schema>;

export const PluginRuntimeApiV1Schema = z.object({
  apiVersion: z.literal(1),
  capabilities: z.array(PluginRuntimeCapabilityFamilyV1Schema).default([]),
}).strict();
export type PluginRuntimeApiV1 = z.infer<typeof PluginRuntimeApiV1Schema>;
