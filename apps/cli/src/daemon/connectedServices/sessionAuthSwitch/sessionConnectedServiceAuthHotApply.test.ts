import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceProviderRuntimeAuthAdapter } from '../runtimeAuth/types';
import { createSessionConnectedServiceAuthHotApply } from './sessionConnectedServiceAuthHotApply';

describe('createSessionConnectedServiceAuthHotApply', () => {
  it('infers the provider from webhook metadata when startup-drained tracked sessions have no spawn options', async () => {
    const hotApply = vi.fn(async () => ({ applied: true }));
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const resolveRuntimeAuthAdapter = vi.fn(async () => adapter);
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/project',
          host: 'host',
          homeDir: '/home/user',
          happyHomeDir: '/home/user/.happy',
          happyLibDir: '/home/user/.happy/lib',
          happyToolsDir: '/home/user/.happy/tools',
          codexSessionId: 'codex-session-1',
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(resolveRuntimeAuthAdapter).toHaveBeenCalledWith('codex');
    expect(hotApply).toHaveBeenCalledOnce();
  });

  it('invokes the provider runtime auth adapter for connected bindings', async () => {
    const hotApply = vi.fn(async () => ({ applied: true }));
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(hotApply).toHaveBeenCalledWith({
      target: { agentId: 'codex' },
      selection: expect.objectContaining({
        serviceId: 'happier.agent.codex/openai-codex',
        profileId: 'work',
      }),
    });
  });

  it('returns exact accepted verification from provider runtime hot-apply proof', async () => {
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply: async () => ({
        applied: true,
        verification: {
          activeAccountId: 'acct_work',
          proofStrength: 'exact',
          source: 'applied_credential',
        },
      }),
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      ok: true,
      verificationByServiceId: {
        'happier.agent.codex/openai-codex': {
          status: 'verified',
          activeAccountId: 'acct_work',
          proofStrength: 'exact',
          source: 'applied_credential',
        },
      },
    });
  });

  it('preserves the complete provider-remeasured generation application proof', async () => {
    const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply: async () => ({
        applied: true,
        verification: {
          status: 'verified',
          sharedAuthSurfaceId: 'group-1',
          proofStrength: 'exact',
          source: 'claude_native_credentials',
          credentialRevision,
          credentialFingerprint: 'fingerprint-1',
          generationApplication: {
            serviceId: 'happier.agent.claude/claude-subscription',
            groupId: 'group-1',
            profileId: 'profile-1',
            generation: 7,
            credentialRevision,
            credentialFingerprint: 'fingerprint-1',
          },
        },
      }),
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({ resolveRuntimeAuthAdapter: async () => adapter });

    await expect(apply({
      tracked: {
        startedBy: 'daemon', happySessionId: 'sess_1', pid: 123,
        spawnOptions: { directory: '/tmp/project', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' } },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'group', groupId: 'group-1', profileId: 'profile-1' },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      verificationByServiceId: {
        'happier.agent.claude/claude-subscription': {
          credentialRevision,
          credentialFingerprint: 'fingerprint-1',
          generationApplication: { generation: 7, credentialRevision, credentialFingerprint: 'fingerprint-1' },
        },
      },
    });
  });

  it('threads authoritative group currentness into the provider lock and reports supersession', async () => {
    const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
    const authoritativeCredentialRevision = 'csr_2123456789ABCDEFGHJKMNPQRS';
    const validateGroupMutationCurrentness = vi.fn(async () => ({
      current: false as const,
      reason: 'credential_revision_superseded',
      authoritativeTarget: {
        profileId: 'profile-current',
        generation: 8,
        credentialRevision: authoritativeCredentialRevision,
      },
    }));
    const hotApply = vi.fn(async (request: Parameters<ConnectedServiceProviderRuntimeAuthAdapter['hotApply']>[0]) => {
      const currentness = await request.validateCurrentBeforeMutation?.();
      return currentness?.current === false
        ? { applied: false, status: 'superseded_after_apply' as const, reason: currentness.reason }
        : { applied: true };
    });
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
      validateGroupMutationCurrentness,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon', happySessionId: 'sess_1', pid: 123,
        spawnOptions: { directory: '/tmp/project', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' } },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'group', groupId: 'group-1', profileId: 'profile-1' },
        },
      },
      runtimeAuthSelectionsByServiceId: new Map([['happier.agent.claude/claude-subscription', {
        serviceId: 'happier.agent.claude/claude-subscription',
        groupId: 'group-1',
        activeProfileId: 'profile-1',
        groupGeneration: 7,
        credentialRevision,
      }]]),
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'credential_revision_superseded',
      serviceId: 'happier.agent.claude/claude-subscription',
    });
    expect(validateGroupMutationCurrentness).toHaveBeenCalledWith({
      serviceId: 'happier.agent.claude/claude-subscription',
      groupId: 'group-1',
      profileId: 'profile-1',
      generation: 7,
      credentialRevision,
    });
    expect(hotApply).toHaveBeenCalledWith(expect.objectContaining({
      validateCurrentBeforeMutation: expect.any(Function),
    }));
  });

  it('does not accept exact hot-apply proof without identity material', async () => {
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply: async () => ({
        applied: true,
        verification: {
          proofStrength: 'exact',
          source: 'applied_credential',
        },
      }),
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({ ok: true });
  });

  it('returns failure when the provider runtime adapter rejects hot apply', async () => {
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply: async () => ({ applied: false, reason: 'not_ready' }),
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_failed',
      serviceId: 'happier.agent.codex/openai-codex',
      serviceResultsByServiceId: {
        'happier.agent.codex/openai-codex': { status: 'failed', errorCode: 'hot_apply_failed' },
      },
    });
  });

  it('returns restart-required when the provider can recover a hot-apply miss by restart', async () => {
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply: async () => ({
        applied: false,
        reason: 'transport_invalidation_failed',
        recovery: 'restart_resume',
      }),
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_restart_required',
      serviceId: 'happier.agent.codex/openai-codex',
      serviceResultsByServiceId: {
        'happier.agent.codex/openai-codex': { status: 'failed', errorCode: 'hot_apply_restart_required' },
      },
    });
  });

  it('returns restart-required when provider reports partial direct-live hot auth', async () => {
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply: async () => ({
        applied: false,
        appliedVia: 'direct_live_hot_auth',
        partialState: 'runtime_auth_partially_applied',
        activeAccountId: 'acct-work',
        reason: 'auth_store_persistence_failed_after_live_apply',
        recovery: 'restart_resume',
      }),
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_restart_required',
      serviceId: 'happier.agent.codex/openai-codex',
      serviceResultsByServiceId: {
        'happier.agent.codex/openai-codex': { status: 'failed', errorCode: 'hot_apply_restart_required' },
      },
    });
  });

  it('prefers materialized runtime auth selections when provided', async () => {
    const hotApply = vi.fn(async () => ({ applied: true }));
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });
    const selection = {
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'work',
      record: { profileId: 'work' },
      invalidateTransports: async () => undefined,
    };

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      runtimeAuthSelectionsByServiceId: new Map([['happier.agent.codex/openai-codex', selection]]),
    })).resolves.toEqual({ ok: true });

    expect(hotApply).toHaveBeenCalledWith({
      target: { agentId: 'codex' },
      selection: {
        serviceId: 'happier.agent.codex/openai-codex',
        profileId: 'work',
      },
    });
  });

  it('applies only requested connected service bindings when a switch scope is provided', async () => {
    const hotApply = vi.fn(async () => ({ applied: true }));
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
          'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'api' },
        },
      },
      serviceIds: new Set(['happier.agent.codex/openai-codex']),
    })).resolves.toEqual({ ok: true });

    expect(hotApply).toHaveBeenCalledOnce();
    expect(hotApply).toHaveBeenCalledWith(expect.objectContaining({
      selection: expect.objectContaining({ serviceId: 'happier.agent.codex/openai-codex' }),
    }));
  });

  it('reports per-service hot-apply progress when a later service fails', async () => {
    const hotApply = vi.fn(async (request: Parameters<ConnectedServiceProviderRuntimeAuthAdapter['hotApply']>[0]) => {
      const selection = request.selection && typeof request.selection === 'object' && !Array.isArray(request.selection)
        ? request.selection as Readonly<Record<string, unknown>>
        : {};
      return selection.serviceId === 'happier.agent.claude/claude-subscription'
        ? { applied: false, reason: 'not_ready' }
        : { applied: true };
    });
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });

    await expect(apply({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
          'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'api' },
        },
      },
      serviceIds: new Set(['happier.agent.codex/openai-codex', 'happier.agent.claude/claude-subscription']),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_failed',
      serviceId: 'happier.agent.claude/claude-subscription',
      serviceResultsByServiceId: {
        'happier.agent.codex/openai-codex': { status: 'applied' },
        'happier.agent.claude/claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
      },
    });

    expect(hotApply).toHaveBeenCalledTimes(2);
  });
});
