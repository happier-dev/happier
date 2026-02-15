import { describe, expect, it, vi } from 'vitest';

import { getKokoroBrowserCacheSummary, clearKokoroBrowserCaches } from './kokoroBrowserCache';

type FakeCache = {
  keys(): Promise<Array<{ url: string }>>;
};

type FakeCacheStorage = {
  open(name: string): Promise<FakeCache>;
  delete(name: string): Promise<boolean>;
};

function createCacheStorageMock(initial: Record<string, string[]>): FakeCacheStorage {
  const state: Record<string, string[]> = JSON.parse(JSON.stringify(initial));

  return {
    open: vi.fn(async (name: string) => {
      if (!state[name]) state[name] = [];
      return {
        keys: vi.fn(async () => state[name].map((url) => ({ url }))),
      };
    }),
    delete: vi.fn(async (name: string) => {
      const existed = Boolean(state[name]);
      delete state[name];
      return existed;
    }),
  };
}

describe('kokoroBrowserCache', () => {
  it('summarizes cache keys for transformers and voices', async () => {
    const storage = createCacheStorageMock({
      'transformers-cache': ['https://example.com/model.onnx', 'https://example.com/tokenizer.json'],
      'kokoro-voices': ['https://example.com/voices/af_heart.bin'],
    });
    (globalThis as any).caches = storage;

    const summary = await getKokoroBrowserCacheSummary();
    expect(summary).toEqual({
      transformersCacheCount: 2,
      kokoroVoicesCacheCount: 1,
    });
  });

  it('clears both caches when requested', async () => {
    const storage = createCacheStorageMock({
      'transformers-cache': ['https://example.com/model.onnx'],
      'kokoro-voices': ['https://example.com/voices/af_heart.bin'],
    });
    (globalThis as any).caches = storage;

    await clearKokoroBrowserCaches();

    expect(storage.delete).toHaveBeenCalledWith('transformers-cache');
    expect(storage.delete).toHaveBeenCalledWith('kokoro-voices');
  });
});

