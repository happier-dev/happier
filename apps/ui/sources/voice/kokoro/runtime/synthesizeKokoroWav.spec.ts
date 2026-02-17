import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { synthesizeKokoroWav } from '@/voice/kokoro/runtime/synthesizeKokoroWav';

async function writeTestKokoroWebRuntime(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-kokoro-web-runtime-'));
  const filePath = path.join(dir, 'kokoro.web.mjs');
  const contents = `
export const calls = [];
export const env = {
  _wasmPaths: null,
  set wasmPaths(v) { this._wasmPaths = v; },
  get wasmPaths() { return this._wasmPaths; },
};
export const KokoroTTS = {
  async from_pretrained(modelId, opts) {
    calls.push({ modelId, opts, wasmPaths: env._wasmPaths });
    return {
      async generate() {
        return { audio: new Float32Array(240), sampling_rate: 24000 };
      }
    };
  }
};
`;
  await fs.writeFile(filePath, contents, 'utf8');
  return pathToFileURL(filePath).toString();
}

describe('synthesizeKokoroWav', () => {
  it('passes resolved runtime config through to kokoro-js', async () => {
    // Avoid triggering the file-backed cache polyfill in tests.
    (globalThis as any).caches = { open: vi.fn(), delete: vi.fn() };
    const runtimeUrl = await writeTestKokoroWebRuntime();
    process.env.EXPO_PUBLIC_KOKORO_WEB_RUNTIME_URL = runtimeUrl;

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

    const mod: any = await import(/* @vite-ignore */ runtimeUrl);
    expect(mod.calls?.length).toBe(1);
    expect(mod.calls?.[0]?.opts?.dtype).toBe('q8');
  });
});
