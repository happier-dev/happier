import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES, type ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { createDaemonControlApp, createRuntimeAuthFailureReportIntake } from '@/daemon/controlServer';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, serializeConnectedServiceChildSelections } from '../connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import { createExecutionRunRuntimeAuthFailureReportIntake } from './executionRunReportIntake';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

function authGroup(groupId: string): ConnectedServiceAuthGroupV1 {
  return {
    v: 1, serviceId: 'openai-codex', groupId, displayName: null,
    policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true },
    activeProfileId: 'primary', generation: 1, runtimeStateRevision: 0, state: { v: 1 },
    members: ['primary', 'backup'].map((profileId, index) => ({
      v: 1, serviceId: 'openai-codex', groupId, profileId, enabled: true,
      priority: index, state: { v: 1 }, createdAt: 1, updatedAt: 1,
    })),
    createdAt: 1, updatedAt: 1,
  };
}

function fixture(overrides: Partial<Pick<Parameters<typeof createExecutionRunRuntimeAuthFailureReportIntake>[0],
  'resolveResumePromptMode' | 'isShuttingDown'
>> = {}) {
  const registry = new ConnectedServiceRuntimeRegistry();
  const registerInput = (groupId: string) => ({
    pid: 42, sessionId: 'parent', agentId: 'codex' as const,
    connectedServicesBindingsRaw: {
      v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId } },
    },
    connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serializeConnectedServiceChildSelections(new Map([[
      'openai-codex', { kind: 'group', serviceId: 'openai-codex', groupId, activeProfileId: 'primary', fallbackProfileId: 'primary', generation: 1 },
    ]]))! },
  });
  registry.registerTarget(registerInput('parent-pool'));
  registry.registerRunTarget({ ...registerInput('child-pool'), runKey: 'execution_run:child' });
  const groups = new Map(['parent-pool', 'child-pool'].map(id => [id, authGroup(id)]));
  // Server persistence and runner restart are the system boundaries; pool policy/selection stay real.
  const restartSession = vi.fn(async () => undefined);
  const switchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
    api: {
      getConnectedServiceAuthGroup: async ({ groupId }) => groups.get(groupId) ?? null,
      updateConnectedServiceAuthGroupActiveProfile: async ({ groupId, activeProfileId }) => {
        const previous = groups.get(groupId)!;
        const next = { ...previous, activeProfileId, generation: previous.generation + 1 };
        groups.set(groupId, next);
        return next;
      },
    },
    runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
    resolveCurrentCredentialRevision: async () => null,
    quotaFreshnessMs: 60_000, nowMs: () => 1_000, restartSession,
  });
  const intake = createExecutionRunRuntimeAuthFailureReportIntake({
    runtimeRegistry: registry,
    sessionIntake: createRuntimeAuthFailureReportIntake({}),
    switchCoordinator,
    resolveResumePromptMode: async () => 'off',
    isShuttingDown: () => false,
    ...overrides,
  });
  const classification: ConnectedServiceRuntimeFailureClassification = {
    kind: 'usage_limit', serviceId: 'openai-codex', groupId: 'child-pool', profileId: 'primary',
    groupGeneration: 1, quotaScope: 'account', resetsAtMs: 10_000,
    planType: null, rateLimits: null, source: 'structured_provider_error',
  };
  return { registry, groups, restartSession, intake, classification };
}

describe('execution-run runtime auth report intake', () => {
  it.each([
    { serviceId: 'claude-subscription' },
    { groupId: 'parent-pool' },
    { profileId: 'another-account' },
    { groupGeneration: 2 },
    { credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' },
  ])('rejects a positively identified source mismatch %j before changing either pool', async (mismatch) => {
    const { intake, classification, groups, restartSession } = fixture();
    await expect(intake({ sessionId: 'execution_run:child', classification: { ...classification, ...mismatch } }))
      .resolves.toMatchObject({ ok: true, result: { status: 'selection_mismatch' } });
    expect(groups.get('parent-pool')).toEqual(authGroup('parent-pool'));
    expect(groups.get('child-pool')).toEqual(authGroup('child-pool'));
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('returns the shared pool exhaustion disposition without arming session recovery', async () => {
    const { intake, classification, groups, restartSession } = fixture();
    const child = groups.get('child-pool')!;
    groups.set('child-pool', {
      ...child,
      members: child.members.map(member => member.profileId === 'backup' ? { ...member, enabled: false } : member),
    });
    await expect(intake({ sessionId: 'execution_run:child', classification })).resolves.toMatchObject({
      ok: true, resumePromptMode: 'off',
      result: { status: 'switch_attempted', result: { status: 'no_eligible_member' } },
    });
    expect(groups.get('parent-pool')).toEqual(authGroup('parent-pool'));
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('does not switch after the exact run registration is released while reading continuation policy', async () => {
    const state = fixture({ resolveResumePromptMode: async () => {
      state.registry.unregisterRunKey('execution_run:child');
      return 'off';
    } });
    await expect(state.intake({ sessionId: 'execution_run:child', classification: state.classification }))
      .resolves.toMatchObject({ ok: true, result: { status: 'selection_mismatch' } });
    expect(state.groups.get('child-pool')).toEqual(authGroup('child-pool'));
    expect(state.restartSession).not.toHaveBeenCalled();
  });

  it('defers run reports while the daemon is shutting down', async () => {
    const { intake, classification, groups } = fixture({ isShuttingDown: () => true });
    await expect(intake({ sessionId: 'execution_run:child', classification })).resolves.toMatchObject({
      ok: true, result: { status: 'daemon_lifecycle_unavailable' },
    });
    expect(groups.get('child-pool')).toEqual(authGroup('child-pool'));
  });

  it('keeps session and unregistered-run reports on the existing session intake', async () => {
    const { intake, classification, registry, groups } = fixture();
    await expect(intake({ sessionId: 'parent', classification })).resolves.toMatchObject({
      ok: false, errorCode: 'connected_service_runtime_auth_handler_unavailable',
    });
    registry.unregisterRunKey('execution_run:child');
    await expect(intake({ sessionId: 'execution_run:child', classification })).resolves.toMatchObject({
      ok: false, errorCode: 'connected_service_runtime_auth_handler_unavailable',
    });
    expect(groups.get('parent-pool')).toEqual(authGroup('parent-pool'));
    expect(groups.get('child-pool')).toEqual(authGroup('child-pool'));
  });

  it('routes a registered run report through the real pool decision without parent session recovery', async () => {
    const { groups, restartSession, intake, classification } = fixture();
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine', stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      runtimeAuthFailureReportIntake: intake,
    });
    try {
      const response = await app.inject({
        method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: { sessionId: 'execution_run:child', classification },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true, resumePromptMode: 'off',
        result: { status: 'switch_attempted', result: { status: 'switched', activeProfileId: 'backup' } },
      });
      expect(groups.get('child-pool')?.activeProfileId).toBe('backup');
      expect(groups.get('parent-pool')).toEqual(authGroup('parent-pool'));
      expect(restartSession.mock.calls).toEqual([[expect.not.objectContaining({ sessionId: expect.any(String) })]]);
    } finally {
      await app.close();
    }
  });
});
