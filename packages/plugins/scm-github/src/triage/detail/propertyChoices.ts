import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { decodeGithubJsonResponse, type GithubApiClientV1 } from '../../observations/githubApiClient.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure, isGithubSuccessStatus } from '../errors.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from '../locator.js';
import { toTriageFailure } from '../mapping/protocol.js';
import { readValidatedGithubFollowUpPage } from '../scan/link.js';
import { GITHUB_MAX_PAGE_SIZE_V1 } from '../types.js';
import type { GithubOverviewResultV1, GithubPropertyChoicesV1 } from './contracts.js';
import { readGithubNamedMembers } from './overview.js';

function unavailable(failure: TriageSourceFailureV1) {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

/** GitHub REST 2026-03-10 lists native logins/names; only validated Link URLs advance. */
async function readDirectory(
  input: Readonly<{ route: GithubRepositoryRouteV1; repositoryId: string | null; directory: 'assignees' | 'labels' }>,
  client: GithubApiClientV1,
): Promise<GithubPropertyChoicesV1['labels']> {
  let url = `${buildGithubApiUrl(['repos', input.route.owner, input.route.name, input.directory])}?per_page=${GITHUB_MAX_PAGE_SIZE_V1}&page=1`;
  const choices: string[] = [];
  while (true) {
    try {
      const response = await client.request({ url });
      if (!isGithubSuccessStatus(response.status)) {
        return unavailable(toTriageFailure(classifyGithubResponseFailure(response, Date.now())));
      }
      const names = readGithubNamedMembers(decodeGithubJsonResponse(response), input.directory === 'assignees' ? 'login' : 'name', 'exact');
      if (names === null) return unavailable({ class: 'unsupportedContract', code: 'github_property_choices_response_invalid' });
      choices.push(...names);
      const next = readValidatedGithubFollowUpPage(response.headers, url, input.repositoryId);
      if (next.kind === 'invalid') return unavailable({ class: 'unsupportedContract', code: 'github_property_choices_pagination_invalid' });
      if (next.kind === 'ended') return Object.freeze({ kind: 'available' as const, choices: Object.freeze(choices) });
      url = next.url;
    } catch (error) {
      return unavailable(toTriageFailure(classifyGithubTransportFailure(error)));
    }
  }
}

/** Reuses the entry's admitted client: no second admission, credential read or repository fetch. */
export async function readGithubPropertyChoices(
  input: Readonly<{ route: GithubRepositoryRouteV1; repositoryId: string | null }>,
  client: GithubApiClientV1,
): Promise<GithubPropertyChoicesV1> {
  const [assignees, labels] = await Promise.all([
    readDirectory({ ...input, directory: 'assignees' }, client),
    readDirectory({ ...input, directory: 'labels' }, client),
  ]);
  return Object.freeze({
    assignees: assignees.kind === 'unavailable' ? assignees : Object.freeze({
      kind: 'available' as const,
      choices: Object.freeze(assignees.choices.map(login => Object.freeze({ login }))),
    }),
    labels,
  });
}

/** Reserve the real failure shape before Overview's existing status-row fitting. */
export function githubPropertyChoicesEnvelopeFallback(): GithubPropertyChoicesV1 {
  const failure = unavailable({ class: 'unsupportedContract', code: 'github_property_choices_response_too_large' });
  return Object.freeze({ assignees: failure, labels: failure });
}

/** The published Action envelope is the only size boundary; never publish a false empty directory. */
export function fitGithubPropertyChoices<TOverview extends Extract<GithubOverviewResultV1, { kind: 'overview' }>>(
  overview: TOverview,
  choices: GithubPropertyChoicesV1,
): TOverview & Readonly<{ propertyChoices: GithubPropertyChoicesV1 }> {
  const complete = { ...overview, propertyChoices: choices };
  if (isExternalActionResultWithinResponseEnvelopeLimitV1(complete)) return Object.freeze(complete);
  let propertyChoices = githubPropertyChoicesEnvelopeFallback();
  for (const key of ['assignees', 'labels'] as const) {
    const candidate = { ...overview, propertyChoices: { ...propertyChoices, [key]: choices[key] } };
    if (isExternalActionResultWithinResponseEnvelopeLimitV1(candidate)) propertyChoices = candidate.propertyChoices;
  }
  return Object.freeze({ ...overview, propertyChoices });
}
