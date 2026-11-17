import { parseModelPackManifest, type ModelPackKind, type ModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { getOptionalHappierSherpaNativeModule } from '@happier-dev/sherpa-native';
import { hashModelPackManifest, installModelPackWithHost, ModelPackInstallError, type ModelPackCoreProgress, type ModelPackPromotionPriorInstallV1 } from '@happier-dev/voice-modelpacks';

import { uriToFilePath } from '@/platform/fileUri';
import { forgetSpeakerCountForAssetsDir } from '@/voice/kokoro/runtime/kokoroSpeakerCountCache';

import { getFetch, getFs } from './installer/fs.native';
import {
  createExpoModelPackInstallerHost,
  excludeDirectoryFromBackup,
  getExpoModelPackPartialBytes,
  reconcileExpoModelPackPromotion,
  removeExpoModelPackWithHost,
  findRunningExpoModelPackInstall,
  runExpoModelPackInstall,
  type ExpoModelPackOperationLease,
} from './installer/host.native';
import { fetchRemoteManifest } from './installer/network';
import { assertManifestPathsSafe, getMetaFile, getPackRootDir, normalizePackId } from './installer/paths';
import type { ExpoFsFile, InstallerFs, InstallMode, InstallerOverrides, InvalidatePackRuntime, UpdatePolicy } from './installer/types';

/**
 * Runtime state derived from the live pack directory. Native voice engines and
 * the speaker count are keyed by that stable path, which the installer reuses
 * across replacements, so the derived state must be dropped whenever the bytes
 * behind it change. Resolved here — the one place that owns both the installer
 * host and the app's voice runtime — rather than inside the filesystem host.
 *
 * Both native engine kinds -- the streaming recognizer and the offline TTS engine
 * -- are retired through one sherpa entry point, which owns their lifetime: it
 * drops the cache entries, marks the jobs running against them cancelled, and
 * lets whichever holder releases last destroy the handles, so an in-flight decode
 * or synthesis is never freed underneath.
 *
 * This fails closed and brackets every live-byte mutation. A rejection before
 * mutation leaves the current pack intact; one after mutation prevents the
 * lifecycle action from reporting completion without current runtime state.
 * Letting either call through would leave an engine built from superseded bytes
 * serving despite the update or removal. The native module being absent entirely
 * (web, or a build without the module) is not that case: nothing is cached
 * against the directory, so there is nothing to retire.
 */
function getInvalidatePackRuntime(overrides: InstallerOverrides): InvalidatePackRuntime {
  return overrides.invalidatePackRuntime ?? (async (packDirUri) => {
    const assetsDir = uriToFilePath(packDirUri);
    forgetSpeakerCountForAssetsDir(assetsDir);
    const sherpa = getOptionalHappierSherpaNativeModule();
    if (!sherpa) return;
    if (typeof sherpa.releaseAssetsDir !== 'function') {
      // A native binary older than this JS bundle cannot retire its engines, and
      // proceeding would leave the superseded model serving until the app restarts.
      throw new Error('model_pack_runtime_invalidation_unsupported');
    }
    await sherpa.releaseAssetsDir({ assetsDir });
  });
}

function getExcludeFromBackup(overrides: InstallerOverrides): (directoryUri: string) => Promise<void> {
  return overrides.excludeFromBackup ?? (async (directoryUri) => {
    const sherpa = getOptionalHappierSherpaNativeModule();
    if (!sherpa) return;
    if (!sherpa.excludeFromBackup) {
      console.warn('model_pack_backup_exclusion_unsupported');
      return;
    }
    await sherpa.excludeFromBackup({ path: uriToFilePath(directoryUri) });
  });
}

async function installViaHost(opts: {
  fs: InstallerFs;
  download?: InstallerOverrides['download'];
  invalidatePackRuntime: InvalidatePackRuntime;
  excludeFromBackup: (directoryUri: string) => Promise<void>;
  operationLease?: ExpoModelPackOperationLease;
  packId: string;
  manifest: ModelPackManifest;
  signal: AbortSignal;
  priorInstall: ModelPackPromotionPriorInstallV1;
  priorManifest?: ModelPackManifest;
  onProgress?: (p: ModelPackCoreProgress) => void;
}): Promise<{ packDirUri: string; manifest: ModelPackManifest }> {
  const host = createExpoModelPackInstallerHost({
    fs: opts.fs,
    download: opts.download,
    invalidatePackRuntime: opts.invalidatePackRuntime,
    excludeFromBackup: opts.excludeFromBackup,
    operationLease: opts.operationLease,
  });
  const result = await installModelPackWithHost({
    host,
    packId: opts.packId,
    manifest: opts.manifest,
    signal: opts.signal,
    priorInstall: opts.priorInstall,
    priorManifest: opts.priorManifest,
    onProgress: opts.onProgress,
  });
  return { packDirUri: result.rootLocation, manifest: result.manifest };
}

export async function ensureModelPackInstalled(
  opts: Parameters<typeof installPackWithLease>[0],
  overrides: InstallerOverrides = {},
): Promise<{ packDirUri: string; manifest: ModelPackManifest }> {
  if (opts.mode === 'require_installed' && opts.updatePolicy !== 'manual_update_if_available') {
    return installPackWithLease(opts, overrides);
  }
  const fs = await getFs(overrides);
  const packId = normalizePackId(opts.packId);
  return runExpoModelPackInstall({ fs, packId, signal: opts.signal, onProgress: opts.onProgress,
    identity: JSON.stringify([opts.mode, opts.updatePolicy ?? 'none', opts.manifestUrl?.trim() ?? null, opts.kind ?? null, opts.timeoutMs]),
    run: ({ lease, signal, onProgress }) => installPackWithLease({ ...opts, signal, onProgress }, { ...overrides, fs }, lease),
  });
}

/** A settings observer can reconnect to the installer-owned work after its previous screen unmounted. */
export async function findRunningModelPackInstall(
  opts: { packId: string; kind?: ModelPackKind },
  overrides: InstallerOverrides = {},
): Promise<ReturnType<typeof findRunningExpoModelPackInstall>> {
  const packId = normalizePackId(opts.packId);
  const running = findRunningExpoModelPackInstall(await getFs(overrides), packId);
  return running ? { follow: async (observer: Parameters<typeof running.follow>[0]) => {
    const result = await running.follow(observer);
    assertManifestFor(result.manifest, packId, opts.kind);
    return result;
  } } : null;
}

async function installPackWithLease(
  opts: {
    packId: string | null;
    mode: InstallMode;
    manifestUrl: string | null;
    timeoutMs: number | null;
    signal: AbortSignal;
    onProgress?: (p: ModelPackCoreProgress) => void;
    updatePolicy?: UpdatePolicy;
    kind?: ModelPackKind;
  },
  overrides: InstallerOverrides = {},
  operationLease?: ExpoModelPackOperationLease,
): Promise<{ packDirUri: string; manifest: ModelPackManifest }> {
  const fs = await getFs(overrides);
  const fetchImpl = getFetch(overrides);
  const invalidatePackRuntime = getInvalidatePackRuntime(overrides);
  const id = normalizePackId(opts.packId);
  // X-M1: roll forward/back any swap this pack left interrupted by a crash before
  // inspecting/serving it, so a transiently-missing live dir is never observed.
  await reconcileExpoModelPackPromotion({ fs, packId: id, invalidatePackRuntime, operationLease });
  const rootDir = getPackRootDir(fs, id);

  const meta = getMetaFile(fs, rootDir);
  if (meta.exists) {
    const installedManifest = await readInstalledManifest(meta);
    if (installedManifest) {
      assertManifestFor(installedManifest, id, opts.kind);
      await excludeDirectoryFromBackup(rootDir.uri, getExcludeFromBackup(overrides));
      if (opts.updatePolicy !== 'manual_update_if_available') {
        return { packDirUri: rootDir.uri, manifest: installedManifest };
      }

      if (!opts.manifestUrl || !opts.manifestUrl.trim()) {
        throw new Error('model_pack_manifest_url_missing');
      }

      const remote = await fetchRemoteManifest({
        fetchImpl,
        manifestUrl: opts.manifestUrl.trim(),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
      assertManifestFor(remote, id, opts.kind);
      assertManifestPathsSafe(remote);
      if (hashModelPackManifest(remote) === hashModelPackManifest(installedManifest)) {
        return { packDirUri: rootDir.uri, manifest: installedManifest };
      }

      // Stage-before-delete via the shared core: the live pack is replaced only
      // after the new pack is fully downloaded and verified. A failed/cancelled
      // update leaves the previously-installed pack intact (no data loss).
      return await installViaHost({
        download: overrides.download,
        fs,
        invalidatePackRuntime,
        excludeFromBackup: getExcludeFromBackup(overrides),
        operationLease,
        packId: id,
        manifest: remote,
        priorManifest: installedManifest,
        signal: opts.signal,
        priorInstall: Object.freeze({ scopeKey: `expo-model-pack:${rootDir.uri}`, identityKey: id }),
        onProgress: opts.onProgress,
      });
    }
    // Invalid metadata: fall through to a fresh install below.
  }

  if (opts.mode === 'require_installed') {
    throw new ModelPackInstallError('model_pack_not_installed');
  }

  if (!opts.manifestUrl || !opts.manifestUrl.trim()) {
    throw new Error('model_pack_manifest_url_missing');
  }

  const manifest = await fetchRemoteManifest({
    fetchImpl,
    manifestUrl: opts.manifestUrl.trim(),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  assertManifestFor(manifest, id, opts.kind);
  assertManifestPathsSafe(manifest);

  return await installViaHost({
    download: overrides.download,
    fs,
    invalidatePackRuntime,
    excludeFromBackup: getExcludeFromBackup(overrides),
    operationLease,
    packId: id,
    manifest,
    signal: opts.signal,
    priorInstall: null,
    onProgress: opts.onProgress,
  });
}

async function readInstalledManifest(meta: Pick<ExpoFsFile, 'text'>): Promise<ModelPackManifest | null> {
  const contents = await meta.text();
  try {
    const parsed = JSON.parse(contents);
    return parseModelPackManifest(parsed?.manifest ?? parsed);
  } catch (error) {
    // Parser errors can include receipt contents, so report only their type.
    console.warn('[modelPacks] Failed to read installed model pack manifest', error instanceof Error ? error.name : 'unknown');
    return null;
  }
}

function assertManifestFor(manifest: ModelPackManifest, packId: string, kind?: ModelPackKind): void {
  if (manifest.packId !== packId) throw new Error('model_pack_manifest_packid_mismatch');
  if (kind && manifest.kind !== kind) throw new Error('model_pack_manifest_kind_mismatch');
}

export async function checkModelPackUpdateAvailable(
  opts: {
    packId: string | null;
    manifestUrl: string | null;
    timeoutMs: number | null;
    signal: AbortSignal;
    kind?: ModelPackKind;
  },
  overrides: InstallerOverrides = {},
): Promise<{ installed: boolean; updateAvailable: boolean; installedManifest: ModelPackManifest | null; remoteManifest: ModelPackManifest | null }> {
  const fs = await getFs(overrides);
  const fetchImpl = getFetch(overrides);
  const id = normalizePackId(opts.packId);
  // X-M1: recover an interrupted swap before comparing manifests. The rollback
  // rewrites the live directory, so it retires the engines keyed on it exactly
  // like a promote or a remove does.
  await reconcileExpoModelPackPromotion({
    fs,
    packId: id,
    invalidatePackRuntime: getInvalidatePackRuntime(overrides),
  });
  const rootDir = getPackRootDir(fs, id);
  const meta = getMetaFile(fs, rootDir);

  const installedManifest = meta.exists ? await readInstalledManifest(meta) : null;
  if (installedManifest) assertManifestFor(installedManifest, id, opts.kind);

  if (!opts.manifestUrl || !opts.manifestUrl.trim()) {
    return { installed: Boolean(installedManifest), updateAvailable: false, installedManifest, remoteManifest: null };
  }

  const remote = await fetchRemoteManifest({
    fetchImpl,
    manifestUrl: opts.manifestUrl.trim(),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  assertManifestFor(remote, id, opts.kind);

  if (!installedManifest) {
    return { installed: false, updateAvailable: false, installedManifest: null, remoteManifest: remote };
  }

  return {
    installed: true,
    updateAvailable: hashModelPackManifest(remote) !== hashModelPackManifest(installedManifest),
    installedManifest,
    remoteManifest: remote,
  };
}

export async function getModelPackInstallSummary(
  opts: { packId: string | null },
  overrides: InstallerOverrides = {},
): Promise<{ installed: boolean; packDirUri: string | null; manifest: ModelPackManifest | null; partialBytes: number }> {
  const fs = await getFs(overrides);
  const id = normalizePackId(opts.packId);
  // X-M1: recover an interrupted swap before reporting install state.
  await reconcileExpoModelPackPromotion({
    fs,
    packId: id,
    invalidatePackRuntime: getInvalidatePackRuntime(overrides),
  });
  const rootDir = getPackRootDir(fs, id);
  const meta = getMetaFile(fs, rootDir);

  const manifest = meta.exists ? await readInstalledManifest(meta) : null;
  return {
    installed: manifest !== null, packDirUri: rootDir.uri, manifest,
    partialBytes: manifest ? 0 : getExpoModelPackPartialBytes({ fs, packId: id }),
  };
}

export async function removeModelPack(
  opts: { packId: string | null; signal?: AbortSignal },
  overrides: InstallerOverrides = {},
): Promise<void> {
  const fs = await getFs(overrides);
  const id = normalizePackId(opts.packId);
  await removeExpoModelPackWithHost({
    fs,
    packId: id,
    signal: opts.signal,
    invalidatePackRuntime: getInvalidatePackRuntime(overrides),
  });
}
