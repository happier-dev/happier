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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, '')}/v1/account/profile`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'happier-cli/doctor-repair',
      },
      signal: controller.signal,
    });
    if (response.ok) return 'ok';
    if (response.status === 401 || response.status === 403) return 'expired';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}
