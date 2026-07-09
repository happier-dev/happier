import { afterEach, describe, expect, it, vi } from 'vitest';

type FetchWithTimeoutArgs = [
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  timeoutErrorCode: string,
  externalSignal?: AbortSignal,
];

const fetchWithTimeout = vi.fn<(...args: FetchWithTimeoutArgs) => Promise<{ ok: boolean; json: () => Promise<{ text: string }> }>>(
  async () => ({
    ok: true,
    json: async () => ({ text: 'hello http stt' }),
  }),
);

vi.mock('@/voice/runtime/fetchWithTimeout', () => ({
  fetchWithTimeout: (...args: FetchWithTimeoutArgs) => fetchWithTimeout(...args),
  resolveVoiceNetworkTimeoutMs: (_value: unknown, fallback: number) => fallback,
}));

vi.mock('@/sync/sync', () => ({
  sync: { decryptSecretValue: () => 'api-key' },
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default ?? spec.web },
  });
});

vi.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
}));

function openAiCompatSettings() {
  return {
    voice: {
      providerId: 'local_conversation',
      adapters: {
        local_conversation: {
          stt: {
            openaiCompat: {
              baseUrl: 'https://example.com',
              apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } },
              model: 'whisper-1',
            },
          },
          networkTimeoutMs: 10_000,
        },
      },
    },
  };
}

describe('transcribeRecordedAudioWithHttpStt', () => {
  afterEach(() => {
    fetchWithTimeout.mockClear();
  });

  it('trims the OpenAI-compatible model before building the transcription request', async () => {
    const { transcribeRecordedAudioWithHttpStt } = await import('./HttpSttController');

    const text = await transcribeRecordedAudioWithHttpStt({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_conversation',
          adapters: {
            local_conversation: {
              stt: {
                openaiCompat: {
                  baseUrl: 'https://example.com',
                  apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } },
                  model: ' whisper-1 ',
                },
              },
              networkTimeoutMs: 10_000,
            },
          },
        },
      },
    });

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const call = fetchWithTimeout.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(init).toBeDefined();
    if (!init) {
      throw new Error('expected request init to be defined');
    }
    const body = init.body as FormData;
    expect(body.get('model')).toBe('whisper-1');
    expect(text).toBe('hello http stt');
  });

  it('returns null without issuing a request when the abort signal is already aborted', async () => {
    const { transcribeRecordedAudioWithHttpStt } = await import('./HttpSttController');
    const aborted = new AbortController();
    aborted.abort();

    const text = await transcribeRecordedAudioWithHttpStt({
      uri: 'file:///rec.m4a',
      settings: openAiCompatSettings(),
      signal: aborted.signal,
    });

    expect(text).toBeNull();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('threads the abort signal through to the network fetch so in-flight work can be cancelled', async () => {
    const { transcribeRecordedAudioWithHttpStt } = await import('./HttpSttController');
    const controller = new AbortController();

    await transcribeRecordedAudioWithHttpStt({
      uri: 'file:///rec.m4a',
      settings: openAiCompatSettings(),
      signal: controller.signal,
    });

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const call = fetchWithTimeout.mock.calls[0];
    expect(call).toBeDefined();
    expect(call![4]).toBe(controller.signal);
  });

  it('returns null gracefully when the in-flight request is aborted', async () => {
    const { transcribeRecordedAudioWithHttpStt } = await import('./HttpSttController');
    const controller = new AbortController();
    fetchWithTimeout.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('aborted');
    });

    const text = await transcribeRecordedAudioWithHttpStt({
      uri: 'file:///rec.m4a',
      settings: openAiCompatSettings(),
      signal: controller.signal,
    });

    expect(text).toBeNull();
  });
});
