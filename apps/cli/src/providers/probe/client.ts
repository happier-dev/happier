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

import {
  awaitWithinProviderOperation,
  ProviderOperationAbandonedError,
} from '../operationLifetime';

import {
  ProviderCatalogFormatUnavailableError,
  parseProviderCatalogResponse,
  type ParsedProviderCatalogResponse,
  type ProviderCatalogFormatParser,
} from './parsers';
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
  /** Opaque host-private predicate; credential source values never escape. */
  containsSensitiveValue(value: string): boolean;
  close(): void;
}>;

/**
 * Host-private transport for a managed Provider endpoint the daemon supervises.
 * It is the exact `ManagedServiceHandle.request` for that service, so the probe
 * never opens a second connection with its own auth and timeout rules.
 */
export type ProviderProbeManagedServiceRequest = (
  request: Readonly<{
    pathAndQuery: string;
    method: 'GET' | 'POST';
    headers: Readonly<Record<string, string>>;
    body?: Uint8Array;
    timeoutMs: number;
    signal: AbortSignal;
  }>,
) => Promise<Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: ReadableStream<Uint8Array> | null;
}>>;

export type ProviderCatalogGetRequest = Readonly<{
  endpointUrl: string;
  /**
   * Absolute end of the caller's already-started Provider operation budget.
   * Absent starts the budget here, which is correct only when this request is
   * the whole operation.
   */
  wallDeadlineAtMs?: number;
  path: string;
  parser: ProviderCatalogParserV1;
  /**
   * Implementations of the catalog wire formats the declaring Provider plugin
   * contributes, keyed by format id. A format the host bundles is never taken
   * from here, and an unresolvable format fails typed instead of falling back.
   */
  contributedCatalogParsers?: Readonly<Record<string, ProviderCatalogFormatParser>>;
  publicHeaders: Readonly<Record<string, string>>;
  /** Host-private managed-service transport. Credential material remains with
   * the endpoint owner and is never projected into this request. */
  managedRequest?: ProviderProbeManagedServiceRequest;
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
  /** Absolute end of the explicit model-load operation's wall budget. */
  wallDeadlineAtMs?: number;
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
    | 'provider_probe_response_invalid'
    | 'provider_contribution_unavailable'>;
  readonly retryAfterMs?: number;
  /** Exact response status for caller-owned recovery policy. No response or credential material is retained. */
  readonly httpStatus?: number;

  constructor(
    code: ProviderProbeClientError['code'],
    options: Readonly<{ retryAfterMs?: number; httpStatus?: number }> = {},
  ) {
    super(code);
    this.name = 'ProviderProbeClientError';
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.httpStatus = options.httpStatus;
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

function providerProbeModelFreeFormStrings(
  model: ParsedProviderCatalogResponse['models'][number],
): readonly string[] {
  const values: string[] = [model.id];
  if (model.name) values.push(model.name);
  for (const option of model.modelOptions ?? []) {
    values.push(option.id, option.name, option.type, option.currentValue);
    if (option.description) values.push(option.description);
    for (const choice of option.options ?? []) {
      values.push(choice.value, choice.name);
      if (choice.description) values.push(choice.description);
    }
    if (option.overridesWhenOn) {
      values.push(...option.overridesWhenOn.optionIds);
      if (option.overridesWhenOn.forcedValue) values.push(option.overridesWhenOn.forcedValue);
    }
  }
  return values;
}

function catalogContainsSensitiveRequestValue(
  catalog: ParsedProviderCatalogResponse,
  credentialLease: ProviderProbeHttpCredentialLease | undefined,
  publicHeaderValues: readonly string[],
): boolean {
  const sensitivePublicHeaderValues = [...new Set(publicHeaderValues.filter(Boolean))];
  return catalog.models.some((model) => providerProbeModelFreeFormStrings(model).some((value) =>
    (credentialLease?.containsSensitiveValue(value) ?? false)
    || containsProviderRegisteredSensitiveValue(value, sensitivePublicHeaderValues)));
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

/**
 * One rejection shared by every await in a bounded request, so a transport that
 * ignores its `signal` still cannot outlive the deadline.
 */
function rejectOnAbort(signal: AbortSignal): Readonly<{
  promise: Promise<never>;
  dispose(): void;
}> {
  let onAbort: (() => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('provider_probe_deadline'));
      return;
    }
    onAbort = () => reject(new Error('provider_probe_deadline'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // The race loser is always unobserved; keep it from surfacing as an
  // unhandled rejection.
  promise.catch(() => undefined);
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      onAbort = null;
    },
  };
}

/**
 * Applies the Provider endpoint deadlines the pinned transport already owns to
 * a host-private authenticated transport: one wall budget covering pre-dispatch
 * resolution, establishment and the complete body, plus one idle budget between
 * body chunks. Either breach cancels the response body, so the endpoint owner's
 * connection and the probe scheduler slot are released instead of being held
 * until an external lifecycle transition.
 */
async function readManagedServiceResponseWithProviderProbeDeadlines(input: Readonly<{
  managedRequest: ProviderProbeManagedServiceRequest;
  requestUrl: string;
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  signal: AbortSignal;
  wallTimeMs: number;
  idleTimeMs: number;
  maxResponseBodyBytes: number;
}>): Promise<ProviderProbeTransportResponse> {
  const deadline = new AbortController();
  const wallTimer = setTimeout(
    () => deadline.abort(new Error('provider_probe_wall_timeout')),
    input.wallTimeMs,
  );
  wallTimer.unref?.();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const resetIdle = (): void => {
    clearIdle();
    idleTimer = setTimeout(
      () => deadline.abort(new Error('provider_probe_idle_timeout')),
      input.idleTimeMs,
    );
    idleTimer.unref?.();
  };
  const bounded = AbortSignal.any([input.signal, deadline.signal]);
  const aborted = rejectOnAbort(bounded);
  try {
    const target = new URL(input.requestUrl);
    const establishment = input.managedRequest({
      pathAndQuery: `${target.pathname}${target.search}`,
      method: input.method,
      headers: { ...input.headers },
      ...(input.body === undefined ? {} : { body: input.body }),
      timeoutMs: input.wallTimeMs,
      signal: bounded,
    });
    // A transport that resolves after the deadline still owns a live body; drop
    // it rather than leaving the endpoint owner holding an open response.
    establishment.then(
      (late) => {
        if (bounded.aborted) void late.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    const fetched = await Promise.race([establishment, aborted.promise]);
    // The idle budget bounds the gaps between body chunks, exactly as the
    // pinned transport arms it once response headers arrive. Establishment
    // stays bounded by the wall budget alone.
    resetIdle();
    const chunks: Uint8Array[] = [];
    let encodedBytes = 0;
    const reader = fetched.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          resetIdle();
          let next: Awaited<ReturnType<
            ReadableStreamDefaultReader<Uint8Array>['read']
          >>;
          try {
            next = await Promise.race([reader.read(), aborted.promise]);
          } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
          }
          if (next.done) break;
          encodedBytes += next.value.byteLength;
          if (encodedBytes > input.maxResponseBodyBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error('Provider probe response limit');
          }
          chunks.push(next.value);
        }
      } finally {
        clearIdle();
        reader.releaseLock();
      }
    }
    return {
      status: fetched.status,
      headers: Object.freeze({ ...fetched.headers }),
      body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    };
  } finally {
    clearTimeout(wallTimer);
    clearIdle();
    aborted.dispose();
  }
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
    wallDeadlineAtMs?: number;
    maxResponseBodyBytes: number;
    signal?: AbortSignal;
    authorizeDestination(destination: AssessedProviderEndpoint): Promise<void>;
    managedRequest?: ProviderProbeManagedServiceRequest;
  }>): Promise<Readonly<{
    response: ProviderProbeTransportResponse;
    credentialLease: ProviderProbeHttpCredentialLease | undefined;
  }>> {
    let assessed: AssessedProviderEndpoint;
    // Destination re-resolution is inside this hop's remaining budget: an
    // unresponsive resolver must not extend or outlive the advertised wall
    // time, and `node:dns` cannot be aborted directly. Establishment and body
    // then spend what resolution left rather than restarting the clock.
    const hopDeadlineAtMs = input.wallDeadlineAtMs ?? now() + input.wallTimeMs;
    try {
      const parsed = new URL(input.currentUrl);
      const addresses = await awaitWithinProviderOperation(
        resolveAddresses(resolveUrlConnectionIdentity(parsed.hostname).hostname),
        {
          ...(input.signal ? { signal: input.signal } : {}),
          wallDeadlineAtMs: hopDeadlineAtMs,
        },
        now,
      );
      throwIfCancelled(input.signal);
      assessed = assessProviderEndpoint(input.currentUrl, {
        resolvedAddresses: addresses,
        privateNetworkConfirmed: true,
      });
    } catch (error) {
      if (error instanceof ProviderProbeCancelledError) throw error;
      if (error instanceof ProviderOperationAbandonedError && error.reason === 'cancelled') {
        throw new ProviderProbeCancelledError();
      }
      throw new ProviderProbeClientError('provider_endpoint_unreachable');
    }
    const operationLifetime = {
      ...(input.signal ? { signal: input.signal } : {}),
      wallDeadlineAtMs: hopDeadlineAtMs,
    };
    try {
      await awaitWithinProviderOperation(
        input.authorizeDestination(assessed),
        operationLifetime,
        now,
      );
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError && error.reason === 'cancelled') {
        throw new ProviderProbeCancelledError();
      }
      if (error instanceof ProviderOperationAbandonedError) {
        throw new ProviderProbeClientError('provider_endpoint_unreachable');
      }
      throw error;
    }
    throwIfCancelled(input.signal);
    let credentialLease: ProviderProbeHttpCredentialLease | undefined;
    try {
      if (input.resolveCredential) {
        const pendingCredentialLease = input.resolveCredential();
        try {
          credentialLease = await awaitWithinProviderOperation(
            pendingCredentialLease,
            operationLifetime,
            now,
          );
        } catch (error) {
          // Acquisition can be backed by an unabortable external credential
          // owner. If it settles after this operation retires, close the late
          // lease immediately instead of leaking secret/redaction custody.
          void pendingCredentialLease.then((lateLease) => lateLease.close(), () => {});
          if (error instanceof ProviderOperationAbandonedError && error.reason === 'cancelled') {
            throw new ProviderProbeCancelledError();
          }
          if (error instanceof ProviderOperationAbandonedError) {
            throw new ProviderProbeClientError('provider_endpoint_unreachable');
          }
          throw error;
        }
      }
      throwIfCancelled(input.signal);
      const credential = credentialLease?.credential;
      const remainingWallTimeMs = hopDeadlineAtMs - now();
      if (remainingWallTimeMs <= 0) throw new ProviderProbeClientError('provider_endpoint_unreachable');
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
        const signal = input.signal ?? new AbortController().signal;
        const requestBody = input.body === undefined
          ? undefined
          : new Uint8Array(input.body);
        const response = input.managedRequest
          ? await readManagedServiceResponseWithProviderProbeDeadlines({
              managedRequest: input.managedRequest,
              requestUrl,
              method: input.method,
              headers,
              ...(requestBody === undefined ? {} : { body: requestBody }),
              signal,
              wallTimeMs: remainingWallTimeMs,
              idleTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxIdleTimeMs,
              maxResponseBodyBytes: input.maxResponseBodyBytes,
            })
          : await transport({
              url: requestUrl,
              hostname: assessed.hostname,
              servername: assessed.hostname,
              validatedAddresses: assessed.resolvedAddresses,
              headers,
              method: input.method,
              ...(input.body ? { body: input.body } : {}),
              signal,
              wallTimeMs: remainingWallTimeMs,
              idleTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxIdleTimeMs,
              maxResponseBodyBytes: input.maxResponseBodyBytes,
            });
        return { response, credentialLease };
      } catch (error) {
        if (input.signal?.aborted || error instanceof ProviderProbeCancelledError) {
          throw new ProviderProbeCancelledError();
        }
        throw new ProviderProbeClientError('provider_endpoint_unreachable');
      }
    } catch (error) {
      credentialLease?.close();
      throw error;
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
      // One wall budget for the catalog read, spent across every redirect hop.
      // A per-hop budget would let the declared redirect chain multiply the
      // advertised ceiling by `maxRedirects + 1`.
      const wallDeadlineAtMs = input.wallDeadlineAtMs
        ?? now() + PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs;
      while (true) {
        const remainingWallTimeMs = wallDeadlineAtMs - now();
        if (remainingWallTimeMs <= 0) {
          throw new ProviderProbeClientError('provider_endpoint_unreachable');
        }
        const headers: Record<string, string> = { ...redirectPublicHeaders, accept: 'application/json' };
        const dispatched = await dispatchSafeRequest({
          currentUrl,
          publicHeaders: headers,
          ...(resolveCredential ? { resolveCredential } : {}),
          method: 'GET',
          wallTimeMs: remainingWallTimeMs,
          wallDeadlineAtMs,
          maxResponseBodyBytes: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxDecodedBodyBytes,
          ...(input.signal ? { signal: input.signal } : {}),
          authorizeDestination: input.authorizeDestination,
          ...(input.managedRequest
            ? { managedRequest: input.managedRequest }
            : {}),
        });
        const { response, credentialLease } = dispatched;
        const credential = credentialLease?.credential;
        try {
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
            const redirectTarget = redirected.toString();
            if (
              (credentialLease?.containsSensitiveValue(redirectTarget) ?? false)
              || containsProviderRegisteredSensitiveValue(
                redirectTarget,
                Object.values(publicHeaders),
              )
            ) {
              throw new ProviderProbeClientError('provider_probe_response_invalid');
            }
            if (redirected.origin !== new URL(currentUrl).origin) {
              resolveCredential = undefined;
              redirectPublicHeaders = {};
            }
            currentUrl = redirectTarget;
            redirects += 1;
            continue;
          }
          if (response.status === 401 || response.status === 403) {
            if (input.credentialPolicy === 'none') {
              throw new ProviderProbeClientError('provider_probe_response_invalid');
            }
            throw new ProviderProbeClientError(
              credential ? 'provider_endpoint_unauthorized' : 'provider_endpoint_auth_required',
              { httpStatus: response.status },
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
            catalog = parseProviderCatalogResponse(
              input.parser,
              json,
              input.contributedCatalogParsers,
            );
          } catch (error) {
            // A declared format with no reachable implementation is a plugin
            // availability fact, not a malformed response from the endpoint.
            if (error instanceof ProviderCatalogFormatUnavailableError) {
              throw new ProviderProbeClientError('provider_contribution_unavailable');
            }
            throw new ProviderProbeClientError('provider_probe_response_invalid');
          }
          if (catalogContainsSensitiveRequestValue(
            catalog,
            credentialLease,
            Object.values(publicHeaders),
          )) {
            throw new ProviderProbeClientError('provider_probe_response_invalid');
          }
          return {
            requestFingerprint,
            finalUrl: currentUrl,
            compatibilityDiagnostic: metadata.compatibilityDiagnostic,
            catalog,
          };
        } finally {
          credentialLease?.close();
        }
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
        ...(input.wallDeadlineAtMs !== undefined
          ? { wallDeadlineAtMs: input.wallDeadlineAtMs }
          : {}),
        maxResponseBodyBytes: PROVIDER_MODEL_LOAD_HTTP_LIMITS.maxDecodedBodyBytes,
        ...(input.signal ? { signal: input.signal } : {}),
        authorizeDestination: input.authorizeDestination,
      });
      const { response, credentialLease } = dispatched;
      const credential = credentialLease?.credential;
      try {
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
      } finally {
        credentialLease?.close();
      }
    },
  };
}
