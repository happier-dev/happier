import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeAuthControl } from '@happier-dev/plugin-sdk/agents/runtime';

import { adaptAgentSessionRuntimeAuthControl } from './runtimeAuthControlAdapter';

describe('adaptAgentSessionRuntimeAuthControl', () => {
  it('projects the private Session transport envelope into the bounded semantic facet', async () => {
    const apply = vi.fn<AgentSessionRuntimeAuthControl['apply']>(async (request) => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'acct-1',
      verification: {
        proofStrength: 'exact',
        providerAccountId: 'acct-1',
        accountLabel: 'unused-apply-label@example.test',
        generationApplication: {
          serviceId: request.serviceId,
          groupId: 'group-1',
          profileId: 'profile-1',
          generation: 4,
          credentialRevision: 'revision-1',
          credentialFingerprint: 'sha256:12345678',
        },
        durability: {
          persisted: false,
          errorCode: 'unused_nested_durability',
        },
      },
      durability: {
        persisted: true,
      },
      accountLabel: 'unused-top-level-label@example.test',
      transportOnly: 'must-not-return',
    }));
    const readIdentity = vi.fn<AgentSessionRuntimeAuthControl['readIdentity']>(async () => ({
      ok: true,
      serviceId: 'plugin-supplied-service',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct-1',
      },
      runtime: {
        safeToProbe: true,
        generation: 4,
      },
      transportOnly: 'must-not-return',
    }));
    const adapter = adaptAgentSessionRuntimeAuthControl({ apply, readIdentity });

    await expect(adapter.applyConnectedServiceAuthGeneration?.({
      serviceId: 'openai-codex',
      reason: 'manual',
      expected: {
        profileId: 'profile-1',
        generation: 4,
        transportOnly: 'must-not-reach-plugin',
      },
      authGeneration: {
        credential: { kind: 'oauth', accessToken: 'secret' },
      },
      transportOnly: 'must-not-reach-plugin',
    })).resolves.toEqual({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'acct-1',
      verification: {
        proofStrength: 'exact',
        providerAccountId: 'acct-1',
        generationApplication: {
          serviceId: 'openai-codex',
          groupId: 'group-1',
          profileId: 'profile-1',
          generation: 4,
          credentialRevision: 'revision-1',
          credentialFingerprint: 'sha256:12345678',
        },
      },
      durability: {
        persisted: true,
      },
    });
    expect(apply).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'manual',
      expected: {
        profileId: 'profile-1',
        generation: 4,
      },
      authGeneration: {
        credential: { kind: 'oauth', accessToken: 'secret' },
      },
    });

    await expect(adapter.readConnectedServiceRuntimeIdentity?.({
      serviceId: 'openai-codex',
      reason: 'diagnostic',
      transportOnly: 'must-not-reach-plugin',
    })).resolves.toEqual({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct-1',
      },
      runtime: {
        safeToProbe: true,
        generation: 4,
      },
    });
    expect(readIdentity).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'diagnostic',
    });
  });

  it('rejects a non-JSON auth-generation payload before invoking the plugin', async () => {
    const apply = vi.fn<AgentSessionRuntimeAuthControl['apply']>();
    const readIdentity = vi.fn<AgentSessionRuntimeAuthControl['readIdentity']>();
    const adapter = adaptAgentSessionRuntimeAuthControl({ apply, readIdentity });

    await expect(adapter.applyConnectedServiceAuthGeneration?.({
      serviceId: 'openai-codex',
      reason: 'manual',
      authGeneration: { invalid: Symbol('not-json') },
    })).resolves.toEqual({
      ok: false,
      error: 'invalid_request',
      errorCode: 'invalid_request',
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
