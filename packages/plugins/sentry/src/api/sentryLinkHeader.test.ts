import { describe, expect, it } from 'vitest';

import issuesListPage1 from '../fixtures/issuesListPage1.json' with { type: 'json' };
import issuesListPage2 from '../fixtures/issuesListPage2.json' with { type: 'json' };
import issuesListNoLinkHeader from '../fixtures/issuesListNoLinkHeader.json' with { type: 'json' };

import { parseSentryLinkHeader } from './sentryLinkHeader.js';

describe('parseSentryLinkHeader', () => {
  it('reads the recorded rel="next" cursor and results flag from a real page response', () => {
    const parsed = parseSentryLinkHeader(issuesListPage1.headers);

    expect(parsed.present).toBe(true);
    if (!parsed.present) return;
    expect(parsed.next).toEqual({
      url: 'https://us.sentry.io/api/0/organizations/7701/issues/?&cursor=1754000000000%3A0%3A0',
      cursor: '1754000000000:0:0',
      hasResults: true,
    });
    expect(parsed.previous?.hasResults).toBe(false);
  });

  it('reports the terminal page as rel="next" with results="false" rather than an absent next', () => {
    const parsed = parseSentryLinkHeader(issuesListPage2.headers);

    expect(parsed.present).toBe(true);
    if (!parsed.present) return;
    expect(parsed.next?.hasResults).toBe(false);
    expect(parsed.next?.cursor).toBe('1753000000000:0:0');
  });

  it('distinguishes an absent Link header from a present header with no next relation', () => {
    expect(parseSentryLinkHeader(issuesListNoLinkHeader.headers)).toEqual({ present: false });
    expect(parseSentryLinkHeader({ Link: '<https://us.sentry.io/x>; rel="previous"; results="false"' }))
      .toEqual({
        present: true,
        next: null,
        previous: { url: 'https://us.sentry.io/x', cursor: null, hasResults: false },
      });
  });

  it('matches the header name case-insensitively', () => {
    const parsed = parseSentryLinkHeader({
      LINK: '<https://us.sentry.io/api/0/organizations/7701/issues/?&cursor=abc%3A0%3A0>; rel="next"; results="true"',
    });

    expect(parsed.present).toBe(true);
    if (!parsed.present) return;
    expect(parsed.next?.cursor).toBe('abc:0:0');
  });

  it('recovers the cursor from the URL query when the link parameter is absent', () => {
    const parsed = parseSentryLinkHeader({
      link: '<https://us.sentry.io/api/0/organizations/7701/issues/?limit=100&cursor=1700000000000%3A25%3A0>; rel="next"; results="true"',
    });

    expect(parsed.present).toBe(true);
    if (!parsed.present) return;
    expect(parsed.next?.cursor).toBe('1700000000000:25:0');
  });

  it('treats a syntactically unusable Link value as present with no usable relation', () => {
    expect(parseSentryLinkHeader({ link: 'not-a-link-header' })).toEqual({
      present: true,
      next: null,
      previous: null,
    });
  });
});
