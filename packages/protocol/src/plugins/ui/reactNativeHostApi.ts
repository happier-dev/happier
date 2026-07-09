import { z } from 'zod';

import { PluginUiHostApiMethodV1Schema } from './hostApi.js';

export const PluginReactNativeHostApiV1Schema = z.object({
  version: z.string().trim().min(1),
  methods: z.array(PluginUiHostApiMethodV1Schema).default([]),
}).strict();
export type PluginReactNativeHostApiV1 =
  z.infer<typeof PluginReactNativeHostApiV1Schema>;

/** @deprecated Use PluginUiHostApiMethodV1 from hostApi.ts. */
export type PluginReactNativeHostApiMethodV1 = z.infer<typeof PluginUiHostApiMethodV1Schema>;
