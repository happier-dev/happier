import { describe, expect, it, vi } from 'vitest';

import { createGoogleVoiceAgentEntry, createGoogleVoiceAgentOperations } from './provider';
import { classifyGoogleCloudLegacyCredential } from '../../protocol/voice/index';

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
    const entry = createGoogleVoiceAgentEntry({ fetch: vi.fn(async () => response) });

    await expect(entry.credentialProviders[0]!.credentialOperations.fetchCatalog({
      secret: 'google-secret',
      catalog: 'models',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(12);
  });

  it('cancels an unread provider error body before returning a safe failure', async () => {
    let cancelled = false;
    const entry = createGoogleVoiceAgentEntry({
      fetch: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array([1])); },
        cancel() { cancelled = true; },
      }), { status: 401 })),
    });

    await expect(entry.credentialProviders[0]!.credentialOperations.fetchCatalog({
      secret: 'invalid-secret', catalog: 'models', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(cancelled).toBe(true);
  });

  it('transcribes audio through Gemini without exposing the source key', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('google-secret');
      expect(String(init?.body)).not.toContain('google-secret');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello world' }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const operations = createGoogleVoiceAgentOperations({ fetch });
    await expect(operations.transcribe({
      secret: 'google-secret',
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

  it('synthesizes bounded audio and validates provider output', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ audioContent: 'AQID' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const operations = createGoogleVoiceAgentOperations({ fetch });
    const result = await operations.synthesize({
      secret: 'google-secret',
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
    const entry = createGoogleVoiceAgentEntry({ fetch });
    const models = await entry.credentialProviders[0]!.credentialOperations.fetchCatalog({
      secret: 'key', catalog: 'models', signal: new AbortController().signal,
    });
    const voices = await entry.credentialProviders[1]!.credentialOperations.fetchCatalog({
      secret: 'key', catalog: 'voices', signal: new AbortController().signal,
    });
    expect(models).toEqual([{ id: 'gemini-2.5-flash', name: 'Gemini Flash', metadata: { description: '' } }]);
    expect(voices).toEqual([{
      id: 'Voice A',
      name: 'Voice A',
      metadata: { languageCodes: 'en-US,fr-FR', ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
    }]);
  });
});
