import { describe, expect, it, vi } from 'vitest';

import { createGithubRepositoryIssueCommentsUrl } from './githubIssueCommentPolling.js';
import {
  GithubRepositoryEventsHistoryGapError,
  pollGithubRepositoryEvents,
} from './githubRepositoryEventsPolling.js';

describe('GitHub observation polling', () => {
  it('follows the provider next links and derives a deterministic oldest-first event timeline', async () => {
    const initialUrl = 'https://api.github.com/repos/acme/widgets/events?per_page=100';
    const pageTwoUrl = 'https://api.github.com/repos/acme/widgets/events?per_page=100&page=2';
    const getPage = vi.fn(async (input: Readonly<{ url: string; ifNoneMatch: string | null }>) => {
      if (input.url === initialUrl) {
        return {
          kind: 'page' as const,
          etag: 'page-one-etag',
          nextUrl: pageTwoUrl,
          pollIntervalMs: 17_000,
          events: [{
            eventId: 'event-b',
            createdAtMs: 1_700,
            observation: { id: 'event-b' },
          }, {
            eventId: 'event-c',
            createdAtMs: 1_800,
            observation: { id: 'event-c' },
          }],
        };
      }
      return {
        kind: 'page' as const,
        etag: 'page-two-etag',
        nextUrl: null,
        pollIntervalMs: null,
        events: [{
          eventId: 'event-a',
          createdAtMs: 1_700,
          observation: { id: 'event-a' },
        }, {
          eventId: 'baseline',
          createdAtMs: 900,
          observation: { id: 'baseline' },
        }],
      };
    });

    await expect(pollGithubRepositoryEvents({
      initialUrl,
      etag: 'prior-page-one-etag',
      getPage,
    })).resolves.toEqual({
      kind: 'events',
      etag: 'page-one-etag',
      pollIntervalMs: 17_000,
      events: [{
        eventId: 'baseline',
        createdAtMs: 900,
        observation: { id: 'baseline' },
      }, {
        eventId: 'event-a',
        createdAtMs: 1_700,
        observation: { id: 'event-a' },
      }, {
        eventId: 'event-b',
        createdAtMs: 1_700,
        observation: { id: 'event-b' },
      }, {
        eventId: 'event-c',
        createdAtMs: 1_800,
        observation: { id: 'event-c' },
      }],
    });
    expect(getPage).toHaveBeenNthCalledWith(1, { url: initialUrl, ifNoneMatch: 'prior-page-one-etag' });
    expect(getPage).toHaveBeenNthCalledWith(2, { url: pageTwoUrl, ifNoneMatch: null });
  });

  it('preserves an initial conditional 304 as no observation change without inventing later pages', async () => {
    const initialUrl = 'https://api.github.com/repos/acme/widgets/events?per_page=100';
    const getPage = vi.fn().mockResolvedValue({ kind: 'notModified' as const, pollIntervalMs: 17_000 });

    await expect(pollGithubRepositoryEvents({
      initialUrl,
      etag: 'current-page-one-etag',
      getPage,
    })).resolves.toEqual({ kind: 'notModified', pollIntervalMs: 17_000 });
    expect(getPage).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledWith({ url: initialUrl, ifNoneMatch: 'current-page-one-etag' });
  });

  it('rejects a distinct fourth Link page even when the first three timeline pages are empty', async () => {
    const pageUrls = [1, 2, 3, 4].map(
      (page) => `https://api.github.com/repos/acme/widgets/events?per_page=100&page=${page}`,
    );
    const getPage = vi.fn(async (input: Readonly<{ url: string; ifNoneMatch: string | null }>) => {
      const index = pageUrls.indexOf(input.url);
      if (index < 0) throw new Error(`unexpected page ${input.url}`);
      return {
        kind: 'page' as const,
        etag: `page-${index + 1}-etag`,
        nextUrl: pageUrls[index + 1] ?? null,
        pollIntervalMs: null,
        events: [],
      };
    });

    await expect(pollGithubRepositoryEvents({
      initialUrl: pageUrls[0]!,
      etag: null,
      getPage,
    })).rejects.toBeInstanceOf(GithubRepositoryEventsHistoryGapError);
    expect(getPage).toHaveBeenCalledTimes(3);
    expect(getPage).toHaveBeenNthCalledWith(3, { url: pageUrls[2], ifNoneMatch: null });
  });

  it('builds the separate repository issue-comments request in GitHub documented updated ascending order', () => {
    const url = new URL(createGithubRepositoryIssueCommentsUrl({
      apiBaseUrl: 'https://api.github.com',
      owner: 'acme',
      repository: 'widgets',
      cursor: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '999999999999999999999',
        etag: 'comments-etag',
      },
    }));

    expect(url.pathname).toBe('/repos/acme/widgets/issues/comments');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      direction: 'asc',
      per_page: '100',
      since: '2026-08-10T11:59:59Z',
      sort: 'updated',
    });
  });
});
