import { describe, expect, it } from 'vitest';

import { AZURE_DEVOPS_API_VERSIONS } from './apiVersions.js';
import { buildAzureCollisionScope, encodeBase64Url } from './identity.js';
import { buildAzureRepositoryKey, normalizeAzureDevOpsBaseUrl } from './origin.js';
import { buildAzureDevOpsRequestUrl } from './requestUrls.js';
import type { AzureDevOpsOrigin, AzureDevOpsRoute } from './types.js';

function requireOrigin(raw: string): AzureDevOpsOrigin {
  const result = normalizeAzureDevOpsBaseUrl(raw);
  if (!result.ok) throw new Error(`expected a normalized origin for ${raw}`);
  return result.origin;
}

describe('normalizeAzureDevOpsBaseUrl', () => {
  it('keeps a service organization base path and normalizes only the scheme and host', () => {
    const origin = requireOrigin('HTTPS://Dev.Azure.com/AcmeOrg/');
    expect(origin.baseUrl).toBe('https://dev.azure.com/AcmeOrg');
    expect(origin.requestOrigin).toBe('https://dev.azure.com');
    expect(origin.forgeHostId).toBe('dev.azure.com');
    expect(origin.organizationOrCollection).toBe('AcmeOrg');
  });

  it('preserves an Azure DevOps Server collection path verbatim, including its case and port', () => {
    const origin = requireOrigin('https://TFS.Example.test:8080/tfs/DefaultCollection');
    expect(origin.baseUrl).toBe('https://tfs.example.test:8080/tfs/DefaultCollection');
    expect(origin.forgeHostId).toBe('tfs.example.test:8080');
    expect(origin.organizationOrCollection).toBe('DefaultCollection');
  });

  it('keeps two collection bases that differ only by path case as two distinct identities', () => {
    const upper = requireOrigin('https://tfs.example.test/tfs/ProjectCollection');
    const lower = requireOrigin('https://tfs.example.test/tfs/projectcollection');
    expect(upper.baseUrl).not.toBe(lower.baseUrl);
  });

  it('drops an explicit default port so one deployment does not key as two', () => {
    expect(requireOrigin('https://dev.azure.com:443/acme').baseUrl)
      .toBe(requireOrigin('https://dev.azure.com/acme').baseUrl);
  });

  it.each([
    ['http://dev.azure.com/acme', 'insecure_scheme'],
    ['not a url', 'invalid_url'],
    ['https://user:secret@dev.azure.com/acme', 'unsupported_url_form'],
    ['https://dev.azure.com/acme?token=abc', 'unsupported_url_form'],
  ])('rejects %s', (raw, reason) => {
    const result = normalizeAzureDevOpsBaseUrl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });
});

describe('buildAzureRepositoryKey', () => {
  it('preserves organization, project and repository case', () => {
    expect(buildAzureRepositoryKey({
      organizationOrCollection: 'AcmeOrg',
      forgeHostId: 'dev.azure.com',
      projectName: 'Payments Platform',
      repositoryName: 'Gateway',
    })).toBe('AcmeOrg/Payments Platform/Gateway');
  });
});

describe('buildAzureCollisionScope', () => {
  const origin = requireOrigin('https://dev.azure.com/AcmeOrg');
  const repositoryId = '5febef5a-833d-4e14-b9c0-14cb638f91e6';

  it('scopes by the normalized base and the repository GUID, never by a name', () => {
    const scope = buildAzureCollisionScope({ origin, repositoryId });
    expect(scope).toBe(`azure-devops:${encodeBase64Url('https://dev.azure.com/AcmeOrg')}:${repositoryId}`);
    expect(scope).not.toContain('AcmeOrg/');
  });

  it('keeps the same repository identical after a project or repository rename', () => {
    const before = buildAzureCollisionScope({ origin, repositoryId });
    const after = buildAzureCollisionScope({ origin, repositoryId });
    expect(after).toBe(before);
  });

  it('rejects a non-GUID repository id rather than minting a name-keyed scope', () => {
    expect(buildAzureCollisionScope({ origin, repositoryId: 'gateway' })).toBeNull();
  });
});

describe('buildAzureDevOpsRequestUrl', () => {
  const origin = requireOrigin('https://dev.azure.com/AcmeOrg');
  const routes: readonly AzureDevOpsRoute[] = [
    { resource: 'connectionData' },
    { resource: 'projects' },
    { resource: 'repositories', project: '3f1e2c74-9a51-4a1b-8f2a-6c1d0b7e5a42' },
    {
      resource: 'pullRequests',
      project: '3f1e2c74-9a51-4a1b-8f2a-6c1d0b7e5a42',
      repositoryId: '5febef5a-833d-4e14-b9c0-14cb638f91e6',
    },
    {
      resource: 'pullRequest',
      project: '3f1e2c74-9a51-4a1b-8f2a-6c1d0b7e5a42',
      repositoryId: '5febef5a-833d-4e14-b9c0-14cb638f91e6',
      pullRequestId: 22,
    },
  ];

  it.each(routes.map((route) => [route.resource, route] as const))(
    'pins an explicit api-version on every %s URL',
    (resource, route) => {
      const url = buildAzureDevOpsRequestUrl(origin, route);
      expect(url).toContain(`api-version=${encodeURIComponent(AZURE_DEVOPS_API_VERSIONS[resource])}`);
    },
  );

  it('builds the documented pull-request lane URL under the configured base', () => {
    const url = buildAzureDevOpsRequestUrl(origin, routes[3]!, {
      'searchCriteria.creatorId': 'd6245f20-2af8-44f4-9451-8107cb2767db',
      'searchCriteria.status': 'active',
      $top: 25,
      $skip: 50,
    });
    expect(url).toBe(
      'https://dev.azure.com/AcmeOrg/3f1e2c74-9a51-4a1b-8f2a-6c1d0b7e5a42/_apis/git/repositories/'
      + '5febef5a-833d-4e14-b9c0-14cb638f91e6/pullrequests'
      + '?searchCriteria.creatorId=d6245f20-2af8-44f4-9451-8107cb2767db'
      + '&searchCriteria.status=active&$top=25&$skip=50&api-version=7.1',
    );
  });

  it('encodes a project name containing a space rather than emitting a broken path', () => {
    const url = buildAzureDevOpsRequestUrl(origin, { resource: 'repositories', project: 'Payments Platform' });
    expect(url).toContain('/Payments%20Platform/_apis/git/repositories?');
  });

  it('omits an undefined query value instead of sending the literal string', () => {
    const url = buildAzureDevOpsRequestUrl(origin, { resource: 'projects' }, {
      $top: 1,
      continuationToken: undefined,
    });
    expect(url).not.toContain('continuationToken');
    expect(url).toBe('https://dev.azure.com/AcmeOrg/_apis/projects?$top=1&api-version=7.1');
  });

  it('percent-encodes a provider continuation token so an opaque value survives the round trip', () => {
    const url = buildAzureDevOpsRequestUrl(origin, { resource: 'projects' }, {
      continuationToken: 'a b/c+d=',
    });
    expect(url).toContain('continuationToken=a%20b%2Fc%2Bd%3D');
  });
});

describe('pinned api-versions', () => {
  it('pins the resources the plan names, including the preview policy-evaluation surface', () => {
    expect(AZURE_DEVOPS_API_VERSIONS.pullRequests).toBe('7.1');
    expect(AZURE_DEVOPS_API_VERSIONS.threads).toBe('7.1');
    expect(AZURE_DEVOPS_API_VERSIONS.iterations).toBe('7.1');
    expect(AZURE_DEVOPS_API_VERSIONS.policyEvaluations).toBe('7.1-preview.1');
  });

  it('never leaves a resource unpinned', () => {
    for (const [resource, version] of Object.entries(AZURE_DEVOPS_API_VERSIONS)) {
      expect(version, resource).toMatch(/^\d+\.\d+(?:-preview(?:\.\d+)?)?$/u);
    }
  });
});
