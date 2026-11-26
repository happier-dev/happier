import { createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizeSessionAttachmentUploadPath, readAttachmentEnvelopeUploads } from '@happier-dev/protocol';
import { filesystemPathComparisonKey } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { isWithinResolvedRoot } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { resolveSessionMediaTempUploadBasePath } from '@/transfers/sessionMedia/resolveSessionMediaTransferTarget';
import { normalizeSessionMediaWorkspaceRelativeDir } from '@/transfers/sessionMedia/sessionMediaConfig';
import { sanitizeSessionMediaFileName } from '@/transfers/sessionMedia/sanitizeSessionMediaFileName';
import { configuration } from '@/configuration';

export const SESSION_ATTACHMENT_FILE_EXCEEDS_UPLOAD_LIMIT = 'SESSION_ATTACHMENT_FILE_EXCEEDS_UPLOAD_LIMIT';

export class SessionAttachmentFileExceedsUploadLimitError extends Error {
  readonly code = SESSION_ATTACHMENT_FILE_EXCEEDS_UPLOAD_LIMIT;

  constructor(readonly maxBytes: number) {
    super(`Session attachment exceeds the configured ${maxBytes}-byte file upload limit`);
    this.name = 'SessionAttachmentFileExceedsUploadLimitError';
  }
}

function readConfiguredWorkspaceUploadPath(upload: ReturnType<typeof readAttachmentEnvelopeUploads>[number]): string | null {
  // Workspace upload storage can use a custom relative root. Confirm the
  // transfer owner's filename and /messages/<message-id>/ layout.
  const relative = normalizeSessionMediaWorkspaceRelativeDir(upload.path);
  if (!relative || !upload.name || path.posix.basename(path.posix.dirname(path.posix.dirname(relative))) !== 'messages') return null;
  const filename = path.posix.basename(relative);
  return /^[a-f0-9]{8}-/.test(filename) && filename.slice(9) === sanitizeSessionMediaFileName(upload.name)
    ? relative
    : null;
}

async function resolveUploadReadPath(cwd: string, uploadPath: string): Promise<string | null> {
  const absolutePath = path.resolve(cwd, uploadPath);
  const temporary = path.isAbsolute(uploadPath);
  const platform = process.platform;
  if (temporary && !isWithinResolvedRoot(filesystemPathComparisonKey(absolutePath),
    filesystemPathComparisonKey(resolveSessionMediaTempUploadBasePath()), platform)) return null;

  try {
    const [realUploadPath, realBase] = await Promise.all([realpath(absolutePath), realpath(temporary ? tmpdir() : cwd)]);
    const root = temporary
      ? resolveSessionMediaTempUploadBasePath(realBase)
      : path.resolve(realBase, path.dirname(path.dirname(uploadPath)));
    return isWithinResolvedRoot(filesystemPathComparisonKey(realUploadPath), filesystemPathComparisonKey(root), platform)
      ? realUploadPath
      : null;
  } catch {
    return null;
  }
}

async function readMatchingDeclaredUpload(params: Readonly<{
  absolutePath: string;
  sha256: string;
  sizeBytes: number | null;
  maxBytes: number;
}>): Promise<Buffer | null> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(params.absolutePath, 'r');
    const fileStat = await file.stat();
    if (!fileStat.isFile()) return null;
    if (params.sizeBytes !== null && fileStat.size !== params.sizeBytes) return null;
    if (fileStat.size > params.maxBytes) {
      throw new SessionAttachmentFileExceedsUploadLimitError(params.maxBytes);
    }

    // Read from the same handle that was statted and reserve one sentinel byte.
    // This keeps the allocation bounded while detecting a file that grows between
    // stat and read instead of letting readFile allocate from its new size.
    const contentWithSentinel = Buffer.alloc(fileStat.size + 1);
    let bytesReadTotal = 0;
    while (bytesReadTotal < contentWithSentinel.byteLength) {
      const { bytesRead } = await file.read(
        contentWithSentinel,
        bytesReadTotal,
        contentWithSentinel.byteLength - bytesReadTotal,
        bytesReadTotal,
      );
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
    }
    if (bytesReadTotal > params.maxBytes) {
      throw new SessionAttachmentFileExceedsUploadLimitError(params.maxBytes);
    }
    if (params.sizeBytes !== null && bytesReadTotal !== params.sizeBytes) return null;
    const content = contentWithSentinel.subarray(0, bytesReadTotal);
    return createHash('sha256').update(content).digest('hex') === params.sha256 ? content : null;
  } catch (error) {
    if (error instanceof SessionAttachmentFileExceedsUploadLimitError) throw error;
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function* readTrustedSessionAttachmentUploads(params: Readonly<{
  cwd: string;
  metadata: unknown;
  includeOrdinaryFiles: boolean;
  maxBytes?: number;
}>) {
  const configuredMaxBytes = params.maxBytes ?? configuration.filesUploadMaxFileBytes;
  const maxBytes = Math.min(configuredMaxBytes, bufferConstants.MAX_LENGTH - 1);

  for (const upload of readAttachmentEnvelopeUploads(params.metadata)) {
    if (!upload.sha256 || (!params.includeOrdinaryFiles && !upload.isImage)) continue;
    const uploadPath = normalizeSessionAttachmentUploadPath(upload.path)
      ?? (params.includeOrdinaryFiles ? readConfiguredWorkspaceUploadPath(upload) : null);
    if (!uploadPath) continue;
    const readPath = await resolveUploadReadPath(params.cwd, uploadPath);
    if (!readPath) continue;
    let bytes: Buffer | null;
    try {
      bytes = await readMatchingDeclaredUpload({ absolutePath: readPath, sha256: upload.sha256, sizeBytes: upload.sizeBytes, maxBytes });
    } catch (error) {
      // The Claude prompt can still deliver the user's message and other uploads
      // if a retained upload no longer fits the local read budget.
      if (params.includeOrdinaryFiles && error instanceof SessionAttachmentFileExceedsUploadLimitError) continue;
      throw error;
    }
    if (bytes) yield { uploadPath, absolutePath: readPath, bytes };
  }
}

export async function readTrustedSessionAttachmentLocalImages(params: Readonly<{
  cwd: string;
  metadata: unknown;
  maxBytes?: number;
}>): Promise<ReadonlyMap<string, Buffer>> {
  const trusted = new Map<string, Buffer>();
  for await (const upload of readTrustedSessionAttachmentUploads({ ...params, includeOrdinaryFiles: false })) {
    trusted.set(upload.uploadPath, upload.bytes);
  }
  return trusted;
}

export async function resolveTrustedSessionAttachmentFilePaths(params: Readonly<{
  cwd: string;
  metadata: unknown;
}>): Promise<ReadonlySet<string>> {
  const paths = new Set<string>();
  for await (const upload of readTrustedSessionAttachmentUploads({ ...params, includeOrdinaryFiles: true })) {
    paths.add(upload.absolutePath);
  }
  return paths;
}

export async function resolveTrustedSessionAttachmentLocalImagePaths(params: Readonly<{
  cwd: string;
  metadata: unknown;
}>): Promise<ReadonlySet<string>> {
  return new Set((await readTrustedSessionAttachmentLocalImages(params)).keys());
}
