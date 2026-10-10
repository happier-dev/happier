import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { awaitPluginAcquisition } from '@/plugins/distribution/acquisitionLifetime';

import {
  openRemoteAcquisition,
  type OpenedRemoteAcquisition,
  type RemoteAcquisitionAddressResolver,
  type RemoteAcquisitionDestinationPolicy,
} from './acquisition';

const REMOTE_FETCH_TIMEOUT_MS_ENV = 'HAPPIER_PLUGIN_REMOTE_FETCH_TIMEOUT_MS';
const REMOTE_CATALOG_MAX_BYTES_ENV = 'HAPPIER_PLUGIN_REMOTE_CATALOG_MAX_BYTES';
const REMOTE_ARCHIVE_MAX_BYTES_ENV = 'HAPPIER_PLUGIN_REMOTE_ARCHIVE_MAX_BYTES';

function resolvePositiveEnvInt(envName: string): number | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${envName} value: ${raw}`);
  return value;
}

export function resolvePluginRemoteFetchTimeoutMs(): number | null {
  return resolvePositiveEnvInt(REMOTE_FETCH_TIMEOUT_MS_ENV);
}

export function resolvePluginRemoteCatalogMaxBytes(): number | null {
  return resolvePositiveEnvInt(REMOTE_CATALOG_MAX_BYTES_ENV);
}

export function resolvePluginRemoteArchiveMaxBytes(): number | null {
  return resolvePositiveEnvInt(REMOTE_ARCHIVE_MAX_BYTES_ENV);
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

function assertResponseContentLengthWithinLimit(params: Readonly<{
  response: Response;
  maxBytes: number | null;
  errorLabel: string;
}>): void {
  const contentLengthRaw = params.response.headers.get('content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : Number.NaN;
  if (params.maxBytes !== null && Number.isFinite(contentLength) && contentLength > params.maxBytes) {
    throw new Error(`${params.errorLabel} exceeds the configured size limit (${params.maxBytes} bytes)`);
  }
}

async function openRemoteResponse(params: Readonly<{
  url: string;
  accept: string;
  timeoutMs: number | null;
  signal?: AbortSignal;
  maxBytes: number | null;
  errorLabel: string;
  network: RemoteFetchNetworkBoundary;
}>): Promise<OpenedRemoteAcquisition> {
  const opened = await openRemoteAcquisition({
    url: params.url,
    headers: { accept: params.accept },
    policy: REMOTE_PLUGIN_ACQUISITION_POLICY,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    errorLabel: params.errorLabel,
    ...(params.network.fetchImpl ? { fetchImpl: params.network.fetchImpl } : {}),
    ...(params.network.resolveAddresses ? { resolveAddresses: params.network.resolveAddresses } : {}),
  });

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
 * Acquisition enforces an explicit caller/operator budget, if configured,
 * for declared and chunked bodies alike.
 */
async function* readLimitedChunks(params: Readonly<{
  response: Response;
  maxBytes: number | null;
  errorLabel: string;
  signal?: AbortSignal;
}>): AsyncGenerator<Uint8Array> {
  const reader = params.response.body?.getReader();
  if (!reader) {
    throw new Error(`${params.errorLabel} response body is empty`);
  }
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await awaitPluginAcquisition(reader.read(), params.signal);
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (params.maxBytes !== null && totalBytes > params.maxBytes) {
        throw new Error(`${params.errorLabel} exceeds the configured size limit (${params.maxBytes} bytes)`);
      }
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function readRemoteJsonResponseWithLimits<T>(params: Readonly<{
  response: Response;
  signal?: AbortSignal;
  maxBytes?: number | null;
  errorLabel: string;
}>): Promise<T> {
  const maxBytes = params.maxBytes === undefined ? resolvePluginRemoteCatalogMaxBytes() : params.maxBytes;
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error('Invalid remote JSON acquisition budget');
  assertResponseContentLengthWithinLimit({ ...params, maxBytes });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of readLimitedChunks({ ...params, maxBytes })) {
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }
  params.signal?.throwIfAborted();
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

export async function fetchRemoteJsonWithLimits<T>(params: Readonly<{
  url: string;
  accept?: string;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  maxBytes?: number | null;
  errorLabel: string;
  network?: RemoteFetchNetworkBoundary;
}>): Promise<T> {
  const timeoutMs = params.timeoutMs === undefined ? resolvePluginRemoteFetchTimeoutMs() : params.timeoutMs;
  const maxBytes = params.maxBytes === undefined ? resolvePluginRemoteCatalogMaxBytes() : params.maxBytes;
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error('Invalid remote JSON acquisition budget');
  const opened = await openRemoteResponse({
    url: params.url, accept: params.accept ?? 'application/json', timeoutMs,
    signal: params.signal, maxBytes, errorLabel: params.errorLabel, network: params.network ?? {},
  });
  try {
    return await readRemoteJsonResponseWithLimits<T>({
      response: opened.response, signal: opened.signal, maxBytes, errorLabel: params.errorLabel,
    });
  } finally {
    await opened.dispose().catch(() => undefined);
  }
}

export async function downloadRemoteFileWithLimits(params: Readonly<{
  url: string;
  destinationPath: string;
  accept?: string;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  maxBytes?: number | null;
  errorLabel: string;
  network?: RemoteFetchNetworkBoundary;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs === undefined ? resolvePluginRemoteFetchTimeoutMs() : params.timeoutMs;
  const maxBytes = params.maxBytes === undefined ? resolvePluginRemoteArchiveMaxBytes() : params.maxBytes;
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error('Invalid remote archive storage budget');
  const opened = await openRemoteResponse({
    url: params.url,
    accept: params.accept ?? 'application/octet-stream',
    timeoutMs,
    signal: params.signal,
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
        signal: opened.signal,
      })),
      createWriteStream(params.destinationPath),
    );
  } finally {
    await opened.dispose().catch(() => undefined);
  }
  opened.signal?.throwIfAborted();
}
