import { describe, expect, it } from 'vitest';

import { buildOpenAiSpeechRequest, buildOpenAiTranscriptionRequest, normalizeOpenAiCompatibleBaseUrl } from './openaiCompat';

describe('local voice OpenAI-compatible helpers', () => {
  it('normalizes base URLs to include /v1', () => {
    expect(normalizeOpenAiCompatibleBaseUrl('http://localhost:8000')).toBe('http://localhost:8000/v1');
    expect(normalizeOpenAiCompatibleBaseUrl('http://localhost:8000/')).toBe('http://localhost:8000/v1');
    expect(normalizeOpenAiCompatibleBaseUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1');
    expect(normalizeOpenAiCompatibleBaseUrl('http://localhost:8000/v1/')).toBe('http://localhost:8000/v1');
    expect(normalizeOpenAiCompatibleBaseUrl(' https://api.example.com/custom/ ')).toBe('https://api.example.com/custom/v1');
  });

  it('builds a TTS request with optional Authorization header', () => {
    const withKey = buildOpenAiSpeechRequest({
      baseUrl: 'http://localhost:8000',
      apiKey: 'sk-test',
      model: 'tts-1',
      voice: 'alloy',
      responseFormat: 'mp3',
      input: 'hello',
    });
    expect(withKey.url).toBe('http://localhost:8000/v1/audio/speech');
    expect((withKey.init.headers as any).Authorization).toBe('Bearer sk-test');

    const withoutKey = buildOpenAiSpeechRequest({
      baseUrl: 'http://localhost:8000/v1',
      apiKey: null,
      model: 'tts-1',
      voice: 'alloy',
      responseFormat: 'mp3',
      input: 'hello',
    });
    expect((withoutKey.init.headers as any).Authorization).toBeUndefined();
  });

  it('builds an STT request to /audio/transcriptions', () => {
    const req = buildOpenAiTranscriptionRequest({
      baseUrl: 'http://localhost:8000',
      apiKey: 'sk-test',
      model: 'whisper-1',
      file: { kind: 'native', uri: 'file:///tmp/rec.m4a', name: 'rec.m4a', mimeType: 'audio/mp4' },
    });
    expect(req.url).toBe('http://localhost:8000/v1/audio/transcriptions');
    expect(req.init.method).toBe('POST');
    expect((req.init.headers as any).Authorization).toBe('Bearer sk-test');
    expect(req.init.body).toBeInstanceOf(FormData);
  });

  it('adds language field only when provided for STT requests', () => {
    const withLanguage = buildOpenAiTranscriptionRequest({
      baseUrl: 'http://localhost:8000',
      apiKey: null,
      model: 'whisper-1',
      language: 'en',
      file: { kind: 'native', uri: 'file:///tmp/rec.m4a', name: 'rec.m4a', mimeType: 'audio/mp4' },
    });

    const withoutLanguage = buildOpenAiTranscriptionRequest({
      baseUrl: 'http://localhost:8000',
      apiKey: null,
      model: 'whisper-1',
      language: null,
      file: { kind: 'native', uri: 'file:///tmp/rec.m4a', name: 'rec.m4a', mimeType: 'audio/mp4' },
    });

    expect(withLanguage.init.body).toBeInstanceOf(FormData);
    expect(withoutLanguage.init.body).toBeInstanceOf(FormData);

    const withLanguageBody = withLanguage.init.body as FormData;
    const withoutLanguageBody = withoutLanguage.init.body as FormData;

    expect(withLanguageBody.get('language')).toBe('en');
    expect(withoutLanguageBody.get('language')).toBeNull();
  });

  it('throws when baseUrl is empty', () => {
    expect(() =>
      buildOpenAiSpeechRequest({
        baseUrl: '',
        apiKey: null,
        model: 'tts-1',
        voice: 'alloy',
        responseFormat: 'mp3',
        input: 'hello',
      })
    ).toThrow('Invalid base URL');

    expect(() =>
      buildOpenAiTranscriptionRequest({
        baseUrl: '   ',
        apiKey: null,
        model: 'whisper-1',
        file: { kind: 'native', uri: 'file:///tmp/rec.m4a', name: 'rec.m4a', mimeType: 'audio/mp4' },
      })
    ).toThrow('Invalid base URL');
  });
});
