import { describe, expect, it } from 'vitest';

import { createGitlabResponseHeaders } from './gitlabHeaders.js';
import { selectGitlabNextPageUrl } from './gitlabLink.js';

const OFFSET_LINK = [
  '<https://gitlab.com/api/v4/merge_requests?page=1&per_page=100&scope=created_by_me>; rel="first"',
  '<https://gitlab.com/api/v4/merge_requests?page=3&per_page=100&scope=created_by_me>; rel="next"',
  '<https://gitlab.com/api/v4/merge_requests?page=1&per_page=100&scope=created_by_me>; rel="prev"',
  '<https://gitlab.com/api/v4/merge_requests?page=9&per_page=100&scope=created_by_me>; rel="last"',
].join(', ');

const KEYSET_LINK =
  '<https://gitlab.com/api/v4/projects?pagination=keyset&per_page=100&order_by=id&sort=desc&id_before=42>; rel="next"';

/**
 * The RFC 8288 grammar itself is owned and exhaustively covered by
 * `@happier-dev/triage-sources`. What stays here is what GitLab's own contract
 * requires of the selected `next`.
 */
describe('selectGitlabNextPageUrl', () => {
  it('picks the next link out of a full offset-pagination header', () => {
    expect(selectGitlabNextPageUrl(
      createGitlabResponseHeaders({ Link: OFFSET_LINK }),
      'https://gitlab.com',
    )).toBe('https://gitlab.com/api/v4/merge_requests?page=3&per_page=100&scope=created_by_me');
  });

  it('accepts an unquoted rel and ignores a rel that is not the next page', () => {
    expect(selectGitlabNextPageUrl(
      createGitlabResponseHeaders({ Link: '<https://gitlab.com/api/v4/issues?page=2>; rel=next' }),
      'https://gitlab.com',
    )).toBe('https://gitlab.com/api/v4/issues?page=2');
    expect(selectGitlabNextPageUrl(
      createGitlabResponseHeaders({
        Link: '<https://gitlab.com/api/v4/issues?page=2>; rel="preload"',
      }),
      'https://gitlab.com',
    )).toBeNull();
  });

  it('returns the keyset URL byte-for-byte, without rebuilding or reordering it', () => {
    const selected = selectGitlabNextPageUrl(
      createGitlabResponseHeaders({ Link: KEYSET_LINK }),
      'https://gitlab.com',
    );
    expect(selected).toBe(
      'https://gitlab.com/api/v4/projects?pagination=keyset&per_page=100&order_by=id&sort=desc&id_before=42',
    );
  });

  it('drops a next link that leaves the exact invoked origin', () => {
    for (const hostile of [
      '<https://gitlab.com.evil.example/api/v4/merge_requests?page=2>; rel="next"',
      '<http://gitlab.com/api/v4/merge_requests?page=2>; rel="next"',
      '<https://attacker.example/api/v4/merge_requests?page=2>; rel="next"',
      '</api/v4/merge_requests?page=2>; rel="next"',
    ]) {
      expect(
        selectGitlabNextPageUrl(createGitlabResponseHeaders({ Link: hostile }), 'https://gitlab.com'),
        hostile,
      ).toBeNull();
    }
  });

  it('requires a next link under a configured path prefix to stay under that prefix', () => {
    const prefixed = 'https://forge.example/Corp/GitLab';
    expect(selectGitlabNextPageUrl(
      createGitlabResponseHeaders({
        Link: '<https://forge.example/Corp/GitLab/api/v4/issues?page=2>; rel="next"',
      }),
      prefixed,
    )).toBe('https://forge.example/Corp/GitLab/api/v4/issues?page=2');
    expect(selectGitlabNextPageUrl(
      createGitlabResponseHeaders({
        Link: '<https://forge.example/other/api/v4/issues?page=2>; rel="next"',
      }),
      prefixed,
    )).toBeNull();
  });

  it('returns null when the response carries only advisory totals and no next link', () => {
    expect(selectGitlabNextPageUrl(
      createGitlabResponseHeaders({ 'X-Total': '20000', 'X-Total-Pages': '200' }),
      'https://gitlab.com',
    )).toBeNull();
  });
});
