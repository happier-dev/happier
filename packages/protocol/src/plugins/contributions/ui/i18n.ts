import { z } from 'zod';

// BCP-47 subset: a 2–3 letter primary language subtag, then an OPTIONAL script
// subtag (titlecase, `[A-Z][a-z]{3}`, e.g. `Hans`/`Hant`) and an OPTIONAL region
// subtag (`[A-Z]{2}` or `[0-9]{3}`, e.g. `US`/`419`). The script subtag is
// required so the host app's shipped `zh-Hans` / `zh-Hant` locales — which the
// UI resolves plugin translation bundles against — are expressible by a plugin.
export const PluginUiLocaleCodeV1Schema = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/);
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
export type PluginUiTranslationsContribution = z.infer<typeof PluginUiTranslationsContributionV1Schema>;
export type PluginUiTranslationsContributionInput = z.input<typeof PluginUiTranslationsContributionV1Schema>;
