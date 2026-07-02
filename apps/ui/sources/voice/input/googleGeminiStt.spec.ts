import { describe, expect, it, vi } from 'vitest';

const fileBase64Spy = vi.fn<() => Promise<string>>().mockResolvedValue('BASE64_AUDIO');
vi.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    base64 = fileBase64Spy;
  },
  readAsStringAsync: () => {
    throw new Error('deprecated_readAsStringAsync_called');
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
