import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type InferenceInstallProgress = Readonly<{
  phase: 'queued' | 'downloading' | 'verifying' | 'installing' | 'complete' | 'error';
  progress: number;
  bytesDownloaded?: number | null;
  totalBytes?: number | null;
  message?: string | null;
}>;

export type InstalledInferenceModel = Readonly<{
  modelId: string;
  state: 'not_installed' | 'installing' | 'installed' | 'error';
  version: string | null;
  manifestHash: string | null;
  kind: string | null;
  model: string | null;
  updatedAtMs: number;
  progress: InferenceInstallProgress | null;
  lastError: string | null;
}>;

type PersistedInstallState = Readonly<{
  modelsById: Record<string, InstalledInferenceModel>;
}>;

const INFERENCE_INSTALL_FAILED_DIAGNOSTIC = 'inference_install_failed';
const INFERENCE_INSTALL_INTERRUPTED_DIAGNOSTIC = 'inference_install_interrupted';

function sanitizeInferenceInstallDiagnostic(value: string): string {
  return value === 'model_pack_sha256_mismatch'
    || value === INFERENCE_INSTALL_INTERRUPTED_DIAGNOSTIC
    ? value
    : INFERENCE_INSTALL_FAILED_DIAGNOSTIC;
}

function sanitizePersistedInstallModel(model: InstalledInferenceModel): InstalledInferenceModel {
  const progress = model.progress;
  const sanitizedProgress = progress && progress.message
    ? {
        ...progress,
        message: progress.phase === 'error'
          ? sanitizeInferenceInstallDiagnostic(progress.message)
          : null,
      }
    : progress;
  return {
    ...model,
    progress: sanitizedProgress,
    lastError: model.lastError
      ? sanitizeInferenceInstallDiagnostic(model.lastError)
      : null,
  };
}

export type InferenceInstallBookkeeping = Readonly<{
  list: () => Promise<InstalledInferenceModel[]>;
  install: (params: Readonly<{
    modelId: string;
    version: string;
    manifestHash: string;
    kind?: string | null;
    model?: string | null;
    onProgress?: (progress: InferenceInstallProgress) => Promise<void> | void;
    performInstall: (reportProgress: (progress: InferenceInstallProgress) => Promise<void>) => Promise<void>;
  }>) => Promise<void>;
  remove: (modelId: string) => Promise<void>;
  status: (modelId: string) => Promise<InstalledInferenceModel>;
}>;

/** Matches the existing model-status observation cadence; progress-only writes need not outrun it. */
export const INFERENCE_INSTALL_PROGRESS_PERSISTENCE_INTERVAL_MS = 750;

function createDefaultInstalledModel(modelId: string, now: number): InstalledInferenceModel {
  return {
    modelId,
    state: 'not_installed',
    version: null,
    manifestHash: null,
    kind: null,
    model: null,
    updatedAtMs: now,
    progress: null,
    lastError: null,
  };
}

export function createInferenceInstallBookkeeping(params: Readonly<{
  stateFilePath: string;
  now?: () => number;
  readStateFile?: (filePath: string) => Promise<string>;
  writeStateFile?: (filePath: string, contents: string) => Promise<void>;
  ensureParentDir?: (filePath: string) => Promise<void>;
  /** Zero preserves immediate persistence for callers without a polling presentation owner. */
  progressPersistenceIntervalMs?: number;
  /**
   * Startup-only integrity decision for an install owned by a predecessor
   * process. The caller supplies the existing artifact verifier; bookkeeping
   * remains the sole owner of the durable presentation state.
   */
  verifyInterruptedInstall?: (
    model: InstalledInferenceModel,
  ) => Promise<'installed' | 'interrupted'>;
}>): InferenceInstallBookkeeping {
  const now = params.now ?? (() => Date.now());
  const readStateFile = params.readStateFile ?? (async (filePath: string) => await readFile(filePath, 'utf8'));
  const writeStateFile = params.writeStateFile ?? (async (filePath: string, contents: string) => {
    await writeFile(filePath, contents, 'utf8');
  });
  const ensureParentDir = params.ensureParentDir ?? (async (filePath: string) => {
    await mkdir(dirname(filePath), { recursive: true });
  });

  let initializationPromise: Promise<void> | null = null;
  let state: PersistedInstallState = { modelsById: {} };

  async function ensureLoaded(): Promise<void> {
    initializationPromise ??= (async () => {
      let shouldRewriteSanitizedState = false;
      try {
        const contents = await readStateFile(params.stateFilePath);
        const parsed = JSON.parse(contents);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.modelsById && typeof parsed.modelsById === 'object') {
          const persistedModels = parsed.modelsById as Record<string, InstalledInferenceModel>;
          state = {
            modelsById: Object.fromEntries(
              Object.entries(persistedModels).map(([modelId, model]) => [
                modelId,
                sanitizePersistedInstallModel(model),
              ]),
            ),
          };
          shouldRewriteSanitizedState =
            JSON.stringify(state.modelsById) !== JSON.stringify(persistedModels);

          if (params.verifyInterruptedInstall) {
            const reconciledEntries = await Promise.all(
              Object.entries(state.modelsById).map(async ([modelId, model]) => {
                if (model.state !== 'installing') return [modelId, model] as const;
                let outcome: 'installed' | 'interrupted' = 'interrupted';
                try {
                  outcome = await params.verifyInterruptedInstall!(model);
                } catch {
                  // Verification failure is the bounded interrupted outcome. The
                  // original provider/filesystem prose must not cross this owner.
                }
                const reconciled: InstalledInferenceModel = outcome === 'installed'
                  ? {
                      ...model,
                      state: 'installed',
                      updatedAtMs: now(),
                      progress: { phase: 'complete', progress: 1 },
                      lastError: null,
                    }
                  : {
                      ...model,
                      state: 'error',
                      updatedAtMs: now(),
                      progress: {
                        phase: 'error',
                        progress: 1,
                        message: INFERENCE_INSTALL_INTERRUPTED_DIAGNOSTIC,
                      },
                      lastError: INFERENCE_INSTALL_INTERRUPTED_DIAGNOSTIC,
                    };
                return [modelId, reconciled] as const;
              }),
            );
            const reconciledModels = Object.fromEntries(reconciledEntries);
            shouldRewriteSanitizedState ||= JSON.stringify(reconciledModels) !== JSON.stringify(state.modelsById);
            state = { modelsById: reconciledModels };
          }
        }
      } catch {
        state = { modelsById: {} };
        return;
      }
      if (shouldRewriteSanitizedState) {
        try {
          await ensureParentDir(params.stateFilePath);
          await writeStateFile(params.stateFilePath, JSON.stringify(state, null, 2));
        } catch {
          // A read-only legacy file must not make its sanitized in-memory status disappear.
          // The same projection boundary will sanitize it again on the next load.
        }
      }
    })();
    await initializationPromise;
  }

  async function save(): Promise<void> {
    await ensureParentDir(params.stateFilePath);
    await writeStateFile(params.stateFilePath, JSON.stringify(state, null, 2));
  }

  function readModel(modelId: string): InstalledInferenceModel {
    return state.modelsById[modelId] ?? createDefaultInstalledModel(modelId, now());
  }

  async function writeModel(model: InstalledInferenceModel): Promise<void> {
    state = {
      modelsById: {
        ...state.modelsById,
        [model.modelId]: model,
      },
    };
    await save();
  }

  return {
    list: async () => {
      await ensureLoaded();
      return Object.values(state.modelsById);
    },
    install: async ({ modelId, version, manifestHash, kind = null, model = null, onProgress, performInstall }) => {
      await ensureLoaded();
      const previousModel = readModel(modelId);
      const preserveInstalledIdentity =
        previousModel.version !== null
        && previousModel.manifestHash !== null;
      let acceptingInstallerProgress = true;
      let progressWriteTail = Promise.resolve();
      let progressWriteFailed = false;
      let progressWriteError: unknown;
      const progressPersistenceIntervalMs = Math.max(0, Math.trunc(params.progressPersistenceIntervalMs ?? 0));
      let pendingProgress: InferenceInstallProgress | null = null;
      let progressTimer: ReturnType<typeof setTimeout> | null = null;
      let lastScheduledPhase: InferenceInstallProgress['phase'] | null = null;

      const persistProgress = (progress: InferenceInstallProgress): Promise<void> => {
        const publicProgress = progress.message
          ? {
              ...progress,
              message: progress.phase === 'error'
                ? sanitizeInferenceInstallDiagnostic(progress.message)
                : null,
            }
            : progress;
        progressWriteTail = progressWriteTail.then(async () => {
          try {
            await writeModel({
              modelId,
              state: publicProgress.phase === 'error' ? 'error' : publicProgress.phase === 'complete' ? 'installed' : 'installing',
              version:
                publicProgress.phase === 'complete' || !preserveInstalledIdentity
                  ? version
                  : previousModel.version,
              manifestHash:
                publicProgress.phase === 'complete' || !preserveInstalledIdentity
                  ? manifestHash
                  : previousModel.manifestHash,
              kind: kind ?? previousModel.kind,
              model: model ?? previousModel.model,
              updatedAtMs: now(),
              progress: publicProgress,
              lastError: publicProgress.phase === 'error' ? publicProgress.message ?? null : null,
            });
            await onProgress?.(publicProgress);
          } catch (error) {
            if (!progressWriteFailed) {
              progressWriteFailed = true;
              progressWriteError = error;
            }
          }
        });
        return progressWriteTail;
      };

      const throwIfProgressWriteFailed = (): void => {
        if (progressWriteFailed) {
          throw progressWriteError;
        }
      };

      const clearProgressTimer = (): void => {
        if (progressTimer !== null) {
          clearTimeout(progressTimer);
          progressTimer = null;
        }
      };

      const flushPendingProgress = async (): Promise<void> => {
        clearProgressTimer();
        const latest = pendingProgress;
        pendingProgress = null;
        if (latest) await persistProgress(latest);
      };

      const reportProgress = async (progress: InferenceInstallProgress): Promise<void> => {
        if (!acceptingInstallerProgress) {
          return;
        }
        const phaseTransition = progress.phase !== lastScheduledPhase;
        lastScheduledPhase = progress.phase;
        if (progressPersistenceIntervalMs === 0 || phaseTransition) {
          pendingProgress = null;
          clearProgressTimer();
          await persistProgress(progress);
          return;
        }
        pendingProgress = progress;
        if (progressTimer === null) {
          progressTimer = setTimeout(() => {
            progressTimer = null;
            const latest = pendingProgress;
            pendingProgress = null;
            if (latest && acceptingInstallerProgress) void persistProgress(latest);
          }, progressPersistenceIntervalMs);
          progressTimer.unref?.();
        }
      };

      await reportProgress({ phase: 'queued', progress: 0 });
      throwIfProgressWriteFailed();
      try {
        await performInstall(reportProgress);
        await flushPendingProgress();
        await progressWriteTail;
        throwIfProgressWriteFailed();
        acceptingInstallerProgress = false;
        await persistProgress({ phase: 'complete', progress: 1 });
        throwIfProgressWriteFailed();
      } catch (error) {
        acceptingInstallerProgress = false;
        pendingProgress = null;
        clearProgressTimer();
        const progressWriteErrorBeforeTerminal = progressWriteError;
        await persistProgress({
          phase: 'error',
          progress: 1,
          // Installer/runtime failures can contain provider prose, local paths, or
          // credential material. Keep the original error for internal control flow,
          // but persist and project only the bounded host-owned public taxonomy.
          message: error instanceof Error ? error.message : INFERENCE_INSTALL_FAILED_DIAGNOSTIC,
        });
        if (progressWriteError !== progressWriteErrorBeforeTerminal) {
          throw progressWriteError;
        }
        throw error;
      }
    },
    remove: async (modelId) => {
      await ensureLoaded();
      const next = { ...state.modelsById };
      delete next[modelId];
      state = { modelsById: next };
      await save();
    },
    status: async (modelId) => {
      await ensureLoaded();
      return readModel(modelId);
    },
  };
}
