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
  verifyInstalledModelPackWithHost,
} from '@happier-dev/voice-modelpacks';

import { createInferenceConcurrencyCoordinator } from '@/daemon/inference/inferenceConcurrencyCoordinator';
import {
  createInferenceDiagnostics,
  createUnavailableInferenceDiagnostics,
  type InferenceDiagnostics,
} from '@/daemon/inference/inferenceDiagnostics';
import {
  createInferenceInstallBookkeeping,
  INFERENCE_INSTALL_PROGRESS_PERSISTENCE_INTERVAL_MS,
} from '@/daemon/inference/inferenceInstallBookkeeping';
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
import { createNodeInstalledModelPackIntegrityHost } from './nodeModelPackIntegrityHost';
import {
  resolveVoiceInferenceIdleResidencyMs,
  resolveVoiceInferenceMaxLoadedArtifactBytes,
  resolveVoiceInferencePerModelConcurrency,
} from './voiceInferenceWorkerConfig';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';
import {
  createRuntimeUnavailableError,
  createVoiceInferenceError,
  assertVoiceInferencePackIdFilesystemSafe,
  isVoiceInferenceRuntimeInvalidatingError,
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
  installModel: (input: Readonly<{
    packId: string;
    /**
     * The requesting caller's lifetime. An install legitimately runs for
     * minutes, so the caller giving up has to reach the installer: without it
     * the download keeps running and still publishes the pack and its metadata
     * long after nobody is waiting for it.
     */
    signal?: AbortSignal | null;
  }>) => Promise<DaemonVoiceInferenceModelStatus>;
  acceptModelPackLicense: (input: Parameters<DaemonPublicVoiceModelPackRuntime['acceptLicense']>[0]) => Promise<DaemonVoiceInferenceModelStatus>;
  removeModel: (packId: string) => Promise<void>;
  warmModelPack: (packId: string, signal?: AbortSignal | null) => Promise<void>;
}>;

export type VoiceInferenceWorkerLifecycleContext = Readonly<{
  isStopped: () => boolean;
  getDiagnostics: () => InferenceDiagnostics;
  setDiagnostics: (diagnostics: InferenceDiagnostics) => void;
  runExclusive: <T>(packId: string, work: () => Promise<T>, options?: Readonly<{ signal?: AbortSignal | null }>) => Promise<T>;
  runLifecycleExclusive: <T>(packId: string, work: () => Promise<T>, options?: Readonly<{ signal?: AbortSignal | null }>) => Promise<T>;
  warmRuntimeForPack: (packId: string, signal?: AbortSignal | null) => Promise<WarmRuntimeHandle>;
}>;

type PublicModelPackEntry = Awaited<ReturnType<DaemonPublicVoiceModelPackRuntime['list']>>[number];
type PublicModelPackSnapshot = ReadonlyMap<string, PublicModelPackEntry>;

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
  maxLoadedArtifactBytes?: number;
  publicModelPacks?: DaemonPublicVoiceModelPackRuntime;
  onStop?: () => Promise<void> | void;
  installerOps?: Readonly<{
    fetchManifest?: typeof fetchVoiceModelPackManifest;
    installModelPack?: typeof installVoiceModelPack;
  }>;
}>;

function sumManifestLoadedArtifactBytes(manifest: ModelPackManifest): number {
  return manifest.files.reduce((total, file) => total + Math.max(0, Math.trunc(file.sizeBytes)), 0);
}

export function createVoiceInferenceWorkerLifecycle(params?: VoiceInferenceWorkerLifecycleParams): Readonly<VoiceInferenceWorkerLifecycleHandle & VoiceInferenceWorkerLifecycleContext> {
  const paths = resolveVoiceInferencePaths();
  const now = params?.now ?? (() => Date.now());
  const residencyMs = params?.residencyMs ?? resolveVoiceInferenceIdleResidencyMs();
  const publicModelPacks = params?.publicModelPacks;
  const installedIntegrityHost = createNodeInstalledModelPackIntegrityHost(paths.packsRootDir);
  const installBookkeeping = createInferenceInstallBookkeeping({
    stateFilePath: paths.installsStateFilePath,
    now,
    progressPersistenceIntervalMs: INFERENCE_INSTALL_PROGRESS_PERSISTENCE_INTERVAL_MS,
    verifyInterruptedInstall: async (installed) => {
      if (!installed.version || !installed.manifestHash) return 'interrupted';
      const publicEntry = await publicModelPacks?.resolve(installed.modelId);
      if (publicEntry) {
        const manifest = publicEntry.descriptor?.loadable === true
          ? publicEntry.installedManifest
          : null;
        return manifest
          && publicEntry.installedMetadata?.manifestDigest === installed.manifestHash
          && manifest.version === installed.version
          ? 'installed'
          : 'interrupted';
      }
      const manifest = await readInstalledVoiceModelPackManifest({
        packsRootDir: paths.packsRootDir,
        packId: installed.modelId,
      });
      if (
        !manifest
        || manifest.version !== installed.version
        || hashVoiceModelPackManifest(manifest) !== installed.manifestHash
      ) {
        return 'interrupted';
      }
      await verifyInstalledModelPackWithHost({
        host: installedIntegrityHost,
        packId: installed.modelId,
        expectedManifest: manifest,
        actualManifest: manifest,
      });
      return 'installed';
    },
  });
  const concurrencyCoordinator = createInferenceConcurrencyCoordinator({
    perModelConcurrency: params?.perModelConcurrency ?? resolveVoiceInferencePerModelConcurrency(),
  });
  const maxLoadedArtifactBytes = params?.maxLoadedArtifactBytes ?? resolveVoiceInferenceMaxLoadedArtifactBytes();
  // Per-pack readiness/declared-artifact bookkeeping for the daemon-side readiness snapshot (T6).
  const runtimeStateByPackId = new Map<string, DaemonVoiceInferenceModelRuntimeState>();
  const loadedArtifactBytesByPackId = new Map<string, number>();
  // In-use lease count per pack. A pack with active leases is mid-inference and must never
  // be evicted by the memory-budget LRU.
  const inUseCountByPackId = new Map<string, number>();
  const warmupCoordinator = createInferenceWarmupCoordinator<WarmRuntimeHandle>({
    residencyMs,
    maxLoadedBytes: maxLoadedArtifactBytes,
    resolveLoadedBytes: (packId) => loadedArtifactBytesByPackId.get(packId) ?? 0,
    isInUse: (packId) => (inUseCountByPackId.get(packId) ?? 0) > 0,
    onRelease: async (packId, warmRuntime) => {
      await concurrencyCoordinator.runLifecycleExclusive(packId, async () => {
        const currentWarmRuntime = warmRuntimeByPackId.get(packId);
        if (currentWarmRuntime === warmRuntime) {
          runtimeStateByPackId.set(packId, 'evicted');
        }
        await releaseRuntimeForPack(packId, warmRuntime);
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
  // Attempt-local currentness latch for public runtimes. The plugin reload
  // controller remains the event owner; this map only identifies which exact
  // warm resources that event must retire.
  const warmPublicPluginIdByPackId = new Map<string, string>();
  const stopScopedController = new AbortController();
  const stopScopedPackIds = new Set<string>();
  let publicInvalidationTail = Promise.resolve();
  let unsubscribePublicInvalidations: (() => void) | null = null;
  let publicInvalidationEpoch = 0;

  function throwIfWarmAborted(signal: AbortSignal | null | undefined): void {
    if (signal?.aborted) {
      throw createVoiceInferenceError('cancelled');
    }
  }

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

  async function releaseRuntimeForPack(
    packId: string,
    expectedWarmRuntime?: WarmRuntimeHandle,
  ): Promise<void> {
    const currentWarmRuntime = warmRuntimeByPackId.get(packId);
    const warmRuntime = expectedWarmRuntime ?? currentWarmRuntime;
    if (!warmRuntime) {
      loadedArtifactBytesByPackId.delete(packId);
      return;
    }
    const releasesCurrentRuntime = currentWarmRuntime === warmRuntime;
    if (releasesCurrentRuntime) {
      loadedArtifactBytesByPackId.delete(packId);
      warmRuntimeByPackId.delete(packId);
    }
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
    warmPublicPluginIdByPackId.delete(packId);
    await releaseRuntimeForPack(packId);
  }

  function resolveRuntimeStateForPack(packId: string): DaemonVoiceInferenceModelRuntimeState {
    return runtimeStateByPackId.get(packId) ?? 'cold';
  }

  async function readPublicModelPackSnapshot(): Promise<PublicModelPackSnapshot> {
    const entries = await publicModelPacks?.list() ?? [];
    return new Map(entries.map((entry) => [entry.key, entry]));
  }

  async function resolveManifestForStatus(
    packId: string,
    publicSnapshot: PublicModelPackSnapshot,
  ): Promise<ModelPackManifest | null> {
    const publicEntry = publicSnapshot.get(packId);
    if (publicEntry) return publicEntry.installedManifest;
    return await readInstalledVoiceModelPackManifest({ packsRootDir: paths.packsRootDir, packId });
  }

  async function resolveModelIdentity(
    packId: string,
    manifest: Readonly<{ kind: DaemonVoiceInferenceModelStatus['kind']; model: string }> | null,
    publicSnapshot: PublicModelPackSnapshot,
  ): Promise<VoiceInferenceModelIdentity> {
    if (manifest) {
      return {
        kind: manifest.kind,
        model: manifest.model,
      };
    }

    const publicEntry = publicSnapshot.get(packId);
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

  async function buildModelStatus(
    packId: string,
    publicSnapshot: PublicModelPackSnapshot,
  ): Promise<DaemonVoiceInferenceModelStatus> {
    const publicEntry = publicSnapshot.get(packId) ?? null;
    const manifest = await resolveManifestForStatus(packId, publicSnapshot);
    const identity = await resolveModelIdentity(packId, manifest, publicSnapshot);
    const installed = await installBookkeeping.status(packId);
    const statResult = publicEntry
      ? {
          exists: Boolean(publicEntry.installedMetadata && publicEntry.installedManifest),
          updatedAtMs: publicEntry.installedMetadata?.verifiedAtMs ?? now(),
        }
      : await statInstalledVoiceModelPack({ packsRootDir: paths.packsRootDir, packId });
    // Interrupted-install reconciliation is the canonical integrity decision.
    // A retained pack.json is only a shallow recovery/discard locator and must
    // not overrule the verifier's durable error result after restart.
    const reconciledArtifactRejected = installed.state === 'error'
      && installed.lastError === 'inference_install_interrupted';
    const installedArtifactExists = statResult.exists && !reconciledArtifactRejected;
    const catalogEntry = getModelPackCatalogEntry(packId);
    const declaredVoices = publicEntry?.descriptor?.contribution?.manifest.voices
      ?? manifest?.voices
      ?? [];
    const declaredDefaultVoiceId = publicEntry?.descriptor?.contribution?.manifest.defaultVoiceId
      ?? manifest?.defaultVoiceId
      ?? declaredVoices[0]?.id
      ?? null;
    let runtimeSupported = publicEntry?.descriptor?.contribution
      ? isDaemonVoiceRuntimeFamilySupported(publicEntry.descriptor.contribution.manifest.runtime.family)
        && publicEntry.descriptor.status === 'available'
      : catalogEntry
        ? isCatalogRuntimeAdmitted(catalogEntry)
        : false;
    if (reconciledArtifactRejected) {
      runtimeSupported = false;
    } else if (!publicEntry && runtimeSupported && enforceCatalogRuntimeManifest && installedArtifactExists) {
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
      installState: installedArtifactExists
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
      updatedAtMs: Math.trunc(reconciledArtifactRejected ? installed.updatedAtMs : statResult.updatedAtMs),
      // Additive readiness snapshot fields (T6). The declared artifact byte count is only
      // meaningful while that pack's runtime is loaded; it is not process-memory telemetry.
      runtimeState: resolveRuntimeStateForPack(packId),
      ...(loadedArtifactBytesByPackId.has(packId)
        ? { loadedArtifactBytes: loadedArtifactBytesByPackId.get(packId) ?? 0 }
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
              artifactBinding: publicEntry.descriptor.artifactBinding,
              accepted: publicEntry.descriptor.status !== 'blocked'
                || publicEntry.descriptor.reason !== 'license_acceptance_required',
            },
          }
        : { licenseReview: null }),
      ...(identity.kind === 'tts_sherpa'
        ? {
            voices: declaredVoices,
            defaultVoiceId: declaredDefaultVoiceId,
          }
        : {}),
    };
  }

  async function listKnownPackIds(publicSnapshot: PublicModelPackSnapshot): Promise<string[]> {
    const installEntries = (await installBookkeeping.list()).map((entry) => entry.modelId);
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
      ...publicSnapshot.keys(),
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
    const warmSignal = signal
      ? AbortSignal.any([stopScopedController.signal, signal])
      : stopScopedController.signal;
    throwIfWarmAborted(warmSignal);
    const resolveInvalidationEpoch = publicInvalidationEpoch;
    const publicEntry = await publicModelPacks?.resolve(packId);
    throwIfWarmAborted(warmSignal);
    if (publicEntry && resolveInvalidationEpoch !== publicInvalidationEpoch) {
      // Resolution may have retained an old registry lease. Any reload while
      // it was pending makes that descriptor generation unprovable; retry must
      // re-resolve through the current public catalog before native admission.
      throw createVoiceInferenceError('runtime_unavailable', 'voice_inference_public_pack_generation_stale');
    }
    if (publicEntry) {
      // Publish the currentness latch before native warm can yield so a plugin
      // reload during warm queues retirement behind the existing lifecycle
      // lock rather than missing this soon-to-be-live runtime.
      warmPublicPluginIdByPackId.set(packId, publicEntry.identity.pluginId);
    } else {
      warmPublicPluginIdByPackId.delete(packId);
    }
    const catalogEntry = getModelPackCatalogEntry(packId);
    if (!publicEntry && !isCatalogRuntimeAdmitted(catalogEntry)) {
      throw createVoiceInferenceError('unsupported_runtime_family');
    }
    const runtimeFamily = publicEntry?.runtimeDescriptor?.family ?? catalogEntry?.runtimeFamily;
    if (!runtimeFamily || !isDaemonVoiceRuntimeFamilySupported(runtimeFamily)) {
      throw createVoiceInferenceError('unsupported_runtime_family');
    }
    const { packDir, manifest, runtimeDescriptor, supportArtifacts } = await resolvePackManifest(packId);
    throwIfWarmAborted(warmSignal);
    diagnostics = { ...diagnostics, runtimeState: 'warming' };
    try {
      const warmRuntime = await warmupCoordinator.warm(packId, async () => {
        runtimeStateByPackId.set(packId, 'warming');
        const loadedRuntime = await loadRuntime();
        try {
          throwIfWarmAborted(warmSignal);
          await loadedRuntime.warmModel?.({ packId, packDir, manifest, runtimeDescriptor, supportArtifacts, signal: warmSignal });
          // A native call can return a late ordinary success after its cancellation signal. Do not
          // publish that stale runtime; cancellation owns the terminal fact and cleanup below.
          throwIfWarmAborted(warmSignal);
          // Prime the loaded engine once so the first real utterance does not pay cold-start
          // latency. Best-effort: priming failures must not block readiness (the model is
          // loaded and usable). Cancellation still propagates as a real abort.
          try {
            await loadedRuntime.primeModel?.({ packId, packDir, manifest, runtimeDescriptor, supportArtifacts, signal: warmSignal });
          } catch (error) {
            if (warmSignal.aborted || isVoiceInferenceRuntimeInvalidatingError(error)) {
              throw error;
            }
          }
          throwIfWarmAborted(warmSignal);
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
        loadedArtifactBytesByPackId.set(packId, sumManifestLoadedArtifactBytes(manifest));
        runtimeStateByPackId.set(packId, 'ready');
        return { runtime: loadedRuntime, packDir, manifest, runtimeDescriptor, supportArtifacts };
      });
      warmRuntimeByPackId.set(packId, warmRuntime);
      diagnostics = { ...diagnostics, runtimeState: 'ready' };
      return warmRuntime;
    } catch (error) {
      loadedArtifactBytesByPackId.delete(packId);
      runtimeStateByPackId.delete(packId);
      warmPublicPluginIdByPackId.delete(packId);
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

  unsubscribePublicInvalidations = publicModelPacks?.subscribeInvalidations?.((changedPluginIds) => {
    if (changedPluginIds.length === 0) return;
    publicInvalidationEpoch += 1;
    const changed = new Set(changedPluginIds);
    const retiredPackIds = [...warmPublicPluginIdByPackId.entries()]
      .filter(([, pluginId]) => changed.has(pluginId))
      .map(([packId]) => packId);
    if (retiredPackIds.length === 0) return;
    publicInvalidationTail = publicInvalidationTail.then(async () => {
      for (const packId of retiredPackIds) {
        await concurrencyCoordinator.runLifecycleExclusive(packId, async () => {
          // A reload/update/disable event ends the admitted runtime epoch. A
          // later inference re-resolves and re-verifies the current plugin
          // generation before warming again.
          await clearWarmRuntimeForPack(packId);
        });
      }
    }).catch((error) => {
      diagnostics = createInferenceDiagnostics({
        runtimeState: 'degraded',
        lastError: error instanceof Error ? error.message : 'voice_inference_public_runtime_release_failed',
      });
    });
  }) ?? null;

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
      unsubscribePublicInvalidations?.();
      unsubscribePublicInvalidations = null;
      await publicInvalidationTail;
      await params?.onStop?.();
      const publicSnapshot = await readPublicModelPackSnapshot();
      const packIds = new Set([...await listKnownPackIds(publicSnapshot), ...warmRuntimeByPackId.keys(), ...stopScopedPackIds]);
      for (const packId of packIds) {
        await concurrencyCoordinator.runLifecycleExclusive(packId, async () => {
          await clearWarmRuntimeForPack(packId);
        });
      }
    },
    getStatus: async () => {
      const publicSnapshot = await readPublicModelPackSnapshot();
      const packIds = await listKnownPackIds(publicSnapshot);
      return {
        serviceState:
          diagnostics.runtimeState === 'ready' && packIds.length === 0
            ? 'idle'
            : diagnostics.runtimeState === 'downloading'
              ? 'warming'
              : diagnostics.runtimeState === 'error'
                ? 'degraded'
                : diagnostics.runtimeState,
        normalization,
        models: await Promise.all(packIds.map(async (packId) => await buildModelStatus(packId, publicSnapshot))),
      };
    },
    listModels: async () => {
      const publicSnapshot = await readPublicModelPackSnapshot();
      return await Promise.all((await listKnownPackIds(publicSnapshot)).map(async (packId) => await buildModelStatus(packId, publicSnapshot)));
    },
    getModelsStatus: async (packIds) => {
      const publicSnapshot = await readPublicModelPackSnapshot();
      const targetPackIds = packIds && packIds.length > 0 ? [...new Set(packIds)] : await listKnownPackIds(publicSnapshot);
      return await Promise.all(targetPackIds.map(async (packId) => await buildModelStatus(packId, publicSnapshot)));
    },
    installModel: async ({ packId, signal: callerSignal }) => {
      // Daemon shutdown and caller abandonment both cancel this install.
      const installSignal = callerSignal
        ? AbortSignal.any([stopScopedController.signal, callerSignal])
        : stopScopedController.signal;
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
            const signal = installSignal;
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
            return await buildModelStatus(normalizedPackId, await readPublicModelPackSnapshot());
          }, { signal: installSignal });
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
          const signal = installSignal;
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
          return await buildModelStatus(safePackId, await readPublicModelPackSnapshot());
        }, { signal: installSignal });
      } finally {
        stopScopedPackIds.delete(safePackId);
      }
    },
    acceptModelPackLicense: async (input) => {
      if (!publicModelPacks) throw createVoiceInferenceError('unsupported_runtime_family');
      const accepted = await publicModelPacks.acceptLicense(input);
      return await buildModelStatus(accepted.key, await readPublicModelPackSnapshot());
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
    warmModelPack: async (packId, callerSignal) => {
      const warmSignal = callerSignal
        ? AbortSignal.any([stopScopedController.signal, callerSignal])
        : stopScopedController.signal;
      const normalizedPackId = normalizePackId(packId);
      if (!normalizedPackId) {
        throw createVoiceInferenceError('internal_error', 'voice_inference_pack_missing');
      }
      // Public resolution belongs exclusively inside warmRuntimeForPack where
      // the reload epoch fences its retained registry lease. Built-in catalog
      // ids are the only ids that need filesystem validation before admission;
      // an unknown external id is rejected before it can reach a disk owner.
      const runtimePackId = getModelPackCatalogEntry(normalizedPackId)
        ? assertVoiceInferencePackIdFilesystemSafe(normalizedPackId)
        : normalizedPackId;
      await concurrencyCoordinator.runLifecycleExclusive(runtimePackId, async () => {
        await warmRuntimeForPack(runtimePackId, warmSignal);
      }, { signal: warmSignal });
    },
  };
}
