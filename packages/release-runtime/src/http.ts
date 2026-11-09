import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { CredentialRequestRedirectError, resolveCredentialRequestRedirect } from './httpRedirects.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);

type HeaderMap = Readonly<Record<string, string>>;

export type DownloadProgress = Readonly<{ receivedBytes: number; totalBytes?: number }>;
type RequestOptions = Readonly<{
  url: string;
  headers?: HeaderMap;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  retryAttempts?: number;
  retryDelayMs?: number;
}>;

function decodeDataUrl(url: string): Buffer {
  const match = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!match) {
    throw new Error(`[http] invalid data URL`);
  }
  const meta = match[1] ?? '';
  const body = match[2] ?? '';
  const isBase64 = meta.split(';').some((part) => part.trim().toLowerCase() === 'base64');
  if (isBase64) {
    return Buffer.from(body, 'base64');
  }
  return Buffer.from(decodeURIComponent(body), 'utf8');
}

function createHttpError(url: string, statusCode: number, headers: import('node:http').IncomingHttpHeaders): Error {
  const error = new Error(`[http] request failed: ${url} (${statusCode})`);
  (error as Error & { statusCode: number }).statusCode = statusCode;
  Object.assign(error, { status: statusCode, code: `HTTP_${statusCode}` });
  if (statusCode >= 300 && statusCode < 400) Object.assign(error, { retryable: false });
  // Preserve only public rate-limit facts, never arbitrary response headers.
  if ((statusCode === 403 || statusCode === 429) && headers['x-ratelimit-remaining'] === '0') {
    Object.assign(error, { rateLimitRemaining: '0', rateLimitReset: headers['x-ratelimit-reset'] });
  }
  return error;
}

function readHttpStatusCode(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = Number((error as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(statusCode)) return statusCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = /\((\d{3})\)\s*$/.exec(message);
  return match ? Number(match[1]) : null;
}

function isRetryableRequestError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'rateLimitRemaining' in error && error.rateLimitRemaining === '0') {
    return false;
  }
  const statusCode = readHttpStatusCode(error);
  if (statusCode !== null) {
    return RETRYABLE_STATUS_CODES.has(statusCode);
  }
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|socket hang up/i.test(message);
}

async function requestBufferWithNode(params: RequestOptions & Readonly<{
  redirectCount?: number;
}>): Promise<Buffer> {
  const redirectCount = params.redirectCount ?? 0;

  const requestImpl = params.url.startsWith('https:') ? httpsRequest : httpRequest;

  return await new Promise<Buffer>((resolve, reject) => {
    const req = requestImpl(
      params.url,
      {
        method: 'GET',
        signal: params.signal,
        headers: params.headers,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location.trim() : '';

        let redirect: ReturnType<typeof resolveCredentialRequestRedirect>;
        try {
          redirect = resolveCredentialRequestRedirect({
            status: statusCode,
            requestUrl: params.url,
            location: location || null,
            method: 'GET',
            headers: params.headers ?? {},
            hasSecretBody: false,
          });
        } catch (error) {
          res.destroy();
          reject(error);
          return;
        }

        if (redirect) {
          if (redirectCount >= MAX_REDIRECTS) {
            res.destroy();
            reject(new CredentialRequestRedirectError(statusCode));
            return;
          }
          res.resume();
          void requestBufferWithNode({
            url: redirect.url,
            headers: redirect.headers,
            redirectCount: redirectCount + 1,
            timeoutMs: params.timeoutMs,
            signal: params.signal,
            onProgress: params.onProgress,
          }).then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(createHttpError(params.url, statusCode, res.headers));
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        const contentLength = Number(res.headers['content-length']);
        const total = Number.isSafeInteger(contentLength) && contentLength > 0
          ? { totalBytes: contentLength }
          : {};
        res.on('data', (chunk) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(bytes);
          receivedBytes += bytes.length;
          params.onProgress?.({ receivedBytes, ...total });
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );

    req.setTimeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      const error = new Error(`[http] request timed out: ${params.url}`);
      Object.assign(error, { code: 'ETIMEDOUT' });
      req.destroy(error);
    });
    req.on('error', reject);
    req.end();
  });
}

export async function requestBytes(params: RequestOptions): Promise<Buffer> {
  params.signal?.throwIfAborted();
  const url = String(params.url ?? '').trim();
  if (!url) throw new Error('[http] url is required');
  if (url.startsWith('data:')) {
    const bytes = decodeDataUrl(url);
    params.onProgress?.({ receivedBytes: bytes.length, ...(bytes.length > 0 ? { totalBytes: bytes.length } : {}) });
    return bytes;
  }
  const retryAttempts = Math.max(1, Math.floor(params.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.floor(params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    try {
      return await requestBufferWithNode({
        url,
        headers: params.headers,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        onProgress: params.onProgress,
      });
    } catch (error) {
      params.signal?.throwIfAborted();
      if (attempt >= retryAttempts || !isRetryableRequestError(error)) {
        throw error;
      }
      if (retryDelayMs > 0) {
        await delay(retryDelayMs, undefined, { signal: params.signal });
      }
    }
  }
  throw new Error(`[http] request failed: ${url}`);
}

export async function requestText(params: RequestOptions): Promise<string> {
  const bytes = await requestBytes(params);
  return bytes.toString('utf8');
}

export async function requestJson<T>(params: RequestOptions): Promise<T> {
  return JSON.parse(await requestText(params)) as T;
}
