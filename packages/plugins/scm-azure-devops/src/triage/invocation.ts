import type { HttpService } from '@happier-dev/plugin-sdk/http';

import type { AzureDevOpsHttpRequest, AzureDevOpsHttpResponse } from './types.js';

/** The one HTTP transport adapter shared by Azure reads and writes. */

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

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
