import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm';
import { TriageSourceObservationV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { azureDevopsHostingProviderAdapter } from '../detection/adapter.js';

import {
  decodeAzureProjectRow,
  decodeAzurePullRequestRow,
  decodeAzureRepositoryRow,
  decodeAzureRowPage,
} from './decode.js';
import { mapAzurePullRequestEntry } from './mapping.js';
import { projectAzurePresentObservation } from './observation.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';
import authoredPage from './fixtures/pullRequests.authored.page1.json';
import projectsPage1 from './fixtures/projects.page1.json';
import repositoriesFixture from './fixtures/repositories.json';

const VIEWER_ID = 'd6245f20-2af8-44f4-9451-8107cb2767db';
const GATEWAY_REPOSITORY_ID = '5febef5a-833d-4e14-b9c0-14cb638f91e6';

function entryOn(baseUrl: string) {
  const originResult = normalizeAzureDevOpsBaseUrl(baseUrl);
  if (!originResult.ok) throw new Error('fixture origin must normalize');
  const projectRow = decodeAzureProjectRow(projectsPage1.value[0]);
  if (projectRow === null) throw new Error('fixture project must decode');
  const repositoryPage = decodeAzureRowPage(repositoriesFixture, decodeAzureRepositoryRow);
  const repository = repositoryPage?.rows.find((row) => row.id === GATEWAY_REPOSITORY_ID);
  if (!repository) throw new Error('fixture repository must decode');
  const rows = decodeAzureRowPage(authoredPage, decodeAzurePullRequestRow);
  const row = rows?.rows.find((candidate) => candidate.repositoryId === GATEWAY_REPOSITORY_ID);
  if (!row) throw new Error('fixture pull request must decode');
  const entry = mapAzurePullRequestEntry({
    origin: originResult.origin,
    project: projectRow,
    repository,
    row,
    lane: 'authored',
    viewerId: VIEWER_ID,
  });
  if (entry === null) throw new Error('fixture entry must map');
  return entry;
}

function observationOn(baseUrl: string) {
  const observation = projectAzurePresentObservation({
    entry: entryOn(baseUrl),
    involvement: ['author'],
  });
  if (observation.kind !== 'present') throw new Error('expected a present observation');
  return observation;
}

describe('the Azure DevOps entry repository identity', () => {
  it('declares the canonical provider kind, deployment, and repository identity', () => {
    const entry = entryOn('https://dev.azure.com/AcmeOrg');
    expect(observationOn('https://dev.azure.com/AcmeOrg').repository).toEqual({
      kind: 'azure-devops',
      deployment: 'https://dev.azure.com/AcmeOrg',
      repository: entry.locator.repositoryKey,
    });
  });

  /**
   * The defect the deployment component exists to prevent: on Azure DevOps the
   * organization or collection lives in the base PATH, so two deployments
   * routinely hold one project and repository name. The identity must differ.
   */
  it('separates two organizations that hold the same project and repository name', () => {
    const acme = observationOn('https://dev.azure.com/AcmeOrg').repository;
    const other = observationOn('https://dev.azure.com/OtherOrg').repository;

    expect(acme?.deployment).not.toBe(other?.deployment);
  });

  /** A collection path is case-significant, so the origin owner's spelling survives. */
  it('preserves the collection path case while folding the host', () => {
    expect(observationOn('https://TFS.Example.com/DefaultCollection/').repository?.deployment)
      .toBe('https://tfs.example.com/DefaultCollection');
  });

  it('preserves Azure DevOps\' longest organization, project, and repository names', () => {
    const base = entryOn('https://dev.azure.com/AcmeOrg');
    const repositoryKey = `${'o'.repeat(64)}/${'p'.repeat(64)}/${'r'.repeat(64)}`;
    const observation = projectAzurePresentObservation({
      entry: { ...base, locator: { ...base.locator, repositoryKey } },
      involvement: ['author'],
    });

    expect(observation.repository?.repository).toBe(repositoryKey);
  });

  it('projects an observation the closed protocol schema admits', () => {
    expect(() => TriageSourceObservationV1Schema.parse(
      observationOn('https://dev.azure.com/AcmeOrg'),
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
 * Azure is the case that makes the deployment component load-bearing: the
 * organization lives in the base PATH and also in the repository key, so the
 * two halves must agree on BOTH or a repair runs in another organization's
 * checkout of the same project and repository name.
 */
describe('the join to a project checkout of the same repository', () => {
  function projectRegistryForge(remoteUrl: string) {
    const provider = azureDevopsHostingProviderAdapter.detectRemote({ remoteUrl, remoteName: 'origin' });
    if (provider === null) throw new Error(`expected ${remoteUrl} to be detected as Azure DevOps`);
    const identity = readScmHostingRepositoryIdentity(provider);
    if (identity === null) throw new Error('expected the detected ref to resolve an identity');
    return identity;
  }

  it('spells the identity exactly as the project registry spells the same checkout (https remote)', () => {
    expect(observationOn('https://dev.azure.com/AcmeOrg').repository).toEqual(
      projectRegistryForge('https://dev.azure.com/AcmeOrg/Payments/_git/gateway'),
    );
  });

  it('spells it the same way for the ssh remote of that checkout', () => {
    expect(observationOn('https://dev.azure.com/AcmeOrg').repository).toEqual(
      projectRegistryForge('git@ssh.dev.azure.com:v3/AcmeOrg/Payments/gateway'),
    );
  });

  /** The organization-collision case, from the project side this time. */
  it('differs from another organization holding the same project and repository name', () => {
    expect(observationOn('https://dev.azure.com/AcmeOrg').repository).not.toEqual(
      projectRegistryForge('https://dev.azure.com/OtherOrg/Payments/_git/gateway'),
    );
  });
});
