import { describe, expect, it } from 'vitest';

import { SENTRY_FAILURE_CODES } from '../sentryContracts.js';

import { resolveSentryAccountRoute } from './sentryAccountRoute.js';

describe('Sentry configured-account route', () => {
  it('routes the DE Cloud deployment from the account origin the host projected', () => {
    const result = resolveSentryAccountRoute(['https://de.sentry.io']);

    expect(result).toEqual({
      ok: true,
      deployment: { kind: 'cloud', region: 'de', origin: 'https://de.sentry.io' },
    });
  });

  it('routes the US Cloud deployment from the account origin the host projected', () => {
    const result = resolveSentryAccountRoute(['https://us.sentry.io']);

    expect(result).toEqual({
      ok: true,
      deployment: { kind: 'cloud', region: 'us', origin: 'https://us.sentry.io' },
    });
  });

  it('refuses to route an account whose configured origin the host did not project', () => {
    const result = resolveSentryAccountRoute([]);

    expect(result).toEqual({
      ok: false,
      failure: {
        class: 'unsupportedContract',
        code: SENTRY_FAILURE_CODES.regionOriginUndeclared,
      },
    });
  });

  it('refuses to choose between two projected origins rather than fanning out', () => {
    const result = resolveSentryAccountRoute(['https://de.sentry.io', 'https://us.sentry.io']);

    expect(result).toEqual({
      ok: false,
      failure: {
        class: 'unsupportedContract',
        code: SENTRY_FAILURE_CODES.regionOriginUndeclared,
      },
    });
  });

  it('routes a self-hosted deployment from its exact normalized configured origin', () => {
    const result = resolveSentryAccountRoute(['https://sentry.internal.example']);

    expect(result).toEqual({
      ok: true,
      deployment: { kind: 'selfHosted', origin: 'https://sentry.internal.example' },
    });
  });

  it('refuses a projected value that is not an exact canonical origin', () => {
    const result = resolveSentryAccountRoute(['https://sentry.internal.example/api/0/']);

    expect(result).toEqual({
      ok: false,
      failure: {
        class: 'unsupportedContract',
        code: SENTRY_FAILURE_CODES.regionOriginUndeclared,
      },
    });
  });
});
