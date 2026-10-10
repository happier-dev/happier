import { describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { createCodexConnectedAccountNativeAuthCodec, createCodexConnectedServiceRuntimeAuthAdapter } from '../../../../../../packages/plugins/codex/src/agent/auth/services/runtime/control/runtimeAuthAdapter';

import type { ConnectedServiceProviderRuntimeAuthAdapter } from '../runtimeAuth/types';
import { createSessionConnectedServiceAuthHotApply } from './sessionConnectedServiceAuthHotApply';

describe('createSessionConnectedServiceAuthHotApply', () => {
  it('keeps pending X readable, invalidates only at auth effects, and preserves retained child custody', async () => {
    const serviceId = 'happier.agent.codex/openai-codex';
    const registry = new ConnectedServiceRuntimeRegistry();
    const previous = { v: 2 as const, bindingsByServiceId: {
      [serviceId]: { source: 'connected' as const, selection: 'profile' as const, profileId: 'old' },
    } };
    const next = { v: 2 as const, bindingsByServiceId: {
      [serviceId]: { source: 'connected' as const, selection: 'profile' as const, profileId: 'next' },
    } };
    registry.registerTarget({ pid: 123, sessionId: 'parent', agentId: 'codex', connectedServicesBindingsRaw: previous });
    // Registration adds a `bindings` convenience projection; stored Run custody
    // consists of the canonical target fields rather than that wrapper's identity.
    const { bindings: _registeredBindings, ...retainedChild } = registry.registerRunTarget({ runKey: 'retained-child', pid: 123,
      sessionId: 'parent', agentId: 'codex', connectedServicesBindingsRaw: previous });
    let admit!: () => void;
    let completeSdkEffect!: () => void;
    let completeFileEffect!: () => void;
    let enteredSdkEffect!: () => void;
    let enteredFileEffect!: () => void;
    const admission = new Promise<void>((resolve) => { admit = resolve; });
    const sdkEffect = new Promise<void>((resolve) => { completeSdkEffect = resolve; });
    const fileEffect = new Promise<void>((resolve) => { completeFileEffect = resolve; });
    const sdkEntered = new Promise<void>((resolve) => { enteredSdkEffect = resolve; });
    const fileEntered = new Promise<void>((resolve) => { enteredFileEffect = resolve; });
    let nativeFiles: Readonly<Record<string, Uint8Array>> = {};
    // Only the live SDK RPC, native filesystem, and Account-currentness IO are boundaries.
    const nativeHome = { readFiles: async () => nativeFiles, replaceFiles: async (files: Readonly<Record<string, Uint8Array>>) => {
      enteredFileEffect(); await fileEffect; nativeFiles = files;
    } };
    const applyConnectedServiceAuthGeneration = async () => {
      enteredSdkEffect(); await sdkEffect; return { ok: true };
    };
    const projected = projectAgentConnectedAccountLaunchCatalogEntry({
      pluginId: 'happier.agent.codex', agentId: 'codex', isCurrent: () => true,
      connectedAccountLaunch: {
        stateSharingDescriptor: {
          providerSupportStatus: 'supported', config: { supported: false, modes: [], entries: [] },
          state: { supported: false, modes: [], entries: [], symlinkUnavailableDegradePolicy: 'block_continuity' },
          authIsolation: { mode: 'materialized_home', secretEntries: ['auth.json'] },
        },
        continuity: { nativeAuthCodec: createCodexConnectedAccountNativeAuthCodec(),
          runtimeAuthAdapter: createCodexConnectedServiceRuntimeAuthAdapter() },
      },
    });
    const apply = createSessionConnectedServiceAuthHotApply({
      runtimeRegistry: registry,
      isSessionCurrent: async () => { await admission; return true; },
      resolveRuntimeAuthAdapter: async () => await projected.getConnectedServiceRuntimeAuthAdapter?.() ?? null,
    });
    const transition = apply({
      tracked: { startedBy: 'daemon', happySessionId: 'parent', pid: 123,
        spawnOptions: { directory: '/tmp/project', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } },
      normalizedBindings: next,
      runtimeAuthSelectionsByServiceId: new Map([[serviceId, {
        serviceId, profileId: 'next', nativeHome, applyConnectedServiceAuthGeneration,
        credential: buildConnectedServiceCredentialRecord({ now: 1, serviceId: 'openai-codex', profileId: 'next', kind: 'oauth',
          oauth: { accessToken: 'access-placeholder', refreshToken: 'refresh-placeholder', idToken: null,
            scope: null, tokenType: 'Bearer', providerAccountId: 'account-next', providerEmail: null } }),
      }]]),
    });
    const read = () => registry.readAppliedSessionBindings({ runnerPid: 123, sessionId: 'parent', agentId: 'codex' });
    try {
      expect(read()).toEqual({ status: 'applied', connectedServices: previous });
      admit(); await sdkEntered;
      expect(read()).toEqual({ status: 'unavailable' });
      expect(registry.getRunTargetByRunKey('retained-child')).toEqual(retainedChild);
      completeSdkEffect(); await fileEntered;
      expect(read()).toEqual({ status: 'unavailable' });
      completeFileEffect(); await expect(transition).resolves.toMatchObject({ ok: true });
      expect(read()).toEqual({ status: 'unavailable' });
      // Only the existing authoritative success registration restores applied proof.
      registry.registerTarget({ pid: 123, sessionId: 'parent', agentId: 'codex', connectedServicesBindingsRaw: next });
      expect(read()).toEqual({ status: 'applied', connectedServices: next });
      expect(registry.getRunTargetByRunKey('retained-child')).toEqual(retainedChild);
    } finally {
      admit(); completeSdkEffect(); completeFileEffect(); await transition;
    }
  });
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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

    expect(hotApply).toHaveBeenCalledWith(expect.objectContaining({
      target: { agentId: 'codex' },
      selection: expect.objectContaining({
        serviceId: 'happier.agent.codex/openai-codex',
        profileId: 'work',
      }),
    }));
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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
    const apply = createSessionConnectedServiceAuthHotApply({ runtimeRegistry: new ConnectedServiceRuntimeRegistry(), resolveRuntimeAuthAdapter: async () => adapter });

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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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

    expect(hotApply).toHaveBeenCalledWith(expect.objectContaining({
      target: { agentId: 'codex' },
      selection: {
        serviceId: 'happier.agent.codex/openai-codex',
        profileId: 'work',
      },
    }));
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
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
