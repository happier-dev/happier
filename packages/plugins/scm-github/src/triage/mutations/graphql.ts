import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
} from '../../observations/githubApiClient.js';

import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubSuccessStatus,
  isGithubWriteResponseAmbiguous,
} from '../errors.js';
import { buildGithubApiUrl } from '../locator.js';
import { toTriageFailure } from '../mapping/protocol.js';

/**
 * The one GraphQL request this vertical makes, and the one place its answer is
 * classified.
 *
 * GitHub does not expose every transition over REST. Draft → ready for review is
 * the first one this source needs: `PATCH /pulls/{n}` documents `title`, `body`,
 * `state`, `base` and `maintainer_can_modify` and no draft field, so the native
 * transition is `markPullRequestReadyForReview`. Sending a REST field GitHub
 * does not document would be silently ignored — the worst outcome, because the
 * user would believe the pull request is ready. Review-thread resolution is the
 * second: a thread is a GraphQL-only entity, so BOTH the read that identifies it
 * and the mutation that changes it travel this one path — which is why the
 * function is named for the request rather than for the mutation.
 *
 * GRAPHQL ANSWERS `200 OK` FOR ITS OWN FAILURES. A transport success is not a
 * claim that the mutation ran: a rejected mutation returns `200` with a
 * populated `errors` array and `data: null`. Reading only the status here would
 * make every refusal look like success, which is exactly the class of mistake
 * the confirming read exists to catch — so both gates are applied.
 *
 * The failure vocabulary is deliberately the SAME one `errors.ts` produces for
 * REST. GitHub publishes an error `type` on each GraphQL error, and mapping it
 * onto the existing codes keeps one classification vocabulary for this source
 * rather than a second, GraphQL-shaped one a surface would have to learn.
 */

export const GITHUB_GRAPHQL_URL = buildGithubApiUrl(['graphql']);

/** A GraphQL response that carried neither `errors` nor a usable `data` object. */
const GRAPHQL_RESPONSE_INVALID_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_graphql_response_invalid',
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * GitHub's own published GraphQL error `type` vocabulary, mapped onto the exact
 * codes `classifyGithubResponseFailure` already emits for the equivalent REST
 * status. An unrecognized type keeps its own code rather than being flattened
 * into a nearby one.
 */
function classifyGithubGraphqlError(errors: readonly unknown[]): TriageSourceFailureV1 {
  const first = errors.find(isRecord);
  const type = typeof first?.type === 'string' ? first.type.trim() : '';
  switch (type) {
    case 'INSUFFICIENT_SCOPES':
      return Object.freeze({ class: 'permission', code: 'insufficient_scope' });
    case 'FORBIDDEN':
      return Object.freeze({ class: 'permission', code: 'github_forbidden' });
    case 'NOT_FOUND':
      return Object.freeze({ class: 'unknown', code: 'github_not_found' });
    case 'RATE_LIMITED':
      return Object.freeze({ class: 'rateLimit', code: 'github_rate_limited' });
    case 'UNPROCESSABLE':
      return Object.freeze({ class: 'unsupportedContract', code: 'github_unprocessable' });
    default:
      return Object.freeze({ class: 'unknown', code: 'github_graphql_error' });
  }
}

export type GithubGraphqlOutcomeV1 =
  | Readonly<{ ok: true; data: Readonly<Record<string, unknown>> }>
  | Readonly<{
    ok: false;
    failure: TriageSourceFailureV1;
    /** The request could have reached GitHub before this response was lost or malformed. */
    mayHaveChanged: boolean;
  }>;

export async function sendGithubGraphqlRequest(
  request: Readonly<{
    query: string;
    variables: Readonly<Record<string, unknown>>;
  }>,
  dependencies: Readonly<{ client: GithubApiClientV1; now: () => number }>,
): Promise<GithubGraphqlOutcomeV1> {
  let response;
  try {
    response = await dependencies.client.request({
      url: GITHUB_GRAPHQL_URL,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        query: request.query,
        variables: request.variables,
      })),
    });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubTransportFailure(error)),
      mayHaveChanged: true,
    });
  }

  if (!isGithubSuccessStatus(response.status)) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())),
      mayHaveChanged: isGithubWriteResponseAmbiguous(response),
    });
  }

  let body: unknown;
  try {
    body = decodeGithubJsonResponse(response);
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubTransportFailure(error)),
      // A 2xx with an unreadable body can be an answer lost after the mutation
      // ran, so a caller that wrote must reconcile rather than retry blindly.
      mayHaveChanged: true,
    });
  }
  if (!isRecord(body)) {
    return Object.freeze({
      ok: false as const,
      failure: GRAPHQL_RESPONSE_INVALID_FAILURE,
      mayHaveChanged: true,
    });
  }
  // `errors` decides before `data` does: a partial GraphQL response carries both,
  // and treating a populated `errors` array as success is the whole failure mode
  // this module exists to prevent.
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return Object.freeze({
      ok: false as const,
      failure: classifyGithubGraphqlError(body.errors),
      // A null data root is GitHub's definite mutation rejection. A populated
      // root can contain a partially resolved mutation field, which must be
      // reconciled by the caller that issued the write.
      mayHaveChanged: isRecord(body.data),
    });
  }
  if (!isRecord(body.data)) {
    return Object.freeze({
      ok: false as const,
      failure: GRAPHQL_RESPONSE_INVALID_FAILURE,
      mayHaveChanged: true,
    });
  }
  return Object.freeze({ ok: true as const, data: body.data });
}
