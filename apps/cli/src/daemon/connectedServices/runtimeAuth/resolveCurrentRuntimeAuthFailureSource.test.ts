import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { resolveCurrentRuntimeAuthFailureSource } from './resolveCurrentRuntimeAuthFailureSource';

const currentRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';

function classification(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'usage_limit' as const,
    serviceId: 'openai-codex',
    profileId: 'work',
    groupId: 'main',
    groupGeneration: 7,
    expectedCredentialRevision: null,
    sourceProviderAccountId: 'acct_work',
    failingAccessTokenFingerprint: 'sha256:1234abcd',
    resetsAtMs: null,
    planType: null,
    rateLimits: null,
    source: 'structured_provider_error' as const,
    recoveryAction: { kind: 'quota_recovery_required' as const },
    ...overrides,
  };
}

function currentCredential() {
  return {
    credentialRevision: currentRevision,
    record: buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 10_000,
      oauth: {
        accessToken: 'current-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_work',
        providerEmail: null,
      },
    }),
  };
}

function exactLiveIdentity() {
  return {
    serviceId: 'happier.agent.codex/openai-codex' as const,
    proofStrength: 'exact' as const,
    providerAccountId: 'acct_work',
    profileId: 'work',
    groupId: 'main',
    generation: 7,
    credentialRevision: null,
  };
}

describe('resolveCurrentRuntimeAuthFailureSource', () => {
  it('delegates predecessor evidence to the provider leaf after exact tuple verification', async () => {
    const resolveLegacySourceRevision = vi.fn(() => currentRevision);
    await expect(resolveCurrentRuntimeAuthFailureSource({
      classification: classification(),
      readRuntimeIdentity: vi.fn(async () => exactLiveIdentity()),
      resolveCurrentCredential: vi.fn(async () => currentCredential()),
      resolveLegacySourceRevision,
    })).resolves.toEqual({
      serviceId: 'happier.agent.codex/openai-codex',
      groupId: 'main',
      profileId: 'work',
      generation: 7,
      credentialRevision: currentRevision,
    });
    expect(resolveLegacySourceRevision).toHaveBeenCalledWith(expect.objectContaining({
      reportedCredentialRevision: null,
      reportedProviderAccountId: 'acct_work',
      failingAccessTokenFingerprint: 'sha256:1234abcd',
    }));
  });

  it('fails closed for predecessor evidence when the provider has no compatibility hook', async () => {
    await expect(resolveCurrentRuntimeAuthFailureSource({
      classification: classification(),
      readRuntimeIdentity: vi.fn(async () => exactLiveIdentity()),
      resolveCurrentCredential: vi.fn(async () => currentCredential()),
    })).resolves.toBeNull();
  });

  it('keeps current reports on opaque revision equality without consulting provider compatibility', async () => {
    const resolveCurrentCredential = vi.fn(async () => currentCredential());
    const resolveLegacySourceRevision = vi.fn(() => null);
    await expect(resolveCurrentRuntimeAuthFailureSource({
      classification: classification({ expectedCredentialRevision: currentRevision }),
      readRuntimeIdentity: vi.fn(async () => ({
        ...exactLiveIdentity(),
        credentialRevision: currentRevision,
      })),
      resolveCurrentCredential,
      resolveLegacySourceRevision,
    })).resolves.toMatchObject({ credentialRevision: currentRevision });
    expect(resolveCurrentCredential).not.toHaveBeenCalled();
    expect(resolveLegacySourceRevision).not.toHaveBeenCalled();
  });

  it('returns the exact current runtime fact when a modern report describes an older target', async () => {
    const currentRuntimeRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const resolveCurrentCredential = vi.fn(async () => currentCredential());
    const resolveLegacySourceRevision = vi.fn(() => null);

    await expect(resolveCurrentRuntimeAuthFailureSource({
      classification: classification({ expectedCredentialRevision: currentRevision }),
      readRuntimeIdentity: vi.fn(async () => ({
        ...exactLiveIdentity(),
        profileId: 'backup',
        generation: 8,
        credentialRevision: currentRuntimeRevision,
      })),
      resolveCurrentCredential,
      resolveLegacySourceRevision,
    })).resolves.toEqual({
      serviceId: 'happier.agent.codex/openai-codex',
      groupId: 'main',
      profileId: 'backup',
      generation: 8,
      credentialRevision: currentRuntimeRevision,
    });
    expect(resolveCurrentCredential).not.toHaveBeenCalled();
    expect(resolveLegacySourceRevision).not.toHaveBeenCalled();
  });

  it('does not reinterpret an exact live revision through newer server truth', async () => {
    const resolveCurrentCredential = vi.fn(async () => ({
      ...currentCredential(),
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    }));
    await expect(resolveCurrentRuntimeAuthFailureSource({
      classification: classification({ expectedCredentialRevision: currentRevision }),
      readRuntimeIdentity: vi.fn(async () => ({
        ...exactLiveIdentity(),
        credentialRevision: currentRevision,
      })),
      resolveCurrentCredential,
      resolveLegacySourceRevision: vi.fn(() => null),
    })).resolves.toMatchObject({ credentialRevision: currentRevision });
    expect(resolveCurrentCredential).not.toHaveBeenCalled();
  });

  it('rejects a revisioned report when the live exact binding omits its revision without consulting legacy compatibility', async () => {
    const resolveCurrentCredential = vi.fn(async () => currentCredential());
    const resolveLegacySourceRevision = vi.fn(() => currentRevision);
    await expect(resolveCurrentRuntimeAuthFailureSource({
      classification: classification({ expectedCredentialRevision: currentRevision }),
      readRuntimeIdentity: vi.fn(async () => exactLiveIdentity()),
      resolveCurrentCredential,
      resolveLegacySourceRevision,
    })).resolves.toBeNull();
    expect(resolveCurrentCredential).not.toHaveBeenCalled();
    expect(resolveLegacySourceRevision).not.toHaveBeenCalled();
  });

  it('propagates transient runtime and credential outages so report custody can retry', async () => {
    await expect(resolveCurrentRuntimeAuthFailureSource({
      classification: classification(),
      readRuntimeIdentity: vi.fn(async () => exactLiveIdentity()),
      resolveCurrentCredential: vi.fn(async () => {
        throw new Error('credential truth temporarily unavailable');
      }),
      resolveLegacySourceRevision: vi.fn(() => currentRevision),
    })).rejects.toThrow('temporarily unavailable');
  });

  it('propagates typed unavailable runtime identity so report custody can retry', async () => {
    await expect(resolveCurrentRuntimeAuthFailureSource({
      classification: classification({ expectedCredentialRevision: currentRevision }),
      readRuntimeIdentity: vi.fn(async () => ({
        status: 'unavailable' as const,
        reason: 'session RPC transport unavailable',
      })),
      resolveCurrentCredential: vi.fn(async () => currentCredential()),
      resolveLegacySourceRevision: vi.fn(() => currentRevision),
    })).rejects.toThrow('session RPC transport unavailable');
  });

  it('keeps a missing or mismatched exact identity terminal', async () => {
    await expect(resolveCurrentRuntimeAuthFailureSource({
      classification: classification({ expectedCredentialRevision: currentRevision }),
      readRuntimeIdentity: vi.fn(async () => null),
      resolveCurrentCredential: vi.fn(async () => currentCredential()),
      resolveLegacySourceRevision: vi.fn(() => currentRevision),
    })).resolves.toBeNull();
  });
});
