import { createReadStream } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
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

export type PreparedMediaSource =
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

type PrepareMediaSourceFailure = Readonly<{
  success: false;
  code: string;
  error: string;
}>;

function failure(code: string, error: string): PrepareMediaSourceFailure {
  return { success: false, code, error };
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
