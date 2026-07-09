import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  buildConnectedServiceCredentialRecord,
  ConnectedServiceMaterializationIdentityV1Schema,
  ConnectedServiceAuthGroupPolicyV1Schema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import type { HostRuntimeControlServiceV1 } from '@happier-dev/agents';
import { CODEX_PROVIDER_RUNTIME_CONTRIBUTION } from '@happier-dev/plugins-codex/agent/contributions/runtime';

import type { TrackedSession } from '@/daemon/types';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { createSessionConnectedServiceAuthHotApply } from './sessionConnectedServiceAuthHotApply';
import { createSessionContinuationRecoveryController } from '../continuation/sessionContinuationRecovery';
import { ConnectedServiceSessionAuthSwitchLockRegistry, createConnectedServiceSessionAuthSwitchCore } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import {
  switchSessionConnectedServiceAuth,
  type SwitchSessionConnectedServiceAuthInput,
} from './switchSessionConnectedServiceAuth';

type RuntimeAuthSelectionContinuityInput = Parameters<SwitchSessionConnectedServiceAuthInput['resolveContinuity']>[0];
type RecoverAfterRuntimeAuthSwitch = (input: Readonly<{
  tracked: TrackedSession;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<string>;
  action: 'hot_applied' | 'restart_requested';
  runtimeAuthSelectionsByServiceId?: ReadonlyMap<string, unknown>;
}>) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode?: string }>>;
type VerifyProviderAccountAdoption = (input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  agentId: string;
  serviceId: string;
  target: Readonly<{
    serviceId: string;
    profileId: string | null;
    groupId?: string | null;
  }>;
  normalizedBindings: ConnectedServiceBindingsV1;
  action: 'hot_applied' | 'restart_requested';
  runtimeAuthSelection?: unknown;
}>) => Promise<
  | Readonly<{ status: 'verified'; providerAccountId?: string | null; reason?: string }>
  | Readonly<{ status: 'weakly_verified'; providerAccountId?: string | null; reason: string }>
  | Readonly<{
      status: 'mismatch';
      expectedProviderAccountId?: string | null;
      actualProviderAccountId?: string | null;
      retryable: boolean;
      reason?: string;
    }>
  | Readonly<{ status: 'unavailable'; retryable: boolean; reason: string; errorClassification?: unknown }>
>;
type SwitchInputWithPostSwitchRecovery = SwitchSessionConnectedServiceAuthInput & Readonly<{
  recoverAfterRuntimeAuthSwitch?: RecoverAfterRuntimeAuthSwitch;
}>;
type SwitchInputWithVerification = SwitchInputWithPostSwitchRecovery & Readonly<{
  verifyProviderAccountAdoption?: VerifyProviderAccountAdoption;
}>;

const TEST_CODEX_RUNTIME_CONTROL: HostRuntimeControlServiceV1 = {
  context: { agentId: 'codex' },
  appServer: {
    checkAvailable: async () => ({ ok: false, code: 'app_server_control_unavailable', error: 'unavailable' }),
    request: async () => ({ ok: false, code: 'app_server_control_unavailable', error: 'unavailable' }),
  },
  session: {
    checkConnectedServiceAuthTransportInvalidation: async () => ({ ok: false, code: 'session_transport_unavailable', error: 'unavailable' }),
    invalidateConnectedServiceAuthTransports: async () => ({ ok: false, code: 'session_transport_unavailable', error: 'unavailable' }),
  },
  connectedServices: {
    refreshRuntimeAuth: async () => ({ ok: false, code: 'connected_service_refresh_unavailable', error: 'unavailable' }),
  },
  reachability: {
    verifyMaterializedState: async () => ({ ok: false, code: 'resume_reachability_unavailable', error: 'unavailable' }),
  },
};

function getCodexRuntimeControlHooks() {
  const hooks = CODEX_PROVIDER_RUNTIME_CONTRIBUTION.runtimeControl?.connectedServices;
  if (!hooks?.createRuntimeAuthAdapter || !hooks.resolveSwitchContinuity) {
    throw new Error('Codex runtime-control connected-service hooks are unavailable');
  }
  return hooks;
}

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: 'sess_1',
    pid: 123,
    spawnOptions: {
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', selection: 'profile', profileId: 'old-profile' },
        },
      },
    },
    ...overrides,
  };
}

function createContinuationStore() {
  const stored = new Map<string, unknown>();
  return {
    read: (sessionId: string) => stored.get(sessionId) ?? null,
    write: (sessionId: string, state: unknown) => {
      stored.set(sessionId, state);
    },
    stored,
  };
}

function group(overrides: Partial<ConnectedServiceAuthGroupV1> = {}): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'anthropic',
    groupId: 'work',
    displayName: 'Work',
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true }),
    activeProfileId: 'group-active',
    generation: 4,
    state: { v: 1 },
    members: [
      {
        v: 1,
        serviceId: 'anthropic',
        groupId: 'work',
        profileId: 'group-active',
        priority: 100,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function bindings(profileId: string): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      anthropic: { source: 'connected', selection: 'profile', profileId },
    },
  };
}

function codexBindings(profileId: string): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      'openai-codex': { source: 'connected', selection: 'profile', profileId },
    },
  };
}

function claudeSubscriptionBindings(profileId: string): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      'claude-subscription': { source: 'connected', selection: 'profile', profileId },
    },
  };
}

function multiServiceBindings(input: Readonly<{
  anthropicProfileId: string;
  claudeSubscriptionProfileId: string;
}>): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      anthropic: { source: 'connected', selection: 'profile', profileId: input.anthropicProfileId },
      'claude-subscription': {
        source: 'connected',
        selection: 'profile',
        profileId: input.claudeSubscriptionProfileId,
      },
    },
  };
}

function createCore() {
  return createConnectedServiceSessionAuthSwitchCore({
    locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
  });
}

function testOnlyPostSwitchVerificationBypass() {
  return {
    kind: 'disabled_for_test_only' as const,
    reason: 'existing switch fixture does not exercise provider adoption verification',
  };
}

function expectMaterializationIdentity(value: unknown): ConnectedServiceMaterializationIdentityV1 {
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(value);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error('Expected connected-service materialization identity');
  }
  return parsed.data;
}

describe('switchSessionConnectedServiceAuth', () => {
  it('rejects a missing session without mutating or restarting', async () => {
    const restartSession = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [],
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'anthropic', profiles: [] }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_missing',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_not_found',
      diagnostics: {
        failurePhase: 'session_lookup',
      },
    });

    expect(restartSession).not.toHaveBeenCalled();
  });

  it('updates inactive session bindings without requesting a restart', async () => {
    const restartSession = vi.fn();
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();
    const resolveContinuity = vi.fn(async () => ({ mode: 'restart_rematerialize' as const }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: bindings('old-profile'),
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity,
      restartSession,
      hotApply: async () => {
        throw new Error('Inactive sessions should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_inactive',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'metadata_updated',
      normalizedBindings: bindings('new-profile'),
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });

    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      tracked: null,
      serviceId: 'anthropic',
    }));
    expect(restartSession).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_inactive', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'old-profile',
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
  });

  it('emits the resolved auth-group label on canonical account switch events', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'group-active', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({ displayName: 'Work Pool' }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: vi.fn(async () => {}),
      persistSessionBindings: vi.fn(async () => {}),
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'old-profile',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      groupId: 'work',
      groupLabel: 'Work Pool',
      fromProfileId: 'old-profile',
      toProfileId: 'group-active',
      reason: 'manual',
    }));
  });

  it('does not emit account switch events when the binding changes but the effective profile stays the same', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: bindings('old-profile'),
      },
    });
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'old-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'old-profile',
          generation: 9,
          members: [
            {
              v: 1,
              serviceId: 'anthropic',
              groupId: 'work',
              profileId: 'old-profile',
              priority: 100,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: vi.fn(async () => {}),
      persistSessionBindings: vi.fn(async () => {}),
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'old-profile',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(emitSessionEvent).not.toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
    }));
  });

  it('suppresses duplicate final account switch events for coordinator-owned automatic group applies', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      reason: 'pre_turn_group_policy',
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'group-active', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({ displayName: 'Work Pool' }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: vi.fn(async () => {}),
      persistSessionBindings: vi.fn(async () => {}),
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'old-profile',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(emitSessionEvent).not.toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      reason: 'pre_turn_group_policy',
    }));
  });

  it('forwards the inactive session cwd and persisted session-file hint to the continuity check (F2)', async () => {
    // For an INACTIVE switch the daemon adapter cannot read cwd/target-root from a tracked session.
    // The switch must forward the inactive session's working directory and persisted session-file hint
    // so the adapter can prove shared-state resume reachability instead of fail-closing a resumable session.
    const resolveContinuity = vi.fn(async () => ({ mode: 'restart_rematerialize' as const }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: bindings('old-profile'),
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/inactive-project',
        candidatePersistedSessionFile: '/tmp/inactive-project/.pi/session-1.jsonl',
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity,
      restartSession: vi.fn(),
      hotApply: async () => {
        throw new Error('Inactive sessions should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      persistSessionBindings: vi.fn(),
      request: {
        sessionId: 'sess_inactive',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({ ok: true, action: 'metadata_updated' });

    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      tracked: null,
      serviceId: 'anthropic',
      cwd: '/tmp/inactive-project',
      candidatePersistedSessionFile: '/tmp/inactive-project/.pi/session-1.jsonl',
      vendorResumeId: 'pi-session-1',
    }));
  });

  it('validates a profile, updates tracked spawn options, restarts, and emits one manual switch event', async () => {
    const tracked = trackedSession();
    const calls: string[] = [];
    const persistSessionBindings = vi.fn(async () => {
      calls.push('persist');
      expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    });
    const restartSession = vi.fn(async () => {
      calls.push('restart');
      expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    });
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      persistSessionBindings,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('new-profile'),
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(calls).toEqual(['persist', 'restart']);
    expect(emitSessionEvent).toHaveBeenCalledTimes(1);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'old-profile',
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
  });

  it('allows retryable-refresh profiles during manual auth switch validation', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'refresh_failed_retryable' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      persistSessionBindings: vi.fn(),
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('new-profile'),
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
  });

  it('uses webhook metadata bindings as the previous binding when tracked spawn options no longer carry them', async () => {
    const previousBindings = bindings('old-profile');
    const nextBindings = bindings('new-profile');
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp/project',
        host: 'test-host',
        homeDir: '/tmp/home',
        happyHomeDir: '/tmp/home/.happier',
        happyLibDir: '/tmp/home/.happier/lib',
        happyToolsDir: '/tmp/home/.happier/tools',
        flavor: 'claude',
        connectedServices: previousBindings,
      },
    });
    const resolveContinuity = vi.fn(async ({ previous, next, previousBindings: resolvedPreviousBindings }) => {
      expect(previous).toEqual(expect.objectContaining({
        serviceId: 'anthropic',
        profileId: 'old-profile',
      }));
      expect(next).toEqual(expect.objectContaining({
        serviceId: 'anthropic',
        profileId: 'new-profile',
      }));
      expect(resolvedPreviousBindings).toEqual(previousBindings);
      return { mode: 'restart_rematerialize' as const };
    });
    const restartSession = vi.fn(async () => {});
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity,
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      persistSessionBindings: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: nextBindings,
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: nextBindings,
    });

    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'old-profile',
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
  });

  it('passes webhook metadata bindings into unchanged rematerialization when spawn options no longer carry them', async () => {
    const previousBindings = bindings('old-profile');
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      happySessionMetadataFromLocalWebhook: {
        path: '/tmp/project',
        host: 'test-host',
        homeDir: '/tmp/home',
        happyHomeDir: '/tmp/home/.happier',
        happyLibDir: '/tmp/home/.happier/lib',
        happyToolsDir: '/tmp/home/.happier/tools',
        flavor: 'claude',
        connectedServices: previousBindings,
      },
    });
    const materializeRuntimeAuthSelection = vi.fn(async ({ previous, next, previousBindings: resolvedPreviousBindings }) => {
      expect(previous).toEqual(expect.objectContaining({
        serviceId: 'anthropic',
        profileId: 'old-profile',
      }));
      expect(next).toEqual(expect.objectContaining({
        serviceId: 'anthropic',
        profileId: 'old-profile',
      }));
      expect(resolvedPreviousBindings).toEqual(previousBindings);
      return { kind: 'materialized' };
    });
    const resolveContinuity = vi.fn(async ({ previous, next, previousBindings: resolvedPreviousBindings }) => {
      expect(previous).toEqual(expect.objectContaining({
        serviceId: 'anthropic',
        profileId: 'old-profile',
      }));
      expect(next).toEqual(expect.objectContaining({
        serviceId: 'anthropic',
        profileId: 'old-profile',
      }));
      expect(resolvedPreviousBindings).toEqual(previousBindings);
      return { mode: 'hot_apply' as const };
    });
    const hotApply = vi.fn(async () => ({ ok: true as const }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'old-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      materializeRuntimeAuthSelection,
      resolveContinuity,
      restartSession: vi.fn(),
      hotApply,
      recoverAfterRuntimeAuthSwitch: vi.fn(async () => ({ ok: true })),
      continueAfterRuntimeAuthSwitch: vi.fn(async () => {}),
      verifyProviderAccountAdoption: vi.fn(async () => ({
        status: 'verified' as const,
        reason: 'test_verified',
      })),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: previousBindings,
        rematerializeServiceId: 'anthropic',
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      normalizedBindings: previousBindings,
      continuityByServiceId: { anthropic: 'hot_apply' },
    });

    expect(materializeRuntimeAuthSelection).toHaveBeenCalledOnce();
    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(hotApply).toHaveBeenCalledOnce();
  });

  it.each([
    ['manual', 'manual_auth_switch'],
    ['pre_turn_group_policy', 'usage_limit_recovery'],
    ['automatic_runtime_failure', 'runtime_auth_recovery'],
  ] as const)(
    'fails closed on blocking runtime materialization diagnostics for %s switches',
    async (switchReason, expectedSource) => {
      const previousBindings = claudeSubscriptionBindings('old-subscription');
      const nextBindings = claudeSubscriptionBindings('new-subscription');
      const tracked = trackedSession({
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          connectedServices: previousBindings,
          environmentVariables: { EXISTING: '1' },
        },
      });
      const persistSessionBindings = vi.fn();
      const restartSession = vi.fn();
      const hotApply = vi.fn(async () => ({ ok: true as const }));
      const resolveContinuity = vi.fn(async () => ({ mode: 'restart_rematerialize' as const }));
      const emitSessionEvent = vi.fn();

      const result = await switchSessionConnectedServiceAuth({
        core: createCore(),
        reason: switchReason,
        postSwitchVerificationMode: {
          kind: 'disabled_for_test_only',
          reason: 'materialization diagnostics stop before provider adoption verification',
        },
        getChildren: () => [tracked],
        api: {
          listConnectedServiceProfiles: async () => ({
            serviceId: 'claude-subscription',
            profiles: [{ profileId: 'new-subscription', status: 'connected' }],
          }),
          getConnectedServiceAuthGroup: async () => null,
        },
        materializeRuntimeAuthSelection: async () => ({
          record: buildConnectedServiceCredentialRecord({
            now: 1,
            serviceId: 'claude-subscription',
            profileId: 'new-subscription',
            kind: 'oauth',
            oauth: {
              accessToken: 'redacted-access-token',
              refreshToken: 'redacted-refresh-token',
              idToken: null,
              scope: null,
              tokenType: 'Bearer',
              providerAccountId: null,
              providerEmail: null,
            },
          }),
          targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/should-not-be-applied' },
          targetMaterializedRoot: '/tmp/should-not-be-applied',
          materializationDiagnostics: [{
            code: 'claude_subscription_missing_claude_code_scope',
            providerId: 'claude',
            serviceId: 'claude-subscription',
            severity: 'blocking',
            reason: 'missing_claude_code_scope',
          }],
        }),
        resolveContinuity,
        restartSession,
        hotApply,
        persistSessionBindings,
        registerHotApplyTargets: vi.fn(),
        emitSessionEvent,
        request: {
          sessionId: 'sess_1',
          agentId: 'claude',
          bindings: nextBindings,
        },
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'post_switch_verification_failed',
        serviceId: 'claude-subscription',
        diagnostics: {
          failurePhase: 'materialization',
          uxDiagnostic: expect.objectContaining({
            code: 'claude_subscription_missing_claude_code_scope',
            failurePhase: 'materialization',
            source: expectedSource,
            serviceId: 'claude-subscription',
            providerId: 'claude',
            retryable: false,
          }),
        },
      });

      expect(tracked.spawnOptions?.connectedServices).toEqual(previousBindings);
      expect(tracked.spawnOptions?.environmentVariables).toEqual({ EXISTING: '1' });
      expect(resolveContinuity).not.toHaveBeenCalled();
      expect(persistSessionBindings).not.toHaveBeenCalled();
      expect(restartSession).not.toHaveBeenCalled();
      expect(hotApply).not.toHaveBeenCalled();
      expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
        type: 'connected_service_account_switch_attempt',
        ok: false,
        action: 'restart_requested',
        errorCode: 'post_switch_verification_failed',
        diagnostic: expect.objectContaining({
          code: 'claude_subscription_missing_claude_code_scope',
          source: expectedSource,
        }),
      }));
    },
  );

  it('generates a materialization identity before restarting an active native session into connected auth', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        resume: 'spawn-resume-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'native' },
            'claude-subscription': { source: 'native' },
          },
        },
      },
    });
    const persistSessionBindings = vi.fn();
    const restartSession = vi.fn(async () => {
      expect(tracked.spawnOptions?.connectedServices).toEqual(multiServiceBindings({
        anthropicProfileId: 'anthropic-new',
        claudeSubscriptionProfileId: 'subscription-new',
      }));
      expectMaterializationIdentity(
        (tracked.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown } | undefined)
          ?.connectedServiceMaterializationIdentityV1,
      );
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async ({ serviceId }) => ({
          serviceId,
          profiles: [
            {
              profileId: serviceId === 'anthropic' ? 'anthropic-new' : 'subscription-new',
              status: 'connected',
            },
          ],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ connectedServiceMaterializationIdentityV1, vendorResumeId }) => {
        expectMaterializationIdentity(connectedServiceMaterializationIdentityV1);
        expect(vendorResumeId).toBe('spawn-resume-1');
        return { mode: 'restart_rematerialize' };
      },
      restartSession,
      persistSessionBindings,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: multiServiceBindings({
          anthropicProfileId: 'anthropic-new',
          claudeSubscriptionProfileId: 'subscription-new',
        }),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: multiServiceBindings({
        anthropicProfileId: 'anthropic-new',
        claudeSubscriptionProfileId: 'subscription-new',
      }),
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
        'claude-subscription': 'restart_rematerialize',
      },
    });

    expect(persistSessionBindings).toHaveBeenCalledOnce();
    const persistedIdentity = expectMaterializationIdentity(
      persistSessionBindings.mock.calls[0]?.[0]?.connectedServiceMaterializationIdentityV1,
    );
    expect((tracked.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown } | undefined)
      ?.connectedServiceMaterializationIdentityV1).toEqual(persistedIdentity);
    expect(restartSession).toHaveBeenCalledWith(tracked);
  });

  it('does not restart when persisting accepted bindings fails', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      persistSessionBindings: async () => {
        throw new Error('metadata write failed');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'metadata_update_failed',
      diagnostics: {
        failurePhase: 'metadata',
      },
    });

    expect(restartSession).not.toHaveBeenCalled();
    expect(emitSessionEvent).not.toHaveBeenCalled();
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('returns restart failure diagnostics when a switch cannot restart the active session', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rollback metadata write failed'));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {
        throw new Error('restart failed');
      },
      persistSessionBindings,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'partial_applied_pending_reconciliation',
      diagnostics: {
        failurePhase: 'reconciliation',
        application: {
          status: 'partial_applied_pending_reconciliation',
          phase: 'restart',
          actor: 'user',
          reason: 'manual',
        },
        rollback: {
          status: 'bindings_rollback_failed',
          pendingReconciliation: true,
        },
      },
    });

    expect(persistSessionBindings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('old-profile'),
    }));
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('marks stale-process restart signal failures as retryable diagnostics', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();
    const staleProcessError = new Error('kill ESRCH');
    Object.assign(staleProcessError, { code: 'ESRCH' });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {
        throw staleProcessError;
      },
      persistSessionBindings,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'restart_failed',
      diagnostics: {
        failurePhase: 'restart',
        retryable: true,
        underlyingError: expect.stringContaining('ESRCH'),
        application: {
          status: 'restart_failed',
          phase: 'restart',
        },
      },
    });
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      action: 'restart_requested',
      attemptedContinuityMode: 'restart',
      outcome: 'failed',
      outcomeAction: 'none',
      errorCode: 'restart_failed',
      partialState: null,
    }));
  });

  it.each([
    { continuityMode: 'restart_rematerialize' as const, expectedAction: 'restart_requested' as const },
    { continuityMode: 'hot_apply' as const, expectedAction: 'hot_applied' as const },
  ])('does not continue interrupted work for pre-turn group policy switches (%s)', async ({ continuityMode, expectedAction }) => {
    const tracked = trackedSession();
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {
      throw new Error('pre-turn policy switches must not enqueue continuation recovery');
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      reason: 'pre_turn_group_policy',
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: continuityMode }),
      restartSession: vi.fn(async () => {}),
      hotApply: async () => ({ ok: true as const }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: () => {},
      recoverAfterRuntimeAuthSwitch: async () => ({ ok: true }),
      continueAfterRuntimeAuthSwitch,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: expectedAction,
    });

    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('treats an omitted previously connected service as a native switch', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {
      expect(tracked.spawnOptions?.connectedServices).toEqual({
        v: 1,
        bindingsByServiceId: {},
      });
    });
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ next }) => {
        expect(next).toMatchObject({
          source: 'native',
          selection: 'native',
          serviceId: 'anthropic',
        });
        return { mode: 'restart_rematerialize' };
      },
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {},
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {},
      },
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'old-profile',
      toProfileId: null,
      reason: 'manual',
    }));
  });

  it('rejects connected-service bindings unsupported by the target agent before profile lookup', async () => {
    const tracked = trackedSession();
    const listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'openai-codex' as const,
      profiles: [{ profileId: 'codex-profile', status: 'connected' as const }],
    }));
    const resolveContinuity = vi.fn(async () => ({ mode: 'restart_rematerialize' as const }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles,
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity,
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-profile',
            },
          },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_service',
      serviceId: 'openai-codex',
    });

    expect(listConnectedServiceProfiles).not.toHaveBeenCalled();
    expect(resolveContinuity).not.toHaveBeenCalled();
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('returns reconnect action-required when manually switching to a reconnect-required profile', async () => {
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'needs_reauth' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'profile_action_required',
      serviceId: 'anthropic',
      diagnostics: {
        failurePhase: 'normalization',
        actionRequired: {
          kind: 'reconnect_profile',
          profileId: 'new-profile',
          healthStatus: 'needs_reauth',
        },
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('resolves group active profile under the lock and rejects stale expected generations before mutation', async () => {
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'anthropic', profiles: [] }),
        getConnectedServiceAuthGroup: async () => group({ generation: 5 }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {},
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 4 },
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'stale-ui-profile',
            },
          },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'group_generation_conflict',
      serviceId: 'anthropic',
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('writes authoritative group metadata into child-selection env when switching into a group', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: bindings('old-profile'),
      },
    });
    const restartSession = vi.fn(async () => {
      expect(tracked.spawnOptions?.environmentVariables).toEqual({
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'anthropic',
            groupId: 'work',
            activeProfileId: 'group-active',
            fallbackProfileId: 'fallback-profile',
            generation: 9,
          },
        ]),
      });
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [
            { profileId: 'group-active', status: 'connected' },
            { profileId: 'fallback-profile', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'group-active',
          generation: 9,
          members: [
            {
              v: 1,
              serviceId: 'anthropic',
              groupId: 'work',
              profileId: 'group-active',
              priority: 100,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
            {
              v: 1,
              serviceId: 'anthropic',
              groupId: 'work',
              profileId: 'fallback-profile',
              priority: 90,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'fallback-profile',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
  });

  it('does not mutate when provider continuity is unsupported', async () => {
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({
        mode: 'unsupported',
        errorCode: 'provider_state_sharing_required',
      }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'provider_state_sharing_required',
      serviceId: 'anthropic',
      diagnostics: {
        failurePhase: 'continuity',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('keeps continuity diagnostics path-safe in public auth-switch results', async () => {
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          materializationIdentityId: 'csm_pi_shared',
          targetMaterializedRoot: '/tmp/happier/materialized/csm_pi_shared/pi',
          vendorResumeId: 'pi-session-1',
          cwd: '/tmp/project',
          candidatePersistedSessionFile: '/tmp/native/pi-session-1.jsonl',
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'provider_session_state_unavailable_for_resume',
      serviceId: 'anthropic',
      diagnostics: {
	        failurePhase: 'continuity',
	        continuity: {
	          requestedStateMode: 'shared',
	          effectiveStateMode: 'shared',
	          reachabilityMissReason: 'pi_session_file_not_found',
	        },
        uxDiagnostic: {
          code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
          failurePhase: 'continuity',
          source: 'manual_auth_switch',
          retryable: false,
          diagnostics: {
            reason: 'pi_session_file_not_found',
          },
        },
      },
    });

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          materializationIdentityId: 'csm_pi_shared',
          targetMaterializedRoot: '/tmp/happier/materialized/csm_pi_shared/pi',
          vendorResumeId: 'pi-session-1',
          cwd: '/tmp/project',
          candidatePersistedSessionFile: '/tmp/native/pi-session-1.jsonl',
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      }),
      restartSession: async () => {},
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    });
	    expect(result.ok).toBe(false);
	    if (result.ok) throw new Error('expected failure');
	    const diagnostics = JSON.stringify(result.diagnostics ?? {});
	    expect(diagnostics).not.toContain('/tmp/');
	    expect(diagnostics).not.toContain('pi-session-1');
	    expect(diagnostics).not.toContain('csm_pi_shared');
	  });

  it('uses runtime-auth recovery as the diagnostic source for automatic continuity failures', async () => {
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
      }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      reason: 'automatic_runtime_failure',
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'provider_session_state_unavailable_for_resume',
      diagnostics: {
        uxDiagnostic: {
          source: 'runtime_auth_recovery',
        },
      },
    });
  });

  it('sanitizes hot-apply failure messages before returning switch diagnostics', async () => {
    const tracked = trackedSession();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({
        ok: false,
        errorCode: 'provider_rejected',
        serviceResultsByServiceId: {
          anthropic: { status: 'failed', errorCode: 'provider_rejected' },
        },
        underlyingError: 'provider refused Bearer raw-secret-token accessToken=raw-access-token',
      }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'hot_apply_failed',
      diagnostics: {
        underlyingError: expect.stringContaining('[REDACTED]'),
      },
    });
    expect(JSON.stringify(result)).not.toContain('raw-secret-token');
    expect(JSON.stringify(result)).not.toContain('raw-access-token');
  });

  it('re-registers quota and refresh targets after hot apply without restart', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const registerHotApplyTargets = vi.fn();
    const calls: string[] = [];
    const hotApply = vi.fn(async () => {
      calls.push('hotApply');
      return { ok: true as const };
    });
    const persistSessionBindings = vi.fn(async () => {
      calls.push('persist');
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      persistSessionBindings,
      hotApply,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
    });

    expect(restartSession).not.toHaveBeenCalled();
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(calls).toEqual(['persist', 'hotApply']);
    expect(registerHotApplyTargets).toHaveBeenCalledWith(tracked);
  });

  it('does not hot-apply live runtime auth when metadata persistence fails', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const registerHotApplyTargets = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply,
      persistSessionBindings: async () => {
        throw new Error('metadata unavailable');
      },
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'metadata_update_failed',
      diagnostics: {
        failurePhase: 'metadata',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(hotApply).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('restores the previous tracked bindings when hot apply fails', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rollback metadata write failed'));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => ({ ok: false, errorCode: 'provider_rejected' }),
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'partial_applied_pending_reconciliation',
      diagnostics: {
        failurePhase: 'reconciliation',
        application: {
          status: 'partial_applied_pending_reconciliation',
          phase: 'hot_apply',
          actor: 'user',
          reason: 'manual',
        },
        rollback: {
          status: 'bindings_rollback_failed',
          pendingReconciliation: true,
        },
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('old-profile'),
    }));
    expect(restartSession).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('returns typed recovery failure when hot apply succeeds but post-switch recovery fails', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi.fn(async () => {});
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async () => ({
      ok: false,
      errorCode: 'provider_rejected_recovery',
    }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

    const input: SwitchInputWithPostSwitchRecovery = {
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    };

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_succeeded_but_recovery_failed',
      diagnostics: {
        failurePhase: 'recover',
        application: {
          status: 'hot_apply_succeeded_but_recovery_failed',
          phase: 'recover',
          actor: 'user',
          reason: 'manual',
        },
      },
    });

    expect(persistSessionBindings).toHaveBeenCalledOnce();
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(recoverAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceIds: new Set(['anthropic']),
    }));
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).toHaveBeenCalledWith(tracked);
  });

  it('falls back to restart when hot-apply verification still sees the old provider account (cmptxauhy0k2ptmqe6o4l8i48)', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const emitSessionEvent = vi.fn();
    const restartSession = vi.fn(async () => {});
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async () => ({ ok: true }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async () => ({
      status: 'mismatch',
      expectedProviderAccountId: 'acct_bot',
      actualProviderAccountId: 'acct_codex3',
      retryable: true,
      reason: 'provider_account_adoption_mismatch authorization=Bearer raw-secret-token',
    }));

    const input: SwitchInputWithVerification = {
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    };

    const result = await switchSessionConnectedServiceAuth(input);
    expect(result).toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });
    expect(JSON.stringify(result)).not.toContain('raw-secret-token');

    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).toHaveBeenNthCalledWith(1, expect.objectContaining({
      serviceId: 'openai-codex',
      target: expect.objectContaining({ profileId: 'bot' }),
      action: 'hot_applied',
    }));
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'openai-codex',
      toProfileId: 'bot',
      mode: 'restart_resume',
    }));
  });

  it('falls back to restart when hot-apply verification cannot read the active provider account id', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: codexBindings('team'),
      },
    });
    const emitSessionEvent = vi.fn();
    const restartSession = vi.fn(async () => {});
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async () => ({ ok: true }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async () => ({
      status: 'unavailable',
      retryable: true,
      reason: 'active_account_probe_missing_account_id',
    }));

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      target: expect.objectContaining({ profileId: 'bot' }),
      action: 'hot_applied',
    }));
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      action: 'restart_requested',
      serviceIds: new Set(['openai-codex']),
    }));
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'openai-codex',
      toProfileId: 'bot',
      mode: 'restart_resume',
    }));
  });

  it('escalates a retryable hot-apply adoption mismatch through restart rematerialization before continuing', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: codexBindings('codex1'),
      },
    });
    const calls: string[] = [];
    const hotApply = vi.fn(async () => {
      calls.push('hot_apply');
      return { ok: true as const };
    });
    const restartSession = vi.fn(async () => {
      calls.push('restart');
    });
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async (context) => {
      calls.push(`recover:${context.action}`);
      return { ok: true };
    });
    const continueAfterRuntimeAuthSwitch = vi.fn(async (context: {
      action: 'hot_applied' | 'restart_requested';
    }) => {
      calls.push(`continue:${context.action}`);
    });
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async (context) => {
      calls.push(`verify:${context.action}`);
      return {
        status: 'mismatch',
        expectedProviderAccountId: 'acct_leeroy',
        actualProviderAccountId: 'acct_codex1',
        retryable: true,
        reason: 'provider_account_email_mismatch',
      };
    });

    const input: SwitchInputWithVerification = {
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'leeroy', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply,
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('leeroy'),
      },
    };

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: codexBindings('leeroy'),
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(hotApply).toHaveBeenCalledOnce();
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledTimes(1);
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      action: 'restart_requested',
      serviceIds: new Set(['openai-codex']),
      switchReason: 'manual',
    }));
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceId: 'openai-codex',
      target: expect.objectContaining({ profileId: 'leeroy' }),
    }));
    expect(calls).toEqual([
      'hot_apply',
      'verify:hot_applied',
      'restart',
      'continue:restart_requested',
    ]);
  });

  it('reports restart request success without verifying adoption against the pre-respawn runtime', async () => {
    const tracked = trackedSession();
    const calls: string[] = [];
    const restartSession = vi.fn(async () => {
      calls.push('restart');
    });
    const emitSessionEvent = vi.fn();
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async () => {
      calls.push('verify');
      return {
        status: 'mismatch',
        expectedProviderAccountId: 'new-profile',
        actualProviderAccountId: 'old-profile',
        retryable: true,
        reason: 'old_runtime_still_alive',
      };
    });
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async () => {
      calls.push('recover');
      return { ok: true };
    });
    const continueAfterRuntimeAuthSwitch = vi.fn(async (_context: {
      sessionId: string;
      attemptId: string;
      action: 'hot_applied' | 'restart_requested';
    }) => {});

    const input = {
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' as const }),
      restartSession,
      hotApply: async () => ({ ok: true as const }),
      recoverAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      continueAfterRuntimeAuthSwitch,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } satisfies SwitchInputWithVerification;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });

    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      toProfileId: 'new-profile',
      mode: 'restart_resume',
    }));
    expect(calls).toEqual(['restart']);
  });

  it('does not require provider account verification before a restart-rematerialize handoff can proceed', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async () => ({
      status: 'unavailable',
      retryable: true,
      reason: 'active_account_probe_unavailable',
    }));
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async () => ({ ok: true }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' as const }),
      restartSession,
      hotApply: async () => ({ ok: true as const }),
      recoverAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      continueAfterRuntimeAuthSwitch,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } satisfies SwitchInputWithVerification)).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });

    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
  });

  it('accepts weak account adoption verification after hot apply without weakening explicit mismatch handling', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const calls: string[] = [];
    const restartSession = vi.fn(async () => {
      calls.push('restart');
    });
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async () => {
      calls.push('verify');
      return {
        status: 'weakly_verified',
        providerAccountId: 'acct-bot',
        reason: 'provider_account_email_verified_without_account_id',
      };
    });
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async () => {
      calls.push('recover');
      return { ok: true };
    });
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {
      calls.push('continue');
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' as const }),
      restartSession,
      hotApply: async () => ({ ok: true as const }),
      recoverAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      continueAfterRuntimeAuthSwitch,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    } satisfies SwitchInputWithVerification)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
      verificationByServiceId: {
        'openai-codex': {
          status: 'weakly_verified',
          reason: 'provider_account_email_verified_without_account_id',
        },
      },
    });

    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceId: 'openai-codex',
      target: expect.objectContaining({ profileId: 'bot' }),
    }));
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
    expect(calls).toEqual(['verify', 'recover', 'continue']);
  });

  it('persists a pending continuation without probing the old runtime when the replacement client is not observable yet', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async () => ({
      status: 'unavailable',
      retryable: true,
      reason: 'active_account_probe_client_unavailable',
    }));
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async () => ({ ok: true }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' as const }),
      restartSession,
      hotApply: async () => ({ ok: true as const }),
      recoverAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      continueAfterRuntimeAuthSwitch,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } satisfies SwitchInputWithVerification)).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });

    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      action: 'restart_requested',
      serviceIds: new Set(['anthropic']),
    }));
  });

  it('records durable continuation state after requesting restart recovery', async () => {
    const tracked = trackedSession();
    const calls: string[] = [];
    const store = createContinuationStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });
    const sentPrompts: string[] = [];
    const restartSession = vi.fn(async () => {
      calls.push('restart');
    });
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async () => {
      calls.push('verify');
      return {
        status: 'verified',
        providerAccountId: 'new-profile',
        reason: 'test_verified',
      };
    });
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async () => {
      calls.push('recover');
      return { ok: true };
    });
    const continueAfterRuntimeAuthSwitch = vi.fn(async (context: {
      sessionId: string;
      attemptId: string;
      action: 'hot_applied' | 'restart_requested';
    }) => {
      calls.push('continue');
      await controller.beginAttempt({
        sessionId: context.sessionId,
        attemptId: context.attemptId,
        failureAtMs: 1_000,
        resumePromptMode: 'standard',
      });
      if (context.action === 'restart_requested') return;
      await controller.resolveAttempt({
        sessionId: context.sessionId,
        attemptId: context.attemptId,
        failureAtMs: 1_000,
        resumePromptMode: 'standard',
        exactProviderContextAvailable: true,
        hasUserMessageAfterFailure: () => false,
        sendContinuationPrompt: ({ prompt }) => {
          sentPrompts.push(prompt);
        },
      });
    });

    const input = {
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' as const }),
      restartSession,
      hotApply: async () => ({ ok: true as const }),
      recoverAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      continueAfterRuntimeAuthSwitch,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } satisfies SwitchInputWithVerification;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      action: 'restart_requested',
      serviceIds: new Set(['anthropic']),
    }));
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(calls).toEqual(['restart', 'continue']);
    expect(sentPrompts).toHaveLength(0);
    const persisted = store.stored.get('sess_1');
    const attemptsById =
      persisted && typeof persisted === 'object' && !Array.isArray(persisted)
        ? (persisted as { attemptsById?: Record<string, { status?: string }> }).attemptsById
        : null;
    expect(Object.keys(attemptsById ?? {})).toEqual([expect.stringContaining('anthropic')]);
    expect(Object.values(attemptsById ?? {})[0]).toMatchObject({ status: 'pending_provider_context' });
  });

  it('preserves automatic runtime failure as the application actor and reason', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      persistSessionBindings: async () => {},
      hotApply: async () => ({ ok: false }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      reason: 'automatic_runtime_failure',
      runtimeAuthApplyReason: 'usage_limit',
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_failed',
      diagnostics: {
        failurePhase: 'hot_apply',
        application: {
          status: 'hot_apply_failed',
          phase: 'hot_apply',
          actor: 'runtime',
          reason: 'automatic_runtime_failure',
        },
      },
    });
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      action: 'hot_applied',
      reason: 'usage_limit',
    }));
  });

  it('preserves automatic runtime failure as the emitted switch reason', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {},
      persistSessionBindings: async () => {},
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      reason: 'automatic_runtime_failure',
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      reason: 'automatic_runtime_failure',
    }));
  });

  it('fails closed when production-mode post-switch account adoption verification is missing', async () => {
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      persistSessionBindings: async () => {},
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'post_switch_verification_failed',
      diagnostics: {
        failurePhase: 'post_switch_verification',
        retryable: false,
        verification: {
          reason: 'post_switch_verifier_missing',
        },
      },
    });
  });

  it('rematerializes an active session when the selected profile binding is unchanged after reconnect', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi.fn();
    const restartSession = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'old-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ previous, next }) => {
        expect(previous).toEqual(expect.objectContaining({
          serviceId: 'anthropic',
          profileId: 'old-profile',
        }));
        expect(next).toEqual(expect.objectContaining({
          serviceId: 'anthropic',
          profileId: 'old-profile',
        }));
        return { mode: 'restart_rematerialize' };
      },
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('old-profile'),
        rematerializeServiceId: 'anthropic',
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('old-profile'),
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });

    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('old-profile'),
    }));
    expectMaterializationIdentity(
      persistSessionBindings.mock.calls[0]?.[0]?.connectedServiceMaterializationIdentityV1,
    );
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('rematerializes an unchanged group binding when an expected generation must be applied', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        },
      },
    });
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'verified' as const,
      reason: 'test_verified',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'group-active', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'group-active',
          generation: 67,
        }),
      },
      resolveContinuity: async ({ previous, next }) => {
        expect(previous).toEqual(expect.objectContaining({
          serviceId: 'anthropic',
          selection: 'group',
          groupId: 'work',
          profileId: 'group-active',
        }));
        expect(next).toEqual(expect.objectContaining({
          serviceId: 'anthropic',
          selection: 'group',
          groupId: 'work',
          profileId: 'group-active',
        }));
        return { mode: 'hot_apply' };
      },
      materializeRuntimeAuthSelection: async () => ({ kind: 'materialized' }),
      restartSession: async () => {},
      hotApply,
      recoverAfterRuntimeAuthSwitch: async () => ({ ok: true }),
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: async () => {},
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 67 },
        bindings: {
          v: 1 as const,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        } satisfies ConnectedServiceBindingsV1,
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          anthropic: {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
            profileId: 'group-active',
          },
        },
      },
      continuityByServiceId: { anthropic: 'hot_apply' },
    });

    expect(hotApply).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      attemptId: 'connected-service-auth-switch|hot_applied|anthropic:group:work:group-active:67',
      action: 'hot_applied',
    }));
  });

  it('does not hot-apply an unchanged group binding when the tracked runtime already adopted the expected generation', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        },
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'anthropic',
            groupId: 'work',
            activeProfileId: 'group-active',
            fallbackProfileId: 'group-active',
            generation: 67,
            policy: null,
          }]),
        },
      },
    });
    const materializeRuntimeAuthSelection = vi.fn(async () => ({ kind: 'materialized' }));
    const resolveContinuity = vi.fn(async () => ({ mode: 'hot_apply' as const }));
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'verified' as const,
      reason: 'test_verified',
    }));
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'group-active', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'group-active',
          generation: 67,
        }),
      },
      resolveContinuity,
      materializeRuntimeAuthSelection,
      restartSession: vi.fn(),
      hotApply,
      recoverAfterRuntimeAuthSwitch: async () => ({ ok: true }),
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 67 },
        bindings: {
          v: 1 as const,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'unchanged',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          anthropic: {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
            profileId: 'group-active',
          },
        },
      },
      continuityByServiceId: {},
    });
    expect(materializeRuntimeAuthSelection).not.toHaveBeenCalled();
    expect(resolveContinuity).not.toHaveBeenCalled();
    expect(hotApply).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('does not treat tracked env adoption as runtime proof for direct-live-required same-account fanout', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'backup',
            },
          },
        },
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'work',
            activeProfileId: 'backup',
            fallbackProfileId: 'backup',
            generation: 5,
          }]),
        },
      },
    });
    const runtimeAuthSelection = { kind: 'runtime-auth-selection', requireDirectLiveHotApply: true };
    const materializeRuntimeAuthSelection = vi.fn(async () => runtimeAuthSelection);
    const resolveContinuity = vi.fn(async ({ runtimeAuthSelection: receivedSelection }) => {
      expect(receivedSelection).toBe(runtimeAuthSelection);
      return { mode: 'hot_apply' as const };
    });
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'verified' as const,
      reason: 'test_verified',
    }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      reason: 'automatic_runtime_failure',
      runtimeAuthApplyReason: 'same_provider_account_exhausted',
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'backup', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({
          serviceId: 'openai-codex',
          groupId: 'work',
          activeProfileId: 'backup',
          generation: 5,
          members: [{
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'work',
            profileId: 'backup',
            priority: 100,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 1,
          }],
        }),
      },
      resolveContinuity,
      materializeRuntimeAuthSelection,
      restartSession: vi.fn(),
      hotApply,
      recoverAfterRuntimeAuthSwitch: async () => ({ ok: true }),
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        expectedGroupGenerationByServiceId: { 'openai-codex': 5 },
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'backup',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });

    expect(materializeRuntimeAuthSelection).toHaveBeenCalledOnce();
    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(hotApply).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
  });

  it('escalates unchanged group hot-apply adoption mismatch through restart rematerialization', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        },
      },
    });
    const calls: string[] = [];
    const restartSession = vi.fn(async () => {
      calls.push('restart');
    });
    const recoverAfterRuntimeAuthSwitch = vi.fn<RecoverAfterRuntimeAuthSwitch>(async (context) => {
      calls.push(`recover:${context.action}`);
      return { ok: true };
    });
    const continueAfterRuntimeAuthSwitch = vi.fn(async (context: {
      action: 'hot_applied' | 'restart_requested';
    }) => {
      calls.push(`continue:${context.action}`);
    });
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async (context) => {
      calls.push(`verify:${context.action}`);
      return {
        status: 'mismatch',
        expectedProviderAccountId: 'acct_group_active',
        actualProviderAccountId: 'acct_previous',
        retryable: true,
        reason: 'provider_account_email_mismatch',
      };
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'group-active', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'group-active',
          generation: 68,
        }),
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      materializeRuntimeAuthSelection: async () => ({ kind: 'materialized' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings: async () => {},
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 68 },
        bindings: {
          v: 1 as const,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      action: 'restart_requested',
      serviceIds: new Set(['anthropic']),
    }));
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceId: 'anthropic',
    }));
    expect(calls).toEqual([
      'verify:hot_applied',
      'restart',
      'continue:restart_requested',
    ]);
  });

  it('preserves group fallback profile and generation when hot applying Codex auth switches', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'tok',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'model.read',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const runtimeAuthSelection = {
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 7,
      record,
      client: {
        request: vi.fn(async () => ({ ok: true })),
      },
      invalidateTransports: async () => undefined,
    };
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'primary',
            },
          },
        },
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'fallback',
              generation: 7,
            },
          ]),
        },
      },
    });
    const codexRuntimeControl = getCodexRuntimeControlHooks();
    const hotApply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => codexRuntimeControl.createRuntimeAuthAdapter(),
    });
    const resolveContinuity = vi.fn(async (input: RuntimeAuthSelectionContinuityInput) => {
      const continuity = await codexRuntimeControl.resolveSwitchContinuity({
        runtimeControl: TEST_CODEX_RUNTIME_CONTROL,
        params: {
          sessionId: input.sessionId,
          agentId: input.agentId,
          serviceId: input.serviceId,
          previousBinding: input.previous,
          nextBinding: input.next,
          runtimeAuthSelection: input.runtimeAuthSelection,
        },
      });
      if (continuity.mode === 'hot_apply') return { mode: 'hot_apply' as const };
      throw new Error(`Expected hot_apply continuity, got ${continuity.mode}`);
    });
    const hotApplySelections: unknown[] = [];

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [
            { profileId: 'backup', status: 'connected' },
            { profileId: 'primary', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => group({
          serviceId: 'openai-codex',
          activeProfileId: 'backup',
          generation: 7,
        }),
      },
      resolveContinuity,
      materializeRuntimeAuthSelection: async () => runtimeAuthSelection,
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async (input) => {
        hotApplySelections.push(input.runtimeAuthSelectionsByServiceId?.get('openai-codex'));
        return await hotApply(input);
      },
      persistSessionBindings: async () => undefined,
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'backup',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });

    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      runtimeAuthSelection,
    }));
    expect(hotApplySelections).toEqual([runtimeAuthSelection]);
    expect(tracked.spawnOptions?.environmentVariables?.[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]).toBe(JSON.stringify([
      {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 7,
      },
    ]));
  });

  it('dry-runs runtime-auth generation apply without mutating session state or emitting events', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'primary',
            },
          },
        },
      },
    });
    const originalSpawnOptions = tracked.spawnOptions;
    const runtimeAuthSelection = { kind: 'materialized-selection' };
    const materializeRuntimeAuthSelection = vi.fn(async () => runtimeAuthSelection);
    const resolveContinuity = vi.fn(async () => ({ mode: 'hot_apply' as const }));
    const persistSessionBindings = vi.fn(async () => undefined);
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const restartSession = vi.fn(async () => undefined);
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'verified' as const,
      reason: 'test_verified',
    }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => undefined);
    const registerHotApplyTargets = vi.fn();
    const emitSessionEvent = vi.fn();
    const input = {
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic' as const,
          profiles: [
            { profileId: 'primary', status: 'connected' as const },
            { profileId: 'group-active', status: 'connected' as const },
          ],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'group-active',
          generation: 67,
        }),
      },
      resolveContinuity,
      materializeRuntimeAuthSelection,
      restartSession,
      hotApply,
      recoverAfterRuntimeAuthSwitch: async () => ({ ok: true as const }),
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent,
      dryRun: true,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 67 },
        bindings: {
          v: 1 as const,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        } satisfies ConnectedServiceBindingsV1,
      },
    };

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { anthropic: 'hot_apply' },
    });
    expect(materializeRuntimeAuthSelection).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'preflight',
    }));
    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      runtimeAuthSelection,
    }));
    expect(tracked.spawnOptions).toBe(originalSpawnOptions);
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(hotApply).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('preflights a prospective group generation before the group active profile is committed', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'primary',
            },
          },
        },
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'anthropic',
            groupId: 'work',
            activeProfileId: 'primary',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      },
    });
    const originalSpawnOptions = tracked.spawnOptions;
    const runtimeAuthSelection = { kind: 'materialized-selection', profileId: 'backup', generation: 5 };
    const materializeRuntimeAuthSelection = vi.fn(async ({ groupMetadata }) => {
      expect(groupMetadata).toMatchObject({
        groupId: 'work',
        activeProfileId: 'backup',
        generation: 5,
      });
      return runtimeAuthSelection;
    });
    const resolveContinuity = vi.fn(async ({ runtimeAuthSelection: receivedSelection }) => {
      expect(receivedSelection).toBe(runtimeAuthSelection);
      return { mode: 'hot_apply' as const };
    });
    const persistSessionBindings = vi.fn(async () => undefined);
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const restartSession = vi.fn(async () => undefined);
    const registerHotApplyTargets = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic' as const,
          profiles: [
            { profileId: 'primary', status: 'connected' as const },
            { profileId: 'backup', status: 'connected' as const },
          ],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'primary',
          generation: 4,
          members: [
            {
              v: 1,
              serviceId: 'anthropic',
              groupId: 'work',
              profileId: 'primary',
              priority: 100,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
            {
              v: 1,
              serviceId: 'anthropic',
              groupId: 'work',
              profileId: 'backup',
              priority: 90,
              enabled: true,
              state: {},
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        }),
      },
      resolveContinuity,
      materializeRuntimeAuthSelection,
      restartSession,
      hotApply,
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent,
      dryRun: true,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 5 },
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'backup',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { anthropic: 'hot_apply' },
    });

    expect(tracked.spawnOptions).toBe(originalSpawnOptions);
    expect(hotApply).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('ignores implicit native defaults for unrelated Codex services when computing changed bindings', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: { v: 1, bindingsByServiceId: {} },
      },
    });
    const resolveContinuity = vi.fn(async ({ serviceId }) => {
      if (serviceId === 'openai-codex') return { mode: 'hot_apply' as const };
      return { mode: 'unsupported' as const, errorCode: 'unsupported_service' as const };
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'happier', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity,
      restartSession: vi.fn(),
      persistSessionBindings: vi.fn(),
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'happier' },
            openai: { source: 'native' },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });

    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
    }));
  });

  it('rolls back persisted metadata and avoids re-registering targets when hot apply rejects the switch', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      persistSessionBindings,
      hotApply: async () => ({ ok: false }),
      registerHotApplyTargets,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_failed',
      diagnostics: {
        failurePhase: 'hot_apply',
        application: {
          status: 'hot_apply_failed',
          phase: 'hot_apply',
          actor: 'user',
          reason: 'manual',
        },
      },
    });

    expect(persistSessionBindings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('old-profile'),
    }));
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'failed',
      outcomeAction: 'none',
      errorCode: 'hot_apply_failed',
      partialState: null,
    }));
  });

  it('restarts without rollback when hot apply reports restart recovery', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const persistSessionBindings = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      persistSessionBindings,
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_restart_required',
        serviceId: 'anthropic',
        serviceResultsByServiceId: {
          anthropic: { status: 'failed', errorCode: 'hot_apply_restart_required' },
        },
      }),
      registerHotApplyTargets,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('new-profile'),
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(persistSessionBindings).toHaveBeenCalledOnce();
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalled();
  });

  it('threads hot-apply mode into emitted manual switch events', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      persistSessionBindings: vi.fn(),
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
    });

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      mode: 'hot_apply',
    }));
  });

  it('returns per-service hot-apply results when multi-service apply partially succeeds', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: multiServiceBindings({
          anthropicProfileId: 'old-anthropic',
          claudeSubscriptionProfileId: 'old-claude-subscription',
        }),
      },
    });
    const persistSessionBindings = vi.fn(async () => {});

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async ({ serviceId }) => ({
          serviceId,
          profiles: [
            { profileId: 'new-anthropic', status: 'connected' },
            { profileId: 'new-claude-subscription', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      persistSessionBindings,
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_failed',
        serviceId: 'claude-subscription',
        serviceResultsByServiceId: {
          anthropic: { status: 'applied' },
          'claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      }),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: multiServiceBindings({
          anthropicProfileId: 'new-anthropic',
          claudeSubscriptionProfileId: 'new-claude-subscription',
        }),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'hot_apply_failed',
      serviceId: 'claude-subscription',
      diagnostics: {
        serviceResultsByServiceId: {
          anthropic: { status: 'applied' },
          'claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      },
    });

    expect(persistSessionBindings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: multiServiceBindings({
        anthropicProfileId: 'new-anthropic',
        claudeSubscriptionProfileId: 'new-claude-subscription',
      }),
    }));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: multiServiceBindings({
        anthropicProfileId: 'old-anthropic',
        claudeSubscriptionProfileId: 'old-claude-subscription',
      }),
    }));
  });

  it('trusts exact direct-live hot-apply proof instead of re-probing account adoption', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: codexBindings('old-codex'),
      },
    });
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'unavailable' as const,
      retryable: false,
      reason: 'active_account_probe_missing_account_id',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'new-codex', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async () => ({
        ok: true as const,
        verificationByServiceId: {
          'openai-codex': {
            status: 'verified' as const,
            activeAccountId: 'acct_new',
            proofStrength: 'exact' as const,
            source: 'applied_credential',
          },
        },
      }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      verifyProviderAccountAdoption,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('new-codex'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      verificationByServiceId: {
        'openai-codex': {
          status: 'verified',
          activeAccountId: 'acct_new',
          proofStrength: 'exact',
          source: 'applied_credential',
        },
      },
    });

    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
  });

  it('restarts instead of hot applying when any changed service requires restart continuity', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: multiServiceBindings({
          anthropicProfileId: 'old-anthropic',
          claudeSubscriptionProfileId: 'old-claude-subscription',
        }),
      },
    });
    const restartSession = vi.fn(async () => {});
    const hotApply = vi.fn(async () => ({ ok: true as const }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async ({ serviceId }) => ({
          serviceId,
          profiles: [
            { profileId: 'new-anthropic', status: 'connected' },
            { profileId: 'new-claude-subscription', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ serviceId }) => (
        serviceId === 'anthropic'
          ? { mode: 'hot_apply' }
          : { mode: 'restart_rematerialize' }
      ),
      restartSession,
      hotApply,
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: multiServiceBindings({
          anthropicProfileId: 'new-anthropic',
          claudeSubscriptionProfileId: 'new-claude-subscription',
        }),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: {
        anthropic: 'hot_apply',
        'claude-subscription': 'restart_rematerialize',
      },
    });

    expect(hotApply).not.toHaveBeenCalled();
    expect(restartSession).toHaveBeenCalledWith(tracked);
  });
});
