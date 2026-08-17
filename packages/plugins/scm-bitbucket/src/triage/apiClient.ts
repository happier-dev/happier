import type { HttpService } from '@happier-dev/plugin-sdk/http';

import {
  BITBUCKET_CLOUD_API_BASE_URL,
  BITBUCKET_CLOUD_API_ORIGIN,
  readBitbucketApiUrl,
} from './apiUrl.js';
import {
  EMPTY_BITBUCKET_RATE_LIMIT_TELEMETRY,
  readBitbucketRateLimitTelemetry,
  type BitbucketRateLimitTelemetry,
} from './bitbucketRateLimit.js';
import {
  classifyBitbucketHttpFailure,
  classifyBitbucketTransportFailure,
  createBitbucketFailure,
  type BitbucketTriageFailure,
} from './failures.js';

export { BITBUCKET_CLOUD_API_BASE_URL, BITBUCKET_CLOUD_API_ORIGIN, readBitbucketApiUrl };

/**
 * Private per-invocation deadline. Bitbucket publishes no request SLA, so this is the source's own
 * bound on a request that neither answers nor fails; it is not public ABI and not a host timer.
 */
export const BITBUCKET_TRIAGE_REQUEST_TIMEOUT_MS = 20_000;

export type BitbucketAuthorizationHeaders = Readonly<Record<string, string>>;

export type BitbucketJsonResponse =
  | Readonly<{ ok: true; status: number; body: unknown; telemetry: BitbucketRateLimitTelemetry }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure; telemetry: BitbucketRateLimitTelemetry }>;

export type BitbucketTriageApiClient = Readonly<{
  requestJson(input: Readonly<{ url: string; signal?: AbortSignal }>): Promise<BitbucketJsonResponse>;
}>;

/**
 * One client instance belongs to one bounded invocation. The credential is materialized at most
 * once per instance and lives only in this closure: it never reaches a result, a page frontier, a
 * persisted row, or a log line.
 */
export function createBitbucketTriageApiClient(
  input: Readonly<{
    http: HttpService;
    authorize: (options: Readonly<{ signal?: AbortSignal }>) => Promise<BitbucketAuthorizationHeaders>;
    now: () => number;
    requestTimeoutMs?: number;
  }>,
): BitbucketTriageApiClient {
  const timeoutMs = input.requestTimeoutMs ?? BITBUCKET_TRIAGE_REQUEST_TIMEOUT_MS;
  let authorization: Promise<BitbucketAuthorizationHeaders> | null = null;

  const authorize = (signal?: AbortSignal): Promise<BitbucketAuthorizationHeaders> => {
    authorization ??= input.authorize({ ...(signal === undefined ? {} : { signal }) });
    return authorization;
  };

  return {
    async requestJson(request) {
      const url = readBitbucketApiUrl(request.url);
      if (url === null) {
        return {
          ok: false,
          failure: createBitbucketFailure('unsupportedContract', 'untrusted-request-origin'),
          telemetry: EMPTY_BITBUCKET_RATE_LIMIT_TELEMETRY,
        };
      }

      if (request.signal?.aborted === true) {
        return {
          ok: false,
          failure: createBitbucketFailure('cancelled', 'invocation-cancelled'),
          telemetry: EMPTY_BITBUCKET_RATE_LIMIT_TELEMETRY,
        };
      }

      let headers: BitbucketAuthorizationHeaders;
      try {
        headers = await authorize(request.signal);
      } catch (error) {
        return {
          ok: false,
          failure: classifyBitbucketTransportFailure(error),
          telemetry: EMPTY_BITBUCKET_RATE_LIMIT_TELEMETRY,
        };
      }

      let response: Awaited<ReturnType<HttpService['request']>>;
      try {
        response = await input.http.request(
          {
            url,
            method: 'GET',
            headers: { Accept: 'application/json', ...headers },
            // A JSON route that redirects is not a route this client follows: the raw-diff
            // redirect is a separate, explicitly origin-checked reader.
            redirect: 'error',
            timeoutMs,
          },
          { ...(request.signal === undefined ? {} : { signal: request.signal }) },
        );
      } catch (error) {
        return {
          ok: false,
          failure: classifyBitbucketTransportFailure(error),
          telemetry: EMPTY_BITBUCKET_RATE_LIMIT_TELEMETRY,
        };
      }

      const telemetry = readBitbucketRateLimitTelemetry(response.headers);
      const text = new TextDecoder().decode(response.body);

      let body: unknown;
      let parsed = true;
      try {
        body = text.length === 0 ? null : JSON.parse(text);
      } catch {
        parsed = false;
        body = null;
      }

      if (response.status >= 200 && response.status < 300) {
        if (!parsed) {
          return {
            ok: false,
            failure: createBitbucketFailure('unsupportedContract', 'malformed-json'),
            telemetry,
          };
        }
        return { ok: true, status: response.status, body, telemetry };
      }

      return {
        ok: false,
        failure: classifyBitbucketHttpFailure({
          status: response.status,
          headers: response.headers,
          body,
          nowMs: input.now(),
        }),
        telemetry,
      };
    },
  };
}
