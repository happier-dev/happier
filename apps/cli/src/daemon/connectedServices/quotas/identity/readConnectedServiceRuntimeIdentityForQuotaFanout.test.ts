import { describe, expect, it, vi } from 'vitest';

import type { StoredCredentials } from '@/persistence';
import { createConnectedServiceRuntimeIdentityFanoutReader } from './readConnectedServiceRuntimeIdentityForQuotaFanout';

describe('createConnectedServiceRuntimeIdentityFanoutReader', () => {
  const credentials = {
    token: 'token',
    encryption: null,
  } satisfies StoredCredentials;

  it('requests exact live runtime identity through the session transport', async () => {
    const readConnectedServiceRuntimeIdentity = vi.fn(async () => ({
      ok: true as const,
      value: {
        ok: true as const,
        serviceId: 'openai-codex' as const,
        identity: {
          strategy: 'provider_account_id' as const,
          proofStrength: 'exact' as const,
          providerAccountId: 'acct-live',
          accountLabel: 'Live account',
        },
        runtime: {
          safeToProbe: true,
          safeToApply: false,
          // Legacy runtime decision fields must not be propagated into fanout policy.
          safeToDirectLiveApply: true,
          requiresTurnBoundaryForApply: false,
          inProviderTurn: true,
          profileId: 'work',
          groupId: 'group-1',
          generation: 7,
        },
      },
    }));
    const createTransport = vi.fn(() => ({ readConnectedServiceRuntimeIdentity }));
    const reader = createConnectedServiceRuntimeIdentityFanoutReader({ credentials, createTransport });

    await expect(reader({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'group-1',
      expectedProfileId: 'work',
      expectedGroupGeneration: 7,
      reason: 'same_provider_account_exhausted',
    })).resolves.toEqual({
      status: 'exact',
      strategy: 'provider_account_id',
      providerAccountId: 'acct-live',
      accountLabel: 'Live account',
      profileId: 'work',
      groupId: 'group-1',
      groupGeneration: 7,
      inProviderTurn: true,
      safeToApply: false,
    });
    expect(createTransport).toHaveBeenCalledWith({ credentials, sessionId: 'sess_1' });
    expect(readConnectedServiceRuntimeIdentity).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'same_provider_account_exhausted',
      requireExactProof: true,
      expected: {
        groupId: 'group-1',
      },
    });
  });

  it('fails closed when runtime identity proof is not exact provider-account proof', async () => {
    const reader = createConnectedServiceRuntimeIdentityFanoutReader({
      credentials,
      createTransport: () => ({
        readConnectedServiceRuntimeIdentity: vi.fn(async () => ({
          ok: true as const,
          value: {
            ok: true as const,
            serviceId: 'openai-codex' as const,
            identity: {
              strategy: 'provider_account_id' as const,
              proofStrength: 'diagnostic' as const,
              providerAccountId: 'acct-live',
            },
            runtime: {
              safeToProbe: true,
              profileId: 'work',
              groupId: 'group-1',
              generation: 7,
            },
          },
        })),
      }),
    });

    await expect(reader({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'group-1',
      expectedProfileId: 'work',
      expectedGroupGeneration: 7,
      reason: 'same_provider_account_exhausted',
    })).resolves.toEqual({
      status: 'inexact',
      reason: 'same_account_fanout_runtime_identity_probe_inexact',
    });
  });

  it('returns exact identity when daemon expected profile and generation are stale', async () => {
    const reader = createConnectedServiceRuntimeIdentityFanoutReader({
      credentials,
      createTransport: () => ({
        readConnectedServiceRuntimeIdentity: vi.fn(async () => ({
          ok: true as const,
          value: {
            ok: true as const,
            serviceId: 'openai-codex' as const,
            identity: {
              strategy: 'provider_account_id' as const,
              proofStrength: 'exact' as const,
              providerAccountId: 'acct-live',
            },
            runtime: {
              safeToProbe: true,
              profileId: 'actual-work',
              groupId: 'group-1',
              generation: 8,
            },
          },
        })),
      }),
    });

    await expect(reader({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'group-1',
      expectedProfileId: 'work',
      expectedGroupGeneration: 7,
      reason: 'same_provider_account_exhausted',
    })).resolves.toEqual({
      status: 'exact',
      strategy: 'provider_account_id',
      providerAccountId: 'acct-live',
      accountLabel: null,
      profileId: 'actual-work',
      groupId: 'group-1',
      groupGeneration: 8,
      inProviderTurn: false,
    });
  });

  it('returns exact shared-auth-surface identity without requiring provider account id', async () => {
    const reader = createConnectedServiceRuntimeIdentityFanoutReader({
      credentials,
      createTransport: () => ({
        readConnectedServiceRuntimeIdentity: vi.fn(async () => ({
          ok: true as const,
          value: {
            ok: true as const,
            serviceId: 'claude-subscription' as const,
            identity: {
              strategy: 'shared_group_auth_surface' as const,
              proofStrength: 'exact' as const,
              sharedAuthSurfaceId: 'team',
            },
            runtime: {
              safeToProbe: true,
              profileId: 'primary',
              groupId: 'team',
              generation: 4,
            },
          },
        })),
      }),
    });

    await expect(reader({
      sessionId: 'sess_1',
      serviceId: 'claude-subscription',
      groupId: 'team',
      expectedProfileId: 'primary',
      expectedGroupGeneration: 4,
      reason: 'same_provider_account_exhausted',
    })).resolves.toEqual({
      status: 'exact',
      strategy: 'shared_group_auth_surface',
      sharedAuthSurfaceId: 'team',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      inProviderTurn: false,
    });
  });

  it('preserves absent runtime apply capability fields as unknown', async () => {
    const reader = createConnectedServiceRuntimeIdentityFanoutReader({
      credentials,
      createTransport: () => ({
        readConnectedServiceRuntimeIdentity: vi.fn(async () => ({
          ok: true as const,
          value: {
            ok: true as const,
            serviceId: 'openai-codex' as const,
            identity: {
              strategy: 'provider_account_id' as const,
              proofStrength: 'exact' as const,
              providerAccountId: 'acct-live',
            },
            runtime: {
              safeToProbe: true,
              inProviderTurn: true,
              profileId: 'primary',
              groupId: 'team',
              generation: 4,
            },
          },
        })),
      }),
    });

    await expect(reader({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'team',
      expectedProfileId: 'primary',
      expectedGroupGeneration: 4,
      reason: 'same_provider_account_exhausted',
    })).resolves.toEqual({
      status: 'exact',
      strategy: 'provider_account_id',
      providerAccountId: 'acct-live',
      accountLabel: null,
      profileId: 'primary',
      groupId: 'team',
      groupGeneration: 4,
      inProviderTurn: true,
    });
  });
});
