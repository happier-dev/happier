import { describe, expect, it } from 'vitest';

import { loadKokoroWebRuntime } from './loadKokoroWebRuntime.web';

describe('loadKokoroWebRuntime', () => {
  it('throws kokoro_import_failed when KokoroTTS export is missing', async () => {
    await expect(
      loadKokoroWebRuntime({
        runtimeUrl: 'https://example.invalid/kokoro.web.js',
        importer: async () => ({}),
      }),
    ).rejects.toThrow(/kokoro_import_failed/i);
  });

  it('caches the imported module per runtimeUrl', async () => {
    let calls = 0;
    const runtimeUrl = 'https://example.invalid/kokoro.web.js';
    const module = { KokoroTTS: class {} };

    const first = await loadKokoroWebRuntime({
      runtimeUrl,
      importer: async () => {
        calls += 1;
        return module;
      },
    });
    const second = await loadKokoroWebRuntime({
      runtimeUrl,
      importer: async () => {
        calls += 1;
        return { KokoroTTS: class {} };
      },
    });

    expect(first.KokoroTTS).toBe(module.KokoroTTS);
    expect(second.KokoroTTS).toBe(module.KokoroTTS);
    expect(calls).toBe(1);
  });
});

