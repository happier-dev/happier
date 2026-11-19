import { MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { SENTRY_SCOPE_SEPARATOR } from '../sentryContracts.js';
import {
  decodeSentryInstanceConfiguration,
  decodeSentryLocalInstanceKey,
  encodeSentryInstanceConfiguration,
  encodeSentryLocalInstanceKey,
} from './sentryInstanceConfiguration.js';

describe('encodeSentryInstanceConfiguration', () => {
  it('reads legacy all-accessible scope as All and accepts a non-empty selected project set', () => {
    const retained = {
      v: 1, organizationId: '7701', environmentScope: { kind: 'all' },
    };
    expect(decodeSentryInstanceConfiguration(JSON.stringify({
      ...retained, projectScope: { kind: 'allAccessible' },
    }))).toMatchObject({ ok: true, configuration: { projectScope: { kind: 'all' } } });
    const selected = { ...retained, projectScope: { kind: 'selected', unitIds: ['9001', '9002'] } };
    expect(decodeSentryInstanceConfiguration(JSON.stringify(selected)))
      .toEqual({ ok: true, configuration: selected });
    expect(decodeSentryInstanceConfiguration(JSON.stringify({
      ...retained, projectScope: { kind: 'selected', unitIds: [] },
    })).ok).toBe(false);
    expect(decodeSentryInstanceConfiguration(JSON.stringify({
      ...retained, projectScope: { kind: 'selected', unitIds: ['mutable-slug'] },
    })).ok).toBe(false);
  });

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
        projectScope: { kind: 'all' },
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

  it('drops unknown retained fields at every configuration boundary and keeps encoded output canonical', () => {
    const configuration = {
      v: 1,
      organizationId: '7701',
      projectScope: { kind: 'all' },
      environmentScope: { kind: 'all' },
    };
    expect(decodeSentryInstanceConfiguration(JSON.stringify({
      ...configuration,
      unexpected: true,
    }))).toEqual({ ok: true, configuration });
    expect(decodeSentryInstanceConfiguration(JSON.stringify({
      ...configuration,
      projectScope: { kind: 'allAccessible', unexpected: true },
    }))).toEqual({ ok: true, configuration });
    expect(decodeSentryInstanceConfiguration(JSON.stringify({
      ...configuration,
      environmentScope: { kind: 'all', unexpected: true },
    }))).toEqual({ ok: true, configuration });
  });

  it('accepts selected-project tokens at the UTF-8 boundary and refuses the first byte over', () => {
    const unitIds = Array.from({ length: 32 }, (_, index) => String(9001 + index));
    const configuration = (padding: number) => ({
      v: 1,
      organizationId: '7701',
      projectScope: { kind: 'selected', unitIds },
      projectUnits: unitIds.map((id, index) => ({
        id,
        label: `Paiement 🧪${'a'.repeat(Math.floor((padding + index) / unitIds.length))}`,
      })),
      environmentScope: { kind: 'all' },
    } as const);
    const bytes = (token: string) => new TextEncoder().encode(token).byteLength;
    const overhead = bytes(encodeSentryInstanceConfiguration(configuration(0)));
    const maxPadding = MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 - overhead;
    for (const delta of [-1, 0]) {
      const input = configuration(maxPadding + delta);
      const token = encodeSentryInstanceConfiguration(input);
      expect(bytes(token)).toBe(MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 + delta);
      expect(decodeSentryInstanceConfiguration(token)).toEqual({ ok: true, configuration: input });
    }
    expect(() => encodeSentryInstanceConfiguration(configuration(maxPadding + 1))).toThrow(/bounded token size/);
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
