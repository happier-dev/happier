import { describe, expect, it } from 'vitest';

import { validateGithubFollowUpPageUrl } from '../scan/link.js';

import {
  GITHUB_CHANGED_FILES_CEILING_V1,
  GITHUB_CHANGED_FILES_PAGE_SIZE_V1,
  GITHUB_MAX_DETAIL_PAGE_SIZE_V1,
  buildGithubChangedFilesUrl,
  buildGithubIssueCommentsUrl,
  buildGithubPullRequestUrl,
  buildGithubTimelineUrl,
  readGithubValidatedPageNumber,
} from './routes.js';

const ROUTE = Object.freeze({ owner: 'octo-org', name: 'example-app' });

describe('GitHub detail route templates', () => {
  it('addresses the timeline of both kinds through the issue path', () => {
    // A pull request's timeline is served from `issues/{number}/timeline`.
    // Reading it from `pulls/{number}` is a 404 on every entry.
    expect(buildGithubTimelineUrl({ route: ROUTE, entryNumber: '1284', perPage: 50, page: 1 }))
      .toBe('https://api.github.com/repos/octo-org/example-app/issues/1284/timeline?per_page=50&page=1');
  });

  it('addresses changed files, comments and the pull request itself', () => {
    expect(buildGithubChangedFilesUrl({ route: ROUTE, entryNumber: '1284', perPage: 100, page: 2 }))
      .toBe('https://api.github.com/repos/octo-org/example-app/pulls/1284/files?per_page=100&page=2');
    expect(buildGithubIssueCommentsUrl({ route: ROUTE, entryNumber: '7', perPage: 30, page: 1 }))
      .toBe('https://api.github.com/repos/octo-org/example-app/issues/7/comments?per_page=30&page=1');
    expect(buildGithubPullRequestUrl({ route: ROUTE, entryNumber: '1284' }))
      .toBe('https://api.github.com/repos/octo-org/example-app/pulls/1284');
  });

  it('refuses an entry number or page geometry it cannot address', () => {
    for (const entryNumber of ['0', '-3', '12a', '', '1284/../4']) {
      expect(() => buildGithubTimelineUrl({ route: ROUTE, entryNumber, perPage: 50, page: 1 }))
        .toThrow();
    }
    expect(() => buildGithubTimelineUrl({
      route: ROUTE,
      entryNumber: '1',
      perPage: GITHUB_MAX_DETAIL_PAGE_SIZE_V1 + 1,
      page: 1,
    })).toThrow();
    expect(() => buildGithubTimelineUrl({ route: ROUTE, entryNumber: '1', perPage: 50, page: 0 }))
      .toThrow();
  });

  /**
   * The rebuild claim this whole paging design rests on: a URL rebuilt from the
   * template with the advertised page is the exact URL GitHub advertised, which
   * is what lets only the page NUMBER cross the Action boundary.
   */
  it('rebuilds the page GitHub advertised, byte for byte', () => {
    const requested = buildGithubTimelineUrl({
      route: ROUTE,
      entryNumber: '1284',
      perPage: 50,
      page: 1,
    });
    const advertised = `${requested.replace('page=1', 'page=2')}`;
    expect(validateGithubFollowUpPageUrl(advertised, requested)).toBe(advertised);
    expect(readGithubValidatedPageNumber(advertised)).toBe(2);
    expect(buildGithubTimelineUrl({ route: ROUTE, entryNumber: '1284', perPage: 50, page: 2 }))
      .toBe(advertised);
  });

  it('sizes the changed-file page so the documented ceiling lands on a page boundary', () => {
    expect(GITHUB_CHANGED_FILES_CEILING_V1 % GITHUB_CHANGED_FILES_PAGE_SIZE_V1).toBe(0);
  });
});
