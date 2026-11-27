import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT, DaemonVoiceInferenceSttStreamFinishResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { ModelPackManifestSchema } from '@happier-dev/protocol';

import { createVoiceInferenceSpeechStreamManager } from './voiceInferenceSpeechStreamManager';
import { startVoiceInferenceWorker } from '../voiceInferenceWorker';
import { resolveVoiceInferencePaths } from '../voiceInferencePaths';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { logger } from '@/ui/logger';

describe('speech stream endpoint diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { streamingMode: 'runtime', recognizerEndpoint: false, endpointDiagnostic: false },
    { streamingMode: 'upload_bridge', recognizerEndpoint: false, endpointDiagnostic: false },
    { streamingMode: 'runtime', recognizerEndpoint: true, endpointDiagnostic: true },
    { streamingMode: 'runtime', recognizerEndpoint: true, endpointDiagnostic: false },
  ] as const)('reports known endpoint facts for $streamingMode (recognizer=$recognizerEndpoint, diagnostic=$endpointDiagnostic)', async ({ streamingMode, recognizerEndpoint, endpointDiagnostic }) => {
    const root = await mkdtemp(join(tmpdir(), 'voice-endpoint-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_WEB_LATENCY_TRACE']);
    process.env.HAPPIER_HOME_DIR = root;
    process.env.HAPPIER_WEB_LATENCY_TRACE = '1';
    const log = vi.spyOn(logger, 'debugLocalFile').mockImplementation(() => undefined);
    reloadConfiguration();
    const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
    const bytes = Buffer.from('native model boundary fixture');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'model.onnx'), bytes);
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(ModelPackManifestSchema.parse({
      packId, kind: 'stt_sherpa', model: 'zipformer', version: 'fixture-v1', files: [{ path: 'model.onnx',
        url: 'https://example.test/model.onnx', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength }],
    })));
    const now = vi.spyOn(performance, 'now').mockReturnValue(120);
    const completeTranscription = async () => {
      now.mockReturnValue(450);
      return { requestId: 'request-endpoint', text: 'heard', language: 'en', modelPackId: null, events: [] };
    };
    // Only the native model runtime is replaced; worker admission and lifecycle stay real.
    const worker = await startVoiceInferenceWorker({ runtimeLoader: async () => ({
        synthesizeTts: async () => { throw new Error('unused synthesis'); },
        transcribeAudio: completeTranscription,
        createStreamingTranscriptionSession: async () => ({
          appendPcm16: async () => ({ events: recognizerEndpoint ? [{ type: 'endpoint' as const, seq: 0, transcript: 'heard', reason: 'vad' as const,
            ...(endpointDiagnostic ? { endpointDecision: { endpointRule: 'unreported_by_recognizer' as const, monotonicMs: 90, timeOriginMs: performance.timeOrigin } } : {}) }] : [] }),
          finish: completeTranscription,
          cancel: async () => undefined,
          close: async () => undefined,
          modelPackId: null,
        }),
    }) });
    await mkdir(resolveVoiceInferencePaths().tempDir, { recursive: true });
    const manager = createVoiceInferenceSpeechStreamManager({ streamRoot: resolveVoiceInferencePaths().tempDir, voiceInferenceWorker: worker });
    try {
      const started = await manager.start({ requestId: 'request-endpoint', packId, language: 'en', streamingMode,
        format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error('stream start failed');
      expect((await manager.appendPcm16Bytes({ ...started, seq: 0, pcm16Bytes: new Uint8Array([0, 0]) })).ok).toBe(true);
      const result = DaemonVoiceInferenceSttStreamFinishResponseSchema.parse(await manager.finish({ ...started, finalSeq: 0 }));
      expect(result).toMatchObject({ ok: true, finalText: 'heard' });
      const endpointLogs = log.mock.calls.filter(([message]) => message === '[Voice] Latency phase');
      if (recognizerEndpoint) {
        // A recognizer endpoint must not become a new client decision, even without older runtimes' optional telemetry.
        expect(result.ok && result.events[0]?.endpointDecision).toBeUndefined();
        expect(endpointLogs).toEqual([]);
      } else {
        const decision = { endpointRule: 'input_finished_by_client', monotonicMs: 120, timeOriginMs: performance.timeOrigin };
        expect(result).toMatchObject({ events: [{ type: 'final', endpointDecision: decision }] });
        expect(endpointLogs).toEqual([['[Voice] Latency phase', expect.objectContaining({ phase: 'endpoint_decided',
          requestId: 'request-endpoint', streamId: started.streamId, sequence: 0, ...decision })]]);
      }
    } finally {
      await manager.dispose();
      await worker.stop();
      await rm(root, { recursive: true, force: true });
      env.restore();
      reloadConfiguration();
    }
  });
});
