import {
  createVoiceInferenceWorkerExecution,
  type VoiceInferenceWorkerExecutionHandle,
} from './voiceInferenceWorker.execution';
import {
  createVoiceInferenceWorkerLifecycle,
  type VoiceInferenceWorkerLifecycleHandle,
} from './voiceInferenceWorker.lifecycle';
import type { RuntimeLoader } from './voiceInferenceWorker.shared';

export type VoiceInferenceWorkerHandle = Readonly<
  VoiceInferenceWorkerLifecycleHandle
  & VoiceInferenceWorkerExecutionHandle
>;

export async function startVoiceInferenceWorker(params?: Readonly<{
  runtimeLoader?: RuntimeLoader;
  now?: () => number;
  residencyMs?: number;
  perModelConcurrency?: number;
}>): Promise<VoiceInferenceWorkerHandle> {
  let abortAllRequests = async () => {};
  const lifecycle = createVoiceInferenceWorkerLifecycle({
    runtimeLoader: params?.runtimeLoader,
    now: params?.now,
    residencyMs: params?.residencyMs,
    perModelConcurrency: params?.perModelConcurrency,
    onStop: async () => {
      await abortAllRequests();
    },
  });
  const execution = createVoiceInferenceWorkerExecution({
    lifecycle,
  });
  abortAllRequests = execution.abortAllRequests;
  const {
    isStopped: _isStopped,
    getDiagnostics: _getDiagnostics,
    setDiagnostics: _setDiagnostics,
    runExclusive: _runExclusive,
    runLifecycleExclusive: _runLifecycleExclusive,
    warmRuntimeForPack: _warmRuntimeForPack,
    ...publicLifecycle
  } = lifecycle;
  const { abortAllRequests: _abortAllRequests, ...executionHandle } = execution;
  return {
    ...publicLifecycle,
    ...executionHandle,
  };
}
