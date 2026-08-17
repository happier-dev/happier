import { z } from 'zod';

export const PLUGIN_UI_ICON_TOKENS_V1 = [
  'action',
  'browser',
  'copy',
  'file',
  'globe',
  'info',
  'preview',
  'refresh',
  'settings',
  'terminal',
  'warning',
  'add',
  'back',
  'check',
  'close',
  'error',
  'external',
  'forward',
  'more',
  'search',
] as const;

export const PluginUiIconTokenV1Schema = z.enum(PLUGIN_UI_ICON_TOKENS_V1);
export type PluginUiIconTokenV1 = z.infer<typeof PluginUiIconTokenV1Schema>;

export const PluginUiToneV1Schema = z.enum([
  'neutral',
  'info',
  'success',
  'warning',
  'danger',
  'accent',
]);
export type PluginUiToneV1 = z.infer<typeof PluginUiToneV1Schema>;

export const PluginUiDisplayV1Schema = z.object({
  titleKey: z.string().trim().min(1),
  descriptionKey: z.string().trim().min(1).optional(),
  labelKey: z.string().trim().min(1).optional(),
  iconToken: PluginUiIconTokenV1Schema.optional(),
  tone: PluginUiToneV1Schema.optional(),
  developerFallback: z.string().trim().min(1).optional(),
}).strict();
export type PluginUiDisplayV1 = z.infer<typeof PluginUiDisplayV1Schema>;
