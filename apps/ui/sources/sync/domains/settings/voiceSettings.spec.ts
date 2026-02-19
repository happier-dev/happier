import { describe, expect, it } from 'vitest';

import { voiceSettingsDefaults, voiceSettingsParse } from './voiceSettings';

describe('voiceSettings', () => {
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
    expect((voiceSettingsDefaults as any).adapters?.realtime_elevenlabs?.tts?.voiceId).toBeTypeOf('string');
    expect(String((voiceSettingsDefaults as any).adapters?.realtime_elevenlabs?.tts?.voiceId)).toBe('EST9Ui6982FZPSi7gCHi');
    expect((voiceSettingsDefaults as any).adapters?.realtime_elevenlabs?.welcome?.enabled).toBe(false);
    expect((voiceSettingsDefaults as any).adapters?.realtime_elevenlabs?.welcome?.mode).toBe('immediate');
  });

  it('defaults include local voice agent transcript persistence settings', () => {
    const agent = (voiceSettingsDefaults as any).adapters?.local_conversation?.agent;
    expect(agent?.idleTtlSeconds).toBe(1800);
    expect(agent?.prewarmOnConnect).toBe(false);
    expect(agent?.resumabilityMode).toBe('replay');
    expect(agent?.providerResume?.fallbackToReplay).toBe(true);
    expect(agent?.replay?.strategy).toBe('recent_messages');
    expect(agent?.replay?.recentMessagesCount).toBeTypeOf('number');
    expect(agent?.welcome?.enabled).toBe(false);
    expect(agent?.welcome?.mode).toBe('immediate');
    expect(agent?.commitIsolation).toBe(false);
    expect(agent?.transcript?.persistenceMode).toBe('ephemeral');
    expect(agent?.transcript?.epoch).toBe(0);
  });

  it('defaults include local voice agent machine + directory policies', () => {
    const agent = (voiceSettingsDefaults as any).adapters?.local_conversation?.agent;
    expect(agent?.machineTargetMode).toBe('auto');
    expect(agent?.machineTargetId).toBe(null);
    expect(agent?.stayInVoiceHome).toBe(false);
    expect(agent?.teleportEnabled).toBe(true);
    expect(agent?.rootSessionPolicy).toBe('single');
    expect(agent?.maxWarmRoots).toBeTypeOf('number');
    expect(agent?.voiceHomeSubdirName).toBeTypeOf('string');
  });

  it('defaults include local TTS provider selection', () => {
    const tts = (voiceSettingsDefaults as any).adapters?.local_direct?.tts;
    expect(tts?.provider).toBe('openai_compat');
    expect(tts?.openaiCompat?.model).toBe('tts-1');
    expect(tts?.openaiCompat?.voice).toBe('alloy');
    expect(tts?.openaiCompat?.format).toBe('mp3');
    expect(tts?.localNeural?.model).toBe('kokoro');
    expect(tts?.localNeural?.assetId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
  });

  it('defaults include local STT provider selection', () => {
    const stt = (voiceSettingsDefaults as any).adapters?.local_direct?.stt;
    expect(stt?.provider).toBe('openai_compat');
    expect(stt?.openaiCompat?.model).toBe('whisper-1');
    expect(stt?.localNeural?.assetId).toBe('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
  });

  it('accepts local_neural as a local TTS provider (Kokoro model)', () => {
    const parsed = voiceSettingsParse({
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          tts: {
            provider: 'local_neural',
            openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
            localNeural: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart', speed: 1 },
            googleCloud: { apiKey: null, voiceName: null, languageCode: null, format: 'mp3' },
            autoSpeakReplies: true,
            bargeInEnabled: true,
          },
        },
      },
    });

    const tts = (parsed as any).adapters?.local_direct?.tts;
    expect(tts?.provider).toBe('local_neural');
    expect(tts?.localNeural?.model).toBe('kokoro');
    expect(tts?.localNeural?.assetId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
    expect(tts?.localNeural?.voiceId).toBe('af_heart');
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
            localNeural: { assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', language: 'en' },
          },
        },
      },
    });

    const stt = (parsed as any).adapters?.local_direct?.stt;
    expect(stt?.provider).toBe('local_neural');
    expect(stt?.localNeural?.assetId).toBe('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
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

    expect((parsed as any).adapters?.local_direct?.tts?.provider).toBe('openai_compat');
    expect((parsed as any).adapters?.local_direct?.tts?.openaiCompat?.baseUrl).toBe('http://localhost:1234');
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

    expect((parsed as any).adapters?.local_direct?.stt?.provider).toBe('openai_compat');
    expect((parsed as any).adapters?.local_direct?.stt?.openaiCompat?.baseUrl).toBe('http://localhost:1234');
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

    expect((parsed as any).adapters?.local_direct?.stt?.provider).toBe('device');
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

    expect((parsed as any).adapters?.local_direct?.tts?.provider).toBe('google_cloud');
    expect((parsed as any).adapters?.local_direct?.tts?.googleCloud?.voiceName).toBe('en-US-Wavenet-D');
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

    expect((parsed as any).adapters?.local_direct?.tts?.provider).toBe('device');
  });
});
