import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';

import { classifyGithubResponseFailure, isGithubSuccessStatus, isGithubWriteResponseAmbiguous } from '../errors.js';
import { readGithubPullRequest } from '../get.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from '../locator.js';
import { toTriageFailure } from '../mapping/protocol.js';
import { createGithubRepositoryReader } from '../repositories.js';
import type { GithubTriageEntryLocalRefV1 } from '../types.js';
import type { GithubPullRequestStateResultV1 } from './contracts.js';
import {
  reduceGithubPullRequestMutationRead,
  sendGithubPullRequestMutation,
  type GithubMutationDependenciesV1,
} from './pullRequest.js';

/** One PATCH owner for content and base edits; callers supply only fields they chose. */
export async function editGithubPullRequest(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    fields: Readonly<{ title?: string; body?: string; base?: string }>;
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestStateResultV1> {
  const repositories = dependencies.repositories
    ?? createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });
  const read = async () => reduceGithubPullRequestMutationRead(
    await readGithubPullRequest(input.localRef, input.route, repositories, dependencies),
  );
  const matches = (current: Awaited<ReturnType<typeof read>>) => current.ok
    && (input.fields.title === undefined || current.overview?.title === input.fields.title)
    && (input.fields.body === undefined || (current.overview?.body === null ? '' : current.overview?.body) === input.fields.body)
    && (input.fields.base === undefined || current.overview?.baseBranch === input.fields.base);
  const current = await read();
  if (!current.ok) return { kind: 'failed', failure: current.failure };
  if (matches(current)) return { kind: 'applied', effect: 'alreadySatisfied', observation: current.observation };

  const confirm = async () => {
    const observed = await read();
    if (!observed.ok) return { kind: 'uncertain' as const, failure: observed.failure };
    return matches(observed)
      ? { kind: 'applied' as const, observation: observed.observation }
      : { kind: 'uncertain' as const, observation: observed.observation };
  };
  const settlement = await settleAtMostOnceProviderWrite({
    dispatch: () => sendGithubPullRequestMutation(dependencies, {
      url: buildGithubApiUrl(['repos', input.route.owner, input.route.name, 'pulls', input.localRef.entryId]),
      method: 'PATCH', body: input.fields,
    }),
    mayHaveChanged: result => !result.ok || isGithubSuccessStatus(result.response.status)
      || isGithubWriteResponseAmbiguous(result.response),
    confirm,
  });
  if (settlement.kind === 'applied') return { ...settlement, effect: 'changed' };
  if (settlement.kind === 'unchanged') return { kind: 'uncertain', observation: settlement.observation };
  if (settlement.kind === 'uncertain') return settlement;
  return { kind: 'failed', failure: settlement.result.ok
    ? toTriageFailure(classifyGithubResponseFailure(settlement.result.response, dependencies.now()))
    : settlement.result.failure };
}
