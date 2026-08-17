import { describe, expect, it } from 'vitest';

import { SENTRY_SCOPE_SEPARATOR } from '../sentryContracts.js';
import {
  deriveSentryCollisionScope,
  resolveSentryInvokedScope,
} from './sentryCollisionScope.js';

const CONFIGURED = Object.freeze({
  deploymentOrigin: 'https://us.sentry.io',
  organizationId: '7701',
});

describe('deriveSentryCollisionScope', () => {
  it('distinguishes equal issue ids when either origin or organization numeric id differs', () => {
    const base = deriveSentryCollisionScope(CONFIGURED);
    const otherOrigin = deriveSentryCollisionScope({
      deploymentOrigin: 'https://de.sentry.io',
      organizationId: '7701',
    });
    const otherOrganization = deriveSentryCollisionScope({
      deploymentOrigin: 'https://us.sentry.io',
      organizationId: '7702',
    });

    expect(base).not.toBe(otherOrigin);
    expect(base).not.toBe(otherOrganization);
    expect(otherOrigin).not.toBe(otherOrganization);
  });

  it('coalesces two observation authorities that share origin and organization', () => {
    // The exact Connected Account is observation authority, never identity: two
    // accounts observing one organization must produce one scope.
    expect(deriveSentryCollisionScope(CONFIGURED)).toBe(deriveSentryCollisionScope({
      deploymentOrigin: 'https://us.sentry.io',
      organizationId: '7701',
    }));
  });

  it('retains the organization numeric id but excludes every mutable locator field', () => {
    const scope = deriveSentryCollisionScope(CONFIGURED);

    expect(scope).toBe(`https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`);
    expect(scope).not.toContain('example-org');
    expect(scope).not.toContain('example-project');
    expect(scope).not.toContain('EXAMPLE-PROJECT-3F');
    expect(scope).not.toContain('permalink');
  });

  it('refuses an empty or non-numeric organization id rather than minting a partial scope', () => {
    expect(() => deriveSentryCollisionScope({
      deploymentOrigin: 'https://us.sentry.io',
      organizationId: '',
    })).toThrow();
    expect(() => deriveSentryCollisionScope({
      deploymentOrigin: 'https://us.sentry.io',
      organizationId: 'example-org',
    })).toThrow();
    expect(() => deriveSentryCollisionScope({
      deploymentOrigin: 'us.sentry.io',
      organizationId: '7701',
    })).toThrow();
  });
});

describe('resolveSentryInvokedScope', () => {
  it('derives the scope from the exact invoked route', () => {
    expect(resolveSentryInvokedScope({
      configured: CONFIGURED,
      requestUrl: 'https://us.sentry.io/api/0/organizations/7701/issues/5501001/?expand=owners',
    })).toEqual({ ok: true, collisionScope: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701` });
  });

  it('rejects a request route whose origin differs from the exact invoked instance', () => {
    expect(resolveSentryInvokedScope({
      configured: CONFIGURED,
      requestUrl: 'https://de.sentry.io/api/0/organizations/7701/issues/5501001/',
    })).toEqual({
      ok: false,
      failure: { class: 'unsupportedContract', code: 'sentry-invoked-origin-mismatch' },
    });
  });

  it('rejects a request route whose organization differs from the exact invoked instance', () => {
    expect(resolveSentryInvokedScope({
      configured: CONFIGURED,
      requestUrl: 'https://us.sentry.io/api/0/organizations/7702/issues/5501001/',
    })).toEqual({
      ok: false,
      failure: { class: 'unsupportedContract', code: 'sentry-invoked-organization-mismatch' },
    });
    expect(resolveSentryInvokedScope({
      configured: CONFIGURED,
      requestUrl: 'https://us.sentry.io/api/0/organizations/example-org/issues/5501001/',
    })).toEqual({
      ok: false,
      failure: { class: 'unsupportedContract', code: 'sentry-invoked-organization-mismatch' },
    });
  });

  it('rejects a route that is not an organization-scoped Sentry API path at all', () => {
    expect(resolveSentryInvokedScope({
      configured: CONFIGURED,
      requestUrl: 'https://us.sentry.io/api/0/issues/5501001/',
    })).toEqual({
      ok: false,
      failure: { class: 'unsupportedContract', code: 'sentry-invoked-organization-mismatch' },
    });
    expect(resolveSentryInvokedScope({
      configured: CONFIGURED,
      requestUrl: 'not-a-url',
    })).toEqual({
      ok: false,
      failure: { class: 'unsupportedContract', code: 'sentry-invoked-origin-mismatch' },
    });
  });
});
