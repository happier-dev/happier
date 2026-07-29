import { describe, expect, it, vi } from 'vitest';
import { VoiceProviderCatalogItemSchema } from '@happier-dev/protocol';

import type { PluginVoiceSpeechCredentialAccess } from '@happier-dev/plugin-sdk/runtime';

import { createGoogleVoiceSpeechRuntime, createGoogleVoiceSpeechOperations } from './speech';
import { classifyGoogleCloudLegacyCredential } from '../protocol/voice/index';

const credential = (secret: string): PluginVoiceSpeechCredentialAccess => async (use) => await use(secret);

describe('Google daemon voice provider', () => {
  it('cancels an oversized streamed response before buffering the remaining body', async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 12) {
          controller.enqueue(new Uint8Array(512 * 1024));
          return;
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const entry = createGoogleVoiceSpeechRuntime({ fetch: vi.fn(async () => response) });

    await expect(entry.catalogProviders[0]!.catalogOperations.fetchCatalog({
      credential: credential('google-secret'),
      catalog: 'models',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(12);
  });

  it.each([401, 403])(
    'cancels an unread provider HTTP %s body before returning unavailable credentials',
    async (status) => {
      let cancelled = false;
      const entry = createGoogleVoiceSpeechRuntime({
        fetch: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
          pull(controller) { controller.enqueue(new Uint8Array([1])); },
          cancel() { cancelled = true; },
        }), { status })),
      });

      await expect(entry.catalogProviders[0]!.catalogOperations.fetchCatalog({
        credential: credential('invalid-secret'), catalog: 'models', signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: 'credential_unavailable',
        message: 'credential_unavailable',
      });
      expect(cancelled).toBe(true);
    },
  );

  it('transcribes audio through Gemini without exposing the source key', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('google-secret');
      expect(String(init?.body)).not.toContain('google-secret');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello world' }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const operations = createGoogleVoiceSpeechOperations({ fetch });
    await expect(operations.transcribe({
      credential: credential('google-secret'),
      request: {
        requestId: 'r1',
        model: 'gemini-2.5-flash',
        language: 'en',
        mimeType: 'audio/wav',
        bytes: new Uint8Array([1, 2, 3]),
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ requestId: 'r1', text: 'hello world' });
  });

  it('rejects a successful provider response that echoes the source credential', async () => {
    const operations = createGoogleVoiceSpeechOperations({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'google-secret' }] } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });

    const result = operations.transcribe({
      credential: credential('google-secret'),
      request: {
        requestId: 'r-secret-echo',
        model: 'gemini-2.5-flash',
        language: null,
        mimeType: 'audio/wav',
        bytes: new Uint8Array([1, 2, 3]),
      },
      signal: new AbortController().signal,
    });

    await expect(result).rejects.toMatchObject({
      code: 'provider_response_invalid',
      message: 'provider_response_invalid',
    });
    await expect(result).rejects.not.toThrow('google-secret');
  });

  it('synthesizes bounded audio and validates provider output', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ audioContent: 'AQID' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const operations = createGoogleVoiceSpeechOperations({ fetch });
    const result = await operations.synthesize({
      credential: credential('google-secret'),
      request: {
        requestId: 'r2',
        input: 'Hello',
        voiceName: 'en-US-Standard-A',
        languageCode: 'en-US',
        format: 'mp3',
        speakingRate: null,
        pitch: null,
        recipientPublicKeyBase64: 'recipient-key',
      },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ requestId: 'r2', mimeType: 'audio/mpeg' });
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  });

  it('never treats Android-restricted credential metadata as a daemon credential', async () => {
    expect(classifyGoogleCloudLegacyCredential({ androidCertSha1: 'AA:BB' })).toBe('needs_machine_credential');
    expect(classifyGoogleCloudLegacyCredential({ androidCertSha1: null })).toBe('importable');
  });

  it('normalizes and deduplicates provider catalogs at the daemon boundary', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('generativelanguage')
        ? { models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] },
          { name: ' models/gemini-2.5-flash ', displayName: 'Duplicate', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
        ] }
        : { voices: [
          { name: ' Voice A ', languageCodes: [' en-US ', 'en-US', 'fr-FR'], ssmlGender: ' FEMALE ', naturalSampleRateHertz: 24000 },
          { name: 'Voice A', languageCodes: ['en-US'], ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
        ] },
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    const entry = createGoogleVoiceSpeechRuntime({ fetch });
    const models = await entry.catalogProviders[0]!.catalogOperations.fetchCatalog({
      credential: credential('key'), catalog: 'models', signal: new AbortController().signal,
    });
    const voices = await entry.catalogProviders[1]!.catalogOperations.fetchCatalog({
      credential: credential('key'), catalog: 'voices', signal: new AbortController().signal,
    });
    expect(models).toEqual([{ id: 'gemini-2.5-flash', name: 'Gemini Flash', metadata: { description: '' } }]);
    expect(voices).toEqual([{
      id: 'Voice A',
      name: 'Voice A',
      metadata: { languageCodes: 'en-US,fr-FR', ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
    }]);
  });

  it('drops an empty normalized model id instead of returning an invalid catalog row', async () => {
    const entry = createGoogleVoiceSpeechRuntime({
      fetch: vi.fn(async () => new Response(JSON.stringify({ models: [{
        name: 'models/', displayName: 'Invalid empty id', supportedGenerationMethods: ['generateContent'],
      }] }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });

    await expect(entry.catalogProviders[0]!.catalogOperations.fetchCatalog({
      credential: credential('key'), catalog: 'models', signal: new AbortController().signal,
    })).resolves.toEqual([]);
  });

  it('bounds joined voice language metadata to the public catalog scalar contract', async () => {
    const languageCodes = Array.from({ length: 9 }, (_, index) => `${index}`.padEnd(64, 'x'));
    const entry = createGoogleVoiceSpeechRuntime({
      fetch: vi.fn(async () => new Response(JSON.stringify({ voices: [{
        name: 'Voice A', languageCodes,
      }] }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });

    const voices = await entry.catalogProviders[1]!.catalogOperations.fetchCatalog({
      credential: credential('key'), catalog: 'voices', signal: new AbortController().signal,
    });
    expect(voices).toHaveLength(1);
    expect(VoiceProviderCatalogItemSchema.safeParse(voices[0]).success).toBe(true);
    expect(String(voices[0]?.metadata.languageCodes).length).toBeLessThanOrEqual(512);
  });
});
