import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm';
import { TriageSourceObservationV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { bitbucketHostingProviderAdapter } from '../adapter.js';

import { decodeBitbucketPullRequestRow } from './entries.js';
import pageOne from './fixtures/pullRequestsPageOne.json' with { type: 'json' };
import { BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1 } from './identity.js';
import { toBitbucketPresentObservation } from './source/observations.js';
import type { BitbucketPullRequestEntry } from './entries.js';

const [openRow] = pageOne.values;

function entry(overrides: Partial<BitbucketPullRequestEntry> = {}): BitbucketPullRequestEntry {
  const decoded = decodeBitbucketPullRequestRow(openRow);
  if (!decoded.ok) throw new Error('expected the fixture row to decode');
  return { ...decoded.entry, ...overrides };
}

function observationOf(value: BitbucketPullRequestEntry) {
  return toBitbucketPresentObservation(value, {
    laneInvolvement: 'author',
    viewerAccountUuid: '{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}',
  });
}

describe('the Bitbucket entry repository identity', () => {
  it('declares the canonical provider kind, deployment, and repository identity', () => {
    expect(observationOf(entry()).repository).toEqual({
      kind: 'bitbucket',
      deployment: BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1,
      repository: 'example-workspace/deploy-tools',
    });
  });

  /** Bitbucket Cloud is this source's only deployment, and the constant says so once. */
  it('names the Bitbucket Cloud deployment', () => {
    expect(BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1).toBe('https://bitbucket.org');
  });

  it('preserves Bitbucket Cloud\'s longest workspace and repository slugs', () => {
    const base = entry();
    const repositoryKey = `${'w'.repeat(62)}/${'r'.repeat(62)}`;
    const maximal = entry({ repository: { ...base.repository, repositoryKey } });

    expect(observationOf(maximal).repository?.repository).toBe(repositoryKey.toLowerCase());
  });

  /**
   * A row whose `full_name` never resolved a two-segment key proves no
   * repository. It resolves to no checkout rather than to every checkout on
   * Bitbucket Cloud.
   */
  it('omits the repository entirely when no repository key resolved', () => {
    const base = entry();
    const withoutKey = entry({ repository: { ...base.repository, repositoryKey: null } });
    expect(observationOf(withoutKey).repository).toBeUndefined();
  });

  it('projects an observation the closed protocol schema admits', () => {
    expect(() => TriageSourceObservationV1Schema.parse(observationOf(entry()))).not.toThrow();
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
 * placement matcher, so the match rule stays in its single owner
 * (`packages/plugins/triage/src/sessions/launchPlacement.ts`).
 */
describe('the join to a project checkout of the same repository', () => {
  function projectRegistryForge(remoteUrl: string) {
    const provider = bitbucketHostingProviderAdapter.detectRemote({ remoteUrl, remoteName: 'origin' });
    if (provider === null) throw new Error(`expected ${remoteUrl} to be detected as Bitbucket`);
    const identity = readScmHostingRepositoryIdentity(provider);
    if (identity === null) throw new Error('expected the detected ref to resolve an identity');
    return identity;
  }

  it('spells the identity exactly as the project registry spells the same checkout (ssh remote)', () => {
    expect(observationOf(entry()).repository).toEqual(
      projectRegistryForge('git@bitbucket.org:example-workspace/deploy-tools.git'),
    );
  });

  it('spells it the same way for an https remote of that checkout', () => {
    expect(observationOf(entry()).repository).toEqual(
      projectRegistryForge('https://bitbucket.org/example-workspace/deploy-tools.git'),
    );
  });

  it('differs from a project checkout of another repository', () => {
    expect(observationOf(entry()).repository).not.toEqual(
      projectRegistryForge('git@bitbucket.org:example-workspace/other-tools.git'),
    );
  });
});
