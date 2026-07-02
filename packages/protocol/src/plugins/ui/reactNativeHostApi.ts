import { z } from 'zod';

const HostApiMethodSchema = z.enum([
  'getSurfaceContext',
  'requestSessionResource',
  'subscribeResource',
  'dispatchAction',
  'openSurface',
  'logDiagnostic',
  'copy',
  'openExternal',
]);

export const PluginReactNativeHostApiV1Schema = z.object({
  version: z.string().trim().min(1),
  methods: z.array(HostApiMethodSchema).default([]),
}).strict();
export type PluginReactNativeHostApiV1 =
  z.infer<typeof PluginReactNativeHostApiV1Schema>;

export type PluginReactNativeHostApiMethodV1 = z.infer<typeof HostApiMethodSchema>;
