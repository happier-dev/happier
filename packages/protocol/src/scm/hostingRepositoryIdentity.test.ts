import { describe, expect, it } from 'vitest';

import {
  readScmHostingRepositoryIdentity,
  sameScmHostingRepositoryIdentity,
} from './hostingRepositoryIdentity.js';

const GITHUB = Object.freeze({
  kind: 'github',
  baseUrl: 'https://github.com',
  nameWithOwner: 'acme/app',
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
});

describe('sameScmHostingRepositoryIdentity', () => {
  it('matches two observers of the same repository across host case, default port and trailing slash', () => {
    const left = readScmHostingRepositoryIdentity(GITHUB);
    const right = readScmHostingRepositoryIdentity({
      kind: 'github',
      baseUrl: 'https://GitHub.com:443/',
      nameWithOwner: 'Acme/App',
    });
    expect(sameScmHostingRepositoryIdentity(left, right)).toBe(true);
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
