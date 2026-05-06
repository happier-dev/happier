import { describe, expect, it } from 'vitest';

import {
  ScmHostingProviderContributionSchema,
  ScmHostingProviderKindSchema,
} from './scmHostingProviders.js';

describe('SCM hosting-provider plugin contribution schema', () => {
  it('defaults URL safety metadata for static provider descriptors', () => {
    const parsed = ScmHostingProviderContributionSchema.parse({
      id: 'scm.github',
      kind: 'github',
      displayName: 'GitHub',
      baseUrl: 'https://github.com',
    });

    expect(parsed.urlSafety.allowedSchemes).toEqual(['https:']);
    expect(parsed.urlSafety.allowedBaseUrls).toEqual([]);
    expect(parsed.urlSafety.allowedOrigins).toEqual([]);
    expect(parsed.remoteHostMatchers.exactHosts).toEqual([]);
    expect(parsed.remoteHostMatchers.suffixHosts).toEqual([]);
  });

  it('accepts URL safety base URL/origin facts and descriptor-owned host matchers', () => {
    const parsed = ScmHostingProviderContributionSchema.parse({
      id: 'scm.azure-devops',
      kind: 'azure-devops',
      displayName: 'Azure DevOps',
      baseUrl: 'https://dev.azure.com',
      remoteHostMatchers: {
        exactHosts: ['dev.azure.com', 'ssh.dev.azure.com'],
        suffixHosts: ['.visualstudio.com'],
      },
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://dev.azure.com', 'https://acme.visualstudio.com'],
        allowedOrigins: ['https://dev.azure.com', 'https://acme.visualstudio.com'],
      },
      capabilities: {
        compareUrl: true,
        openUrl: true,
      },
    });

    expect(parsed.kind).toBe('azure-devops');
    expect(parsed.remoteHostMatchers.exactHosts).toEqual(['dev.azure.com', 'ssh.dev.azure.com']);
    expect(parsed.remoteHostMatchers.suffixHosts).toEqual(['.visualstudio.com']);
    expect(parsed.urlSafety).toEqual({
      allowedSchemes: ['https:'],
      allowedBaseUrls: ['https://dev.azure.com', 'https://acme.visualstudio.com'],
      allowedOrigins: ['https://dev.azure.com', 'https://acme.visualstudio.com'],
    });
    expect(parsed.capabilities).toEqual({
      compareUrl: true,
      openUrl: true,
      pullRequests: {
        list: false,
        get: false,
        create: false,
        checkout: false,
        prepareWorktree: false,
        runStacked: false,
      },
      repositoryProvisioning: {
        describeTargets: false,
        createRepository: false,
        publish: false,
      },
      reviewThreads: {
        read: false,
        write: false,
      },
    });
    expect(parsed.auth).toEqual({
      materializationKinds: [],
      cloudOnly: false,
    });
  });

  it('accepts descriptor-owned provider auth readiness metadata without secret values', () => {
    const parsed = ScmHostingProviderContributionSchema.parse({
      id: 'scm.bitbucket',
      kind: 'bitbucket',
      displayName: 'Bitbucket',
      baseUrl: 'https://bitbucket.org',
      auth: {
        materializationKinds: ['scm_hosting_basic_auth'],
        credentialPayloadKind: 'bitbucket_basic_auth',
        cloudOnly: true,
      },
    });

    expect(parsed.auth).toEqual({
      materializationKinds: ['scm_hosting_basic_auth'],
      credentialPayloadKind: 'bitbucket_basic_auth',
      cloudOnly: true,
    });
  });

  it('rejects unknown provider declarations and scheme values without a trailing colon', () => {
    expect(ScmHostingProviderKindSchema.parse('unknown')).toBe('unknown');
    expect(ScmHostingProviderContributionSchema.safeParse({
      id: 'scm.unknown',
      kind: 'unknown',
      displayName: 'Unknown',
      baseUrl: 'https://example.com',
    }).success).toBe(false);

    expect(ScmHostingProviderContributionSchema.safeParse({
      id: 'scm.custom',
      kind: 'custom',
      displayName: 'Custom',
      baseUrl: 'https://example.com',
      urlSafety: {
        allowedSchemes: ['https'],
      },
    }).success).toBe(false);
  });

  it('rejects non-HTTPS provider base URLs', () => {
    expect(ScmHostingProviderContributionSchema.safeParse({
      id: 'scm.github',
      kind: 'github',
      displayName: 'GitHub',
      baseUrl: 'http://github.com',
    }).success).toBe(false);
  });
});
