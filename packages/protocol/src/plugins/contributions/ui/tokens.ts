import { z } from 'zod';

export const PluginUiIconTokenV1Schema = z.enum([
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
]);
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

export const PluginUiThemeRoleV1Schema = z.enum([
  'surface',
  'surfaceMuted',
  'text',
  'textMuted',
  'border',
  'accent',
]);
export type PluginUiThemeRoleV1 = z.infer<typeof PluginUiThemeRoleV1Schema>;

export const PluginUiBadgeVariantV1Schema = z.enum([
  'dot',
  'count',
  'status',
]);
export type PluginUiBadgeVariantV1 = z.infer<typeof PluginUiBadgeVariantV1Schema>;

export const PluginUiSizeTokenV1Schema = z.enum([
  'compact',
  'regular',
  'expanded',
]);
export type PluginUiSizeTokenV1 = z.infer<typeof PluginUiSizeTokenV1Schema>;

export const PluginUiDisplayV1Schema = z.object({
  titleKey: z.string().trim().min(1),
  descriptionKey: z.string().trim().min(1).optional(),
  labelKey: z.string().trim().min(1).optional(),
  iconToken: PluginUiIconTokenV1Schema.optional(),
  tone: PluginUiToneV1Schema.optional(),
  themeRole: PluginUiThemeRoleV1Schema.optional(),
  developerFallback: z.string().trim().min(1).optional(),
}).strict();
export type PluginUiDisplayV1 = z.infer<typeof PluginUiDisplayV1Schema>;

export const PluginUiBadgeDescriptorV1Schema = z.object({
  variant: PluginUiBadgeVariantV1Schema,
  labelKey: z.string().trim().min(1).optional(),
  countPath: z.string().trim().min(1).optional(),
  tone: PluginUiToneV1Schema.optional(),
}).strict();
export type PluginUiBadgeDescriptorV1 = z.infer<typeof PluginUiBadgeDescriptorV1Schema>;
