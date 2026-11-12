import { Buffer } from 'node:buffer';

import type { ManagedServiceRequest, ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';
import type { ProviderBrokerApplicationBindingV1, ProviderWireProtocol } from '@happier-dev/protocol';
import type { ProviderBrokerSourceApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { projectManagedProviderBrokerApplication } from './applicationProjection';
import { getProviderContribution } from '@/providers/registry';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import type {
  ProviderConnectionCpxBridge,
  ProviderConnectionCpxBridgeOpenInput,
} from './providerConnectionSource';
import { acquireBrokerSourceOperation } from './brokerSourceOperationAcquisition';
import { readProviderBrokerTransportFailure } from './providerBrokerTransportFailure';
import { ProviderBrokerApplicationFailureError } from './providerBrokerApplicationFailure';

const SOURCE_CREDENTIAL_HEADER = 'x-happier-provider-source-credential';
const SOURCE_ADDITIONAL_CREDENTIALS_HEADER = 'x-happier-provider-source-additional-credentials';

/** Exact requests admit their declared implementation without a catalog scan.
 * Discovery requires a unique declaration because it has no selected identity. */
export function readProviderConnectionBrokerImplementation(
  registry: ProviderContributionRegistryView,
  implementationIdentity?: ProviderBrokerApplicationBindingV1['implementationIdentity'],
): ResolvedProviderContribution | null {
  if (implementationIdentity) {
    const provider = getProviderContribution(registry,
      `${implementationIdentity.pluginId}/${implementationIdentity.localId}`);
    return provider?.definition.managedRuntime?.sourceEnvelopeTransport === 'cpx-v1' ? provider : null;
  }
  let implementation: ResolvedProviderContribution | null = null;
  for (const provider of registry.providersByContributionKey.values()) {
    if (provider.definition.managedRuntime?.sourceEnvelopeTransport !== 'cpx-v1') continue;
    if (implementation) return null;
    implementation = provider;
  }
  return implementation;
}

/** The contribution declares this private transport; endpoint and protocol
 * admission remain with the current registry's application projection. */
type BrokerApplicationInput = Readonly<{
  registry: ProviderContributionRegistryView;
  agentTargetKey?: string;
  protocol: ProviderWireProtocol;
  expectedApplication?: ProviderBrokerSourceApplicationBindingV1;
}>;
export function projectProviderConnectionBrokerApplication(input: BrokerApplicationInput & { agentTargetKey: string }): ProviderBrokerApplicationBindingV1 | null;
export function projectProviderConnectionBrokerApplication(input: BrokerApplicationInput): ProviderBrokerSourceApplicationBindingV1 | null;
export function projectProviderConnectionBrokerApplication(input: BrokerApplicationInput): ProviderBrokerSourceApplicationBindingV1 | null {
  const identity = readProviderConnectionBrokerImplementation(input.registry,
    input.expectedApplication?.implementationIdentity)?.identity;
  if (!identity) return null;
  if (input.expectedApplication && (
    input.expectedApplication.implementationIdentity.pluginId !== identity.pluginId
    || input.expectedApplication.implementationIdentity.localId !== identity.localId
    || input.expectedApplication.agentTargetKey !== input.agentTargetKey
    || input.expectedApplication.protocol !== input.protocol
  )) return null;
  return projectManagedProviderBrokerApplication({
    registry: input.registry,
    implementationIdentity: identity,
    agentTargetKey: input.agentTargetKey,
    protocol: input.protocol,
    ...(input.expectedApplication ? { endpointTemplateId: input.expectedApplication.endpointTemplateId } : {}),
  });
}
const SOURCE_DESCRIPTOR_HEADER = 'x-happier-provider-source';
const PRIVATE_REQUEST_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  SOURCE_CREDENTIAL_HEADER,
  SOURCE_ADDITIONAL_CREDENTIALS_HEADER,
  SOURCE_DESCRIPTOR_HEADER,
  'x-happier-machine-local-capability',
  'x-happier-provider-broker-authority',
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
]);

function upstreamUnavailable(): ManagedServiceResponse {
  return Object.freeze({
    ok: false,
    status: 502,
    statusText: 'Upstream unavailable',
    headers: Object.freeze({}),
    body: null,
  });
}

function safePublicHeaders(headers: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(headers);
  return entries.every(([rawName, value]) => {
    const name = rawName.toLowerCase();
    return rawName === name
      && !PRIVATE_REQUEST_HEADERS.has(name)
      && !/[\0\r\n]/u.test(value);
    });
}

function descriptor(
  input: ProviderConnectionCpxBridgeOpenInput,
  credentialHeaderName: string,
  additionalCredentialHeaderNames: readonly string[] = [],
): string {
  return Buffer.from(JSON.stringify({
    baseUrl: input.endpoint.normalizedUrl,
    resolvedAddresses: input.endpoint.resolvedAddresses,
    publicHeaders: input.endpoint.publicHeaders,
    credentialHeaderName: credentialHeaderName.toLowerCase(),
    ...(additionalCredentialHeaderNames.length ? { additionalCredentialHeaderNames } : {}),
  }), 'utf8').toString('base64url');
}

function requestHeaders(
  caller: Readonly<Record<string, string>> | undefined,
  providerHeaders: Readonly<Record<string, string>>,
  sourceDescriptor: string,
  credential: string,
  additionalCredentials?: string,
): Readonly<Record<string, string>> | null {
  const result: Record<string, string> = Object.create(null);
  for (const [rawName, value] of Object.entries(caller ?? {})) {
    const name = rawName.toLowerCase();
    if (Object.hasOwn(providerHeaders, name)) return null;
    if (!PRIVATE_REQUEST_HEADERS.has(name)) result[name] = value;
  }
  result[SOURCE_DESCRIPTOR_HEADER] = sourceDescriptor;
  result[SOURCE_CREDENTIAL_HEADER] = credential;
  if (additionalCredentials !== undefined) result[SOURCE_ADDITIONAL_CREDENTIALS_HEADER] = additionalCredentials;
  result['accept-encoding'] = 'identity';
  return Object.freeze(result);
}

function responseHeaders(
  headers: Readonly<Record<string, string>>,
  containsSensitiveValue: (value: string) => boolean,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      !PRIVATE_REQUEST_HEADERS.has(name)
      && name !== 'set-cookie'
      && name !== 'set-cookie2'
      && !containsSensitiveValue(value)
    ) result[name] = value;
  }
  return Object.freeze(result);
}

function bindResponseBody(
  body: ManagedServiceResponse['body'],
  signal: AbortSignal | undefined,
  cleanup: () => void,
  sanitizer: Readonly<{ push(chunk: Uint8Array): string; flush(): string }>,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    cleanup();
    return null;
  }
  const reader = body.getReader();
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', abort);
    cleanup();
  };
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined).finally(settle); };
  signal?.addEventListener('abort', abort, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          const tail = sanitizer.flush();
          if (tail) controller.enqueue(new TextEncoder().encode(tail));
          controller.close();
          settle();
        } else {
          const safe = sanitizer.push(next.value);
          if (safe) controller.enqueue(new TextEncoder().encode(safe));
        }
      } catch (error) {
        controller.error(error);
        settle();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { settle(); }
    },
  });
}

/**
 * Adapts the exact Provider source into the existing SVC09 process. The bridge
 * never contacts the Provider: each request carries a current source envelope
 * over the host-bearer protected loopback access, and the managed process owns
 * target pinning plus final-hop authorization injection.
 */
export function createProviderConnectionCpxBridge(input: Readonly<{
  custody: ManagedProviderExplicitStartCustody;
}>): ProviderConnectionCpxBridge {
  return Object.freeze({
    async open(openInput) {
      if (
        openInput.application.protocol !== openInput.endpoint.protocol
        || !safePublicHeaders(openInput.endpoint.publicHeaders)
      ) return null;
      const acquired = await acquireBrokerSourceOperation({
        ...(openInput.retirementGroup ? { retirementGroup: openInput.retirementGroup } : {}),
        custody: input.custody,
        identity: openInput.application.implementationIdentity,
        contributionKey: `${openInput.application.implementationIdentity.pluginId}/${openInput.application.implementationIdentity.localId}`,
        endpointTemplateId: openInput.application.endpointTemplateId,
        operationClaim: { kind: 'providerBroker', operation: openInput.operation },
        purposeBindings: { v: 1, bindings: [] },
        isSourceCurrent: async (signal) => await openInput.isCurrent(signal),
        callerSignal: openInput.signal,
      });
      if (!acquired || 'unavailable' in acquired) return null;
      const { projection, retire, isAuthorizationCurrent } = acquired;
      const send = async (
        requestInput: ManagedServiceRequest,
        lease: NonNullable<Awaited<ReturnType<typeof openInput.acquireRequestCredential>>>,
      ): Promise<ManagedServiceResponse> => {
        if (!requestInput.pathAndQuery.startsWith('/') || requestInput.pathAndQuery.startsWith('//')) {
          lease.close();
          throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable' });
        }
        const credentials = [lease.credential, ...(lease.credential.additionalCredentials ?? [])];
        const names = credentials.map(credential => credential.name.toLowerCase());
        if (credentials.some(credential => credential.kind !== 'httpHeader' || !credential.value || /[\u0000-\u001f\u007f]/u.test(credential.value))
          || new Set(names).size !== names.length
          || names.some(name => Object.keys(openInput.endpoint.publicHeaders).some(header => header.toLowerCase() === name))) {
          lease.close();
          throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable' });
        }
        const additionalCarrier = credentials.length === 1 ? undefined : Buffer.from(JSON.stringify(
          Object.fromEntries(credentials.slice(1).map(credential => [credential.name.toLowerCase(), credential.value])),
        ), 'utf8').toString('base64url');
        if (additionalCarrier !== undefined) {
          if (!lease.registerSensitiveValues) {
            lease.close();
            throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable' });
          }
          lease.registerSensitiveValues([additionalCarrier]);
        }
        const headers = requestHeaders(
          requestInput.headers,
          openInput.endpoint.publicHeaders,
          descriptor(openInput, lease.credential.name, names.slice(1)),
          lease.credential.value,
          additionalCarrier,
        );
        if (!headers) {
          lease.close();
          throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable' });
        }
        let response: ManagedServiceResponse;
        try {
          response = await projection.access.request({
            ...requestInput,
            // Broker admission already accepts only the canonical public
            // protocol routes (`/v1/responses`, `/v1/chat/completions`, and
            // `/v1/messages`). Managed endpoint access scopes that exact path
            // to the declared CPX endpoint. Prefixing OpenAI paths here would
            // turn the real composed request into `/v1/v1/...`; the earlier
            // helper-only test accidentally hid that by sending `/responses`.
            pathAndQuery: requestInput.pathAndQuery,
            headers,
          });
        } catch (error) {
          lease.close();
          if (error instanceof ProviderBrokerApplicationFailureError) throw error;
          return readProviderBrokerTransportFailure(error) ?? upstreamUnavailable();
        }
        if ((response.status >= 300 && response.status < 400)
          || Object.entries(response.headers).some(([name, value]) => (
            name.toLowerCase() === 'content-encoding' && value.toLowerCase() !== 'identity'
          ))) {
          await response.body?.cancel().catch(() => undefined);
          lease.close();
          return upstreamUnavailable();
        }
        // Filter while the redaction lease still owns its sensitive values.
        // A bodyless response settles the lease synchronously in
        // bindResponseBody, so doing this afterward would retain a secret in
        // an otherwise-benign response header.
        const sanitizedResponseHeaders = responseHeaders(
          response.headers,
          lease.containsSensitiveValue,
        );
        const body = bindResponseBody(
          response.body,
          requestInput.signal,
          lease.close,
          lease.createStreamingSanitizer(),
        );
        return Object.freeze({
          ...response,
          headers: sanitizedResponseHeaders,
          body,
        });
      };

      const request = async (requestInput: ManagedServiceRequest): Promise<ManagedServiceResponse> => {
        if (openInput.signal.aborted || !isAuthorizationCurrent()) {
          throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable' });
        }
        const lease = await openInput.acquireRequestCredential().catch(() => null);
        if (!lease) throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable' });
        return await send(requestInput, lease);
      };

      return Object.freeze({
        access: Object.freeze({
          endpointUrl: projection.access.endpointUrl,
          request,
        }),
        isCurrent: () => isAuthorizationCurrent() && projection.isCurrent(),
        retire,
        async cleanup() {
          // Releases this caller's join only. The operation itself ends through
          // `retire`, so a closing stream never makes a retained operation
          // permanently non-current for the streams still using it.
          await projection.cleanup();
        },
      });
    },
  });
}
