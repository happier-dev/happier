import { describe, expect, it } from 'vitest';

import { SENTRY_SCOPE_SEPARATOR } from '../sentryContracts.js';
import {
  decodeSentryInstanceConfiguration,
  decodeSentryLocalInstanceKey,
  encodeSentryInstanceConfiguration,
  encodeSentryLocalInstanceKey,
} from './sentryInstanceConfiguration.js';

describe('encodeSentryInstanceConfiguration', () => {
  it('round-trips the source-private configuration and persists no deployment origin', () => {
    const token = encodeSentryInstanceConfiguration({
      v: 1,
      organizationId: '7701',
      projectScope: { kind: 'allAccessible' },
      environmentScope: { kind: 'all' },
    });

    expect(token).not.toContain('sentry.io');
    expect(token).not.toContain('https');
    expect(decodeSentryInstanceConfiguration(token)).toEqual({
      ok: true,
      configuration: {
        v: 1,
        organizationId: '7701',
        projectScope: { kind: 'allAccessible' },
        environmentScope: { kind: 'all' },
      },
    });
  });

  it('rejects a malformed, foreign-version or oversized token rather than routing from it', () => {
    expect(decodeSentryInstanceConfiguration('not-json').ok).toBe(false);
    expect(decodeSentryInstanceConfiguration(JSON.stringify({ v: 2, organizationId: '7701' })).ok)
      .toBe(false);
    expect(decodeSentryInstanceConfiguration(JSON.stringify({
      v: 1,
      organizationId: 'example-org',
      projectScope: { kind: 'allAccessible' },
      environmentScope: { kind: 'all' },
    })).ok).toBe(false);
    expect(decodeSentryInstanceConfiguration(JSON.stringify({
      v: 1,
      organizationId: '7701',
      projectScope: { kind: 'selected', projectIds: ['9001'] },
      environmentScope: { kind: 'all' },
    })).ok).toBe(false);
  });

  it('refuses to encode a configuration that would exceed the bounded token size', () => {
    expect(() => encodeSentryInstanceConfiguration({
      v: 1,
      organizationId: '7'.repeat(64 * 1024),
      projectScope: { kind: 'allAccessible' },
      environmentScope: { kind: 'all' },
    })).toThrow();
  });
});

describe('encodeSentryLocalInstanceKey', () => {
  it('recovers the expected normalized origin and organization from the strict key codec', () => {
    const key = encodeSentryLocalInstanceKey({
      deploymentOrigin: 'https://us.sentry.io',
      organizationId: '7701',
    });

    expect(decodeSentryLocalInstanceKey(key)).toEqual({
      ok: true,
      instance: { deploymentOrigin: 'https://us.sentry.io', organizationId: '7701' },
    });
  });

  it('rejects a malformed key rather than routing to a partially recovered origin', () => {
    const sep = SENTRY_SCOPE_SEPARATOR;

    expect(decodeSentryLocalInstanceKey('https://us.sentry.io').ok).toBe(false);
    expect(decodeSentryLocalInstanceKey('').ok).toBe(false);
    expect(decodeSentryLocalInstanceKey(`https://us.sentry.io${sep}`).ok).toBe(false);
    expect(decodeSentryLocalInstanceKey(`${sep}7701`).ok).toBe(false);
    expect(decodeSentryLocalInstanceKey(`https://us.sentry.io${sep}7701${sep}extra`).ok).toBe(false);
    expect(decodeSentryLocalInstanceKey(`https://us.sentry.io/api${sep}7701`).ok).toBe(false);
    expect(decodeSentryLocalInstanceKey(`https://us.sentry.io${sep}example-org`).ok).toBe(false);
  });

  it('keeps the key free of the configuration token, account and query scopes', () => {
    const key = encodeSentryLocalInstanceKey({
      deploymentOrigin: 'https://sentry.example.com',
      organizationId: '4501',
    });

    expect(key).toBe(`https://sentry.example.com${SENTRY_SCOPE_SEPARATOR}4501`);
    expect(key).not.toContain('allAccessible');
    expect(key).not.toContain('account');
  });
});
