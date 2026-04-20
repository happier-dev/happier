import { z } from 'zod';

export const ExtensionRuntimeCapabilityFamilyV1Schema = z.enum([
  'providers',
  'backends',
  'actions',
  'tools',
  'commands',
  'hooks',
  'resources',
  'uiDescriptors',
  'lifecycle',
  'reload',
]);
export type ExtensionRuntimeCapabilityFamilyV1 = z.infer<typeof ExtensionRuntimeCapabilityFamilyV1Schema>;

export const ExtensionRuntimeApiV1Schema = z.object({
  apiVersion: z.literal(1),
  capabilities: z.array(ExtensionRuntimeCapabilityFamilyV1Schema).default([]),
}).strict();
export type ExtensionRuntimeApiV1 = z.infer<typeof ExtensionRuntimeApiV1Schema>;
