import { t } from '@/text';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

export function resolveConnectedServiceOauthErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  if (!(error instanceof Error)) return fallbackMessage;
  const code = error.message.trim();
  if (!code) return fallbackMessage;

  if (code === 'connect_oauth_state_mismatch') return t('errors.oauthStateMismatch');
  if (code === 'connect_oauth_timeout') return t('errors.connectionTimeout');
  if (code === 'connect_oauth_service_unsupported') return t('welcome.serverIncompatibleBody', { serverUrl: getActiveServerSnapshot().serverUrl });
  if (code === 'connect_oauth_project_required') return t('connectedServices.importAccounts.projectRequired');
  if (code === 'connect_oauth_account_ineligible') return t('connectedServices.importAccounts.accountIneligible');
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
  if (code.startsWith('connect_oauth_')) return fallbackMessage;
  return code;
}
