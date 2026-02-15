import { describe, expect, it } from 'vitest';

describe('fetchGoogleGeminiModelCatalog', () => {
  it('lists generateContent-capable models and normalizes ids', async () => {
    const fetchSpy = async () => {
      return {
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/text-embedding-004',
              displayName: 'Embedding',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        }),
      } as any;
    };
    (globalThis as any).fetch = fetchSpy as any;

    const { fetchGoogleGeminiModelCatalog } = await import('./googleGeminiModelsApi');
    const models = await fetchGoogleGeminiModelCatalog({ apiKey: 'k', timeoutMs: 15_000 });

    expect(models).toEqual([
      {
        id: 'gemini-2.5-flash',
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        description: null,
      },
    ]);
  });
});

