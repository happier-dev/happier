import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { DaemonVoiceInferenceModelStatusSchema } from '@happier-dev/protocol/daemon/voiceInference';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { normalizeVoiceFixtureTranscript, readVoiceFixture } from '../../../../../packages/tests/src/testkit/voice/voiceFixture';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';
import { startVoiceInferenceWorker } from './voiceInferenceWorker';

const PACK_ID = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const enabled = process.env.HAPPIER_PARAKEET_V3_REAL === '1';

describe.runIf(enabled)('published Parakeet v3 consumed lifecycle', () => {
  it('installs, warms, transcribes a complete human reference and removes through the production worker', async () => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_VARIANT', 'HAPPIER_CLI_SUBPROCESS_PREFER_TSX',
      'HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE', 'HAPPIER_MODEL_PACK_MANIFESTS', 'EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS']);
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-parakeet-v3-real-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_VARIANT = 'dev';
    process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = '1';
    // Use current source in the real supervised worker, without publishing shared dist.
    process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = new URL('./runtime/packagedVoiceInferenceRuntime.ts', import.meta.url).href;
    delete process.env.HAPPIER_MODEL_PACK_MANIFESTS;
    delete process.env.EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS;
    reloadConfiguration();
    let worker: Awaited<ReturnType<typeof startVoiceInferenceWorker>> | null = null;
    try {
      // Expose a missing native dependency directly instead of losing its cause
      // behind the child runtime's public unavailable result.
      const nativeAddonSpecifier = 'sherpa-onnx-node';
      await import(nativeAddonSpecifier);
      console.info('parakeet-v3-native-addon-loaded', { platform: process.platform, arch: process.arch });
      worker = await startVoiceInferenceWorker();
      const installed = DaemonVoiceInferenceModelStatusSchema.parse(await worker.installModel({ packId: PACK_ID }));
      expect(installed).toMatchObject({ packId: PACK_ID, installState: 'installed', runtimeSupported: true, inUse: false });
      console.info('parakeet-v3-public-install-verified', { packId: PACK_ID });
      await worker.warmModelPack(PACK_ID);
      const { metadata: fixture } = await readVoiceFixture('natural-librispeech-61-70968-0000-16k');
      if (!fixture.expectedTranscript) throw new Error('natural speech reference missing');
      const filePath = join(resolveVoiceInferencePaths().tempDir, 'human-reference.wav');
      await copyFile(fileURLToPath(new URL(fixture.file, new URL('../../../../../packages/tests/fixtures/voice/', import.meta.url))), filePath);
      const result = await worker.transcribeAudio({
        requestId: 'parakeet-v3-public-human', uploadId: 'parakeet-v3-public-human', filePath,
        inputMimeType: 'audio/wav', packId: PACK_ID, language: null,
        normalization: { inputTransport: 'upload_transfer', strategy: 'ui_pretranscoded_pcm16_fallback', systemFfmpegAllowed: false },
      });
      expect(normalizeVoiceFixtureTranscript(result.text)).toBe(normalizeVoiceFixtureTranscript(fixture.expectedTranscript));
      expect(result.modelPackId).toBe(PACK_ID);
      expect(DaemonVoiceInferenceModelStatusSchema.parse((await worker.getModelsStatus([PACK_ID]))[0]))
        .toMatchObject({ runtimeState: 'ready', inUse: false });
      await worker.removeModel(PACK_ID);
      expect((await worker.getModelsStatus([PACK_ID]))[0]).toMatchObject({ installState: 'not_installed', inUse: false });
      console.info('parakeet-v3-real', { platform: process.platform, arch: process.arch,
        runtime: 'current-source-supervised-worker', packId: PACK_ID });
    } finally {
      try {
        await worker?.stop();
      } finally {
        env.restore();
        reloadConfiguration();
        await rm(homeDir, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
