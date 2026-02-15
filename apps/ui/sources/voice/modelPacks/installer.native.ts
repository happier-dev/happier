import { digest } from '@/platform/digest';
import { parseModelPackManifest, type ModelPackManifest } from '@/voice/modelPacks/manifest';

type InstallMode = 'require_installed' | 'download_if_missing';
type UpdatePolicy = 'none' | 'manual_update_if_available';

type InstallerFs = {
  Directory: any;
  File: any;
  Paths: { document: any };
};

type InstallerOverrides = {
  fs?: InstallerFs;
  fetch?: typeof fetch;
};

type Progress = { loaded: number; total: number };

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function filePathParts(path: string): string[] {
  const raw = path.trim();
  if (!raw) throw new Error('model_pack_invalid_path');
  if (raw.startsWith('/') || raw.startsWith('\\')) throw new Error('model_pack_invalid_path');
  if (raw.includes('\\')) throw new Error('model_pack_invalid_path');
  if (raw.includes('\0')) throw new Error('model_pack_invalid_path');

  const parts = raw
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('model_pack_invalid_path');
  for (const p of parts) {
    if (p === '.' || p === '..') throw new Error('model_pack_invalid_path');
  }
  return parts;
}

async function getFs(overrides: InstallerOverrides): Promise<InstallerFs> {
  if (overrides.fs) return overrides.fs;
  const fs = await import('expo-file-system');
  return fs as any;
}

function getFetch(overrides: InstallerOverrides): typeof fetch {
  return overrides.fetch ?? fetch;
}

function createAbortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort);
  });
}

function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    (timer as any)?.unref?.();
  });
}

function cacheBustUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  const suffix = `happierCacheBust=${Date.now()}`;
  return trimmed.includes('?') ? `${trimmed}&${suffix}` : `${trimmed}?${suffix}`;
}

function normalizePackId(packId: string | null): string {
  return packId && packId.trim().length > 0 ? packId.trim() : 'default';
}

function getPackRootDir(fs: InstallerFs, packId: string): any {
  return new fs.Directory(fs.Paths.document, 'happier', 'voice', 'modelPacks', packId);
}

function getMetaFile(fs: InstallerFs, rootDir: any): any {
  return new fs.File(rootDir, 'pack.json');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const out = await digest('SHA-256', bytes);
  return toHex(out).toLowerCase();
}

async function writeResponseToFile(opts: {
  response: Response;
  file: any;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<{ loaded: number; total: number }> {
  const contentLength = opts.response.headers.get('content-length');
  const total = contentLength ? Number(contentLength) : 0;
  let loaded = 0;

  const body: any = (opts.response as any).body;
  const reader = body?.getReader?.();
  const writable: WritableStream | null = (opts.file as any).writableStream?.() ?? null;
  const writer = writable ? (writable as any).getWriter?.() : null;

  if (reader && writer) {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), createAbortPromise(opts.signal)]);
      if (done) break;
      if (value) {
        await writer.write(value);
        loaded += value.length ?? value.byteLength ?? 0;
        opts.onProgress?.({ loaded, total });
      }
    }
    await writer.close();
    return { loaded, total: total || loaded };
  }

  const buf = new Uint8Array(await Promise.race([opts.response.arrayBuffer(), createAbortPromise(opts.signal)]));
  loaded = buf.length;
  (opts.file as any).write(buf);
  opts.onProgress?.({ loaded, total: total || loaded });
  return { loaded, total: total || loaded };
}

async function downloadAndVerifyFile(opts: {
  fs: InstallerFs;
  fetchImpl: typeof fetch;
  rootDir: any;
  entry: ModelPackManifest['files'][number];
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  const parts = filePathParts(opts.entry.path);
  const parentParts = parts.slice(0, -1);
  const filename = parts[parts.length - 1]!;

  let dir = opts.rootDir;
  for (const p of parentParts) {
    dir = new opts.fs.Directory(dir, p);
  }
  try {
    dir.create({ intermediates: true, idempotent: true });
  } catch {
    // ignore
  }

  const file = new opts.fs.File(dir, filename);
  if (file.exists) {
    try {
      const bytes = await file.bytes();
      const actual = await sha256Hex(bytes);
      if (actual === opts.entry.sha256.toLowerCase()) return;
      file.delete();
    } catch {
      try {
        file.delete();
      } catch {
        // ignore
      }
    }
  }

  const response = await Promise.race([
    opts.fetchImpl(opts.entry.url, { signal: opts.signal }),
    createAbortPromise(opts.signal),
    createTimeoutPromise(opts.timeoutMs),
  ]);
  if (!response.ok) throw new Error(`model_pack_download_failed:${response.status}`);

  try {
    if (!file.exists) {
      try {
        file.create();
      } catch {
        // ignore
      }
    }

    await writeResponseToFile({ response, file, signal: opts.signal, onProgress: opts.onProgress });

    const bytes = await file.bytes();
    const actual = await sha256Hex(bytes);
    if (actual !== opts.entry.sha256.toLowerCase()) {
      try {
        file.delete();
      } catch {
        // ignore
      }
      throw new Error('model_pack_sha256_mismatch');
    }
  } catch (error) {
    try {
      if (file.exists) file.delete();
    } catch {
      // ignore
    }
    throw error;
  }
}

function assertManifestPathsSafe(manifest: ModelPackManifest): void {
  for (const f of manifest.files) {
    // This will throw model_pack_invalid_path on invalid paths.
    filePathParts(f.path);
  }
}

async function fetchRemoteManifest(opts: {
  fetchImpl: typeof fetch;
  manifestUrl: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ModelPackManifest> {
  const response = await Promise.race([
    opts.fetchImpl(cacheBustUrl(opts.manifestUrl), { signal: opts.signal }),
    createAbortPromise(opts.signal),
    createTimeoutPromise(opts.timeoutMs),
  ]);
  if (!response.ok) throw new Error(`model_pack_manifest_download_failed:${response.status}`);
  const json = await Promise.race([response.json(), createAbortPromise(opts.signal), createTimeoutPromise(opts.timeoutMs)]);
  return parseModelPackManifest(json);
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

async function downloadManifestFiles(opts: {
  fs: InstallerFs;
  fetchImpl: typeof fetch;
  rootDir: any;
  manifest: ModelPackManifest;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (p: { loaded: number; total: number; file?: string }) => void;
}): Promise<void> {
  const total = opts.manifest.files.reduce((acc, f) => acc + (Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0), 0);
  let loadedTotal = 0;

  for (const f of opts.manifest.files) {
    let loadedThisFile = 0;
    await downloadAndVerifyFile({
      fs: opts.fs,
      fetchImpl: opts.fetchImpl,
      rootDir: opts.rootDir,
      entry: f,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onProgress: (p) => {
        const delta = Math.max(0, p.loaded - loadedThisFile);
        loadedThisFile = p.loaded;
        loadedTotal += delta;
        opts.onProgress?.({ loaded: loadedTotal, total, file: f.path });
      },
    });
  }
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
