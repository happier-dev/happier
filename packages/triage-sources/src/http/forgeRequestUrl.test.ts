import { describe, expect, it } from 'vitest';

import { admitForgeRequestUrl } from './forgeRequestUrl.js';

const GITHUB_BASE = 'https://api.github.com';
const BITBUCKET_BASE = 'https://api.bitbucket.org/2.0';
const SELF_MANAGED_BASE = 'https://git.example.com/forge';

describe('admitForgeRequestUrl', () => {
  it('returns the candidate byte-for-byte when it is under the authorized base URL', () => {
    // A provider-issued next-page URL is followed verbatim. Re-serializing it would
    // change bytes the forge signed into a keyset cursor.
    const candidate = 'https://api.github.com/search/issues?q=is%3Aopen+repo%3Ao%2Fr&page=2';
    expect(admitForgeRequestUrl(candidate, GITHUB_BASE)).toBe(candidate);
  });

  it('refuses any other origin', () => {
    expect(admitForgeRequestUrl('https://api.github.com.evil.test/x', GITHUB_BASE)).toBeNull();
    expect(admitForgeRequestUrl('https://gist.github.com/x', GITHUB_BASE)).toBeNull();
    expect(admitForgeRequestUrl('http://api.github.com/x', GITHUB_BASE)).toBeNull();
  });

  it('refuses a non-https candidate even when the base URL is not https', () => {
    // Credentials never travel in clear text, whatever a binding recorded.
    expect(admitForgeRequestUrl('http://git.example.com/x', 'http://git.example.com')).toBeNull();
  });

  it('refuses credentials in the URL and a fragment', () => {
    expect(admitForgeRequestUrl('https://user:pass@api.github.com/x', GITHUB_BASE)).toBeNull();
    expect(admitForgeRequestUrl('https://user@api.github.com/x', GITHUB_BASE)).toBeNull();
    expect(admitForgeRequestUrl('https://api.github.com/x#fragment', GITHUB_BASE)).toBeNull();
  });

  it('confines the candidate to the base URL path prefix', () => {
    expect(admitForgeRequestUrl(`${BITBUCKET_BASE}/repositories/w`, BITBUCKET_BASE))
      .toBe(`${BITBUCKET_BASE}/repositories/w`);
    expect(admitForgeRequestUrl('https://api.bitbucket.org/1.0/x', BITBUCKET_BASE)).toBeNull();
    // The prefix boundary is a path segment, so a sibling prefix cannot pass.
    expect(admitForgeRequestUrl('https://api.bitbucket.org/2.0evil/x', BITBUCKET_BASE)).toBeNull();
    // The prefix itself, with no descendant segment, is not a resource under it.
    expect(admitForgeRequestUrl(BITBUCKET_BASE, BITBUCKET_BASE)).toBeNull();
  });

  it('admits any path when the base URL has no path prefix', () => {
    expect(admitForgeRequestUrl('https://api.github.com/repos/o/r/issues/1', GITHUB_BASE))
      .toBe('https://api.github.com/repos/o/r/issues/1');
  });

  it('confines a self-managed deployment to its configured subpath', () => {
    expect(admitForgeRequestUrl(`${SELF_MANAGED_BASE}/api/v4/issues`, SELF_MANAGED_BASE))
      .toBe(`${SELF_MANAGED_BASE}/api/v4/issues`);
    expect(admitForgeRequestUrl('https://git.example.com/api/v4/issues', SELF_MANAGED_BASE))
      .toBeNull();
  });

  it('refuses a candidate that is not a usable absolute URL string', () => {
    expect(admitForgeRequestUrl('', GITHUB_BASE)).toBeNull();
    expect(admitForgeRequestUrl('/search/issues', GITHUB_BASE)).toBeNull();
    expect(admitForgeRequestUrl(undefined, GITHUB_BASE)).toBeNull();
    expect(admitForgeRequestUrl(42, GITHUB_BASE)).toBeNull();
    expect(admitForgeRequestUrl({ url: GITHUB_BASE }, GITHUB_BASE)).toBeNull();
  });

  it('refuses everything when the authorized base URL is itself unusable', () => {
    expect(admitForgeRequestUrl('https://api.github.com/x', 'not-a-url')).toBeNull();
  });
});
