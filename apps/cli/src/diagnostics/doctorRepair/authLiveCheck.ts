/**
 * Live auth verification for the active server profile.
 *
 * Hits `GET /v1/account/profile` with the stored bearer token and a short
 * timeout. We interpret the outcome conservatively so offline/network failures
 * DON'T cause a false "expired" report:
 *
 *   - 2xx          → `ok`
 *   - 401 / 403    → `expired` (token rejected by server)
 *   - anything else (timeout, 5xx, DNS fail) → `unknown`
 */

import { validateStoredAuthTokenAgainstServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';

export type LiveAuthResult = 'ok' | 'expired' | 'unknown';

const DEFAULT_TIMEOUT_MS = 3_000;

export async function checkAuthLive(params: Readonly<{
  serverUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>): Promise<LiveAuthResult> {
  const url = String(params.serverUrl ?? '').trim();
  const token = String(params.token ?? '').trim();
  if (!url || !token) return 'unknown';
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = params.fetchImpl ?? fetch;

  const result = await validateStoredAuthTokenAgainstServer({
    token,
    serverUrl: url,
    timeoutMs,
    fetchImpl,
  });
  return result.state === 'valid' ? 'ok' : result.state === 'invalid' ? 'expired' : 'unknown';
}
