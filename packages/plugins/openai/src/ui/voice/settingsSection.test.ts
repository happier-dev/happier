import { describe, expect, it } from 'vitest';

import { createOpenAiRealtimeSettingsSection } from './settingsSection.js';

describe('OpenAI Realtime settings descriptor', () => {
  it('declares stable and moving model choices plus recommended voice choices as data', () => {
    const descriptor = createOpenAiRealtimeSettingsSection();
    const model = descriptor.fields.find((field) => field.kind === 'model');
    const voice = descriptor.fields.find((field) => field.kind === 'voice');

    expect(model).toMatchObject({
      titleKey: 'settingsVoice.realtimeProviders.fields.model.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.model.subtitle',
      movingAliasRequiresOptIn: true,
      options: [
        { kind: 'pinned', id: 'gpt-realtime-2.1' },
        { kind: 'moving_alias', id: 'gpt-realtime' },
      ],
    });
    expect(voice).toMatchObject({
      titleKey: 'settingsVoice.realtimeProviders.fields.voice.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.voice.subtitle',
      options: [{ id: 'marin', recommended: true }, { id: 'cedar', recommended: true }],
      customIdAllowed: true,
    });
    expect(descriptor).toMatchObject({
      titleKey: 'settingsVoice.realtimeProviders.authentication.sectionTitle',
      footerKey: 'settingsVoice.realtimeProviders.authentication.footer',
      credential: {
        titleKey: 'settingsVoice.realtimeProviders.credential.title',
        promptTitleKey: 'settingsVoice.realtimeProviders.credential.promptTitle',
        promptBodyKey: 'settingsVoice.realtimeProviders.credential.promptBody',
      },
    });
    expect(descriptor.fields[0]).toMatchObject({
      kind: 'authentication_source',
      path: 'authentication',
      options: [
        { id: 'voice_saved_secret' },
        { id: 'connected_service_api_key', purpose: 'realtime-openai-account' },
        { id: 'connected_service_oauth', purpose: 'realtime-openai-codex-account' },
      ],
    });
  });
});
