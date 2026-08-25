import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  openRemoteAcquisition,
  type OpenedRemoteAcquisition,
  type RemoteAcquisitionAddressResolver,
  type RemoteAcquisitionDestinationPolicy,
} from './acquisition';

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

/**
 * Remote plugin material is named by the current user (a typed install locator
 * or a configured catalog URL), so that first destination is their own network
 * intent. Everything the remote side then chooses — a redirect, a re-resolved
 * name — must stay on a destination this host has classified, and may never
 * move a public acquisition into a loopback, private or reserved network.
 */
const REMOTE_PLUGIN_ACQUISITION_POLICY: RemoteAcquisitionDestinationPolicy = Object.freeze({
  scheme: 'httpOrHttps',
  redirects: 'anyAssessedOrigin',
  privateNetwork: 'followCallerDestination',
});

export type RemoteFetchNetworkBoundary = Readonly<{
  fetchImpl?: typeof fetch;
  resolveAddresses?: RemoteAcquisitionAddressResolver;
}>;

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

async function openRemoteResponse(params: Readonly<{
  url: string;
  accept: string;
  timeoutMs: number;
  maxBytes: number;
  errorLabel: string;
  network: RemoteFetchNetworkBoundary;
}>): Promise<OpenedRemoteAcquisition> {
  let opened: OpenedRemoteAcquisition;
  try {
    opened = await openRemoteAcquisition({
      url: params.url,
      headers: { accept: params.accept },
      policy: REMOTE_PLUGIN_ACQUISITION_POLICY,
      timeoutMs: params.timeoutMs,
      errorLabel: params.errorLabel,
      ...(params.network.fetchImpl ? { fetchImpl: params.network.fetchImpl } : {}),
      ...(params.network.resolveAddresses ? { resolveAddresses: params.network.resolveAddresses } : {}),
    });
  } catch (error) {
    throw describeTimeoutError(error, params.errorLabel, params.timeoutMs);
  }

  try {
    if (opened.response.status < 200 || opened.response.status >= 300) {
      throw new Error(`${params.errorLabel} fetch failed with ${opened.response.status}`);
    }
    assertResponseContentLengthWithinLimit({
      response: opened.response,
      maxBytes: params.maxBytes,
      errorLabel: params.errorLabel,
    });
    if (!opened.response.body) {
      throw new Error(`${params.errorLabel} response body is empty`);
    }
  } catch (error) {
    await opened.response.body?.cancel().catch(() => undefined);
    await opened.dispose().catch(() => undefined);
    throw error;
  }
  return opened;
}

/**
 * The single byte-budget owner for a remote plugin body. Both the catalog
 * reader and the archive writer consume it, so a declared and an undeclared
 * length are bounded by exactly the same rule.
 */
async function* readLimitedChunks(params: Readonly<{
  response: Response;
  maxBytes: number;
  errorLabel: string;
}>): AsyncGenerator<Uint8Array> {
  const reader = params.response.body?.getReader();
  if (!reader) {
    throw new Error(`${params.errorLabel} response body is empty`);
  }
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > params.maxBytes) {
        throw new Error(`${params.errorLabel} exceeds the configured size limit (${params.maxBytes} bytes)`);
      }
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function fetchRemoteJsonWithLimits<T>(params: Readonly<{
  url: string;
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  errorLabel: string;
  network?: RemoteFetchNetworkBoundary;
}>): Promise<T> {
  const timeoutMs = params.timeoutMs ?? resolvePluginRemoteFetchTimeoutMs();
  const maxBytes = params.maxBytes ?? resolvePluginRemoteCatalogMaxBytes();
  const opened = await openRemoteResponse({
    url: params.url,
    accept: params.accept ?? 'application/json',
    timeoutMs,
    maxBytes,
    errorLabel: params.errorLabel,
    network: params.network ?? {},
  });

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of readLimitedChunks({
      response: opened.response,
      maxBytes,
      errorLabel: params.errorLabel,
    })) {
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } finally {
    await opened.dispose().catch(() => undefined);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

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
  network?: RemoteFetchNetworkBoundary;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? resolvePluginRemoteFetchTimeoutMs();
  const maxBytes = params.maxBytes ?? resolvePluginRemoteArchiveMaxBytes();
  const opened = await openRemoteResponse({
    url: params.url,
    accept: params.accept ?? 'application/octet-stream',
    timeoutMs,
    maxBytes,
    errorLabel: params.errorLabel,
    network: params.network ?? {},
  });

  try {
    await mkdir(dirname(params.destinationPath), { recursive: true });
    await pipeline(
      Readable.from(readLimitedChunks({
        response: opened.response,
        maxBytes,
        errorLabel: params.errorLabel,
      })),
      createWriteStream(params.destinationPath),
    );
  } finally {
    await opened.dispose().catch(() => undefined);
  }
}
