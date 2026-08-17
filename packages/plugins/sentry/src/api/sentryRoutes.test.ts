import { describe, expect, it } from 'vitest';

import type { SentryInvokedInstanceV1 } from '../instances/sentryCollisionScope.js';

import {
  assertRoutableSentryInstance,
  buildSentryIssueEventUrl,
  buildSentryIssueEventsUrl,
  buildSentryIssueUrl,
  buildSentryTagValuesUrl,
} from './sentryRoutes.js';

const INSTANCE: SentryInvokedInstanceV1 = Object.freeze({
  deploymentOrigin: 'https://us.sentry.io',
  organizationId: '42',
});

describe('Sentry detail routes', () => {
  it('addresses one issue through its immutable organization id', () => {
    expect(buildSentryIssueUrl({ instance: INSTANCE, entryId: '1234' }))
      .toBe('https://us.sentry.io/api/0/organizations/42/issues/1234/');
  });

  it('declares the issue-events window and page size the provider caps', () => {
    const url = new URL(buildSentryIssueEventsUrl({
      instance: INSTANCE,
      entryId: '1234',
      perPage: 100,
    }));
    expect(url.pathname).toBe('/api/0/organizations/42/issues/1234/events/');
    // `per_page` is this endpoint's parameter; the issues list uses `limit`.
    expect(url.searchParams.get('per_page')).toBe('100');
    // `full=false` keeps the raw event bodies out of a list read entirely.
    expect(url.searchParams.get('full')).toBe('false');
    expect(url.searchParams.get('statsPeriod')).toBe('90d');
  });

  it('carries an opaque provider cursor without reinterpreting it', () => {
    const url = new URL(buildSentryIssueEventsUrl({
      instance: INSTANCE,
      entryId: '1234',
      perPage: 50,
      cursor: '0:100:0',
    }));
    expect(url.searchParams.get('cursor')).toBe('0:100:0');
  });

  it('escapes a tag key into exactly one path segment', () => {
    const url = new URL(buildSentryTagValuesUrl({
      instance: INSTANCE,
      entryId: '1234',
      tagKey: 'sentry:user',
      perPage: 100,
    }));
    expect(url.pathname).toBe('/api/0/organizations/42/issues/1234/tags/sentry%3Auser/values/');
  });

  it('refuses a tag key that could leave its own path segment', () => {
    for (const tagKey of ['../../projects', 'a/b', '', 'x'.repeat(201), 'tag key']) {
      expect(() => buildSentryTagValuesUrl({
        instance: INSTANCE,
        entryId: '1234',
        tagKey,
        perPage: 100,
      })).toThrow();
    }
  });

  it('addresses the representative occurrence by the provider’s own selector word', () => {
    const url = new URL(buildSentryIssueEventUrl({
      instance: INSTANCE,
      entryId: '1234',
      selector: { kind: 'representative' },
    }));
    expect(url.pathname).toBe('/api/0/organizations/42/issues/1234/events/recommended/');
    // §8.5: this source never asks Sentry to format an event for a model.
    expect(url.search).toBe('');
  });

  it('addresses one exact occurrence by its own event id', () => {
    const url = new URL(buildSentryIssueEventUrl({
      instance: INSTANCE,
      entryId: '1234',
      selector: { kind: 'event', eventId: 'a'.repeat(32) },
    }));
    expect(url.pathname).toBe(
      `/api/0/organizations/42/issues/1234/events/${'a'.repeat(32)}/`,
    );
  });

  it('refuses an event id that is not one provider event identifier', () => {
    // The published enum lists only the aliases, so the id is validated here
    // rather than trusted: a selector that can leave its path segment would
    // address a resource the caller never named.
    for (const eventId of ['', 'latest', '../7', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), `${'a'.repeat(31)}/`]) {
      expect(() => buildSentryIssueEventUrl({
        instance: INSTANCE,
        entryId: '1234',
        selector: { kind: 'event', eventId },
      })).toThrow();
    }
  });

  it('refuses an entry id that is not the provider’s numeric issue id', () => {
    for (const entryId of ['', 'abc', '12a', '../7']) {
      expect(() => buildSentryIssueUrl({ instance: INSTANCE, entryId })).toThrow();
    }
  });

  it('refuses an instance whose origin is not already the canonical normalized one', () => {
    expect(() => assertRoutableSentryInstance({
      deploymentOrigin: 'https://us.sentry.io/',
      organizationId: '42',
    })).toThrow();
    expect(() => assertRoutableSentryInstance({
      deploymentOrigin: 'https://us.sentry.io',
      organizationId: 'acme',
    })).toThrow();
  });

  it('refuses a page size outside the provider’s own ceiling', () => {
    for (const perPage of [0, -1, 101, 1.5]) {
      expect(() => buildSentryIssueEventsUrl({
        instance: INSTANCE,
        entryId: '1234',
        perPage,
      })).toThrow();
    }
  });
});
