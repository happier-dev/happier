import { describe, expect, it } from 'vitest';

import {
  VoiceProviderIdSchema,
  VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS,
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  readVoiceProviderSettingsConfig,
  voiceSettingsDefaults,
  voiceSettingsParse,
} from './voiceSettings';
import { DEFAULT_ELEVENLABS_VOICE_ID } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';

describe('voiceSettings', () => {
  const elevenLabsProviderId = 'happier.voice.elevenlabs/realtime-elevenlabs';

  it.each(['off', 'on_demand', 'automatic'] as const)(
    'preserves the independent current UI context privacy mode %s',
    (currentUiContextMode) => {
      expect(voiceSettingsParse({
        privacy: { currentUiContextMode },
      }).privacy.currentUiContextMode).toBe(currentUiContextMode);
    },
  );

  it('defaults an absent or malformed current UI context privacy mode to on demand', () => {
    expect(voiceSettingsParse({}).privacy.currentUiContextMode).toBe('on_demand');
    expect(voiceSettingsParse({
      privacy: { currentUiContextMode: 'always' },
    }).privacy.currentUiContextMode).toBe('on_demand');
  });

  it('drops never-released conversation selections and envelopes at settings ingress', () => {
    const parsed = voiceSettingsParse({
      providerId: 'realtime_codex',
      providers: {
        realtime_codex: {
          schemaVersion: 2,
          config: { globalConnectedServices: null },
        },
      },
    });

    expect(parsed.providerId).toBeNull();
    expect(parsed.providers['happier.agent.codex/realtime-codex']).toEqual(
      voiceSettingsDefaults.providers['happier.agent.codex/realtime-codex'],
    );
    expect(parsed.providers).not.toHaveProperty('realtime_codex');
  });

  it('keeps a canonical provider envelope while dropping a never-released lookalike', () => {
    const parsed = voiceSettingsParse({
      providers: {
        realtime_codex: {
          schemaVersion: 2,
          config: { globalConnectedServices: null },
        },
        'happier.agent.codex/realtime-codex': {
          schemaVersion: 2,
          config: { globalConnectedServices: 'all' },
        },
      },
    });

    expect(parsed.providers['happier.agent.codex/realtime-codex']).toEqual({
      schemaVersion: 2,
      config: { globalConnectedServices: 'all' },
    });
    expect(parsed.providers).not.toHaveProperty('realtime_codex');
  });

  it('keeps an explicit canonical root speech envelope when contracting a colliding nested copy', () => {
    const speechProviderId = 'happier.voice.google/gemini-stt';
    const parsed = voiceSettingsParse({
      providerId: 'local_conversation',
      providers: {
        [speechProviderId]: {
          schemaVersion: 2,
          config: { model: 'default-root', language: '' },
        },
        local_conversation: {
          schemaVersion: 1,
          config: {
            stt: {
              provider: speechProviderId,
              providers: {
                [speechProviderId]: {
                  schemaVersion: 2,
                  config: { model: 'selected-nested', language: 'de' },
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.providers[speechProviderId]).toEqual({
      schemaVersion: 2,
      config: { model: 'default-root', language: '' },
    });
    expect(readLocalConversationVoiceSettings(parsed).stt).not.toHaveProperty('providers');
  });

  it('does not recover an invalid explicit root speech envelope from a valid nested copy', () => {
    const speechProviderId = 'happier.voice.google/gemini-stt';
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      providers: {
        [speechProviderId]: {
          schemaVersion: 2,
          config: { model: null, language: '' },
        },
        local_direct: {
          schemaVersion: 1,
          config: {
            stt: {
              provider: speechProviderId,
              providers: {
                [speechProviderId]: {
                  schemaVersion: 2,
                  config: { model: 'nested-must-not-recover', language: 'de' },
                },
              },
            },
          },
        },
      },
    });

    expect(readVoiceProviderSettingsConfig(parsed, speechProviderId)).toBeNull();
    expect(readLocalDirectVoiceSettings(parsed).stt).not.toHaveProperty('providers');
  });

  it('does not promote an unshipped nested speech envelope into canonical root settings', () => {
    const speechProviderId = 'happier.voice.google/gemini-stt';
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      providers: {
        local_direct: {
          schemaVersion: 1,
          config: {
            stt: {
              provider: speechProviderId,
              providers: {
                [speechProviderId]: {
                  schemaVersion: 2,
                  config: { model: 'dev-only-nested', language: 'de' },
                },
              },
            },
          },
        },
      },
    });

    expect(readVoiceProviderSettingsConfig(parsed, speechProviderId)).toEqual({
      model: 'gemini-2.5-flash',
      language: '',
    });
  });

  it('imports released OpenAI-compatible role settings without inferring current-only authority', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          stt: {
            provider: 'openai_compat',
            openaiCompat: {
              baseUrl: 'http://localhost:8101/v1',
              insecureLocalOriginConsent: 'http://localhost:8101',
              insecureLocalConsentMachineId: 'machine-a',
              apiKey: null,
              model: 'legacy-whisper',
            },
          },
          tts: {
            provider: 'openai_compat',
          },
        },
        local_conversation: {
          tts: {
            provider: 'openai_compat',
            openaiCompat: {
              baseUrl: 'http://localhost:8102/v1',
              insecureLocalOriginConsent: 'http://localhost:8102',
              insecureLocalConsentMachineId: 'machine-b',
              apiKey: null,
              model: 'legacy-tts',
              voice: 'legacy-voice',
              format: 'wav',
            },
          },
        },
      },
    });

    expect(parsed.providers['happier.voice.openai-compat/stt']).toEqual({
      schemaVersion: 2,
      config: expect.objectContaining({
        baseUrl: 'http://localhost:8101/v1',
        insecureLocalOriginConsent: '',
        insecureLocalConsentMachineId: '',
        model: 'legacy-whisper',
        language: '',
      }),
    });
    expect(parsed.providers['happier.voice.openai-compat/tts']).toEqual({
      schemaVersion: 2,
      config: expect.objectContaining({
        baseUrl: 'http://localhost:8102/v1',
        insecureLocalOriginConsent: '',
        insecureLocalConsentMachineId: '',
        model: 'legacy-tts',
        voiceName: 'legacy-voice',
        format: 'wav',
      }),
    });
    expect(parsed.providers['happier.voice.openai-compat/stt']?.config).not.toHaveProperty('apiKey');
    expect(parsed.providers['happier.voice.openai-compat/tts']?.config).not.toHaveProperty('apiKey');
    const local = readLocalDirectVoiceSettings(parsed);
    expect(local.stt.provider).toBe('happier.voice.openai-compat/stt');
    expect(local.tts.provider).toBe('happier.voice.openai-compat/tts');
    expect(local.stt).not.toHaveProperty('openaiCompat');
    expect(local.tts).not.toHaveProperty('openaiCompat');
  });

  it('does not treat current-only speech fields as a released OpenAI-compatible configuration carrier', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          stt: {
            provider: 'openai_compat',
            baseUrl: 'http://current-only-stt.test/v1',
            insecureLocalOriginConsent: 'http://current-only-stt.test',
            insecureLocalConsentMachineId: 'machine-stt',
            language: 'de',
            model: 'current-only-whisper',
          },
          tts: {
            provider: 'openai_compat',
            baseUrl: 'http://current-only-tts.test/v1',
            insecureLocalOriginConsent: 'http://current-only-tts.test',
            insecureLocalConsentMachineId: 'machine-tts',
            model: 'current-only-tts',
            voice: 'current-only-voice',
            format: 'wav',
          },
        },
      },
    });

    expect(readVoiceProviderSettingsConfig(parsed, 'happier.voice.openai-compat/stt')).toEqual({
      baseUrl: '',
      insecureLocalOriginConsent: '',
      insecureLocalConsentMachineId: '',
      language: '',
      model: 'whisper-1',
    });
    expect(readVoiceProviderSettingsConfig(parsed, 'happier.voice.openai-compat/tts')).toEqual({
      baseUrl: '',
      insecureLocalOriginConsent: '',
      insecureLocalConsentMachineId: '',
      format: 'mp3',
      model: 'tts-1',
      voiceName: 'alloy',
    });
  });

  it('stores credential references in the Voice settings owner', () => {
    const parsed = voiceSettingsParse({
      credentialBindings: [{
        contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: 'saved-openai' } },
      }],
    });

    expect(parsed.credentialBindings).toEqual([{
      contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
      credentialSlotId: 'api_key',
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { api_key: 'saved-openai' } },
    }]);
    expect(voiceSettingsParse({
      credentialBindings: [
        {
          contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
          credentialSlotId: 'api_key', credentialSource: { kind: 'savedSecret' }, credentialBindings: {},
        },
        {
          contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
          credentialSlotId: 'api_key', credentialSource: { kind: 'savedSecret' }, credentialBindings: {},
        },
      ],
    }).credentialBindings).toEqual([]);
  });

  it('defaults to an explicitly unconfigured provider with canonical provider envelopes', () => {
    expect(voiceSettingsDefaults.providerId).toBe(null);
    expect(voiceSettingsDefaults.dictation).toEqual({
      sttBinding: 'explicit',
      language: null,
      stt: {
        provider: 'device',
        localNeural: expect.any(Object),
      },
    });
    expect(voiceSettingsDefaults.providers).toEqual(expect.objectContaining({
      [elevenLabsProviderId]: expect.objectContaining({ schemaVersion: 2 }),
      local_direct: expect.objectContaining({ schemaVersion: 1 }),
      local_conversation: expect.objectContaining({ schemaVersion: 1 }),
    }));
    expect(voiceSettingsDefaults.executionMachine).toEqual({
      mode: 'auto',
      machineId: null,
      autoMachineId: null,
    });
    expect(voiceSettingsDefaults.welcome).toEqual({
      enabled: false,
      mode: 'immediate',
      templateId: null,
    });
    expect('adapters' in voiceSettingsDefaults).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(voiceSettingsDefaults, 'adapters')).toBe(false);
    expect(JSON.stringify(voiceSettingsDefaults)).not.toContain('"adapters"');
    expect(readLocalDirectVoiceSettings(voiceSettingsDefaults).stt).not.toHaveProperty('openaiCompat');
    expect(readLocalDirectVoiceSettings(voiceSettingsDefaults).tts).not.toHaveProperty('openaiCompat');
    expect(voiceSettingsDefaults.dictation.stt).not.toHaveProperty('openaiCompat');
  });

  it('persists the current qualified Dictation selection independently from provider configuration', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_conversation',
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { stt: { provider: 'local_neural' } },
        },
      },
      dictation: {
        sttBinding: 'explicit',
        language: 'de-CH',
        stt: {
          provider: 'happier.voice.openai-compat/stt',
        },
      },
    });

    expect(parsed.dictation).toMatchObject({
      sttBinding: 'explicit',
      language: 'de-CH',
      stt: {
        provider: 'happier.voice.openai-compat/stt',
      },
    });
    expect(parsed.dictation.stt).not.toHaveProperty('openaiCompat');
    expect(parsed.dictation.stt).not.toHaveProperty('openaiCompat');
  });

  it('migrates the complete untouched legacy hosted default to unconfigured', () => {
    const parsed = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      assistantLanguage: null,
      ui: {},
      privacy: {},
      adapters: {
        realtime_elevenlabs: {
          assistantLanguage: null,
          billingMode: 'happier',
          welcome: { enabled: false, mode: 'immediate', templateId: null },
          tts: {
            voiceId: 'EST9Ui6982FZPSi7gCHi',
            modelId: null,
            voiceSettings: {
              stability: null,
              similarityBoost: null,
              style: null,
              useSpeakerBoost: null,
              speed: null,
            },
          },
          byo: { agentId: null, apiKey: null },
        },
        local_direct: {},
        local_conversation: {},
      },
    });

    expect(parsed.providerId).toBe(null);
  });

  it('preserves an explicit or customized legacy hosted selection', () => {
    expect(voiceSettingsParse({ providerId: 'realtime_elevenlabs' }).providerId).toBe(elevenLabsProviderId);

    const customized = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      adapters: {
        realtime_elevenlabs: {
          billingMode: 'byo',
          tts: { voiceId: 'EST9Ui6982FZPSi7gCHi' },
          byo: { agentId: 'agent-123', apiKey: null },
        },
      },
    });
    expect(customized.providerId).toBe(elevenLabsProviderId);
    expect(readVoiceProviderSettingsConfig(customized, elevenLabsProviderId)).toMatchObject({
      tts: { voiceId: 'EST9Ui6982FZPSi7gCHi' },
    });
  });

  it('does not expose legacy adapters on canonical parse results while preserving legacy boundary migration', () => {
    const canonical = voiceSettingsParse({ providerId: 'realtime_elevenlabs' });

    expect('adapters' in canonical).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(canonical, 'adapters')).toBe(false);
    expect(voiceSettingsParse(canonical).providerId).toBe(elevenLabsProviderId);

    const migrated = voiceSettingsParse({
      providerId: 'local_conversation',
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          networkTimeoutMs: 31_000,
        },
      },
    });
    expect(readLocalConversationVoiceSettings(migrated)).toMatchObject({
      conversationMode: 'agent',
      networkTimeoutMs: 31_000,
    });
    expect('adapters' in migrated).toBe(false);
  });

  it('migrates language, welcome, and execution-machine ownership exactly once', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_conversation',
      assistantLanguage: 'en',
      adapters: {
        realtime_elevenlabs: {
          assistantLanguage: 'fr',
          welcome: { enabled: true, mode: 'on_first_turn', templateId: 'eleven' },
        },
        local_conversation: {
          agent: {
            machineTargetMode: 'fixed',
            machineTargetId: 'machine-1',
            autoTargetMachineId: 'machine-old',
            welcome: { enabled: true, mode: 'immediate', templateId: 'local' },
          },
        },
      },
    });

    expect(parsed.assistantLanguage).toBe('en');
    expect(parsed.welcome).toEqual({ enabled: true, mode: 'immediate', templateId: 'local' });
    expect(parsed.executionMachine).toEqual({
      mode: 'fixed',
      machineId: 'machine-1',
      autoMachineId: 'machine-old',
    });
    expect(JSON.stringify(parsed)).not.toContain('machineTargetMode');
    expect(JSON.stringify(parsed.providers[elevenLabsProviderId].config)).not.toContain('assistantLanguage');
  });

  it('migrates the legacy assistant language only when the canonical root field is absent', () => {
    const migrated = voiceSettingsParse({
      adapters: {
        realtime_elevenlabs: { assistantLanguage: 'fr' },
      },
    });
    expect(migrated.providers[elevenLabsProviderId]).toMatchObject({
      schemaVersion: 2,
      config: expect.any(Object),
    });
    expect(migrated.assistantLanguage).toBe('fr');

    expect(voiceSettingsParse({
      assistantLanguage: null,
      adapters: {
        realtime_elevenlabs: { assistantLanguage: 'fr' },
      },
    }).assistantLanguage).toBe(null);
  });

  it('preserves valid unknown provider envelopes without selecting or interpreting them', () => {
    const providerId = 'acme.voice/future-vendor';
    const unknown = {
      schemaVersion: 7,
      config: { nested: ['value', 3, true, null], future: { flag: 'kept' } },
    };
    const parsed = voiceSettingsParse({
      providerId,
      providers: { [providerId]: unknown },
    });

    expect(parsed.providerId).toBe(providerId);
    expect(parsed.providers[providerId]).toEqual(unknown);
    expect(JSON.parse(JSON.stringify(parsed)).providers[providerId]).toEqual(unknown);
  });

  it('reclaims an inert legacy bundled-provider envelope after the same owner is restored', () => {
    const parsed = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 1,
          config: {
            assistantLanguage: 'fr',
            billingMode: 'byo',
            welcome: { enabled: true, mode: 'on_first_turn', templateId: 'restored' },
          },
        },
      },
    });

    expect(parsed.assistantLanguage).toBe('fr');
    expect(parsed.welcome).toEqual({ enabled: true, mode: 'on_first_turn', templateId: 'restored' });
    expect(parsed.providers[elevenLabsProviderId].config).toMatchObject({ billingMode: 'byo' });
    expect(parsed.providers[elevenLabsProviderId].config).not.toHaveProperty('assistantLanguage');
    expect(parsed.providers[elevenLabsProviderId].config).not.toHaveProperty('welcome');
  });

  it('keeps a legacy credential envelope migration-only until the credential store confirms import', () => {
    const legacySecret = { _isSecretValue: true as const, value: 'xi_legacy' };
    const parsed = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 1,
          config: {
            assistantLanguage: 'fr',
            billingMode: 'byo',
            welcome: { enabled: true, mode: 'on_first_turn', templateId: 'legacy' },
            byo: { agentId: 'agent_1', apiKey: legacySecret },
          },
        },
      },
    });

    expect(parsed.assistantLanguage).toBe('fr');
    expect(parsed.welcome).toEqual({ enabled: true, mode: 'on_first_turn', templateId: 'legacy' });
    expect(parsed.providers[elevenLabsProviderId]).toEqual({
      schemaVersion: 1,
      config: expect.objectContaining({ byo: { agentId: 'agent_1', apiKey: legacySecret } }),
    });
  });

  it('does not discard an unselected legacy provider welcome while its credential still needs import', () => {
    const parsed = voiceSettingsParse({
      providerId: null,
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 1,
          config: {
            billingMode: 'byo',
            welcome: { enabled: true, mode: 'on_first_turn', templateId: 'later' },
            byo: {
              agentId: 'agent_1',
              apiKey: { _isSecretValue: true, value: 'xi_legacy' },
            },
          },
        },
      },
    });

    expect(parsed.welcome).toEqual({ enabled: false, mode: 'immediate', templateId: null });
    expect(parsed.providers[elevenLabsProviderId].config).toMatchObject({
      welcome: { enabled: true, mode: 'on_first_turn', templateId: 'later' },
    });
  });

  it('preserves malformed known-provider config as inert instead of replacing it with runnable defaults', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_conversation',
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'not-a-real-mode', futureField: true },
        },
      },
    });

    expect(parsed.providers.local_conversation).toEqual({
      schemaVersion: 1,
      config: { conversationMode: 'not-a-real-mode', futureField: true },
    });
  });

  it('migrates missing legacy providers without overwriting canonical provider envelopes', () => {
    const providerId = 'acme.voice/future-vendor';
    const parsed = voiceSettingsParse({
      providers: {
        [providerId]: { schemaVersion: 4, config: { preserved: true } },
      },
      adapters: {
        local_direct: { networkTimeoutMs: 32_000 },
      },
    });

    expect(parsed.providers[providerId]).toEqual({ schemaVersion: 4, config: { preserved: true } });
    expect((parsed.providers.local_direct.config as any).networkTimeoutMs).toBe(32_000);
  });

  it('does not classify a legacy provider block with unknown customization as the untouched hosted default', () => {
    const parsed = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      ui: {},
      privacy: {},
      adapters: {
        realtime_elevenlabs: { futureCustomization: true },
        local_direct: {},
        local_conversation: {},
      },
    });

    expect(parsed.providerId).toBe(elevenLabsProviderId);
  });

  it('does not migrate an inactive realtime welcome preference onto local-direct voice', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        realtime_elevenlabs: {
          welcome: { enabled: true, mode: 'on_first_turn', templateId: 'realtime-only' },
        },
        local_direct: {},
      },
    });

    expect(parsed.welcome).toEqual({ enabled: false, mode: 'immediate', templateId: null });
  });

  it('rejects prototype-reserved provider identifiers at the open settings boundary', () => {
    expect(VoiceProviderIdSchema.safeParse('constructor').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse('prototype').success).toBe(false);
  });

  it('preserves a canonical external provider selection and envelope', () => {
    const providerId = 'acme.synthetic-voice/conversation';
    const parsed = voiceSettingsParse({
      providerId,
      providers: { [providerId]: { schemaVersion: 1, config: { mode: 'default' } } },
    });
    expect(parsed.providerId).toBe(providerId);
    expect(parsed.providers[providerId]).toEqual({ schemaVersion: 1, config: { mode: 'default' } });
  });

  it('copies unknown provider JSON so callers cannot mutate parsed settings through the input object', () => {
    const providerId = 'acme.voice/future-vendor';
    const config = { nested: { value: 'before' } };
    const parsed = voiceSettingsParse({
      providers: { [providerId]: { schemaVersion: 7, config } },
    });

    config.nested.value = 'after';

    expect(parsed.providers[providerId]).toEqual({
      schemaVersion: 7,
      config: { nested: { value: 'before' } },
    });
  });

  it('drops malformed or oversized provider envelopes while preserving neighboring valid entries', () => {
    const malformedProviderId = 'acme.voice/malformed';
    const oversizedProviderId = 'acme.voice/oversized';
    const validProviderId = 'acme.voice/valid-unknown';
    const parsed = voiceSettingsParse({
      providers: {
        [malformedProviderId]: { schemaVersion: 0, config: { nope: true } },
        [oversizedProviderId]: { schemaVersion: 1, config: { value: 'x'.repeat(70_000) } },
        [validProviderId]: { schemaVersion: 1, config: { kept: true } },
      },
    });

    expect(parsed.providers[malformedProviderId]).toBeUndefined();
    expect(parsed.providers[oversizedProviderId]).toBeUndefined();
    expect(parsed.providers[validProviderId]).toEqual({ schemaVersion: 1, config: { kept: true } });
  });

  it('defaults include ui activity feed + scope settings', () => {
    expect((voiceSettingsDefaults as any).ui?.activityFeedEnabled).toBe(false);
    expect((voiceSettingsDefaults as any).ui?.activityFeedAutoExpandOnStart).toBe(false);
    expect((voiceSettingsDefaults as any).ui?.scopeDefault).toBeTypeOf('string');
  });

  it('defaults include opt-out privacy settings', () => {
    expect((voiceSettingsDefaults as any).privacy?.shareToolNames).toBe(true);
    expect((voiceSettingsDefaults as any).privacy?.sharePermissionRequests).toBe(true);
    expect((voiceSettingsDefaults as any).privacy?.shareDeviceInventory).toBe(true);
    expect((voiceSettingsDefaults as any).privacy?.shareFilePaths).toBe(false);
    expect((voiceSettingsDefaults as any).privacy?.shareToolArgs).toBe(false);
  });

  it('parses ui activityFeedEnabled and keeps defaults for missing fields', () => {
    const parsed = voiceSettingsParse({ ui: { activityFeedEnabled: true } });
    expect((parsed as any).ui?.activityFeedEnabled).toBe(true);
    expect((parsed as any).ui?.activityFeedAutoExpandOnStart).toBe(false);
  });

  it('does not throw when ui fields are invalid', () => {
    const parsed = voiceSettingsParse({ ui: { activityFeedEnabled: 'yes' } });
    expect((parsed as any).ui?.activityFeedEnabled).toBe(false);
  });

  it('parses privacy booleans (including shareToolArgs)', () => {
    const parsed = voiceSettingsParse({ privacy: { shareToolArgs: false, shareFilePaths: false } });
    expect((parsed as any).privacy?.shareToolArgs).toBe(false);
    expect((parsed as any).privacy?.shareFilePaths).toBe(false);
  });

  it('defaults include ElevenLabs TTS voice selection', () => {
    const elevenLabs = readVoiceProviderSettingsConfig(voiceSettingsDefaults, elevenLabsProviderId) as any;
    expect(elevenLabs?.tts?.voiceId).toBeTypeOf('string');
    // The plugin manifest is the sole authority for the shipped default; a
    // literal here would be a second copy that silently drifts from it.
    expect(String(elevenLabs?.tts?.voiceId)).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
    expect(voiceSettingsDefaults.welcome.enabled).toBe(false);
    expect(voiceSettingsDefaults.welcome.mode).toBe('immediate');
  });

  it('defaults include local voice agent transcript persistence settings', () => {
    const agent = readLocalConversationVoiceSettings(voiceSettingsDefaults).agent;
    expect(agent?.idleTtlSeconds).toBe(1800);
    expect(agent?.prewarmOnConnect).toBe(true);
    expect(agent?.resumabilityMode).toBe('replay');
    expect(agent?.providerResume?.fallbackToReplay).toBe(true);
    expect(agent?.replay?.strategy).toBe('recent_messages');
    expect(agent?.replay?.recentMessagesCount).toBeTypeOf('number');
    expect(voiceSettingsDefaults.welcome.enabled).toBe(false);
    expect(voiceSettingsDefaults.welcome.mode).toBe('immediate');
    expect(agent?.commitIsolation).toBe(false);
    expect(agent?.transcript?.persistenceMode).toBe('ephemeral');
    expect(agent?.transcript?.epoch).toBe(0);
  });

  it('defaults include hands-free endpointing settings for local voice', () => {
    const localConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    expect(localConversation?.handsFree?.endpointing?.silenceMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs);
    expect(localConversation?.handsFree?.endpointing?.minSpeechMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs);

    const localDirect = readLocalDirectVoiceSettings(voiceSettingsDefaults);
    expect(localDirect?.handsFree?.endpointing?.silenceMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs);
    expect(localDirect?.handsFree?.endpointing?.minSpeechMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs);
  });

  it('migrates legacy hands-free endpointing defaults to the new voice defaults', () => {
    const parsed = voiceSettingsParse({
      adapters: {
        local_conversation: {
          handsFree: {
            enabled: false,
            endpointing: { silenceMs: 450, minSpeechMs: 120 },
          },
        },
        local_direct: {
          handsFree: {
            enabled: false,
            endpointing: { silenceMs: 450, minSpeechMs: 120 },
          },
        },
      },
    });

    expect(readLocalConversationVoiceSettings(parsed).handsFree.endpointing.silenceMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs);
    expect(readLocalConversationVoiceSettings(parsed).handsFree.endpointing.minSpeechMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs);
    expect(readLocalDirectVoiceSettings(parsed).handsFree.endpointing.silenceMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs);
    expect(readLocalDirectVoiceSettings(parsed).handsFree.endpointing.minSpeechMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs);
  });

  it('preserves custom hands-free endpointing values when they are not the legacy defaults', () => {
    const parsed = voiceSettingsParse({
      adapters: {
        local_conversation: {
          handsFree: {
            enabled: true,
            endpointing: { silenceMs: 700, minSpeechMs: 300 },
          },
        },
      },
    });

    expect(readLocalConversationVoiceSettings(parsed).handsFree.enabled).toBe(true);
    expect(readLocalConversationVoiceSettings(parsed).handsFree.endpointing.silenceMs).toBe(700);
    expect(readLocalConversationVoiceSettings(parsed).handsFree.endpointing.minSpeechMs).toBe(300);
  });

  it('migrates the old minimum-speech default even when silence timeout is already on the newer default', () => {
    const parsed = voiceSettingsParse({
      adapters: {
        local_conversation: {
          handsFree: {
            enabled: false,
            endpointing: { silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs, minSpeechMs: 120 },
          },
        },
      },
    });

    expect(readLocalConversationVoiceSettings(parsed).handsFree.endpointing.silenceMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs);
    expect(readLocalConversationVoiceSettings(parsed).handsFree.endpointing.minSpeechMs).toBe(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs);
  });

  it('defaults include a generous streamed-turn timeout for local voice agents', () => {
    const streaming = readLocalConversationVoiceSettings(voiceSettingsDefaults).streaming;
    expect(streaming?.enabled).toBe(true);
    expect(streaming?.ttsEnabled).toBe(true);
    expect(streaming?.turnStreamTimeoutMs).toBe(1800000);
  });

  it('defaults include local voice agent machine + directory policies', () => {
    const agent = readLocalConversationVoiceSettings(voiceSettingsDefaults).agent;
    expect(voiceSettingsDefaults.executionMachine.mode).toBe('auto');
    expect(voiceSettingsDefaults.executionMachine.machineId).toBe(null);
    expect(voiceSettingsDefaults.executionMachine.autoMachineId).toBe(null);
    expect(agent?.stayInVoiceHome).toBe(false);
    expect(agent?.teleportEnabled).toBe(true);
    expect(agent?.rootSessionPolicy).toBe('single');
    expect(agent?.maxWarmRoots).toBeTypeOf('number');
    expect(agent?.voiceHomeSubdirName).toBeTypeOf('string');
  });

  it('defaults include local TTS provider selection', () => {
    const tts = readLocalDirectVoiceSettings(voiceSettingsDefaults).tts;
    expect(tts?.provider).toBe('happier.voice.openai-compat/tts');
    expect(tts).not.toHaveProperty('openaiCompat');
    expect(readVoiceProviderSettingsConfig(
      voiceSettingsDefaults,
      'happier.voice.openai-compat/tts',
    )).toMatchObject({ model: 'tts-1', voiceName: 'alloy', format: 'mp3' });
    expect(tts?.localNeural?.model).toBe('kokoro');
    expect(tts?.localNeural?.assetId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
    expect(tts?.localNeural?.execution).toBe('auto');
  });

  it('defaults include local STT provider selection', () => {
    const stt = readLocalDirectVoiceSettings(voiceSettingsDefaults).stt;
    expect(stt?.provider).toBe('happier.voice.openai-compat/stt');
    expect(stt).not.toHaveProperty('openaiCompat');
    expect(readVoiceProviderSettingsConfig(
      voiceSettingsDefaults,
      'happier.voice.openai-compat/stt',
    )).toMatchObject({ model: 'whisper-1' });
    expect(stt?.localNeural?.assetId).toBe('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
    expect(stt?.localNeural?.execution).toBe('auto');
  });

  it('accepts local_neural as a local TTS provider (Kokoro model)', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          tts: {
            provider: 'local_neural',
            openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
            localNeural: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart', speed: 1, execution: 'daemon' },
            googleCloud: { apiKey: null, voiceName: null, languageCode: null, format: 'mp3' },
            autoSpeakReplies: true,
            bargeInEnabled: true,
          },
        },
      },
    });

    const tts = readLocalDirectVoiceSettings(parsed).tts;
    expect(tts?.provider).toBe('local_neural');
    expect(tts?.localNeural?.model).toBe('kokoro');
    expect(tts?.localNeural?.assetId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
    expect(tts?.localNeural?.voiceId).toBe('af_heart');
    expect(tts?.localNeural?.execution).toBe('daemon');
  });

  it('accepts local_neural as a local STT provider', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          stt: {
            provider: 'local_neural',
            openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
            googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
            localNeural: { assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', language: 'en', execution: 'device' },
          },
        },
      },
    });

    const stt = readLocalDirectVoiceSettings(parsed).stt;
    expect(stt?.provider).toBe('local_neural');
    expect(stt?.localNeural?.assetId).toBe('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
    expect(stt?.localNeural?.execution).toBe('device');
  });

  it('drops undeployed local TTS endpoint configuration at the qualified boundary', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          tts: {
            baseUrl: 'http://localhost:1234',
            apiKey: null,
            model: 'tts-1',
            voice: 'alloy',
            format: 'mp3',
            useDeviceTts: false,
            autoSpeakReplies: true,
            bargeInEnabled: true,
          },
        },
      },
    });

    expect(readLocalDirectVoiceSettings(parsed).tts.provider).toBe('happier.voice.openai-compat/tts');
    expect(readLocalDirectVoiceSettings(parsed).tts).not.toHaveProperty('openaiCompat');
    expect(readVoiceProviderSettingsConfig(
      parsed,
      'happier.voice.openai-compat/tts',
    )).toMatchObject({ baseUrl: '' });
  });

  it('drops undeployed local STT endpoint configuration at the qualified boundary', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          stt: {
            baseUrl: 'http://localhost:1234',
            apiKey: null,
            model: 'whisper-1',
            useDeviceStt: false,
          },
        },
      },
    });

    expect(readLocalDirectVoiceSettings(parsed).stt.provider).toBe('happier.voice.openai-compat/stt');
    expect(readLocalDirectVoiceSettings(parsed).stt).not.toHaveProperty('openaiCompat');
    expect(readVoiceProviderSettingsConfig(
      parsed,
      'happier.voice.openai-compat/stt',
    )).toMatchObject({ baseUrl: '' });
  });

  it('preserves host-owned local-conversation fields while dropping undeployed speech endpoint config', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_conversation',
      adapters: {
        local_conversation: {
          conversationMode: 'direct_session',
          stt: { baseUrl: 'http://localhost:8000', apiKey: null, model: 'whisper-1', useDeviceStt: false },
          tts: {
            autoSpeakReplies: false,
            bargeInEnabled: true,
            provider: 'openai_compat',
            openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
            kokoro: { assetSetId: null, voiceId: null, speed: null },
          },
          networkTimeoutMs: 15_000,
          handsFree: { enabled: false, endpointing: { silenceMs: 5000, minSpeechMs: 1000 } },
          agent: {
            agentSource: 'session',
            agentId: 'claude',
            permissionPolicy: 'read_only',
            idleTtlSeconds: 300,
            chatModelSource: 'custom',
            chatModelId: 'default',
            commitModelSource: 'chat',
            commitModelId: 'default',
            providerChat: null,
            verbosity: 'short',
          },
          streaming: { enabled: false, ttsEnabled: false, ttsChunkChars: 200 },
        },
      },
    });

    expect((parsed.providers.local_conversation.config as any).stt).not.toHaveProperty('openaiCompat');
    expect(readVoiceProviderSettingsConfig(
      parsed,
      'happier.voice.openai-compat/stt',
    )).toMatchObject({ baseUrl: '' });
    expect((parsed.providers.local_conversation.config as any).streaming.enabled).toBe(false);
  });

  it('strips retired direct Chat aliases instead of retaining a parallel runtime configuration', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_conversation',
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: {
            conversationMode: 'agent',
            agent: {
              backend: 'openai_compat',
              openaiCompat: { maxTokens: -9 },
            },
          },
        },
      },
    });

    const agent = (parsed.providers.local_conversation.config as any).agent;
    expect(agent).not.toHaveProperty('backend');
    expect(agent).not.toHaveProperty('openaiCompat');
    expect(readLocalConversationVoiceSettings(parsed).agent.providerChat).toBeNull();
  });

  it('migrates legacy device STT toggle into provider format', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          stt: {
            baseUrl: null,
            apiKey: null,
            model: 'whisper-1',
            useDeviceStt: true,
          },
        },
      },
    });

    expect(readLocalDirectVoiceSettings(parsed).stt.provider).toBe('device');
  });

  it('accepts google_cloud as a local TTS provider', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          tts: {
            provider: 'google_cloud',
            openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
            localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
            googleCloud: { apiKey: null, voiceName: 'en-US-Wavenet-D', languageCode: 'en-US', format: 'mp3' },
            autoSpeakReplies: true,
            bargeInEnabled: true,
          },
        },
      },
    });

    expect(readLocalDirectVoiceSettings(parsed).tts.provider).toBe('happier.voice.google/google-cloud-tts');
    expect(readLocalDirectVoiceSettings(parsed).tts).not.toHaveProperty('providers');
    expect(parsed.providers['happier.voice.google/google-cloud-tts']).toEqual({
      schemaVersion: 2,
      config: expect.objectContaining({ voiceName: 'en-US-Wavenet-D' }),
    });
  });

  it('migrates legacy device TTS toggle into provider format', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          tts: {
            baseUrl: null,
            apiKey: null,
            model: 'tts-1',
            voice: 'alloy',
            format: 'mp3',
            useDeviceTts: true,
            autoSpeakReplies: true,
            bargeInEnabled: true,
          },
        },
      },
    });

    expect(readLocalDirectVoiceSettings(parsed).tts.provider).toBe('device');
  });
});
