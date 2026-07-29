import { createForkedVoiceInferenceRuntimeHandle } from './forkedWorker/forkedRuntimeLoader';
import {
  createVoiceInferenceWorkerExecution,
  type VoiceInferenceWorkerExecutionHandle,
} from './voiceInferenceWorker.execution';
import {
  createVoiceInferenceWorkerLifecycle,
  type VoiceInferenceWorkerLifecycleHandle,
} from './voiceInferenceWorker.lifecycle';
import {
  resolveVoiceInferenceRuntimeIsolationMode,
  type VoiceInferenceRuntimeIsolationMode,
} from './voiceInferenceWorkerConfig';
import type { RuntimeLoader } from './voiceInferenceWorker.shared';
import type { DaemonPublicVoiceModelPackRuntime } from './publicModelPacks/runtime';
import { reconcileModelPackPromotions } from './modelPackInstallerHost.node';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';

export type VoiceInferenceWorkerHandle = Readonly<
  VoiceInferenceWorkerLifecycleHandle
  & VoiceInferenceWorkerExecutionHandle
>;

export async function startVoiceInferenceWorker(params?: Readonly<{
  runtimeLoader?: RuntimeLoader;
  /**
   * Process-isolation mode. Defaults to the centralized config flag
   * (`resolveVoiceInferenceRuntimeIsolationMode`). Ignored when an explicit
   * `runtimeLoader` is supplied (tests / overrides own the runtime directly).
   */
  isolationMode?: VoiceInferenceRuntimeIsolationMode;
  now?: () => number;
  residencyMs?: number;
  perModelConcurrency?: number;
  maxResidentBytes?: number;
  publicModelPacks?: DaemonPublicVoiceModelPackRuntime;
}>): Promise<VoiceInferenceWorkerHandle> {
  let abortAllRequests = async () => {};

  // Recovery is a startup gate: catalog/load observations must not race durable
  // metadata and filesystem convergence.
  if (params?.publicModelPacks) await params.publicModelPacks.ready();
  else await reconcileModelPackPromotions(resolveVoiceInferencePaths().packsRootDir);

  // Selection: an explicit runtimeLoader always wins (used by tests and module overrides).
  // Otherwise the centralized isolation flag picks between the default in-process engine
  // and the forked-worker engine. Both implement the SAME VoiceInferenceRuntime interface,
  // so nothing downstream branches on the choice.
  const isolationMode = params?.isolationMode ?? resolveVoiceInferenceRuntimeIsolationMode();
  const forkedHandle = params?.runtimeLoader || isolationMode !== 'forked'
    ? null
    : createForkedVoiceInferenceRuntimeHandle();
  const runtimeLoader = params?.runtimeLoader ?? forkedHandle?.runtimeLoader;

  const lifecycle = createVoiceInferenceWorkerLifecycle({
    runtimeLoader,
    enforceCatalogRuntimeManifest: params?.runtimeLoader === undefined,
    now: params?.now,
    residencyMs: params?.residencyMs,
    perModelConcurrency: params?.perModelConcurrency,
    maxResidentBytes: params?.maxResidentBytes,
    publicModelPacks: params?.publicModelPacks,
    onStop: async () => {
      await abortAllRequests();
    },
  });
  const execution = createVoiceInferenceWorkerExecution({
    lifecycle,
  });
  abortAllRequests = execution.abortAllRequests;
  const {
    stop: stopLifecycle,
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
    stop: async () => {
      try {
        // Release every warm model while the forked runtime channel is still available.
        // Disposing the child first makes releaseModel fail with worker_stopped and skips
        // native cleanup, which the real lifecycle measurement guards against.
        await stopLifecycle();
      } finally {
        // Terminate the forked child (if any) only after runtime/model cleanup completes.
        await forkedHandle?.dispose();
      }
    },
  };
}
