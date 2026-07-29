import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REMOTE_FETCH_TIMEOUT_MS_ENV = 'HAPPIER_PLUGIN_REMOTE_FETCH_TIMEOUT_MS';
const REMOTE_CATALOG_MAX_BYTES_ENV = 'HAPPIER_PLUGIN_REMOTE_CATALOG_MAX_BYTES';
const REMOTE_ARCHIVE_MAX_BYTES_ENV = 'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES';

const DEFAULT_REMOTE_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_REMOTE_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_REMOTE_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;

function resolvePositiveEnvInt(params: Readonly<{
  envName: string;
  defaultValue: number;
  maxValue: number;
}>): number {
  const raw = process.env[params.envName]?.trim();
  if (!raw) {
    return params.defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${params.envName} value: ${raw}`);
  }

  return Math.min(Math.floor(parsed), params.maxValue);
}

export function resolvePluginRemoteFetchTimeoutMs(): number {
  return resolvePositiveEnvInt({
    envName: REMOTE_FETCH_TIMEOUT_MS_ENV,
    defaultValue: DEFAULT_REMOTE_FETCH_TIMEOUT_MS,
    maxValue: 120_000,
  });
}

export function resolvePluginRemoteCatalogMaxBytes(): number {
  return resolvePositiveEnvInt({
    envName: REMOTE_CATALOG_MAX_BYTES_ENV,
    defaultValue: DEFAULT_REMOTE_CATALOG_MAX_BYTES,
    maxValue: 32 * 1024 * 1024,
  });
}

export function resolvePluginRemoteArchiveMaxBytes(): number {
  return resolvePositiveEnvInt({
    envName: REMOTE_ARCHIVE_MAX_BYTES_ENV,
    defaultValue: DEFAULT_REMOTE_ARCHIVE_MAX_BYTES,
    maxValue: 1024 * 1024 * 1024,
  });
}

function describeTimeoutError(error: unknown, errorLabel: string, timeoutMs: number): Error {
  if (
    error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR')
  ) {
    return new Error(`${errorLabel} timed out after ${timeoutMs}ms`);
  }
  return error instanceof Error ? error : new Error(`${errorLabel} fetch failed`);
}

function assertResponseContentLengthWithinLimit(params: Readonly<{
  response: Response;
  maxBytes: number;
  errorLabel: string;
}>): void {
  const contentLengthRaw = params.response.headers.get('content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : Number.NaN;
  if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
    throw new Error(`${params.errorLabel} exceeds the configured size limit (${params.maxBytes} bytes)`);
  }
}

function createBodyByteLimitTransform(params: Readonly<{
  maxBytes: number;
  errorLabel: string;
}>): Transform {
  let totalBytes = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
      totalBytes += chunkBytes;
      if (totalBytes > params.maxBytes) {
        callback(new Error(`${params.errorLabel} exceeds the configured size limit (${params.maxBytes} bytes)`));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function fetchRemoteResponse(params: Readonly<{
  url: string;
  accept: string;
  timeoutMs: number;
  maxBytes: number;
  errorLabel: string;
}>): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(params.url, {
      headers: {
        accept: params.accept,
      },
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (error) {
    throw describeTimeoutError(error, params.errorLabel, params.timeoutMs);
  }

  if (!response.ok) {
    throw new Error(`${params.errorLabel} fetch failed with ${response.status}`);
  }

  assertResponseContentLengthWithinLimit({
    response,
    maxBytes: params.maxBytes,
    errorLabel: params.errorLabel,
  });

  if (!response.body) {
    throw new Error(`${params.errorLabel} response body is empty`);
  }

  return response;
}

async function readRemoteBodyWithLimit(params: Readonly<{
  response: Response;
  maxBytes: number;
  errorLabel: string;
}>): Promise<Uint8Array> {
  const reader = params.response.body?.getReader();
  if (!reader) {
    throw new Error(`${params.errorLabel} response body is empty`);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > params.maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new Error(`${params.errorLabel} exceeds the configured size limit (${params.maxBytes} bytes)`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function fetchRemoteJsonWithLimits<T>(params: Readonly<{
  url: string;
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  errorLabel: string;
}>): Promise<T> {
  const timeoutMs = params.timeoutMs ?? resolvePluginRemoteFetchTimeoutMs();
  const maxBytes = params.maxBytes ?? resolvePluginRemoteCatalogMaxBytes();
  const response = await fetchRemoteResponse({
    url: params.url,
    accept: params.accept ?? 'application/json',
    timeoutMs,
    maxBytes,
    errorLabel: params.errorLabel,
  });
  const body = await readRemoteBodyWithLimit({
    response,
    maxBytes,
    errorLabel: params.errorLabel,
  });

  try {
    return JSON.parse(Buffer.from(body).toString('utf8')) as T;
  } catch {
    throw new Error(`Invalid ${params.errorLabel.toLowerCase()}`);
  }
}

export async function downloadRemoteFileWithLimits(params: Readonly<{
  url: string;
  destinationPath: string;
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  errorLabel: string;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? resolvePluginRemoteFetchTimeoutMs();
  const maxBytes = params.maxBytes ?? resolvePluginRemoteArchiveMaxBytes();
  const response = await fetchRemoteResponse({
    url: params.url,
    accept: params.accept ?? 'application/octet-stream',
    timeoutMs,
    maxBytes,
    errorLabel: params.errorLabel,
  });

  await mkdir(dirname(params.destinationPath), { recursive: true });
  // Mixed DOM/Node declaration builds model the same runtime WHATWG stream with
  // structurally incompatible interfaces. Keep the assertion at that boundary.
  const responseBody = response.body as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(
    Readable.fromWeb(responseBody),
    createBodyByteLimitTransform({
      maxBytes,
      errorLabel: params.errorLabel,
    }),
    createWriteStream(params.destinationPath),
  );
}
