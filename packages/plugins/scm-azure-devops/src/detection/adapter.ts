import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/experimental/scm';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from './remoteUrl.js';

export const AZURE_DEVOPS_SCM_HOSTING_PROVIDER_LOCAL_ID = 'azure-devops';
export const AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID = `${PLUGIN_MANIFEST.id}/${AZURE_DEVOPS_SCM_HOSTING_PROVIDER_LOCAL_ID}`;
export const AZURE_DEVOPS_REMOTE_HOST_MATCHERS = Object.freeze({
  exactHosts: Object.freeze(['dev.azure.com', 'ssh.dev.azure.com']),
  suffixHosts: Object.freeze(['.visualstudio.com']),
});
export const AZURE_DEVOPS_URL_SAFETY = Object.freeze({
  allowedSchemes: Object.freeze(['https:']),
  allowedBaseUrls: Object.freeze(['https://dev.azure.com']),
  allowedOrigins: Object.freeze(['https://dev.azure.com']),
});

export type ScmHostingProviderDetectionInput = Readonly<{
  remoteName: string | null;
  remoteUrl: string;
}>;

export type ScmHostingProviderCompareUrlInput = Readonly<{
  provider: ScmHostingProviderRef;
  base: string;
  head: string;
}>;

export type AzureDevopsScmHostingProviderAdapter = Readonly<{
  detectRemote(input: ScmHostingProviderDetectionInput): ScmHostingProviderRef | null;
  buildCompareUrl(input: ScmHostingProviderCompareUrlInput): string | null;
}>;

type AzureRemoteProject = Readonly<{
  organization: string;
  project: string;
  repository: string;
  baseUrl: string;
  webOrigin: string;
}>;

type AzureProviderBaseContext = Readonly<{
  organization: string;
  baseUrl: string;
}>;

function readVisualStudioOrganization(host: string): string | null {
  const suffix = '.visualstudio.com';
  if (!host.endsWith(suffix) || host === suffix.slice(1)) return null;
  const organization = host.slice(0, -suffix.length);
  return organization && !organization.includes('.') ? organization : null;
}

function readCurrentHttpsProject(host: string, segments: readonly string[]): AzureRemoteProject | null {
  if (host !== 'dev.azure.com' || segments.length !== 4 || segments[2] !== '_git') return null;
  const [organization, project, , repository] = segments;
  if (!organization || !project || !repository) return null;
  return {
    organization,
    project,
    repository,
    baseUrl: `https://dev.azure.com/${organization}`,
    webOrigin: 'https://dev.azure.com',
  };
}

function readCurrentSshProject(host: string, segments: readonly string[]): AzureRemoteProject | null {
  if (host !== 'ssh.dev.azure.com' || segments.length !== 4 || segments[0] !== 'v3') return null;
  const [, organization, project, repository] = segments;
  if (!organization || !project || !repository) return null;
  return {
    organization,
    project,
    repository,
    baseUrl: `https://dev.azure.com/${organization}`,
    webOrigin: 'https://dev.azure.com',
  };
}

function readLegacyHttpsProject(host: string, segments: readonly string[]): AzureRemoteProject | null {
  const organization = readVisualStudioOrganization(host);
  if (!organization || segments.length !== 3 || segments[1] !== '_git') return null;
  const [project, , repository] = segments;
  if (!project || !repository) return null;
  const baseUrl = `https://${host}`;
  return {
    organization,
    project,
    repository,
    baseUrl,
    webOrigin: baseUrl,
  };
}

function readLegacySshProject(host: string, segments: readonly string[]): AzureRemoteProject | null {
  const hostOrganization = readVisualStudioOrganization(host);
  if (!hostOrganization || segments.length !== 4 || segments[0] !== 'v3') return null;
  const [, organization, project, repository] = segments;
  if (!organization || organization !== hostOrganization || !project || !repository) return null;
  const baseUrl = `https://${host}`;
  return {
    organization,
    project,
    repository,
    baseUrl,
    webOrigin: baseUrl,
  };
}

function readAzureRemoteProject(scheme: 'https:' | 'ssh:' | 'scp:', host: string, path: string): AzureRemoteProject | null {
  const segments = path.split('/').filter(Boolean);
  if (scheme === 'https:') {
    return readCurrentHttpsProject(host, segments) ?? readLegacyHttpsProject(host, segments);
  }
  if (scheme === 'ssh:' || scheme === 'scp:') {
    return readCurrentSshProject(host, segments) ?? readLegacySshProject(host, segments);
  }
  return null;
}

function buildNameWithOwner(project: AzureRemoteProject): string {
  return `${project.organization}/${project.project}/${project.repository}`;
}

function buildRepositoryWebUrl(project: AzureRemoteProject): string {
  return `${stripTrailingSlash(project.baseUrl)}/${encodeURIComponent(project.project)}/_git/${encodeURIComponent(project.repository)}`;
}

function isSafeNameWithOwnerSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('?')
    && !value.includes('#');
}

function readProviderBaseContext(baseUrl: string): AzureProviderBaseContext | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.port || parsed.search || parsed.hash) return null;

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (host === 'dev.azure.com') {
    if (segments.length !== 1) return null;
    return {
      organization: segments[0],
      baseUrl: `https://dev.azure.com/${segments[0]}`,
    };
  }

  const organization = readVisualStudioOrganization(host);
  if (!organization || segments.length !== 0) return null;
  return {
    organization,
    baseUrl: `https://${host}`,
  };
}

export const azureDevopsHostingProviderAdapter: AzureDevopsScmHostingProviderAdapter = Object.freeze({
  detectRemote(input) {
    const parsed = parseScmRemoteUrl(input.remoteUrl);
    if (!parsed) return null;
    const project = readAzureRemoteProject(parsed.scheme, parsed.host, parsed.path);
    if (!project) return null;
    return {
      id: AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID,
      kind: 'azure-devops',
      displayName: 'Azure DevOps',
      baseUrl: project.baseUrl,
      nameWithOwner: buildNameWithOwner(project),
      repositoryWebUrl: buildRepositoryWebUrl(project),
      remoteName: input.remoteName ?? undefined,
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: [project.baseUrl],
        allowedOrigins: [project.webOrigin],
      },
    };
  },
  buildCompareUrl(input) {
    const { provider } = input;
    if (
      provider.id !== AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID
      || provider.kind !== 'azure-devops'
      || !provider.nameWithOwner
    ) {
      return null;
    }
    const context = readProviderBaseContext(provider.baseUrl);
    if (!context) return null;
    const parts = provider.nameWithOwner.split('/');
    if (parts.length !== 3) return null;
    const [organization, project, repository] = parts;
    if (organization !== context.organization) return null;
    if (!parts.every(isSafeNameWithOwnerSegment)) return null;
    const baseUrl = stripTrailingSlash(context.baseUrl);
    return `${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/branchCompare?baseVersion=GB${encodeCompareRef(input.base)}&targetVersion=GB${encodeCompareRef(input.head)}`;
  },
});
