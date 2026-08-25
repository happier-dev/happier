import { afterEach, describe, expect, it } from 'vitest';

import { setPreferredLanguageFromSettings } from '@/text';

import { getSherpaStreamingSttPackOptions } from './sherpaStreamingSttPacks';

describe('sherpaStreamingSttPacks', () => {
  afterEach(() => {
    setPreferredLanguageFromSettings(null);
  });

  it('projects the built-in description through the active locale while preserving environment-provided option copy', () => {
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
