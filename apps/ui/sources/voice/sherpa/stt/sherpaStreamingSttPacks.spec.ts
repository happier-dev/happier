import { afterEach, describe, expect, it } from 'vitest';

import { setPreferredLanguageFromSettings } from '@/text';
import { preloadTranslations } from '@/text/i18n';
import { getDefaultModelPackId, listModelPackCatalogEntries } from '@happier-dev/protocol/voice/modelPacks/catalog';

import { getSherpaStreamingSttPackOptions } from './sherpaStreamingSttPacks';

describe('sherpaStreamingSttPacks', () => {
  afterEach(() => {
    setPreferredLanguageFromSettings(null);
  });

  it('offers every published streaming STT pack with the canonical default first', () => {
    const options = getSherpaStreamingSttPackOptions({});
    const published = listModelPackCatalogEntries('stt_sherpa').filter(entry => entry.publicationStatus === 'published' && entry.streamingCapable);
    expect(options.map(option => option.id)).toEqual(published.map(entry => entry.packId));
    expect(options[0]?.id).toBe(getDefaultModelPackId('stt_sherpa'));
    expect(options.map(option => option.title)).toEqual(published.map(entry => entry.displayName));
  });

  it('projects the built-in description through the active locale while preserving environment-provided option copy', async () => {
    await preloadTranslations('es');
    setPreferredLanguageFromSettings('es');

    expect(getSherpaStreamingSttPackOptions({})[0]?.subtitle).toBe(
      'Transmisión en tiempo real, baja latencia (recomendado).',
    );

    const configuredSubtitle = 'Configured by the deployment';
    expect(getSherpaStreamingSttPackOptions({
      EXPO_PUBLIC_SHERPA_STREAMING_STT_PACKS: JSON.stringify([
        { id: 'configured-stt-pack', title: 'Configured pack', subtitle: configuredSubtitle },
      ]),
    })[0]?.subtitle).toBe(configuredSubtitle);
  });
});
