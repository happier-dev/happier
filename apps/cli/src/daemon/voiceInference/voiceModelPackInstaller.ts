import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, rm, stat } from 'node:fs/promises';

import { assertManifestPathsSafe, parseModelPackManifest, type ModelPackManifest } from '@happier-dev/protocol';
import {
  assertManifestUrlsAllowed,
  assertModelPackUrlAllowed,
  installModelPackWithHost,
  resolveModelPackManifestUrl,
  type ModelPackDownloadStream,
  type ModelPackUrlPolicy,
} from '@happier-dev/voice-modelpacks';

import {
  createNodeModelPackDownloadOpener,
  createNodeModelPackInstallerHost,
  type NodeModelPackDownloadNetwork,
} from './modelPackInstallerHost.node';
import { assertVoiceInferencePackIdFilesystemSafe } from './voiceInferenceWorker.shared';

type InstallProgress = Readonly<{
  phase: 'queued' | 'downloading' | 'verifying' | 'installing' | 'complete' | 'error';
  progress: number;
  bytesDownloaded?: number | null;
  totalBytes?: number | null;
  message?: string | null;
}>;

/**
 * Download/manifest URL policy for the daemon: production assets must be https,
 * but a loopback dev/self-hosted asset server (e.g. via
 * `HAPPIER_MODEL_PACK_MANIFESTS`) may use http on localhost.
 */
const DAEMON_URL_POLICY: ModelPackUrlPolicy = { allowInsecureLoopback: true };
const MODEL_PACK_MANIFEST_WALL_TIME_MS = 60_000;
const MODEL_PACK_MANIFEST_IDLE_TIME_MS = 15_000;
/**
 * The strict public declaration ceiling is 384 files and 512 voices. Their
 * bounded path/URL/catalog fields fit below 2 MiB; retain another 2 MiB for the
 * legacy envelope and JSON overhead without permitting an unbounded response.
 */
const MODEL_PACK_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

function readManifestMap(raw: string | undefined): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

export function resolveVoiceModelPackManifestUrl(packId: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalizedPackId = assertVoiceInferencePackIdFilesystemSafe(packId);
  const manifestMapRaw =
    readManifestMap(env.HAPPIER_MODEL_PACK_MANIFESTS) ?? readManifestMap(env.EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS);
  return resolveModelPackManifestUrl({ packId: normalizedPackId, manifestMapRaw });
}

function serializeVoiceModelPackManifest(manifest: ModelPackManifest): string {
  return JSON.stringify(manifest, null, 2);
}

export function hashVoiceModelPackManifest(manifest: ModelPackManifest): string {
  return createHash('sha256').update(serializeVoiceModelPackManifest(manifest), 'utf8').digest('hex').toLowerCase();
}

async function fetchJson(params: Readonly<{
  url: string;
  signal?: AbortSignal | null;
  network?: NodeModelPackDownloadNetwork;
}>): Promise<unknown> {
  let stream: ModelPackDownloadStream;
  try {
    stream = await createNodeModelPackDownloadOpener({
      urlPolicy: DAEMON_URL_POLICY,
      resolveAddresses: params.network?.resolveAddresses,
      pinnedTransport: params.network?.pinnedTransport,
      wallTimeMs: MODEL_PACK_MANIFEST_WALL_TIME_MS,
      idleTimeMs: MODEL_PACK_MANIFEST_IDLE_TIME_MS,
    })({
      url: params.url,
      signal: params.signal ?? new AbortController().signal,
    });
  } catch (error) {
    if (error instanceof Error && /^model_pack_download_failed:\d+$/.test(error.message)) {
      throw new Error(error.message.replace(
        'model_pack_download_failed:',
        'model_pack_manifest_download_failed:',
      ));
    }
    throw error;
  }
  try {
    if (
      stream.contentLength !== null
      && stream.contentLength > MODEL_PACK_MANIFEST_MAX_BYTES
    ) {
      throw new Error('model_pack_manifest_response_too_large');
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for (;;) {
      const chunk = await stream.read();
      if (chunk === null) break;
      totalBytes += chunk.byteLength;
      if (totalBytes > MODEL_PACK_MANIFEST_MAX_BYTES) {
        throw new Error('model_pack_manifest_response_too_large');
      }
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')) as unknown;
  } finally {
    stream.cancel?.();
  }
}

export async function fetchVoiceModelPackManifest(params: Readonly<{
  packId: string;
  signal?: AbortSignal | null;
  env?: NodeJS.ProcessEnv;
  network?: NodeModelPackDownloadNetwork;
}>): Promise<ModelPackManifest> {
  const normalizedPackId = assertVoiceInferencePackIdFilesystemSafe(params.packId);
  const manifestUrl = resolveVoiceModelPackManifestUrl(params.packId, params.env ?? process.env);
  // LB-M1: validate the manifest document URL through the SAME shared url policy
  // owner the UI uses (network.ts) BEFORE any network round-trip, so both hosts
  // share one transport-safety owner. The per-file https/host gate still runs at
  // install time via the installer core; this closes the manifest-document hole.
  assertModelPackUrlAllowed(manifestUrl, DAEMON_URL_POLICY);
  const manifest = parseModelPackManifest(await fetchJson({
    url: manifestUrl,
    signal: params.signal,
    network: params.network,
  }));
  if (manifest.packId !== normalizedPackId) {
    throw new Error('model_pack_manifest_packid_mismatch');
  }
  // Canonical path-safety owner (protocol); no private copy.
  assertManifestPathsSafe(manifest);
  // Defense in depth: reject any file URL that violates policy before promoting
  // the manifest to callers (the core re-checks at install time).
  assertManifestUrlsAllowed(manifest, DAEMON_URL_POLICY);
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

  const totalBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  await params.reportProgress?.({ phase: 'downloading', progress: 0, bytesDownloaded: 0, totalBytes });

  const host = createNodeModelPackInstallerHost({
    packsRootDir: params.packsRootDir,
    urlPolicy: DAEMON_URL_POLICY,
  });
  const signal = params.signal ?? new AbortController().signal;

  await installModelPackWithHost({
    host,
    packId: safePackId,
    manifest,
    signal,
    urlPolicy: DAEMON_URL_POLICY,
    onProgress: (progress) => {
      const ratio = progress.total > 0 ? Math.min(1, progress.loaded / progress.total) : 1;
      void params.reportProgress?.({
        phase: 'downloading',
        progress: ratio,
        bytesDownloaded: progress.loaded,
        totalBytes: progress.total,
      });
    },
  });

  await params.reportProgress?.({ phase: 'installing', progress: 1, bytesDownloaded: totalBytes, totalBytes });
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
