import { parseModelPackManifest, type ModelPackManifest } from '@happier-dev/protocol';
import { installModelPackWithHost } from '@happier-dev/voice-modelpacks';

import { getFetch, getFs } from './installer/fs.native';
import { createExpoModelPackInstallerHost, reconcileExpoModelPackPromotion } from './installer/host.native';
import { fetchRemoteManifest } from './installer/network';
import { assertManifestPathsSafe, getMetaFile, getPackRootDir, normalizePackId } from './installer/paths';
import type { InstallerFs, InstallMode, InstallerOverrides, UpdatePolicy } from './installer/types';

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
  packId: string;
  manifest: ModelPackManifest;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (p: { loaded: number; total: number; file?: string }) => void;
}): Promise<{ packDirUri: string; manifest: ModelPackManifest }> {
  const host = createExpoModelPackInstallerHost({
    fs: opts.fs,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  const result = await installModelPackWithHost({
    host,
    packId: opts.packId,
    manifest: opts.manifest,
    signal: opts.signal,
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
  const id = normalizePackId(opts.packId);
  // X-M1: roll forward/back any swap this pack left interrupted by a crash before
  // inspecting/serving it, so a transiently-missing live dir is never observed.
  reconcileExpoModelPackPromotion({ fs, packId: id });
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
        packId: id,
        manifest: remote,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
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
    packId: id,
    manifest,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
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
  reconcileExpoModelPackPromotion({ fs, packId: id });
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

export async function removeModelPack(opts: { packId: string | null }, overrides: InstallerOverrides = {}): Promise<void> {
  const fs = await getFs(overrides);
  const id = normalizePackId(opts.packId);
  const rootDir = getPackRootDir(fs, id);
  try {
    if (rootDir.exists) {
      rootDir.delete?.({ idempotent: true });
    }
  } catch {
    // ignore
  }
}
