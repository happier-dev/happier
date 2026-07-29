import { readFile } from 'node:fs/promises';

import { parseModelPackManifest } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { voiceInferenceRuntimeEngine } from './packagedVoiceInferenceRuntime';

const modelDir = process.env.HAPPIER_ZIPFORMER_MODEL_DIR?.trim() ?? '';
const manifestPath = process.env.HAPPIER_ZIPFORMER_MANIFEST_PATH?.trim() ?? '';
const fixtureWav = process.env.HAPPIER_ZIPFORMER_FIXTURE_WAV?.trim() ?? '';
const expectedTranscriptSubstrings = (process.env.HAPPIER_ZIPFORMER_EXPECTED_TRANSCRIPT_SUBSTRINGS ?? 'confirmation,continuing')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter((value) => value.length > 0);
const integrationEnabled = modelDir.length > 0 && manifestPath.length > 0 && fixtureWav.length > 0;

describe.runIf(integrationEnabled)('packaged Zipformer runtime integration', () => {
  it('warms, transcribes the project-owned 16 kHz fixture, and releases the production runtime', async () => {
    const manifest = parseModelPackManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    const common = {
      packId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
      packDir: modelDir,
      manifest,
    } as const;

    const warmStartedAt = performance.now();
    await voiceInferenceRuntimeEngine.warmModel(common);
    const warmMs = performance.now() - warmStartedAt;

    const inferenceStartedAt = performance.now();
    const result = await voiceInferenceRuntimeEngine.transcribeAudio({
      requestId: 'zipformer-real-fixture',
      filePath: fixtureWav,
      inputMimeType: 'audio/wav',
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
      },
      ...common,
    });
    const inferenceMs = performance.now() - inferenceStartedAt;

    const normalized = result.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    expect(normalized.length).toBeGreaterThan(10);
    for (const expected of expectedTranscriptSubstrings) {
      expect(normalized).toContain(expected);
    }
    expect(warmMs).toBeGreaterThan(0);
    expect(inferenceMs).toBeGreaterThan(0);

    await voiceInferenceRuntimeEngine.releaseModel(common);
  }, 120_000);
});
