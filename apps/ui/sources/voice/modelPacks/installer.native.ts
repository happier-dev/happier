import { parseModelPackManifest, type ModelPackManifest } from '@happier-dev/protocol';
import { getOptionalHappierSherpaNativeModule } from '@happier-dev/sherpa-native';
import { installModelPackWithHost, type ModelPackPromotionPriorInstallV1 } from '@happier-dev/voice-modelpacks';

import { uriToFilePath } from '@/platform/fileUri';
import { forgetSpeakerCountForAssetsDir } from '@/voice/kokoro/runtime/kokoroSpeakerCountCache';

import { getFetch, getFs } from './installer/fs.native';
import {
  createExpoModelPackInstallerHost,
  reconcileExpoModelPackPromotion,
  removeExpoModelPackWithHost,
} from './installer/host.native';
import { fetchRemoteManifest } from './installer/network';
import { assertManifestPathsSafe, getMetaFile, getPackRootDir, normalizePackId } from './installer/paths';
import type { InstallerFs, InstallMode, InstallerOverrides, InvalidatePackRuntime, UpdatePolicy } from './installer/types';

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
 * This fails closed. It is awaited before the live bytes move, so a rejection
 * aborts the promotion or removal with the pack still intact; letting it through
 * would replace the bytes while the engine built from the predecessor bytes keeps
 * serving, which reads to the user as an update that did nothing. The native
 * module being absent entirely (web, or a build without the module) is not that
 * case: nothing is cached against the directory, so there is nothing to retire.
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

function manifestsEqual(a: ModelPackManifest, b: ModelPackManifest): boolean {
  if (a.packId !== b.packId) return false;
  if (a.files.length !== b.files.length) return false;
  const mapA = new Map(a.files.map((f) => [f.path, f.sha256.toLowerCase()]));
  for (const f of b.files) {
    const sha = mapA.get(f.path);
    if (!sha) return false;
    if (sha !== f.sha256.toLowerCase()) return false;
  }
  return true;
}

async function installViaHost(opts: {
  fs: InstallerFs;
  fetchImpl: typeof fetch;
  invalidatePackRuntime: InvalidatePackRuntime;
  packId: string;
  manifest: ModelPackManifest;
  timeoutMs: number;
  signal: AbortSignal;
  priorInstall: ModelPackPromotionPriorInstallV1;
  onProgress?: (p: { loaded: number; total: number; file?: string }) => void;
}): Promise<{ packDirUri: string; manifest: ModelPackManifest }> {
  const host = createExpoModelPackInstallerHost({
    fs: opts.fs,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    invalidatePackRuntime: opts.invalidatePackRuntime,
  });
  const result = await installModelPackWithHost({
    host,
    packId: opts.packId,
    manifest: opts.manifest,
    signal: opts.signal,
    priorInstall: opts.priorInstall,
    onProgress: opts.onProgress,
  });
  return { packDirUri: result.rootLocation, manifest: result.manifest };
}

export async function ensureModelPackInstalled(
  opts: {
    packId: string | null;
    mode: InstallMode;
    manifestUrl: string | null;
    timeoutMs: number;
    signal: AbortSignal;
    onProgress?: (p: { loaded: number; total: number; file?: string }) => void;
    updatePolicy?: UpdatePolicy;
  },
  overrides: InstallerOverrides = {},
): Promise<{ packDirUri: string; manifest: ModelPackManifest }> {
  const fs = await getFs(overrides);
  const fetchImpl = getFetch(overrides);
  const invalidatePackRuntime = getInvalidatePackRuntime(overrides);
  const id = normalizePackId(opts.packId);
  // X-M1: roll forward/back any swap this pack left interrupted by a crash before
  // inspecting/serving it, so a transiently-missing live dir is never observed.
  await reconcileExpoModelPackPromotion({ fs, packId: id, invalidatePackRuntime });
  const rootDir = getPackRootDir(fs, id);

  const meta = getMetaFile(fs, rootDir);
  if (meta.exists) {
    const installedManifest = await readInstalledManifest(meta);
    if (installedManifest) {
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
      if (remote.packId !== id) throw new Error('model_pack_manifest_packid_mismatch');
      assertManifestPathsSafe(remote);
      if (manifestsEqual(remote, installedManifest)) {
        return { packDirUri: rootDir.uri, manifest: installedManifest };
      }

      // Stage-before-delete via the shared core: the live pack is replaced only
      // after the new pack is fully downloaded and verified. A failed/cancelled
      // update leaves the previously-installed pack intact (no data loss).
      return await installViaHost({
        fs,
        fetchImpl,
        invalidatePackRuntime,
        packId: id,
        manifest: remote,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        priorInstall: Object.freeze({ scopeKey: `expo-model-pack:${rootDir.uri}`, identityKey: id }),
        onProgress: opts.onProgress,
      });
    }
    // Corrupt/unreadable meta: fall through to a fresh install below.
  }

  if (opts.mode === 'require_installed') {
    throw new Error('model_pack_not_installed');
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
  if (manifest.packId !== id) {
    throw new Error('model_pack_manifest_packid_mismatch');
  }
  assertManifestPathsSafe(manifest);

  return await installViaHost({
    fs,
    fetchImpl,
    invalidatePackRuntime,
    packId: id,
    manifest,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    priorInstall: null,
    onProgress: opts.onProgress,
  });
}

async function readInstalledManifest(meta: any): Promise<ModelPackManifest | null> {
  try {
    const parsed = JSON.parse(await meta.text());
    return parseModelPackManifest(parsed?.manifest ?? parsed);
  } catch {
    return null;
  }
}

export async function checkModelPackUpdateAvailable(
  opts: {
    packId: string | null;
    manifestUrl: string | null;
    timeoutMs: number;
    signal: AbortSignal;
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

  let installedManifest: ModelPackManifest | null = null;
  if (meta.exists) {
    try {
      const parsed = JSON.parse(await meta.text());
      installedManifest = parseModelPackManifest(parsed?.manifest ?? parsed);
    } catch {
      installedManifest = null;
    }
  }

  if (!opts.manifestUrl || !opts.manifestUrl.trim()) {
    return { installed: Boolean(installedManifest), updateAvailable: false, installedManifest, remoteManifest: null };
  }

  const remote = await fetchRemoteManifest({
    fetchImpl,
    manifestUrl: opts.manifestUrl.trim(),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  if (remote.packId !== id) throw new Error('model_pack_manifest_packid_mismatch');

  if (!installedManifest) {
    return { installed: false, updateAvailable: false, installedManifest: null, remoteManifest: remote };
  }

  return {
    installed: true,
    updateAvailable: !manifestsEqual(remote, installedManifest),
    installedManifest,
    remoteManifest: remote,
  };
}

export async function getModelPackInstallSummary(
  opts: { packId: string | null },
  overrides: InstallerOverrides = {},
): Promise<{ installed: boolean; packDirUri: string | null; manifest: ModelPackManifest | null }> {
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

  if (!meta.exists) {
    return { installed: false, packDirUri: rootDir.uri, manifest: null };
  }

  try {
    const parsed = JSON.parse(await meta.text());
    const manifest = parseModelPackManifest(parsed?.manifest ?? parsed);
    return { installed: true, packDirUri: rootDir.uri, manifest };
  } catch {
    return { installed: false, packDirUri: rootDir.uri, manifest: null };
  }
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
