import { describe, expect, it, vi } from 'vitest';

const readAsStringAsyncSpy = vi.fn<(...args: any[]) => Promise<string>>().mockResolvedValue('BASE64_AUDIO');
vi.mock('expo-file-system', () => ({
  readAsStringAsync: (...args: any[]) => readAsStringAsyncSpy(...args),
  EncodingType: { Base64: 'base64' },
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

    expect(readAsStringAsyncSpy).toHaveBeenCalled();
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
