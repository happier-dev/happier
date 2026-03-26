import { afterEach, describe, expect, it } from 'vitest';
import { fetchOpenAiCompatSpeechAudio } from './fetchOpenAiCompatSpeechAudio';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

describe('fetchOpenAiCompatSpeechAudio', () => {
  afterEach(() => {
    resetRuntimeFetch();
  });

  it('posts to /v1/audio/speech with OpenAI-compatible fields and optional bearer auth', async () => {
    setRuntimeFetch(async (input, init) => {
      expect(String(input)).toBe('http://example.invalid/v1/audio/speech');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe('Bearer secret');
      expect(String(headers?.['Content-Type'] ?? '')).toContain('application/json');

      const json = JSON.parse(String(init?.body ?? ''));
      expect(json).toEqual({
        model: 'tts-1',
        input: 'hello',
        voice: 'alloy',
        response_format: 'wav',
      });

      return new Response(Buffer.from('ok'), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    });

    const audio = await fetchOpenAiCompatSpeechAudio({
      baseUrl: 'http://example.invalid', // intentionally no /v1 suffix
      apiKey: 'secret',
      model: 'tts-1',
      voice: 'alloy',
      format: 'wav',
      input: 'hello',
    });

    expect(audio.byteLength).toBeGreaterThan(0);
  });

  it('throws a stable error code when the endpoint fails', async () => {
    setRuntimeFetch(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));

    await expect(
      fetchOpenAiCompatSpeechAudio({
        baseUrl: 'http://example.invalid',
        apiKey: null,
        model: 'tts-1',
        voice: 'alloy',
        format: 'wav',
        input: 'hello',
      }),
    ).rejects.toThrow('tts_failed');
  });

  it('aborts and throws timeout error when request exceeds timeoutMs', async () => {
    setRuntimeFetch((_: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    });

    await expect(
      fetchOpenAiCompatSpeechAudio({
        baseUrl: 'http://example.invalid',
        apiKey: null,
        model: 'tts-1',
        voice: 'alloy',
        format: 'wav',
        input: 'hello',
        timeoutMs: 5,
      }),
    ).rejects.toThrow('tts_timeout');
  });
});
