import { readConnectedServiceApiErrorFields } from '@/sync/api/account/connectedServiceApiError';
import { t } from '@/text';

import { resolveConnectedServiceNetworkErrorMessage } from '../errors/connectedServiceNetworkErrorMessage';
import { ConnectedServiceOauthRejectedError } from './connectedServiceOauthErrors';

function isServerSideStatus(status: number | undefined): status is number {
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500);
}

export function resolveConnectedServiceOauthErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  if (!(error instanceof Error)) return fallbackMessage;
  const networkMessage = resolveConnectedServiceNetworkErrorMessage(error);
  if (networkMessage) return networkMessage;
  if (error instanceof ConnectedServiceOauthRejectedError) {
    return error.oauthError
      ? t('connectedServices.oauthPaste.errors.rejected', { reason: error.oauthError })
      : t('connectedServices.oauthPaste.errors.rejectedGeneric');
  }
  const code = error.message.trim();
  if (!code) return fallbackMessage;
  if (code === 'connect_service_unsupported') return t('connectedServices.detail.errors.serviceUnsupportedServer');

  if (code === 'connect_oauth_state_mismatch') return t('connectedServices.oauthPaste.errors.stateMismatch');
  if (code === 'connect_oauth_timeout') return t('errors.connectionTimeout');
  if (
    'code' in error
    && error.code === 'connected_service_credential_binding_mismatch'
  ) {
    return t('connectedServices.reconnect.targetMismatch');
  }
  if (
    code === 'connect_oauth_invalid_client'
    || code === 'connect_oauth_invalid_grant'
    || code === 'connect_oauth_missing_refresh_token'
  ) {
    return t('errors.tokenExchangeFailed');
  }
  if (code.startsWith('connect_oauth_')) {
    const status = readConnectedServiceApiErrorFields(error)?.status;
    return isServerSideStatus(status)
      ? t('connectedServices.requestErrors.serverHttp', { status: String(status) })
      : fallbackMessage;
  }
  return code;
}
