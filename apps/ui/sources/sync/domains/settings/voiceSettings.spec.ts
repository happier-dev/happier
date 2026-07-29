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

describe('voiceSettings', () => {
  it('stores credential references in the Voice settings owner', () => {
    const parsed = voiceSettingsParse({
      credentialBindings: [{
        providerId: 'realtime_openai',
        credentialBindings: { account: { api_key: 'saved-openai' } },
      }],
    });

    expect(parsed.credentialBindings).toEqual([{
      providerId: 'realtime_openai',
      credentialBindings: { account: { api_key: 'saved-openai' } },
    }]);
    expect(voiceSettingsParse({
      credentialBindings: [
        { providerId: 'realtime_openai', credentialBindings: {} },
        { providerId: 'realtime_openai', credentialBindings: {} },
      ],
    }).credentialBindings).toEqual([]);
  });

  it('defaults to an explicitly unconfigured provider with canonical provider envelopes', () => {
    expect(voiceSettingsDefaults.providerId).toBe(null);
    expect(voiceSettingsDefaults.dictation).toEqual({
      sttBinding: 'explicit',
      language: null,
      stt: expect.objectContaining({
        provider: 'device',
      }),
    });
    expect(voiceSettingsDefaults.providers).toEqual(expect.objectContaining({
      realtime_elevenlabs: expect.objectContaining({ schemaVersion: 2 }),
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
  });

  it('persists Dictation STT independently while stripping legacy inline secrets', () => {
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
          provider: 'openai_compat',
          openaiCompat: {
            baseUrl: 'https://speech.example.test',
            apiKey: { _isSecretValue: true, value: 'must-not-persist' },
            model: 'whisper-dictation',
          },
        },
      },
    });

    expect(parsed.dictation).toMatchObject({
      sttBinding: 'explicit',
      language: 'de-CH',
      stt: {
        provider: 'openai_compat',
        openaiCompat: {
          baseUrl: 'https://speech.example.test',
          apiKey: null,
          model: 'whisper-dictation',
        },
      },
    });
    expect(JSON.stringify(parsed.dictation)).not.toContain('must-not-persist');
  });

  it('migrates the complete untouched legacy hosted default to unconfigured', () => {
    const parsed = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      assistantLanguage: null,
      ui: {},
      privacy: {},
      adapters: {
        realtime_elevenlabs: {},
        local_direct: {},
        local_conversation: {},
      },
    });

    expect(parsed.providerId).toBe(null);
  });

  it('preserves an explicit or customized legacy hosted selection', () => {
    expect(voiceSettingsParse({ providerId: 'realtime_elevenlabs' }).providerId).toBe('realtime_elevenlabs');

    const customized = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      adapters: {
        realtime_elevenlabs: {
          billingMode: 'byo',
          byo: { agentId: 'agent-123', apiKey: null },
        },
      },
    });
    expect(customized.providerId).toBe('realtime_elevenlabs');
  });

  it('does not expose legacy adapters on canonical parse results while preserving legacy boundary migration', () => {
    const canonical = voiceSettingsParse({ providerId: 'realtime_elevenlabs' });

    expect('adapters' in canonical).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(canonical, 'adapters')).toBe(false);
    expect(voiceSettingsParse(canonical).providerId).toBe('realtime_elevenlabs');

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
    expect(JSON.stringify(parsed.providers.realtime_elevenlabs.config)).not.toContain('assistantLanguage');
  });

  it('migrates the legacy assistant language only when the canonical root field is absent', () => {
    expect(voiceSettingsParse({
      adapters: {
        realtime_elevenlabs: { assistantLanguage: 'fr' },
      },
    }).assistantLanguage).toBe('fr');

    expect(voiceSettingsParse({
      assistantLanguage: null,
      adapters: {
        realtime_elevenlabs: { assistantLanguage: 'fr' },
      },
    }).assistantLanguage).toBe(null);
  });

  it('preserves valid unknown provider envelopes without selecting or interpreting them', () => {
    const unknown = {
      schemaVersion: 7,
      config: { nested: ['value', 3, true, null], future: { flag: 'kept' } },
    };
    const parsed = voiceSettingsParse({
      providerId: 'future_vendor',
      providers: { future_vendor: unknown },
    });

    expect(parsed.providerId).toBe('future_vendor');
    expect(parsed.providers.future_vendor).toEqual(unknown);
    expect(JSON.parse(JSON.stringify(parsed)).providers.future_vendor).toEqual(unknown);
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
    expect(parsed.providers.realtime_elevenlabs.config).toMatchObject({ billingMode: 'byo' });
    expect(parsed.providers.realtime_elevenlabs.config).not.toHaveProperty('assistantLanguage');
    expect(parsed.providers.realtime_elevenlabs.config).not.toHaveProperty('welcome');
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
    expect(parsed.providers.realtime_elevenlabs).toEqual({
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
    expect(parsed.providers.realtime_elevenlabs.config).toMatchObject({
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
    const parsed = voiceSettingsParse({
      providers: {
        future_vendor: { schemaVersion: 4, config: { preserved: true } },
      },
      adapters: {
        local_direct: { networkTimeoutMs: 32_000 },
      },
    });

    expect(parsed.providers.future_vendor).toEqual({ schemaVersion: 4, config: { preserved: true } });
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

    expect(parsed.providerId).toBe('realtime_elevenlabs');
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
    const config = { nested: { value: 'before' } };
    const parsed = voiceSettingsParse({
      providers: { future_vendor: { schemaVersion: 7, config } },
    });

    config.nested.value = 'after';

    expect(parsed.providers.future_vendor).toEqual({
      schemaVersion: 7,
      config: { nested: { value: 'before' } },
    });
  });

  it('drops malformed or oversized provider envelopes while preserving neighboring valid entries', () => {
    const parsed = voiceSettingsParse({
      providers: {
        malformed: { schemaVersion: 0, config: { nope: true } },
        oversized: { schemaVersion: 1, config: { value: 'x'.repeat(70_000) } },
        valid_unknown: { schemaVersion: 1, config: { kept: true } },
      },
    });

    expect(parsed.providers.malformed).toBeUndefined();
    expect(parsed.providers.oversized).toBeUndefined();
    expect(parsed.providers.valid_unknown).toEqual({ schemaVersion: 1, config: { kept: true } });
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
    const elevenLabs = readVoiceProviderSettingsConfig(voiceSettingsDefaults, 'realtime_elevenlabs') as any;
    expect(elevenLabs?.tts?.voiceId).toBeTypeOf('string');
    expect(String(elevenLabs?.tts?.voiceId)).toBe('EST9Ui6982FZPSi7gCHi');
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
    expect(tts?.provider).toBe('openai_compat');
    expect(tts?.openaiCompat?.model).toBe('tts-1');
    expect(tts?.openaiCompat?.voice).toBe('alloy');
    expect(tts?.openaiCompat?.format).toBe('mp3');
    expect(tts?.localNeural?.model).toBe('kokoro');
    expect(tts?.localNeural?.assetId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
    expect(tts?.localNeural?.execution).toBe('auto');
  });

  it('defaults include local STT provider selection', () => {
    const stt = readLocalDirectVoiceSettings(voiceSettingsDefaults).stt;
    expect(stt?.provider).toBe('openai_compat');
    expect(stt?.openaiCompat?.model).toBe('whisper-1');
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

  it('migrates legacy local TTS settings into provider format', () => {
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

    expect(readLocalDirectVoiceSettings(parsed).tts.provider).toBe('openai_compat');
    expect(readLocalDirectVoiceSettings(parsed).tts.openaiCompat.baseUrl).toBe('http://localhost:1234');
  });

  it('migrates legacy local STT settings into provider format', () => {
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

    expect(readLocalDirectVoiceSettings(parsed).stt.provider).toBe('openai_compat');
    expect(readLocalDirectVoiceSettings(parsed).stt.openaiCompat.baseUrl).toBe('http://localhost:1234');
  });

  it('migrates partial legacy local-conversation settings without dropping valid network fields', () => {
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
            backend: 'daemon',
            agentSource: 'session',
            agentId: 'claude',
            permissionPolicy: 'read_only',
            idleTtlSeconds: 300,
            chatModelSource: 'custom',
            chatModelId: 'default',
            commitModelSource: 'chat',
            commitModelId: 'default',
            openaiCompat: {
              chatBaseUrl: null,
              chatApiKey: null,
              chatModel: 'default',
              commitModel: 'default',
              temperature: 0.4,
              maxTokens: null,
            },
            verbosity: 'short',
          },
          streaming: { enabled: false, ttsEnabled: false, ttsChunkChars: 200 },
        },
      },
    });

    expect((parsed.providers.local_conversation.config as any).stt.openaiCompat.baseUrl).toBe('http://localhost:8000');
    expect((parsed.providers.local_conversation.config as any).streaming.enabled).toBe(false);
  });

  it('preserves non-positive OpenAI-compatible max tokens as inert JSON and fails runtime reading closed', () => {
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

    expect((parsed.providers.local_conversation.config as any).agent.openaiCompat.maxTokens).toBe(-9);
    expect(readLocalConversationVoiceSettings(parsed).agent.openaiCompat.maxTokens).toBeNull();
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

    expect(readLocalDirectVoiceSettings(parsed).tts.provider).toBe('google_cloud');
    expect(readLocalDirectVoiceSettings(parsed).tts.providers?.google_cloud).toEqual({
      schemaVersion: 1,
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
