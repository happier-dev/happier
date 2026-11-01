import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('sends iOS app restriction headers with the catalog request', async () => {
    vi.resetModules();
    vi.doMock('expo-application', () => ({ applicationId: 'dev.happier.app' }));
    vi.doMock('react-native', async () => {
      const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
      return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    });
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) }) as any);
    (globalThis as any).fetch = fetchSpy;

    const { fetchGoogleGeminiModelCatalog } = await import('./googleGeminiModelsApi');
    await fetchGoogleGeminiModelCatalog({ apiKey: 'k', timeoutMs: 15_000 });

    expect((fetchSpy.mock.calls[0] as any)?.[1]?.headers).toMatchObject({
      'x-goog-api-key': 'k',
      'X-Ios-Bundle-Identifier': 'dev.happier.app',
    });
  });
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('expo-application');
  vi.doUnmock('react-native');
});
