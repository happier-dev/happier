import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

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
  it('prefers the materialized direct live runtime apply hook', async () => {
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
    })).toEqual({
      supported: true,
      mode: 'direct_live_hot_auth',
    });

    await expect(adapter.hotApply({
      target: { agentId: 'codex' },
      selection,
    })).resolves.toEqual({
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      verification: {
        activeAccountId: 'acct-work',
        proofStrength: 'exact',
        source: 'applied_credential',
      },
    });

    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      requireDirectLiveHotApply: true,
      expected: {
        profileId: 'work',
        groupId: 'team',
        generation: 4,
      },
      authGeneration: {
        credential: record,
        forcedWorkspaceId: 'acct-work',
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'work',
          fallbackProfileId: 'backup',
          generation: 4,
        },
      },
    });
    expect(selection.client.request).not.toHaveBeenCalled();
    expect(selection.invalidateTransports).not.toHaveBeenCalled();
  });

  it('labels retained control-client invalidation fallback as transport recycle', async () => {
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
      supported: true,
      mode: 'transport_recycle',
      recovery: 'restart_resume',
    });

    await expect(adapter.hotApply({
      target: { agentId: 'codex' },
      selection,
    })).resolves.toEqual({
      applied: true,
      via: 'transport_recycle',
      appliedVia: 'transport_recycle',
    });
  });

  it('returns restart-required partial state when direct-live follow-up persistence fails', async () => {
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
      appliedVia: 'direct_live_hot_auth',
      partialState: 'runtime_auth_partially_applied',
      activeAccountId: 'acct-work',
      reason: 'refresh_bridge_selection_update_failed',
      error: 'refresh_bridge_selection_update_failed',
      recovery: 'restart_resume',
    });
  });

  it('treats successful direct-live responses with failed durability as partial state', async () => {
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
      appliedVia: 'direct_live_hot_auth',
      partialState: 'runtime_auth_partially_applied',
      activeAccountId: 'acct-work',
      reason: 'auth_store_persistence_failed_after_live_apply',
      error: 'auth_store_persistence_failed_after_live_apply',
      recovery: 'restart_resume',
      durability: {
        persisted: false,
        errorCode: 'auth_store_persistence_failed_after_live_apply',
      },
    });
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
      reason: 'live_hot_auth_unavailable',
      recovery: 'restart_resume',
    });

    await expect(adapter.hotApply({
      target: { agentId: 'codex' },
      selection,
    })).resolves.toEqual({
      applied: false,
      reason: 'live_hot_auth_unavailable',
      recovery: 'restart_resume',
    });
    expect(client.request).not.toHaveBeenCalled();
    expect(invalidateTransports).not.toHaveBeenCalled();
  });
});
