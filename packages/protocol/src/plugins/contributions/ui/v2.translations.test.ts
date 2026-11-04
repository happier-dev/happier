import { describe, expect, it } from 'vitest';
import { PluginUiTranslationBundleV2Schema } from './v2.js';

describe('packaged translation admission', () => {
  it('accepts locale Resource references while preserving inline bundles and rejecting mixed forms', () => {
    expect(PluginUiTranslationBundleV2Schema.parse({ locale: 'fr', resourceId: 'copy-fr' })).toEqual({ locale: 'fr', resourceId: 'copy-fr' });
    expect(PluginUiTranslationBundleV2Schema.parse({ locale: 'en', messages: { title: 'Title' } })).toEqual({ locale: 'en', messages: { title: 'Title' } });
    for (const invalid of [{ locale: 'fr', resourceId: 'copy-fr', messages: {} }, { locale: 'not_a_locale', resourceId: 'copy-fr' }, { locale: 'fr', resourceId: '' }]) {
      expect(PluginUiTranslationBundleV2Schema.safeParse(invalid).success).toBe(false);
    }
  });
});
