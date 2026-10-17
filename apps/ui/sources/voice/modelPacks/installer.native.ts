import type { Directory as ExpoDirectory, File as ExpoFile } from 'expo-file-system';
import { parseModelPackManifest, type ModelPackManifest } from '@/voice/modelPacks/manifest';

import { downloadManifestFiles } from './installer/download.native';
import { getFetch, getFs } from './installer/fs.native';
import { fetchRemoteManifest } from './installer/network';
import {
  assertManifestPathsSafe,
  getMetaFile,
  getPackFile,
  getPackRootDir,
  getPackUpdateDir,
  normalizePackId,
} from './installer/paths';
import type { InstallMode, InstallerDirectory, InstallerFs, InstallerOverrides, ModelPackDownloadProgress, UpdatePolicy } from './installer/types';

export type { ModelPackDownloadProgress } from './installer/types';

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

async function readInstalledManifest(meta: Pick<ExpoFile, 'exists' | 'text'>): Promise<ModelPackManifest | null> {
  if (!meta.exists) return null;
  try {
    const parsed = JSON.parse(await meta.text());
    return parseModelPackManifest(parsed?.manifest ?? parsed);
  } catch (error) {
    // Parser errors can include receipt contents, so report only their type.
    console.warn('[modelPacks] Failed to read installed model pack manifest', error instanceof Error ? error.name : 'unknown');
    return null;
  }
}

function deletePack(fs: InstallerFs, id: string): void {
  const rootDir = getPackRootDir(fs, id);
  if (rootDir.exists) rootDir.delete();
  removePackUpdateDir(fs, id);
}

function removePackUpdateDir(fs: InstallerFs, id: string): void {
  const stagingDir = getPackUpdateDir(fs, id);
  if (stagingDir.exists) stagingDir.delete();
}

function writeInstalledManifest(meta: Pick<ExpoFile, 'write'>, manifest: ModelPackManifest): void {
  // Expo File.write creates a missing file. Publishing the receipt is part of installation,
  // so a write failure must reach the caller instead of reporting an unusable pack as ready.
  meta.write(JSON.stringify({ manifest }));
}

async function applyPackUpdate(opts: {
  fs: InstallerFs;
  id: string;
  rootDir: Pick<ExpoDirectory, 'uri'>;
  meta: Pick<ExpoFile, 'exists' | 'delete' | 'write'>;
  installed: ModelPackManifest;
  remote: ModelPackManifest;
  signal: AbortSignal;
  onProgress?: (p: ModelPackDownloadProgress) => void;
}): Promise<void> {
  const installedSha = new Map(opts.installed.files.map((f) => [f.path, f.sha256.toLowerCase()]));
  // Files missing from the pack are fetched as well, so an update also repairs a damaged install.
  const changed = opts.remote.files.filter((f) => (
    installedSha.get(f.path) !== f.sha256.toLowerCase() || !getPackFile(opts.fs, opts.rootDir, f.path).exists
  ));
  const stagingDir = getPackUpdateDir(opts.fs, opts.id);
  stagingDir.create({ intermediates: true, idempotent: true });
  // The installed pack stays untouched until every changed file is verified; staged files survive a
  // failed attempt, so retrying the update resumes instead of starting over.
  await downloadManifestFiles({
    fs: opts.fs,
    rootDir: stagingDir,
    manifest: { ...opts.remote, files: changed },
    signal: opts.signal,
    onProgress: opts.onProgress,
  });

  // While files move the pack is not installed, so an interrupted swap reinstalls instead of loading a
  // mix of builds; the reinstall reuses files that already verify.
  if (opts.meta.exists) opts.meta.delete();
  // Dropped files go first: a new build may turn a dropped file's path into a directory, or a dropped
  // directory's path into a file.
  const remotePaths = new Set(opts.remote.files.map((f) => f.path));
  for (const f of opts.installed.files) {
    if (remotePaths.has(f.path)) continue;
    const dropped = getPackFile(opts.fs, opts.rootDir, f.path);
    if (dropped.exists) dropped.delete();
  }
  for (const f of changed) {
    const target = getPackFile(opts.fs, opts.rootDir, f.path, { createParents: true });
    if (target.exists) target.delete();
    getPackFile(opts.fs, stagingDir, f.path).move(target);
  }
  removePackUpdateDir(opts.fs, opts.id);
  writeInstalledManifest(opts.meta, opts.remote);
}

export async function ensureModelPackInstalled(
  opts: {
    packId: string | null;
    mode: InstallMode;
    manifestUrl: string | null;
    timeoutMs: number;
    signal: AbortSignal;
    onProgress?: (p: ModelPackDownloadProgress) => void;
    updatePolicy?: UpdatePolicy;
  },
  overrides: InstallerOverrides = {},
): Promise<{ packDirUri: string; manifest: ModelPackManifest }> {
  const fs = await getFs(overrides);
  const fetchImpl = getFetch(overrides);
  const id = normalizePackId(opts.packId);
  const rootDir = getPackRootDir(fs, id);

  rootDir.create({ intermediates: true, idempotent: true });

  const meta = getMetaFile(fs, rootDir);
  const installed = await readInstalledManifest(meta);
  if (!installed && meta.exists) {
    // An unreadable record cannot describe the pack; reinstalling re-verifies files already on disk.
    meta.delete();
  }
  if (installed) {
    if (opts.updatePolicy !== 'manual_update_if_available') {
      return { packDirUri: rootDir.uri, manifest: installed };
    }
    if (!opts.manifestUrl || !opts.manifestUrl.trim()) {
      throw new Error('model_pack_manifest_url_missing');
    }
    try {
      const remote = await fetchRemoteManifest({
        fetchImpl,
        manifestUrl: opts.manifestUrl.trim(),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
      if (remote.packId !== id) throw new Error('model_pack_manifest_packid_mismatch');
      assertManifestPathsSafe(remote);
      if (manifestsEqual(remote, installed)) {
        removePackUpdateDir(fs, id);
        return { packDirUri: rootDir.uri, manifest: installed };
      }
      await applyPackUpdate({ fs, id, rootDir, meta, installed, remote, signal: opts.signal, onProgress: opts.onProgress });
      return { packDirUri: rootDir.uri, manifest: remote };
    } catch (error) {
      // Cancelling an update discards its staged files, including ones kept from an earlier failed attempt.
      if (opts.signal.aborted) removePackUpdateDir(fs, id);
      throw error;
    }
  }

  if (opts.mode === 'require_installed') {
    throw new Error('model_pack_not_installed');
  }

  if (!opts.manifestUrl || !opts.manifestUrl.trim()) {
    throw new Error('model_pack_manifest_url_missing');
  }

  let manifest: ModelPackManifest;
  try {
    manifest = await fetchRemoteManifest({
      fetchImpl,
      manifestUrl: opts.manifestUrl.trim(),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    if (manifest.packId !== id) {
      throw new Error('model_pack_manifest_packid_mismatch');
    }
    assertManifestPathsSafe(manifest);
    await downloadManifestFiles({
      fs,
      rootDir,
      manifest,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
  } catch (error) {
    // Cancelling discards the partial pack, including files kept from an earlier failed attempt; after a
    // failure verified files stay so retrying resumes.
    if (opts.signal.aborted) deletePack(fs, id);
    throw error;
  }
  writeInstalledManifest(meta, manifest);
  removePackUpdateDir(fs, id);

  return { packDirUri: rootDir.uri, manifest };
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

  const installedManifest = await readInstalledManifest(meta);

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

function directoryBytes(dir: Pick<InstallerDirectory, 'size'>): number {
  try {
    // expo-file-system sums contained files recursively and reports null for a missing directory.
    const size: unknown = dir.size;
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0;
  } catch (error) {
    console.warn('[modelPacks] Failed to measure model pack directory', error);
    return 0;
  }
}

export async function getModelPackInstallSummary(
  opts: { packId: string | null },
  overrides: InstallerOverrides = {},
): Promise<{ installed: boolean; packDirUri: string | null; manifest: ModelPackManifest | null; partialBytes: number }> {
  const fs = await getFs(overrides);
  const id = normalizePackId(opts.packId);
  const rootDir = getPackRootDir(fs, id);
  const meta = getMetaFile(fs, rootDir);

  const manifest = await readInstalledManifest(meta);
  // A failed install keeps verified files so a retry resumes; report them so they can also be discarded.
  const partialBytes = manifest ? 0 : directoryBytes(rootDir) + directoryBytes(getPackUpdateDir(fs, id));
  return { installed: manifest !== null, packDirUri: rootDir.uri, manifest, partialBytes };
}

export async function removeModelPack(opts: { packId: string | null }, overrides: InstallerOverrides = {}): Promise<void> {
  const fs = await getFs(overrides);
  const id = normalizePackId(opts.packId);
  deletePack(fs, id);
}

