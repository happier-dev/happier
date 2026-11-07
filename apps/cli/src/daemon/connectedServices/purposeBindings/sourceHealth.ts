import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';

export { ConnectedAccountSourceReconnectRequiredError } from '@happier-dev/cli-common/connectedAccounts';

/** Wrappers recognize the closed code, never provider prose or a missing binding. */
export function isConnectedAccountSourceReconnectRequiredError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;
  return 'code' in error && error.code === code
    || 'errorCode' in error && error.errorCode === code
    || 'status' in error && error.status === 'unavailable' && 'reason' in error && error.reason === code;
}

/** Existing optional selection adapters may omit absence, but not confirmed health. */
export function preserveConnectedAccountSourceHealthFailure(error: unknown): null {
  if (isConnectedAccountSourceReconnectRequiredError(error)) throw error;
  return null;
}
