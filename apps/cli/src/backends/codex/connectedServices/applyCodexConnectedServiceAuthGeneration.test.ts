import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  applyCodexConnectedServiceAuthGeneration,
  evaluateCodexConnectedServiceHotApplyEligibility,
} from './applyCodexConnectedServiceAuthGeneration';

describe('Codex connected-service runtime auth application', () => {
  it('rejects forced-workspace mismatches before mutating live auth', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'openai-codex',
      profileId: 'personal',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'workspace-personal',
        providerEmail: null,
      },
    });
    const client = { request: vi.fn() };

    const result = await applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: 'workspace-work',
    });

    expect(result).toEqual({ applied: false, reason: 'forced_workspace_incompatible' });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('hot-applies same-family ChatGPT token credentials through account/login/start', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const client = { request: vi.fn(async () => ({ ok: true })) };
    const persistAuthStore = vi.fn(async () => {});

    const result = await applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: 'workspace-work',
      persistAuthStore,
    });

    expect(result).toMatchObject({
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'workspace-work',
      durability: { persisted: true },
    });
    expect(result).not.toHaveProperty('via');

    expect(client.request).toHaveBeenCalledWith('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: 'access',
      chatgptAccountId: 'workspace-work',
    });
    expect(persistAuthStore).toHaveBeenCalledOnce();
    expect(client.request.mock.invocationCallOrder[0]!)
      .toBeLessThan(persistAuthStore.mock.invocationCallOrder[0]!);
  });

  it('treats auth-store persistence as durability after live apply, not as the live apply mechanism', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const client = { request: vi.fn(async () => ({ ok: true })) };
    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: 'workspace-work',
    })).resolves.toMatchObject({
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'workspace-work',
      durability: { persisted: false, errorCode: 'auth_store_persistence_unavailable_after_live_apply' },
    });

    expect(client.request).toHaveBeenCalledOnce();
  });

  it('returns a durability diagnostic when auth-store persistence fails after live apply', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const client = { request: vi.fn(async () => ({ ok: true })) };
    const persistAuthStore = vi.fn(async () => {
      throw new Error('disk full');
    });

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: 'workspace-work',
      persistAuthStore,
    })).resolves.toMatchObject({
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'workspace-work',
      durability: { persisted: false, errorCode: 'auth_store_persistence_failed_after_live_apply' },
    });

    expect(client.request).toHaveBeenCalledOnce();
  });

  it('arms the refresh bridge selection before live login succeeds and before durability work', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const order: string[] = [];
    const client = {
      request: vi.fn(async () => {
        order.push('login');
        return { ok: true };
      }),
    };
    const updateRefreshSelection = vi.fn(async () => {
      order.push('refresh-selection');
      return async () => {
        order.push('rollback');
      };
    });

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: 'workspace-work',
      refreshSelection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'work',
        fallbackProfileId: 'old',
        generation: 4,
      },
      updateRefreshSelection,
    } as any)).resolves.toMatchObject({
      applied: true,
      appliedVia: 'direct_live_hot_auth',
    });

    expect(order).toEqual(['refresh-selection', 'login']);
    expect(updateRefreshSelection).toHaveBeenCalledWith({
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'work',
      fallbackProfileId: 'old',
      generation: 4,
    });
  });

  it('rolls back an armed refresh bridge selection when live login fails before mutation', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const order: string[] = [];
    const client = {
      request: vi.fn(async () => {
        order.push('login');
        throw new Error('forced_chatgpt_workspace_id rejected supplied chatgptAccountId');
      }),
    };
    const updateRefreshSelection = vi.fn(async () => {
      order.push('refresh-selection');
      return async () => {
        order.push('rollback');
      };
    });

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: null,
      refreshSelection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'work',
        fallbackProfileId: 'old',
        generation: 4,
      },
      updateRefreshSelection,
    } as any)).resolves.toEqual({
      applied: false,
      reason: 'forced_workspace_incompatible',
    });

    expect(updateRefreshSelection).toHaveBeenCalledOnce();
    expect(order).toEqual(['refresh-selection', 'login', 'rollback']);
  });

  it('fails before live mutation when refresh bridge selection is required but no updater is available', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const client = { request: vi.fn(async () => ({ ok: true })) };

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: null,
      refreshSelection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'work',
      },
    } as any)).resolves.toEqual({
      applied: false,
      reason: 'refresh_selection_resync_failed',
    });

    expect(client.request).not.toHaveBeenCalled();
  });

  it('fails before live mutation when refresh bridge selection update fails', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const order: string[] = [];
    const client = {
      request: vi.fn(async () => {
        order.push('login');
        return { ok: true };
      }),
    };
    const updateRefreshSelection = vi.fn(async () => {
      order.push('refresh-selection');
      throw new Error('selection write failed');
    });

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: null,
      refreshSelection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'work',
      },
      updateRefreshSelection,
    } as any)).resolves.toEqual({
      applied: false,
      reason: 'refresh_selection_resync_failed',
    });

    expect(order).toEqual(['refresh-selection']);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('does not require transport invalidation for direct live app-server auth apply', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const client = { request: vi.fn(async () => ({ ok: true })) };

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: 'workspace-work',
    })).resolves.toMatchObject({
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'workspace-work',
    });

    expect(client.request).toHaveBeenCalledOnce();
  });

  it('direct-live applies while a provider turn is in flight because Codex app-server auth swaps are in-process safe', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const client = { request: vi.fn(async () => ({ ok: true })) };

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: 'workspace-work',
    } as any)).resolves.toMatchObject({
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'workspace-work',
    });

    expect(client.request).toHaveBeenCalledWith('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: 'access',
      chatgptAccountId: 'workspace-work',
    });
  });

  it('requires an exact provider account id before live mutation', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: null,
        providerEmail: 'work@example.test',
      },
    });
    const client = { request: vi.fn(async () => ({ ok: true })) };

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: null,
    })).resolves.toEqual({
      applied: false,
      reason: 'direct_live_hot_auth_ineligible',
      detailReason: 'provider_account_identity_unavailable',
    });

    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects forced non-ChatGPT login method before live mutation', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const client = { request: vi.fn(async () => ({ ok: true })) };

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: null,
      forcedLoginMethod: 'api_key',
    } as any)).resolves.toEqual({
      applied: false,
      reason: 'direct_live_hot_auth_ineligible',
      detailReason: 'credential_family_mismatch',
    });

    expect(client.request).not.toHaveBeenCalled();
  });

  it('maps missing experimental login surface to a compatibility diagnostic without token leakage', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
        idToken: 'secret-id-token',
        scope: null,
        tokenType: null,
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const client = {
      request: vi.fn(async () => {
        const error = new Error('Method not found: account/login/start') as Error & { code?: number; method?: string };
        error.code = -32601;
        error.method = 'account/login/start';
        throw error;
      }),
    };

    const result = await applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: null,
    });

    expect(result).toMatchObject({
      applied: false,
      reason: 'experimental_api_unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('secret-access-token');
    expect(JSON.stringify(result)).not.toContain('secret-refresh-token');
    expect(JSON.stringify(result)).not.toContain('secret-id-token');
  });

  it('maps forced workspace/login rejections from Codex to precise diagnostics', async () => {
    const candidate = buildConnectedServiceCredentialRecord({
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
        providerAccountId: 'workspace-work',
        providerEmail: null,
      },
    });
    const client = {
      request: vi.fn(async () => {
        throw new Error('forced_chatgpt_workspace_id rejected supplied chatgptAccountId');
      }),
    };

    await expect(applyCodexConnectedServiceAuthGeneration({
      client,
      candidate,
      forcedWorkspaceId: null,
    })).resolves.toMatchObject({
      applied: false,
      reason: 'forced_workspace_incompatible',
    });
  });

  it('marks API-key or native auth-family transitions as restart-only', () => {
    const candidate = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'openai',
      profileId: 'api',
      kind: 'token',
      token: { token: 'sk-openai', providerAccountId: null, providerEmail: null },
    });

    expect(evaluateCodexConnectedServiceHotApplyEligibility({
      candidate,
      forcedWorkspaceId: null,
    })).toEqual({
      eligible: false,
      reason: 'direct_live_hot_auth_ineligible',
      detailReason: 'auth_family_mismatch',
    });
  });

});
