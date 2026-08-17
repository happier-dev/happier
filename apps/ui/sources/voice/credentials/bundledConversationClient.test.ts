import { afterEach, describe, expect, it } from 'vitest';
import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
} from '@happier-dev/protocol';

import {
  createBundledConversationUi,
} from './bundledConversationClient';
import {
  commitExternalVoiceProviderRegistration,
  resetExternalVoiceProviderRegistrationsForTests,
} from '@/voice/registry/externalVoiceProviderRegistrations';

describe('bundled conversation account credential client', () => {
  const providerId = (pluginId: string, localId: string) =>
    buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId }));
  const elevenLabsProviderId = providerId('happier.voice.elevenlabs', 'realtime-elevenlabs');
  const openAiProviderId = providerId('happier.voice.openai', 'realtime-openai');
  const xaiProviderId = providerId('happier.voice.xai', 'realtime-grok');
  const codexProviderId = providerId('happier.agent.codex', 'realtime-codex');

  afterEach(() => resetExternalVoiceProviderRegistrationsForTests());

  it('projects catalog operations without recreating a provider-specific settings-action bridge', () => {
    commitExternalVoiceProviderRegistration(Object.freeze({
      token: Object.freeze({}),
      pluginId: 'happier.voice.elevenlabs',
      localId: 'realtime-elevenlabs',
      providerId: elevenLabsProviderId,
      descriptor: null,
      adapter: null,
      settingsOperations: Object.freeze({
        async listCatalog() {
          return Object.freeze([]);
        },
      }),
    }));
    const elevenLabs = createBundledConversationUi(elevenLabsProviderId);
    expect(elevenLabs).not.toBeNull();
    expect(elevenLabs?.client?.fetchVoiceCatalog).toBeTypeOf('function');
    expect(elevenLabs).not.toHaveProperty('autoprovision');

    const xai = createBundledConversationUi(xaiProviderId);
    expect(xai).not.toBeNull();
    expect(xai?.client).toBeNull();
  });

  it('does not admit predecessor selections at the bundled presentation boundary', () => {
    expect(createBundledConversationUi('realtime_openai')).toBeNull();
  });

  it('does not construct a private OpenAI settings surface beside its public declaration', () => {
    expect(createBundledConversationUi(openAiProviderId)).toBeNull();
  });

  it('does not construct a private Codex settings surface beside its public declaration', () => {
    expect(createBundledConversationUi(codexProviderId)).toBeNull();
  });

  it('projects account-operation settings clients without exposing broker credential mutations', () => {
    commitExternalVoiceProviderRegistration(Object.freeze({
      token: Object.freeze({}),
      pluginId: 'happier.voice.xai',
      localId: 'realtime-grok',
      providerId: xaiProviderId,
      descriptor: null,
      adapter: null,
      settingsOperations: Object.freeze({
        async listCatalog() {
          return Object.freeze([]);
        },
      }),
    }));
    for (const currentProviderId of [xaiProviderId]) {
      const ui = createBundledConversationUi(currentProviderId);
      expect(ui).not.toBeNull();
      expect(ui).not.toHaveProperty('autoprovision');
      expect(ui?.client).not.toHaveProperty('credentialStatus');
      expect(ui?.client).not.toHaveProperty('storeCredential');
      expect(ui?.client).not.toHaveProperty('deleteCredential');
    }
    expect(createBundledConversationUi(xaiProviderId)?.client?.fetchVoiceCatalog).toBeTypeOf('function');
  });
});
