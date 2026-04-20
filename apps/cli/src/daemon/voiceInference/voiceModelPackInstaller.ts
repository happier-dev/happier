import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';

import { parseModelPackManifest, type ModelPackManifest } from '@happier-dev/protocol';

import { assertVoiceInferencePackIdFilesystemSafe } from './voiceInferenceWorker.shared';

type InstallProgress = Readonly<{
  phase: 'queued' | 'downloading' | 'verifying' | 'installing' | 'complete' | 'error';
  progress: number;
  bytesDownloaded?: number | null;
  totalBytes?: number | null;
  message?: string | null;
}>;

function filePathParts(path: string): string[] {
  const raw = path.trim();
  if (!raw || raw.startsWith('/') || raw.startsWith('\\') || raw.includes('\\') || raw.includes('\0')) {
    throw new Error('model_pack_invalid_path');
  }

  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('model_pack_invalid_path');
  }
  return parts;
}

function assertManifestPathsSafe(manifest: ModelPackManifest): void {
  for (const file of manifest.files) {
    filePathParts(file.path);
  }
}

function resolveDefaultManifestUrl(packId: string): string {
  return `https://github.com/happier-dev/happier-assets/releases/download/model-packs/${encodeURIComponent(packId)}__manifest.json`;
}

function readManifestMap(raw: string | undefined): Record<string, string> | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
    );
  } catch {
    return null;
  }
}

export function resolveVoiceModelPackManifestUrl(packId: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalizedPackId = assertVoiceInferencePackIdFilesystemSafe(packId);
  const manifestMap =
    readManifestMap(env.HAPPIER_MODEL_PACK_MANIFESTS)
    ?? readManifestMap(env.EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS);
  const fromMap = manifestMap?.[normalizedPackId];
  if (typeof fromMap === 'string' && fromMap.trim().length > 0) {
    return fromMap.trim();
  }
  return resolveDefaultManifestUrl(normalizedPackId);
}

function serializeVoiceModelPackManifest(manifest: ModelPackManifest): string {
  return JSON.stringify(manifest, null, 2);
}

export function hashVoiceModelPackManifest(manifest: ModelPackManifest): string {
  return createHash('sha256').update(serializeVoiceModelPackManifest(manifest), 'utf8').digest('hex').toLowerCase();
}

async function fetchJson(url: string, signal?: AbortSignal | null): Promise<unknown> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(`model_pack_manifest_download_failed:${response.status}`);
  }
  return await response.json();
}

async function downloadFile(params: Readonly<{
  url: string;
  filePath: string;
  expectedSizeBytes: number;
  expectedSha256Hex: string;
  signal?: AbortSignal | null;
  onProgress?: (progress: Readonly<{ loaded: number; total: number | null }>) => Promise<void> | void;
}>): Promise<void> {
  const response = await fetch(params.url, params.signal ? { signal: params.signal } : undefined);
  if (!response.ok) {
    throw new Error(`model_pack_download_failed:${response.status}`);
  }

  const totalHeader = response.headers.get('content-length');
  const total = typeof totalHeader === 'string' ? Number.parseInt(totalHeader, 10) : NaN;
  const totalBytes = Number.isFinite(total) && total >= 0 ? total : null;
  await mkdir(dirname(params.filePath), { recursive: true });

  const expectedSizeBytes = Math.max(0, Math.trunc(params.expectedSizeBytes));
  const expectedSha = params.expectedSha256Hex.trim().toLowerCase();
  const hash = createHash('sha256');

  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength !== expectedSizeBytes) {
      throw new Error('model_pack_size_mismatch');
    }
    hash.update(buffer);
    const actualSha = hash.digest('hex').toLowerCase();
    if (actualSha !== expectedSha) {
      throw new Error('model_pack_sha256_mismatch');
    }
    await writeFile(params.filePath, buffer);
    await params.onProgress?.({ loaded: buffer.byteLength, total: totalBytes });
    return;
  }

  const out = createWriteStream(params.filePath);
  const reader = body.getReader();
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value ?? new Uint8Array();
      loaded += chunk.byteLength;
      if (loaded > expectedSizeBytes) {
        throw new Error('model_pack_size_mismatch');
      }
      hash.update(chunk);
      out.write(chunk);
      await params.onProgress?.({ loaded: chunk.byteLength, total: totalBytes });
    }
    out.end();
    await finished(out);
  } catch (error) {
    try {
      out.destroy();
    } catch {
      // ignore
    }
    await rm(params.filePath, { force: true }).catch(() => undefined);
    throw error;
  }

  if (loaded !== expectedSizeBytes) {
    await rm(params.filePath, { force: true }).catch(() => undefined);
    throw new Error('model_pack_size_mismatch');
  }

  const actualSha = hash.digest('hex').toLowerCase();
  if (actualSha !== expectedSha) {
    await rm(params.filePath, { force: true }).catch(() => undefined);
    throw new Error('model_pack_sha256_mismatch');
  }
}

export async function fetchVoiceModelPackManifest(params: Readonly<{
  packId: string;
  signal?: AbortSignal | null;
}>): Promise<ModelPackManifest> {
  const normalizedPackId = assertVoiceInferencePackIdFilesystemSafe(params.packId);
  const manifestUrl = resolveVoiceModelPackManifestUrl(params.packId);
  const manifest = parseModelPackManifest(await fetchJson(manifestUrl, params.signal));
  if (manifest.packId !== normalizedPackId) {
    throw new Error('model_pack_manifest_packid_mismatch');
  }
  assertManifestPathsSafe(manifest);
  return manifest;
}

export async function readInstalledVoiceModelPackManifest(params: Readonly<{
  packsRootDir: string;
  packId: string;
}>): Promise<ModelPackManifest | null> {
  try {
    const manifestPath = join(params.packsRootDir, assertVoiceInferencePackIdFilesystemSafe(params.packId), 'pack.json');
    return parseModelPackManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  } catch {
    return null;
  }
}

export async function installVoiceModelPack(params: Readonly<{
  packsRootDir: string;
  manifest: ModelPackManifest;
  signal?: AbortSignal | null;
  reportProgress?: (progress: InstallProgress) => Promise<void> | void;
}>): Promise<ModelPackManifest> {
  const manifest = params.manifest;
  const safePackId = assertVoiceInferencePackIdFilesystemSafe(manifest.packId);
  const packRootDir = join(params.packsRootDir, safePackId);
  const stagingRootDir = join(params.packsRootDir, `.${safePackId}.staging-${randomUUID()}`);
  const backupRootDir = join(params.packsRootDir, `.${safePackId}.backup-${randomUUID()}`);
  await rm(stagingRootDir, { recursive: true, force: true });
  await mkdir(stagingRootDir, { recursive: true });

  const totalBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  let downloadedBytes = 0;
  await params.reportProgress?.({ phase: 'downloading', progress: 0, bytesDownloaded: 0, totalBytes });

  for (const file of manifest.files) {
    const filePath = join(stagingRootDir, ...filePathParts(file.path));
    await downloadFile({
      url: file.url,
      filePath,
      expectedSizeBytes: file.sizeBytes,
      expectedSha256Hex: file.sha256,
      signal: params.signal,
      onProgress: async ({ loaded }) => {
        downloadedBytes += loaded;
        await params.reportProgress?.({
          phase: 'downloading',
          progress: totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : 1,
          bytesDownloaded: downloadedBytes,
          totalBytes,
        });
      },
    });
    await params.reportProgress?.({ phase: 'verifying', progress: totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : 1, bytesDownloaded: downloadedBytes, totalBytes });
  }

  await params.reportProgress?.({ phase: 'installing', progress: 1, bytesDownloaded: downloadedBytes, totalBytes });
  const manifestContents = serializeVoiceModelPackManifest(manifest);
  await writeFile(join(stagingRootDir, 'pack.json'), manifestContents, 'utf8');

  let backupCreated = false;
  let promoted = false;
  try {
    try {
      await rename(packRootDir, backupRootDir);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        throw error;
      }
    }
    await rename(stagingRootDir, packRootDir);
    promoted = true;
  } catch (error) {
    if (!promoted && backupCreated) {
      await rename(backupRootDir, packRootDir).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!promoted) {
      await rm(stagingRootDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (promoted && backupCreated) {
      await rm(backupRootDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return manifest;
}

export async function removeInstalledVoiceModelPack(params: Readonly<{
  packsRootDir: string;
  packId: string;
}>): Promise<void> {
  const safePackId = assertVoiceInferencePackIdFilesystemSafe(params.packId);
  await rm(join(params.packsRootDir, safePackId), { recursive: true, force: true });
}

export async function statInstalledVoiceModelPack(params: Readonly<{
  packsRootDir: string;
  packId: string;
}>): Promise<Readonly<{ exists: boolean; updatedAtMs: number }>> {
  try {
    const safePackId = assertVoiceInferencePackIdFilesystemSafe(params.packId);
    const fileStats = await stat(join(params.packsRootDir, safePackId, 'pack.json'));
    return {
      exists: true,
      updatedAtMs: fileStats.mtimeMs,
    };
  } catch {
    return {
      exists: false,
      updatedAtMs: Date.now(),
    };
  }
}
