import { pluginJsonValuesEqual } from '@happier-dev/protocol';
import type { ProviderBrokerApplicationBindingV1, ProviderBrokerConsumerV1, ProviderConnectionId } from '@happier-dev/protocol';
import { ProviderBrokerAccountOpenResponseV2Schema, type ProviderBrokerAccountOpenRequestV2, type ProviderBrokerAccountOpenResponseV2, type SignedProviderBrokerRouteGrantV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { normalizeProviderOriginRelativePathSyntax } from '@happier-dev/protocol/providers/safety/url';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import type { ManagedProviderEndpointAccessProjection } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import type { ManagedServiceRequest } from '@happier-dev/plugin-sdk/managed-services';

type BrokerTunnel = Readonly<{
  localPort: number;
  localCapability: string;
  observedPath: 'direct' | 'relay' | 'unknown';
  retire(): Promise<void>;
  close(): Promise<void>;
}>;
export type AccountConnectionProviderBrokerAccess = ManagedProviderEndpointAccessProjection & Readonly<{
  readHttpBinding(): Promise<Readonly<{ endpointUrl: string; headers: Readonly<Record<string, string>> }>>;
}>;
export type OpenAccountConnectionProviderBrokerAccess = (input: Readonly<{
  connectionId: ProviderConnectionId;
  expectedConnectionSecurityFingerprint: string;
  expectedManagedRuntimeBindingFingerprint: string;
  targetMachineId: string;
  consumer: ProviderBrokerConsumerV1;
  executionRunOccurrenceId?: string;
  application: ProviderBrokerApplicationBindingV1;
  signal: AbortSignal;
}>) => Promise<AccountConnectionProviderBrokerAccess>;

export async function openAccountConnectionProviderBrokerAccess(input: Parameters<OpenAccountConnectionProviderBrokerAccess>[0] & Readonly<{
  homeId: string;
  accountId: string;
  initiatorMachineId: string;
  openBroker(request: ProviderBrokerAccountOpenRequestV2, signal: AbortSignal): Promise<ProviderBrokerAccountOpenResponseV2>;
  admitConsumer(authority: SignedProviderBrokerRouteGrantV2, signal?: AbortSignal): Promise<boolean>;
  openTunnel(request: Readonly<{
    brokerOpen: Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }>;
    refreshBrokerOpen(signal?: AbortSignal): Promise<ProviderBrokerAccountOpenResponseV2>;
    signal: AbortSignal;
  }>): Promise<BrokerTunnel>;
  fetchImpl?: typeof fetch;
}>): Promise<AccountConnectionProviderBrokerAccess> {
  const unavailable = () => createProviderErrorV1('provider_endpoint_unavailable', { connectionId: input.connectionId, machineId: input.targetMachineId });
  input.signal.throwIfAborted();
  if ((input.consumer.kind === 'execution_run') !== (input.executionRunOccurrenceId !== undefined)
    || input.executionRunOccurrenceId === '') throw unavailable();
  const request: ProviderBrokerAccountOpenRequestV2 = {
    v: 2, source: { kind: 'account_connection', connectionId: input.connectionId,
      expectedConnectionSecurityFingerprint: input.expectedConnectionSecurityFingerprint,
      expectedManagedRuntimeBindingFingerprint: input.expectedManagedRuntimeBindingFingerprint },
    initiatorMachineId: input.initiatorMachineId, targetMachineId: input.targetMachineId,
    consumer: input.consumer, application: input.application,
  };
  const opened = ProviderBrokerAccountOpenResponseV2Schema.parse(await input.openBroker(request, input.signal));
  if (!opened.ok) throw unavailable();
  const payload = opened.authority.payload;
  if (payload.homeId !== input.homeId || payload.accountId !== input.accountId
    || payload.initiator.machineId !== input.initiatorMachineId
    || payload.target.machineId !== input.targetMachineId
    || !pluginJsonValuesEqual(payload.source, request.source)
    || !pluginJsonValuesEqual(payload.consumer, input.consumer)
    || payload.executionRunOccurrenceId !== input.executionRunOccurrenceId
    || !pluginJsonValuesEqual(payload.application, input.application)) throw unavailable();
  // The existing carrier verifies the signature and transport-observed peer
  // before it publishes this host-only loopback listener. It renews the same
  // exact authority for each new stream and never replays an inference call.
  const tunnel = await input.openTunnel({ brokerOpen: opened, signal: input.signal,
    refreshBrokerOpen: async (signal = input.signal) => await input.openBroker({ ...request, refreshAuthority: opened.authority }, signal) });
  const endpointUrl = `http://127.0.0.1:${tunnel.localPort}/v1`;
  let closed = false;
  let cleanupInFlight: Promise<void> | null = null;
  const readHttpBinding = async () => {
    input.signal.throwIfAborted();
    if (closed || !await input.admitConsumer(opened.authority, input.signal)) throw unavailable();
    input.signal.throwIfAborted();
    if (closed) throw unavailable();
    return Object.freeze({ endpointUrl, headers: Object.freeze({
      authorization: `Bearer ${tunnel.localCapability}`,
      [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: tunnel.localCapability,
    }) });
  };
  return Object.freeze({
    isCurrent: () => !closed && !input.signal.aborted,
    readHttpBinding,
    access: Object.freeze({
      endpointUrl: (endpointTemplateId: string) => !closed && endpointTemplateId === input.application.endpointTemplateId ? endpointUrl : null,
      async request(request: ManagedServiceRequest) {
        const binding = await readHttpBinding();
        const path = normalizeProviderOriginRelativePathSyntax(request.pathAndQuery, { allowQuery: true });
        const target = new URL(path, `http://127.0.0.1:${tunnel.localPort}`);
        if (target.origin !== `http://127.0.0.1:${tunnel.localPort}` || target.hash !== '') throw unavailable();
        const signal = request.signal ? AbortSignal.any([input.signal, request.signal]) : input.signal;
        const response = await (input.fetchImpl ?? fetch)(target, {
          method: request.method ?? 'GET', headers: { ...request.headers, ...binding.headers },
          ...(request.body ? { body: new Uint8Array(request.body) } : {}), redirect: 'error', signal,
        });
        return Object.freeze({ ok: response.ok, status: response.status, statusText: response.statusText,
          headers: Object.freeze(Object.fromEntries(response.headers)), body: response.body });
      },
    }),
    cleanup() {
      if (cleanupInFlight) return cleanupInFlight;
      closed = true;
      cleanupInFlight ??= (async () => {
        try {
          await tunnel.retire();
        } finally {
          await tunnel.close();
        }
      })().catch((error: unknown) => {
        cleanupInFlight = null;
        throw error;
      });
      return cleanupInFlight;
    },
  });
}
