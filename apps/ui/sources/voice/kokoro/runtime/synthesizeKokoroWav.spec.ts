import { describe, expect, it } from 'vitest';

describe('synthesizeKokoroWav', () => {
  it('keeps the shared synthesis entrypoint as a removed-browser sentinel', async () => {
    const { synthesizeKokoroWav } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    await expect(
      synthesizeKokoroWav({
        text: 'hello',
        assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        voiceId: 'af_heart',
        speed: 1,
        timeoutMs: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/kokoro_web_runtime_removed/i);
  });

  it('keeps the shared warmup entrypoint as a removed-browser sentinel', async () => {
    const { prepareKokoroTts } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    await expect(
      prepareKokoroTts({
        assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        timeoutMs: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/kokoro_web_runtime_removed/i);
  });

  it('keeps the shared streaming entrypoint as a removed-browser sentinel', async () => {
    const { streamKokoroWavSentences } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    await expect((async () => {
      for await (const _chunk of streamKokoroWavSentences({
        text: 'hello',
        assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        voiceId: 'af_heart',
        speed: 1,
        timeoutMs: 1,
        signal: new AbortController().signal,
      })) {
        // The iterator should throw before yielding.
      }
    })()).rejects.toThrow(/kokoro_web_runtime_removed/i);
  });
});
