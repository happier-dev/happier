import { parseModelPackManifest, type ModelPackManifest } from '@/voice/modelPacks/manifest';

import { downloadManifestFiles } from './installer/download.native';
import { getFetch, getFs } from './installer/fs.native';
import { fetchRemoteManifest } from './installer/network';
import { assertManifestPathsSafe, getMetaFile, getPackRootDir, normalizePackId } from './installer/paths';
import type { InstallMode, InstallerOverrides, UpdatePolicy } from './installer/types';

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
  const rootDir = getPackRootDir(fs, id);

  try {
    rootDir.create({ intermediates: true, idempotent: true });
  } catch {
    // ignore
  }

  const meta = getMetaFile(fs, rootDir);
  if (meta.exists) {
    try {
      const parsed = JSON.parse(await meta.text());
      const manifest = parseModelPackManifest(parsed?.manifest ?? parsed);
      if (opts.updatePolicy !== 'manual_update_if_available') {
        return { packDirUri: rootDir.uri, manifest };
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
      if (manifestsEqual(remote, manifest)) {
        return { packDirUri: rootDir.uri, manifest };
      }

      // Wipe to guarantee no stale files remain (pack contents are manifest-driven).
      try {
        rootDir.delete({ idempotent: true });
      } catch {
        // ignore
      }
      try {
        rootDir.create({ intermediates: true, idempotent: true });
      } catch {
        // ignore
      }

      await downloadManifestFiles({
        fs,
        fetchImpl,
        rootDir,
        manifest: remote,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        onProgress: opts.onProgress,
      });

      try {
        meta.create?.();
      } catch {
        // ignore
      }
      try {
        meta.write(JSON.stringify({ manifest: remote }));
      } catch {
        // ignore
      }
      return { packDirUri: rootDir.uri, manifest: remote };
    } catch {
      try {
        meta.delete();
      } catch {
        // ignore
      }
    }
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

  await downloadManifestFiles({
    fs,
    fetchImpl,
    rootDir,
    manifest,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onProgress: opts.onProgress,
  });

  try {
    meta.create?.();
  } catch {
    // ignore
  }
  try {
    meta.write(JSON.stringify({ manifest }));
  } catch {
    // ignore
  }

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
      rootDir.delete({ idempotent: true });
    }
  } catch {
    // ignore
  }
}

