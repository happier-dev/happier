import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configuration } from '@/configuration';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { ensureSessionMediaIgnoreRule } from '@/transfers/targets/ensureSessionMediaIgnoreRule';
import {
  DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG,
  normalizeSessionMediaWorkspaceRelativeDir,
  persistedSessionMediaCategoryToTransferCategory,
  resolveConfiguredSessionMediaTransferTarget,
  type SessionMediaTransferConfig,
} from '@/transfers/targets/resolveSessionMediaTransferTarget';
import { resolveWorkspaceFileUploadTarget } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';

import type { SessionMediaIngestionSource, SessionMediaItemV1, SessionMediaOrigin } from './_types';
import {
  extensionForSessionMediaMimeType,
  resolveSessionMediaMimeType,
  type SupportedSessionMediaMimeType,
} from './mime';

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
  | Readonly<{ success: true; item: SessionMediaItemV1 }>
  | Readonly<{ success: false; code: string; error: string }>;

export type SessionMediaProviderFileDownloadResult =
  | Readonly<{
      success: true;
      bytes: Buffer | Uint8Array;
      mimeType?: string;
      fileNameHint?: string;
    }>
  | Readonly<{ success: false; code: string; error: string }>;

type PreparedMediaSource =
  | Readonly<{
      kind: 'buffer';
      bytes: Buffer;
      mimeType: SupportedSessionMediaMimeType;
      suggestedName?: string;
    }>
  | Readonly<{
      kind: 'file';
      path: string;
      sizeBytes: number;
      mimeType: SupportedSessionMediaMimeType;
      suggestedName?: string;
    }>;

type ImageDimensions = Readonly<{
  width: number;
  height: number;
}>;

export type GarbageCollectSessionMediaResult = Readonly<{
  deletedFiles: number;
  deletedBytes: number;
}>;

const MAX_SAFE_FILE_NAME_LENGTH = 200;

function failure(code: string, error: string): Extract<PersistSessionMediaResult, { success: false }> {
  return { success: false, code, error };
}

function isFailure(value: PreparedMediaSource | Extract<PersistSessionMediaResult, { success: false }>): value is Extract<PersistSessionMediaResult, { success: false }> {
  return 'success' in value && value.success === false;
}

function normalizePathSegment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('\0')) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

function joinSessionMediaPath(...segments: readonly string[]): string {
  return segments
    .map((segment) => segment.replace(/[\\]+/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/');
}

function normalizeWorkspaceRelativeMediaPath(value: string): string | null {
  const normalized = joinSessionMediaPath(value);
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return normalized;
}

function sanitizeFileName(value: string, fallback = 'file'): string {
  const raw = String(value ?? '');
  const base = raw.split(/[/\\]/g).pop() ?? '';
  const trimmed = base.trim() || fallback;
  const safe = trimmed.replace(/[^\w.\- ()]/g, '_');
  const collapsed = safe.replace(/_+/g, '_');
  const finalName = collapsed === '.' || collapsed === '..' ? fallback : collapsed;
  return finalName.length > MAX_SAFE_FILE_NAME_LENGTH
    ? finalName.slice(-MAX_SAFE_FILE_NAME_LENGTH)
    : finalName;
}

function withFileExtension(fileName: string, extensionWithDot: string): string {
  const currentExtension = extname(fileName);
  const base = currentExtension ? fileName.slice(0, -currentExtension.length) : fileName;
  return `${base || 'file'}${extensionWithDot}`;
}

function resolveSourceSuggestedName(source: SessionMediaIngestionSource, fallback?: string): string {
  if (source.fileNameHint) return source.fileNameHint;
  if (fallback) return fallback;
  if (source.kind === 'local-file') return basename(source.path);
  if (source.kind === 'local-uri') {
    try {
      const parsed = new URL(source.uri);
      return parsed.protocol === 'file:' ? basename(fileURLToPath(parsed)) : 'image';
    } catch {
      return 'image';
    }
  }
  return 'image';
}

function sanitizeOrigin(origin: SessionMediaOrigin): SessionMediaOrigin {
  return {
    source: origin.source,
    ...(typeof origin.agentId === 'string' && origin.agentId.trim() ? { agentId: origin.agentId } : {}),
    ...(typeof origin.toolCallId === 'string' && origin.toolCallId.trim() ? { toolCallId: origin.toolCallId } : {}),
    ...(typeof origin.generationId === 'string' && origin.generationId.trim() ? { generationId: origin.generationId } : {}),
    ...(typeof origin.providerEventId === 'string' && origin.providerEventId.trim() ? { providerEventId: origin.providerEventId } : {}),
    ...(typeof origin.providerFileId === 'string' && origin.providerFileId.trim() ? { providerFileId: origin.providerFileId } : {}),
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function calculateDirectorySizeBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await calculateDirectorySizeBytes(entryPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const entryStat = await stat(entryPath).catch(() => null);
    total += entryStat?.size ?? 0;
  }
  return total;
}

async function garbageCollectSessionMediaDirectory(input: Readonly<{
  workingDirectory: string;
  directoryPath: string;
  keepPaths: ReadonlySet<string>;
}>): Promise<GarbageCollectSessionMediaResult> {
  const entries = await readdir(input.directoryPath, { withFileTypes: true }).catch(() => []);
  let deletedFiles = 0;
  let deletedBytes = 0;

  for (const entry of entries) {
    const entryPath = join(input.directoryPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const childResult = await garbageCollectSessionMediaDirectory({
        workingDirectory: input.workingDirectory,
        directoryPath: entryPath,
        keepPaths: input.keepPaths,
      });
      deletedFiles += childResult.deletedFiles;
      deletedBytes += childResult.deletedBytes;
      await rmdir(entryPath).catch(() => undefined);
      continue;
    }
    if (!entry.isFile()) continue;

    const workspaceRelativePath = normalizeWorkspaceRelativeMediaPath(relative(input.workingDirectory, entryPath));
    if (!workspaceRelativePath || input.keepPaths.has(workspaceRelativePath)) continue;
    const entryStat = await stat(entryPath).catch(() => null);
    await rm(entryPath, { force: true });
    deletedFiles += 1;
    deletedBytes += entryStat?.size ?? 0;
  }

  return { deletedFiles, deletedBytes };
}

async function fileExistsWithHash(path: string, sha256: string): Promise<boolean> {
  const existingStat = await stat(path).catch(() => null);
  if (!existingStat?.isFile()) return false;
  const existingSha256 = await hashFile(path).catch(() => null);
  return existingSha256 === sha256;
}

async function checkSessionMediaBudgets(input: Readonly<{
  workingDirectory: string;
  config: SessionMediaTransferConfig;
  sessionId: string;
  additionalBytes: number;
  sessionBudgetMaxBytes: number | null;
  workspaceBudgetMaxBytes: number | null;
}>): Promise<Extract<PersistSessionMediaResult, { success: false }> | null> {
  const workspaceRelativeDir = normalizeSessionMediaWorkspaceRelativeDir(input.config.workspaceRelativeDir);
  if (!workspaceRelativeDir || input.config.uploadLocation !== 'workspace') return null;

  if (typeof input.sessionBudgetMaxBytes === 'number' && Number.isFinite(input.sessionBudgetMaxBytes)) {
    const sessionBudgetMaxBytes = Math.max(0, Math.trunc(input.sessionBudgetMaxBytes));
    const sessionBytes = await Promise.all(['messages', 'generated', 'artifacts'].map((category) =>
      calculateDirectorySizeBytes(join(input.workingDirectory, workspaceRelativeDir, category, input.sessionId)),
    ));
    const currentSessionBytes = sessionBytes.reduce((sum, value) => sum + value, 0);
    if (currentSessionBytes + input.additionalBytes > sessionBudgetMaxBytes) {
      return failure('session_media_session_budget_exceeded', 'Session media exceeds the configured per-session budget');
    }
  }

  if (typeof input.workspaceBudgetMaxBytes === 'number' && Number.isFinite(input.workspaceBudgetMaxBytes)) {
    const workspaceBudgetMaxBytes = Math.max(0, Math.trunc(input.workspaceBudgetMaxBytes));
    const currentWorkspaceBytes = await calculateDirectorySizeBytes(join(input.workingDirectory, workspaceRelativeDir));
    if (currentWorkspaceBytes + input.additionalBytes > workspaceBudgetMaxBytes) {
      return failure('session_media_workspace_budget_exceeded', 'Session media exceeds the configured per-workspace budget');
    }
  }

  return null;
}

async function readFilePrefix(path: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of createReadStream(path, { start: 0, end: Math.max(0, maxBytes - 1) })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    totalBytes += bytes.byteLength;
    if (totalBytes >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

function resolveLocalUriPath(uri: string): Readonly<{ success: true; path: string } | { success: false; code: string; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { success: false, code: 'unsupported_uri', error: 'Media URI is invalid' };
  }
  if (parsed.protocol !== 'file:') {
    return { success: false, code: 'unsupported_uri', error: 'Only local file URIs are supported for session media persistence' };
  }
  return { success: true, path: fileURLToPath(parsed) };
}

async function prepareSource(input: Readonly<{
  source: SessionMediaIngestionSource;
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
  maxBytes: number;
  suggestedName?: string;
  providerFileDownloader?: (source: Extract<SessionMediaIngestionSource, { kind: 'provider-file' }>) => Promise<SessionMediaProviderFileDownloadResult>;
}>): Promise<PreparedMediaSource | Extract<PersistSessionMediaResult, { success: false }>> {
  if (input.source.kind === 'provider-file') {
    if (!input.providerFileDownloader) {
      return failure('provider_file_unavailable', 'Provider file media requires a provider-owned downloader before it can be persisted');
    }
    const downloaded = await input.providerFileDownloader(input.source);
    if (!downloaded.success) {
      return failure(downloaded.code, downloaded.error);
    }
    const bytes = Buffer.from(downloaded.bytes);
    if (bytes.byteLength === 0) {
      return failure('invalid_provider_file', 'Provider file downloader returned empty media bytes');
    }
    if (bytes.byteLength > input.maxBytes) {
      return failure('media_too_large', 'Media exceeds the configured size limit');
    }
    const suggestedName = downloaded.fileNameHint
      ?? input.source.fileNameHint
      ?? input.suggestedName
      ?? 'provider-file';
    const mimeType = resolveSessionMediaMimeType({
      bytes,
      declaredMimeType: downloaded.mimeType ?? input.source.mimeType,
      suggestedName,
    });
    if (!mimeType) {
      return failure('unsupported_mime', 'Media MIME type is unsupported');
    }
    return { kind: 'buffer', bytes, mimeType, suggestedName };
  }

  if (input.source.kind === 'base64') {
    const bytes = Buffer.from(input.source.data, 'base64');
    if (bytes.byteLength === 0) {
      return failure('invalid_base64', 'Media source base64 data is invalid');
    }
    if (bytes.byteLength > input.maxBytes) {
      return failure('media_too_large', 'Media exceeds the configured size limit');
    }
    const suggestedName = resolveSourceSuggestedName(input.source, input.suggestedName);
    const mimeType = resolveSessionMediaMimeType({
      bytes,
      declaredMimeType: input.source.mimeType,
      suggestedName,
    });
    if (!mimeType) {
      return failure('unsupported_mime', 'Media MIME type is unsupported');
    }
    return { kind: 'buffer', bytes, mimeType, suggestedName };
  }

  const localPath = input.source.kind === 'local-uri'
    ? resolveLocalUriPath(input.source.uri)
    : { success: true as const, path: input.source.path };
  if (!localPath.success) {
    return failure(localPath.code, localPath.error);
  }

  const sourceAuthorization = authorizeFilesystemPath({
    targetPath: localPath.path,
    defaultDirectory: input.workingDirectory,
    accessPolicy: input.accessPolicy ?? { kind: 'osUser' },
  });
  if (!sourceAuthorization.valid) {
    return failure('unauthorized_source_path', sourceAuthorization.error);
  }

  const sourceLstat = await lstat(sourceAuthorization.resolvedPath).catch(() => null);
  if (!sourceLstat || !sourceLstat.isFile() || sourceLstat.isSymbolicLink()) {
    return failure('invalid_source_file', 'Media source must be a regular file');
  }
  const sourceStat = await stat(sourceAuthorization.resolvedPath);
  if (sourceStat.size > input.maxBytes) {
    return failure('media_too_large', 'Media exceeds the configured size limit');
  }

  const suggestedName = resolveSourceSuggestedName(input.source, input.suggestedName);
  const prefix = await readFilePrefix(sourceAuthorization.resolvedPath, 4096);
  const mimeType = resolveSessionMediaMimeType({
    bytes: prefix,
    declaredMimeType: input.source.mimeType,
    suggestedName,
  });
  if (!mimeType) {
    return failure('unsupported_mime', 'Media MIME type is unsupported');
  }

  return {
    kind: 'file',
    path: sourceAuthorization.resolvedPath,
    sizeBytes: sourceStat.size,
    mimeType,
    suggestedName,
  };
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

async function writePreparedSourceAtomically(input: Readonly<{
  source: PreparedMediaSource;
  destinationPath: string;
  expectedSha256: string;
}>): Promise<void> {
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
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (
      error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'EEXIST'
    ) {
      const existingSha256 = await hashFile(input.destinationPath).catch(() => null);
      if (existingSha256 === input.expectedSha256) {
        return;
      }
    }
    throw error;
  }
}

function buildStoredFileName(input: Readonly<{
  sha256: string;
  category: PersistSessionMediaInput['category'];
  source: SessionMediaIngestionSource;
  suggestedName?: string;
  mimeType: SupportedSessionMediaMimeType;
}>): string {
  const fallback = input.category === 'tool-artifact' ? 'artifact-image' : 'generated-image';
  const rawName = resolveSourceSuggestedName(input.source, input.suggestedName || fallback);
  const safeName = sanitizeFileName(rawName, fallback);
  const nameWithExtension = withFileExtension(safeName, extensionForSessionMediaMimeType(input.mimeType));
  return `${input.sha256.slice(0, 12)}-${nameWithExtension}`;
}

export async function garbageCollectSessionMedia(params: Readonly<{
  workingDirectory: string;
  config?: SessionMediaTransferConfig;
  referencedWorkspaceRelativePaths: readonly string[];
  protectedWorkspaceRelativePaths?: readonly string[];
}>): Promise<GarbageCollectSessionMediaResult> {
  const config = params.config ?? DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG;
  const workspaceRelativeDir = normalizeSessionMediaWorkspaceRelativeDir(config.workspaceRelativeDir);
  if (!workspaceRelativeDir || config.uploadLocation !== 'workspace') {
    return { deletedFiles: 0, deletedBytes: 0 };
  }

  const keepPaths = new Set<string>();
  for (const path of [
    ...params.referencedWorkspaceRelativePaths,
    ...(params.protectedWorkspaceRelativePaths ?? []),
  ]) {
    const normalized = normalizeWorkspaceRelativeMediaPath(path);
    if (normalized) keepPaths.add(normalized);
  }

  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const category of ['messages', 'generated', 'artifacts']) {
    const categoryResult = await garbageCollectSessionMediaDirectory({
      workingDirectory: params.workingDirectory,
      directoryPath: join(params.workingDirectory, workspaceRelativeDir, category),
      keepPaths,
    });
    deletedFiles += categoryResult.deletedFiles;
    deletedBytes += categoryResult.deletedBytes;
  }

  return { deletedFiles, deletedBytes };
}

export async function persistSessionMedia(params: Readonly<{
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
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
    accessPolicy: params.accessPolicy,
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
  const fileName = buildStoredFileName({
    sha256,
    category: params.input.category,
    source: params.input.source,
    suggestedName: prepared.suggestedName,
    mimeType: prepared.mimeType,
  });
  const mediaPath = joinSessionMediaPath(resolvedTarget.uploadBasePath, sessionId, messageLocalId, fileName);
  const sizeBytes = prepared.kind === 'buffer' ? prepared.bytes.byteLength : prepared.sizeBytes;
  const uploadTarget = resolveWorkspaceFileUploadTarget({
    workingDirectory: params.workingDirectory,
    accessPolicy: params.accessPolicy,
    path: mediaPath,
    sizeBytes,
    overwrite: false,
    additionalAllowedWriteDirs: resolvedTarget.target.additionalAllowedWriteDirs,
    sessionRpcTransferMaxBytes: params.sessionRpcTransferMaxBytes ?? null,
  });
  if (!uploadTarget.success) {
    return failure('unauthorized_media_path', uploadTarget.error);
  }
  const destinationAlreadyExists = await fileExistsWithHash(uploadTarget.target.destPath, sha256);
  if (!destinationAlreadyExists) {
    const budgetFailure = await checkSessionMediaBudgets({
      workingDirectory: params.workingDirectory,
      config,
      sessionId,
      additionalBytes: sizeBytes,
      sessionBudgetMaxBytes: params.sessionBudgetMaxBytes ?? configuration.sessionMediaMaxBytesPerSession,
      workspaceBudgetMaxBytes: params.workspaceBudgetMaxBytes ?? configuration.sessionMediaMaxBytesPerWorkspace,
    });
    if (budgetFailure) {
      return budgetFailure;
    }
  }

  await writePreparedSourceAtomically({
    source: prepared,
    destinationPath: uploadTarget.target.destPath,
    expectedSha256: sha256,
  });
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
    item: {
      id: sha256.slice(0, 16),
      role: params.input.role,
      category: params.input.category,
      mediaKind: 'image',
      mimeType: prepared.mimeType,
      name: fileName.slice(13),
      path: mediaPath,
      sizeBytes,
      sha256,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
      ...(typeof params.input.createdAtMs === 'number' ? { createdAtMs: params.input.createdAtMs } : {}),
      origin: sanitizeOrigin(params.input.origin),
    },
  };
}
