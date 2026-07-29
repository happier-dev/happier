import { afterEach, describe, expect, it } from 'vitest';

import {
  createBundledConversationUi,
} from './bundledConversationClient';
import {
  commitExternalVoiceProviderRegistration,
  resetExternalVoiceProviderRegistrationsForTests,
} from '@/voice/registry/externalVoiceProviderRegistrations';

describe('bundled conversation account credential client', () => {
  afterEach(() => resetExternalVoiceProviderRegistrationsForTests());

  it('constructs ElevenLabs settings actions only from the projected public leaf operations', () => {
    commitExternalVoiceProviderRegistration(Object.freeze({
      token: Object.freeze({}),
      pluginId: 'happier.voice.elevenlabs',
      localId: 'realtime-elevenlabs',
      providerId: 'realtime_elevenlabs',
      descriptor: null,
      adapter: null,
      settingsOperations: Object.freeze({
        async listCatalog() {
          return Object.freeze([]);
        },
        async provision() {
          return Object.freeze({ updated: true });
        },
      }),
    }));
    const elevenLabs = createBundledConversationUi('realtime_elevenlabs');
    expect(elevenLabs).not.toBeNull();
    expect(elevenLabs?.client?.fetchVoiceCatalog).toBeTypeOf('function');
    expect(elevenLabs?.autoprovision?.findExistingAgents).toBeTypeOf('function');

    const xai = createBundledConversationUi('realtime_grok');
    expect(xai).not.toBeNull();
    expect(xai?.client?.fetchVoiceCatalog).toBeTypeOf('function');
  });

  it('projects OpenAI settings without constructing its retired direct auth client', () => {
    const ui = createBundledConversationUi('realtime_openai');
    expect(ui).not.toBeNull();
    expect(ui?.settingsDescriptor.providerId).toBe('realtime_openai');
    expect(ui?.autoprovision).toBeNull();
    expect(ui?.client).toBeNull();
  });

  it('does not construct a private Codex settings surface beside its public declaration', () => {
    expect(createBundledConversationUi('realtime_codex')).toBeNull();
  });

  it('projects account-operation settings clients without exposing broker credential mutations', () => {
    for (const providerId of ['realtime_grok']) {
      const ui = createBundledConversationUi(providerId);
      expect(ui).not.toBeNull();
      expect(ui?.settingsDescriptor.providerId).toBe(providerId);
      expect(ui?.autoprovision).toBeNull();
      expect(ui?.client).not.toHaveProperty('credentialStatus');
      expect(ui?.client).not.toHaveProperty('storeCredential');
      expect(ui?.client).not.toHaveProperty('deleteCredential');
    }
    expect(createBundledConversationUi('realtime_grok')?.client?.fetchVoiceCatalog).toBeTypeOf('function');
  });
});
