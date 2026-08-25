import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm';
import { TriageSourceObservationV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { githubHostingProviderAdapter } from '../../adapter.js';

import {
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_SEARCH_PULL_REQUEST_ITEM,
} from '../__fixtures__/githubResponses.js';
import { GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1 } from '../configuration.js';
import type { GithubTriagePresentObservationV1 } from '../types.js';

import { decodeGithubSearchItem, projectGithubEntry } from './entry.js';
import { toTriageObservation } from './protocol.js';

/**
 * The source-owned half of launch placement: the entry declares the forge
 * repository it belongs to, in the same vocabulary a project's resolved SCM
 * hosting provider uses, so the two are joined by equality and nothing parses a
 * remote URL.
 */
function presentObservation(
  overrides: Partial<GithubTriagePresentObservationV1['snapshot']> = {},
): GithubTriagePresentObservationV1 {
  const view = decodeGithubSearchItem(GITHUB_SEARCH_PULL_REQUEST_ITEM);
  if (view === null) throw new Error('expected the fixture item to decode');
  const projection = projectGithubEntry(view, GITHUB_FIXTURE_REPOSITORY_ID);
  if (projection === null) throw new Error('expected the fixture entry to project');
  return {
    kind: 'present',
    localRef: projection.localRef,
    locator: projection.locator,
    snapshot: { ...projection.snapshot, ...overrides },
    viewer: { involvement: [] },
  };
}

function repositoryOf(observation: GithubTriagePresentObservationV1) {
  const projected = toTriageObservation(observation);
  return projected.kind === 'present' ? projected.repository : undefined;
}

describe('the GitHub entry repository identity', () => {
  it('declares the canonical provider kind, deployment, and repository identity', () => {
    expect(repositoryOf(presentObservation())).toEqual({
      kind: 'github',
      deployment: GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1,
      repository: 'octo-org/example-app',
    });
  });

  /**
   * The deployment is the admitted one, not a hostname invented here. GitHub
   * admits exactly `github.com` today, so the constant derives from the
   * admission and moves with it.
   */
  it('names the admitted GitHub deployment', () => {
    expect(GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1).toBe('https://github.com');
  });

  it('normalizes GitHub repository casing through the SCM identity owner', () => {
    expect(repositoryOf(presentObservation({ nameWithOwner: 'Octo-Org/Example-App' }))?.repository)
      .toBe('octo-org/example-app');
  });

  it('preserves GitHub\'s longest admitted owner and repository names', () => {
    const nameWithOwner = `${'o'.repeat(39)}/${'r'.repeat(100)}`;
    expect(repositoryOf(presentObservation({ nameWithOwner }))?.repository)
      .toBe(nameWithOwner);
  });

  /** An entry whose repository name did not fit is no identity, never a partial one. */
  it('omits the repository entirely when the repository name is unavailable', () => {
    expect(repositoryOf(presentObservation({ nameWithOwner: null }))).toBeUndefined();
  });

  /** What the producer emits must survive the closed public schema. */
  it('projects an observation the closed protocol schema admits', () => {
    expect(() => TriageSourceObservationV1Schema.parse(toTriageObservation(presentObservation())))
      .not.toThrow();
  });
});

/**
 * The join, end to end and inside one package.
 *
 * The left half is this source's `repository`. The right half is what the
 * project registry projection publishes for a checkout of the SAME repository
 * (`apps/ui/sources/sync/ops/actions/listProjects.ts#forgeOf`): this plugin's
 * own `detectRemote` answer, read through the incumbent identity owner
 * `readScmHostingRepositoryIdentity`.
 *
 * The assertion is EQUALITY of the two records, not a re-implementation of the
 * placement matcher. Equality is the stronger claim — it holds for any
 * equality-based join — and it keeps the match rule in its single owner
 * (`packages/plugins/triage/src/sessions/launchPlacement.ts`) instead of
 * restating it in a test.
 */
describe('the join to a project checkout of the same repository', () => {
  function projectRegistryForge(remoteUrl: string) {
    const provider = githubHostingProviderAdapter.detectRemote({ remoteUrl, remoteName: 'origin' });
    if (provider === null) throw new Error(`expected ${remoteUrl} to be detected as GitHub`);
    const identity = readScmHostingRepositoryIdentity(provider);
    if (identity === null) throw new Error('expected the detected ref to resolve an identity');
    return identity;
  }

  it('spells the identity exactly as the project registry spells the same checkout (ssh remote)', () => {
    expect(repositoryOf(presentObservation()))
      .toEqual(projectRegistryForge('git@github.com:octo-org/example-app.git'));
  });

  it('spells it the same way for an https remote of that checkout', () => {
    expect(repositoryOf(presentObservation()))
      .toEqual(projectRegistryForge('https://github.com/octo-org/example-app.git'));
  });

  /**
   * A different repository on the same deployment must NOT produce the entry's
   * identity — otherwise every equality join would match every checkout.
   */
  it('differs from a project checkout of another repository', () => {
    expect(repositoryOf(presentObservation()))
      .not.toEqual(projectRegistryForge('git@github.com:octo-org/other-app.git'));
  });
});
