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
}>): InferenceInstallBookkeeping {
  const now = params.now ?? (() => Date.now());
  const readStateFile = params.readStateFile ?? (async (filePath: string) => await readFile(filePath, 'utf8'));
  const writeStateFile = params.writeStateFile ?? (async (filePath: string, contents: string) => {
    await writeFile(filePath, contents, 'utf8');
  });
  const ensureParentDir = params.ensureParentDir ?? (async (filePath: string) => {
    await mkdir(dirname(filePath), { recursive: true });
  });

  let loaded = false;
  let state: PersistedInstallState = { modelsById: {} };

  async function ensureLoaded(): Promise<void> {
    if (loaded) {
      return;
    }
    loaded = true;
    try {
      const contents = await readStateFile(params.stateFilePath);
      const parsed = JSON.parse(contents);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.modelsById && typeof parsed.modelsById === 'object') {
        state = {
          modelsById: parsed.modelsById as Record<string, InstalledInferenceModel>,
        };
      }
    } catch {
      state = { modelsById: {} };
    }
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
      const reportProgress = async (progress: InferenceInstallProgress): Promise<void> => {
        await writeModel({
          modelId,
          state: progress.phase === 'error' ? 'error' : progress.phase === 'complete' ? 'installed' : 'installing',
          version:
            progress.phase === 'complete' || !preserveInstalledIdentity
              ? version
              : previousModel.version,
          manifestHash:
            progress.phase === 'complete' || !preserveInstalledIdentity
              ? manifestHash
              : previousModel.manifestHash,
          kind: kind ?? previousModel.kind,
          model: model ?? previousModel.model,
          updatedAtMs: now(),
          progress,
          lastError: progress.phase === 'error' ? progress.message ?? null : null,
        });
        await onProgress?.(progress);
      };

      await reportProgress({ phase: 'queued', progress: 0 });
      try {
        await performInstall(reportProgress);
        await reportProgress({ phase: 'complete', progress: 1 });
      } catch (error) {
        await reportProgress({
          phase: 'error',
          progress: 1,
          message: error instanceof Error ? error.message : String(error),
        });
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
