import { readFile } from 'node:fs/promises';

import { parseModelPackManifest } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { voiceInferenceRuntimeEngine } from './packagedVoiceInferenceRuntime';

const PARAKEET_V2_PACK_ID = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';
const modelDir = process.env.HAPPIER_PARAKEET_V2_MODEL_DIR?.trim() ?? '';
const manifestPath = process.env.HAPPIER_PARAKEET_V2_MANIFEST_PATH?.trim() ?? '';
const fixtureWav = process.env.HAPPIER_PARAKEET_V2_FIXTURE_WAV?.trim() ?? '';
const integrationEnabled = modelDir.length > 0 && manifestPath.length > 0 && fixtureWav.length > 0;

describe.runIf(integrationEnabled)('packaged Parakeet runtime integration', () => {
    it('transcribes the official pinned v2 audio fixture through the production runtime adapter', async () => {
        const manifest = parseModelPackManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
        expect(manifest.packId).toBe(PARAKEET_V2_PACK_ID);
        expect(manifest.kind).toBe('stt_sherpa');

        const result = await voiceInferenceRuntimeEngine.transcribeAudio({
            requestId: 'parakeet-v2-real-fixture',
            filePath: fixtureWav,
            inputMimeType: 'audio/wav',
            packId: PARAKEET_V2_PACK_ID,
            packDir: modelDir,
            manifest,
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'ui_pretranscoded_pcm16_fallback',
                systemFfmpegAllowed: false,
            },
        });

        const normalized = result.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        expect(normalized).toContain('i don t wish to see it any more');
        expect(normalized).toContain('it is certainly very like the old portrait');
    }, 120_000);
});
