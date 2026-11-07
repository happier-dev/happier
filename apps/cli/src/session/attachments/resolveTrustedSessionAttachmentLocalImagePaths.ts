import { createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { readAttachmentEnvelopeLocalImagePaths } from '@happier-dev/protocol';
import { configuration } from '@/configuration';

export const SESSION_ATTACHMENT_FILE_EXCEEDS_UPLOAD_LIMIT = 'SESSION_ATTACHMENT_FILE_EXCEEDS_UPLOAD_LIMIT';

export class SessionAttachmentFileExceedsUploadLimitError extends Error {
  readonly code = SESSION_ATTACHMENT_FILE_EXCEEDS_UPLOAD_LIMIT;

  constructor(readonly maxBytes: number) {
    super(`Session attachment exceeds the configured ${maxBytes}-byte file upload limit`);
    this.name = 'SessionAttachmentFileExceedsUploadLimitError';
  }
}

type MetadataRecord = Record<string, unknown>;

function asRecord(value: unknown): MetadataRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function asRecordArray(value: unknown): MetadataRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is MetadataRecord => Boolean(entry)) : [];
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAttachmentPath(value: unknown): string | null {
  const rawPath = readString(value);
  return rawPath ? rawPath.replace(/[\\]+/g, '/') : null;
}

function readAttachmentEnvelope(value: MetadataRecord): MetadataRecord[] {
  const happier = asRecord(value.happier);
  if (happier?.kind !== 'attachments.v1') return [];
  const payload = asRecord(happier.payload);
  return asRecordArray(payload?.attachments);
}

function readSha256(value: unknown): string | null {
  const candidate = readString(value);
  return candidate && /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : null;
}

function readSizeBytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function resolveAttachmentPath(cwd: string, uploadPath: string): string {
  return path.isAbsolute(uploadPath) ? uploadPath : path.resolve(cwd, uploadPath);
}

async function readMatchingDeclaredUpload(params: Readonly<{
  cwd: string;
  uploadPath: string;
  sha256: string;
  sizeBytes: number | null;
  maxBytes: number;
}>): Promise<Buffer | null> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const absolutePath = resolveAttachmentPath(params.cwd, params.uploadPath);
    file = await open(absolutePath, 'r');
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

export async function readTrustedSessionAttachmentLocalImages(params: Readonly<{
  cwd: string;
  metadata: unknown;
  maxBytes?: number;
}>): Promise<ReadonlyMap<string, Buffer>> {
  const metadata = asRecord(params.metadata);
  const trusted = new Map<string, Buffer>();
  if (!metadata) return trusted;
  const configuredMaxBytes = params.maxBytes ?? configuration.filesImageReadMaxBytes;
  const maxBytes = Math.min(configuredMaxBytes, bufferConstants.MAX_LENGTH - 1);

  const candidatePaths = readAttachmentEnvelopeLocalImagePaths(metadata);
  if (candidatePaths.size === 0) return trusted;

  for (const attachment of readAttachmentEnvelope(metadata)) {
    const normalizedPath = normalizeAttachmentPath(attachment.path);
    if (!normalizedPath || !candidatePaths.has(normalizedPath)) continue;
    const sha256 = readSha256(attachment.sha256);
    if (!sha256) continue;
    const content = await readMatchingDeclaredUpload({
      cwd: params.cwd,
      uploadPath: normalizedPath,
      sha256,
      sizeBytes: readSizeBytes(attachment.sizeBytes),
      maxBytes,
    });
    if (content) trusted.set(normalizedPath, content);
  }
  return trusted;
}

export async function resolveTrustedSessionAttachmentLocalImagePaths(params: Readonly<{
  cwd: string;
  metadata: unknown;
}>): Promise<ReadonlySet<string>> {
  return new Set((await readTrustedSessionAttachmentLocalImages(params)).keys());
}
