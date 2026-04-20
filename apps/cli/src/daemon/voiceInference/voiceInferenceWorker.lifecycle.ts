import { join } from 'node:path';

import type {
  DaemonVoiceInferenceModelStatus,
  DaemonVoiceInferenceNormalizationDecision,
  ModelPackManifest,
} from '@happier-dev/protocol';

import { createInferenceConcurrencyCoordinator } from '@/daemon/inference/inferenceConcurrencyCoordinator';
import {
  createInferenceDiagnostics,
  createUnavailableInferenceDiagnostics,
  type InferenceDiagnostics,
} from '@/daemon/inference/inferenceDiagnostics';
import { createInferenceInstallBookkeeping } from '@/daemon/inference/inferenceInstallBookkeeping';
import { createInferenceWarmupCoordinator } from '@/daemon/inference/inferenceWarmupCoordinator';

import {
  fetchVoiceModelPackManifest,
  hashVoiceModelPackManifest,
  installVoiceModelPack,
  readInstalledVoiceModelPackManifest,
  removeInstalledVoiceModelPack,
  statInstalledVoiceModelPack,
} from './voiceModelPackInstaller';
import { loadDefaultVoiceInferenceRuntime } from './loadDefaultVoiceInferenceRuntime';
import type { VoiceInferenceRuntime } from './voiceInferenceRuntimeTypes';
import { resolveVoiceInferenceIdleResidencyMs, resolveVoiceInferencePerModelConcurrency } from './voiceInferenceWorkerConfig';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';
import {
  createRuntimeUnavailableError,
  createVoiceInferenceError,
  assertVoiceInferencePackIdFilesystemSafe,
  isVoiceInferenceModelKind,
  normalizePackId,
  type RuntimeLoader,
  type VoiceInferenceModelIdentity,
  type WarmRuntimeHandle,
} from './voiceInferenceWorker.shared';

export type VoiceInferenceWorkerLifecycleHandle = Readonly<{
  stop: () => Promise<void>;
  getStatus: () => Promise<Readonly<{
    serviceState: 'unavailable' | 'idle' | 'warming' | 'ready' | 'degraded';
    normalization: DaemonVoiceInferenceNormalizationDecision;
    models: readonly DaemonVoiceInferenceModelStatus[];
  }>>;
  listModels: () => Promise<readonly DaemonVoiceInferenceModelStatus[]>;
  getModelsStatus: (packIds?: readonly string[] | null) => Promise<readonly DaemonVoiceInferenceModelStatus[]>;
  installModel: (input: Readonly<{ packId: string }>) => Promise<DaemonVoiceInferenceModelStatus>;
  removeModel: (packId: string) => Promise<void>;
  warmModelPack: (packId: string) => Promise<void>;
}>;

export type VoiceInferenceWorkerLifecycleContext = Readonly<{
  isStopped: () => boolean;
  getDiagnostics: () => InferenceDiagnostics;
  setDiagnostics: (diagnostics: InferenceDiagnostics) => void;
  runExclusive: <T>(packId: string, work: () => Promise<T>) => Promise<T>;
  runLifecycleExclusive: <T>(packId: string, work: () => Promise<T>) => Promise<T>;
  warmRuntimeForPack: (packId: string, signal?: AbortSignal | null) => Promise<WarmRuntimeHandle>;
}>;

type VoiceInferenceWorkerLifecycleParams = Readonly<{
  runtimeLoader?: RuntimeLoader;
  now?: () => number;
  residencyMs?: number;
  perModelConcurrency?: number;
  onStop?: () => Promise<void> | void;
}>;

export function createVoiceInferenceWorkerLifecycle(params?: VoiceInferenceWorkerLifecycleParams): Readonly<VoiceInferenceWorkerLifecycleHandle & VoiceInferenceWorkerLifecycleContext> {
  const paths = resolveVoiceInferencePaths();
  const now = params?.now ?? (() => Date.now());
  const residencyMs = params?.residencyMs ?? resolveVoiceInferenceIdleResidencyMs();
  const installBookkeeping = createInferenceInstallBookkeeping({
    stateFilePath: paths.installsStateFilePath,
    now,
  });
  const concurrencyCoordinator = createInferenceConcurrencyCoordinator({
    perModelConcurrency: params?.perModelConcurrency ?? resolveVoiceInferencePerModelConcurrency(),
  });
  const warmupCoordinator = createInferenceWarmupCoordinator<VoiceInferenceRuntime>({
    residencyMs,
    onRelease: async (packId) => {
      await concurrencyCoordinator.runLifecycleExclusive(packId, async () => {
        await releaseRuntimeForPack(packId);
      });
    },
  });
  const normalization: DaemonVoiceInferenceNormalizationDecision = {
    inputTransport: 'upload_transfer',
    strategy: 'daemon_decode',
    systemFfmpegAllowed: false,
  };
  const runtimeLoader = params?.runtimeLoader ?? loadDefaultVoiceInferenceRuntime;

  let diagnostics: InferenceDiagnostics = createUnavailableInferenceDiagnostics();
  let stopped = false;
  const warmRuntimeByPackId = new Map<string, WarmRuntimeHandle>();

  async function loadRuntime(): Promise<VoiceInferenceRuntime> {
    try {
      const runtime = await runtimeLoader();
      if (!runtime) {
        diagnostics = createUnavailableInferenceDiagnostics();
        throw createVoiceInferenceError('runtime_unavailable');
      }
      diagnostics = createInferenceDiagnostics({ runtimeState: 'ready' });
      return runtime;
    } catch (error) {
      diagnostics = createUnavailableInferenceDiagnostics();
      throw createRuntimeUnavailableError(error);
    }
  }

  async function releaseRuntimeForPack(packId: string): Promise<void> {
    const warmRuntime = warmRuntimeByPackId.get(packId);
    if (!warmRuntime) {
      return;
    }
    warmRuntimeByPackId.delete(packId);
    await warmRuntime.runtime.releaseModel?.({
      packId,
      packDir: warmRuntime.packDir,
      manifest: warmRuntime.manifest,
    });
  }

  async function clearWarmRuntimeForPack(packId: string): Promise<void> {
    await warmupCoordinator.release(packId, { skipOnRelease: true });
    await releaseRuntimeForPack(packId);
  }

  async function resolveManifestForStatus(packId: string): Promise<ModelPackManifest | null> {
    const installedManifest = await readInstalledVoiceModelPackManifest({ packsRootDir: paths.packsRootDir, packId });
    if (installedManifest) {
      return installedManifest;
    }
    try {
      return await fetchVoiceModelPackManifest({ packId });
    } catch {
      return null;
    }
  }

  async function resolveModelIdentity(
    packId: string,
    manifest: Readonly<{ kind: DaemonVoiceInferenceModelStatus['kind']; model: string }> | null,
  ): Promise<VoiceInferenceModelIdentity> {
    if (manifest) {
      return {
        kind: manifest.kind,
        model: manifest.model,
      };
    }

    const installed = await installBookkeeping.status(packId);
    if (isVoiceInferenceModelKind(installed.kind) && typeof installed.model === 'string' && installed.model.trim().length > 0) {
      return {
        kind: installed.kind,
        model: installed.model,
      };
    }

    throw createVoiceInferenceError('internal_error', 'voice_inference_model_identity_missing');
  }

  async function buildModelStatus(packId: string): Promise<DaemonVoiceInferenceModelStatus> {
    const manifest = await resolveManifestForStatus(packId);
    const identity = await resolveModelIdentity(packId, manifest);
    const installed = await installBookkeeping.status(packId);
    const statResult = await statInstalledVoiceModelPack({ packsRootDir: paths.packsRootDir, packId });
    return {
      packId,
      kind: identity.kind,
      model: identity.model,
      version: installed.version ?? manifest?.version ?? null,
      executionSupport: ['daemon'],
      installState: statResult.exists
        ? installed.state === 'error'
          ? 'error'
          : installed.state === 'installing'
            ? 'installing'
            : 'installed'
        : installed.state === 'installing'
          ? 'installing'
          : installed.state === 'error'
            ? 'error'
            : 'not_installed',
      progress: installed.progress
        ? {
            phase: installed.progress.phase,
            progress: installed.progress.progress,
            bytesDownloaded: installed.progress.bytesDownloaded ?? null,
            totalBytes: installed.progress.totalBytes ?? null,
            message: installed.progress.message ?? null,
          }
        : null,
      lastError: installed.lastError,
      updatedAtMs: Math.trunc(statResult.updatedAtMs),
    };
  }

  async function listKnownPackIds(): Promise<string[]> {
    const installEntries = (await installBookkeeping.list()).map((entry) => entry.modelId);
    return [...new Set(installEntries)];
  }

  async function resolvePackManifest(packId: string): Promise<Readonly<{ packDir: string; manifest: ModelPackManifest }>> {
    const safePackId = assertVoiceInferencePackIdFilesystemSafe(packId);
    const manifest = await readInstalledVoiceModelPackManifest({ packsRootDir: paths.packsRootDir, packId: safePackId });
    if (!manifest) {
      throw createVoiceInferenceError('model_not_installed');
    }
    return {
      packDir: join(paths.packsRootDir, safePackId),
      manifest,
    };
  }

  async function warmRuntimeForPack(packId: string, signal?: AbortSignal | null): Promise<WarmRuntimeHandle> {
    const { packDir, manifest } = await resolvePackManifest(packId);
    diagnostics = { ...diagnostics, runtimeState: 'warming' };
    const runtime = await warmupCoordinator.warm(packId, async () => {
      const loadedRuntime = await loadRuntime();
      await loadedRuntime.warmModel?.({ packId, packDir, manifest, signal });
      return loadedRuntime;
    });
    warmRuntimeByPackId.set(packId, { runtime, packDir, manifest });
    diagnostics = { ...diagnostics, runtimeState: 'ready' };
    return { runtime, packDir, manifest };
  }

  return {
    isStopped: () => stopped,
    getDiagnostics: () => diagnostics,
    setDiagnostics: (next) => {
      diagnostics = next;
    },
    runExclusive: async <T>(packId: string, work: () => Promise<T>): Promise<T> => await concurrencyCoordinator.runExclusive(packId, work),
    runLifecycleExclusive: async <T>(packId: string, work: () => Promise<T>): Promise<T> => await concurrencyCoordinator.runLifecycleExclusive(packId, work),
    warmRuntimeForPack,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await params?.onStop?.();
      const packIds = new Set([...await listKnownPackIds(), ...warmRuntimeByPackId.keys()]);
      for (const packId of packIds) {
        await concurrencyCoordinator.runLifecycleExclusive(packId, async () => {
          await clearWarmRuntimeForPack(packId);
        });
      }
    },
    getStatus: async () => ({
      serviceState:
        diagnostics.runtimeState === 'ready' && (await listKnownPackIds()).length === 0
          ? 'idle'
          : diagnostics.runtimeState === 'downloading'
            ? 'warming'
          : diagnostics.runtimeState === 'error'
            ? 'degraded'
            : diagnostics.runtimeState,
      normalization,
      models: await Promise.all((await listKnownPackIds()).map(async (packId) => await buildModelStatus(packId))),
    }),
    listModels: async () => await Promise.all((await listKnownPackIds()).map(async (packId) => await buildModelStatus(packId))),
    getModelsStatus: async (packIds) => {
      const targetPackIds = packIds && packIds.length > 0 ? [...new Set(packIds)] : await listKnownPackIds();
      return await Promise.all(targetPackIds.map(async (packId) => await buildModelStatus(packId)));
    },
    installModel: async ({ packId }) => {
      const normalizedPackId = normalizePackId(packId);
      if (!normalizedPackId) {
        throw createVoiceInferenceError('internal_error', 'voice_inference_pack_missing');
      }
      const safePackId = assertVoiceInferencePackIdFilesystemSafe(normalizedPackId);
      return await concurrencyCoordinator.runLifecycleExclusive(safePackId, async () => {
        const manifest = await fetchVoiceModelPackManifest({ packId: safePackId });
        await installBookkeeping.install({
          modelId: safePackId,
          version: manifest.version,
          manifestHash: hashVoiceModelPackManifest(manifest),
          kind: manifest.kind,
          model: manifest.model,
          performInstall: async (reportProgress) => {
            await installVoiceModelPack({
              packsRootDir: paths.packsRootDir,
              manifest,
              reportProgress,
            });
          },
        });
        await clearWarmRuntimeForPack(safePackId);
        return await buildModelStatus(safePackId);
      });
    },
    removeModel: async (packId) => {
      const normalizedPackId = normalizePackId(packId);
      if (!normalizedPackId) {
        return;
      }
      const safePackId = assertVoiceInferencePackIdFilesystemSafe(normalizedPackId);
      await concurrencyCoordinator.runLifecycleExclusive(safePackId, async () => {
        await clearWarmRuntimeForPack(safePackId);
        await removeInstalledVoiceModelPack({ packsRootDir: paths.packsRootDir, packId: safePackId });
        await installBookkeeping.remove(safePackId);
      });
    },
    warmModelPack: async (packId) => {
      const normalizedPackId = normalizePackId(packId);
      if (!normalizedPackId) {
        throw createVoiceInferenceError('internal_error', 'voice_inference_pack_missing');
      }
      const safePackId = assertVoiceInferencePackIdFilesystemSafe(normalizedPackId);
      await concurrencyCoordinator.runLifecycleExclusive(safePackId, async () => {
        await warmRuntimeForPack(safePackId);
      });
    },
  };
}
