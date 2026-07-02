import { z } from 'zod';

export const PluginUiLocaleCodeV1Schema = z.string().trim().regex(/^[a-z]{2,3}(?:-[A-Z0-9]{2,8})?$/);
export type PluginUiLocaleCodeV1 = z.infer<typeof PluginUiLocaleCodeV1Schema>;

export const PluginUiTranslationKeyV1Schema = z.string().trim().min(1);
export type PluginUiTranslationKeyV1 = z.infer<typeof PluginUiTranslationKeyV1Schema>;

export const PluginUiTranslationBundleV1Schema = z.record(
  PluginUiTranslationKeyV1Schema,
  z.string().trim().min(1),
);
export type PluginUiTranslationBundleV1 = z.infer<typeof PluginUiTranslationBundleV1Schema>;

export const PluginUiTranslationsContributionV1Schema = z.object({
  locales: z.record(PluginUiLocaleCodeV1Schema, PluginUiTranslationBundleV1Schema).refine(
    (value) => Object.keys(value).length > 0,
    { message: 'at least one locale is required' },
  ),
  defaultLocale: PluginUiLocaleCodeV1Schema.optional(),
}).strict();
export type PluginUiTranslationsContributionV1 = z.infer<typeof PluginUiTranslationsContributionV1Schema>;
