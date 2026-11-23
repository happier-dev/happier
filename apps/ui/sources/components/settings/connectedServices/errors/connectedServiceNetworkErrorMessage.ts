import { classifyConnectedServiceTransportFailure } from '@/sync/api/account/connectedServiceNetworkError';
import { t } from '@/text';

/**
 * Message for a request that never got an HTTP response, or null when the error is not one.
 * The cause (offline, VPN down, DNS, refused) is not observable, so the wording stays general.
 */
export function resolveConnectedServiceNetworkErrorMessage(error: unknown): string | null {
  const category = classifyConnectedServiceTransportFailure(error);
  if (category === 'timeout') return t('connectedServices.requestErrors.timeout');
  if (category === 'unreachable') return t('connectedServices.requestErrors.unreachable');
  return null;
}
