import type { HttpService } from '@happier-dev/plugin-sdk/http';
import {
  createBoundedInvocation,
  type BoundedInvocation,
} from '@happier-dev/triage-sources/runtime';

import type { AzureDevOpsHttpRequest, AzureDevOpsHttpResponse } from './types.js';

/**
 * The two things every bounded Azure invocation installs before it reaches the provider: its own
 * deadline, and the transport seam the client speaks through.
 *
 * They live here rather than beside their first caller because a mounted detail read and a
 * pull-request write need exactly the same two, and a second copy of the redirect rule would be a
 * second answer to what happens when Azure redirects an unusable credential to a sign-in page.
 */

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * The caller's signal, additionally bounded by the source's own deadline.
 *
 * The deadline aborts with a `TimeoutError` so the failure owner can tell it apart from a caller
 * cancellation (`failures.ts`); `AbortSignal.any` carries whichever fired first through to every
 * provider boundary below. The timer is dropped as soon as the caller's own signal aborts and is
 * unreferenced, so work nobody is waiting for cannot hold the daemon open.
 *
 * It bounds the whole invocation rather than each request, because that is what the person
 * experiences: several calls behind one panel or one button must not be allowed to wait several
 * times the number here.
 */
export function boundAzureInvocation(
  callerSignal: AbortSignal,
  deadlineMs: number,
): BoundedInvocation {
  return createBoundedInvocation({ callerSignal, timeoutMs: deadlineMs });
}

/**
 * Adapt the host HTTP service to this source's one transport seam.
 *
 * `redirect: 'error'` is deliberate: Azure answers an unusable credential with a redirect to a
 * sign-in host, and a followed redirect would deliver that page's HTML as if it were an API
 * response.
 */
export function toAzureTransport(
  http: HttpService,
  signal: AbortSignal,
): (request: AzureDevOpsHttpRequest) => Promise<AzureDevOpsHttpResponse> {
  return async (request) => {
    const response = await http.request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: new TextEncoder().encode(request.body) }),
      redirect: 'error',
    }, { signal });
    return {
      status: response.status,
      headers: response.headers,
      bodyText: TEXT_DECODER.decode(response.body),
    };
  };
}
