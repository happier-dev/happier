import { MAX_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS } from '@/api/connectedServices/serverApiTimeout';
import { CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS } from '@/daemon/connectedServices/refresh/serviceRefreshers';

/**
 * Outer transport budget for a daemon-owned runtime-auth recovery. A recovery can
 * include one bounded server lookup plus token rotation and optional provider evidence,
 * with a small allowance for local projection and transport work.
 */
export const CONNECTED_SERVICE_RUNTIME_AUTH_RECOVERY_TRANSPORT_TIMEOUT_MS =
  MAX_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS
  + (2 * CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS)
  + 30_000;
