import { lookup } from 'node:dns/promises';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import {
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  assessProviderEndpoint,
  containsProviderRegisteredSensitiveValue,
  createProviderProbeRequestFingerprintV1,
  ProviderModelIdSchema,
  ProviderOriginRelativePathSchema,
  normalizeProviderCredentialHeaderName,
  normalizeProviderPublicHeaders,
  normalizeProviderQueryParameterName,
  validateProviderProbeResponseMetadata,
  type ProviderCatalogParserV1,
  type AssessedProviderEndpoint,
  type ProviderErrorCodeV1,
  type ProviderProbeRequestFingerprintV1,
} from '@happier-dev/protocol';

import { resolveUrlConnectionIdentity } from '@/network/urlConnectionIdentity';

import { parseProviderCatalogResponse, type ParsedProviderCatalogResponse } from './parsers';
import { openPinnedHttpStream } from '../../network/pinnedHttp';

export type ProviderProbeTransportRequest = Readonly<{
  url: string;
  hostname: string;
  servername: string;
  validatedAddresses: readonly string[];
  headers: Readonly<Record<string, string>>;
  method: 'GET' | 'POST';
  body?: Uint8Array;
  signal: AbortSignal;
  wallTimeMs: number;
  idleTimeMs: number;
  maxResponseBodyBytes: number;
}>;

export type ProviderProbeTransportResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}>;

export type ProviderProbeTransport = (
  request: ProviderProbeTransportRequest,
) => Promise<ProviderProbeTransportResponse>;

export type ProviderProbeCredential =
  | Readonly<{ kind: 'httpHeader'; name: string; value: string }>
  | Readonly<{ kind: 'queryParam'; name: string; value: string }>;

export type ProviderProbeHttpCredentialLease = Readonly<{
  credential: ProviderProbeCredential;
  close(): void;
}>;

export type ProviderCatalogGetRequest = Readonly<{
  endpointUrl: string;
  path: string;
  parser: ProviderCatalogParserV1;
  publicHeaders: Readonly<Record<string, string>>;
  resolveCredential?: () => Promise<ProviderProbeHttpCredentialLease>;
  credentialPolicy?: 'none' | 'optional' | 'required';
  authorizeDestination(destination: AssessedProviderEndpoint): Promise<void>;
  signal?: AbortSignal;
}>;

export type ProviderCatalogGetResult = Readonly<{
  requestFingerprint: ProviderProbeRequestFingerprintV1;
  finalUrl: string;
  compatibilityDiagnostic: boolean;
  catalog: ParsedProviderCatalogResponse;
}>;

export const PROVIDER_MODEL_LOAD_HTTP_LIMITS = Object.freeze({
  wallTimeMs: 10 * 60 * 1_000,
  maxDecodedBodyBytes: 1024 * 1024,
} as const);

export type ProviderModelLoadPostRequest = Readonly<{
  endpointUrl: string;
  path: string;
  publicHeaders: Readonly<Record<string, string>>;
  modelId: string;
  resolveCredential?: () => Promise<ProviderProbeHttpCredentialLease>;
  authorizeDestination(destination: AssessedProviderEndpoint): Promise<void>;
  signal?: AbortSignal;
}>;

export type ProviderModelLoadPostResult = Readonly<{ statusCode: number }>;

export class ProviderProbeClientError extends Error {
  readonly code: Extract<ProviderErrorCodeV1,
    | 'provider_endpoint_unreachable'
    | 'provider_endpoint_unavailable'
    | 'provider_endpoint_rate_limited'
    | 'provider_endpoint_auth_required'
    | 'provider_endpoint_unauthorized'
    | 'provider_probe_response_invalid'>;
  readonly retryAfterMs?: number;

  constructor(
    code: ProviderProbeClientError['code'],
    options: Readonly<{ retryAfterMs?: number }> = {},
  ) {
    super(code);
    this.name = 'ProviderProbeClientError';
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Caller cancellation is control flow, not settled endpoint health. */
export class ProviderProbeCancelledError extends Error {
  constructor() {
    super('Provider probe cancelled');
    this.name = 'ProviderProbeCancelledError';
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ProviderProbeCancelledError();
}

function headerValue(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function boundedRetryAfterMs(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  const delay = Number.isFinite(seconds)
    ? Math.max(0, Math.floor(seconds * 1_000))
    : Math.max(0, Date.parse(value) - now);
  if (!Number.isFinite(delay)) return undefined;
  return Math.min(86_400_000, delay);
}

function decodeResponseBody(body: Uint8Array, encoding: string, maxDecodedBodyBytes: number): Buffer {
  const source = Buffer.from(body);
  const maxOutputLength = maxDecodedBodyBytes + 1;
  let decoded: Buffer;
  try {
    switch (encoding) {
      case 'identity': decoded = source; break;
      case 'gzip': decoded = gunzipSync(source, { maxOutputLength }); break;
      case 'deflate': decoded = inflateSync(source, { maxOutputLength }); break;
      case 'br': decoded = brotliDecompressSync(source, { maxOutputLength }); break;
      default: throw new Error('unsupported');
    }
  } catch {
    throw new ProviderProbeClientError('provider_probe_response_invalid');
  }
  if (decoded.byteLength > maxDecodedBodyBytes) {
    throw new ProviderProbeClientError('provider_probe_response_invalid');
  }
  return decoded;
}

function catalogContainsSensitiveRequestValue(
  catalog: ParsedProviderCatalogResponse,
  values: readonly (string | undefined)[],
): boolean {
  const sensitiveValues = [...new Set(values.filter((value): value is string => Boolean(value)))];
  if (sensitiveValues.length === 0) return false;
  return catalog.models.some((model) =>
    containsProviderRegisteredSensitiveValue(model.id, sensitiveValues)
    || (model.name ? containsProviderRegisteredSensitiveValue(model.name, sensitiveValues) : false));
}

async function defaultResolveAddresses(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

async function defaultTransport(input: ProviderProbeTransportRequest): Promise<ProviderProbeTransportResponse> {
  const response = await openPinnedHttpStream({
    url: input.url,
    validatedAddresses: input.validatedAddresses,
    headers: input.headers,
    method: input.method,
    ...(input.body ? { body: input.body } : {}),
    signal: input.signal,
    wallTimeMs: input.wallTimeMs,
    idleTimeMs: input.idleTimeMs,
  });
  const chunks: Uint8Array[] = [];
  let encodedBytes = 0;
  for (;;) {
    const chunk = await response.read();
    if (chunk === null) break;
    encodedBytes += chunk.byteLength;
    if (encodedBytes > input.maxResponseBodyBytes) {
      response.cancel();
      throw new Error('Provider probe response limit');
    }
    chunks.push(chunk);
  }
  return {
    status: response.status,
    headers: response.headers,
    body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  };
}

export function createProviderProbeHttpClient(dependencies: Readonly<{
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  transport?: ProviderProbeTransport;
  now?: () => number;
}> = {}) {
  const resolveAddresses = dependencies.resolveAddresses ?? defaultResolveAddresses;
  const transport = dependencies.transport ?? defaultTransport;
  const now = dependencies.now ?? Date.now;

  async function dispatchSafeRequest(input: Readonly<{
    currentUrl: string;
    publicHeaders: Readonly<Record<string, string>>;
    resolveCredential?: () => Promise<ProviderProbeHttpCredentialLease>;
    method: 'GET' | 'POST';
    body?: Uint8Array;
    wallTimeMs: number;
    maxResponseBodyBytes: number;
    signal?: AbortSignal;
    authorizeDestination(destination: AssessedProviderEndpoint): Promise<void>;
  }>): Promise<Readonly<{
    response: ProviderProbeTransportResponse;
    credential: ProviderProbeCredential | undefined;
  }>> {
    let assessed: AssessedProviderEndpoint;
    try {
      const parsed = new URL(input.currentUrl);
      const addresses = await resolveAddresses(resolveUrlConnectionIdentity(parsed.hostname).hostname);
      throwIfCancelled(input.signal);
      assessed = assessProviderEndpoint(input.currentUrl, {
        resolvedAddresses: addresses,
        privateNetworkConfirmed: true,
      });
    } catch (error) {
      if (error instanceof ProviderProbeCancelledError) throw error;
      throw new ProviderProbeClientError('provider_endpoint_unreachable');
    }
    await input.authorizeDestination(assessed);
    throwIfCancelled(input.signal);
    let credentialLease: ProviderProbeHttpCredentialLease | undefined;
    try {
      credentialLease = input.resolveCredential ? await input.resolveCredential() : undefined;
      throwIfCancelled(input.signal);
      const credential = credentialLease?.credential;
      const headers: Record<string, string> = { ...input.publicHeaders };
      let requestUrl = assessed.normalizedUrl;
      if (credential?.kind === 'httpHeader') {
        headers[normalizeProviderCredentialHeaderName(credential.name)] = credential.value;
      } else if (credential?.kind === 'queryParam') {
        const url = new URL(requestUrl);
        url.searchParams.set(normalizeProviderQueryParameterName(credential.name), credential.value);
        requestUrl = url.toString();
      }
      try {
        const response = await transport({
          url: requestUrl,
          hostname: assessed.hostname,
          servername: assessed.hostname,
          validatedAddresses: assessed.resolvedAddresses,
          headers,
          method: input.method,
          ...(input.body ? { body: input.body } : {}),
          signal: input.signal ?? new AbortController().signal,
          wallTimeMs: input.wallTimeMs,
          idleTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxIdleTimeMs,
          maxResponseBodyBytes: input.maxResponseBodyBytes,
        });
        return { response, credential };
      } catch (error) {
        if (input.signal?.aborted || error instanceof ProviderProbeCancelledError) {
          throw new ProviderProbeCancelledError();
        }
        throw new ProviderProbeClientError('provider_endpoint_unreachable');
      }
    } finally {
      credentialLease?.close();
    }
  }

  return {
    async getCatalog(input: ProviderCatalogGetRequest): Promise<ProviderCatalogGetResult> {
      throwIfCancelled(input.signal);
      const publicHeaders = normalizeProviderPublicHeaders(input.publicHeaders);
      const requestFingerprint = createProviderProbeRequestFingerprintV1({
        method: 'GET', endpointUrl: input.endpointUrl, path: input.path, parser: input.parser, publicHeaders,
      });
      const initialUrl = new URL(input.path, input.endpointUrl).toString();
      let currentUrl = initialUrl;
      let resolveCredential = input.resolveCredential;
      let redirectPublicHeaders: Readonly<Record<string, string>> = publicHeaders;
      let redirects = 0;
      while (true) {
        const headers: Record<string, string> = { ...redirectPublicHeaders, accept: 'application/json' };
        const dispatched = await dispatchSafeRequest({
          currentUrl,
          publicHeaders: headers,
          ...(resolveCredential ? { resolveCredential } : {}),
          method: 'GET',
          wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
          maxResponseBodyBytes: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxDecodedBodyBytes,
          ...(input.signal ? { signal: input.signal } : {}),
          authorizeDestination: input.authorizeDestination,
        });
        const { response, credential } = dispatched;
        throwIfCancelled(input.signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = headerValue(response.headers, 'location');
          if (!location || redirects >= PROVIDER_ENDPOINT_SAFETY_LIMITS.maxRedirects) {
            throw new ProviderProbeClientError('provider_probe_response_invalid');
          }
          let redirected: URL;
          try {
            redirected = new URL(location, currentUrl);
          } catch {
            throw new ProviderProbeClientError('provider_probe_response_invalid');
          }
          if (containsProviderRegisteredSensitiveValue(redirected.toString(), [
            credential?.value ?? '',
            ...Object.values(publicHeaders),
          ])) {
            throw new ProviderProbeClientError('provider_probe_response_invalid');
          }
          if (redirected.origin !== new URL(currentUrl).origin) {
            resolveCredential = undefined;
            redirectPublicHeaders = {};
          }
          currentUrl = redirected.toString();
          redirects += 1;
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          if (input.credentialPolicy === 'none') {
            throw new ProviderProbeClientError('provider_probe_response_invalid');
          }
          throw new ProviderProbeClientError(
            credential ? 'provider_endpoint_unauthorized' : 'provider_endpoint_auth_required',
          );
        }
        if (response.status === 429) {
          throw new ProviderProbeClientError('provider_endpoint_rate_limited', {
            retryAfterMs: boundedRetryAfterMs(headerValue(response.headers, 'retry-after'), now()),
          });
        }
        if (response.status >= 500 && response.status <= 599) {
          throw new ProviderProbeClientError('provider_endpoint_unavailable');
        }
        if (response.status < 200 || response.status >= 300) {
          throw new ProviderProbeClientError('provider_probe_response_invalid');
        }
        let metadata;
        try {
          metadata = validateProviderProbeResponseMetadata({
            contentType: headerValue(response.headers, 'content-type'),
            contentEncoding: headerValue(response.headers, 'content-encoding'),
          });
        } catch {
          throw new ProviderProbeClientError('provider_probe_response_invalid');
        }
        const decoded = decodeResponseBody(
          response.body,
          metadata.encoding,
          PROVIDER_ENDPOINT_SAFETY_LIMITS.maxDecodedBodyBytes,
        );
        let json: unknown;
        try {
          json = JSON.parse(decoded.toString('utf8')) as unknown;
        } catch {
          throw new ProviderProbeClientError('provider_probe_response_invalid');
        }
        let catalog: ParsedProviderCatalogResponse;
        try {
          catalog = parseProviderCatalogResponse(input.parser, json);
        } catch {
          throw new ProviderProbeClientError('provider_probe_response_invalid');
        }
        if (catalogContainsSensitiveRequestValue(catalog, [
          credential?.value,
          ...Object.values(publicHeaders),
        ])) {
          throw new ProviderProbeClientError('provider_probe_response_invalid');
        }
        return {
          requestFingerprint,
          finalUrl: currentUrl,
          compatibilityDiagnostic: metadata.compatibilityDiagnostic,
          catalog,
        };
      }
    },
    async postModelLoad(input: ProviderModelLoadPostRequest): Promise<ProviderModelLoadPostResult> {
      throwIfCancelled(input.signal);
      const publicHeaders = normalizeProviderPublicHeaders(input.publicHeaders);
      const path = ProviderOriginRelativePathSchema.parse(input.path);
      const modelId = ProviderModelIdSchema.parse(input.modelId);
      const currentUrl = new URL(path, input.endpointUrl).toString();
      const body = Buffer.from(JSON.stringify({ model: modelId }), 'utf8');
      const headers: Record<string, string> = {
        ...publicHeaders,
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
      };
      const dispatched = await dispatchSafeRequest({
        currentUrl,
        publicHeaders: headers,
        ...(input.resolveCredential ? { resolveCredential: input.resolveCredential } : {}),
        method: 'POST',
        body,
        wallTimeMs: PROVIDER_MODEL_LOAD_HTTP_LIMITS.wallTimeMs,
        maxResponseBodyBytes: PROVIDER_MODEL_LOAD_HTTP_LIMITS.maxDecodedBodyBytes,
        ...(input.signal ? { signal: input.signal } : {}),
        authorizeDestination: input.authorizeDestination,
      });
      const { response, credential } = dispatched;
      throwIfCancelled(input.signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        throw new ProviderProbeClientError('provider_probe_response_invalid');
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderProbeClientError(
          credential ? 'provider_endpoint_unauthorized' : 'provider_endpoint_auth_required',
        );
      }
      if (response.status === 429) {
        throw new ProviderProbeClientError('provider_endpoint_rate_limited', {
          retryAfterMs: boundedRetryAfterMs(headerValue(response.headers, 'retry-after'), now()),
        });
      }
      if (response.status >= 500 && response.status <= 599) {
        throw new ProviderProbeClientError('provider_endpoint_unavailable');
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ProviderProbeClientError('provider_probe_response_invalid');
      }
      const encoding = headerValue(response.headers, 'content-encoding')?.trim().toLowerCase() || 'identity';
      decodeResponseBody(response.body, encoding, PROVIDER_MODEL_LOAD_HTTP_LIMITS.maxDecodedBodyBytes);
      return { statusCode: response.status };
    },
  };
}
