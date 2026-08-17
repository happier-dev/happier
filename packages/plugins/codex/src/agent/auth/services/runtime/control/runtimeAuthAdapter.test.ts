import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createCodexConnectedServiceRuntimeAuthAdapter } from './runtimeAuthAdapter.js';

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
  it('returns a public runtime usage observation without writing the retired quota snapshot store', async () => {
    const record = buildCodexCredential();
    const retiredRuntimeQuotaSnapshots = { recordSnapshot: vi.fn() };
    const adapter = createCodexConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.probeQuota({
      target: { agentId: 'codex' },
      selection: {
        record,
        groupId: 'team',
        runtimeQuotaSnapshots: retiredRuntimeQuotaSnapshots,
        client: {
          request: vi.fn(async () => ({
            rateLimits: {
              primary: { usedPercent: 12, resetsAt: 1_768_010_000 },
            },
          })),
        },
      },
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
    const selection = {
      record,
      forcedWorkspaceId: 'acct-work',
      applyReason: 'usage_limit',
      requireDirectLiveHotApply: true,
      groupId: 'team',
      activeProfileId: 'work',
      fallbackProfileId: 'backup',
      generation: 4,
      applyConnectedServiceAuthGeneration,
      client: { request: vi.fn(async () => ({ ok: true })) },
      invalidateTransports: vi.fn(async () => undefined),
    };

    expect(adapter.canHotApply({
      target: { agentId: 'codex' },
      selection,
    })).toEqual({ supported: true, mode: 'codex_chatgpt_auth_tokens' });

    await expect(adapter.hotApply({
      target: { agentId: 'codex' },
      selection,
    })).resolves.toMatchObject({
      applied: true,
      reason: 'direct_live_hot_auth',
      verification: { activeAccountId: 'acct-work', proofStrength: 'exact' },
    });

    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      requireDirectLiveHotApply: true,
      expected: { profileId: 'work', groupId: 'team', generation: 4 },
    }));
    expect(selection.client.request).not.toHaveBeenCalled();
    expect(selection.invalidateTransports).not.toHaveBeenCalled();
  });

  it('declines when the canonical session runtime callback is unavailable', async () => {
    const record = buildCodexCredential();
    const client = { request: vi.fn(async () => ({ ok: true })) };
    const invalidateTransports = vi.fn(async () => undefined);
    const adapter = createCodexConnectedServiceRuntimeAuthAdapter();
    const selection = {
      record,
      forcedWorkspaceId: 'acct-work',
      client,
      invalidateTransports,
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
    expect(client.request).not.toHaveBeenCalled();
    expect(invalidateTransports).not.toHaveBeenCalled();
  });

  it('reports a callback response that identifies partial live mutation for restart reconciliation', async () => {
    const record = buildCodexCredential();
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
      selection: {
        record,
        forcedWorkspaceId: 'acct-work',
        applyConnectedServiceAuthGeneration,
      },
    })).resolves.toEqual({
      applied: false,
      reason: 'refresh_bridge_selection_update_failed',
      recovery: 'restart_resume',
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'acct-work',
    });
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledOnce();
  });

  it('reports failed durability after direct live apply for restart reconciliation', async () => {
    const record = buildCodexCredential();
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
      selection: {
        record,
        forcedWorkspaceId: 'acct-work',
        applyConnectedServiceAuthGeneration,
      },
    })).resolves.toEqual({
      applied: false,
      reason: 'auth_store_persistence_failed_after_live_apply',
      recovery: 'restart_resume',
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'acct-work',
    });
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledOnce();
  });

  it('suppresses transport recycle when direct live hot apply is required', async () => {
    const record = buildCodexCredential();
    const client = { request: vi.fn(async () => ({ ok: true })) };
    const invalidateTransports = vi.fn(async () => undefined);
    const adapter = createCodexConnectedServiceRuntimeAuthAdapter();
    const selection = {
      record,
      forcedWorkspaceId: 'acct-work',
      requireDirectLiveHotApply: true,
      client,
      invalidateTransports,
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
    expect(client.request).not.toHaveBeenCalled();
    expect(invalidateTransports).not.toHaveBeenCalled();
  });
});
