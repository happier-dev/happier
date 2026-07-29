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
      recoverAfterRuntimeAuthSwitch: async () => ({ status: 'resumed' }),
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
          codexBackendMode: 'appServer',
        },
      },
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(resolveRuntimeAuthAdapter).toHaveBeenCalledWith('codex');
    expect(hotApply).toHaveBeenCalledOnce();
  });

  it('invokes the provider runtime auth adapter for connected bindings', async () => {
    const hotApply = vi.fn(async () => ({ applied: true }));
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ status: 'resumed' }));
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      recoverAfterRuntimeAuthSwitch,
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
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(hotApply).toHaveBeenCalledWith({
      target: { agentId: 'codex' },
      selection: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        binding: { source: 'connected', selection: 'profile', profileId: 'work' },
      }),
    });
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
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
      recoverAfterRuntimeAuthSwitch: async () => ({ status: 'resumed' }),
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
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      ok: true,
      verificationByServiceId: {
        'openai-codex': {
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
            serviceId: 'claude-subscription',
            groupId: 'group-1',
            profileId: 'profile-1',
            generation: 7,
            credentialRevision,
            credentialFingerprint: 'fingerprint-1',
          },
        },
      }),
      recoverAfterRuntimeAuthSwitch: async () => ({ status: 'resumed' }),
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
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'group-1', profileId: 'profile-1' },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      verificationByServiceId: {
        'claude-subscription': {
          credentialRevision,
          credentialFingerprint: 'fingerprint-1',
          generationApplication: { generation: 7, credentialRevision, credentialFingerprint: 'fingerprint-1' },
        },
      },
    });
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
      recoverAfterRuntimeAuthSwitch: async () => ({ status: 'resumed' }),
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
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
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
      recoverAfterRuntimeAuthSwitch: async () => ({ status: 'resumed' }),
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
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_failed',
      serviceId: 'openai-codex',
      serviceResultsByServiceId: {
        'openai-codex': { status: 'failed', errorCode: 'hot_apply_failed' },
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
      recoverAfterRuntimeAuthSwitch: async () => ({ status: 'resumed' }),
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
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_restart_required',
      serviceId: 'openai-codex',
      serviceResultsByServiceId: {
        'openai-codex': { status: 'failed', errorCode: 'hot_apply_restart_required' },
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
      recoverAfterRuntimeAuthSwitch: async () => ({ status: 'resumed' }),
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
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_restart_required',
      serviceId: 'openai-codex',
      serviceResultsByServiceId: {
        'openai-codex': { status: 'failed', errorCode: 'hot_apply_restart_required' },
      },
    });
  });

  it('prefers materialized runtime auth selections when provided', async () => {
    const hotApply = vi.fn(async () => ({ applied: true }));
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ status: 'resumed' }));
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      recoverAfterRuntimeAuthSwitch,
      probeQuota: async () => ({}),
      refreshActiveProfile: async () => ({}),
    } satisfies ConnectedServiceProviderRuntimeAuthAdapter;
    const apply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => adapter,
    });
    const selection = {
      serviceId: 'openai-codex',
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
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      runtimeAuthSelectionsByServiceId: new Map([['openai-codex', selection]]),
    })).resolves.toEqual({ ok: true });

    expect(hotApply).toHaveBeenCalledWith({
      target: { agentId: 'codex' },
      selection,
    });
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('applies only requested connected service bindings when a switch scope is provided', async () => {
    const hotApply = vi.fn(async () => ({ applied: true }));
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ status: 'resumed' }));
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      recoverAfterRuntimeAuthSwitch,
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
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
          openai: { source: 'connected', selection: 'profile', profileId: 'api' },
        },
      },
      serviceIds: new Set(['openai-codex']),
    })).resolves.toEqual({ ok: true });

    expect(hotApply).toHaveBeenCalledOnce();
    expect(hotApply).toHaveBeenCalledWith(expect.objectContaining({
      selection: expect.objectContaining({ serviceId: 'openai-codex' }),
    }));
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('reports per-service hot-apply progress when a later service fails', async () => {
    const hotApply = vi.fn(async (request: Parameters<ConnectedServiceProviderRuntimeAuthAdapter['hotApply']>[0]) => {
      const selection = request.selection && typeof request.selection === 'object' && !Array.isArray(request.selection)
        ? request.selection as Readonly<Record<string, unknown>>
        : {};
      return selection.serviceId === 'openai'
        ? { applied: false, reason: 'not_ready' }
        : { applied: true };
    });
    const adapter = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({}),
      canHotApply: () => ({ supported: true }),
      hotApply,
      recoverAfterRuntimeAuthSwitch: async () => ({ status: 'resumed' }),
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
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
          openai: { source: 'connected', selection: 'profile', profileId: 'api' },
        },
      },
      serviceIds: new Set(['openai-codex', 'openai']),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_failed',
      serviceId: 'openai',
      serviceResultsByServiceId: {
        'openai-codex': { status: 'applied' },
        openai: { status: 'failed', errorCode: 'hot_apply_failed' },
      },
    });

    expect(hotApply).toHaveBeenCalledTimes(2);
  });
});
