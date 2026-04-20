import { describe, expect, it, vi } from 'vitest';

describe('fetchGoogleCloudTtsVoiceCatalog', () => {
  it('normalizes and deduplicates catalog language codes', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        voices: [
          {
            name: '  Voice A  ',
            languageCodes: [' en-US ', 'en-US', '  ', 'fr-FR'],
            ssmlGender: ' FEMALE ',
            naturalSampleRateHertz: 24000,
          },
        ],
      }),
    });
    (globalThis as any).fetch = fetchSpy;

    const { fetchGoogleCloudTtsVoiceCatalog } = await import('./googleCloudTtsApi');
    const voices = await fetchGoogleCloudTtsVoiceCatalog({
      apiKey: ' key ',
      languageCode: ' en-US ',
      androidCertSha1: ' sha1 ',
      timeoutMs: 1000,
    });

    expect(fetchSpy).toHaveBeenCalled();
    const call = fetchSpy.mock.calls[0]!;
    const url = String(call[0]);
    const init = call[1] as any;
    expect(url).not.toContain('key=');
    expect(url).not.toContain(' key ');
    expect(url).not.toContain('key');
    expect(init?.headers?.['x-goog-api-key']).toBe('key');
    expect(voices).toEqual([
      {
        name: 'Voice A',
        languageCodes: ['en-US', 'fr-FR'],
        ssmlGender: 'FEMALE',
        naturalSampleRateHertz: 24000,
      },
    ]);
  });
});
