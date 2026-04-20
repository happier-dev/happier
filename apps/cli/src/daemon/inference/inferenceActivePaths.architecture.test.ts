import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('shared daemon inference active paths', () => {
  it('keeps active voice and memory runtime ownership on shared inference primitives', async () => {
    const voiceInferenceWorkerSource = await readFile('src/daemon/voiceInference/voiceInferenceWorker.ts', 'utf8');
    expect(voiceInferenceWorkerSource).toContain('createVoiceInferenceWorkerLifecycle');
    expect(voiceInferenceWorkerSource).toContain('createVoiceInferenceWorkerExecution');
    expect(voiceInferenceWorkerSource).not.toContain("@/daemon/inference/inferenceConcurrencyCoordinator");
    expect(voiceInferenceWorkerSource).not.toContain("@/daemon/inference/inferenceInstallBookkeeping");
    expect(voiceInferenceWorkerSource).not.toContain("@/daemon/inference/inferenceWarmupCoordinator");
    expect(voiceInferenceWorkerSource).not.toContain("@/daemon/memory/");
    expect(voiceInferenceWorkerSource).not.toContain('singleFlightIntervalLoop');

    const voiceInferenceLifecycleSource = await readFile('src/daemon/voiceInference/voiceInferenceWorker.lifecycle.ts', 'utf8');
    expect(voiceInferenceLifecycleSource).toContain("@/daemon/inference/inferenceConcurrencyCoordinator");
    expect(voiceInferenceLifecycleSource).toContain("@/daemon/inference/inferenceInstallBookkeeping");
    expect(voiceInferenceLifecycleSource).toContain("@/daemon/inference/inferenceWarmupCoordinator");
    expect(voiceInferenceLifecycleSource).toContain('voiceModelPackInstaller');
    expect(voiceInferenceLifecycleSource).not.toContain('validateDaemonVoiceInferenceAudioInput');

    const voiceInferenceExecutionSource = await readFile('src/daemon/voiceInference/voiceInferenceWorker.execution.ts', 'utf8');
    expect(voiceInferenceExecutionSource).toContain('validateDaemonVoiceInferenceAudioInput');
    expect(voiceInferenceExecutionSource).toContain('voiceInferenceWorker.shared');
    expect(voiceInferenceExecutionSource).not.toContain("@/daemon/inference/inferenceConcurrencyCoordinator");
    expect(voiceInferenceExecutionSource).not.toContain('voiceModelPackInstaller');

    const voiceInferenceSharedSource = await readFile('src/daemon/voiceInference/voiceInferenceWorker.shared.ts', 'utf8');
    expect(voiceInferenceSharedSource).not.toContain("@/daemon/inference/");
    expect(voiceInferenceSharedSource).not.toContain('voiceModelPackInstaller');

    const memoryWorkerSource = await readFile('src/daemon/memory/memoryWorker.ts', 'utf8');
    expect(memoryWorkerSource).toContain("@/daemon/inference/inferencePaths");
    expect(memoryWorkerSource).not.toContain("@/daemon/voiceInference/");

    const memoryEmbeddingsSource = await readFile(
      'src/daemon/memory/deepIndex/embeddings/createLocalTransformersEmbeddingsProvider.ts',
      'utf8',
    );
    expect(memoryEmbeddingsSource).toContain("@/daemon/inference/inferenceRuntimeLoader");
    expect(memoryEmbeddingsSource).not.toContain("@/daemon/voiceInference/");

    const voiceRuntimeLoaderSource = await readFile(
      'src/daemon/voiceInference/loadDefaultVoiceInferenceRuntime.ts',
      'utf8',
    );
    expect(voiceRuntimeLoaderSource).toContain("@/daemon/inference/inferenceRuntimeLoader");

    const memoryDiagnosticsSource = await readFile(
      'src/daemon/memory/resolveOperationalMemoryEmbeddingsSettings.ts',
      'utf8',
    );
    expect(memoryDiagnosticsSource).toContain("@/daemon/inference/inferenceDiagnostics");
  });
});
