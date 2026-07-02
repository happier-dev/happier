import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';

import { configuration } from '@/configuration';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { ensureSessionMediaIgnoreRule } from '@/transfers/targets/ensureSessionMediaIgnoreRule';
import {
  DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG,
  persistedSessionMediaCategoryToTransferCategory,
  resolveConfiguredSessionMediaTransferTarget,
  type SessionMediaTransferConfig,
} from '@/transfers/targets/resolveSessionMediaTransferTarget';
import { resolveWorkspaceFileUploadTarget } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';

import type { SessionMediaIngestionSource, SessionMediaItemV1, SessionMediaOrigin } from './_types';
import { checkSessionMediaBudgets } from './budget';
import {
  extensionForSessionMediaMimeType,
  type SupportedSessionMediaMimeType,
} from './mime';
import {
  sanitizeSessionMediaIdentifier,
  sanitizeSessionMediaFileName,
  withSessionMediaFileExtension,
} from './names';
import { joinSessionMediaPath, normalizePathSegment } from './paths';
import {
  prepareSource,
  resolveSourceSuggestedName,
  type PreparedMediaSource,
  type SessionMediaProviderFileDownloadResult,
} from './source';

export { garbageCollectSessionMedia, type GarbageCollectSessionMediaResult } from './budget';
export type { SessionMediaProviderFileDownloadResult } from './source';

export type PersistSessionMediaInput = Readonly<{
  sessionId: string;
  messageLocalId: string;
  role: 'input' | 'output';
  category: 'attachment' | 'generated' | 'tool-artifact';
  source: SessionMediaIngestionSource;
  origin: SessionMediaOrigin;
  suggestedName?: string;
  createdAtMs?: number;
}>;

export type PersistSessionMediaResult =
  | Readonly<{ success: true; item: SessionMediaItemV1; created: boolean }>
  | Readonly<{ success: false; code: string; error: string }>;

type ImageDimensions = Readonly<{
  width: number;
  height: number;
}>;

function failure(code: string, error: string): Extract<PersistSessionMediaResult, { success: false }> {
  return { success: false, code, error };
}

function isFailure(value: PreparedMediaSource | Extract<PersistSessionMediaResult, { success: false }>): value is Extract<PersistSessionMediaResult, { success: false }> {
  return 'success' in value && value.success === false;
}

function sanitizeOrigin(origin: SessionMediaOrigin): SessionMediaOrigin {
  const agentId = sanitizeSessionMediaIdentifier(origin.agentId);
  const toolCallId = sanitizeSessionMediaIdentifier(origin.toolCallId);
  const generationId = sanitizeSessionMediaIdentifier(origin.generationId);
  const providerEventId = sanitizeSessionMediaIdentifier(origin.providerEventId);
  const providerFileId = sanitizeSessionMediaIdentifier(origin.providerFileId);
  return {
    source: origin.source,
    ...(agentId ? { agentId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(generationId ? { generationId } : {}),
    ...(providerEventId ? { providerEventId } : {}),
    ...(providerFileId ? { providerFileId } : {}),
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function fileExistsWithHash(path: string, sha256: string): Promise<boolean> {
  const existingStat = await stat(path).catch(() => null);
  if (!existingStat?.isFile()) return false;
  const existingSha256 = await hashFile(path).catch(() => null);
  return existingSha256 === sha256;
}

function readPositiveImageDimension(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

async function readPreparedImageDimensions(source: PreparedMediaSource): Promise<ImageDimensions | null> {
  try {
    const sharp = (await import('sharp')).default;
    const image = source.kind === 'buffer'
      ? sharp(source.bytes, { failOn: 'none' })
      : sharp(source.path, { failOn: 'none' });
    const metadata = await image.metadata();
    const width = readPositiveImageDimension(metadata.width);
    const height = readPositiveImageDimension(metadata.height);
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

async function adoptSourceFile(input: Readonly<{
  sourcePath: string;
  destinationPath: string;
}>): Promise<void> {
  try {
    await copyFile(input.sourcePath, input.destinationPath, constants.COPYFILE_FICLONE);
    return;
  } catch {
    // Reflink is opportunistic; fall through to byte-preserving fallbacks.
  }
  try {
    await link(input.sourcePath, input.destinationPath);
    return;
  } catch {
    // Hard links are not portable across all filesystems.
  }
  await copyFile(input.sourcePath, input.destinationPath);
}

type WritePreparedSourceAtomicResult = 'written' | 'exists-same-hash' | 'exists-different-hash';

async function writePreparedSourceAtomically(input: Readonly<{
  source: PreparedMediaSource;
  destinationPath: string;
  expectedSha256: string;
}>): Promise<WritePreparedSourceAtomicResult> {
  await mkdir(dirname(input.destinationPath), { recursive: true });
  const tempPath = join(dirname(input.destinationPath), `.happier-session-media-${randomUUID()}.tmp`);
  try {
    if (input.source.kind === 'buffer') {
      await writeFile(tempPath, input.source.bytes);
    } else {
      await adoptSourceFile({ sourcePath: input.source.path, destinationPath: tempPath });
    }
    await link(tempPath, input.destinationPath);
    await rm(tempPath, { force: true });
    return 'written';
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (
      error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'EEXIST'
    ) {
      const existingSha256 = await hashFile(input.destinationPath).catch(() => null);
      if (existingSha256 === input.expectedSha256) {
        return 'exists-same-hash';
      }
      return 'exists-different-hash';
    }
    throw error;
  }
}

function addCollisionSuffix(fileName: string, collisionIndex: number): string {
  if (collisionIndex <= 0) return fileName;
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${stem}-${collisionIndex}${extension}`;
}

function buildStoredFileName(input: Readonly<{
  sha256: string;
  category: PersistSessionMediaInput['category'];
  source: SessionMediaIngestionSource;
  suggestedName?: string;
  mimeType: SupportedSessionMediaMimeType;
  collisionIndex?: number;
}>): string {
  const fallback = input.category === 'tool-artifact' ? 'artifact-image' : 'generated-image';
  const rawName = resolveSourceSuggestedName(input.source, input.suggestedName || fallback);
  const safeName = sanitizeSessionMediaFileName(rawName, fallback);
  const nameWithExtension = withSessionMediaFileExtension(safeName, extensionForSessionMediaMimeType(input.mimeType));
  return `${input.sha256.slice(0, 12)}-${addCollisionSuffix(nameWithExtension, input.collisionIndex ?? 0)}`;
}

export async function persistSessionMedia(params: Readonly<{
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
  sourceAccessPolicy?: FilesystemAccessPolicy;
  pathAllowanceRegistry: TransferPathAllowanceRegistry;
  config?: SessionMediaTransferConfig;
  maxBytes?: number;
  sessionBudgetMaxBytes?: number | null;
  workspaceBudgetMaxBytes?: number | null;
  sessionRpcTransferMaxBytes?: number | null;
  providerFileDownloader?: (source: Extract<SessionMediaIngestionSource, { kind: 'provider-file' }>) => Promise<SessionMediaProviderFileDownloadResult>;
  input: PersistSessionMediaInput;
}>): Promise<PersistSessionMediaResult> {
  const messageLocalId = normalizePathSegment(params.input.messageLocalId);
  if (!messageLocalId) {
    return failure('invalid_message_local_id', 'Invalid messageLocalId');
  }
  const sessionId = normalizePathSegment(params.input.sessionId);
  if (!sessionId) {
    return failure('invalid_session_id', 'Invalid sessionId');
  }

  const config = params.config ?? DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG;
  const transferCategory = persistedSessionMediaCategoryToTransferCategory(params.input.category);
  const tempUploadRoot = join(tmpdir(), 'happier', 'uploads', randomUUID());
  const resolvedTarget = resolveConfiguredSessionMediaTransferTarget({
    config,
    tempUploadRoot,
    workingDirectory: params.workingDirectory,
    accessPolicy: params.accessPolicy,
    category: transferCategory,
  });
  if (!resolvedTarget.success) {
    const code = resolvedTarget.error.startsWith('Access denied')
      ? 'unauthorized_media_path'
      : 'invalid_media_target';
    return failure(code, resolvedTarget.error);
  }

  const maxBytes = params.maxBytes ?? configuration.filesUploadMaxFileBytes;
  const prepared = await prepareSource({
    source: params.input.source,
    workingDirectory: params.workingDirectory,
    accessPolicy: params.sourceAccessPolicy ?? params.accessPolicy,
    maxBytes,
    suggestedName: params.input.suggestedName,
    providerFileDownloader: params.providerFileDownloader,
  });
  if (isFailure(prepared)) {
    return prepared;
  }

  const sha256 = prepared.kind === 'buffer'
    ? createHash('sha256').update(prepared.bytes).digest('hex')
    : await hashFile(prepared.path);
  const sizeBytes = prepared.kind === 'buffer' ? prepared.bytes.byteLength : prepared.sizeBytes;

  let storedFileName: string | null = null;
  let mediaPath: string | null = null;
  let created = false;
  const maxCollisionAttempts = 100;

  for (let collisionIndex = 0; collisionIndex < maxCollisionAttempts; collisionIndex += 1) {
    const candidateFileName = buildStoredFileName({
      sha256,
      category: params.input.category,
      source: params.input.source,
      suggestedName: prepared.suggestedName,
      mimeType: prepared.mimeType,
      collisionIndex,
    });
    const candidateMediaPath = joinSessionMediaPath(resolvedTarget.uploadBasePath, sessionId, messageLocalId, candidateFileName);
    const uploadTarget = resolveWorkspaceFileUploadTarget({
      workingDirectory: params.workingDirectory,
      accessPolicy: params.accessPolicy,
      path: candidateMediaPath,
      sizeBytes,
      overwrite: false,
      additionalAllowedWriteDirs: resolvedTarget.target.additionalAllowedWriteDirs,
      sessionRpcTransferMaxBytes: params.sessionRpcTransferMaxBytes ?? null,
    });
    if (!uploadTarget.success) {
      return failure('unauthorized_media_path', uploadTarget.error);
    }

    if (await fileExistsWithHash(uploadTarget.target.destPath, sha256)) {
      storedFileName = candidateFileName;
      mediaPath = candidateMediaPath;
      created = false;
      break;
    }

    const existingStat = await stat(uploadTarget.target.destPath).catch(() => null);
    if (existingStat) continue;

    const budgetFailure = await checkSessionMediaBudgets({
      workingDirectory: params.workingDirectory,
      config,
      sessionId,
      additionalBytes: sizeBytes,
      sessionBudgetMaxBytes: params.sessionBudgetMaxBytes ?? configuration.sessionMediaMaxBytesPerSession,
      workspaceBudgetMaxBytes: params.workspaceBudgetMaxBytes ?? configuration.sessionMediaMaxBytesPerWorkspace,
    });
    if (budgetFailure) {
      return failure(budgetFailure.code, budgetFailure.error);
    }

    const writeResult = await writePreparedSourceAtomically({
      source: prepared,
      destinationPath: uploadTarget.target.destPath,
      expectedSha256: sha256,
    });
    if (writeResult === 'exists-different-hash') continue;

    storedFileName = candidateFileName;
    mediaPath = candidateMediaPath;
    created = writeResult === 'written';
    break;
  }

  if (!storedFileName || !mediaPath) {
    return failure('media_path_collision', 'Unable to allocate a collision-free session media path');
  }

  const dimensions = await readPreparedImageDimensions(prepared);

  try {
    await ensureSessionMediaIgnoreRule({
      workingDirectory: params.workingDirectory,
      config,
    });
  } catch {
    // Ignore-rule writes are best effort and must not prevent media persistence.
  }

  params.pathAllowanceRegistry.setAdditionalAllowedReadDirs(resolvedTarget.target.additionalAllowedReadDirs);
  params.pathAllowanceRegistry.setAdditionalAllowedWriteDirs(resolvedTarget.target.additionalAllowedWriteDirs);

  return {
    success: true,
    created,
    item: {
      id: sha256.slice(0, 16),
      role: params.input.role,
      category: params.input.category,
      mediaKind: 'image',
      mimeType: prepared.mimeType,
      name: storedFileName.slice(13),
      path: mediaPath,
      sizeBytes,
      sha256,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
      ...(typeof params.input.createdAtMs === 'number' ? { createdAtMs: params.input.createdAtMs } : {}),
      origin: sanitizeOrigin(params.input.origin),
    },
  };
}
