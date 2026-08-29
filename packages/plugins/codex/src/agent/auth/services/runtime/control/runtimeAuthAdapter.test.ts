import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  createCodexConnectedAccountNativeAuthCodec,
  createCodexConnectedServiceRuntimeAuthAdapter,
} from './runtimeAuthAdapter.js';

function buildCodexCredential() {
  return buildConnectedServiceCredentialRecord({
    now: 1000,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: 2000,
    oauth: {
      accessToken: 'access',
      refreshToken: 'refresh',
      idToken: 'id',
      scope: null,
      tokenType: null,
      providerAccountId: 'acct-work',
      providerEmail: 'work@example.test',
    },
  });
}

describe('Codex runtime auth adapter', () => {
  it('attributes runtime failures to the canonical qualified Connected Account service', () => {
    expect(createCodexConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
      target: { agentId: 'codex' },
      selection: {
        serviceId: 'happier.agent.codex/openai-codex',
        profileId: 'work',
      },
      error: { code: 'refresh_token_expired' },
    })).toMatchObject({
      kind: 'auth_expired',
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'work',
    });
  });

  it('returns a public runtime usage observation without writing the retired quota snapshot store', async () => {
    const record = buildCodexCredential();
    const retiredRuntimeQuotaSnapshots = { recordSnapshot: vi.fn() };
    const adapter = createCodexConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.probeQuota({
      target: { agentId: 'codex' },
      selection: {
        groupId: 'team',
        sourceProviderAccountId: record.oauth.providerAccountId,
        sourceAccountLabel: record.oauth.providerEmail,
      },
      readProviderUsage: vi.fn(async () => ({
            rateLimits: {
              primary: { usedPercent: 12, resetsAt: 1_768_010_000 },
            },
          })),
    })).resolves.toMatchObject({
      status: 'available',
      usageSnapshot: {
        providerId: 'openai-codex',
        recordKey: {
          providerId: 'openai-codex',
          accountSubjectId: 'acct-work',
          subjectKind: 'account',
          quotaScope: 'account',
        },
        accountSubject: { kind: 'providerSubject', id: 'acct-work' },
        source: 'runtimeSignal',
      },
    });
    expect(retiredRuntimeQuotaSnapshots.recordSnapshot).not.toHaveBeenCalled();
  });

  it('applies the selected generation through the canonical session runtime callback', async () => {
    const record = buildCodexCredential();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: {
        activeAccountId: 'acct-work',
        proofStrength: 'exact',
        source: 'applied_credential',
      },
    }));
    const adapter = createCodexConnectedServiceRuntimeAuthAdapter();
    const materializeNativeAuth = vi.fn(async () => ({
      status: 'verified' as const,
      providerAccountId: 'acct-work',
    }));
    const selection = {
      applyReason: 'usage_limit',
      requireDirectLiveHotApply: true,
      groupId: 'team',
      activeProfileId: 'work',
      fallbackProfileId: 'backup',
      generation: 4,
    };

    expect(adapter.canHotApply({
      target: { agentId: 'codex' },
      selection,
      applySelectedAuthGeneration: applyConnectedServiceAuthGeneration,
      materializeNativeAuth,
    })).toEqual({ supported: true });

    await expect(adapter.hotApply({
      target: { agentId: 'codex' },
      selection,
      applySelectedAuthGeneration: applyConnectedServiceAuthGeneration,
      materializeNativeAuth,
    })).resolves.toMatchObject({
      applied: true,
      reason: 'direct_live_hot_auth',
      verification: { activeAccountId: 'acct-work', proofStrength: 'exact' },
    });

    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith();
    expect(materializeNativeAuth).toHaveBeenCalledWith();
  });

  it('declines when the canonical session runtime callback is unavailable', async () => {
    const adapter = createCodexConnectedServiceRuntimeAuthAdapter();
    const selection = {};

    expect(adapter.canHotApply({
      target: { agentId: 'codex' },
      selection,
    })).toEqual({
      supported: false,
      reason: 'runtime_apply_callback_unavailable',
    });

    await expect(adapter.hotApply({
      target: { agentId: 'codex' },
      selection,
    })).resolves.toEqual({
      applied: false,
      reason: 'runtime_apply_callback_unavailable',
    });
  });

  it('reports a callback response that identifies partial live mutation for restart reconciliation', async () => {
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: false,
      errorCode: 'refresh_bridge_selection_update_failed',
      error: { phase: 'refresh-selection' },
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'acct-work',
      recovery: 'restart_resume',
    }));
    const adapter = createCodexConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.hotApply({
      target: { agentId: 'codex' },
      selection: {},
      applySelectedAuthGeneration: applyConnectedServiceAuthGeneration,
      materializeNativeAuth: vi.fn(async () => ({ status: 'verified', providerAccountId: 'acct-work' })),
    })).resolves.toEqual({
      applied: false,
      reason: 'refresh_bridge_selection_update_failed',
      recovery: 'restart_resume',
    });
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledOnce();
  });

  it('requires host-owned auth-store persistence after direct live apply', async () => {
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'acct-work',
      durability: {
        persisted: false,
        errorCode: 'auth_store_persistence_failed_after_live_apply',
      },
    }));
    const adapter = createCodexConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.hotApply({
      target: { agentId: 'codex' },
      selection: {},
      applySelectedAuthGeneration: applyConnectedServiceAuthGeneration,
      materializeNativeAuth: vi.fn(async () => ({
        status: 'unavailable',
        retryable: true,
        reason: 'runtime_apply_persistence_unavailable',
      })),
    })).resolves.toEqual({
      applied: false,
      reason: 'runtime_apply_persistence_unavailable',
      recovery: 'restart_resume',
    });
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledOnce();
  });

  it('suppresses transport recycle when direct live hot apply is required', async () => {
    const adapter = createCodexConnectedServiceRuntimeAuthAdapter();
    const selection = {
      requireDirectLiveHotApply: true,
    };

    expect(adapter.canHotApply({
      target: { agentId: 'codex' },
      selection,
    })).toEqual({
      supported: false,
      reason: 'runtime_apply_callback_unavailable',
    });

    await expect(adapter.hotApply({
      target: { agentId: 'codex' },
      selection,
    })).resolves.toEqual({
      applied: false,
      reason: 'runtime_apply_callback_unavailable',
    });
  });

  it('combines named provider-account and typed native-auth evidence', async () => {
    await expect(createCodexConnectedServiceRuntimeAuthAdapter().verifyActiveAccount({
      target: { agentId: 'codex' },
      selection: {
        sourceProviderAccountId: 'acct-work',
        sourceAccountLabel: 'work@example.test',
      },
      readProviderAccount: vi.fn(async () => ({ account: { email: 'work@example.test' } })),
      inspectNativeAuth: vi.fn(async () => ({
        status: 'mismatch',
        expectedProviderAccountId: 'acct-work',
        actualProviderAccountId: 'acct-other',
        retryable: true,
        reason: 'provider_account_auth_store_mismatch',
      })),
    })).resolves.toEqual({
      status: 'mismatch',
      expectedProviderAccountId: 'acct-work',
      actualProviderAccountId: 'acct-other',
      retryable: true,
      reason: 'provider_account_auth_store_conflict',
    });
  });

  it('encodes and inspects auth.json only through the pure native-auth codec', () => {
    const credential = buildCodexCredential();
    const codec = createCodexConnectedAccountNativeAuthCodec();
    const materialized = codec.materialize({
      credential,
      selection: { serviceId: 'openai-codex', profileId: 'work' },
    });
    expect(materialized.files).toEqual({ 'auth.json': expect.any(Uint8Array) });
    expect(codec.inspect({
      credential,
      selection: { serviceId: 'openai-codex', profileId: 'work' },
      files: materialized.files,
    })).toMatchObject({
      status: 'verified',
      providerAccountId: 'acct-work',
    });
  });
});
