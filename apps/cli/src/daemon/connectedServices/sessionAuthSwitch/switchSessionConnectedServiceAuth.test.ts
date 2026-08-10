import { describe, expect, it, vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceAuthGroupPolicyV1Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import { createCodexConnectedServiceRuntimeAuthAdapter } from '@/backends/codex/connectedServices/createCodexConnectedServiceRuntimeAuthAdapter';
import { resolveCodexConnectedServiceSwitchContinuity } from '@/backends/codex/connectedServices/resolveCodexConnectedServiceSwitchContinuity';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { ConnectedServiceSessionAuthSwitchLockRegistry, createConnectedServiceSessionAuthSwitchCore } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { createSessionConnectedServiceAuthHotApply } from './sessionConnectedServiceAuthHotApply';
import { switchSessionConnectedServiceAuth, type SwitchSessionConnectedServiceAuthInput } from './switchSessionConnectedServiceAuth';

const credentialRevision = 'csr_abcdefghijklmnopqrstuv';

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: 'sess_1',
    pid: 123,
    spawnOptions: {
      directory: '/tmp/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    path: '/tmp/project',
    host: 'test-host',
    homeDir: '/tmp/home',
    happyHomeDir: '/tmp/home/.happier',
    happyLibDir: '/tmp/home/.happier/lib',
    happyToolsDir: '/tmp/home/.happier/tools',
    ...overrides,
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
    runtimeStateRevision: 0,
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

function profileBindingWithGroupContext(input: Readonly<{
  serviceId: 'anthropic' | 'claude-subscription' | 'openai-codex';
  profileId: string;
  groupId: string;
}>): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      [input.serviceId]: {
        source: 'connected',
        selection: 'profile',
        profileId: input.profileId,
        groupId: input.groupId,
      },
    },
  } as unknown as ConnectedServiceBindingsV1;
}

const materializationIdentity = {
  v: 1,
  id: 'csm_switch_1',
  createdAtMs: 123,
} as const;

function expectMaterializationIdentity(value: unknown) {
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(value);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error('Expected connected-service materialization identity');
  }
  expect(parsed.data.id).toMatch(/^csm_[a-f0-9]{32}$/);
  return parsed.data;
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

function claudeSubscriptionGroupBindings(input: Readonly<{
  groupId: string;
  claudeSubscriptionProfileId: string;
}>): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      'claude-subscription': {
        source: 'connected',
        selection: 'group',
        groupId: input.groupId,
        profileId: input.claudeSubscriptionProfileId,
      },
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

describe('switchSessionConnectedServiceAuth', () => {
  it('rejects a missing session without mutating or restarting', async () => {
    const restartSession = vi.fn();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_not_found',
    });

    expect(restartSession).not.toHaveBeenCalled();
  });

  it('uses the canonical tracked-agent resolver for reattached sessions whose spawn options lost backendTarget', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        connectedServices: codexBindings('codex-profile'),
      },
      happySessionMetadataFromLocalWebhook: metadata({
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: { backendMode: 'appServer', vendorSessionId: 'codex-session' },
        },
      }),
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'agent resolution regression only',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex' as const,
          profiles: [{ profileId: 'codex-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('codex-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'unchanged',
    });
  });

  it('treats a profile binding with group context as a group binding that follows the active member', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: profileBindingWithGroupContext({
          serviceId: 'anthropic',
          profileId: 'remembered-member',
          groupId: 'work',
        }),
      },
    });
    const workGroup = group({
      activeProfileId: 'manual-active',
      members: [
        {
          v: 1,
          serviceId: 'anthropic',
          groupId: 'work',
          profileId: 'remembered-member',
          priority: 1,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 1,
        },
        {
          v: 1,
          serviceId: 'anthropic',
          groupId: 'work',
          profileId: 'manual-active',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });
    const resolveContinuity = vi.fn(async (input: Parameters<SwitchSessionConnectedServiceAuthInput['resolveContinuity']>[0]) => {
      expect(input.next).toMatchObject({
        selection: 'group',
        groupId: 'work',
        profileId: 'manual-active',
      });
      return { mode: 'restart_rematerialize' as const };
    });
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'binding policy test does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic' as const,
          profiles: [
            { profileId: 'remembered-member', status: 'connected' as const },
            { profileId: 'manual-active', status: 'connected' as const },
          ],
        }),
        getConnectedServiceAuthGroup: async () => workGroup,
      },
      resolveContinuity,
      restartSession: vi.fn(async () => {}),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: profileBindingWithGroupContext({
          serviceId: 'anthropic',
          profileId: 'remembered-member',
          groupId: 'work',
        }),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: {
        bindingsByServiceId: {
          anthropic: {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
            profileId: 'manual-active',
          },
        },
      },
    });

    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      normalizedBindings: expect.objectContaining({
        bindingsByServiceId: expect.objectContaining({
          anthropic: expect.objectContaining({
            selection: 'group',
            profileId: 'manual-active',
          }),
        }),
      }),
    }));
  });

  it('awaits runtime-auth credential write commitment before restart rematerialization spawns', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
      },
    });
    let releaseCredentialWrite!: () => void;
    let credentialWriteCommitted = false;
    const credentialWriteCommittedPromise = new Promise<void>((resolve) => {
      releaseCredentialWrite = () => {
        credentialWriteCommitted = true;
        resolve();
      };
    });
    const restartSession = vi.fn(async () => {
      if (!credentialWriteCommitted) throw new Error('credential_write_not_committed');
    });
    const materializeRuntimeAuthSelection = vi.fn(async () => ({
      credentialWriteCommitted: credentialWriteCommittedPromise,
    }));
    const switchPromise = switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'restart ordering test does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic' as const,
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      materializeRuntimeAuthSelection,
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' as const }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restartSession).not.toHaveBeenCalled();

    releaseCredentialWrite();
    await expect(switchPromise).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });
    expect(restartSession).toHaveBeenCalledOnce();
  });

  it('fails before side effects when startup reconciliation would require restart-resume', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
      },
    });
    const restartSession = vi.fn(async () => {});
    const persistSessionBindings = vi.fn(async () => {});

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      executionPolicy: {
        allowRestartResume: false,
        allowContinuation: false,
        source: 'startup_reconciliation',
      },
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'startup execution-authority policy fails before provider verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic' as const,
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' as const }),
      restartSession,
      hotApply: async () => ({ ok: false, errorCode: 'hot_apply_restart_required' }),
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'restart_disallowed_by_execution_policy',
    });

    expect(restartSession).not.toHaveBeenCalled();
    expect(persistSessionBindings).not.toHaveBeenCalled();
  });

  it('updates inactive session bindings without requesting a restart', async () => {
    const restartSession = vi.fn();
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();
    const resolveContinuity = vi.fn(async () => ({ mode: 'restart_rematerialize' as const }));

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: bindings('old-profile'),
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        vendorResumeId: 'vendor-inactive-1',
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
    } as any);

    expect(result).toMatchObject({
      ok: true,
      action: 'metadata_updated',
      normalizedBindings: bindings('new-profile'),
    });

    expect(persistSessionBindings).toHaveBeenCalledWith({
      sessionId: 'sess_inactive',
      normalizedBindings: bindings('new-profile'),
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      tracked: null,
      sessionId: 'sess_inactive',
      serviceId: 'anthropic',
      previous: expect.objectContaining({ profileId: 'old-profile' }),
      next: expect.objectContaining({ profileId: 'new-profile' }),
      connectedServiceMaterializationIdentityV1: materializationIdentity,
      vendorResumeId: 'vendor-inactive-1',
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

  it('threads the inactive session cwd and persisted session-file hint into the continuity check', async () => {
    // Regression: the inactive-switch continuity check ran with tracked=null, so the daemon adapter
    // (which derives cwd/target root from tracked.spawnOptions) starved the shared-state reachability
    // proof and fail-closed a genuinely-resumable inactive session. The switch must forward the
    // inactive session's cwd + persisted session-file hint so the adapter can reconstruct the target
    // and prove reachability from source.
    const resolveContinuity = vi.fn(async () => ({ mode: 'restart_rematerialize' as const }));

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: bindings('old-profile'),
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        vendorResumeId: 'vendor-inactive-1',
        cwd: '/tmp/inactive-repo',
        candidatePersistedSessionFile: '/tmp/inactive-repo/.pi/agent/sessions/--tmp-inactive-repo--/s.jsonl',
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
    } as any);

    expect(result).toMatchObject({ ok: true, action: 'metadata_updated' });

    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      tracked: null,
      sessionId: 'sess_inactive',
      cwd: '/tmp/inactive-repo',
      candidatePersistedSessionFile: '/tmp/inactive-repo/.pi/agent/sessions/--tmp-inactive-repo--/s.jsonl',
    }));
  });

  it('rejects inactive session switches when provider state sharing is required', async () => {
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'codex',
        connectedServices: codexBindings('old-codex-profile'),
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'new-codex-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ tracked, sessionId, previous, next }) => {
        expect(tracked).toBeNull();
        expect(sessionId).toBe('sess_inactive_codex');
        expect(previous).toEqual(expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'old-codex-profile',
        }));
        expect(next).toEqual(expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'new-codex-profile',
        }));
        return {
          mode: 'unsupported',
          errorCode: 'provider_state_sharing_required',
        };
      },
      restartSession: async () => {
        throw new Error('Inactive sessions should not restart');
      },
      hotApply: async () => {
        throw new Error('Inactive sessions should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_inactive_codex',
        agentId: 'codex',
        bindings: codexBindings('new-codex-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'provider_state_sharing_required',
      serviceId: 'openai-codex',
      diagnostics: {
        failurePhase: 'continuity',
      },
    });

    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledTimes(1);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_inactive_codex', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      action: 'restart_requested',
      errorCode: 'provider_state_sharing_required',
      partialState: null,
    }));
  });

  it('validates a profile, updates tracked spawn options, restarts, and emits one manual switch event', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      } as TrackedSession['spawnOptions'] & {
        connectedServiceMaterializationIdentityV1: typeof materializationIdentity;
      },
    });
    const calls: string[] = [];
    const persistSessionBindings = vi.fn(async () => {
      calls.push('persist');
      expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
      expect((tracked.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown } | undefined)
        ?.connectedServiceMaterializationIdentityV1).toEqual(materializationIdentity);
    });
    const restartSession = vi.fn(async () => {
      calls.push('restart');
      expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    });
    const emitSessionEvent = vi.fn();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as any);

    expect(result).toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('new-profile'),
    });

    expect(calls).toEqual(['persist', 'restart']);
    expect(persistSessionBindings).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(emitSessionEvent).toHaveBeenCalledTimes(2);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'old-profile',
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      partialState: null,
      errorCode: null,
    }));
  });

  it('uses webhook metadata bindings as the previous binding when tracked spawn options no longer carry them', async () => {
    const previousBindings = bindings('old-profile');
    const nextBindings = bindings('new-profile');
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      },
      happySessionMetadataFromLocalWebhook: metadata({
        flavor: 'claude',
        connectedServices: previousBindings,
      }),
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

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
    });

    expect(result).toMatchObject({
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
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      },
      happySessionMetadataFromLocalWebhook: metadata({
        flavor: 'claude',
        connectedServices: previousBindings,
      }),
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

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
    });

    expect(result).toMatchObject({
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
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        switchReason,
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

  it('reconsumes current group truth once when materialization reports a pre-effect group supersession', async () => {
    const previousBindings = claudeSubscriptionBindings('old-subscription');
    const requestedBindings = claudeSubscriptionGroupBindings({
      groupId: 'claude',
      claudeSubscriptionProfileId: 'first-active',
    });
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
      },
    });
    const groups = [
      group({
        serviceId: 'claude-subscription',
        groupId: 'claude',
        activeProfileId: 'first-active',
        generation: 337,
        members: [
          {
            v: 1,
            serviceId: 'claude-subscription',
            groupId: 'claude',
            profileId: 'first-active',
            priority: 100,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'claude-subscription',
            groupId: 'claude',
            profileId: 'second-active',
            priority: 90,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      group({
        serviceId: 'claude-subscription',
        groupId: 'claude',
        activeProfileId: 'second-active',
        generation: 338,
        members: [
          {
            v: 1,
            serviceId: 'claude-subscription',
            groupId: 'claude',
            profileId: 'first-active',
            priority: 90,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'claude-subscription',
            groupId: 'claude',
            profileId: 'second-active',
            priority: 100,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    ];
    const getConnectedServiceAuthGroup = vi.fn(async () => groups.shift() ?? groups[0] ?? null);
    const materializeRuntimeAuthSelection = vi.fn(async (input) => {
      if (input.groupMetadata?.generation === 337) {
        return {
          materializationDiagnostics: [{
            code: 'claude_connected_service_generation_superseded',
            providerId: 'claude' as const,
            serviceId: 'claude-subscription' as const,
            severity: 'blocking' as const,
            reason: 'authoritative_group_target_changed_before_materialization',
          }],
        };
      }
      return {
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/current-group-home' },
        targetMaterializedRoot: '/tmp/current-group-home',
      };
    });
    const persistSessionBindings = vi.fn(async () => {});
    const restartSession = vi.fn(async () => {});

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'the test isolates pre-effect group supersession convergence',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'claude-subscription',
          profiles: [
            { profileId: 'first-active', status: 'connected' },
            { profileId: 'second-active', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup,
      },
      materializeRuntimeAuthSelection,
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch: async () => ({ ok: true }),
      continueAfterRuntimeAuthSwitch: async () => {},
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: requestedBindings,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: {
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
            profileId: 'second-active',
          },
        },
      },
    });
    expect(getConnectedServiceAuthGroup).toHaveBeenCalledTimes(2);
    expect(materializeRuntimeAuthSelection).toHaveBeenCalledTimes(2);
    expect(persistSessionBindings).toHaveBeenCalledOnce();
    expect(restartSession).toHaveBeenCalledOnce();
  });

  it('returns metadata-only for reactive runtime switches that require restart rematerialization', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
        environmentVariables: { EXISTING: '1' },
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
    });
    const persistSessionBindings = vi.fn();
    const restartSession = vi.fn(async () => {
      throw new Error('reactive runtime switch should not restart inside the switch primitive');
    });
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {
      throw new Error('reactive runtime switch should continue only after the recovery owner restarts');
    });
    const emitSessionEvent = vi.fn();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      switchReason: 'automatic_runtime_failure',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'runtime recovery restart is scheduled by the recovery owner',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({
        mode: 'restart_rematerialize',
        // INC-6: the proven continuity context must surface on the success result so switch
        // telemetry is not all-null for spawn_next_turn switches.
        diagnostics: {
          materializationIdentityId: materializationIdentity.id,
          targetMaterializedRoot: '/tmp/new-claude-config',
          vendorResumeId: 'claude-session-1',
          cwd: '/tmp/project',
          candidatePersistedSessionFile: null,
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
        },
      }),
      materializeRuntimeAuthSelection: async () => ({
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/new-claude-config' },
        targetMaterializedRoot: '/tmp/new-claude-config',
        credentialRevision,
      }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      recoverAfterRuntimeAuthSwitch: async () => ({ ok: true }),
      continueAfterRuntimeAuthSwitch,
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'metadata_updated',
      normalizedBindings: bindings('new-profile'),
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
      // INC-6: the success result carries the proven continuity context for switch telemetry.
      diagnostics: {
        continuity: {
          targetMaterializedRoot: '/tmp/new-claude-config',
          vendorResumeId: 'claude-session-1',
          candidatePersistedSessionFile: null,
          effectiveStateMode: 'shared',
        },
      },
    });
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(tracked.spawnOptions?.environmentVariables).toEqual({
      EXISTING: '1',
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
        { kind: 'profile', serviceId: 'anthropic', profileId: 'new-profile', credentialRevision },
      ]),
    });
    expect(persistSessionBindings).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'old-profile',
      toProfileId: 'new-profile',
      mode: 'spawn_next_turn',
    }));
    // INC-7: a metadata-only commit is NOT a proven switch — no restart happened and no provider
    // adoption was verified. The transcript outcome must stay observed-intermediate until proof
    // lands; only failed/terminal/succeeded-with-proof shapes may render as final.
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'metadata_updated',
      attemptedContinuityMode: 'metadata_only',
      outcome: 'observed',
      outcomeAction: 'metadata_updated',
      errorCode: null,
    }));
  });

  it('rematerializes an active session with a generated identity when the selected profile binding is unchanged after reconnect', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi.fn();
    const restartSession = vi.fn();
    const emitSessionEvent = vi.fn();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('old-profile'),
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });

    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    const persistedIdentity = expectMaterializationIdentity(
      persistSessionBindings.mock.calls[0]?.[0]?.connectedServiceMaterializationIdentityV1,
    );
    expect((tracked.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown } | undefined)
      ?.connectedServiceMaterializationIdentityV1).toEqual(persistedIdentity);
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      partialState: null,
      errorCode: null,
    }));
  });

  it('keeps unchanged-binding restart rematerialize projected as a restart request without probing the old runtime', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const emitSessionEvent = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'unavailable' as const,
      retryable: false,
      reason: 'active_account_probe_unavailable',
    }));

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'old-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply,
      registerHotApplyTargets: vi.fn(),
      verifyProviderAccountAdoption,
      emitSessionEvent,
      persistSessionBindings: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('old-profile'),
        rematerializeServiceId: 'anthropic',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(hotApply).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      attemptedContinuityMode: 'restart',
      outcome: 'observed',
      outcomeAction: 'none',
      errorCode: null,
    }));
    expect(emitSessionEvent).not.toHaveBeenCalledWith('sess_1', expect.objectContaining({
      attemptedContinuityMode: 'hot_apply',
    }));
    expect(emitSessionEvent).not.toHaveBeenCalledWith('sess_1', expect.objectContaining({
      action: 'hot_applied',
    }));
  });

  it('startup reconciliation hot-applies an unchanged group generation without continuation', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
    });
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'verified' as const,
      reason: 'test_verified',
    }));

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      executionPolicy: {
        allowRestartResume: false,
        allowContinuation: false,
        source: 'startup_reconciliation',
      },
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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

    expect(result).toMatchObject({
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
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('rejects a revision-only mismatch before unchanged-binding rematerialization side effects', async () => {
    const desiredRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const materializedRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
    });
    const previousSpawnOptions = tracked.spawnOptions;
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const persistSessionBindings = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const restartSession = vi.fn(async () => {});
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'verified' as const,
      reason: 'test_verified',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      executionPolicy: {
        allowRestartResume: false,
        allowContinuation: false,
        source: 'startup_reconciliation',
      },
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'revision fencing aborts before provider adoption verification',
      },
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
      expectedCredentialRevisionByServiceId: {
        anthropic: desiredRevision,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      materializeRuntimeAuthSelection: async () => ({
        credentialRevision: materializedRevision,
      }),
      restartSession,
      hotApply,
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 67 },
        bindings: {
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
    })).rejects.toThrow(
      'connected_service_auth_generation_apply_failed:credential_revision_superseded',
    );

    expect(tracked.spawnOptions).toBe(previousSpawnOptions);
    expect(hotApply).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('suppresses continuation replay for pre-turn group switches through the unchanged-binding path (F5)', async () => {
    // The canonical pre-turn member switch keeps the group binding unchanged (only the generation
    // moves), so it flows through rematerializeUnchangedConnectedServiceBinding. The switch reason
    // must reach the continuation gate there too, otherwise `pre_turn_group_policy` replay
    // suppression never engages and the original user message can be delivered twice.
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
    });
    const restartSession = vi.fn(async () => {});
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      switchReason: 'pre_turn_group_policy',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'pre-turn restart fixture does not exercise provider adoption verification',
      },
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
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      materializeRuntimeAuthSelection: async () => ({ kind: 'materialized' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      recoverAfterRuntimeAuthSwitch: async () => ({ ok: true }),
      continueAfterRuntimeAuthSwitch,
      persistSessionBindings: async () => {},
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 67 },
        bindings: {
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

    expect(result).toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });
    expect(restartSession).toHaveBeenCalledWith(tracked);
    // F5: pre-turn switches always suppress replay — no continuation may fire.
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('gates a predictive soft-threshold switch before side effects when the session cannot hot-apply (RD-SW-9)', async () => {
    // A `soft_threshold` switch must never disrupt a live session: if continuity resolves to a
    // restart, the FSM must refuse BEFORE committing bindings or requesting a restart — not let
    // the coordinator backstop classify `generation_apply_failed` after the damage is done.
    const tracked = trackedSession();
    const previousSpawnOptions = tracked.spawnOptions;
    const persistSessionBindings = vi.fn(async () => {});
    const restartSession = vi.fn(async () => {});
    const emitSessionEvent = vi.fn();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      switchReason: 'pre_turn_group_policy',
      groupSwitchTriggerReason: 'soft_threshold',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'predictive gate fixture never reaches provider adoption verification',
      },
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
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as any);

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'hot_apply_restart_required',
    });
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(emitSessionEvent).not.toHaveBeenCalled();
    expect(tracked.spawnOptions).toBe(previousSpawnOptions);
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('gates a predictive soft-threshold switch through the unchanged-binding rematerialize path before side effects (RD-SW-9)', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
    });
    const previousSpawnOptions = tracked.spawnOptions;
    const restartSession = vi.fn(async () => {});
    const persistSessionBindings = vi.fn(async () => {});

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      switchReason: 'pre_turn_group_policy',
      groupSwitchTriggerReason: 'soft_threshold',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'predictive gate fixture never reaches provider adoption verification',
      },
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
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      materializeRuntimeAuthSelection: async () => ({ kind: 'materialized' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      recoverAfterRuntimeAuthSwitch: async () => ({ ok: true }),
      continueAfterRuntimeAuthSwitch: async () => {},
      persistSessionBindings,
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 67 },
        bindings: {
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

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'hot_apply_restart_required',
    });
    expect(restartSession).not.toHaveBeenCalled();
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(tracked.spawnOptions).toBe(previousSpawnOptions);
  });

  it('does not emit successful switch-attempt transcript events for proactive soft-threshold hot applies', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      switchReason: 'pre_turn_group_policy',
      groupSwitchTriggerReason: 'soft_threshold',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'soft-threshold maintenance rows are filtered before transcript commit',
      },
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
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      persistSessionBindings: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as any)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
    });

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
    }));
    expect(emitSessionEvent).not.toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
    }));
  });

  it('does not accept tracked launch metadata as proof that the runtime adopted the expected generation', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'anthropic',
            groupId: 'work',
            activeProfileId: 'group-active',
            fallbackProfileId: 'group-active',
            generation: 67,
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

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
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

    expect(result).toMatchObject({
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
    });
    expect(materializeRuntimeAuthSelection).toHaveBeenCalledOnce();
    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(hotApply).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
  });

  it('does not treat tracked env adoption as provider proof for same-account exhausted fanout', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'codex-team',
              profileId: 'backup',
            },
          },
        },
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'codex-team',
            activeProfileId: 'backup',
            fallbackProfileId: 'backup',
            generation: 5,
          }]),
        },
      },
    });
    const runtimeAuthSelection = {
      serviceId: 'openai-codex',
      binding: {
        source: 'connected',
        selection: 'group',
        groupId: 'codex-team',
        profileId: 'backup',
      },
      profileId: 'backup',
      activeProfileId: 'backup',
      groupId: 'codex-team',
      generation: 5,
      record: buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'openai-codex',
        profileId: 'backup',
        kind: 'oauth',
        expiresAt: 2_000,
        oauth: {
          accessToken: 'access',
          refreshToken: 'refresh',
          idToken: 'id',
          scope: null,
          tokenType: null,
          providerAccountId: 'acct-backup',
          providerEmail: null,
        },
      }),
    };
    const materializeRuntimeAuthSelection = vi.fn(async () => runtimeAuthSelection);
    const resolveContinuity = vi.fn(async ({ runtimeAuthSelection: receivedSelection }) => {
      expect(receivedSelection).toBe(runtimeAuthSelection);
      return { mode: 'hot_apply' as const };
    });
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'verified' as const,
      reason: 'test_verified',
    }));
    const registerHotApplyTargets = vi.fn();
    const emitSessionEvent = vi.fn();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      switchReason: 'pre_turn_group_policy',
      groupSwitchTriggerReason: 'same_provider_account_exhausted',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'same-account fanout fixture asserts provider apply dispatch only',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'backup', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => ({
          ...group({
            serviceId: 'openai-codex',
            groupId: 'codex-team',
            displayName: 'Codex Team',
            activeProfileId: 'backup',
            generation: 5,
          }),
          members: [{
            v: 1,
            serviceId: 'openai-codex' as const,
            groupId: 'codex-team',
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
      registerHotApplyTargets,
      emitSessionEvent,
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
              groupId: 'codex-team',
              profileId: 'backup',
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });
    expect(materializeRuntimeAuthSelection).toHaveBeenCalledOnce();
    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(hotApply).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).toHaveBeenCalledOnce();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'hot_applied',
      outcome: 'succeeded',
    }));
  });

  it('escalates unchanged group hot-apply adoption mismatch to restart and defers proof to the respawned runtime', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'leeroy',
            },
          },
        },
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
    });
    const restartSession = vi.fn(async () => {});
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn()
      .mockResolvedValueOnce({
        status: 'mismatch' as const,
        expectedProviderAccountId: 'acct_leeroy',
        actualProviderAccountId: 'acct_codex1',
        retryable: true,
        reason: 'provider_account_adoption_mismatch',
      });

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'leeroy', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({
          groupId: 'happier',
          activeProfileId: 'leeroy',
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
        agentId: 'codex',
        expectedGroupGenerationByServiceId: { 'openai-codex': 68 },
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'leeroy',
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(restartSession).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceId: 'openai-codex',
    }));
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
  });

  it('generates a materialization identity before restarting an active native session into connected auth', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        resume: 'spawn-resume-1',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

    const emitSessionEvent = vi.fn();
	    await expect(switchSessionConnectedServiceAuth({
	      core: createCore(),
	      postSwitchVerificationMode: {
	        kind: 'disabled_for_test_only',
	        reason: 'existing switch fixture does not exercise provider adoption verification',
	      },
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
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      persistSessionBindings,
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

    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    const persistedIdentity = expectMaterializationIdentity(
      persistSessionBindings.mock.calls[0]?.[0]?.connectedServiceMaterializationIdentityV1,
    );
    expect((tracked.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown } | undefined)
      ?.connectedServiceMaterializationIdentityV1).toEqual(persistedIdentity);
    expect(restartSession).toHaveBeenCalledWith(tracked);
  });

  it('persists a generated materialization identity when updating an inactive native session into connected auth', async () => {
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'native' },
          },
        },
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ connectedServiceMaterializationIdentityV1 }) => {
        expectMaterializationIdentity(connectedServiceMaterializationIdentityV1);
        return { mode: 'restart_rematerialize' };
      },
      restartSession: async () => {
        throw new Error('Inactive sessions should not restart');
      },
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
    });

    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    expectMaterializationIdentity(
      persistSessionBindings.mock.calls[0]?.[0]?.connectedServiceMaterializationIdentityV1,
    );
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_inactive', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: null,
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
  });

  it('uses the daemon-threaded pre-switch member as the transcript "from" when provided', async () => {
    // Regression for the "Switched ... account from Native" mislabel: an automatic group switch has
    // no live member on the persisted binding, so the daemon threads the pre-switch member via
    // emitFromProfileIdByServiceId. When present, that member (not null) must be the emitted "from".
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'native' },
          },
        },
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {
        throw new Error('Inactive sessions should not restart');
      },
      hotApply: async () => {
        throw new Error('Inactive sessions should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings: vi.fn(),
      emitFromProfileIdByServiceId: new Map([['anthropic', 'prior-member']]),
      request: {
        sessionId: 'sess_inactive',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'metadata_updated',
    });

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_inactive', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'prior-member',
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
  });

  it('does not emit no-op switch events when the threaded pre-switch member already matches the target profile', async () => {
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'native' },
          },
        },
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {
        throw new Error('Inactive sessions should not restart');
      },
      hotApply: async () => {
        throw new Error('Inactive sessions should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings: vi.fn(),
      emitFromProfileIdByServiceId: new Map([['anthropic', 'new-profile']]),
      request: {
        sessionId: 'sess_inactive',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'metadata_updated',
    });

    expect(emitSessionEvent).not.toHaveBeenCalledWith('sess_inactive', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
    }));
  });

  it('allows retryable-refresh profiles during manual auth switch validation', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'refresh_failed_retryable' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      persistSessionBindings: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
  });

  it('returns action-required for reconnect-required profile selection', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'needs_reauth' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => {
        throw new Error('Reconnect-required profiles should not resolve continuity');
      },
      restartSession,
      hotApply: async () => {
        throw new Error('Reconnect-required profiles should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      persistSessionBindings: vi.fn(),
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
        },
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('does not restart when persisting the accepted binding fails', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      persistSessionBindings: async () => {
        throw new Error('metadata unavailable');
      },
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as any)).resolves.toMatchObject({
      ok: false,
      errorCode: 'metadata_update_failed',
	      diagnostics: {
	        failurePhase: 'metadata',
	        uxDiagnostic: expect.objectContaining({
	          code: 'metadata_update_failed',
	          failurePhase: 'metadata',
	          source: 'manual_auth_switch',
	          suggestedActions: expect.arrayContaining(['retry', 'open_connected_accounts']),
	        }),
	      },
	    });

	    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
	    expect(restartSession).not.toHaveBeenCalled();
	  });

	  it('uses runtime-auth recovery as the diagnostic source for automatic runtime failures', async () => {
	    const tracked = trackedSession();

	    await expect(switchSessionConnectedServiceAuth({
	      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
	      switchReason: 'automatic_runtime_failure',
	      getChildren: () => [tracked],
	      api: {
	        listConnectedServiceProfiles: async () => ({
	          serviceId: 'anthropic',
	          profiles: [{ profileId: 'new-profile', status: 'connected' }],
	        }),
	        getConnectedServiceAuthGroup: async () => null,
	      },
	      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
	      restartSession: vi.fn(),
	      hotApply: async () => ({ ok: true }),
	      registerHotApplyTargets: () => {},
	      emitSessionEvent: () => {},
	      persistSessionBindings: async () => {
	        throw new Error('metadata unavailable');
	      },
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
	        uxDiagnostic: expect.objectContaining({
	          code: 'metadata_update_failed',
	          failurePhase: 'metadata',
	          source: 'runtime_auth_recovery',
	        }),
	      },
	    });
	  });

	  it('uses usage-limit recovery as the diagnostic source for pre-turn group policy switches', async () => {
	    const tracked = trackedSession();

	    await expect(switchSessionConnectedServiceAuth({
	      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
	      switchReason: 'pre_turn_group_policy',
	      getChildren: () => [tracked],
	      api: {
	        listConnectedServiceProfiles: async () => ({
	          serviceId: 'anthropic',
	          profiles: [{ profileId: 'new-profile', status: 'connected' }],
	        }),
	        getConnectedServiceAuthGroup: async () => null,
	      },
	      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
	      restartSession: vi.fn(),
	      hotApply: async () => ({ ok: true }),
	      registerHotApplyTargets: () => {},
	      emitSessionEvent: () => {},
	      persistSessionBindings: async () => {
	        throw new Error('metadata unavailable');
	      },
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
	        uxDiagnostic: expect.objectContaining({
	          code: 'metadata_update_failed',
	          failurePhase: 'metadata',
	          source: 'usage_limit_recovery',
	        }),
	      },
	    });
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
      switchReason: 'pre_turn_group_policy',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'pre-turn switches should never drive continuation replay',
      },
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
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch: vi.fn(async () => ({ ok: true as const })),
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
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            { kind: 'profile', serviceId: 'anthropic', profileId: 'old-profile' },
          ]),
        },
      },
    });
    const restartSession = vi.fn(async () => {
      expect(tracked.spawnOptions?.connectedServices).toEqual({
        v: 1,
        bindingsByServiceId: {},
      });
      expect(tracked.spawnOptions?.environmentVariables).toBeUndefined();
    });
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      emitSessionEvent,
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
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      errorCode: 'unsupported_service',
    }));
  });

  it('converges a real switch onto the CURRENT group truth when the expected generation is stale', async () => {
    // Live regression 2026-07-10: the settings pool-switch fan-out is a long-running per-session
    // loop while the group generation legitimately keeps moving (concurrent daemons, recovery
    // switches, member edits). A strict expected==current CAS here turned every such advance into a
    // per-session "Authentication could not be switched (group_generation_conflict)" transcript
    // error, even though applying the group's CURRENT active profile is always the correct
    // convergence. A stale expectation must converge, not fail; only dry-run preflights keep the
    // strict semantics (they gate a NOT-yet-committed prospective generation).
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
      },
    });
    const restartSession = vi.fn(async () => {
      // The child env adopts the CURRENT generation (5), not the caller's stale expectation (4).
      expect(tracked.spawnOptions?.environmentVariables).toEqual({
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'anthropic',
            groupId: 'work',
            activeProfileId: 'group-active',
            fallbackProfileId: 'group-active',
            generation: 5,
            credentialRevision,
          },
        ]),
      });
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'group-active', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({ generation: 5 }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      materializeRuntimeAuthSelection: async () => ({ credentialRevision }),
      restartSession,
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
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
  });

  it('keeps the strict generation check for dry-run preflights (prospective generations only)', async () => {
    // A dry-run preflight validates a PROSPECTIVE switch (expected == current + 1 is the committed
    // shape). A stale/other expectation must still abort so the coordinator re-resolves before
    // committing — convergence applies only to REAL applies.
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      dryRun: true,
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
        expectedGroupGenerationByServiceId: { anthropic: 3 },
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
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
            credentialRevision,
          },
        ]),
      });
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      materializeRuntimeAuthSelection: async () => ({ credentialRevision }),
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

  it('rejects a needs-reauth fallback profile before mutating group session state', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [
            { profileId: 'group-active', status: 'connected' },
            { profileId: 'fallback-profile', status: 'needs_reauth' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'group-active',
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
              priority: 200,
              enabled: true,
              state: {},
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      persistSessionBindings,
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
      ok: false,
      errorCode: 'profile_action_required',
      serviceId: 'anthropic',
      diagnostics: {
        actionRequired: {
          kind: 'reconnect_profile',
          profileId: 'fallback-profile',
          healthStatus: 'needs_reauth',
        },
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('does not mutate when provider continuity is unsupported', async () => {
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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

  it('fails closed when PI continuity cannot prove resume reachability', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old-profile' },
          },
        },
      },
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
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
      request: {
        sessionId: 'sess_1',
        agentId: 'pi',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'new-profile' },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'provider_session_state_unavailable_for_resume',
      serviceId: 'openai-codex',
      diagnostics: {
        failurePhase: 'continuity',
        uxDiagnostic: expect.objectContaining({
          code: 'provider_session_state_unavailable_for_resume',
          failurePhase: 'continuity',
          serviceId: 'openai-codex',
          suggestedActions: expect.arrayContaining(['start_fresh_under_selected_account', 'open_connected_accounts']),
        }),
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old-profile' },
      },
    });
  });

  it('keeps PI continuity diagnostics path-safe in public auth-switch results', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old-profile' },
          },
        },
      },
    });

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          materializationIdentityId: 'csm_pi_shared',
          targetMaterializedRoot: '/tmp/materialized/csm_pi_shared/pi',
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
        agentId: 'pi',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'new-profile' },
          },
        },
      },
    });

	    expect(result).toMatchObject({
	      ok: false,
	      errorCode: 'provider_session_state_unavailable_for_resume',
	      diagnostics: {
	        failurePhase: 'continuity',
	        continuity: {
	          requestedStateMode: 'shared',
	          effectiveStateMode: 'shared',
	          reachabilityMissReason: 'pi_session_file_not_found',
        },
        uxDiagnostic: expect.objectContaining({
          code: 'provider_session_state_unavailable_for_resume',
          diagnostics: {
            reason: 'pi_session_file_not_found',
          },
        }),
      },
	    });

	    if (!result.ok) {
	      const diagnostics = JSON.stringify(result.diagnostics ?? {});
	      expect(diagnostics).not.toContain('/tmp/materialized');
	      expect(diagnostics).not.toContain('/tmp/native');
	      expect(diagnostics).not.toContain('/tmp/project');
	      expect(diagnostics).not.toContain('pi-session-1');
	      expect(diagnostics).not.toContain('csm_pi_shared');
	    }
	  });

  it('returns restart failure diagnostics when a switch cannot restart the active session', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi.fn();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      persistSessionBindings,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'restart_failed',
      diagnostics: {
        failurePhase: 'restart',
        underlyingError: expect.stringContaining('restart failed'),
      },
    });
    expect(result.ok ? null : result.diagnostics?.retryable).toBeUndefined();

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
      connectedServiceMaterializationIdentityV1: expect.objectContaining({ v: 1 }),
    }));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('old-profile'),
    }));
  });

  it('marks stale-process restart signal failures as retryable diagnostics', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi.fn();
    const staleProcessError = new Error('kill ESRCH');
    Object.assign(staleProcessError, { code: 'ESRCH' });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      persistSessionBindings,
      emitSessionEvent: () => {},
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
      },
    });
  });

  it('re-registers quota and refresh targets after hot apply without restart', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const registerHotApplyTargets = vi.fn();
    const calls: string[] = [];
    const runtimeAuthSelection = {
      serviceId: 'anthropic',
      profileId: 'new-profile',
      record: buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'anthropic',
        profileId: 'new-profile',
        kind: 'token',
        token: {
          token: 'token',
          providerAccountId: 'anthropic-account-id',
          providerEmail: null,
        },
      }),
    };

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      materializeRuntimeAuthSelection: async () => runtimeAuthSelection,
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => {
        calls.push('hotApply');
        return { ok: true };
      },
      persistSessionBindings: async () => {
        calls.push('persist');
      },
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
    expect(calls).toEqual(['persist', 'hotApply']);
    expect(registerHotApplyTargets).toHaveBeenCalledWith(tracked, {
      runtimeAuthSelectionsByServiceId: expect.any(Map),
    });
    expect(registerHotApplyTargets.mock.calls[0]?.[1]?.runtimeAuthSelectionsByServiceId?.get('anthropic'))
      .toBe(runtimeAuthSelection);
  });

  it('invokes post-switch recovery after hot apply', async () => {
    const tracked = trackedSession();
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const input = {
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' as const }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true as const }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } satisfies SwitchSessionConnectedServiceAuthInput & Readonly<{
      recoverAfterRuntimeAuthSwitch: typeof recoverAfterRuntimeAuthSwitch;
    }>;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
    });

    expect(recoverAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      tracked,
      serviceIds: new Set(['anthropic']),
      normalizedBindings: bindings('new-profile'),
    }));
  });

  it('falls back to restart when hot-apply verification still sees the old provider account', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const emitSessionEvent = vi.fn();
    const restartSession = vi.fn(async () => {});
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'mismatch' as const,
      expectedProviderAccountId: 'acct_bot',
      actualProviderAccountId: 'acct_codex3',
      retryable: true,
      reason: 'provider_account_adoption_mismatch',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      target: expect.objectContaining({ profileId: 'bot' }),
      action: 'hot_applied',
    }));
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(restartSession).toHaveBeenCalledOnce();
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      errorCode: null,
    }));
  });

  it('falls back to restart when hot-apply verification cannot prove the active Codex account id yet', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const emitSessionEvent = vi.fn();
    const restartSession = vi.fn(async () => {});
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'unavailable' as const,
      retryable: true,
      reason: 'active_account_probe_missing_account_id',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      target: expect.objectContaining({ profileId: 'bot' }),
      action: 'hot_applied',
    }));
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(restartSession).toHaveBeenCalledOnce();
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
    const switchEvents = emitSessionEvent.mock.calls.filter(([, event]) => (
      event as { type?: unknown }
    ).type === 'connected_service_account_switch_attempt');
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents.some(([, event]) => (event as { ok?: unknown }).ok === false)).toBe(false);
    expect(switchEvents[0]).toEqual(['sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      attemptedContinuityMode: 'restart',
      outcome: 'observed',
      outcomeAction: 'none',
      errorCode: null,
    })]);
  });

  it('escalates successful hot apply adoption mismatch to restart before reporting the restart request', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex1'),
      },
    });
    const restartSession = vi.fn(async () => {});
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'mismatch' as const,
      expectedProviderAccountId: 'acct_leeroy',
      actualProviderAccountId: 'acct_codex1',
      retryable: true,
      reason: 'provider_account_adoption_mismatch',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('leeroy'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(restartSession).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      target: expect.objectContaining({ profileId: 'leeroy' }),
    }));
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
  });

  it('reports restart request success without verifying adoption against the pre-respawn runtime', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const calls: string[] = [];
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => {
      calls.push('recover');
      return { ok: true as const };
    });
    const continueAfterRuntimeAuthSwitch = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'mismatch' as const,
      expectedProviderAccountId: 'acct_bot',
      actualProviderAccountId: 'acct_codex3',
      retryable: true,
      reason: 'provider_account_adoption_mismatch',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(calls).toEqual([]);
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
  });

  it('does not verify provider adoption against the old runtime after requesting restart-rematerialize', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const restartSession = vi.fn(async () => {});
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'mismatch' as const,
      expectedProviderAccountId: 'acct_bot',
      actualProviderAccountId: 'acct_codex3',
      retryable: true,
      reason: 'provider_account_adoption_mismatch',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(restartSession).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      action: 'restart_requested',
      serviceIds: new Set(['openai-codex']),
    }));
  });

  it('does not require provider account verification before a restart-rematerialize handoff can proceed', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'unavailable' as const,
      retryable: true,
      reason: 'active_account_probe_unavailable',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
  });

  it('accepts weak account adoption verification after hot apply without weakening explicit mismatch handling', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'weakly_verified' as const,
      providerAccountId: 'acct_bot',
      reason: 'provider_account_email_verified_without_account_id',
    }));
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
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
      serviceId: 'openai-codex',
      target: expect.objectContaining({ profileId: 'bot' }),
      action: 'hot_applied',
    }));
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'hot_applied',
      reason: 'manual',
      verificationByServiceId: {
        'openai-codex': {
          status: 'weakly_verified',
          reason: 'provider_account_email_verified_without_account_id',
        },
      },
    }));
  });

  it('persists a pending continuation without probing the old runtime when the replacement client is not observable yet', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const continueAfterRuntimeAuthSwitch = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'unavailable' as const,
      retryable: true,
      reason: 'active_account_probe_client_unavailable',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      action: 'restart_requested',
      serviceIds: new Set(['openai-codex']),
    }));
  });

	  it('sanitizes hot-apply failure messages before returning switch diagnostics', async () => {
	    const tracked = trackedSession();
	    const emitSessionEvent = vi.fn();

	    const result = await switchSessionConnectedServiceAuth({
	      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
        errorCode: 'hot_apply_failed',
        serviceResultsByServiceId: {
          anthropic: { status: 'applied' },
          openai: { status: 'failed', errorCode: 'hot_apply_failed' },
        },
        underlyingError: 'provider refused Bearer raw-secret-token accessToken=raw-access-token',
	      }),
	      persistSessionBindings: vi.fn(),
	      registerHotApplyTargets: vi.fn(),
	      emitSessionEvent,
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
	    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
	      type: 'connected_service_account_switch_attempt',
	      ok: false,
	      errorCode: 'hot_apply_failed',
	      attemptedContinuityMode: 'hot_apply',
	      outcome: 'failed',
	      outcomeAction: 'none',
		    }));
		  });

  it('keeps a declined predictive soft-threshold hot-apply out of the transcript (benign fail-safe)', async () => {
    // Live incident 2026-07-10 19:10: the burn-rate soft-switch targeted 5 sessions; 4 idle
    // siblings hot-applied instantly, the one MID-TURN session had no safe apply window, timed out
    // after 15s and surfaced "Authentication could not be switched (hot_apply_failed)" to the user.
    // A predictive switch is a background optimization that fails BEFORE side effects by design
    // (RD-SW-9): the session keeps working on its current account, the next poll/in-band tick
    // retries, and hard-limit recovery remains the backstop. The SUCCESS path already keeps
    // soft-threshold switches silent here (they surface via the centralized swap notification);
    // the benign-decline failure must be symmetric. Side-effectful failures stay loud.
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      groupSwitchTriggerReason: 'soft_threshold',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
        errorCode: 'hot_apply_failed',
        underlyingError: 'no safe apply window within bound',
      }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    });

    // The coordinator still sees the failure (retry bookkeeping)…
    expect(result).toMatchObject({ ok: false, errorCode: 'hot_apply_failed' });
    // …but the user-facing failed switch-attempt event is NOT committed.
    expect(emitSessionEvent).not.toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
    }));
  });

  it('emits hot-apply attempted route when post-switch verification fails after hot apply', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const emitSessionEvent = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'unavailable' as const,
      retryable: false,
      reason: 'active_account_probe_unavailable',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      verifyProviderAccountAdoption,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'post_switch_verification_failed',
      diagnostics: {
        failurePhase: 'post_switch_verification',
      },
    });

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'failed',
      outcomeAction: 'none',
      errorCode: 'post_switch_verification_failed',
    }));
  });

  it('trusts exact direct-live hot-apply proof instead of re-probing account adoption', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const emitSessionEvent = vi.fn();
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
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({
        ok: true as const,
        verificationByServiceId: {
          'openai-codex': {
            status: 'verified' as const,
            providerAccountId: 'acct_bot',
            proofStrength: 'exact' as const,
            source: 'applied_credential',
          },
        },
      }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      verifyProviderAccountAdoption,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      verificationByServiceId: {
        'openai-codex': {
          status: 'verified',
          providerAccountId: 'acct_bot',
          proofStrength: 'exact',
          source: 'applied_credential',
        },
      },
    });

    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'hot_applied',
      verificationByServiceId: {
        'openai-codex': {
          status: 'verified',
          providerAccountId: 'acct_bot',
          proofStrength: 'exact',
          source: 'applied_credential',
        },
      },
    }));
  });

  it('trusts exact shared-auth-surface hot-apply proof without requiring provider account id', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: claudeSubscriptionGroupBindings({
          groupId: 'claude-team',
          claudeSubscriptionProfileId: 'subscription-old',
        }),
      },
    });
    const emitSessionEvent = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'unavailable' as const,
      retryable: false,
      reason: 'provider_account_id_not_applicable',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'claude-subscription',
          profiles: [{ profileId: 'subscription-new', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({
          serviceId: 'claude-subscription',
          groupId: 'claude-team',
          displayName: 'Claude Team',
          activeProfileId: 'subscription-new',
          generation: 3,
          members: [
            {
              v: 1,
              serviceId: 'claude-subscription',
              groupId: 'claude-team',
              profileId: 'subscription-old',
              priority: 100,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
            {
              v: 1,
              serviceId: 'claude-subscription',
              groupId: 'claude-team',
              profileId: 'subscription-new',
              priority: 90,
              enabled: true,
              state: {},
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        }),
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({
        ok: true as const,
        verificationByServiceId: {
          'claude-subscription': {
            status: 'verified' as const,
            sharedAuthSurfaceId: 'claude-team',
            proofStrength: 'exact' as const,
            source: 'runtime_identity_probe',
          },
        },
      }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      verifyProviderAccountAdoption,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: claudeSubscriptionGroupBindings({
          groupId: 'claude-team',
          claudeSubscriptionProfileId: 'subscription-new',
        }),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      verificationByServiceId: {
        'claude-subscription': {
          status: 'verified',
          sharedAuthSurfaceId: 'claude-team',
          proofStrength: 'exact',
          source: 'runtime_identity_probe',
        },
      },
    });

    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'hot_applied',
      verificationByServiceId: {
        'claude-subscription': {
          status: 'verified',
          sharedAuthSurfaceId: 'claude-team',
          proofStrength: 'exact',
          source: 'runtime_identity_probe',
        },
      },
    }));
  });

  it('does not trust exact direct-live hot-apply proof without provider account identity material', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const emitSessionEvent = vi.fn();
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
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({
        ok: true as const,
        verificationByServiceId: {
          'openai-codex': {
            status: 'verified' as const,
            proofStrength: 'exact' as const,
            source: 'applied_credential',
          },
        },
      }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      verifyProviderAccountAdoption,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'post_switch_verification_failed',
      diagnostics: {
        failurePhase: 'post_switch_verification',
      },
    });

    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'openai-codex' }),
    );
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      action: 'hot_applied',
      attemptedContinuityMode: 'hot_apply',
      outcome: 'failed',
      outcomeAction: 'none',
      errorCode: 'post_switch_verification_failed',
    }));
  });

  it('reports restart fallback after a hot-apply process failure without probing the old runtime', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const emitSessionEvent = vi.fn();
    const restartSession = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn(async () => ({
      status: 'unavailable' as const,
      retryable: false,
      reason: 'active_account_probe_unavailable',
    }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: false, errorCode: 'hot_apply_failed' }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      verifyProviderAccountAdoption,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
    });

    expect(restartSession).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      attemptedContinuityMode: 'restart',
      outcome: 'observed',
      outcomeAction: 'none',
      errorCode: null,
    }));
  });

  it('does not restart a healthy same-account sibling when direct live hot apply fails', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('old-codex-profile'),
      },
    });
    const restartSession = vi.fn(async () => {});
    const persistSessionBindings = vi.fn(async () => {});

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      groupSwitchTriggerReason: 'same_provider_account_exhausted',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'same-account fanout must never restart healthy siblings',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'new-codex-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_failed',
        serviceId: 'openai-codex',
        serviceResultsByServiceId: {
          'openai-codex': { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      }),
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('new-codex-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'hot_apply_failed',
      diagnostics: {
        failurePhase: 'hot_apply',
      },
    });

    expect(restartSession).not.toHaveBeenCalled();
    expect(tracked.spawnOptions?.connectedServices).toEqual(codexBindings('old-codex-profile'));
    expect(persistSessionBindings).toHaveBeenCalledTimes(2);
  });

		  it('fails closed when a production post-switch path omits the adoption verifier', async () => {
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
	      restartSession: vi.fn(),
	      hotApply: async () => ({ ok: true }),
	      persistSessionBindings: vi.fn(),
	      registerHotApplyTargets: vi.fn(),
	      emitSessionEvent: vi.fn(),
	      request: {
	        sessionId: 'sess_1',
	        agentId: 'claude',
	        bindings: bindings('new-profile'),
	      },
	    })).resolves.toMatchObject({
	      ok: false,
	      errorCode: 'post_switch_verification_failed',
	      serviceId: 'anthropic',
	      diagnostics: {
	        failurePhase: 'post_switch_verification',
	        retryable: false,
	        verification: {
	          reason: 'post_switch_verifier_missing',
	        },
	      },
	    });
	  });

  it('invokes the continuation producer after requesting restart recovery', async () => {
    const tracked = trackedSession();
    const calls: string[] = [];
    const emitSessionEvent = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => {
      calls.push('verify');
      return { status: 'verified' as const, reason: 'test_verified' };
    });
    const continueAfterRuntimeAuthSwitch = vi.fn(async (context: {
      sessionId: string;
      attemptId: string;
      action: 'hot_applied' | 'restart_requested';
      serviceIds: ReadonlySet<string>;
    }) => {
      calls.push('continue');
    });
    const input = {
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' as const }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true as const }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch: vi.fn(async () => {
        calls.push('recover');
        return { ok: true as const };
      }),
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as SwitchSessionConnectedServiceAuthInput & Readonly<{
      continueAfterRuntimeAuthSwitch: typeof continueAfterRuntimeAuthSwitch;
    }>;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      action: 'restart_requested',
      serviceIds: new Set(['anthropic']),
    }));
    expect(calls).toEqual(['continue']);
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(input.recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
	    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
	      type: 'connected_service_account_switch_attempt',
	      ok: true,
	      action: 'restart_requested',
	      attemptedContinuityMode: 'restart',
	      outcome: 'observed',
	      outcomeAction: 'none',
	      partialState: null,
	      errorCode: null,
	    }));
	  });

  it('invokes the post-switch continuation decision exactly once after hot apply', async () => {
    const tracked = trackedSession();
    const calls: string[] = [];
    const restartSession = vi.fn();
    const verifyProviderAccountAdoption = vi.fn(async () => {
      calls.push('verify');
      return { status: 'verified' as const, reason: 'test_verified' };
    });
    const continueAfterRuntimeAuthSwitch = vi.fn(async (context: {
      sessionId: string;
      attemptId: string;
      action: 'hot_applied' | 'restart_requested';
      serviceIds: ReadonlySet<string>;
    }) => {
      calls.push('continue');
    });
    const input = {
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' as const }),
      restartSession,
      hotApply: async () => ({ ok: true as const }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch: vi.fn(async () => ({ ok: true as const })),
      continueAfterRuntimeAuthSwitch,
      verifyProviderAccountAdoption,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as SwitchSessionConnectedServiceAuthInput & Readonly<{
      continueAfterRuntimeAuthSwitch: typeof continueAfterRuntimeAuthSwitch;
    }>;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
    });

    // Hot-apply continues in place — no respawn.
    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledTimes(1);
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceIds: new Set(['anthropic']),
    }));
    expect(calls).toEqual(['verify', 'continue']);
  });

  it('returns typed partial result when post-switch recovery fails', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'recover_failed',
    }));
    const input = {
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' as const }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true as const }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } satisfies SwitchSessionConnectedServiceAuthInput & Readonly<{
      recoverAfterRuntimeAuthSwitch: typeof recoverAfterRuntimeAuthSwitch;
    }>;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: false,
      errorCode: 'hot_apply_succeeded_but_recovery_failed',
      diagnostics: {
        failurePhase: 'post_switch_recovery',
        partialState: 'runtime_auth_applied',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      action: 'hot_applied',
      partialState: 'runtime_auth_applied',
      errorCode: 'hot_apply_succeeded_but_recovery_failed',
    }));
  });

  it('threads hot-apply mode into emitted manual switch events', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
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

  it('emits provider state-sharing degraded diagnostics when restarting after a switch', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
        materializationDiagnostics: [
          {
            code: 'state_symlink_unavailable',
            providerId: 'claude',
            serviceId: 'anthropic',
            requestedStateMode: 'shared',
            effectiveStateMode: 'isolated',
          },
        ],
      } as TrackedSession['spawnOptions'] & {
        materializationDiagnostics?: ReadonlyArray<{
          code: string;
          providerId: string;
          serviceId?: string;
          requestedStateMode?: string;
          effectiveStateMode?: string;
        }>;
      },
    });
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
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
      type: 'provider_state_sharing_degraded',
      serviceId: 'anthropic',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      code: 'state_symlink_unavailable',
    }));
  });

  it('does not hot-apply live runtime auth when metadata persistence fails', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const registerHotApplyTargets = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
        uxDiagnostic: expect.objectContaining({
          code: 'metadata_update_failed',
          failurePhase: 'metadata',
          suggestedActions: expect.arrayContaining(['retry', 'open_connected_accounts']),
        }),
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(hotApply).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('hot-applies Codex manual switches with the materialized runtime auth selection', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('old-codex-profile'),
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            { kind: 'profile', serviceId: 'openai-codex', profileId: 'old-codex-profile' },
          ]),
        },
      },
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'new-codex-profile',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const binding = { source: 'connected', selection: 'profile', profileId: 'new-codex-profile' } as const;
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: { activeAccountId: 'acct' },
    }));
    const runtimeAuthSelection = {
      serviceId: 'openai-codex',
      binding,
      profileId: 'new-codex-profile',
      record,
      credentialRevision,
      applyConnectedServiceAuthGeneration,
      applyReason: 'manual',
    };
    type RuntimeAuthSelectionContinuityInput =
      Parameters<SwitchSessionConnectedServiceAuthInput['resolveContinuity']>[0]
      & Readonly<{ runtimeAuthSelection?: unknown }>;
    const materializeRuntimeAuthSelection = vi.fn(async () => runtimeAuthSelection);
    const hotApply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => createCodexConnectedServiceRuntimeAuthAdapter(),
    });
    const registerHotApplyTargets = vi.fn();
    const switchInput = {
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex' as const,
          profiles: [{ profileId: 'new-codex-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      materializeRuntimeAuthSelection,
      resolveContinuity: async (input: RuntimeAuthSelectionContinuityInput) => {
        expect(input.runtimeAuthSelection).toBe(runtimeAuthSelection);
        const continuity = await resolveCodexConnectedServiceSwitchContinuity({
          sessionId: input.sessionId,
          agentId: input.agentId,
          serviceId: input.serviceId,
          previousBinding: input.previous,
          nextBinding: input.next,
          fromBindings: input.previousBindings,
          toBindings: input.normalizedBindings,
          runtimeAuthSelection: input.runtimeAuthSelection,
        });
        if (continuity.mode === 'hot_apply') return { mode: 'hot_apply' };
        throw new Error(`Expected hot_apply continuity, got ${continuity.mode}`);
      },
      restartSession: vi.fn(),
      hotApply,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('new-codex-profile'),
      },
    } satisfies SwitchSessionConnectedServiceAuthInput & Readonly<{
      materializeRuntimeAuthSelection: () => Promise<typeof runtimeAuthSelection>;
    }>;

    await expect(switchSessionConnectedServiceAuth(switchInput)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });

    expect(materializeRuntimeAuthSelection).toHaveBeenCalledOnce();
    expect(switchInput.restartSession).not.toHaveBeenCalled();
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      reason: 'manual',
      requireDirectLiveHotApply: false,
      authGeneration: expect.objectContaining({
        credential: record,
      }),
    }));
    expect(registerHotApplyTargets).toHaveBeenCalledWith(expect.objectContaining({
      spawnOptions: expect.objectContaining({
        environmentVariables: expect.objectContaining({
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            { kind: 'profile', serviceId: 'openai-codex', profileId: 'new-codex-profile', credentialRevision },
          ]),
        }),
      }),
    }), {
      runtimeAuthSelectionsByServiceId: expect.any(Map),
    });
    expect(registerHotApplyTargets.mock.calls[0]?.[1]?.runtimeAuthSelectionsByServiceId?.get('openai-codex'))
      .toBe(runtimeAuthSelection);
  });

  it('rejects a superseded materialized credential revision before the provider effect', async () => {
    const desiredRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const materializedRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('old-codex-profile'),
      },
    });
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const switchInput = {
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'revision fencing aborts before provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex' as const,
          profiles: [{ profileId: 'new-codex-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      expectedCredentialRevisionByServiceId: {
        'openai-codex': desiredRevision,
      },
      materializeRuntimeAuthSelection: async () => ({
        credentialRevision: materializedRevision,
      }),
      resolveContinuity: async () => ({ mode: 'hot_apply' as const }),
      restartSession: vi.fn(),
      hotApply,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('new-codex-profile'),
      },
    } satisfies SwitchSessionConnectedServiceAuthInput & Readonly<{
      expectedCredentialRevisionByServiceId: Readonly<Record<string, string>>;
    }>;

    await expect(switchSessionConnectedServiceAuth(switchInput)).rejects.toThrow(
      'connected_service_auth_generation_apply_failed:credential_revision_superseded',
    );
    expect(hotApply).not.toHaveBeenCalled();
  });

  it('requires direct live Codex apply for usage-limit recovery when the provider declares direct live auth', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('old-codex-profile'),
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            { kind: 'profile', serviceId: 'openai-codex', profileId: 'old-codex-profile' },
          ]),
        },
      },
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'new-codex-profile',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const binding = { source: 'connected', selection: 'profile', profileId: 'new-codex-profile' } as const;
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: { activeAccountId: 'acct' },
    }));
    const runtimeAuthSelection = {
      serviceId: 'openai-codex',
      binding,
      profileId: 'new-codex-profile',
      record,
      applyConnectedServiceAuthGeneration,
      applyReason: 'usage_limit',
    };
    type RuntimeAuthSelectionContinuityInput =
      Parameters<SwitchSessionConnectedServiceAuthInput['resolveContinuity']>[0]
      & Readonly<{ runtimeAuthSelection?: unknown }>;
    const materializeRuntimeAuthSelection = vi.fn(async (
      input: Parameters<NonNullable<SwitchSessionConnectedServiceAuthInput['materializeRuntimeAuthSelection']>>[0],
    ) => ({
      ...runtimeAuthSelection,
      requireDirectLiveHotApply: input.requireDirectLiveHotApply,
    }));
    const hotApply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => createCodexConnectedServiceRuntimeAuthAdapter(),
    });
    const restartSession = vi.fn();
    const switchInput = {
      core: createCore(),
      groupSwitchTriggerReason: 'usage_limit',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex' as const,
          profiles: [{ profileId: 'new-codex-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      runtimeAuthApplyCapabilityResolver: () => ({
        directLiveHotAuth: {
          supportsInTurnApply: true,
          requiresExactRuntimeIdentity: true,
          refreshSelectionResync: 'required',
          authMode: {
            kind: 'external_token_injection',
            surface: 'codex_chatgpt_auth_tokens',
          },
        },
      }),
      materializeRuntimeAuthSelection,
      resolveContinuity: async (input: RuntimeAuthSelectionContinuityInput) => {
        expect(input.runtimeAuthSelection).toEqual(expect.objectContaining({
          ...runtimeAuthSelection,
          requireDirectLiveHotApply: true,
        }));
        const continuity = await resolveCodexConnectedServiceSwitchContinuity({
          sessionId: input.sessionId,
          agentId: input.agentId,
          serviceId: input.serviceId,
          previousBinding: input.previous,
          nextBinding: input.next,
          fromBindings: input.previousBindings,
          toBindings: input.normalizedBindings,
          runtimeAuthSelection: input.runtimeAuthSelection,
        });
        if (continuity.mode === 'hot_apply') return { mode: 'hot_apply' };
        throw new Error(`Expected hot_apply continuity, got ${continuity.mode}`);
      },
      restartSession,
      hotApply,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('new-codex-profile'),
      },
    } satisfies SwitchSessionConnectedServiceAuthInput;

    await expect(switchSessionConnectedServiceAuth(switchInput)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });

    expect(restartSession).not.toHaveBeenCalled();
    expect(materializeRuntimeAuthSelection).toHaveBeenCalledWith(expect.objectContaining({
      applyReason: 'usage_limit',
      requireDirectLiveHotApply: true,
    }));
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      requireDirectLiveHotApply: true,
      authGeneration: expect.objectContaining({
        credential: record,
      }),
    }));
  });

  it('uses preflight runtime-auth materialization during dry-run switches without applying side effects', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('old-codex-profile'),
      },
    });
    const runtimeAuthSelection = {
      serviceId: 'openai-codex',
      binding: { source: 'connected', selection: 'profile', profileId: 'new-codex-profile' },
      profileId: 'new-codex-profile',
      record: buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'openai-codex',
        profileId: 'new-codex-profile',
        kind: 'oauth',
        expiresAt: 2_000,
        oauth: {
          accessToken: 'access',
          refreshToken: 'refresh',
          idToken: 'id',
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
    };
    const materializeRuntimeAuthSelection = vi.fn(async () => runtimeAuthSelection);
    const resolveContinuity = vi.fn(async ({ runtimeAuthSelection: receivedSelection }) => {
      expect(receivedSelection).toBe(runtimeAuthSelection);
      return { mode: 'hot_apply' as const };
    });
    const restartSession = vi.fn();
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const persistSessionBindings = vi.fn();
    const registerHotApplyTargets = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      dryRun: true,
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'dry-run preflight does not perform post-switch verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex' as const,
          profiles: [{ profileId: 'new-codex-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      materializeRuntimeAuthSelection,
      resolveContinuity,
      restartSession,
      hotApply,
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('new-codex-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });

    expect(materializeRuntimeAuthSelection).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'preflight',
      serviceId: 'openai-codex',
    }));
    expect(restartSession).not.toHaveBeenCalled();
    expect(hotApply).not.toHaveBeenCalled();
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
    expect(emitSessionEvent).not.toHaveBeenCalled();
  });

  it('preflights a prospective group generation before the group active profile is committed', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'codex-team',
              profileId: 'work',
            },
          },
        },
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'codex-team',
            activeProfileId: 'work',
            fallbackProfileId: 'backup',
            generation: 4,
          }]),
        },
      },
    });
    const runtimeAuthSelection = {
      serviceId: 'openai-codex',
      binding: { source: 'connected', selection: 'group', groupId: 'codex-team', profileId: 'backup' },
      profileId: 'backup',
      groupId: 'codex-team',
      generation: 5,
      record: buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'openai-codex',
        profileId: 'backup',
        kind: 'oauth',
        expiresAt: 2_000,
        oauth: {
          accessToken: 'access',
          refreshToken: 'refresh',
          idToken: 'id',
          scope: null,
          tokenType: null,
          providerAccountId: 'acct-backup',
          providerEmail: null,
        },
      }),
    };
    const materializeRuntimeAuthSelection = vi.fn(async ({ groupMetadata }) => {
      expect(groupMetadata).toMatchObject({
        groupId: 'codex-team',
        activeProfileId: 'backup',
        generation: 5,
      });
      return runtimeAuthSelection;
    });
    const resolveContinuity = vi.fn(async ({ runtimeAuthSelection: receivedSelection }) => {
      expect(receivedSelection).toBe(runtimeAuthSelection);
      return { mode: 'hot_apply' as const };
    });
    const restartSession = vi.fn();
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const persistSessionBindings = vi.fn();
    const registerHotApplyTargets = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      dryRun: true,
      groupSwitchTriggerReason: 'same_provider_account_exhausted',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'dry-run preflight does not perform post-switch verification',
      },
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex' as const,
          profiles: [
            { profileId: 'work', status: 'connected' as const },
            { profileId: 'backup', status: 'connected' as const },
          ],
        }),
        getConnectedServiceAuthGroup: async () => ({
          v: 1,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-team',
          displayName: 'Codex Team',
          policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true }),
          activeProfileId: 'work',
          generation: 4,
          runtimeStateRevision: 0,
          state: { v: 1 },
          members: [
            {
              v: 1,
              serviceId: 'openai-codex' as const,
              groupId: 'codex-team',
              profileId: 'work',
              priority: 100,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
            {
              v: 1,
              serviceId: 'openai-codex' as const,
              groupId: 'codex-team',
              profileId: 'backup',
              priority: 90,
              enabled: true,
              state: {},
              createdAt: 2,
              updatedAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        }),
      },
      materializeRuntimeAuthSelection,
      resolveContinuity,
      restartSession,
      hotApply,
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'codex-team',
              profileId: 'backup',
            },
          },
        },
        expectedGroupGenerationByServiceId: { 'openai-codex': 5 },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });

    expect(restartSession).not.toHaveBeenCalled();
    expect(hotApply).not.toHaveBeenCalled();
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
    expect(emitSessionEvent).not.toHaveBeenCalled();
    expect(tracked.spawnOptions?.connectedServices).toMatchObject({
      bindingsByServiceId: {
        'openai-codex': {
          selection: 'group',
          groupId: 'codex-team',
          profileId: 'work',
        },
      },
    });
  });

  it('ignores implicit native defaults for unrelated Codex services when computing changed bindings', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: { v: 1, bindingsByServiceId: {} },
      },
    });
    const resolveContinuity = vi.fn(async ({ serviceId }) => {
      if (serviceId === 'openai-codex') return { mode: 'hot_apply' as const };
      return { mode: 'unsupported' as const, errorCode: 'unsupported_service' as const };
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
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

  it('restarts when hot apply fails before applying any runtime auth changes', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: false, errorCode: 'hot_apply_failed' }),
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
      connectedServiceMaterializationIdentityV1: expect.objectContaining({ v: 1 }),
    }));
    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('restarts when hot apply adapter is unavailable before any runtime auth changes', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({ ok: false, errorCode: 'hot_apply_unavailable' }),
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('restarts when hot apply throws before applying any runtime auth changes', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => {
        throw new Error('runtime auth adapter failure');
      },
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('restarts without rollback when hot apply reports restart recovery', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_restart_required',
        serviceId: 'anthropic',
        serviceResultsByServiceId: {
          anthropic: { status: 'failed', errorCode: 'hot_apply_restart_required' },
        },
      }),
      persistSessionBindings,
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

  it('returns rollback-failed when persisted rollback fails after hot apply failure', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('metadata rollback unavailable'));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
        errorCode: 'hot_apply_failed',
        serviceResultsByServiceId: {
          anthropic: { status: 'applied' },
          openai: { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      }),
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'bindings_rollback_failed',
      diagnostics: {
        failurePhase: 'rollback',
        partialState: 'metadata_may_reference_new_binding',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('restarts instead of hot applying when any changed service requires restart continuity', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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

  it('returns per-service hot-apply results when multi-service apply partially succeeds', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: multiServiceBindings({
          anthropicProfileId: 'old-anthropic',
          claudeSubscriptionProfileId: 'old-claude-subscription',
        }),
      },
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'existing switch fixture does not exercise provider adoption verification',
      },
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
      restartSession: vi.fn(),
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_failed',
        serviceId: 'claude-subscription',
        serviceResultsByServiceId: {
          anthropic: { status: 'applied' },
          'claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      }),
      persistSessionBindings: vi.fn(),
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
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_failed',
      serviceId: 'claude-subscription',
      continuityByServiceId: {
        anthropic: 'hot_apply',
        'claude-subscription': 'hot_apply',
      },
      diagnostics: {
        failurePhase: 'hot_apply',
        partialState: 'runtime_auth_partially_applied',
        serviceResultsByServiceId: {
          anthropic: { status: 'applied' },
          'claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      },
    });
  });
});
