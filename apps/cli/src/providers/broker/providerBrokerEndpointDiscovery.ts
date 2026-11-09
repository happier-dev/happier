import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunch';
import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { logger } from '@/ui/logger';
import { ProviderBrokerAdmissionFailureCodeV1Schema, type ProviderBrokerAdmissionFailureCodeV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerMachineCarrierTunnel } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import type { MachineCarrierFailureDiagnostic } from '@/daemon/peer/iroh/machineCarrier';

import { readProviderBrokerEndpointUrl } from './providerBrokerPrivateProtocol';

type EndpointDiscoveryFailureCause = 'aborted' | 'timeout' | 'connection_reset' | 'connection_refused'
  | 'socket_closed' | 'http_response' | 'invalid_metadata' | 'transport_error' | 'broker_refresh_refused';

export type ProviderBrokerEndpointDiscoveryFailure = Readonly<{
  httpStatus?: number;
  discoveryCause?: EndpointDiscoveryFailureCause;
  admissionReasonCode?: ProviderBrokerAdmissionFailureCodeV1;
}> & Partial<MachineCarrierFailureDiagnostic>;

function endpointDiscoveryFailureCause(error: unknown, signal: AbortSignal, httpStatus?: number): EndpointDiscoveryFailureCause {
  if (signal.aborted) return 'aborted';
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'aborted';
    if (error.name === 'TimeoutError') return 'timeout';
  }
  if (httpStatus !== undefined) return httpStatus === 204 ? 'invalid_metadata' : 'http_response';
  // Fetch wraps socket failures in TypeError.cause. Only fixed codes become
  // diagnostics; raw names/messages/objects can contain private broker data.
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  switch (code) {
    case 'ECONNRESET': return 'connection_reset';
    case 'ECONNREFUSED': return 'connection_refused';
    case 'UND_ERR_SOCKET': return 'socket_closed';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT': return 'timeout';
    default: return 'transport_error';
  }
}

/** Account and Team supply different signed authority, but acquire the same
 * private endpoint. Keep refresh evidence here before native can erase a
 * refused handshake into an HTTP socket close. No authority enters diagnostics. */
export function createProviderBrokerEndpointDiscovery() {
  let httpStatus: number | undefined;
  let discoveryCause: EndpointDiscoveryFailureCause | undefined;
  let admissionReasonCode: ProviderBrokerAdmissionFailureCodeV1 | undefined;
  let readTransportFailure: ProviderBrokerMachineCarrierTunnel['readFailureDiagnostic'];
  let transportFailure: MachineCarrierFailureDiagnostic | undefined;
  let refreshOutcome: 'not_requested' | 'pending' | 'accepted' | 'refused' | 'failed' = 'not_requested';
  let refreshStartedAt: number | undefined;
  let refreshElapsedMs: number | undefined;
  const failureDiagnostic = (): ProviderBrokerEndpointDiscoveryFailure => ({
    ...transportFailure,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(discoveryCause === undefined ? {} : { discoveryCause }),
    ...(admissionReasonCode === undefined ? {} : { admissionReasonCode }),
  });
  const refuse = async (error: unknown, signal: AbortSignal, startedAt: number): Promise<never> => {
    if (error instanceof CredentialRequestRedirectError) throw error;
    const discoveryElapsedMs = Date.now() - startedAt;
    discoveryCause ??= endpointDiscoveryFailureCause(error, signal, httpStatus);
    // Snapshot before cleanup destroys native custody; no status work on
    // success, typed authority refusals or idle listeners. Older addons and
    // unavailable diagnostics must not replace the original failure.
    if (!admissionReasonCode && !signal.aborted && httpStatus === undefined) {
      try { transportFailure = await readTransportFailure?.(); } catch { /* Diagnostic only. */ }
    }
    try {
      logger.warnLocalFile('[ProviderBroker] Endpoint discovery refused', {
        reason: 'endpoint_discovery_failed', ...failureDiagnostic(),
        discoveryElapsedMs, refreshOutcome,
        ...(refreshStartedAt === undefined ? {} : { refreshElapsedMs: refreshElapsedMs ?? Date.now() - refreshStartedAt }),
      });
    } catch { /* Diagnostic failure must not replace the refusal. */ }
    signal.throwIfAborted();
    // Native's fixed HTTP refusal has no broker-code header. Its reader's
    // generic fallback must not overwrite the Home decision retained here.
    if (admissionReasonCode && (!(error instanceof SessionTeamCredentialLaunchUnavailableError)
      || error.code !== admissionReasonCode)) throw new SessionTeamCredentialLaunchUnavailableError(admissionReasonCode);
    if (error instanceof SessionTeamCredentialLaunchUnavailableError) throw error;
    throw new SessionTeamCredentialLaunchUnavailableError(admissionReasonCode ?? 'provider_endpoint_unavailable');
  };
  return {
    failureDiagnostic,
    async openTunnel<T extends Pick<ProviderBrokerMachineCarrierTunnel, 'readFailureDiagnostic'>>(open: () => Promise<T>, signal: AbortSignal): Promise<T> {
      const startedAt = Date.now();
      try {
        const tunnel = await open();
        readTransportFailure = tunnel.readFailureDiagnostic;
        return tunnel;
      } catch (error) {
        if (refreshOutcome === 'refused' || refreshOutcome === 'failed') return refuse(error, signal, startedAt);
        throw error;
      }
    },
    async refreshBrokerOpen<T extends Readonly<{ ok: boolean; reasonCode?: unknown }>>(open: () => Promise<T>, signal: AbortSignal): Promise<T> {
      refreshOutcome = 'pending';
      admissionReasonCode = undefined;
      refreshStartedAt = Date.now();
      refreshElapsedMs = undefined;
      try {
        const refreshed = await open();
        refreshOutcome = refreshed.ok ? 'accepted' : 'refused';
        if (!refreshed.ok) {
          discoveryCause = 'broker_refresh_refused';
          // Retain only Home's closed code before native can replace the
          // refused callback with an HTTP socket close. Never retain its body.
          const reason = ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(refreshed.reasonCode);
          if (reason.success) admissionReasonCode = reason.data;
        }
        return refreshed;
      } catch (error) {
        refreshOutcome = 'failed';
        discoveryCause = endpointDiscoveryFailureCause(error, signal);
        throw error;
      } finally {
        refreshElapsedMs = Date.now() - refreshStartedAt;
      }
    },
    async readEndpointUrl(input: Parameters<typeof readProviderBrokerEndpointUrl>[0]): Promise<string> {
      const startedAt = Date.now();
      try {
        return await readProviderBrokerEndpointUrl({ ...input,
          onRefusal: code => { admissionReasonCode = code; input.onRefusal?.(code); },
          fetchImpl: async (request, options) => {
            const response = await (input.fetchImpl ?? fetch)(request, options);
            httpStatus = response.status;
            return response;
          } });
      } catch (error) {
        return refuse(error, input.signal, startedAt);
      }
    },
  };
}
