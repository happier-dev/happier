import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { GithubApiClientV1, GithubApiMethodV1, GithubApiResponseV1 } from '../../observations/githubApiClient.js';
import { classifyGithubTransportFailure } from '../errors.js';
import { toTriageFailure } from '../mapping/protocol.js';

/** One REST request encoder/transport reduction for every GitHub entry kind. */
export async function sendGithubRestRequest(
  dependencies: Readonly<{ client: GithubApiClientV1 }>,
  request: Readonly<{ url: string; method: GithubApiMethodV1; body?: Readonly<Record<string, unknown>> }>,
): Promise<Readonly<{ ok: true; response: GithubApiResponseV1 }> | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>> {
  try {
    return { ok: true, response: await dependencies.client.request({
      url: request.url, method: request.method,
      ...(request.body === undefined ? {} : { headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(request.body)) }),
    }) };
  } catch (error) {
    return { ok: false, failure: toTriageFailure(classifyGithubTransportFailure(error)) };
  }
}
