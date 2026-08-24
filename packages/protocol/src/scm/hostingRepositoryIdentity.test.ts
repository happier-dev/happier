import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  normalizeScmHostingRepositoryIdentity,
  readScmHostingRepositoryIdentity,
  sameScmHostingRepositoryIdentity,
  type ScmHostingRepositoryIdentityV1,
} from './hostingRepositoryIdentity.js';

const GITHUB = Object.freeze({
  kind: 'github',
  baseUrl: 'https://github.com',
  nameWithOwner: 'acme/app',
});

describe('normalizeScmHostingRepositoryIdentity', () => {
  it('preserves a validated provider-kind literal while keeping untyped input broad', () => {
    const github = normalizeScmHostingRepositoryIdentity({
      kind: 'github',
      deployment: 'https://github.com',
      repository: 'Acme/App',
    });
    const broadInput: Readonly<{
      kind?: unknown;
      deployment?: unknown;
      repository?: unknown;
    }> = {
      kind: 'github',
      deployment: 'https://github.com',
      repository: 'Acme/App',
    };
    const broad = normalizeScmHostingRepositoryIdentity(broadInput);

    expectTypeOf(github).toEqualTypeOf<ScmHostingRepositoryIdentityV1<'github'> | null>();
    expectTypeOf(broad).toEqualTypeOf<ScmHostingRepositoryIdentityV1 | null>();
  });

  it('rejects a runtime provider kind outside the canonical vocabulary', () => {
    expect(normalizeScmHostingRepositoryIdentity({
      kind: 'gitea',
      deployment: 'https://forge.example',
      repository: 'acme/app',
    })).toBeNull();
  });

  it.each(['custom', 'unknown'] as const)(
    'preserves the %s provider kind and repository casing',
    (kind) => {
      expect(normalizeScmHostingRepositoryIdentity({
        kind,
        deployment: 'https://forge.example',
        repository: 'Acme/App',
      })).toEqual({
        kind,
        deployment: 'https://forge.example',
        repository: 'Acme/App',
      });
    },
  );
});

describe('readScmHostingRepositoryIdentity', () => {
  it('reads a joinable identity from a resolved hosting provider ref', () => {
    expect(readScmHostingRepositoryIdentity(GITHUB)).toEqual({
      kind: 'github',
      deployment: 'https://github.com',
      repository: 'acme/app',
    });
  });

  it('refuses a ref that never resolved a repository', () => {
    // A forge binding without `nameWithOwner` would otherwise produce a
    // deployment-only identity that matches every repository on that forge.
    expect(readScmHostingRepositoryIdentity({ ...GITHUB, nameWithOwner: undefined })).toBeNull();
    expect(readScmHostingRepositoryIdentity({ ...GITHUB, nameWithOwner: '   ' })).toBeNull();
    expect(readScmHostingRepositoryIdentity(null)).toBeNull();
  });

  it('refuses a ref whose base URL is unparseable or carries credentials', () => {
    expect(readScmHostingRepositoryIdentity({ ...GITHUB, baseUrl: 'not a url' })).toBeNull();
    expect(readScmHostingRepositoryIdentity({
      ...GITHUB,
      baseUrl: 'https://user:pass@forge.example',
    })).toBeNull();
  });

  it('keeps a self-managed deployment base path in the deployment half', () => {
    expect(readScmHostingRepositoryIdentity({
      kind: 'gitlab',
      baseUrl: 'https://forge.example/gitlab/',
      nameWithOwner: '/acme/team/app/',
    })).toEqual({
      kind: 'gitlab',
      deployment: 'https://forge.example/gitlab',
      repository: 'acme/team/app',
    });
  });

  it.each([
    ['github', 'Acme/App', 'acme/app'],
    ['gitlab', 'Acme/Team/App', 'acme/team/app'],
    ['bitbucket', 'Acme/App', 'acme/app'],
    ['azure-devops', 'AcmeOrg/Payments/Gateway', 'AcmeOrg/Payments/Gateway'],
  ] as const)('applies the %s repository addressing rule at the identity owner', (
    kind,
    repository,
    expectedRepository,
  ) => {
    expect(readScmHostingRepositoryIdentity({
      kind,
      baseUrl: kind === 'azure-devops'
        ? 'https://dev.azure.com/AcmeOrg'
        : `https://${kind}.example.com`,
      nameWithOwner: repository,
    })?.repository).toBe(expectedRepository);
  });
});

describe('sameScmHostingRepositoryIdentity', () => {
  it('compares already-normalized repository identities exactly', () => {
    const left = readScmHostingRepositoryIdentity(GITHUB);
    const sameCanonicalRepository = readScmHostingRepositoryIdentity({
      kind: 'github',
      baseUrl: 'https://GitHub.com:443/',
      nameWithOwner: 'Acme/App',
    });
    const differentRepositoryBytes = {
      kind: 'github' as const,
      deployment: 'https://github.com',
      repository: 'Acme/App',
    };

    expect(sameScmHostingRepositoryIdentity(left, sameCanonicalRepository)).toBe(true);
    expect(sameScmHostingRepositoryIdentity(left, differentRepositoryBytes)).toBe(false);
  });

  it('separates a different repository, a different deployment and a different forge kind', () => {
    const left = readScmHostingRepositoryIdentity(GITHUB);
    expect(sameScmHostingRepositoryIdentity(
      left,
      readScmHostingRepositoryIdentity({ ...GITHUB, nameWithOwner: 'acme/other' }),
    )).toBe(false);
    expect(sameScmHostingRepositoryIdentity(
      left,
      readScmHostingRepositoryIdentity({ ...GITHUB, baseUrl: 'https://github.com:8443' }),
    )).toBe(false);
    expect(sameScmHostingRepositoryIdentity(
      left,
      readScmHostingRepositoryIdentity({ ...GITHUB, kind: 'gitlab' }),
    )).toBe(false);
  });

  it('separates two self-managed deployments that share an origin', () => {
    expect(sameScmHostingRepositoryIdentity(
      readScmHostingRepositoryIdentity({
        kind: 'gitlab',
        baseUrl: 'https://forge.example/gitlab',
        nameWithOwner: 'acme/app',
      }),
      readScmHostingRepositoryIdentity({
        kind: 'gitlab',
        baseUrl: 'https://forge.example/other',
        nameWithOwner: 'acme/app',
      }),
    )).toBe(false);
  });

  it('never matches an absent identity with itself', () => {
    expect(sameScmHostingRepositoryIdentity(null, null)).toBe(false);
  });
});
