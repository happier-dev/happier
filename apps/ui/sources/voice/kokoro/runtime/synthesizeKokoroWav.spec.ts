import { describe, expect, it, vi } from 'vitest';

import { synthesizeKokoroWav } from '@/voice/kokoro/runtime/synthesizeKokoroWav';

const fromPretrained = vi.fn(async (_modelId: string, _opts: any) => {
  return {
    generate: vi.fn(async (_text: string, _opts2: any) => {
      // 240 samples at 24kHz ≈ 10ms.
      return { audio: new Float32Array(240), sampling_rate: 24000 };
    }),
  };
});

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: (modelId: string, opts: any) => fromPretrained(modelId, opts),
  },
  env: {},
}));

describe('synthesizeKokoroWav', () => {
  it('passes resolved runtime config through to kokoro-js', async () => {
    // Avoid triggering the file-backed cache polyfill in tests.
    (globalThis as any).caches = { open: vi.fn(), delete: vi.fn() };

    const controller = new AbortController();
    const out = await synthesizeKokoroWav({
      text: 'hello',
      assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    expect(out).toBeInstanceOf(ArrayBuffer);
    expect(fromPretrained).toHaveBeenCalled();

    const opts = fromPretrained.mock.calls[0]?.[1] ?? null;
    expect(opts?.dtype).toBe('q8');
  });
});
