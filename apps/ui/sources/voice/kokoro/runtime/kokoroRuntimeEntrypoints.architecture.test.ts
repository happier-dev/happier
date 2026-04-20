import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const uiRootPath = fileURLToPath(new URL('../../../../', import.meta.url));

const requiredEntrypoints = [
    'sources/voice/kokoro/runtime/synthesizeKokoroWav.ts',
    'sources/voice/kokoro/runtime/synthesizeKokoroWav.native.ts',
    'sources/voice/kokoro/runtime/synthesizeKokoroWav.web.ts',
] as const;

const retiredWebRuntimeArtifacts = [
    'sources/voice/kokoro/runtime/loadKokoroWebRuntime.web.ts',
    'sources/voice/kokoro/runtime/loadKokoroWebRuntime.spec.ts',
    'sources/voice/kokoro/runtime/kokoroWebWorkerClient.web.ts',
] as const;

describe('kokoro runtime entrypoints', () => {
    it('keeps explicit platform entrypoints for native and web', async () => {
        for (const requiredPath of requiredEntrypoints) {
            // fs.access(...) resolves to `undefined` when the file exists.
            await expect(access(join(uiRootPath, requiredPath))).resolves.toBeUndefined();
        }
    });

    it('retire the removed web runtime owners/helpers (no browser Kokoro runtime)', async () => {
        for (const retiredPath of retiredWebRuntimeArtifacts) {
            await expect(access(join(uiRootPath, retiredPath))).rejects.toBeDefined();
        }
    });

    it('keeps the non-native fallback entrypoint fail-closed (no browser Kokoro runtime revival)', async () => {
        const source = await readFile(
            join(uiRootPath, 'sources/voice/kokoro/runtime/synthesizeKokoroWav.ts'),
            'utf8',
        );
        expect(source).toContain('kokoro_web_runtime_removed');
        expect(source).not.toContain('loadKokoroWebRuntime');
        expect(source).not.toContain('encodeWavPcm16');
        expect(source).not.toContain('prepareKokoroTtsInWorker');
        expect(source).not.toContain('new Worker');
    });
});
