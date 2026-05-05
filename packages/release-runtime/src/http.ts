import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']);

type HeaderMap = Readonly<Record<string, string>>;

const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization']);

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

function dropCrossOriginSensitiveHeaders(headers: HeaderMap | undefined): HeaderMap | undefined {
  if (!headers) {
    return headers;
  }

  let nextHeaders: Record<string, string> | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (CROSS_ORIGIN_SENSITIVE_HEADERS.has(key.toLowerCase())) {
      nextHeaders ??= { ...headers };
      delete nextHeaders[key];
      continue;
    }
    if (nextHeaders) {
      nextHeaders[key] = value;
    }
  }

  return nextHeaders ?? headers;
}

function resolveRedirectHeaders(params: Readonly<{
  requestUrl: string;
  redirectUrl: string;
  headers: HeaderMap | undefined;
}>): HeaderMap | undefined {
  const requestOrigin = new URL(params.requestUrl).origin;
  const redirectOrigin = new URL(params.redirectUrl).origin;
  if (requestOrigin === redirectOrigin) {
    return params.headers;
  }
  return dropCrossOriginSensitiveHeaders(params.headers);
}

function createHttpError(url: string, statusCode: number): Error {
  const error = new Error(`[http] request failed: ${url} (${statusCode})`);
  (error as Error & { statusCode: number }).statusCode = statusCode;
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestBufferWithNode(params: Readonly<{
  url: string;
  headers?: HeaderMap;
  redirectCount?: number;
  timeoutMs?: number;
}>): Promise<Buffer> {
  const redirectCount = params.redirectCount ?? 0;
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error(`[http] too many redirects for ${params.url}`);
  }

  const requestImpl = params.url.startsWith('https:') ? httpsRequest : httpRequest;

  return await new Promise<Buffer>((resolve, reject) => {
    const req = requestImpl(
      params.url,
      {
        method: 'GET',
        headers: params.headers,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location.trim() : '';

        if (statusCode >= 300 && statusCode < 400 && location) {
          const nextUrl = new URL(location, params.url).toString();
          const nextHeaders = resolveRedirectHeaders({
            requestUrl: params.url,
            redirectUrl: nextUrl,
            headers: params.headers,
          });
          res.resume();
          void requestBufferWithNode({
            url: nextUrl,
            headers: nextHeaders,
            redirectCount: redirectCount + 1,
            timeoutMs: params.timeoutMs,
          }).then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(createHttpError(params.url, statusCode));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );

    req.setTimeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error(`[http] request timed out: ${params.url}`));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function requestBytes(params: Readonly<{
  url: string;
  headers?: HeaderMap;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}>): Promise<Buffer> {
  const url = String(params.url ?? '').trim();
  if (!url) throw new Error('[http] url is required');
  if (url.startsWith('data:')) {
    return decodeDataUrl(url);
  }
  const retryAttempts = Math.max(1, Math.floor(params.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.floor(params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    try {
      return await requestBufferWithNode({
        url,
        headers: params.headers,
        timeoutMs: params.timeoutMs,
      });
    } catch (error) {
      if (attempt >= retryAttempts || !isRetryableRequestError(error)) {
        throw error;
      }
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }
  throw new Error(`[http] request failed: ${url}`);
}

export async function requestText(params: Readonly<{
  url: string;
  headers?: HeaderMap;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}>): Promise<string> {
  const bytes = await requestBytes(params);
  return bytes.toString('utf8');
}

export async function requestJson<T>(params: Readonly<{
  url: string;
  headers?: HeaderMap;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}>): Promise<T> {
  return JSON.parse(await requestText(params)) as T;
}
