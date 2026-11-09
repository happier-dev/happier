import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { isConnectedAccountSourceReconnectRequiredError } from '@/daemon/connectedServices/purposeBindings/sourceHealth';
import { ProviderBrokerApplicationFailureError } from './providerBrokerApplicationFailure';
import { ProviderBrokerApplicationPhaseError } from './providerBrokerApplicationFailureContext';

/** The broker preserves source health through async phase wrappers and HTTP. */
export function preserveBrokerSourceHealthFailure(error: unknown): null {
  const cause = error instanceof ProviderBrokerApplicationPhaseError ? error.cause : error;
  if (isConnectedAccountSourceReconnectRequiredError(cause)) throw new ProviderBrokerApplicationFailureError({
    ok: false, reasonCode: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired,
  });
  return null;
}
