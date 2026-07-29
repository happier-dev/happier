import { z } from 'zod';

export const PluginRuntimeCapabilityFamilyV1Schema = z.enum([
  'agents',
  'actions',
  'tools',
  'commands',
  'hooks',
  'resources',
  'settings',
  'executionRunProfiles',
  'mcp',
  'notifications',
  'sessionHooks',
  'scmHostingProviders',
  'scmBackends',
  'connectedAccountDescriptors',
  'managedDependencies',
  'terminalHost',
  'lifecycle',
  'reload',
]);
export type PluginRuntimeCapabilityFamilyV1 = z.infer<typeof PluginRuntimeCapabilityFamilyV1Schema>;
