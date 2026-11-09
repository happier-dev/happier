import type { HttpService } from '../services/io.js';
import type { ConnectedAccountDevicePollResult } from './index.public.js';

export type DeviceGrantStepInput<T> = Readonly<{
  http: Pick<HttpService, 'request'>;
  url: string;
  fields: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  pollIntervalMs: number;
  parseSuccess(body: unknown): T | Promise<T>;
  /** Interpret provider-specific refusals without moving vendor facts into the SDK. */
  parseError?(body: unknown, httpStatus: number): T | null;
}>;

/** Perform one RFC 8628 token request. The caller owns the attempt and scheduling. */
export async function requestDeviceGrantStep<T>(
  input: DeviceGrantStepInput<T>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<T | Exclude<ConnectedAccountDevicePollResult, { status: 'connected' | 'configurationRequired' }>> {
  const failure = (status: 'unavailable' | 'rejected', code: string, message: string) => ({
    status, diagnostic: { code, severity: 'error' as const, message },
  });
  options?.signal?.throwIfAborted();
  let response;
  try {
    response = await input.http.request({
      url: input.url, method: 'POST', redirect: 'error',
      headers: { ...input.headers, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new TextEncoder().encode(new URLSearchParams(input.fields).toString()),
    }, options);
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    return failure('unavailable', 'device_grant_transport_unavailable', 'The device authorization token endpoint could not be reached.');
  }
  options?.signal?.throwIfAborted();
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(response.body)); } catch {
    return failure('unavailable', 'device_grant_response_invalid', 'The device authorization token endpoint returned an invalid response.');
  }
  const error = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).error : undefined;
  switch (error) {
    case 'authorization_pending': return { status: 'pending', retryAfterMs: input.pollIntervalMs };
    // RFC 8628 §3.5 requires increasing all subsequent polling intervals by five seconds.
    case 'slow_down': return { status: 'pending', retryAfterMs: input.pollIntervalMs + 5000 };
    case 'access_denied': return failure('rejected', 'device_grant_access_denied', 'Device authorization was denied.');
    case 'expired_token': return failure('rejected', 'device_grant_expired', 'Device authorization expired; start again.');
  }
  if (error !== undefined || response.status < 200 || response.status >= 300) {
    return input.parseError?.(body, response.status)
      ?? failure('unavailable', 'device_grant_token_endpoint_unavailable', 'The device authorization token endpoint could not complete this request.');
  }
  return input.parseSuccess(body);
}
