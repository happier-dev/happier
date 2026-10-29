import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const MAX_REDIRECTS = 5;
const DOWNLOAD_RETRY_DELAYS_MS = [250, 1_000] as const;

function normalizeExpectedSha256(digest: string | null | undefined): string | null {
  const raw = typeof digest === 'string' ? digest.trim() : '';
  if (!raw) return null;
  const normalized = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw;
  return normalized.trim().toLowerCase() || null;
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

async function openGitHubReleaseAssetResponse(
  url: string,
  headers: Readonly<Record<string, string>>,
  redirectCount = 0,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  signal?.throwIfAborted();
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error('[github-release] too many redirects while downloading asset');
  }

  const target = new URL(url);
  const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return await new Promise<IncomingMessage>((resolve, reject) => {
    const req = requestImpl(target, { headers, signal }, (response) => {
      const statusCode = Number(response.statusCode ?? 0);
      const location = typeof response.headers.location === 'string' ? response.headers.location.trim() : '';
      if (isRedirect(statusCode) && location) {
        response.destroy();
        const nextUrl = new URL(location, target).toString();
        void openGitHubReleaseAssetResponse(nextUrl, headers, redirectCount + 1, signal).then(resolve, reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.destroy();
        reject(new Error(`[github-release] failed to download asset (${statusCode || 'unknown'})`));
        return;
      }
      resolve(response);
    });
    req.on('error', reject);
    req.end();
  });
}

export async function downloadGitHubReleaseAsset(params: Readonly<{
  url: string;
  destinationPath: string;
  digest?: string | null;
  userAgent?: string;
  signal?: AbortSignal;
  onProgress?: (event: Readonly<{ bytesDone: number; bytesTotal?: number }>) => void;
}>): Promise<void> {
  params.signal?.throwIfAborted();
  const url = String(params.url ?? '').trim();
  const destinationPath = String(params.destinationPath ?? '').trim();
  const userAgent = String(params.userAgent ?? '').trim() || 'happier-cli';
  if (!url) throw new Error('[github-release] url is required');
  if (!destinationPath) throw new Error('[github-release] destinationPath is required');

  const headers = {
    'user-agent': userAgent,
    accept: 'application/octet-stream',
  };
  const expectedSha256 = normalizeExpectedSha256(params.digest);

  await mkdir(dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.download`;

  const maxAttempts = DOWNLOAD_RETRY_DELAYS_MS.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      params.signal?.throwIfAborted();
      const response = await openGitHubReleaseAssetResponse(url, headers, 0, params.signal);
      const hash = createHash('sha256');
      let bytesDone = 0;
      const contentLength = Number(response.headers['content-length']);
      const total = Number.isSafeInteger(contentLength) && contentLength > 0 ? { bytesTotal: contentLength } : {};
      const hashTap = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          bytesDone += chunk.length;
          params.onProgress?.({ bytesDone, ...total });
          callback(null, chunk);
        },
      });
      await pipeline(response, hashTap, createWriteStream(tempPath), { signal: params.signal });
      params.signal?.throwIfAborted();
      if (expectedSha256) {
        const actualSha256 = hash.digest('hex');
        if (actualSha256 !== expectedSha256) {
          throw new Error('[github-release] checksum verification failed');
        }
      }
      await rename(tempPath, destinationPath);
      return;
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      params.signal?.throwIfAborted();
      const retryDelayMs = DOWNLOAD_RETRY_DELAYS_MS[attempt - 1] ?? null;
      if (!isRetryableDownloadError(error) || retryDelayMs === null) {
        if (error instanceof Error) throw error;
        throw new Error(String(error));
      }
      try {
        await sleep(retryDelayMs, undefined, { signal: params.signal });
      } catch (waitError) {
        params.signal?.throwIfAborted();
        throw waitError;
      }
    }
  }
}

function isRetryableDownloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/^\[github-release\] failed to download asset \((502|503|504)\)$/.test(message)) {
    return true;
  }
  if (error && typeof error === 'object') {
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE') {
      return true;
    }
  }
  return false;
}
