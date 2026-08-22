import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  ComposerContentHandleV1Schema,
  type ComposerContentHandleV1,
  type ComposerContentMediaKindV1,
  type ComposerContentMimeTypeV1,
  type PluginContributionIdentityV1,
  type SessionExecutionTargetV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import {
  isSessionMediaImageMimeType,
  sessionMediaKindForMimeType,
  sniffSessionMediaMimeType,
  type SupportedSessionMediaMimeType,
} from '@/session/media/mime';
import { sanitizeSessionMediaFileName } from '@/session/media/names';

const MANIFEST_VERSION = 1 as const;
const MANIFEST_MAX_BYTES = 16 * 1024;
const MIME_SNIFF_BYTES = 4 * 1024;
const CONTENT_FILE_NAME = 'content';
const MANIFEST_FILE_NAME = 'manifest.json';
const COMPLETED_DIRECTORY_NAME = 'completed';
const PENDING_DIRECTORY_NAME = '.pending';
const STAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const COMPOSER_MEDIA_STAGE_ORPHAN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ComposerMediaStageManifest = Readonly<{
  v: typeof MANIFEST_VERSION;
  createdAtMs: number;
  handle: ComposerContentHandleV1;
}>;

type ComposerMediaStageFailureCode =
  | 'invalid_metadata'
  | 'target_mismatch'
  | 'source_corrupt'
  | 'stage_corrupt'
  | 'stage_unavailable';

type ComposerMediaStageFailure = Readonly<{
  success: false;
  error: string;
  code: ComposerMediaStageFailureCode;
}>;

export type ComposerMediaStageFinalizeResult =
  | Readonly<{ success: true; handle: ComposerContentHandleV1 }>
  | ComposerMediaStageFailure;

export type ComposerMediaStageInspection =
  | Readonly<{
      status: 'ready';
      handle: ComposerContentHandleV1;
      filePath: string;
      mediaKind: ComposerContentMediaKindV1;
      mimeType: ComposerContentMimeTypeV1;
      name: string;
      sizeBytes: number;
      sha256: string;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: 'notFound' | 'expired' | 'targetMismatch' | 'ownerMismatch' | 'corrupt';
    }>;

export type ComposerMediaStageReleaseResult =
  | Readonly<{ status: 'released' }>
  | Readonly<{
      status: 'unavailable';
      reason: 'notFound' | 'expired' | 'targetMismatch' | 'ownerMismatch' | 'corrupt';
    }>;

export type ComposerMediaStageStore = Readonly<{
  finalizeUpload: (input: Readonly<{
    tempPath: string;
    sizeBytes: number;
    sha256: string;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    mediaKind: ComposerContentMediaKindV1;
    mimeType: ComposerContentMimeTypeV1;
    name: string;
  }>) => Promise<ComposerMediaStageFinalizeResult>;
  inspectForFinalization: (input: Readonly<{
    handle: ComposerContentHandleV1;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
  }>) => Promise<ComposerMediaStageInspection>;
  release: (input: Readonly<{
    handle: ComposerContentHandleV1;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
  }>) => Promise<ComposerMediaStageReleaseResult>;
}>;

function unavailable(reason: Extract<ComposerMediaStageInspection, { status: 'unavailable' }>['reason']): Extract<ComposerMediaStageInspection, { status: 'unavailable' }> {
  return { status: 'unavailable', reason };
}

function failure(code: ComposerMediaStageFailureCode, error: string): ComposerMediaStageFailure {
  return { success: false, code, error };
}

function sameExecutionTarget(
  left: SessionExecutionTargetV1,
  right: SessionExecutionTargetV1,
): boolean {
  return left.serverId === right.serverId && left.machineId === right.machineId;
}

function sameOwner(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readManifest(value: unknown): ComposerMediaStageManifest | null {
  if (!isRecord(value) || !hasExactKeys(value, ['v', 'createdAtMs', 'handle'])) return null;
  if (value.v !== MANIFEST_VERSION) return null;
  const createdAtMs = value.createdAtMs;
  if (typeof createdAtMs !== 'number' || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0) return null;
  const handle = ComposerContentHandleV1Schema.safeParse(value.handle);
  if (!handle.success) return null;
  return {
    v: MANIFEST_VERSION,
    createdAtMs,
    handle: handle.data,
  };
}

function normalizeSha256(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function readPositiveSafeInteger(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeSupportedMimeType(value: ComposerContentMimeTypeV1): SupportedSessionMediaMimeType {
  return value as SupportedSessionMediaMimeType;
}

function isWebmHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
    return false;
  }
  return Buffer.from(bytes).includes(Buffer.from('webm', 'ascii'));
}

async function readPrefix(path: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const bytes = Buffer.alloc(Math.max(1, maxBytes));
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    return bytes.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hashFile(path: string): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

async function verifyContentFile(input: Readonly<{
  path: string;
  handle: ComposerContentHandleV1;
}>): Promise<boolean> {
  const fileStat = await lstat(input.path).catch(() => null);
  if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== input.handle.sizeBytes) {
    return false;
  }
  const actualSha256 = await hashFile(input.path);
  if (!actualSha256 || actualSha256 !== input.handle.sha256.toLowerCase()) return false;

  const prefix = await readPrefix(input.path, MIME_SNIFF_BYTES);
  if (!prefix) return false;
  const mimeType = normalizeSupportedMimeType(input.handle.mimeType);
  if (isSessionMediaImageMimeType(mimeType)) {
    return sniffSessionMediaMimeType(prefix) === mimeType;
  }
  return input.handle.mediaKind === 'video' && mimeType === 'video/webm' && isWebmHeader(prefix);
}

async function readBoundedManifest(path: string): Promise<ComposerMediaStageManifest | null> {
  const manifestStat = await lstat(path).catch(() => null);
  if (
    !manifestStat?.isFile()
    || manifestStat.isSymbolicLink()
    || manifestStat.size <= 0
    || manifestStat.size > MANIFEST_MAX_BYTES
  ) {
    return null;
  }
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return readManifest(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function stageDirectory(rootDirectory: string, id: string): string {
  return join(rootDirectory, COMPLETED_DIRECTORY_NAME, id);
}

function isStageId(value: string): boolean {
  return STAGE_ID_PATTERN.test(value);
}

function isContainedPath(rootDirectory: string, candidatePath: string): boolean {
  const containedPath = relative(rootDirectory, candidatePath);
  return containedPath !== ''
    && containedPath !== '..'
    && !containedPath.startsWith(`..${sep}`)
    && !isAbsolute(containedPath);
}

async function resolveStageNamespace(rootDirectory: string, name: string): Promise<string | null> {
  const canonicalRoot = await realpath(rootDirectory).catch(() => null);
  if (!canonicalRoot) return null;

  const namespacePath = join(canonicalRoot, name);
  const namespaceStat = await lstat(namespacePath).catch(() => null);
  if (!namespaceStat?.isDirectory() || namespaceStat.isSymbolicLink()) return null;

  const canonicalNamespace = await realpath(namespacePath).catch(() => null);
  if (!canonicalNamespace || !isContainedPath(canonicalRoot, canonicalNamespace)) return null;
  return canonicalNamespace;
}

async function removeStageEntryFromNamespace(namespaceDirectory: string, id: string): Promise<void> {
  if (!isStageId(id)) return;
  const entryPath = join(namespaceDirectory, id);
  if (!isContainedPath(namespaceDirectory, entryPath)) return;

  const entryStat = await lstat(entryPath).catch(() => null);
  if (!entryStat?.isDirectory() || entryStat.isSymbolicLink()) return;

  const canonicalEntry = await realpath(entryPath).catch(() => null);
  if (!canonicalEntry || !isContainedPath(namespaceDirectory, canonicalEntry)) return;
  await rm(canonicalEntry, { recursive: true, force: true }).catch(() => undefined);
}

async function sweepCompletedStages(input: Readonly<{
  rootDirectory: string;
  now: number;
  orphanTtlMs: number;
}>): Promise<void> {
  const completedDirectory = await resolveStageNamespace(input.rootDirectory, COMPLETED_DIRECTORY_NAME);
  if (!completedDirectory) return;

  const entries = await readdir(completedDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isStageId(entry.name)) continue;

    const entryPath = join(completedDirectory, entry.name);
    const entryStat = await lstat(entryPath).catch(() => null);
    if (!entryStat?.isDirectory() || entryStat.isSymbolicLink() || !Number.isFinite(entryStat.mtimeMs)) {
      continue;
    }

    const manifest = await readBoundedManifest(join(entryPath, MANIFEST_FILE_NAME));
    const createdAtMs = manifest?.handle.id === entry.name
      ? manifest.createdAtMs
      : entryStat.mtimeMs;
    if (!isExpired(createdAtMs, input.now, input.orphanTtlMs)) {
      continue;
    }
    await removeStageEntryFromNamespace(completedDirectory, entry.name);
  }
}

async function sweepPendingStages(input: Readonly<{
  rootDirectory: string;
  now: number;
  orphanTtlMs: number;
}>): Promise<void> {
  const pendingDirectory = await resolveStageNamespace(input.rootDirectory, PENDING_DIRECTORY_NAME);
  if (!pendingDirectory) return;

  const entries = await readdir(pendingDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isStageId(entry.name)) continue;

    const entryPath = join(pendingDirectory, entry.name);
    const entryStat = await lstat(entryPath).catch(() => null);
    if (
      !entryStat?.isDirectory()
      || entryStat.isSymbolicLink()
      || !Number.isFinite(entryStat.mtimeMs)
      || !isExpired(entryStat.mtimeMs, input.now, input.orphanTtlMs)
    ) {
      continue;
    }
    await removeStageEntryFromNamespace(pendingDirectory, entry.name);
  }
}

async function sweepExpiredOrphanedStages(input: Readonly<{
  rootDirectory: string;
  now: () => number;
  orphanTtlMs: number;
}>): Promise<void> {
  const currentTime = input.now();
  if (!Number.isFinite(currentTime)) return;
  await Promise.all([
    sweepCompletedStages({
      rootDirectory: input.rootDirectory,
      now: currentTime,
      orphanTtlMs: input.orphanTtlMs,
    }),
    sweepPendingStages({
      rootDirectory: input.rootDirectory,
      now: currentTime,
      orphanTtlMs: input.orphanTtlMs,
    }),
  ]);
}

export async function runComposerMediaStageStartupMaintenance(input: Readonly<{
  rootDirectory: string;
  now?: () => number;
  orphanTtlMs?: number;
}>): Promise<void> {
  await sweepExpiredOrphanedStages({
    rootDirectory: input.rootDirectory,
    now: input.now ?? Date.now,
    orphanTtlMs: Math.max(
      1,
      Math.floor(input.orphanTtlMs ?? COMPOSER_MEDIA_STAGE_ORPHAN_TTL_MS),
    ),
  });
}

function isExpired(createdAtMs: number, now: number, orphanTtlMs: number): boolean {
  return now >= createdAtMs + orphanTtlMs;
}

function createCanonicalHandle(input: Readonly<{
  id: string;
  executionTarget: SessionExecutionTargetV1;
  owner: PluginContributionIdentityV1;
  mediaKind: ComposerContentMediaKindV1;
  mimeType: ComposerContentMimeTypeV1;
  name: string;
  sizeBytes: number;
  sha256: string;
}>): ComposerContentHandleV1 | null {
  const sanitizedName = sanitizeSessionMediaFileName(input.name, 'media');
  const parsed = ComposerContentHandleV1Schema.safeParse({
    v: MANIFEST_VERSION,
    id: input.id,
    executionTarget: input.executionTarget,
    owner: input.owner,
    mediaKind: input.mediaKind,
    mimeType: input.mimeType,
    name: sanitizedName,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
  });
  return parsed.success ? parsed.data : null;
}

export function createComposerMediaStageStore(input: Readonly<{
  rootDirectory: string;
  executionTarget: SessionExecutionTargetV1;
  now?: () => number;
  orphanTtlMs?: number;
}>): ComposerMediaStageStore {
  const now = input.now ?? Date.now;
  const orphanTtlMs = Math.max(1, Math.floor(input.orphanTtlMs ?? COMPOSER_MEDIA_STAGE_ORPHAN_TTL_MS));
  const completedDirectory = join(input.rootDirectory, COMPLETED_DIRECTORY_NAME);
  const pendingDirectory = join(input.rootDirectory, PENDING_DIRECTORY_NAME);

  const removeStage = async (id: string): Promise<void> => {
    const canonicalCompletedDirectory = await resolveStageNamespace(
      input.rootDirectory,
      COMPLETED_DIRECTORY_NAME,
    );
    if (!canonicalCompletedDirectory) return;
    await removeStageEntryFromNamespace(canonicalCompletedDirectory, id);
  };

  const inspectForFinalization: ComposerMediaStageStore['inspectForFinalization'] = async (request) => {
    const handle = ComposerContentHandleV1Schema.safeParse(request.handle);
    if (!handle.success) return unavailable('corrupt');
    if (!sameExecutionTarget(request.executionTarget, input.executionTarget)
      || !sameExecutionTarget(handle.data.executionTarget, input.executionTarget)) {
      return unavailable('targetMismatch');
    }
    if (!sameOwner(request.owner, handle.data.owner)) return unavailable('ownerMismatch');

    const directory = stageDirectory(input.rootDirectory, handle.data.id);
    const manifest = await readBoundedManifest(join(directory, MANIFEST_FILE_NAME));
    if (!manifest) {
      const exists = await lstat(directory).then(() => true).catch(() => false);
      if (exists) await removeStage(handle.data.id);
      return unavailable(exists ? 'corrupt' : 'notFound');
    }
    if (isExpired(manifest.createdAtMs, now(), orphanTtlMs)) {
      await removeStage(handle.data.id);
      return unavailable('expired');
    }
    if (!sameExecutionTarget(manifest.handle.executionTarget, input.executionTarget)) {
      await removeStage(handle.data.id);
      return unavailable('corrupt');
    }
    // The caller's opaque claim is untrusted. A foreign or altered claim must
    // never make its real completed stage destructible.
    if (!sameOwner(manifest.handle.owner, request.owner)) return unavailable('ownerMismatch');
    if (JSON.stringify(manifest.handle) !== JSON.stringify(handle.data)) return unavailable('corrupt');

    const filePath = join(directory, CONTENT_FILE_NAME);
    if (!await verifyContentFile({ path: filePath, handle: manifest.handle })) {
      await removeStage(handle.data.id);
      return unavailable('corrupt');
    }
    return {
      status: 'ready',
      handle: manifest.handle,
      filePath,
      mediaKind: manifest.handle.mediaKind,
      mimeType: manifest.handle.mimeType,
      name: manifest.handle.name,
      sizeBytes: manifest.handle.sizeBytes,
      sha256: manifest.handle.sha256,
    };
  };

  return {
    finalizeUpload: async (request) => {
      const sizeBytes = readPositiveSafeInteger(request.sizeBytes);
      const sha256 = normalizeSha256(request.sha256);
      if (!sizeBytes || !sha256) return failure('invalid_metadata', 'Invalid Composer media metadata');
      if (!sameExecutionTarget(request.executionTarget, input.executionTarget)) {
        return failure('target_mismatch', 'Composer media stage target does not match target daemon');
      }
      const handle = createCanonicalHandle({
        id: randomUUID(),
        executionTarget: request.executionTarget,
        owner: request.owner,
        mediaKind: request.mediaKind,
        mimeType: request.mimeType,
        name: request.name,
        sizeBytes,
        sha256,
      });
      if (!handle || sessionMediaKindForMimeType(normalizeSupportedMimeType(handle.mimeType)) !== handle.mediaKind) {
        return failure('invalid_metadata', 'Invalid Composer media metadata');
      }
      if (!await verifyContentFile({ path: request.tempPath, handle })) {
        return failure('source_corrupt', 'Composer media bytes do not match declared metadata');
      }

      const pendingStageDirectory = join(pendingDirectory, handle.id);
      const destinationDirectory = stageDirectory(input.rootDirectory, handle.id);
      try {
        await mkdir(pendingDirectory, { recursive: true });
        await mkdir(completedDirectory, { recursive: true });
        await mkdir(pendingStageDirectory);
        const contentPath = join(pendingStageDirectory, CONTENT_FILE_NAME);
        await copyFile(request.tempPath, contentPath);
        if (!await verifyContentFile({ path: contentPath, handle })) {
          await rm(pendingStageDirectory, { recursive: true, force: true });
          return failure('source_corrupt', 'Composer media bytes changed while being finalized');
        }
        const manifest: ComposerMediaStageManifest = {
          v: MANIFEST_VERSION,
          createdAtMs: now(),
          handle,
        };
        await writeFile(
          join(pendingStageDirectory, MANIFEST_FILE_NAME),
          JSON.stringify(manifest),
          { encoding: 'utf8', flag: 'wx' },
        );
        await rename(pendingStageDirectory, destinationDirectory);
        return { success: true, handle };
      } catch {
        await rm(pendingStageDirectory, { recursive: true, force: true }).catch(() => undefined);
        return failure('stage_unavailable', 'Unable to finalize Composer media stage');
      }
    },
    inspectForFinalization,
    release: async (request) => {
      const inspected = await inspectForFinalization(request);
      if (inspected.status !== 'ready') return inspected;
      await removeStage(inspected.handle.id);
      return { status: 'released' };
    },
  };
}

/**
 * Production callers use this factory instead of deriving an active-server
 * path themselves. The completed-stage root is one daemon-owned namespace.
 */
export function createActiveDaemonComposerMediaStageStore(input: Readonly<{
  machineId: string;
}>): ComposerMediaStageStore {
  return createComposerMediaStageStore({
    rootDirectory: join(configuration.activeServerDir, 'composer-media-stages'),
    executionTarget: {
      serverId: configuration.activeServerId,
      machineId: input.machineId,
    },
  });
}

export async function runActiveDaemonComposerMediaStageStartupMaintenance(): Promise<void> {
  await runComposerMediaStageStartupMaintenance({
    rootDirectory: join(configuration.activeServerDir, 'composer-media-stages'),
  });
}
