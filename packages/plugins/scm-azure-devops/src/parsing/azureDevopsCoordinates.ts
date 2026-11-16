import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';

import { AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID, readAzureDevopsProviderBaseContext } from '../detection/adapter.js';
import { createAzureInvalidRequestError } from '../operations/errors.js';

export type AzureDevopsRepositoryCoordinates = Readonly<{
  organization: string;
  project: string;
  repository: string;
  organizationUrl: string;
  webOrigin: string;
  nameWithOwner: string;
}>;

function isSafeSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('?')
    && !value.includes('#');
}

export function readAzureDevopsOrganizationCoordinates(
  provider: ScmHostingProviderRef,
): Pick<AzureDevopsRepositoryCoordinates, 'organization' | 'organizationUrl' | 'webOrigin'> {
  if (
    provider.id !== AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID
    || provider.kind !== 'azure-devops'
  ) {
    throw createAzureInvalidRequestError('Azure DevOps provider coordinates are required');
  }

  const context = readAzureDevopsProviderBaseContext(provider.baseUrl);
  if (!context) {
    throw createAzureInvalidRequestError('Azure DevOps provider baseUrl must be a safe HTTPS organization URL');
  }
  return { organization: context.organization, organizationUrl: context.baseUrl, webOrigin: context.webOrigin };
}

export function readAzureDevopsRepositoryCoordinates(
  provider: ScmHostingProviderRef,
): AzureDevopsRepositoryCoordinates {
  const coordinates = readAzureDevopsOrganizationCoordinates(provider);
  if (!provider.nameWithOwner) throw createAzureInvalidRequestError('Azure DevOps repository coordinates are required');
  const parts = provider.nameWithOwner.split('/').map((part) => part.trim());
  if (parts.length !== 3 || !parts.every(isSafeSegment)) {
    throw createAzureInvalidRequestError('Azure DevOps repository coordinates must be organization/project/repository');
  }
  const [owner, project, repository] = parts;
  if (owner !== coordinates.organization) {
    throw createAzureInvalidRequestError('Azure DevOps repository organization must match provider baseUrl');
  }

  return {
    ...coordinates,
    project,
    repository,
    nameWithOwner: `${coordinates.organization}/${project}/${repository}`,
  };
}

export function readAzureDevopsRepositoryPublicationCoordinates(input: Readonly<{
  provider: ScmHostingProviderRef;
  owner: string;
  repositoryName: string;
}>): AzureDevopsRepositoryCoordinates {
  const coordinates = readAzureDevopsOrganizationCoordinates(input.provider);
  const parts = input.owner.trim().split('/').map((part) => part.trim());
  const currentProject = parts.length === 1 && input.provider.nameWithOwner
    ? readAzureDevopsRepositoryCoordinates(input.provider).project : undefined;
  const project = parts.length === 2 && parts[0] === coordinates.organization ? parts[1]
    : parts.length === 1 && parts[0] === currentProject ? currentProject : undefined;
  if (!project || !isSafeSegment(project) || !isSafeSegment(input.repositoryName) || input.repositoryName.includes('/')) {
    throw createAzureInvalidRequestError('Azure DevOps repository owner must be organization/project');
  }
  return { ...coordinates, project, repository: input.repositoryName,
    nameWithOwner: `${coordinates.organization}/${project}/${input.repositoryName}` };
}

export function parseAzurePullRequestNumberFromUrl(
  provider: ScmHostingProviderRef,
  url: string,
): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.port || parsed.search || parsed.hash) return null;

  let coordinates: AzureDevopsRepositoryCoordinates;
  try {
    coordinates = readAzureDevopsRepositoryCoordinates(provider);
  } catch {
    return null;
  }
  if (parsed.origin !== coordinates.webOrigin && parsed.origin !== coordinates.organizationUrl) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  const expectedCurrent = [
    coordinates.organization,
    coordinates.project,
    '_git',
    coordinates.repository,
    'pullrequest',
  ];
  const expectedLegacy = [
    coordinates.project,
    '_git',
    coordinates.repository,
    'pullrequest',
  ];
  const prefix = parsed.origin === 'https://dev.azure.com' ? expectedCurrent : expectedLegacy;
  if (segments.length !== prefix.length + 1) return null;
  if (!prefix.every((segment, index) => segments[index] === segment)) return null;
  const number = Number(segments[prefix.length]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function buildAzureRepositoryWebUrl(input: AzureDevopsRepositoryCoordinates): string {
  return `${input.organizationUrl}/${encodeURIComponent(input.project)}/_git/${encodeURIComponent(input.repository)}`;
}

export function stripAzureBranchRef(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return trimmed.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed;
}
