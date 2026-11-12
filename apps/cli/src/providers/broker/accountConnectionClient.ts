import { readDecodedFetchResponseHeaders } from '@happier-dev/cli-common/plugins/http';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import type { ProviderBrokerApplicationBindingV1, ProviderBrokerConsumerV1, ProviderConnectionId } from '@happier-dev/protocol';
import { ProviderBrokerAccountOpenResponseV2Schema, type ProviderBrokerAdmissionFailureCodeV1, type ProviderBrokerAccountOpenRequestV2, type ProviderBrokerAccountOpenResponseV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createProviderErrorV1, ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import { normalizeProviderOriginRelativePathSyntax } from '@happier-dev/protocol/providers/safety/url';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import type { ManagedProviderEndpointAccessProjection } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import type { ManagedServiceRequest } from '@happier-dev/plugin-sdk/managed-services';
import { createProviderBrokerEndpointDiscovery, type ProviderBrokerEndpointDiscoveryFailure } from './providerBrokerEndpointDiscovery';
import { logger } from '@/ui/logger';
import { MachineCarrierError } from '@/daemon/peer/iroh/machineCarrier';
import type { ProviderBrokerMachineCarrierTunnel as BrokerTunnel } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';

type BrokerOpenFailureReason = 'broker_open_refused' | 'binding_invalid' | 'tunnel_open_failed'
  | 'admission_refused' | 'endpoint_discovery_failed' | 'consumer_binding_invalid';

type AccountConnectionProviderBrokerFailureDiagnostic = ProviderBrokerEndpointDiscoveryFailure & Readonly<{
  reason: BrokerOpenFailureReason | 'native_runtime_absent';
}>;
// Same-process diagnostic custody. The outer error preserves Provider codes;
// Home's closed reason can project into the existing runner failure cause.
// No raw exception or signed authority crosses that boundary.
const failureDiagnostics = new WeakMap<object, AccountConnectionProviderBrokerFailureDiagnostic>();

export function reportAccountConnectionProviderBrokerOpenFailure(diagnostic: AccountConnectionProviderBrokerFailureDiagnostic): void {
  try { logger.warnLocalFile('[ProviderBroker] Account connection open refused', diagnostic); }
  catch { /* Diagnostics must not replace the original refusal. */ }
}

export function withAccountConnectionProviderBrokerFailureDiagnostic<T>(
  error: T, diagnostic: AccountConnectionProviderBrokerFailureDiagnostic,
): T {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    failureDiagnostics.set(error, diagnostic);
  }
  return error;
}

export function readAccountConnectionProviderBrokerFailureDiagnostic(
  error: unknown,
): AccountConnectionProviderBrokerFailureDiagnostic | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? failureDiagnostics.get(error) : undefined;
}

export type AccountConnectionProviderBrokerAccess = ManagedProviderEndpointAccessProjection & Readonly<{
  readHttpBinding(signal?: AbortSignal): Promise<Readonly<{ endpointUrl: string; headers: Readonly<Record<string, string>> }>>;
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
  openTunnel(request: Readonly<{
    brokerOpen: Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }>;
    refreshBrokerOpen(signal?: AbortSignal): Promise<ProviderBrokerAccountOpenResponseV2>;
    signal: AbortSignal;
  }>): Promise<BrokerTunnel>;
  fetchImpl?: typeof fetch;
}>): Promise<AccountConnectionProviderBrokerAccess> {
  const unavailable = (cause?: unknown) => {
    const code = ProviderErrorCodeV1Schema.safeParse(cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined);
    return createProviderErrorV1(code.success ? code.data : 'provider_endpoint_unavailable', {
      connectionId: input.connectionId, machineId: input.targetMachineId,
    });
  };
  let failedReason: BrokerOpenFailureReason = 'consumer_binding_invalid';
  let admissionReasonCode: ProviderBrokerAdmissionFailureCodeV1 | undefined;
  const discovery = createProviderBrokerEndpointDiscovery();
  const reportFailure = (reason: BrokerOpenFailureReason) => {
    reportAccountConnectionProviderBrokerOpenFailure({ reason,
      ...(admissionReasonCode ? { admissionReasonCode } : {}),
      ...(reason === 'endpoint_discovery_failed' ? discovery.failureDiagnostic() : {}) });
  };
  try {
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
    failedReason = 'broker_open_refused';
    const opened = ProviderBrokerAccountOpenResponseV2Schema.parse(await input.openBroker(request, input.signal));
    if (!opened.ok) {
      admissionReasonCode = opened.reasonCode;
      throw unavailable();
    }
    failedReason = 'binding_invalid';
    const payload = opened.authority.payload;
    if (payload.homeId !== input.homeId || payload.accountId !== input.accountId
      || payload.initiator.machineId !== input.initiatorMachineId
      || payload.target.machineId !== input.targetMachineId
      || !pluginJsonValuesEqual(payload.source, request.source)
      || !pluginJsonValuesEqual(payload.consumer, input.consumer)
      || payload.executionRunOccurrenceId !== input.executionRunOccurrenceId
      || !pluginJsonValuesEqual(payload.application, input.application)) throw unavailable();
    let closed = false;
    // Home issued this exact open. The target admits each HTTP request before
    // source effects; publishing its local binding does not repeat admission.
    // The existing carrier verifies the signature and transport-observed peer
    // before it publishes this host-only loopback listener. It renews the same
    // exact authority for each new stream and never replays an inference call.
    failedReason = 'tunnel_open_failed';
    let tunnel: BrokerTunnel;
    try {
      tunnel = await discovery.openTunnel(() => input.openTunnel({ brokerOpen: opened, signal: input.signal,
        refreshBrokerOpen: (signal = input.signal) => discovery.refreshBrokerOpen(
          () => input.openBroker({ ...request, refreshAuthority: opened.authority }, signal), signal),
      }), input.signal);
    } catch (error) {
      if (error instanceof CredentialRequestRedirectError) throw error;
      if (discovery.failureDiagnostic().discoveryCause !== undefined) {
        failedReason = 'endpoint_discovery_failed';
        // Discovery's Team-shaped internal exception is not an Account public
        // error. Its closed Home reason remains in the shared private context.
        input.signal.throwIfAborted();
        throw unavailable(error);
      }
      // Classify the carrier's closed signature/binding failures, without
      // inspecting native messages or changing its verification decision.
      if (error instanceof MachineCarrierError && [
        'grant_invalid', 'grant_unknown_key', 'grant_bad_signature', 'grant_expired', 'grant_not_yet_valid',
        'grant_binding_mismatch', 'transport_identity_mismatch', 'broker_initiator_mismatch', 'broker_target_endpoint_changed',
      ].includes(error.code)) failedReason = 'binding_invalid';
      throw error;
    }
    const localOrigin = `http://127.0.0.1:${tunnel.localPort}`;
    let cleanupInFlight: Promise<void> | null = null;
    const headers = Object.freeze({
      [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: tunnel.localCapability,
    });
    const cleanup = () => {
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
    };
    let endpointUrl: string;
    try {
      failedReason = 'endpoint_discovery_failed';
      endpointUrl = await discovery.readEndpointUrl({ localOrigin, headers, signal: input.signal, fetchImpl: input.fetchImpl });
      input.signal.throwIfAborted();
    } catch (error) {
      // Never publish an unverified base path or leave its listener exposed.
      // Preserve the opening failure even if remote retirement also fails.
      try { await cleanup(); } finally {
        input.signal.throwIfAborted();
        if (error instanceof CredentialRequestRedirectError) throw error;
        throw unavailable(error);
      }
    }
    const readHttpBinding = async (signal?: AbortSignal) => {
      const lifetime = signal ? AbortSignal.any([input.signal, signal]) : input.signal;
      lifetime.throwIfAborted();
      if (closed) throw unavailable();
      return Object.freeze({ endpointUrl, headers });
    };
    return Object.freeze({
      isCurrent: () => !closed && !input.signal.aborted,
      readHttpBinding,
      access: Object.freeze({
        endpointUrl: (endpointTemplateId: string) => !closed && endpointTemplateId === input.application.endpointTemplateId ? endpointUrl : null,
        async request(request: ManagedServiceRequest) {
          const binding = await readHttpBinding(request.signal);
          const path = normalizeProviderOriginRelativePathSyntax(request.pathAndQuery, { allowQuery: true });
          const target = new URL(path, localOrigin);
          if (target.origin !== localOrigin || target.hash !== '') throw unavailable();
          const signal = request.signal ? AbortSignal.any([input.signal, request.signal]) : input.signal;
          const response = await fetchWithCredentialRedirectRefusal(target.href, {
            method: request.method ?? 'GET', headers: { ...request.headers, ...binding.headers },
            ...(request.body ? { body: new Uint8Array(request.body) } : {}), signal,
          }, input.fetchImpl, new Set(Object.keys(binding.headers).map(name => name.toLowerCase())));
          return Object.freeze({ ok: response.ok, status: response.status, statusText: response.statusText,
            headers: readDecodedFetchResponseHeaders(response), body: response.body });
        },
      }),
      cleanup,
    });
  } catch (error) {
    if (!input.signal.aborted || failedReason === 'endpoint_discovery_failed') {
      const diagnostic = failedReason === 'endpoint_discovery_failed' ? discovery.failureDiagnostic() : {};
      withAccountConnectionProviderBrokerFailureDiagnostic(error, {
        reason: failedReason, ...(admissionReasonCode ? { admissionReasonCode } : {}), ...diagnostic,
      });
      reportFailure(failedReason);
    }
    throw error;
  }
}
