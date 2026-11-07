/** Packaged locale declarations; copy lives only in assets/i18n/<locale>.json. */
type ChannelsUiLocale = "en" | "de" | "ru" | "pl" | "es" | "fr" | "it" | "pt" | "ca" | "zh-Hans" | "zh-Hant" | "ja";

export const CHANNELS_UI_TRANSLATION_BUNDLES: ReadonlyArray<Readonly<{
  locale: ChannelsUiLocale;
  resourceId: string;
}>> = Object.freeze([
  { locale: "en", resourceId: "i18n-en" },
  { locale: "de", resourceId: "i18n-de" },
  { locale: "ru", resourceId: "i18n-ru" },
  { locale: "pl", resourceId: "i18n-pl" },
  { locale: "es", resourceId: "i18n-es" },
  { locale: "fr", resourceId: "i18n-fr" },
  { locale: "it", resourceId: "i18n-it" },
  { locale: "pt", resourceId: "i18n-pt" },
  { locale: "ca", resourceId: "i18n-ca" },
  { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
  { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
  { locale: "ja", resourceId: "i18n-ja" },
]);

export const CHANNELS_UI_TRANSLATION_RESOURCES: Readonly<Record<string, Readonly<{
  kind: 'asset';
  path: string;
  contentType: 'application/json';
}>>> = Object.freeze(Object.fromEntries(CHANNELS_UI_TRANSLATION_BUNDLES.map(({ locale, resourceId }) => [
  resourceId,
  { kind: 'asset', path: `assets/i18n/${locale}.json`, contentType: 'application/json' } as const,
])));
