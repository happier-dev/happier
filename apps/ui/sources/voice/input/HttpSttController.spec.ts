import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default ?? spec.web },
  });
});

vi.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
}));

function openAiCompatSettings(model = 'whisper-1') {
  return {
    voice: {
      providerId: 'local_conversation',
      providers: {
        local_conversation: { schemaVersion: 1, config: {
          stt: {
            openaiCompat: {
              baseUrl: 'https://example.com/v1',
              insecureLocalOriginConsent: 'http://localhost:8002',
              insecureLocalConsentMachineId: 'machine-a',
              apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'legacy-only' } },
              model,
            },
          },
          networkTimeoutMs: 10_000,
        } },
      },
    },
  };
}

describe('transcribeRecordedAudioWithHttpStt', () => {
  it('routes the normalized model and native media source through the daemon without decrypting legacy keys', async () => {
    const transcribe = vi.fn(async () => 'hello daemon stt');
    const { transcribeRecordedAudioWithHttpStt } = await import('./HttpSttController');

    const text = await transcribeRecordedAudioWithHttpStt({
      uri: 'file:///rec.m4a',
      settings: openAiCompatSettings(' whisper-1 '),
      client: { transcribe } as any,
    });

    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://example.com/v1',
      insecureLocalOriginConsent: 'http://localhost:8002',
      insecureLocalConsentMachineId: 'machine-a',
      credentialKind: 'stt_api_key',
      model: 'whisper-1',
      source: { kind: 'native', uri: 'file:///rec.m4a' },
      mimeType: 'audio/mp4',
    }));
    expect(text).toBe('hello daemon stt');
  });

  it('returns null without issuing a daemon request when already aborted', async () => {
    const transcribe = vi.fn(async () => 'unexpected');
    const aborted = new AbortController();
    aborted.abort();
    const { transcribeRecordedAudioWithHttpStt } = await import('./HttpSttController');
    await expect(transcribeRecordedAudioWithHttpStt({
      uri: 'file:///rec.m4a',
      settings: openAiCompatSettings(),
      signal: aborted.signal,
      client: { transcribe } as any,
    })).resolves.toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('threads cancellation through the selected-daemon operation and treats caller abort as graceful', async () => {
    const controller = new AbortController();
    const transcribe = vi.fn(async (input: { signal?: AbortSignal }) => {
      expect(input.signal).toBe(controller.signal);
      controller.abort();
      throw new Error('cancelled');
    });
    const { transcribeRecordedAudioWithHttpStt } = await import('./HttpSttController');
    await expect(transcribeRecordedAudioWithHttpStt({
      uri: 'file:///rec.m4a',
      settings: openAiCompatSettings(),
      signal: controller.signal,
      client: { transcribe } as any,
    })).resolves.toBeNull();
  });
});
