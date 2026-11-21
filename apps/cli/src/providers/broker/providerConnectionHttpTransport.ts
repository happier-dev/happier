import type { ManagedServiceRequest, ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeProviderOriginRelativePathSyntax } from '@happier-dev/protocol/providers/safety/url';

import { openPinnedHttpStream, type PinnedHttpStreamResponse, type PinnedHttpStreamTransport } from '@/network/pinnedHttp';
import type { ManagedProviderEndpointAccessProjection } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import type { resolveRuntimeProviderCredential } from '@/providers/spawn/runtimeCredential';

import { ProviderBrokerApplicationFailureError, providerBrokerApplicationFailureBody } from './providerBrokerApplicationFailure';
import { preserveBrokerSourceHealthFailure } from './sourceFailure';

type RuntimeCredentialLease = Extract<Awaited<ReturnType<typeof resolveRuntimeProviderCredential>>, { ok: true }>['lease'];
type RequestCredentialLease = RuntimeCredentialLease & Readonly<{
  queryParameters?: Readonly<Record<string, string>>;
  onResponse?(status: number, signal: AbortSignal): Promise<void>;
}>;

type OpenInput = Readonly<{
  applicationEndpointTemplateId: string;
  applicationBaseUrl: string;
  endpoint: Readonly<{
    normalizedUrl: string;
    resolvedAddresses: readonly string[];
    publicHeaders: Readonly<Record<string, string>>;
  }>;
  signal: AbortSignal;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  acquireRequestCredential(signal?: AbortSignal): Promise<RequestCredentialLease | null>;
}>;

export type ProviderConnectionHttpTransport = Readonly<{
  open(input: OpenInput): Promise<(ManagedProviderEndpointAccessProjection & Readonly<{
    retire(): Promise<void>;
  }>) | null>;
}>;

const PRIVATE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-goog-api-key',
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding',
  'cookie', 'set-cookie', 'set-cookie2',
]);

function mayForwardHeader(name: string): boolean {
  return !PRIVATE_HEADERS.has(name) && !name.startsWith('x-happier-');
}

function sourceUnavailable(): ProviderBrokerApplicationFailureError {
  return new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable' });
}

function upstreamUnavailable(cause?: unknown): ManagedServiceResponse {
  const failure = cause === undefined ? null : providerBrokerApplicationFailureBody({
    ok: false, reasonCode: 'broker_unavailable', failureCause: projectActionFailureCauseV1(cause),
  }, undefined);
  return {
    ok: false, status: 502, statusText: 'Upstream unavailable',
    headers: failure ? { 'content-type': 'application/json' } : {},
    body: failure ? new Response(JSON.stringify(failure)).body : null,
  };
}

function requestTarget(input: OpenInput, basePath: string, pathAndQuery: string): URL {
  const acceptedPath = normalizeProviderOriginRelativePathSyntax(pathAndQuery, { allowQuery: true });
  const queryStart = acceptedPath.indexOf('?');
  const path = queryStart === -1 ? acceptedPath : acceptedPath.slice(0, queryStart);
  if (basePath && path !== basePath && !path.startsWith(`${basePath}/`)) throw sourceUnavailable();
  const target = new URL(input.endpoint.normalizedUrl);
  target.pathname = `${target.pathname.replace(/\/$/u, '')}${path.slice(basePath.length) || '/'}`;
  target.search = queryStart === -1 ? '' : acceptedPath.slice(queryStart);
  return target;
}

function requestHeaders(input: OpenInput, request: ManagedServiceRequest, lease: RequestCredentialLease): Record<string, string> {
  const material = new Map<string, string>();
  for (const credential of [lease.credential, ...(lease.credential.additionalCredentials ?? [])]) {
    const name = credential.name.toLowerCase();
    if (credential.kind !== 'httpHeader' || !credential.value || /[\u0000-\u001f\u007f]/u.test(credential.value)
      || material.has(name) || Object.hasOwn(input.endpoint.publicHeaders, name)) throw sourceUnavailable();
    material.set(name, credential.value);
  }
  const headers: Record<string, string> = Object.create(null);
  for (const [rawName, value] of Object.entries(request.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!mayForwardHeader(name) || material.has(name)) continue;
    if (Object.hasOwn(input.endpoint.publicHeaders, name)) throw sourceUnavailable();
    headers[name] = value;
  }
  return Object.assign(headers, input.endpoint.publicHeaders, Object.fromEntries(material), { 'accept-encoding': 'identity' });
}

function streamResponseBody(response: PinnedHttpStreamResponse, signal: AbortSignal, lease: RequestCredentialLease): ReadableStream<Uint8Array> {
  const sanitizer = lease.createStreamingSanitizer();
  const encoder = new TextEncoder();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', settle);
    response.cancel();
    lease.close();
  };
  signal.addEventListener('abort', settle, { once: true });
  if (signal.aborted) settle();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        for (;;) {
          const chunk = await response.read();
          if (settled) {
            signal.throwIfAborted();
            return;
          }
          if (chunk === null) {
            const tail = sanitizer.flush();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            settle();
            return;
          }
          const safe = sanitizer.push(chunk);
          if (safe) {
            controller.enqueue(encoder.encode(safe));
            return;
          }
        }
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    cancel: settle,
  });
}

/** Opens scoped access from admitted source facts. The source owner provides a
 * fresh credential for each request and the network owner dials its admitted IPs. */
export function createProviderConnectionHttpTransport(
  options: Readonly<{ openHttp?: PinnedHttpStreamTransport }> = {},
): ProviderConnectionHttpTransport {
  const openHttp = options.openHttp ?? openPinnedHttpStream;
  return {
    async open(input) {
      if (Object.keys(input.endpoint.publicHeaders).some(name => !mayForwardHeader(name))) return null;
      if (!await input.isCurrent(input.signal)) return null;
      const scope = new AbortController();
      const lifetime = AbortSignal.any([scope.signal, input.signal]);
      const basePath = new URL(input.applicationBaseUrl).pathname.replace(/\/$/u, '');
      const request = async (requestInput: ManagedServiceRequest): Promise<ManagedServiceResponse> => {
        const signal = requestInput.signal ? AbortSignal.any([lifetime, requestInput.signal]) : lifetime;
        signal.throwIfAborted();
        const target = requestTarget(input, basePath, requestInput.pathAndQuery);
        const lease = await input.acquireRequestCredential(signal).catch(error => {
          preserveBrokerSourceHealthFailure(error);
          throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable',
            failureCause: projectActionFailureCauseV1(error) });
        });
        if (!lease) throw sourceUnavailable();
        try {
          const headers = requestHeaders(input, requestInput, lease);
          for (const [name, value] of Object.entries(lease.queryParameters ?? {})) target.searchParams.set(name, value);
          signal.throwIfAborted();
          const response = await openHttp({
            url: target.href, validatedAddresses: input.endpoint.resolvedAddresses, headers,
            method: requestInput.method, body: requestInput.body, signal,
          });
          const encoding = response.headers['content-encoding'];
          if (signal.aborted || (response.status >= 300 && response.status < 400)
            || (encoding !== undefined && encoding.toLowerCase() !== 'identity')) {
            response.cancel();
            lease.close();
            return upstreamUnavailable();
          }
          // The lease owner classifies the status for future requests. Preserve this response if recovery fails.
          await lease.onResponse?.(response.status, signal).catch(() => undefined);
          const filtered = Object.fromEntries(Object.entries(response.headers).flatMap(([name, value]) => (
            value !== undefined && mayForwardHeader(name) && !lease.containsSensitiveValue(value) ? [[name, value]] : []
          )));
          return {
            status: response.status, ok: response.status >= 200 && response.status < 300, statusText: '',
            headers: filtered, body: streamResponseBody(response, signal, lease),
          };
        } catch (error) {
          lease.close();
          if (error instanceof ProviderBrokerApplicationFailureError) throw error;
          return upstreamUnavailable(error);
        }
      };
      return {
        access: {
          endpointUrl: id => id === input.applicationEndpointTemplateId ? input.applicationBaseUrl : null,
          request,
        },
        isCurrent: () => !lifetime.aborted,
        cleanup: () => scope.abort(),
        retire: async () => scope.abort(),
      };
    },
  };
}
