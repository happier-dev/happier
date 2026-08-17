import { describe, expect, it } from 'vitest';

import organizationsCloudPage from '../fixtures/organizationsCloudPage.json' with { type: 'json' };
import organizationsOssPage from '../fixtures/organizationsOssPage.json' with { type: 'json' };

import { parseSentryOrganizationsPage } from './sentryOrganizations.js';

const CLOUD = Object.freeze({
  kind: 'cloud' as const,
  region: 'us' as const,
  origin: 'https://us.sentry.io',
});
const SELF_HOSTED = Object.freeze({
  kind: 'selfHosted' as const,
  origin: 'https://sentry.example.com',
});

describe('parseSentryOrganizationsPage', () => {
  it('parses an organization carrying neither access nor features and never reads the omission as a denial', () => {
    // First-party source serializes this listing with feature flags disabled and
    // no access object, so a required parser rejects every current OSS/self-hosted
    // response and an `[]` default disables every organization.
    const parsed = parseSentryOrganizationsPage({
      deployment: SELF_HOSTED,
      body: organizationsOssPage.body,
    });

    expect(parsed.organizations).toHaveLength(2);
    expect(parsed.malformedRowCount).toBe(0);
    expect(parsed.organizations[0]).toEqual({
      organizationId: '4501',
      slug: 'example-org',
      name: 'Example Org',
      statusId: 'active',
      grantedScopes: null,
      features: null,
    });
    expect(parsed.failure).toBeNull();
  });

  it('keeps the SaaS access and features arrays when the deployment does emit them', () => {
    const parsed = parseSentryOrganizationsPage({
      deployment: CLOUD,
      body: organizationsCloudPage.body,
    });

    expect(parsed.organizations[0]?.grantedScopes).toEqual(['org:read', 'event:read']);
    expect(parsed.organizations[0]?.features).toEqual([
      'advanced-search',
      'custom-symbol-sources',
    ]);
  });

  it('keeps valid siblings and counts malformed rows instead of rejecting the batch', () => {
    const parsed = parseSentryOrganizationsPage({
      deployment: CLOUD,
      body: [
        organizationsCloudPage.body[0],
        { id: 7702 },
        { slug: 'no-id-org' },
        'a bare string',
        { id: 'example-org', slug: 'non-numeric-id' },
      ],
    });

    expect(parsed.organizations.map((organization) => organization.organizationId)).toEqual(['7701']);
    expect(parsed.malformedRowCount).toBe(4);
    expect(parsed.failure).toEqual({
      class: 'unsupportedContract',
      code: 'sentry-malformed-organization-row',
    });
  });

  it('rejects an organization whose regionUrl names a different deployment', () => {
    const parsed = parseSentryOrganizationsPage({
      deployment: CLOUD,
      body: [{
        ...organizationsCloudPage.body[0],
        links: { organizationUrl: 'https://x.sentry.io', regionUrl: 'https://de.sentry.io' },
      }],
    });

    expect(parsed.organizations).toHaveLength(0);
    expect(parsed.failure).toEqual({
      class: 'unsupportedContract',
      code: 'sentry-region-origin-undeclared',
    });
  });

  it('accepts an organization with no links object rather than inventing a route', () => {
    const { links, ...withoutLinks } = organizationsCloudPage.body[0] ?? {};
    void links;
    const parsed = parseSentryOrganizationsPage({ deployment: CLOUD, body: [withoutLinks] });

    expect(parsed.organizations).toHaveLength(1);
    expect(parsed.failure).toBeNull();
  });

  it('reports a non-array body as an unparseable response', () => {
    const parsed = parseSentryOrganizationsPage({
      deployment: CLOUD,
      body: { detail: 'not an array' },
    });

    expect(parsed.organizations).toHaveLength(0);
    expect(parsed.failure).toEqual({
      class: 'unsupportedContract',
      code: 'sentry-response-unparseable',
    });
  });
});
