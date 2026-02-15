import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('listElevenLabsVoices', () => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.PUBLIC_EXPO_ELEVENLABS_API_BASE_URL;

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = vi.fn() as any;
    process.env.PUBLIC_EXPO_ELEVENLABS_API_BASE_URL = 'https://api.elevenlabs.io/v1';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.PUBLIC_EXPO_ELEVENLABS_API_BASE_URL;
    else process.env.PUBLIC_EXPO_ELEVENLABS_API_BASE_URL = originalBase;
  });

  it('parses voice_id/name/preview_url from the list voices response', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        voices: [
          { voice_id: 'v1', name: 'Alpha', preview_url: 'https://example.com/a.mp3', category: 'premade', labels: { accent: 'us' } },
          { voice_id: 'v2', name: 'Beta', preview_url: null },
        ],
      }),
    });

    const { listElevenLabsVoices } = await import('./elevenLabsVoices');
    const voices = await listElevenLabsVoices('xi_test');

    expect(voices.map((v) => v.voiceId)).toEqual(['v1', 'v2']);
    expect(voices.find((v) => v.voiceId === 'v1')?.previewUrl).toBe('https://example.com/a.mp3');
    expect(voices.find((v) => v.voiceId === 'v1')?.labels?.accent).toBe('us');
  });
});

