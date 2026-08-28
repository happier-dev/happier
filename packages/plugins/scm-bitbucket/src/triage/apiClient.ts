import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

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
  classifyBitbucketAbortSignal,
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

/**
 * The verbs this source's Bitbucket vertical issues.
 *
 * `GET` serves every read. `POST` serves the pull-request writes Bitbucket models as commands on a
 * sub-resource — `/merge` and `/decline` — and `DELETE` is the documented spelling of reopening a
 * comment thread. The set is closed here so a verb reaches Bitbucket only when the plugin manifest
 * has already granted it: a method this client could send but the grant omits is rejected by the
 * host at dispatch, not by Bitbucket.
 */
export type BitbucketRequestMethod = 'GET' | 'POST' | 'DELETE';

export type BitbucketJsonResponse =
  | Readonly<{
    ok: true;
    status: number;
    /**
     * Present so a caller can read a documented response header the body does not carry —
     * Bitbucket's asynchronous merge answers `202` and puts the merge-status location here.
     */
    headers: Readonly<Record<string, string>>;
    body: unknown;
    telemetry: BitbucketRateLimitTelemetry;
  }>
  | Readonly<{
    ok: false;
    /**
     * The exact status Bitbucket answered, or `null` when no response was received at all.
     *
     * The classified failure is deliberately coarse — it is what a reader renders — while a
     * mutation must be able to tell Bitbucket's two documented terminal merge refusals apart from
     * each other and from an ordinary error. That distinction is the status, so the status travels.
     */
    status: number | null;
    failure: BitbucketTriageFailure;
    telemetry: BitbucketRateLimitTelemetry;
  }>;

export type BitbucketTriageApiClient = Readonly<{
  requestJson(input: Readonly<{
    url: string;
    /** Absent means `GET`; every write names its verb explicitly. */
    method?: BitbucketRequestMethod;
    /** Serialized as JSON. A request with no body sends no `Content-Type` at all. */
    body?: unknown;
    signal?: AbortSignal;
  }>): Promise<BitbucketJsonResponse>;
  /** Reads Bitbucket's one non-JSON success resource through its documented redirect. */
  requestRawDiff(input: Readonly<{
    url: string;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{ ok: true; kind: 'available'; text: string }>
    | Readonly<{ ok: true; kind: 'tooLarge' }>
    | Readonly<{ ok: false; failure: BitbucketTriageFailure }>
  >;
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
          status: null,
          failure: createBitbucketFailure('unsupportedContract', 'untrusted-request-origin'),
          telemetry: EMPTY_BITBUCKET_RATE_LIMIT_TELEMETRY,
        };
      }

      if (request.signal?.aborted === true) {
        return {
          ok: false,
          status: null,
          failure: classifyBitbucketAbortSignal(request.signal),
          telemetry: EMPTY_BITBUCKET_RATE_LIMIT_TELEMETRY,
        };
      }

      let headers: BitbucketAuthorizationHeaders;
      try {
        headers = await authorize(request.signal);
      } catch (error) {
        return {
          ok: false,
          status: null,
          failure: classifyBitbucketTransportFailure(error),
          telemetry: EMPTY_BITBUCKET_RATE_LIMIT_TELEMETRY,
        };
      }

      const encodedBody = request.body === undefined
        ? undefined
        : new TextEncoder().encode(JSON.stringify(request.body));

      let response: Awaited<ReturnType<HttpService['request']>>;
      try {
        response = await input.http.request(
          {
            url,
            method: request.method ?? 'GET',
            headers: {
              Accept: 'application/json',
              ...(encodedBody === undefined ? {} : { 'Content-Type': 'application/json' }),
              ...headers,
            },
            ...(encodedBody === undefined ? {} : { body: encodedBody }),
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
          status: null,
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
            status: response.status,
            failure: createBitbucketFailure('unsupportedContract', 'malformed-json'),
            telemetry,
          };
        }
        return {
          ok: true,
          status: response.status,
          headers: response.headers,
          body,
          telemetry,
        };
      }

      return {
        ok: false,
        status: response.status,
        failure: classifyBitbucketHttpFailure({
          status: response.status,
          headers: response.headers,
          body,
          nowMs: input.now(),
        }),
        telemetry,
      };
    },
    async requestRawDiff(request) {
      const url = readBitbucketApiUrl(request.url);
      if (url === null) {
        return {
          ok: false,
          failure: createBitbucketFailure('unsupportedContract', 'untrusted-request-origin'),
        };
      }
      if (request.signal?.aborted === true) {
        return { ok: false, failure: classifyBitbucketAbortSignal(request.signal) };
      }

      let headers: BitbucketAuthorizationHeaders;
      try {
        headers = await authorize(request.signal);
      } catch (error) {
        return { ok: false, failure: classifyBitbucketTransportFailure(error) };
      }

      const fetchRaw = async (target: string, redirect: 'manual' | 'error') => input.http.request({
        url: target,
        method: 'GET',
        headers: { Accept: 'text/plain', ...headers },
        redirect,
        timeoutMs,
      }, { ...(request.signal === undefined ? {} : { signal: request.signal }) });

      let first: Awaited<ReturnType<typeof fetchRaw>>;
      try {
        first = await fetchRaw(url, 'manual');
      } catch (error) {
        return { ok: false, failure: classifyBitbucketTransportFailure(error) };
      }
      if (first.status === 555) return { ok: true, kind: 'tooLarge' };
      if (first.status !== 302) {
        return {
          ok: false,
          failure: classifyBitbucketHttpFailure({
            status: first.status,
            headers: first.headers,
            body: null,
            nowMs: input.now(),
          }),
        };
      }
      const location = readTriageResponseHeaderV1(first.headers, 'location');
      const target = location === null ? null : readBitbucketApiUrl(location);
      if (target === null) {
        return {
          ok: false,
          failure: createBitbucketFailure('unsupportedContract', 'untrusted-diff-redirect'),
        };
      }

      let redirected: Awaited<ReturnType<typeof fetchRaw>>;
      try {
        redirected = await fetchRaw(target, 'error');
      } catch (error) {
        return { ok: false, failure: classifyBitbucketTransportFailure(error) };
      }
      if (redirected.status === 555) return { ok: true, kind: 'tooLarge' };
      if (redirected.status !== 200) {
        return {
          ok: false,
          failure: classifyBitbucketHttpFailure({
            status: redirected.status,
            headers: redirected.headers,
            body: null,
            nowMs: input.now(),
          }),
        };
      }
      return { ok: true, kind: 'available', text: new TextDecoder().decode(redirected.body) };
    },
  };
}
