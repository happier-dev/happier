import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

import type { SessionMediaIngestionSource } from './_types';
import { decodeSessionMediaBase64 } from './base64';
import {
  resolveSessionMediaMimeType,
  type SupportedSessionMediaMimeType,
} from './mime';

export type SessionMediaProviderFileDownloadResult =
  | Readonly<{
      success: true;
      bytes: Buffer | Uint8Array;
      mimeType?: string;
      fileNameHint?: string;
    }>
  | Readonly<{ success: false; code: string; error: string }>;

export type PreparedMediaSource = Readonly<{
  kind: 'buffer';
  bytes: Buffer;
  mimeType: SupportedSessionMediaMimeType;
  suggestedName?: string;
}>;

type PrepareMediaSourceFailure = Readonly<{
  success: false;
  code: string;
  error: string;
}>;

function failure(code: string, error: string): PrepareMediaSourceFailure {
  return { success: false, code, error };
}

function hasSameFileIdentity(
  left: Readonly<{ dev: number; ino: number }>,
  right: Readonly<{ dev: number; ino: number }>,
): boolean {
  const deviceMatches = left.dev === 0 || right.dev === 0 || left.dev === right.dev;
  const inodeMatches = left.ino === 0 || right.ino === 0 || left.ino === right.ino;
  return deviceMatches && inodeMatches;
}

export function resolveSourceSuggestedName(source: SessionMediaIngestionSource, fallback?: string): string {
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

async function readAuthorizedLocalFile(input: Readonly<{
  path: string;
  maxBytes: number;
  reauthorize(): boolean;
}>): Promise<Buffer | PrepareMediaSourceFailure> {
  const { path, maxBytes } = input;
  const sourceLstat = await lstat(path).catch(() => null);
  if (!sourceLstat || !sourceLstat.isFile() || sourceLstat.isSymbolicLink()) {
    return failure('invalid_source_file', 'Media source must be a regular file');
  }
  if (sourceLstat.size > maxBytes) {
    return failure('media_too_large', 'Media exceeds the configured size limit');
  }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) {
    return failure('invalid_source_file', 'Media source must be a regular file');
  }

  const chunks: Buffer[] = [];
  let offset = 0;
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile()
      || !hasSameFileIdentity(openedStat, sourceLstat)
    ) {
      return failure('invalid_source_file', 'Media source changed while it was being authorized');
    }
    if (openedStat.size > maxBytes) {
      return failure('media_too_large', 'Media exceeds the configured size limit');
    }
    if (!input.reauthorize()) {
      return failure('unauthorized_source_path', 'Media source changed outside the allowed directories while it was being authorized');
    }
    const currentPathStat = await lstat(path).catch(() => null);
    if (
      !currentPathStat
      || currentPathStat.isSymbolicLink()
      || !currentPathStat.isFile()
      || !hasSameFileIdentity(currentPathStat, openedStat)
    ) {
      return failure('invalid_source_file', 'Media source changed while it was being authorized');
    }

    while (offset <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (offset > maxBytes) {
    return failure('media_too_large', 'Media exceeds the configured size limit');
  }
  return Buffer.concat(chunks, offset);
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

export async function prepareSource(input: Readonly<{
  source: SessionMediaIngestionSource;
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
  maxBytes: number;
  suggestedName?: string;
  providerFileDownloader?: (source: Extract<SessionMediaIngestionSource, { kind: 'provider-file' }>) => Promise<SessionMediaProviderFileDownloadResult>;
}>): Promise<PreparedMediaSource | PrepareMediaSourceFailure> {
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
      allowVideoByDeclarationOrExtension: true,
    });
    if (!mimeType) {
      return failure('unsupported_mime', 'Media MIME type is unsupported');
    }
    return { kind: 'buffer', bytes, mimeType, suggestedName };
  }

  if (input.source.kind === 'base64') {
    const decoded = decodeSessionMediaBase64(input.source.data, input.maxBytes);
    if (!decoded.success) {
      return failure(decoded.code, decoded.error);
    }
    const suggestedName = resolveSourceSuggestedName(input.source, input.suggestedName);
    const mimeType = resolveSessionMediaMimeType({
      bytes: decoded.bytes,
      declaredMimeType: input.source.mimeType,
      suggestedName,
    });
    if (!mimeType) {
      return failure('unsupported_mime', 'Media MIME type is unsupported');
    }
    return { kind: 'buffer', bytes: decoded.bytes, mimeType, suggestedName };
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

  const bytes = await readAuthorizedLocalFile({
    path: sourceAuthorization.resolvedPath,
    maxBytes: input.maxBytes,
    reauthorize: () => authorizeFilesystemPath({
      targetPath: sourceAuthorization.resolvedPath,
      defaultDirectory: input.workingDirectory,
      accessPolicy: input.accessPolicy ?? { kind: 'osUser' },
    }).valid,
  });
  if (!Buffer.isBuffer(bytes)) {
    return bytes;
  }

  const suggestedName = resolveSourceSuggestedName(input.source, input.suggestedName);
  const mimeType = resolveSessionMediaMimeType({
    bytes: bytes.subarray(0, 4096),
    declaredMimeType: input.source.mimeType,
    suggestedName,
    allowVideoByDeclarationOrExtension: true,
  });
  if (!mimeType) {
    return failure('unsupported_mime', 'Media MIME type is unsupported');
  }

  return {
    kind: 'buffer',
    bytes,
    mimeType,
    suggestedName,
  };
}
