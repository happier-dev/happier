import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { isConnectedAccountSourceReconnectRequiredError } from '@/daemon/connectedServices/purposeBindings/sourceHealth';
import { ProviderBrokerApplicationFailureError } from './providerBrokerApplicationFailure';
import { ProviderBrokerApplicationPhaseError } from './providerBrokerApplicationFailureContext';

/** The broker preserves source health through async phase wrappers and HTTP. */
export function preserveBrokerSourceHealthFailure(error: unknown): null {
  const cause = error instanceof ProviderBrokerApplicationPhaseError ? error.cause : error;
  if (cause instanceof ProviderBrokerApplicationFailureError) throw cause;
  // Catalog projection failures wrap the source owner's typed error. Only its
  // closed code crosses Accounts; private source identifiers/context do not.
  const providerError = ProviderErrorV1Schema.safeParse(cause !== null && typeof cause === 'object' && 'error' in cause
    ? cause.error : cause);
  if (providerError.success) throw new ProviderBrokerApplicationFailureError({
    ok: false, reasonCode: providerError.data.code,
    ...(providerError.data.failureCause ? { failureCause: providerError.data.failureCause } : {}),
  });
  if (isConnectedAccountSourceReconnectRequiredError(cause)) throw new ProviderBrokerApplicationFailureError({
    ok: false, reasonCode: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired,
  });
  return null;
}
