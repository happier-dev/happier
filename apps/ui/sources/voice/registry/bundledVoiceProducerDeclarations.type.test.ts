import { describe, expect, it } from 'vitest';

import {
  BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
  BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS,
} from './generatedBundledVoiceEntries';
import { createBundledVoiceProviderPresentations } from './bundledVoiceManifestProjection';
import { VOICE_PROVIDER_PRESENTATIONS as GOOGLE_PRESENTATIONS } from '@happier-dev/plugins-google/ui/voice';
import { VOICE_PROVIDER_PRESENTATIONS as OPENAI_COMPAT_PRESENTATIONS } from '@happier-dev/plugins-openai-compat/ui/voice';

describe('bundled voice producer projection', () => {
  it('preserves source speech settings when the publisher transports only JSON presentation facts', () => {
    const source = [...GOOGLE_PRESENTATIONS, ...OPENAI_COMPAT_PRESENTATIONS];
    const projected = createBundledVoiceProviderPresentations(JSON.parse(JSON.stringify(source)));
    expect(projected.map((presentation) => presentation.createSettingsSpec?.()))
      .toEqual(source.map((presentation) => presentation.createSettingsSpec()));
  });
  it('rehydrates generated speech presentation data without changing settings or selection identity', () => {
    const settingsSpec = {
      titleKey: 'settings.title', subtitleKey: 'settings.subtitle', detailKey: 'settings.detail',
      iconName: 'cloud', fields: [{ fieldId: 'model', titleKey: 'model.title', subtitleKey: 'model.subtitle' }],
      test: null,
    };
    const [speech, conversation] = createBundledVoiceProviderPresentations([
      { providerId: 'happier.voice.fixture/stt', settingsSectionId: 'fixture.stt', settingsSpec },
      {
        providerId: 'happier.voice.fixture/realtime', settingsSectionId: 'fixture.realtime',
        selectionOptions: [{
          id: 'fixture', modeId: 'fixture', order: 20,
          titleKey: 'fixture.title', subtitleKey: 'fixture.subtitle', configPatch: { billingMode: 'byo' },
        }],
      },
    ]);
    expect(speech?.createSettingsSpec?.()).toBe(settingsSpec);
    expect(speech?.createSettingsSpec?.()).toEqual(settingsSpec);
    expect(conversation?.selectionOptions?.[0]).toMatchObject({ configPatch: { billingMode: 'byo' } });
    expect(conversation).not.toHaveProperty('createSettingsSpec');
  });
  it('keeps manifest semantics separate from qualified presentation', () => {
    expect(BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS).toHaveLength(
      BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS.length,
    );
    for (const contribution of BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS) {
      const presentation = BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS.find(
        (candidate) => candidate.providerId === contribution.providerId,
      );
      expect(presentation).toBeDefined();
      expect(presentation).not.toHaveProperty('declaration');
      expect(presentation).not.toHaveProperty('mark');
      expect(presentation).not.toHaveProperty('roles');
      expect(presentation).not.toHaveProperty('requirements');
      expect(presentation).not.toHaveProperty('providerSettings');
      expect(presentation).not.toHaveProperty('projectSettings');
    }
  });
});
