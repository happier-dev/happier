import { join } from 'node:path';

import type {
  DaemonVoiceInferenceModelRuntimeState,
  DaemonVoiceInferenceModelStatus,
  DaemonVoiceInferenceNormalizationDecision,
  ModelPackManifest,
} from '@happier-dev/protocol';
import {
  getModelPackCatalogEntry,
  isPublishedModelPackCatalogEntry,
  listModelPackCatalogEntries,
} from '@happier-dev/protocol';
import {
  deriveVoiceModelPackLicenseTextDigestV1,
  deriveVoiceModelPackManifestDigestV1,
} from '@happier-dev/voice-modelpacks';

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
import {
  assertDaemonVoiceRuntimeManifestCompatible,
  isDaemonVoiceRuntimeFamilySupported,
} from './runtime/runtimeFamilyRegistry';
import type { VoiceInferenceRuntime } from './voiceInferenceRuntimeTypes';
import type { DaemonPublicVoiceModelPackRuntime } from './publicModelPacks/runtime';
import {
  resolveVoiceInferenceIdleResidencyMs,
  resolveVoiceInferenceMaxResidentBytes,
  resolveVoiceInferencePerModelConcurrency,
} from './voiceInferenceWorkerConfig';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';
import {
  createRuntimeUnavailableError,
  createVoiceInferenceError,
  assertVoiceInferencePackIdFilesystemSafe,
  isVoiceInferenceModelKind,
  normalizePackId,
  readVoiceInferenceErrorCode,
  shouldPreserveHealthyDiagnostics,
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
  acceptModelPackLicense: (input: Parameters<DaemonPublicVoiceModelPackRuntime['acceptLicense']>[0]) => Promise<DaemonVoiceInferenceModelStatus>;
  removeModel: (packId: string) => Promise<void>;
  warmModelPack: (packId: string) => Promise<void>;
}>;

export type VoiceInferenceWorkerLifecycleContext = Readonly<{
  isStopped: () => boolean;
  getDiagnostics: () => InferenceDiagnostics;
  setDiagnostics: (diagnostics: InferenceDiagnostics) => void;
  runExclusive: <T>(packId: string, work: () => Promise<T>, options?: Readonly<{ signal?: AbortSignal | null }>) => Promise<T>;
  runLifecycleExclusive: <T>(packId: string, work: () => Promise<T>, options?: Readonly<{ signal?: AbortSignal | null }>) => Promise<T>;
  warmRuntimeForPack: (packId: string, signal?: AbortSignal | null) => Promise<WarmRuntimeHandle>;
}>;

type VoiceInferenceWorkerLifecycleParams = Readonly<{
  runtimeLoader?: RuntimeLoader;
  /**
   * Default/forked packaged runtimes require a published catalog entry and
   * consume its declared file roles. Explicit injected test runtimes own their
   * distinct fixture bytes instead; they still require a known runtime family
   * implemented by this daemon.
   */
  enforceCatalogRuntimeManifest?: boolean;
  now?: () => number;
  residencyMs?: number;
  perModelConcurrency?: number;
  maxResidentBytes?: number;
  publicModelPacks?: DaemonPublicVoiceModelPackRuntime;
  onStop?: () => Promise<void> | void;
  installerOps?: Readonly<{
    fetchManifest?: typeof fetchVoiceModelPackManifest;
    installModelPack?: typeof installVoiceModelPack;
  }>;
}>;

function sumManifestResidentBytes(manifest: ModelPackManifest): number {
  return manifest.files.reduce((total, file) => total + Math.max(0, Math.trunc(file.sizeBytes)), 0);
}

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
  const maxResidentBytes = params?.maxResidentBytes ?? resolveVoiceInferenceMaxResidentBytes();
  // Per-pack readiness/resident bookkeeping for the daemon-side readiness snapshot (T6).
  const runtimeStateByPackId = new Map<string, DaemonVoiceInferenceModelRuntimeState>();
  const residentBytesByPackId = new Map<string, number>();
  // In-use lease count per pack. A pack with active leases is mid-inference and must never
  // be evicted by the memory-budget LRU.
  const inUseCountByPackId = new Map<string, number>();
  const warmupCoordinator = createInferenceWarmupCoordinator<VoiceInferenceRuntime>({
    residencyMs,
    maxResidentBytes,
    resolveResidentBytes: (packId) => residentBytesByPackId.get(packId) ?? 0,
    isInUse: (packId) => (inUseCountByPackId.get(packId) ?? 0) > 0,
    onRelease: async (packId) => {
      runtimeStateByPackId.set(packId, 'evicted');
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
  const enforceCatalogRuntimeManifest = params?.enforceCatalogRuntimeManifest !== false;
  const fetchManifest = params?.installerOps?.fetchManifest ?? fetchVoiceModelPackManifest;
  const installModelPack = params?.installerOps?.installModelPack ?? installVoiceModelPack;
  const publicModelPacks = params?.publicModelPacks;

  function isCatalogRuntimeAdmitted(
    entry: ReturnType<typeof getModelPackCatalogEntry>,
  ): boolean {
    return Boolean(
      entry
      && isDaemonVoiceRuntimeFamilySupported(entry.runtimeFamily)
      && (!enforceCatalogRuntimeManifest || isPublishedModelPackCatalogEntry(entry)),
    );
  }

  let diagnostics: InferenceDiagnostics = createUnavailableInferenceDiagnostics();
  let stopped = false;
  const warmRuntimeByPackId = new Map<string, WarmRuntimeHandle>();
  const stopScopedController = new AbortController();
  const stopScopedPackIds = new Set<string>();

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
    residentBytesByPackId.delete(packId);
    const warmRuntime = warmRuntimeByPackId.get(packId);
    if (!warmRuntime) {
      return;
    }
    warmRuntimeByPackId.delete(packId);
    await warmRuntime.runtime.releaseModel?.({
      packId,
      packDir: warmRuntime.packDir,
      manifest: warmRuntime.manifest,
      runtimeDescriptor: warmRuntime.runtimeDescriptor,
      supportArtifacts: warmRuntime.supportArtifacts,
    });
  }

  async function clearWarmRuntimeForPack(packId: string): Promise<void> {
    await warmupCoordinator.release(packId, { skipOnRelease: true });
    runtimeStateByPackId.delete(packId);
    await releaseRuntimeForPack(packId);
  }

  function resolveRuntimeStateForPack(packId: string): DaemonVoiceInferenceModelRuntimeState {
    return runtimeStateByPackId.get(packId) ?? 'cold';
  }

  async function resolveManifestForStatus(packId: string): Promise<ModelPackManifest | null> {
    const publicEntry = await publicModelPacks?.resolve(packId);
    if (publicEntry) return publicEntry.installedManifest;
    return await readInstalledVoiceModelPackManifest({ packsRootDir: paths.packsRootDir, packId });
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

    const publicEntry = await publicModelPacks?.resolve(packId);
    if (publicEntry?.descriptor?.contribution) {
      return {
        kind: publicEntry.descriptor.contribution.manifest.kind,
        model: publicEntry.descriptor.contribution.manifest.model,
      };
    }

    const catalogEntry = getModelPackCatalogEntry(packId);
    if (catalogEntry) {
      return {
        kind: catalogEntry.kind,
        model: catalogEntry.model,
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
    const publicEntry = await publicModelPacks?.resolve(packId) ?? null;
    const manifest = await resolveManifestForStatus(packId);
    const identity = await resolveModelIdentity(packId, manifest);
    const installed = await installBookkeeping.status(packId);
    const statResult = publicEntry
      ? {
          exists: Boolean(publicEntry.installedMetadata && publicEntry.installedManifest),
          updatedAtMs: publicEntry.installedMetadata?.verifiedAtMs ?? now(),
        }
      : await statInstalledVoiceModelPack({ packsRootDir: paths.packsRootDir, packId });
    const catalogEntry = getModelPackCatalogEntry(packId);
    let runtimeSupported = publicEntry?.descriptor?.contribution
      ? isDaemonVoiceRuntimeFamilySupported(publicEntry.descriptor.contribution.manifest.runtime.family)
        && publicEntry.descriptor.status === 'available'
      : catalogEntry
        ? isCatalogRuntimeAdmitted(catalogEntry)
        : false;
    if (!publicEntry && runtimeSupported && enforceCatalogRuntimeManifest && statResult.exists) {
      if (!manifest) {
        runtimeSupported = false;
      } else {
        try {
          assertDaemonVoiceRuntimeManifestCompatible(packId, manifest);
        } catch {
          runtimeSupported = false;
        }
      }
    }
    return {
      packId,
      pluginIdentity: publicEntry?.identity ?? null,
      kind: identity.kind,
      model: identity.model,
      version: installed.version ?? manifest?.version ?? publicEntry?.descriptor?.contribution?.manifest.version ?? null,
      executionSupport: ['daemon'],
      runtimeFamily: publicEntry?.runtimeDescriptor?.family ?? catalogEntry?.runtimeFamily ?? null,
      runtimeSupported,
      installState: statResult.exists
        ? installed.state === 'installing'
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
      // Additive readiness snapshot fields (T6). Resident bytes are only meaningful while
      // the model is loaded; omit them otherwise so the snapshot stays truthful.
      runtimeState: resolveRuntimeStateForPack(packId),
      ...(residentBytesByPackId.has(packId)
        ? { residentMemoryBytes: residentBytesByPackId.get(packId) ?? 0 }
        : {}),
      ...(publicEntry?.descriptor?.contribution?.manifest.license.requiresAcceptance
        && publicEntry.descriptor.contribution.manifest.license.text
        && publicEntry.descriptor.identity
        ? {
            licenseReview: {
              pluginId: publicEntry.descriptor.identity.pluginId,
              packId: publicEntry.descriptor.identity.packId,
              pluginVersion: publicEntry.descriptor.pluginVersion,
              packVersion: publicEntry.descriptor.contribution.manifest.version,
              licenseId: publicEntry.descriptor.contribution.manifest.license.id,
              licenseTitle: publicEntry.descriptor.contribution.manifest.license.title,
              licenseText: publicEntry.descriptor.contribution.manifest.license.text,
              licenseSourceUrl: publicEntry.descriptor.contribution.manifest.license.url,
              licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(
                publicEntry.descriptor.contribution.manifest.license.text,
              ),
              artifactDigest: publicEntry.descriptor.sourceDigest,
              accepted: publicEntry.descriptor.status !== 'blocked'
                || publicEntry.descriptor.reason !== 'license_acceptance_required',
            },
          }
        : { licenseReview: null }),
    };
  }

  async function listKnownPackIds(): Promise<string[]> {
    const installEntries = (await installBookkeeping.list()).map((entry) => entry.modelId);
    const publicEntries = await publicModelPacks?.list() ?? [];
    const physicallyInstalledCatalogEntries = (
      await Promise.all(listModelPackCatalogEntries().map(async (entry) => (
        (await statInstalledVoiceModelPack({
          packsRootDir: paths.packsRootDir,
          packId: entry.packId,
        })).exists
          ? entry.packId
          : null
      )))
    ).filter((packId): packId is string => packId !== null);
    return [...new Set([
      ...installEntries,
      ...publicEntries.map((entry) => entry.key),
      ...physicallyInstalledCatalogEntries,
    ])];
  }

  async function resolvePackManifest(packId: string): Promise<Readonly<{
    packDir: string;
    manifest: ModelPackManifest;
    runtimeDescriptor: WarmRuntimeHandle['runtimeDescriptor'];
    supportArtifacts: WarmRuntimeHandle['supportArtifacts'];
  }>> {
    const publicEntry = await publicModelPacks?.resolve(packId);
    if (publicEntry) {
      if (
        !publicEntry.installedManifest
        || !publicEntry.runtimeDescriptor
        || publicEntry.descriptor?.loadable !== true
      ) {
        throw createVoiceInferenceError('model_not_installed');
      }
      return {
        packDir: join(paths.packsRootDir, publicEntry.directoryKey),
        manifest: publicEntry.installedManifest,
        runtimeDescriptor: publicEntry.runtimeDescriptor,
        supportArtifacts: publicEntry.supportArtifacts,
      };
    }
    const safePackId = assertVoiceInferencePackIdFilesystemSafe(packId);
    const manifest = await readInstalledVoiceModelPackManifest({ packsRootDir: paths.packsRootDir, packId: safePackId });
    if (!manifest) {
      throw createVoiceInferenceError('model_not_installed');
    }
    if (enforceCatalogRuntimeManifest) {
      assertDaemonVoiceRuntimeManifestCompatible(safePackId, manifest);
    }
    return {
      packDir: join(paths.packsRootDir, safePackId),
      manifest,
      runtimeDescriptor: null,
      supportArtifacts: Object.freeze([]),
    };
  }

  async function warmRuntimeForPack(packId: string, signal?: AbortSignal | null): Promise<WarmRuntimeHandle> {
    const publicEntry = await publicModelPacks?.resolve(packId);
    const catalogEntry = getModelPackCatalogEntry(packId);
    if (!publicEntry && !isCatalogRuntimeAdmitted(catalogEntry)) {
      throw createVoiceInferenceError('unsupported_runtime_family');
    }
    const runtimeFamily = publicEntry?.runtimeDescriptor?.family ?? catalogEntry?.runtimeFamily;
    if (!runtimeFamily || !isDaemonVoiceRuntimeFamilySupported(runtimeFamily)) {
      throw createVoiceInferenceError('unsupported_runtime_family');
    }
    const { packDir, manifest, runtimeDescriptor, supportArtifacts } = await resolvePackManifest(packId);
    diagnostics = { ...diagnostics, runtimeState: 'warming' };
    try {
      const runtime = await warmupCoordinator.warm(packId, async () => {
        runtimeStateByPackId.set(packId, 'warming');
        const loadedRuntime = await loadRuntime();
        try {
          await loadedRuntime.warmModel?.({ packId, packDir, manifest, runtimeDescriptor, supportArtifacts, signal });
          // Prime the loaded engine once so the first real utterance does not pay cold-start
          // latency. Best-effort: priming failures must not block readiness (the model is
          // loaded and usable). Cancellation still propagates as a real abort.
          try {
            await loadedRuntime.primeModel?.({ packId, packDir, manifest, runtimeDescriptor, supportArtifacts, signal });
          } catch (error) {
            if (signal?.aborted) {
              throw error;
            }
          }
        } catch (error) {
          try {
            await loadedRuntime.releaseModel?.({
              packId,
              packDir,
              manifest,
              runtimeDescriptor,
              supportArtifacts,
            });
          } catch {
            // Preserve the originating warm/prime failure; release is best-effort cleanup.
          }
          throw error;
        }
        residentBytesByPackId.set(packId, sumManifestResidentBytes(manifest));
        runtimeStateByPackId.set(packId, 'ready');
        return loadedRuntime;
      });
      warmRuntimeByPackId.set(packId, { runtime, packDir, manifest, runtimeDescriptor, supportArtifacts });
      diagnostics = { ...diagnostics, runtimeState: 'ready' };
      return { runtime, packDir, manifest, runtimeDescriptor, supportArtifacts };
    } catch (error) {
      residentBytesByPackId.delete(packId);
      runtimeStateByPackId.delete(packId);
      if (readVoiceInferenceErrorCode(error) === 'runtime_unavailable') {
        diagnostics = createUnavailableInferenceDiagnostics();
      } else {
        const preserveHealthyDiagnostics = signal?.aborted || shouldPreserveHealthyDiagnostics(error);
        diagnostics = createInferenceDiagnostics({
          runtimeState: preserveHealthyDiagnostics ? 'ready' : 'degraded',
          lastError: preserveHealthyDiagnostics
            ? null
            : error instanceof Error
              ? error.message
              : String(error ?? ''),
        });
      }
      throw error;
    }
  }

  return {
    isStopped: () => stopped,
    getDiagnostics: () => diagnostics,
    setDiagnostics: (next) => {
      diagnostics = next;
    },
    runExclusive: async <T>(packId: string, work: () => Promise<T>, options?: Readonly<{ signal?: AbortSignal | null }>): Promise<T> => {
      // Track the in-use lease so the memory-budget LRU never evicts a model mid-inference.
      inUseCountByPackId.set(packId, (inUseCountByPackId.get(packId) ?? 0) + 1);
      try {
        return await concurrencyCoordinator.runExclusive(packId, work, options);
      } finally {
        const next = (inUseCountByPackId.get(packId) ?? 1) - 1;
        if (next > 0) {
          inUseCountByPackId.set(packId, next);
        } else {
          inUseCountByPackId.delete(packId);
        }
      }
    },
    runLifecycleExclusive: async <T>(packId: string, work: () => Promise<T>, options?: Readonly<{ signal?: AbortSignal | null }>): Promise<T> => await concurrencyCoordinator.runLifecycleExclusive(packId, work, options),
    warmRuntimeForPack,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      stopScopedController.abort();
      await params?.onStop?.();
      const packIds = new Set([...await listKnownPackIds(), ...warmRuntimeByPackId.keys(), ...stopScopedPackIds]);
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
      const publicEntry = await publicModelPacks?.resolve(normalizedPackId);
      if (publicEntry) {
        const descriptor = publicEntry.descriptor;
        if (!descriptor?.installable || !descriptor.contribution) {
          throw createVoiceInferenceError('unsupported_runtime_family');
        }
        const runtimeFamily = descriptor.contribution.manifest.runtime.family;
        if (!isDaemonVoiceRuntimeFamilySupported(runtimeFamily)) {
          throw createVoiceInferenceError('unsupported_runtime_family');
        }
        stopScopedPackIds.add(normalizedPackId);
        try {
          return await concurrencyCoordinator.runLifecycleExclusive(normalizedPackId, async () => {
            const signal = stopScopedController.signal;
            await installBookkeeping.install({
              modelId: normalizedPackId,
              version: descriptor.contribution!.manifest.version,
              manifestHash: deriveVoiceModelPackManifestDigestV1(descriptor.contribution!.manifest),
              kind: descriptor.contribution!.manifest.kind,
              model: descriptor.contribution!.manifest.model,
              performInstall: async (reportProgress) => {
                await publicModelPacks!.install({ key: normalizedPackId, signal, reportProgress });
              },
            });
            await clearWarmRuntimeForPack(normalizedPackId);
            return await buildModelStatus(normalizedPackId);
          }, { signal: stopScopedController.signal });
        } finally {
          stopScopedPackIds.delete(normalizedPackId);
        }
      }
      const safePackId = assertVoiceInferencePackIdFilesystemSafe(normalizedPackId);
      const catalogEntry = getModelPackCatalogEntry(safePackId);
      if (
        !catalogEntry
        || !isCatalogRuntimeAdmitted(catalogEntry)
      ) {
        throw createVoiceInferenceError('unsupported_runtime_family');
      }
      stopScopedPackIds.add(safePackId);
      try {
        return await concurrencyCoordinator.runLifecycleExclusive(safePackId, async () => {
          const signal = stopScopedController.signal;
          const manifest = await fetchManifest({ packId: safePackId, signal });
          if (enforceCatalogRuntimeManifest) {
            assertDaemonVoiceRuntimeManifestCompatible(safePackId, manifest);
          }
          await installBookkeeping.install({
            modelId: safePackId,
            version: manifest.version,
            manifestHash: hashVoiceModelPackManifest(manifest),
            kind: manifest.kind,
            model: manifest.model,
            performInstall: async (reportProgress) => {
              await installModelPack({
                packsRootDir: paths.packsRootDir,
                manifest,
                signal,
                reportProgress,
              });
            },
          });
          await clearWarmRuntimeForPack(safePackId);
          return await buildModelStatus(safePackId);
        }, { signal: stopScopedController.signal });
      } finally {
        stopScopedPackIds.delete(safePackId);
      }
    },
    acceptModelPackLicense: async (input) => {
      if (!publicModelPacks) throw createVoiceInferenceError('unsupported_runtime_family');
      const accepted = await publicModelPacks.acceptLicense(input);
      return await buildModelStatus(accepted.key);
    },
    removeModel: async (packId) => {
      const normalizedPackId = normalizePackId(packId);
      if (!normalizedPackId) {
        return;
      }
      const publicEntry = await publicModelPacks?.resolve(normalizedPackId);
      if (publicEntry) {
        await concurrencyCoordinator.runLifecycleExclusive(normalizedPackId, async () => {
          await clearWarmRuntimeForPack(normalizedPackId);
          await publicModelPacks!.remove(normalizedPackId);
          await installBookkeeping.remove(normalizedPackId);
        });
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
      const publicEntry = await publicModelPacks?.resolve(normalizedPackId);
      const runtimePackId = publicEntry
        ? normalizedPackId
        : assertVoiceInferencePackIdFilesystemSafe(normalizedPackId);
      await concurrencyCoordinator.runLifecycleExclusive(runtimePackId, async () => {
        await warmRuntimeForPack(runtimePackId);
      });
    },
  };
}
