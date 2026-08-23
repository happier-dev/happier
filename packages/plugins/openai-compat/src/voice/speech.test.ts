import { describe, expect, it, vi } from 'vitest';
import type { VoiceSpeechOperationContext } from '@happier-dev/plugin-sdk/voice/speech';

import {
  createOpenAiCompatSttRuntime,
  createOpenAiCompatTtsRuntime,
} from './speech.js';
import {
  OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY,
  OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY,
} from '../speechIdentity.js';

type HttpRequest = Readonly<{
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  redirect: 'error' | 'follow' | 'manual';
  timeoutMs?: number;
}>;

function response(input: Readonly<{
  status?: number;
  headers?: Readonly<Record<string, string>>;
  body: Uint8Array | string;
}>) {
  return Object.freeze({
    status: input.status ?? 200,
    finalUrl: 'https://speech.example.test/v1/result',
    headers: Object.freeze({ ...(input.headers ?? {}) }),
    body: typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body,
  });
}

function context(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  request: (input: HttpRequest, options?: Readonly<{ signal?: AbortSignal }>) => Promise<ReturnType<typeof response>>;
  secret?: string | null;
  signal?: AbortSignal;
}>): VoiceSpeechOperationContext {
  const materialize = params.secret === undefined
    ? null
    : vi.fn(async (request: Readonly<{ kind: string; keys?: readonly string[] }>) => {
      if (request.kind !== 'environment') throw new Error('unexpected materialization request');
      return {
        kind: 'environment' as const,
        env: params.secret === null || !request.keys?.[0]
          ? {}
          : { [request.keys[0]]: params.secret },
      };
    });
  return {
    settings: params.settings,
    http: { request: params.request },
    credentials: {
      phase: 'speech',
      mediated: null,
      raw: materialize ? { materialize } : null,
    },
    signal: params.signal ?? new AbortController().signal,
  } as VoiceSpeechOperationContext;
}

const STT_REQUEST = Object.freeze({
  requestId: 'stt-request',
  model: 'whisper-custom',
  language: 'de',
  mimeType: 'audio/wav' as const,
  bytes: new Uint8Array([1, 2, 3]),
});

const TTS_REQUEST = Object.freeze({
  requestId: 'tts-request',
  input: 'Hallo Welt',
  model: 'tts-custom',
  voiceName: 'verse',
  languageCode: null,
  format: 'wav' as const,
  speakingRate: 1.2,
  pitch: null,
});

describe('OpenAI-compatible public batch speech runtimes', () => {
  it('uses the fresh invocation settings, bounded host HTTP service, and exact STT credential grant', async () => {
    const request = vi.fn(async (input: HttpRequest, options?: Readonly<{ signal?: AbortSignal }>) => {
      expect(input.url).toBe('https://stt.example.test/v1/audio/transcriptions');
      expect(input.method).toBe('POST');
      expect(input.redirect).toBe('error');
      expect(input.headers?.authorization).toBe('Bearer stt-secret');
      expect(input.headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/u);
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const body = new TextDecoder().decode(input.body);
      expect(body).toContain('name="model"');
      expect(body).toContain('whisper-custom');
      expect(body).toContain('name="language"');
      expect(body).toContain('de');
      expect(body).toContain('filename="speech.wav"');
      return response({
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text: ' gehoert ' }),
      });
    });
    const operationContext = context({
      settings: Object.freeze({ baseUrl: 'https://stt.example.test/v1' }),
      request,
      secret: 'stt-secret',
    });

    await expect(createOpenAiCompatSttRuntime().transcribe!(
      STT_REQUEST,
      operationContext,
    )).resolves.toEqual({ requestId: 'stt-request', text: ' gehoert ' });

    expect(operationContext.credentials.raw?.materialize).toHaveBeenCalledWith(
      {
        kind: 'environment',
        keys: [OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY],
      },
      { signal: operationContext.signal },
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('forwards the public TTS model, voice, format, and speaking rate through fresh TTS settings', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const request = vi.fn(async (input: HttpRequest) => {
      expect(input.url).toBe('https://tts.example.test/custom/audio/speech');
      expect(input.headers).toEqual({
        authorization: 'Bearer tts-secret',
        'content-type': 'application/json',
      });
      expect(JSON.parse(new TextDecoder().decode(input.body))).toEqual({
        model: 'tts-custom',
        voice: 'verse',
        input: 'Hallo Welt',
        response_format: 'wav',
        speed: 1.2,
      });
      return response({ headers: { 'content-type': 'audio/wav' }, body: bytes });
    });
    const operationContext = context({
      settings: Object.freeze({ baseUrl: 'https://tts.example.test/custom/' }),
      request,
      secret: 'tts-secret',
    });

    const result = await createOpenAiCompatTtsRuntime().synthesize!(TTS_REQUEST, operationContext);

    expect(result).toEqual({ requestId: 'tts-request', bytes, mimeType: 'audio/wav' });
    expect(result.bytes).not.toBe(bytes);
    expect(operationContext.credentials.raw?.materialize).toHaveBeenCalledWith(
      {
        kind: 'environment',
        keys: [OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY],
      },
      { signal: operationContext.signal },
    );
  });

  it('does not capture settings at activation and supports credential-less compatible endpoints', async () => {
    const urls: string[] = [];
    const runtime = createOpenAiCompatSttRuntime();
    const request = vi.fn(async (input: HttpRequest) => {
      urls.push(input.url);
      expect(input.headers).not.toHaveProperty('authorization');
      return response({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'ok' }),
      });
    });

    await runtime.transcribe!(STT_REQUEST, context({
      settings: Object.freeze({ baseUrl: 'https://first.example.test/v1' }),
      request,
    }));
    await runtime.transcribe!(STT_REQUEST, context({
      settings: Object.freeze({ baseUrl: 'https://second.example.test/v2' }),
      request,
    }));

    expect(urls).toEqual([
      'https://first.example.test/v1/audio/transcriptions',
      'https://second.example.test/v2/audio/transcriptions',
    ]);
  });

  it('fails closed before HTTP for missing endpoint settings or incomplete selected credentials', async () => {
    const request = vi.fn();
    const runtime = createOpenAiCompatSttRuntime();

    await expect(runtime.transcribe!(STT_REQUEST, context({
      settings: Object.freeze({ baseUrl: '   ' }),
      request,
    }))).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(runtime.transcribe!(STT_REQUEST, context({
      settings: Object.freeze({ baseUrl: 'https://stt.example.test/v1' }),
      request,
      secret: null,
    }))).rejects.toMatchObject({ code: 'credential_unavailable' });
    await expect(runtime.transcribe!(STT_REQUEST, context({
      settings: Object.freeze({ baseUrl: 'https://stt.example.test/v1' }),
      request,
      secret: 'token\r\nX-Happier-Injection: true',
    }))).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('leaves insecure endpoint admission to the host HTTP service', async () => {
    const request = vi.fn(async () => response({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ok' }),
    }));
    const runtime = createOpenAiCompatSttRuntime();

    await expect(runtime.transcribe!(STT_REQUEST, context({
      settings: Object.freeze({ baseUrl: 'http://localhost:11434/v1' }),
      request,
    }))).resolves.toEqual({ requestId: 'stt-request', text: 'ok' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://localhost:11434/v1/audio/transcriptions',
    }), expect.anything());
  });

  it('rejects multipart field injection before contacting the provider', async () => {
    const request = vi.fn();
    const runtime = createOpenAiCompatSttRuntime();
    const operationContext = context({
      settings: Object.freeze({ baseUrl: 'https://stt.example.test/v1' }),
      request,
    });

    await expect(runtime.transcribe!({
      ...STT_REQUEST,
      model: 'whisper-1\r\nX-Happier-Injection: true',
    }, operationContext)).rejects.toMatchObject({ code: 'invalid_parameters' });
    await expect(runtime.transcribe!({
      ...STT_REQUEST,
      language: 'de\r\nX-Happier-Injection: true',
    }, operationContext)).rejects.toMatchObject({ code: 'invalid_parameters' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects redirects, mismatched media, malformed JSON, empty audio, and credential echoes', async () => {
    const stt = createOpenAiCompatSttRuntime();
    const tts = createOpenAiCompatTtsRuntime();
    const sttContext = (reply: ReturnType<typeof response>) => context({
      settings: Object.freeze({ baseUrl: 'https://speech.example.test/v1' }),
      request: vi.fn(async () => reply),
      secret: 'registered-secret',
    });

    await expect(stt.transcribe!(STT_REQUEST, sttContext(response({
      status: 307,
      body: '',
    })))).rejects.toMatchObject({ code: 'provider_response_invalid' });
    await expect(stt.transcribe!(STT_REQUEST, sttContext(response({
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ text: 'hello' }),
    })))).rejects.toMatchObject({ code: 'provider_response_invalid' });
    await expect(stt.transcribe!(STT_REQUEST, sttContext(response({
      headers: { 'content-type': 'application/json' },
      body: '{',
    })))).rejects.toMatchObject({ code: 'provider_response_invalid' });
    await expect(stt.transcribe!(STT_REQUEST, sttContext(response({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'registered-secret' }),
    })))).rejects.toMatchObject({ code: 'provider_response_invalid' });
    await expect(tts.synthesize!(TTS_REQUEST, sttContext(response({
      headers: { 'content-type': 'audio/mpeg' },
      body: new Uint8Array([1]),
    })))).rejects.toMatchObject({ code: 'provider_response_invalid' });
    await expect(tts.synthesize!(TTS_REQUEST, sttContext(response({
      headers: { 'content-type': 'audio/wav' },
      body: new Uint8Array(),
    })))).rejects.toMatchObject({ code: 'provider_response_invalid' });
    await expect(tts.synthesize!(TTS_REQUEST, sttContext(response({
      headers: { 'content-type': 'audio/wav' },
      body: new TextEncoder().encode('registered-secret'),
    })))).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('rejects a transcription body that is not valid UTF-8 instead of substituting replacement characters', async () => {
    const stt = createOpenAiCompatSttRuntime();
    // A lone 0x80 continuation byte cannot begin a UTF-8 sequence. A non-fatal
    // decode would silently turn it into U+FFFD and publish a corrupted
    // transcript as if the provider had returned it.
    const malformed = new Uint8Array([
      ...new TextEncoder().encode('{"text":"hallo '),
      0x80,
      ...new TextEncoder().encode(' welt"}'),
    ]);
    await expect(stt.transcribe!(STT_REQUEST, context({
      settings: Object.freeze({ baseUrl: 'https://speech.example.test/v1' }),
      request: vi.fn(async () => response({
        headers: { 'content-type': 'application/json' },
        body: malformed,
      })),
      secret: 'registered-secret',
    }))).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('labels each supported transcription container with its own filename extension', async () => {
    const stt = createOpenAiCompatSttRuntime();
    const filenameFor = async (mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/webm' | 'audio/ogg') => {
      let filename: string | null = null;
      await stt.transcribe!({ ...STT_REQUEST, mimeType }, context({
        settings: Object.freeze({ baseUrl: 'https://speech.example.test/v1' }),
        request: vi.fn(async (input: HttpRequest) => {
          filename = new TextDecoder().decode(input.body ?? new Uint8Array())
            .match(/filename="([^"]+)"/u)?.[1] ?? null;
          return response({
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'ok' }),
          });
        }),
        secret: 'registered-secret',
      }));
      return filename;
    };

    expect(await filenameFor('audio/wav')).toBe('speech.wav');
    expect(await filenameFor('audio/mpeg')).toBe('speech.mp3');
    expect(await filenameFor('audio/mp4')).toBe('speech.m4a');
    expect(await filenameFor('audio/webm')).toBe('speech.webm');
    expect(await filenameFor('audio/ogg')).toBe('speech.ogg');
  });

  it('passes the exact host cancellation signal through credential and HTTP boundaries', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_input: HttpRequest, options?: Readonly<{ signal?: AbortSignal }>) => {
      expect(options?.signal).toBe(controller.signal);
      return await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    });
    const operationContext = context({
      settings: Object.freeze({ baseUrl: 'https://stt.example.test/v1' }),
      request,
      secret: 'stt-secret',
      signal: controller.signal,
    });
    const pending = createOpenAiCompatSttRuntime().transcribe!(STT_REQUEST, operationContext);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    controller.abort(new Error('cancelled'));

    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(operationContext.credentials.raw?.materialize).toHaveBeenCalledWith(
      expect.any(Object),
      { signal: controller.signal },
    );
  });
});
