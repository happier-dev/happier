import { ConnectedServiceQuotaFetchError } from './types';

export type GoogleCodeAssistFetchRuntime = (url: string, init: RequestInit) => Promise<Response>;

/** Shared HTTP boundary only; provider leaves own endpoint, project and response policy. */
export async function requestGoogleCodeAssist(params: Readonly<{
  fetchRuntime: GoogleCodeAssistFetchRuntime;
  accessToken: string;
  userAgent?: string;
  endpoint: string;
  method: 'loadCodeAssist' | 'retrieveUserQuota' | 'retrieveUserQuotaSummary';
  body: unknown;
  signal: AbortSignal;
}>): Promise<unknown> {
  let response: Response;
  try {
    response = await params.fetchRuntime(`${params.endpoint}/v1internal:${params.method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        'content-type': 'application/json',
        ...(params.userAgent ? { 'user-agent': params.userAgent } : {}),
      },
      body: JSON.stringify(params.body),
      signal: params.signal,
    });
  } catch (error) {
    if (params.signal.aborted) throw error;
    throw new ConnectedServiceQuotaFetchError('google_code_assist_network_failed', { quotaFetchErrorCode: 'network' });
  }
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
    throw new ConnectedServiceQuotaFetchError(`google_code_assist_${params.method}_failed`, {
      status: response.status,
      quotaFetchErrorCode: response.status === 401 ? 'auth_failure' : 'provider_backoff',
      retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null,
    });
  }
  try {
    return await response.json() as unknown;
  } catch {
    throw new ConnectedServiceQuotaFetchError('google_code_assist_response_malformed', { quotaFetchErrorCode: 'malformed' });
  }
}
