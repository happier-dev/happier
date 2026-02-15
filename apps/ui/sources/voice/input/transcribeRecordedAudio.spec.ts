import { describe, expect, it, vi } from 'vitest';

const readAsStringAsyncSpy = vi.fn<(...args: any[]) => Promise<string>>().mockResolvedValue('BASE64_AUDIO');
vi.mock('expo-file-system', () => ({
  readAsStringAsync: (...args: any[]) => readAsStringAsyncSpy(...args),
  EncodingType: { Base64: 'base64' },
}));

describe('transcribeRecordedAudioWithProvider', () => {
  it('routes google_gemini STT to the Gemini API', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hello gemini' }] } }],
      }),
    });
    (globalThis as any).fetch = fetchSpy;

    const { transcribeRecordedAudioWithProvider } = await import('./transcribeRecordedAudioWithProvider');

    const text = await transcribeRecordedAudioWithProvider({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'google_gemini',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } }, model: 'gemini-2.5-flash', language: 'en' },
              },
              networkTimeoutMs: 15000,
            },
          },
        },
      },
      decryptSecretValue: () => 'gemini-key',
    });

    expect(readAsStringAsyncSpy).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('generativelanguage.googleapis.com'), expect.anything());
    expect(text).toBe('hello gemini');
  });

  it('treats local_neural STT as non-file-based on web and returns null', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;

    const { transcribeRecordedAudioWithProvider } = await import('./transcribeRecordedAudioWithProvider');

    const text = await transcribeRecordedAudioWithProvider({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en' },
              },
              networkTimeoutMs: 15000,
            },
          },
        },
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(text).toBeNull();
  });
});
