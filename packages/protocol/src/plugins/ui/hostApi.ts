import { z } from 'zod';

export const PLUGIN_UI_HOST_API_VERSION_V1 = '1.0.0' as const;

export const PluginUiHostApiMethodV1Schema = z.enum([
  'getSurfaceContext',
  'requestSessionResource',
  'subscribeResource',
  'unsubscribeResource',
  'dispatchAction',
  'openSurface',
  'logDiagnostic',
  'copy',
  'openExternal',
]);
export type PluginUiHostApiMethodV1 = z.infer<typeof PluginUiHostApiMethodV1Schema>;

export const PluginUiHostApiRequirementV1Schema = z.object({
  minVersion: z.string().trim().min(1),
  methods: z.array(PluginUiHostApiMethodV1Schema).default([]),
}).strict();
export type PluginUiHostApiRequirementV1 =
  z.infer<typeof PluginUiHostApiRequirementV1Schema>;

export const PluginUiHostApiAvailabilityV1Schema = z.object({
  version: z.string().trim().min(1),
  methods: z.array(PluginUiHostApiMethodV1Schema).default([]),
  state: z.enum(['available', 'unavailable', 'denied']),
  diagnostics: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginUiHostApiAvailabilityV1 =
  z.infer<typeof PluginUiHostApiAvailabilityV1Schema>;
