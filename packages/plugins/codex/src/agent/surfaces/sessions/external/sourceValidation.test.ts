import { describe, expect, it } from 'vitest';

import { validateCodexExternalSessionsSourcePolicy } from './sourceValidation.js';

describe('Codex external session source validation policy', () => {
  it('normalizes user-home sources to the configured Codex home path', () => {
    const result = validateCodexExternalSessionsSourcePolicy({
      source: { kind: 'codexHome', home: 'user' },
      configuredCodexHomePath: '/Users/alice/.codex',
      canonicalRequestedHomePath: null,
      isSafeConnectedServiceId: () => true,
    });

    expect(result).toEqual({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/Users/alice/.codex',
      },
    });
  });

  /**
   * Whether a requested home is one the machine environment or the account's
   * settings authorized is decided by the host admission boundary
   * (`admitCallerChosenExternalSessionSourceFields`), which compares the
   * canonical forms this policy produces. The policy canonicalizes and owns only
   * the connected-service identifier rule below, so both sides of that
   * comparison come from one implementation.
   */
  it('keeps a requested user home canonical instead of deciding whether it is allowed', () => {
    const result = validateCodexExternalSessionsSourcePolicy({
      source: { kind: 'codexHome', home: 'user', homePath: '/tmp/other-codex-home' },
      configuredCodexHomePath: '/Users/alice/.codex',
      canonicalRequestedHomePath: '/tmp/other-codex-home',
      isSafeConnectedServiceId: () => true,
    });

    expect(result).toEqual({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/tmp/other-codex-home',
      },
    });
  });

  it('rejects sources from another provider family', () => {
    const result = validateCodexExternalSessionsSourcePolicy({
      source: { kind: 'url', url: 'https://example.com/session' },
      configuredCodexHomePath: '/Users/alice/.codex',
      canonicalRequestedHomePath: null,
      isSafeConnectedServiceId: () => true,
    });

    expect(result).toEqual({
      ok: false,
      error: 'provider/source mismatch',
    });
  });

  it('rejects unsafe connected-service source ids through the host validator', () => {
    const result = validateCodexExternalSessionsSourcePolicy({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: '../escape',
      },
      configuredCodexHomePath: '/Users/alice/.codex',
      canonicalRequestedHomePath: null,
      isSafeConnectedServiceId: () => false,
    });

    expect(result).toEqual({
      ok: false,
      error: 'invalid connectedServiceId',
    });
  });
});
