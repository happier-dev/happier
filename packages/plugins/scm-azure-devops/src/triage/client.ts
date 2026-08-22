import {
  classifyAzureDevOpsResponse,
  classifyAzureDevOpsTransportFailure,
  createAzureDevOpsFailure,
  isAzureDevOpsDeadlineAbort,
} from './failures.js';
import { buildAzureDevOpsRequestUrl } from './requestUrls.js';
import type {
  AzureDevOpsApiClient,
  AzureDevOpsClientDependencies,
  AzureDevOpsRequestResult,
} from './types.js';

/**
 * The Azure DevOps REST client.
 *
 * It issues **exactly one** transport call per request and owns no timer, sleep, retry loop,
 * or limiter. A throttled response comes back as an ordinary failure carrying Azure's own
 * retry evidence, so a user-driven action can report the wait instead of sitting through it.
 *
 * The materialized authorization lives in the closure of one invocation's client and is never
 * re-materialized per page or per request.
 */
export function createAzureDevOpsApiClient(
  deps: AzureDevOpsClientDependencies,
): AzureDevOpsApiClient {
  const { origin, authorization, transport, now } = deps;

  return {
    origin,
    async request(input): Promise<AzureDevOpsRequestResult> {
      const { route, query, method = 'GET', body, signal } = input;

      if (signal.aborted) {
        // A multi-request read whose deadline elapsed between two of its calls
        // reaches here rather than the transport, and must still say which of
        // the two aborts happened.
        const timedOut = isAzureDevOpsDeadlineAbort(signal);
        return {
          ok: false,
          failure: createAzureDevOpsFailure({
            failureClass: timedOut ? 'timedOut' : 'cancelled',
            detail: timedOut
              ? 'The Azure DevOps request was not sent because its deadline had already passed.'
              : 'The Azure DevOps request was cancelled before it was sent.',
          }),
        };
      }

      const url = buildAzureDevOpsRequestUrl(origin, route, query);
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...authorization.headers,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';

      let response;
      try {
        response = await transport({
          url,
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        });
      } catch (error) {
        return { ok: false, failure: classifyAzureDevOpsTransportFailure({ error, signal }) };
      }

      const failure = classifyAzureDevOpsResponse({
        status: response.status,
        headers: response.headers,
        bodyText: response.bodyText,
        nowMs: now(),
      });
      if (failure !== null) return { ok: false, failure };

      if (response.bodyText.trim().length === 0) {
        return { ok: true, status: response.status, headers: response.headers, body: null };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.bodyText);
      } catch {
        return {
          ok: false,
          failure: createAzureDevOpsFailure({
            failureClass: 'malformedResponse',
            status: response.status,
            detail: 'Azure DevOps returned a body that is not JSON.',
          }),
        };
      }

      return { ok: true, status: response.status, headers: response.headers, body: parsed };
    },
  };
}
