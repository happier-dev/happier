import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';

import type { HappierUiEnvironment, HappierUiLocalization } from './types.js';

type PluginTranslate = HappierUiLocalization['translate'];
const translationResolvers = new WeakMap<Readonly<Record<string, string>>, PluginTranslate>();

function resolveTranslationResolver(translations: Readonly<Record<string, string>>): PluginTranslate {
  const existing = translationResolvers.get(translations);
  if (existing) return existing;
  const resolver = (
    key: string,
    fallback?: string,
    values?: Readonly<Record<string, string | number>>,
  ): string => {
    const translation = Object.prototype.hasOwnProperty.call(translations, key) ? translations[key] : undefined;
    const resolved = typeof translation === 'string' ? translation : (fallback ?? '');
    if (values === undefined) return resolved;
    return resolved.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => (
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder
    ));
  };
  translationResolvers.set(translations, resolver);
  return resolver;
}

/** The one complete projection from public surface facts into presentation capabilities. */
export function projectHappierUiEnvironment(
  context: Pick<SurfaceContext,
    | 'theme' | 'locale' | 'direction' | 'translations' | 'textScale'
    | 'reducedMotion' | 'screenReaderEnabled' | 'contrast' | 'platform'
    | 'colorScheme' | 'safeAreaInsets'>,
): HappierUiEnvironment {
  return {
    theme: context.theme,
    localization: {
      locale: context.locale,
      direction: context.direction,
      translate: resolveTranslationResolver(context.translations),
    },
    accessibility: {
      textScale: context.textScale,
      reducedMotion: context.reducedMotion,
      screenReaderEnabled: context.screenReaderEnabled,
      contrast: context.contrast,
    },
    platform: { platform: context.platform, colorScheme: context.colorScheme },
    insets: { safeArea: context.safeAreaInsets },
  };
}
