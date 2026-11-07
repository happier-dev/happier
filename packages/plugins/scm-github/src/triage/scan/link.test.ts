import { expect, it } from 'vitest';
import { validateGithubFollowUpPageUrl } from './link.js';
it('accepts native alert cursors while retaining exact family, repository and query', () => {
  const first = 'https://api.github.com/repos/octo/repo/dependabot/alerts?per_page=10&state=open%2Cdismissed%2Cfixed%2Cauto_dismissed';
  const next = `${first}&after=opaque%2Bcursor`;
  expect(validateGithubFollowUpPageUrl(next, first, '1', 'cursor')).toBe(next);
  expect(validateGithubFollowUpPageUrl(next.replace('dependabot', 'code-scanning'), first, '1', 'cursor')).toBeNull();
  expect(validateGithubFollowUpPageUrl(next.replace('per_page=10', 'per_page=100'), first, '1', 'cursor')).toBeNull();
  expect(validateGithubFollowUpPageUrl(`${next}&state=open`, first, '1', 'cursor')).toBeNull();
  expect(validateGithubFollowUpPageUrl(next, next, '1', 'cursor')).toBeNull();
  const pagedFirst = `${first}&page=1`;
  expect(validateGithubFollowUpPageUrl(`${pagedFirst}&after=second`, pagedFirst, '1', 'cursor'))
    .toBe(`${pagedFirst}&after=second`);
  expect(validateGithubFollowUpPageUrl(`${first}&before=earlier&after=later`, first, '1', 'cursor')).toBeNull();
});
