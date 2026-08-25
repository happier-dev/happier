import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm';
import { TriageSourceObservationV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { gitlabHostingProviderAdapter } from '../adapter.js';

import mergeRequestList from './__fixtures__/mergeRequestList.json' with { type: 'json' };
import { decodeGitlabRow } from './mapping/gitlabEntry.js';
import { normalizeGitlabConfiguredBaseUrl } from './origin.js';
import { projectGitlabPresentObservation } from './sourceObservation.js';

function entryOn(baseUrl: string) {
  const origin = normalizeGitlabConfiguredBaseUrl(baseUrl);
  if (!origin) throw new Error('unusable fixture origin');
  const decoded = decodeGitlabRow({
    kindId: 'merge-request',
    origin,
    row: mergeRequestList[0],
    laneInvolvement: 'author',
  });
  if (decoded.kind !== 'mapped') throw new Error(decoded.reason);
  return decoded.entry;
}

function repositoryOn(baseUrl: string) {
  return projectGitlabPresentObservation(entryOn(baseUrl)).repository;
}

describe('the GitLab entry repository identity', () => {
  it('declares the canonical provider kind, deployment, and repository identity', () => {
    expect(repositoryOn('https://gitlab.com')).toEqual({
      kind: 'gitlab',
      deployment: 'https://gitlab.com',
      repository: entryOn('https://gitlab.com').locator.repositoryKey,
    });
  });

  /**
   * The deployment is the CONFIGURED origin this read reached, canonicalized by
   * the source's own origin owner — not a constant, so a second admitted
   * deployment cannot silently inherit gitlab.com's identity.
   */
  it('carries the deployment the read actually reached, path prefix included', () => {
    expect(repositoryOn('https://gitlab.example.com/gitlab/')?.deployment)
      .toBe('https://gitlab.example.com/gitlab');
  });

  /** A base path is case-significant, so the origin owner's spelling is preserved. */
  it('preserves the base path case the origin owner preserved', () => {
    expect(repositoryOn('https://GitLab.Example.com/Group')?.deployment)
      .toBe('https://gitlab.example.com/Group');
  });

  it('preserves GitLab\'s longest admitted routed project path', () => {
    const base = entryOn('https://gitlab.com');
    const repositoryKey = `${'g'.repeat(154)}/${'r'.repeat(100)}`;
    const observation = projectGitlabPresentObservation({
      ...base,
      locator: { ...base.locator, repositoryKey },
    });

    expect(observation.repository?.repository).toBe(repositoryKey.toLowerCase());
  });

  it('projects an observation the closed protocol schema admits', () => {
    expect(() => TriageSourceObservationV1Schema.parse(
      projectGitlabPresentObservation(entryOn('https://gitlab.com')),
    )).not.toThrow();
  });
});

/**
 * The join, end to end and inside one package.
 *
 * The left half is this source's `repository`. The right half is what the
 * project registry projection publishes for a checkout of the SAME repository
 * (`apps/ui/sources/sync/ops/actions/listProjects.ts#forgeOf`): this plugin's
 * own `detectRemote` answer read through the incumbent identity owner
 * `readScmHostingRepositoryIdentity`.
 *
 * The assertion is EQUALITY of the two records, not a re-implementation of the
 * placement matcher. Equality is the stronger claim and it leaves the match
 * rule in its single owner
 * (`packages/plugins/triage/src/sessions/launchPlacement.ts`).
 */
describe('the join to a project checkout of the same repository', () => {
  function projectRegistryForge(remoteUrl: string) {
    const provider = gitlabHostingProviderAdapter.detectRemote({ remoteUrl, remoteName: 'origin' });
    if (provider === null) throw new Error(`expected ${remoteUrl} to be detected as GitLab`);
    const identity = readScmHostingRepositoryIdentity(provider);
    if (identity === null) throw new Error('expected the detected ref to resolve an identity');
    return identity;
  }

  /** A nested group path is the ordinary GitLab case, and it must survive whole. */
  it('spells the identity exactly as the project registry spells the same checkout (ssh remote)', () => {
    expect(repositoryOn('https://gitlab.com')).toEqual(projectRegistryForge(
      'git@gitlab.com:example-group/example-subgroup/example-project.git',
    ));
  });

  it('spells it the same way for an https remote of that checkout', () => {
    expect(repositoryOn('https://gitlab.com')).toEqual(projectRegistryForge(
      'https://gitlab.com/example-group/example-subgroup/example-project.git',
    ));
  });

  /** A sibling project in the same group is a different repository. */
  it('differs from a project checkout of another repository', () => {
    expect(repositoryOn('https://gitlab.com')).not.toEqual(projectRegistryForge(
      'git@gitlab.com:example-group/example-subgroup/other-project.git',
    ));
  });
});
