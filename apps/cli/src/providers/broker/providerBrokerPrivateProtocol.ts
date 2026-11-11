import type { ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';
import { fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { normalizeProviderOriginRelativePathSyntax } from '@happier-dev/protocol/providers/safety/url';
import type { ProviderCredentialTransportV1, ProviderWireProtocol } from '@happier-dev/protocol';
import { TeamCredentialBrokerApplicationFailureCodeV1Schema, type TeamCredentialBrokerApplicationFailureCodeV1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunch';
import { logger } from '@/ui/logger';
import {
  PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER, PROVIDER_BROKER_ENDPOINT_PATH_HEADER,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
export { PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER, PROVIDER_BROKER_ENDPOINT_PATH_HEADER,
  PROVIDER_BROKER_CLOSE_REQUEST_ID_HEADER, PROVIDER_BROKER_MODEL_ID_HEADER,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';

/** The worker authenticates to the carrier, independently of upstream auth. */
export function teamCredentialBrokerLocalCredentialTransport(protocol: ProviderWireProtocol): ProviderCredentialTransportV1 {
  return { id: 'team-provider-broker-local-capability-v1', protocols: [protocol], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: MACHINE_HTTP_LOCAL_CAPABILITY_HEADER, format: 'raw' } };
}

/** Host-private members of the existing signed broker application. They are not
 * part of a Provider's `/v1` surface and never reach Provider dispatch. */
export const PROVIDER_BROKER_PRIVATE_CLOSE_PATH =
  '/v1/_happier/provider-broker/close' as const;
export const PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH =
  '/v1/_happier/provider-broker/endpoint' as const;

/** Both Account and Team applications project the admitted runtime endpoint,
 * never a protocol-derived prefix or the upstream origin/credential. */
export function projectProviderBrokerEndpointMetadata(endpointUrl: string | null): ManagedServiceResponse | null {
  if (!endpointUrl) return null;
  try {
    const endpoint = new URL(endpointUrl);
    if (endpoint.search || endpoint.hash) return null;
    const path = normalizeProviderOriginRelativePathSyntax(endpoint.pathname);
    return { ok: true, status: 204, statusText: 'No Content',
      headers: { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: path }, body: null };
  } catch { return null; }
}

/** One reader for the private broker projection, shared by both consumers. */
export async function readProviderBrokerEndpointUrl(input: Readonly<{
  localOrigin: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  onRefusal?: (code: TeamCredentialBrokerApplicationFailureCodeV1) => void;
}>): Promise<string> {
  const response = await fetchWithCredentialRedirectRefusal(new URL(PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH, input.localOrigin).href, {
    method: 'GET', headers: input.headers, signal: input.signal,
  }, input.fetchImpl, new Set([MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]));
  const declaredPath = response.headers.get(PROVIDER_BROKER_ENDPOINT_PATH_HEADER);
  if (response.status !== 204 || declaredPath === null) {
    const code = response.headers.get(PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER);
    const brokerReason = TeamCredentialBrokerApplicationFailureCodeV1Schema.safeParse(code);
    if (response.status !== 204 && brokerReason.success) input.onRefusal?.(brokerReason.data);
    logger.warnLocalFile('[ProviderBroker] Endpoint metadata refused', {
      httpStatus: response.status, hasEndpointPath: declaredPath !== null,
      brokerReasonCode: brokerReason.success ? brokerReason.data : null,
    });
    throw new SessionTeamCredentialLaunchUnavailableError(response.status === 204
      ? 'provider_endpoint_unavailable' : brokerReason.success ? brokerReason.data : 'broker_unavailable');
  }
  const path = normalizeProviderOriginRelativePathSyntax(declaredPath);
  input.signal.throwIfAborted();
  return new URL(path, input.localOrigin).href;
}
