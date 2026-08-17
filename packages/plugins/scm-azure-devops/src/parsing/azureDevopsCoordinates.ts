import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';

import { AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID } from '../detection/adapter.js';
import { createAzureInvalidRequestError } from '../operations/errors.js';

export type AzureDevopsRepositoryCoordinates = Readonly<{
  organization: string;
  project: string;
  repository: string;
  organizationUrl: string;
  webOrigin: string;
  nameWithOwner: string;
}>;

function readVisualStudioOrganization(host: string): string | null {
  const suffix = '.visualstudio.com';
  if (!host.endsWith(suffix) || host === suffix.slice(1)) return null;
  const organization = host.slice(0, -suffix.length);
  return organization && !organization.includes('.') ? organization : null;
}

function isSafeSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('?')
    && !value.includes('#');
}

export function readAzureDevopsRepositoryCoordinates(
  provider: ScmHostingProviderRef,
): AzureDevopsRepositoryCoordinates {
  if (
    provider.id !== AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID
    || provider.kind !== 'azure-devops'
    || !provider.nameWithOwner
  ) {
    throw createAzureInvalidRequestError('Azure DevOps provider coordinates are required');
  }

  let parsed: URL;
  try {
    parsed = new URL(provider.baseUrl);
  } catch {
    throw createAzureInvalidRequestError('Azure DevOps provider baseUrl is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.port || parsed.search || parsed.hash) {
    throw createAzureInvalidRequestError('Azure DevOps provider baseUrl must be a safe HTTPS organization URL');
  }

  const host = parsed.hostname.toLowerCase();
  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  let organization: string | null = null;
  let organizationUrl: string | null = null;
  let webOrigin: string | null = null;

  if (host === 'dev.azure.com') {
    if (pathSegments.length !== 1 || !isSafeSegment(pathSegments[0])) {
      throw createAzureInvalidRequestError('Azure DevOps provider baseUrl must include exactly one organization path');
    }
    organization = pathSegments[0];
    organizationUrl = `https://dev.azure.com/${organization}`;
    webOrigin = 'https://dev.azure.com';
  } else {
    if (pathSegments.length !== 0) {
      throw createAzureInvalidRequestError('Azure DevOps legacy organization baseUrl must not include a path');
    }
    organization = readVisualStudioOrganization(host);
    if (!organization) {
      throw createAzureInvalidRequestError('Azure DevOps provider host is unsupported');
    }
    organizationUrl = `https://${host}`;
    webOrigin = organizationUrl;
  }

  const parts = provider.nameWithOwner.split('/').map((part) => part.trim());
  if (parts.length !== 3 || !parts.every(isSafeSegment)) {
    throw createAzureInvalidRequestError('Azure DevOps repository coordinates must be organization/project/repository');
  }
  const [owner, project, repository] = parts;
  if (owner !== organization) {
    throw createAzureInvalidRequestError('Azure DevOps repository organization must match provider baseUrl');
  }

  return {
    organization,
    project,
    repository,
    organizationUrl,
    webOrigin,
    nameWithOwner: `${organization}/${project}/${repository}`,
  };
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
