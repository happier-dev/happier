import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const uiRootPath = fileURLToPath(new URL('../../../../', import.meta.url));

const retiredWebRuntimeArtifacts = [
    'sources/voice/kokoro/runtime/loadKokoroWebRuntime.web.ts',
    'sources/voice/kokoro/runtime/loadKokoroWebRuntime.spec.ts',
    'sources/voice/kokoro/runtime/kokoroWebWorkerClient.web.ts',
] as const;

describe('kokoro runtime entrypoints', () => {
    it('keeps explicit platform entrypoints for native and web', async () => {
        const native = await import('./synthesizeKokoroWav.native');
        const web = await import('./synthesizeKokoroWav.web');
        for (const entrypoint of [native, web]) {
            expect(entrypoint.synthesizeKokoroWav).toBeTypeOf('function');
            expect(entrypoint.prepareKokoroTts).toBeTypeOf('function');
            expect(entrypoint.streamKokoroWavSentences).toBeTypeOf('function');
        }
        expect(native.prewarmKokoroRuntime).toBeTypeOf('function');
    });

    it('retire the removed web runtime owners/helpers (no browser Kokoro runtime)', async () => {
        for (const retiredPath of retiredWebRuntimeArtifacts) {
            await expect(access(join(uiRootPath, retiredPath))).rejects.toBeDefined();
        }
    });

    it('keeps fallback and explicit web entrypoints fail-closed', async () => {
        const fallback = await import('./synthesizeKokoroWav');
        const web = await import('./synthesizeKokoroWav.web');
        const options = {
            text: 'hello', assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart', speed: 1, timeoutMs: 1,
            signal: new AbortController().signal,
        };
        for (const entrypoint of [fallback, web]) {
            await expect(entrypoint.synthesizeKokoroWav(options)).rejects.toThrow('kokoro_web_runtime_removed');
            await expect(entrypoint.prepareKokoroTts(options)).rejects.toThrow('kokoro_web_runtime_removed');
            await expect(entrypoint.streamKokoroWavSentences(options)[Symbol.asyncIterator]().next())
                .rejects.toThrow('kokoro_web_runtime_removed');
        }
    });
});
