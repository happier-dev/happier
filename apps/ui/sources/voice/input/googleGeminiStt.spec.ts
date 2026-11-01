import { afterEach, describe, expect, it, vi } from 'vitest';

const fileBase64Spy = vi.fn<() => Promise<string>>().mockResolvedValue('BASE64_AUDIO');
vi.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    base64 = fileBase64Spy;
  },
}));

describe('transcribeWithGoogleGeminiStt', () => {
  it('uploads audio and returns a transcript', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hello world' }] } }],
      }),
    });
    (globalThis as any).fetch = fetchSpy;

    const { transcribeWithGoogleGeminiStt } = await import('./googleGeminiStt');
    const text = await transcribeWithGoogleGeminiStt({
      apiKey: 'k',
      model: 'gemini-2.0-flash-lite',
      audio: { kind: 'native', uri: 'file:///rec.m4a', mimeType: 'audio/mp4' },
      language: 'en',
      timeoutMs: 15_000,
    });

    expect(fileBase64Spy).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(text).toBe('hello world');
  });

  it('accepts model ids that include the "models/" prefix', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      }),
    });
    (globalThis as any).fetch = fetchSpy;

    const { transcribeWithGoogleGeminiStt } = await import('./googleGeminiStt');
    await transcribeWithGoogleGeminiStt({
      apiKey: 'k',
      model: 'models/gemini-2.0-flash-lite',
      audio: { kind: 'native', uri: 'file:///rec.m4a', mimeType: 'audio/mp4' },
      timeoutMs: 15_000,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/v1beta/models/gemini-2.0-flash-lite:generateContent'),
      expect.anything(),
    );
  });
});

describe('transcribeWithGoogleGeminiStt request contract', () => {
  function okFetch() {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    });
    (globalThis as any).fetch = fetchSpy;
    return fetchSpy;
  }

  function sentBody(fetchSpy: ReturnType<typeof vi.fn>): any {
    return JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'));
  }

  it.each([
    ['audio/mp4', 'audio/m4a'],
    ['audio/x-m4a', 'audio/m4a'],
    ['audio/webm;codecs=opus', 'audio/webm'],
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    ['audio/wav', 'audio/wav'],
  ])('sends %s audio as the documented Gemini MIME type %s', async (input, expected) => {
    const fetchSpy = okFetch();
    const { transcribeWithGoogleGeminiStt } = await import('./googleGeminiStt');
    await transcribeWithGoogleGeminiStt({
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      audio: { kind: 'native', uri: 'file:///rec.bin', mimeType: input },
      timeoutMs: 15_000,
    });

    expect(sentBody(fetchSpy).contents[0].parts[1].inline_data.mime_type).toBe(expected);
  });

  it('disables thinking for Gemini 2.5 Flash transcription', async () => {
    const fetchSpy = okFetch();
    const { transcribeWithGoogleGeminiStt } = await import('./googleGeminiStt');
    await transcribeWithGoogleGeminiStt({
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      audio: { kind: 'native', uri: 'file:///rec.m4a', mimeType: 'audio/m4a' },
      timeoutMs: 15_000,
    });

    expect(sentBody(fetchSpy).generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
  });

  it.each(['gemini-2.5-flash-lite', 'gemini-2.5-flash-preview-09-2025', 'gemini-2.5-flash-lite-preview-06-17'])(
    'disables thinking for the transcription-capable Flash variant %s',
    async (model) => {
      const fetchSpy = okFetch();
      const { transcribeWithGoogleGeminiStt } = await import('./googleGeminiStt');
      await transcribeWithGoogleGeminiStt({
        apiKey: 'k',
        model,
        audio: { kind: 'native', uri: 'file:///rec.m4a', mimeType: 'audio/m4a' },
        timeoutMs: 15_000,
      });

      expect(sentBody(fetchSpy).generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    },
  );

  it.each(['gemini-2.5-pro', 'gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-native-audio-preview-09-2025', 'gemini-2.5-flash-live-preview'])(
    'leaves thinking at the model default for %s',
    async (model) => {
      const fetchSpy = okFetch();
      const { transcribeWithGoogleGeminiStt } = await import('./googleGeminiStt');
      await transcribeWithGoogleGeminiStt({
        apiKey: 'k',
        model,
        audio: { kind: 'native', uri: 'file:///rec.m4a', mimeType: 'audio/m4a' },
        timeoutMs: 15_000,
      });

      expect(sentBody(fetchSpy).generationConfig).toBeUndefined();
    },
  );

  it('leaves thinking at the model default where it cannot be disabled', async () => {
    const fetchSpy = okFetch();
    const { transcribeWithGoogleGeminiStt } = await import('./googleGeminiStt');
    await transcribeWithGoogleGeminiStt({
      apiKey: 'k',
      model: 'gemini-2.5-pro',
      audio: { kind: 'native', uri: 'file:///rec.m4a', mimeType: 'audio/m4a' },
      timeoutMs: 15_000,
    });

    expect(sentBody(fetchSpy).generationConfig).toBeUndefined();
  });

  it.each([
    [400, { error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 'stt_auth_failed'],
    [403, { error: { status: 'PERMISSION_DENIED' } }, 'stt_auth_failed'],
    [429, { error: { status: 'RESOURCE_EXHAUSTED' } }, 'stt_rate_limited'],
    [400, { error: { status: 'INVALID_ARGUMENT' } }, 'stt_failed'],
  ])('classifies HTTP %i responses for the user', async (status, body, code) => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    const { transcribeWithGoogleGeminiStt } = await import('./googleGeminiStt');

    await expect(
      transcribeWithGoogleGeminiStt({
        apiKey: 'k',
        model: 'gemini-2.5-flash',
        audio: { kind: 'native', uri: 'file:///rec.m4a', mimeType: 'audio/m4a' },
        timeoutMs: 15_000,
      }),
    ).rejects.toMatchObject({ code, status });
  });
});

describe('transcribeWithGoogleGeminiStt API key restrictions', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('expo-application');
    vi.doUnmock('react-native');
  });

  it('sends Android app restriction headers so restricted keys work', async () => {
    vi.resetModules();
    vi.doMock('expo-application', () => ({ applicationId: 'dev.happier.app' }));
    vi.doMock('react-native', async () => {
      const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
      return createReactNativeWebMock({ Platform: { OS: 'android' } });
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    });
    (globalThis as any).fetch = fetchSpy;

    const { transcribeWithGoogleGeminiStt } = await import('./googleGeminiStt');
    await transcribeWithGoogleGeminiStt({
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      audio: { kind: 'native', uri: 'file:///rec.m4a', mimeType: 'audio/m4a' },
      androidCertSha1: 'aa:bb',
      timeoutMs: 15_000,
    });

    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-goog-api-key': 'k',
      'X-Android-Package': 'dev.happier.app',
      'X-Android-Cert': 'AA:BB',
    });
  });
});
