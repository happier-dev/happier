import { describe, expect, it } from 'vitest';

import issuesListPage1 from '../fixtures/issuesListPage1.json' with { type: 'json' };

import { SENTRY_DISPLAY_PATH_SEPARATOR } from '../sentryContracts.js';
import { buildSentryLocator } from './sentryLocator.js';

const ISSUE = issuesListPage1.body[0]!;

describe('buildSentryLocator', () => {
  it('carries the provider permalink verbatim and composes the display path', () => {
    expect(buildSentryLocator({
      permalink: ISSUE.permalink,
      organizationSlug: 'example-org',
      projectSlug: ISSUE.project.slug,
      shortId: ISSUE.shortId,
      deploymentOrigin: 'https://us.sentry.io',
      entryId: ISSUE.id,
      organizationId: '7701',
    })).toEqual({
      webUrl: 'https://example-org.sentry.io/issues/5501001/',
      displayPath: `example-org/example-project${SENTRY_DISPLAY_PATH_SEPARATOR}EXAMPLE-PROJECT-3F`,
      truncated: false,
    });
  });

  it('emits no routingToken and no secret-bearing field', () => {
    const locator = buildSentryLocator({
      permalink: ISSUE.permalink,
      organizationSlug: 'example-org',
      projectSlug: ISSUE.project.slug,
      shortId: ISSUE.shortId,
      deploymentOrigin: 'https://us.sentry.io',
      entryId: ISSUE.id,
      organizationId: '7701',
    });

    expect(Object.keys(locator).sort()).toEqual(['displayPath', 'truncated', 'webUrl']);
    expect('routingToken' in locator).toBe(false);
  });

  it('falls back to the organization-scoped API route when the permalink is unusable', () => {
    for (const permalink of [null, undefined, '', 'javascript:alert(1)', 'not a url']) {
      expect(buildSentryLocator({
        permalink,
        organizationSlug: 'example-org',
        projectSlug: 'example-project',
        shortId: 'EXAMPLE-PROJECT-3F',
        deploymentOrigin: 'https://us.sentry.io',
        entryId: '5501001',
        organizationId: '7701',
      }).webUrl).toBe('https://us.sentry.io/organizations/example-org/issues/5501001/');
    }
  });

  it('degrades the display path component-by-component instead of dropping it', () => {
    expect(buildSentryLocator({
      permalink: null,
      organizationSlug: 'example-org',
      projectSlug: null,
      shortId: null,
      deploymentOrigin: 'https://us.sentry.io',
      entryId: '5501001',
      organizationId: '7701',
    }).displayPath).toBe(`example-org${SENTRY_DISPLAY_PATH_SEPARATOR}5501001`);
  });
});
