import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createPluginStateStore } from '../store/pluginStateStore';

const DEFAULT_REMOTE_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const REMOTE_ARCHIVE_MAX_BYTES_ENV = 'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES';

function resolveRemoteArchiveMaxBytes(): number {
  const raw = process.env[REMOTE_ARCHIVE_MAX_BYTES_ENV]?.trim();
  if (!raw) {
    return DEFAULT_REMOTE_ARCHIVE_MAX_BYTES;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${REMOTE_ARCHIVE_MAX_BYTES_ENV} value: ${raw}`);
  }

  return Math.floor(parsed);
}

function createArchiveByteLimitTransform(maxBytes: number): Transform {
  let totalBytes = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
      totalBytes += chunkBytes;
      if (totalBytes > maxBytes) {
        callback(new Error(`Remote plugin archive exceeds the configured size limit (${maxBytes} bytes)`));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function streamRemoteArchiveToFile(params: Readonly<{
  archiveUrl: string;
  destinationPath: string;
  maxBytes: number;
}>): Promise<void> {
  const response = await fetch(params.archiveUrl, {
    headers: {
      accept: 'application/octet-stream',
    },
  });
  if (!response.ok) {
    throw new Error(`Remote plugin archive fetch failed with ${response.status}`);
  }

  const contentLengthRaw = response.headers.get('content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : Number.NaN;
  if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
    throw new Error(`Remote plugin archive exceeds the configured size limit (${params.maxBytes} bytes)`);
  }

  if (!response.body) {
    throw new Error('Remote plugin archive response body is empty');
  }

  await pipeline(
    Readable.fromWeb(response.body),
    createArchiveByteLimitTransform(params.maxBytes),
    createWriteStream(params.destinationPath),
  );
}

export async function downloadRemoteArchiveToTempFile(params: Readonly<{
  happyHomeDir: string;
  archiveUrl: string;
  archiveName: string;
}>): Promise<Readonly<{ tempDir: string; archivePath: string }>> {
  const maxBytes = resolveRemoteArchiveMaxBytes();
  const store = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  await mkdir(store.paths.cacheDir, { recursive: true });
  const tempDir = await mkdtemp(join(store.paths.cacheDir, 'plugin-download-'));
  const archivePath = join(tempDir, params.archiveName);

  try {
    await streamRemoteArchiveToFile({
      archiveUrl: params.archiveUrl,
      destinationPath: archivePath,
      maxBytes,
    });
    return {
      tempDir,
      archivePath,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
