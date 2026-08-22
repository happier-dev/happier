import { describe, expect, it, vi } from 'vitest';
import { VoiceProviderCatalogItemSchema } from '@happier-dev/protocol';
import type { VoiceCredentialAccess } from '@happier-dev/plugin-sdk/voice';
import type { VoiceSpeechOperationContext } from '@happier-dev/plugin-sdk/voice/speech';

import {
  createGoogleCloudTtsRuntime,
  createGoogleGeminiSttRuntime,
} from './speech.js';
import { classifyGoogleCloudLegacyCredential } from '../protocol/voice/index.js';

function credentialContext(
  secret: string,
  onRequest?: (request: Readonly<{ kind: string; origin?: string; headerNames?: readonly string[] }>) => void,
  signal = new AbortController().signal,
  httpRequest: VoiceSpeechOperationContext['http']['request'] = async () => ({
    status: 200,
    finalUrl: 'https://example.test',
    headers: Object.freeze({}),
    body: new TextEncoder().encode('{}'),
  }),
): VoiceSpeechOperationContext {
  const credentials: VoiceCredentialAccess<'speech'> = {
    phase: 'speech',
    mediated: null,
    raw: {
      async materialize(request) {
        onRequest?.(request);
        if (request.kind !== 'httpHeaders') throw new Error('unexpected materialization kind');
        return { kind: 'httpHeaders', headers: { 'x-goog-api-key': secret } };
      },
    },
  };
  return {
    credentials,
    settings: Object.freeze({}),
    http: Object.freeze({ request: httpRequest }),
    signal,
  };
}

function jsonHttpResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = Object.freeze({ 'content-type': 'application/json' }),
) {
  return {
    status,
    finalUrl: 'https://provider.example.test',
    headers,
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

const transcribeRequest = Object.freeze({
  requestId: 'r1',
  model: 'gemini-2.5-flash',
  language: 'en',
  mimeType: 'audio/wav' as const,
  bytes: new Uint8Array([1, 2, 3]),
});

const synthesizeRequest = Object.freeze({
  requestId: 'r2',
  input: 'Hello',
  model: null,
  voiceName: 'en-US-Standard-A',
  languageCode: 'en-US',
  format: 'mp3' as const,
  speakingRate: null,
  pitch: null,
});

describe('Google daemon voice providers', () => {
  it('routes provider requests through the operation context HTTP service', async () => {
    const request = vi.fn(async () => jsonHttpResponse({ models: [] }));
    const signal = new AbortController().signal;
    const runtime = createGoogleGeminiSttRuntime();
    const context = credentialContext('google-secret', undefined, signal, request);

    await expect(runtime.catalog!.list({ catalog: 'models' }, context)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith({
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      method: 'GET',
      headers: { 'x-goog-api-key': 'google-secret' },
      redirect: 'error',
    }, { signal });
  });

  it('exposes separate operation-tight runtimes without cross-operation fallbacks', () => {
    const stt = createGoogleGeminiSttRuntime();
    const tts = createGoogleCloudTtsRuntime();
    expect(stt).toMatchObject({ kind: 'speech', transcribe: expect.any(Function) });
    expect(stt).not.toHaveProperty('synthesize');
    expect(tts).toMatchObject({ kind: 'speech', synthesize: expect.any(Function) });
    expect(tts).not.toHaveProperty('transcribe');
    expect(stt).not.toHaveProperty('catalogProviders');
    expect(tts).not.toHaveProperty('speechProviderIds');
    expect(stt).not.toHaveProperty('schemas');
  });

  it('rejects an oversized JSON body returned by the bounded host HTTP service', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: new Uint8Array(4 * 1024 * 1024 + 1),
    }));
    const runtime = createGoogleGeminiSttRuntime();

    await expect(runtime.catalog!.list(
      { catalog: 'models' },
      credentialContext('google-secret', undefined, undefined, request),
    )).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('rejects a successful provider response that is not valid UTF-8 JSON', async () => {
    const prefix = new TextEncoder().encode('{"models":[{"name":"models/gemini-');
    const suffix = new TextEncoder().encode('","supportedGenerationMethods":["generateContent"]}]}');
    const body = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    body.set(prefix);
    body[prefix.byteLength] = 0xff;
    body.set(suffix, prefix.byteLength + 1);
    const request = vi.fn(async () => ({
      status: 200,
      finalUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body,
    }));
    const runtime = createGoogleGeminiSttRuntime();

    await expect(runtime.catalog!.list(
      { catalog: 'models' },
      credentialContext('google-secret', undefined, undefined, request),
    )).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it.each([401, 403])(
    'maps provider HTTP %s to unavailable credentials',
    async (status) => {
      const request = vi.fn(async () => jsonHttpResponse({ error: 'denied' }, status));
      const runtime = createGoogleGeminiSttRuntime();

      await expect(runtime.catalog!.list(
        { catalog: 'models' },
        credentialContext('invalid-secret', undefined, undefined, request),
      )).rejects.toMatchObject({ code: 'credential_unavailable', message: 'credential_unavailable' });
    },
  );

  it('transcribes through Gemini with only the Gemini origin credential', async () => {
    const requestedOrigins: string[] = [];
    const httpRequest = vi.fn(async (input: Parameters<VoiceSpeechOperationContext['http']['request']>[0]) => {
      expect(input.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
      expect(input.headers?.['x-goog-api-key']).toBe('gemini-secret');
      expect(new TextDecoder().decode(input.body)).not.toContain('gemini-secret');
      return jsonHttpResponse({ candidates: [{ content: { parts: [{ text: 'hello world' }] } }] });
    });
    const runtime = createGoogleGeminiSttRuntime();
    await expect(runtime.transcribe!(
      transcribeRequest,
      credentialContext(
        'gemini-secret',
        (request) => requestedOrigins.push(request.origin ?? ''),
        undefined,
        httpRequest,
      ),
    )).resolves.toEqual({ requestId: 'r1', text: 'hello world' });
    expect(requestedOrigins).toEqual(['https://generativelanguage.googleapis.com']);
  });

  it('keeps Gemini inline audio within its declared request envelope', async () => {
    let sentBody: Uint8Array | null = null;
    const httpRequest = vi.fn(async (
      input: Parameters<VoiceSpeechOperationContext['http']['request']>[0],
    ) => {
      sentBody = input.body ?? null;
      return jsonHttpResponse({ candidates: [{ content: { parts: [{ text: 'bounded transcript' }] } }] });
    });
    const runtime = createGoogleGeminiSttRuntime();
    const context = credentialContext('gemini-secret', undefined, undefined, httpRequest);

    await expect(runtime.transcribe!({
      ...transcribeRequest,
      bytes: new Uint8Array(8 * 1024 * 1024),
    }, context)).resolves.toEqual({ requestId: 'r1', text: 'bounded transcript' });
    expect(sentBody?.byteLength).toBeLessThanOrEqual(20_000_000);

    await expect(runtime.transcribe!({
      ...transcribeRequest,
      bytes: new Uint8Array(8 * 1024 * 1024 + 1),
    }, context)).rejects.toMatchObject({ code: 'invalid_parameters' });
    expect(httpRequest).toHaveBeenCalledOnce();
  });

  it('rejects a successful provider response that echoes the source credential', async () => {
    const httpRequest = vi.fn(async () => jsonHttpResponse({
      candidates: [{ content: { parts: [{ text: 'google-secret' }] } }],
    }));
    const runtime = createGoogleGeminiSttRuntime();
    const result = runtime.transcribe!(
      transcribeRequest,
      credentialContext('google-secret', undefined, undefined, httpRequest),
    );
    await expect(result).rejects.toMatchObject({ code: 'provider_response_invalid' });
    await expect(result).rejects.not.toThrow('google-secret');
  });

  it('synthesizes bounded audio with only the Google Cloud origin credential', async () => {
    const requestedOrigins: string[] = [];
    const httpRequest = vi.fn(async (input: Parameters<VoiceSpeechOperationContext['http']['request']>[0]) => {
      expect(input.url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
      expect(input.headers?.['x-goog-api-key']).toBe('cloud-secret');
      return jsonHttpResponse({ audioContent: 'AQID' });
    });
    const runtime = createGoogleCloudTtsRuntime();
    const result = await runtime.synthesize!(
      synthesizeRequest,
      credentialContext(
        'cloud-secret',
        (request) => requestedOrigins.push(request.origin ?? ''),
        undefined,
        httpRequest,
      ),
    );
    expect(result).toMatchObject({ requestId: 'r2', mimeType: 'audio/mpeg' });
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
    expect(requestedOrigins).toEqual(['https://texttospeech.googleapis.com']);
  });

  it('enforces Google Cloud Text-to-Speech input as UTF-8 bytes', async () => {
    const largestAccepted = `${'\u0800'.repeat(1_666)}aa`;
    const firstRejected = `${largestAccepted}a`;
    expect(new TextEncoder().encode(largestAccepted).byteLength).toBe(5_000);
    expect(new TextEncoder().encode(firstRejected).byteLength).toBe(5_001);
    const httpRequest = vi.fn(async () => jsonHttpResponse({ audioContent: 'AQID' }));
    const runtime = createGoogleCloudTtsRuntime();
    const context = credentialContext('cloud-secret', undefined, undefined, httpRequest);

    await expect(runtime.synthesize!({
      ...synthesizeRequest,
      input: largestAccepted,
    }, context)).resolves.toMatchObject({ requestId: 'r2', bytes: new Uint8Array([1, 2, 3]) });
    await expect(runtime.synthesize!({
      ...synthesizeRequest,
      input: firstRejected,
    }, context)).rejects.toMatchObject({ code: 'invalid_parameters' });
    expect(httpRequest).toHaveBeenCalledOnce();
  });

  it('keeps decoded Google Cloud Text-to-Speech audio within the JSON/base64 envelope', async () => {
    const largestAccepted = Buffer.alloc(3_000_000).toString('base64');
    const firstRejected = Buffer.alloc(3_000_001).toString('base64');
    const httpRequest = vi.fn()
      .mockResolvedValueOnce(jsonHttpResponse({ audioContent: largestAccepted }))
      .mockResolvedValueOnce(jsonHttpResponse({ audioContent: firstRejected }));
    const runtime = createGoogleCloudTtsRuntime();
    const context = credentialContext('cloud-secret', undefined, undefined, httpRequest);

    const accepted = await runtime.synthesize!(synthesizeRequest, context);
    expect(accepted.requestId).toBe('r2');
    expect(accepted.bytes.byteLength).toBe(3_000_000);
    let rejected: unknown = null;
    try {
      await runtime.synthesize!(synthesizeRequest, context);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: 'provider_response_invalid' });
  });

  it('propagates the exact cancellation signal through credential materialization and provider HTTP', async () => {
    const controller = new AbortController();
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { 'x-goog-api-key': 'google-secret' },
    }));
    const httpRequest = vi.fn(async (
      _input: Parameters<VoiceSpeechOperationContext['http']['request']>[0],
      options?: Parameters<VoiceSpeechOperationContext['http']['request']>[1],
    ) => {
      expect(options?.signal).toBe(controller.signal);
      return await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    });
    const runtime = createGoogleGeminiSttRuntime();
    const context: VoiceSpeechOperationContext = {
      signal: controller.signal,
      settings: Object.freeze({}),
      http: Object.freeze({ request: httpRequest }),
      credentials: { phase: 'speech', mediated: null, raw: { materialize } },
    };
    const result = runtime.transcribe!(transcribeRequest, context);
    await vi.waitFor(() => expect(httpRequest).toHaveBeenCalledOnce());
    controller.abort(new Error('cancelled'));
    await expect(result).rejects.toBe(controller.signal.reason);
    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'httpHeaders' }),
      { signal: controller.signal },
    );
  });

  it('never treats Android-restricted credential metadata as a daemon credential', () => {
    expect(classifyGoogleCloudLegacyCredential({ androidCertSha1: 'AA:BB' })).toBe('needs_machine_credential');
    expect(classifyGoogleCloudLegacyCredential({ androidCertSha1: null })).toBe('importable');
  });

  it('normalizes and deduplicates the correct model and voice catalogs', async () => {
    const geminiHttp = vi.fn(async () => jsonHttpResponse({ models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] },
        { name: ' models/gemini-2.5-flash ', displayName: 'Duplicate', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
      ] }));
    const cloudHttp = vi.fn(async () => jsonHttpResponse({ voices: [
        { name: ' Voice A ', languageCodes: [' en-US ', 'en-US', 'fr-FR'], ssmlGender: ' FEMALE ', naturalSampleRateHertz: 24000 },
        { name: 'Voice A', languageCodes: ['en-US'], ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
      ] }));
    const gemini = createGoogleGeminiSttRuntime();
    const cloud = createGoogleCloudTtsRuntime();
    await expect(gemini.catalog!.list(
      { catalog: 'models' },
      credentialContext('AIzaSy-catalog-test-credential', undefined, undefined, geminiHttp),
    )).resolves.toEqual([
      { id: 'gemini-2.5-flash', name: 'Gemini Flash', metadata: { description: '' } },
    ]);
    const voices = await cloud.catalog!.list(
      { catalog: 'voices' },
      credentialContext('AIzaSy-voice-catalog-test-credential', undefined, undefined, cloudHttp),
    );
    expect(voices).toEqual([{
      id: 'Voice A',
      name: 'Voice A',
      metadata: { languageCodes: 'en-US,fr-FR', ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
    }]);
    expect(VoiceProviderCatalogItemSchema.safeParse(voices[0]).success).toBe(true);
  });

  it('separates a real empty catalog from a malformed catalog payload', async () => {
    const gemini = createGoogleGeminiSttRuntime();
    const cloud = createGoogleCloudTtsRuntime();

    await expect(gemini.catalog!.list(
      { catalog: 'models' },
      credentialContext('AIzaSy-empty-models', undefined, undefined, vi.fn(async () => jsonHttpResponse({ models: [] }))),
    )).resolves.toEqual([]);
    await expect(cloud.catalog!.list(
      { catalog: 'voices' },
      credentialContext('AIzaSy-empty-voices', undefined, undefined, vi.fn(async () => jsonHttpResponse({ voices: [] }))),
    )).resolves.toEqual([]);

    for (const malformed of [{}, { models: null }, { models: { a: 1 } }]) {
      await expect(gemini.catalog!.list(
        { catalog: 'models' },
        credentialContext('AIzaSy-bad-models', undefined, undefined, vi.fn(async () => jsonHttpResponse(malformed))),
      )).rejects.toMatchObject({ code: 'provider_response_invalid' });
    }
    for (const malformed of [{}, { voices: null }, { voices: { a: 1 } }]) {
      await expect(cloud.catalog!.list(
        { catalog: 'voices' },
        credentialContext('AIzaSy-bad-voices', undefined, undefined, vi.fn(async () => jsonHttpResponse(malformed))),
      )).rejects.toMatchObject({ code: 'provider_response_invalid' });
    }
  });

  it('rejects cross-catalog calls before provider HTTP', async () => {
    const geminiHttp = vi.fn();
    const cloudHttp = vi.fn();
    const geminiMaterialize = vi.fn();
    const cloudMaterialize = vi.fn();
    const geminiContext: VoiceSpeechOperationContext = {
      signal: new AbortController().signal,
      settings: Object.freeze({}),
      http: Object.freeze({ request: geminiHttp }),
      credentials: {
        phase: 'speech',
        mediated: null,
        raw: { materialize: geminiMaterialize },
      },
    };
    const cloudContext: VoiceSpeechOperationContext = {
      signal: new AbortController().signal,
      settings: Object.freeze({}),
      http: Object.freeze({ request: cloudHttp }),
      credentials: {
        phase: 'speech',
        mediated: null,
        raw: { materialize: cloudMaterialize },
      },
    };
    await expect(createGoogleGeminiSttRuntime().catalog!.list(
      { catalog: 'voices' }, geminiContext,
    )).rejects.toMatchObject({ code: 'invalid_parameters' });
    await expect(createGoogleCloudTtsRuntime().catalog!.list(
      { catalog: 'models' }, cloudContext,
    )).rejects.toMatchObject({ code: 'invalid_parameters' });
    expect(geminiMaterialize).not.toHaveBeenCalled();
    expect(cloudMaterialize).not.toHaveBeenCalled();
    expect(geminiHttp).not.toHaveBeenCalled();
    expect(cloudHttp).not.toHaveBeenCalled();
  });

  it('drops an empty normalized model id instead of returning an invalid catalog row', async () => {
    const httpRequest = vi.fn(async () => jsonHttpResponse({ models: [{
        name: 'models/', displayName: 'Invalid empty id', supportedGenerationMethods: ['generateContent'],
      }] }));
    const runtime = createGoogleGeminiSttRuntime();
    await expect(runtime.catalog!.list(
      { catalog: 'models' }, credentialContext('key', undefined, undefined, httpRequest),
    )).resolves.toEqual([]);
  });
});
