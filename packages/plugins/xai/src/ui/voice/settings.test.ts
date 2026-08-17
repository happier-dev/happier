import { describe, expect, it } from 'vitest';

import { createXaiRealtimeSettingsSection } from './settings.js';
import { XAI_SUPPORTED_LANGUAGE_HINTS } from '../../protocol/voice/settings.js';

describe('xAI Realtime settings section', () => {
  it('projects explicit pinned and moving-alias model choices for the generic renderer', () => {
    const section = createXaiRealtimeSettingsSection();
    const model = section.fields.find((field) => field.kind === 'model');
    expect(model).toMatchObject({
      kind: 'model',
      path: 'model',
      movingAliasRequiresOptIn: true,
      options: [
        { kind: 'pinned', id: 'grok-voice-think-fast-1.0' },
        { kind: 'moving_alias', id: 'grok-voice-latest' },
      ],
    });
  });

  it('provides presentation keys for every shipping field and credential action', () => {
    const section = createXaiRealtimeSettingsSection();
    expect(section).toMatchObject({
      providerId: 'happier.voice.xai/realtime-grok',
      titleKey: 'settingsVoice.realtimeProviders.setup.title',
      footerKey: 'settingsVoice.realtimeProviders.xai.setup.footer',
      credential: {
        credentialPurpose: 'voice.client-auth',
        titleKey: 'settingsVoice.realtimeProviders.credential.title',
        promptTitleKey: 'settingsVoice.realtimeProviders.credential.promptTitle',
        promptBodyKey: 'settingsVoice.realtimeProviders.xai.credential.promptBody',
      },
    });
    const byPath = new Map(section.fields.map((field) => [field.path, field]));
    const keyNames: Readonly<Record<string, string>> = {
      model: 'model', voice: 'voice', instructions: 'instructions',
      reasoningEffort: 'reasoning', outputSpeed: 'outputSpeed',
      'transcription.languageHint': 'languageHint', 'transcription.keyterms': 'keyterms',
      turnDetection: 'turnDetection', resumptionEnabled: 'resumption',
    };
    for (const name of ['model', 'voice', 'instructions', 'reasoningEffort', 'outputSpeed', 'transcription.languageHint', 'transcription.keyterms', 'turnDetection', 'resumptionEnabled'] as const) {
      const keyName = keyNames[name]!;
      expect(byPath.get(name)).toMatchObject({
        titleKey: `settingsVoice.realtimeProviders.fields.${keyName}.title`,
        subtitleKey: `settingsVoice.realtimeProviders.fields.${keyName}.subtitle`,
      });
    }
    for (const [path, keyName] of [
      ['instructions', 'instructions'],
      ['outputSpeed', 'outputSpeed'],
      ['transcription.languageHint', 'languageHint'],
      ['transcription.keyterms', 'keyterms'],
    ] as const) {
      expect(byPath.get(path)).toMatchObject({
        promptTitleKey: `settingsVoice.realtimeProviders.fields.${keyName}.promptTitle`,
        promptBodyKey: `settingsVoice.realtimeProviders.fields.${keyName}.promptBody`,
      });
    }
    expect(byPath.get('instructions')).toMatchObject({ maxLength: 10_000 });
  });

  it('projects documented language and server-VAD option metadata without host provider branches', () => {
    const section = createXaiRealtimeSettingsSection();
    const language = section.fields.find((field) => field.path === 'transcription.languageHint');
    expect(language).toMatchObject({ options: [...XAI_SUPPORTED_LANGUAGE_HINTS] });
    const vad = section.fields.find((field) => field.path === 'turnDetection');
    expect(vad).toMatchObject({
      subfields: [
        expect.objectContaining({ suffix: 'threshold', path: 'turnDetection.threshold', min: 0.1, max: 0.9, nullable: true, titleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.threshold.title' }),
        expect.objectContaining({ suffix: 'silenceDurationMs', path: 'turnDetection.silenceDurationMs', min: 0, max: 10_000, integer: true, nullable: true, titleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.silenceDurationMs.title' }),
        expect.objectContaining({ suffix: 'prefixPaddingMs', path: 'turnDetection.prefixPaddingMs', min: 0, max: 10_000, integer: true, nullable: true, titleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.prefixPaddingMs.title' }),
        expect.objectContaining({
          suffix: 'idleTimeoutMs', path: 'turnDetection.idleTimeoutMs', min: 1, max: 600_000,
          integer: true, nullable: true, requiresOptIn: true,
          titleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.title',
          confirmTitleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.confirmTitle',
          confirmBodyKey: 'settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.confirmBody',
          confirmActionKey: 'settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.confirmAction',
        }),
      ],
    });
  });
});
