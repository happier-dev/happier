import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  buildConnectedServiceCredentialRecord,
  ConnectedServiceMaterializationIdentityV1Schema,
  ConnectedServiceAuthGroupPolicyV1Schema,
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountListResponseV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  ingestPluginManifestV2,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceBindingsV2,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import { CODEX_PLUGIN } from '@happier-dev/plugins-codex/manifest';
import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import type { TrackedSession } from '@/daemon/types';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, readConnectedServiceChildSelectionsFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import { isPidSafeHappySessionProcess } from '@/daemon/pidSafety';
import { adoptTrackedSessionRunnerIdentity } from '@/daemon/sessions/sessionReportCorrelation';
import { resolveSessionConnectedServiceSwitchContinuity } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { createConnectedServiceSwitchDeferralQueue } from './connectedServiceSwitchDeferralQueue';
import { createVersionRuntimeRefreshAttemptHandoff } from '@/daemon/plannedRunnerRestart/versionRuntimeRefreshAttemptHandoff';
import type { RestartSessionRunnerCompletion } from '@/daemon/plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { createSessionRunnerRespawnManager } from '@/daemon/processSupervision/sessionRunnerRespawn';
import { requestConnectedServiceSessionRestartSignal } from './requestConnectedServiceSessionRestartSignal';
import { applyConnectedServiceCredentialUpdate } from './credentialApplicationState';
import { createSessionConnectedServiceAuthHotApply } from './sessionConnectedServiceAuthHotApply';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { ConnectedServiceSessionAuthSwitchLockRegistry, createConnectedServiceSessionAuthSwitchCore } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { projectConnectedServiceRuntimeAuthTargetInput } from '../runtimeAuth/projectRuntimeAuthTargetInput';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import {
  applyConnectedServiceAuthGenerationToTrackedSession,
  switchSessionConnectedServiceAuth as switchSessionConnectedServiceAuthImpl,
  type SwitchSessionConnectedServiceAuthInput,
} from './switchSessionConnectedServiceAuth';
import type { ConnectedServiceQualifiedAuthGroupApi } from '../resolveConnectedServiceAuthForSpawn';
import { resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '../runtimeAuth/types';
import type { ApiClient } from '@/api/api';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveConnectedServiceHomeDir } from '../homes/resolveConnectedServiceHomeDir';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { canResumeFromMaterializedState } from '../stateSharing/canResumeFromMaterializedState';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from './materializeSessionConnectedServiceRuntimeAuthSelection';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from './resolveTrackedConnectedServiceSwitchContinuityContext';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry, type ConnectedServiceAuthGroupSwitchState } from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { handleConnectedServiceRuntimeAuthFailureForSession } from '../runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { RuntimeAuthRecoveryScheduler, type RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import { createConnectedServiceContinuationHandler } from '../continuation/switchRecovery';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resolveSharedStateRequiredSwitchContinuity } from './sharedStateContinuity';
import { resolveTrackedSessionRunnerActivity } from '@/daemon/sessionRunnerRuntime/resolveRuntimeState';

let catalogRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  catalogRuntime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.claude', 'happier.agent.codex', 'happier.agent.gemini'] } });
});
afterAll(async () => { await catalogRuntime?.dispose(); });

async function readCodexRuntimeAuthAdapterRegistration() {
  let captured: unknown;
  const ignoreRegistration = vi.fn();
  const api = new Proxy({
    agents: new Proxy({
      register: (_id: string, _factory: unknown, options: unknown) => {
        captured = options;
      },
    }, { get: (target, property) => Reflect.get(target, property) ?? ignoreRegistration }),
  }, {
    get: (target, property) => Reflect.get(target, property) ?? new Proxy({}, { get: () => ignoreRegistration }),
  });
  await CODEX_PLUGIN.activate(api as never);
  const launch = (captured as Readonly<{
    connectedAccountLaunch?: AgentConnectedAccountLaunchContributionV1;
  }> | undefined)?.connectedAccountLaunch;
  if (!launch) return undefined;
  const ingestedManifest = ingestPluginManifestV2(CODEX_PLUGIN.manifest);
  if (!ingestedManifest.ok) {
    throw new Error('Expected the bundled Codex manifest to pass canonical ingestion');
  }
  return await projectAgentConnectedAccountLaunchCatalogEntry({
    pluginId: ingestedManifest.manifest.id,
    agentId: 'codex',
    connectedAccountLaunch: launch,
    hostAccess: ingestedManifest.manifest.hostAccess,
    isCurrent: () => true,
  }).getConnectedServiceRuntimeAuthAdapter?.();
}

type RuntimeAuthSelectionContinuityInput = Parameters<SwitchSessionConnectedServiceAuthInput['resolveContinuity']>[0];
type RecoverAfterRuntimeAuthSwitch = (input: Readonly<{
  tracked: TrackedSession;
  normalizedBindings: ConnectedServiceBindingsV2;
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
  normalizedBindings: ConnectedServiceBindingsV2;
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
type SwitchInputWithPostSwitchRecovery = SwitchTestInput & Readonly<{
  recoverAfterRuntimeAuthSwitch?: RecoverAfterRuntimeAuthSwitch;
}>;
type SwitchInputWithVerification = SwitchInputWithPostSwitchRecovery & Readonly<{
  verifyProviderAccountAdoption?: VerifyProviderAccountAdoption;
}>;

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    trackingKey: legacyPidSessionTrackingKey(overrides.pid ?? 123),
    startedBy: 'daemon',
    happySessionId: 'sess_1',
    pid: 123,
    spawnOptions: {
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.claude/anthropic': { source: 'connected', selection: 'profile', profileId: 'old-profile' },
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

function qualifiedAuthGroupApiForLegacyGroup(input: ConnectedServiceAuthGroupV1) {
  const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' } as const;
  const qualifiedGroup = QualifiedConnectedAccountGroupV4Schema.parse({
    v: 1,
    ref: { service, groupId: input.groupId },
    incarnation: `qualified-group-${input.groupId}`,
    displayName: input.displayName,
    policy: input.policy,
    activeConnectedAccountId: input.activeProfileId,
    generation: input.generation,
    runtimeStateRevision: input.runtimeStateRevision ?? 0,
    state: {},
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    members: input.members.map((member) => ({
      v: 1,
      connectedAccountId: member.profileId,
      priority: member.priority,
      enabled: member.enabled,
      state: member.state,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    })),
  });
  const qualifiedAccounts = QualifiedConnectedAccountListResponseV4Schema.parse({
    service,
    accounts: input.members.map((member) => ({
      ref: { service, accountId: member.profileId },
      status: 'connected',
      authenticationModeId: 'api-key',
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      configurationReady: true,
      configurationRevision: null,
      scopes: [],
    })),
  });
  return {
    readGroup: vi.fn(async () => qualifiedGroup),
    listAccounts: vi.fn(async () => qualifiedAccounts),
  };
}

type LegacyTestConnectedServiceApi = Readonly<{
  getConnectedServiceAuthGroup?: (input: Readonly<{ serviceId: string; groupId: string }>) => Promise<ConnectedServiceAuthGroupV1 | null>;
  listConnectedServiceProfiles?: (input: Readonly<{ serviceId: string }>) => Promise<Readonly<{
    profiles: ReadonlyArray<Readonly<{ profileId: string; status: 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable' }>>;
  }>>;
}>;

function qualifiedAuthGroupApiFromLegacyTestApi(api: unknown): ConnectedServiceQualifiedAuthGroupApi {
  const legacy = api as LegacyTestConnectedServiceApi;
  const resolveLegacyServiceId = (service: Readonly<{ pluginId: string; localId: string }>): string => {
    const entry = Object.entries(BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID)
      .find(([, compatibility]) => (
        compatibility.service.pluginId === service.pluginId
        && compatibility.service.localId === service.localId
      ));
    if (!entry) throw new Error('test_legacy_service_mapping_missing');
    return entry[0];
  };
  return {
    readGroup: async ({ service, groupId }) => {
      const serviceId = resolveLegacyServiceId(service);
      const group = await legacy.getConnectedServiceAuthGroup?.({ serviceId, groupId });
      if (!group) return null;
      return QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1,
        ref: { service, groupId: group.groupId },
        incarnation: `qualified-group-${group.groupId}`,
        displayName: group.displayName,
        policy: group.policy,
        activeConnectedAccountId: group.activeProfileId,
        generation: group.generation,
        runtimeStateRevision: group.runtimeStateRevision ?? 0,
        state: {},
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
        members: group.members.map((member) => ({
          v: 1,
          connectedAccountId: member.profileId,
          priority: member.priority,
          enabled: member.enabled,
          state: member.state,
          createdAt: member.createdAt,
          updatedAt: member.updatedAt,
        })),
      });
    },
    listAccounts: async ({ service }) => {
      const serviceId = resolveLegacyServiceId(service);
      const profiles = await legacy.listConnectedServiceProfiles?.({ serviceId });
      const profileRows = profiles?.profiles ?? [];
      return QualifiedConnectedAccountListResponseV4Schema.parse({
        service,
        accounts: profileRows.map((profile) => ({
          ref: { service, accountId: profile.profileId },
          status: profile.status,
          authenticationModeId: 'api-key',
          revisionSemantics: 'revisioned',
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
          configurationReady: true,
          configurationRevision: null,
          scopes: [],
        })),
      });
    },
  };
}

type SwitchTestInput = Omit<SwitchSessionConnectedServiceAuthInput, 'api' | 'qualifiedConnectedAccountApi'> & Readonly<{
  api: SwitchSessionConnectedServiceAuthInput['api'] & Pick<LegacyTestConnectedServiceApi, 'getConnectedServiceAuthGroup'>;
  qualifiedConnectedAccountApi?: ConnectedServiceQualifiedAuthGroupApi;
}>;

function switchSessionConnectedServiceAuth(input: SwitchTestInput) {
  return switchSessionConnectedServiceAuthImpl({
    ...input,
    qualifiedConnectedAccountApi:
      input.qualifiedConnectedAccountApi ?? qualifiedAuthGroupApiFromLegacyTestApi(input.api),
  });
}

function bindings(profileId: string): ConnectedServiceBindingsV2 {
  return {
    v: 2,
    bindingsByServiceId: {
      'happier.agent.claude/anthropic': { source: 'connected', selection: 'profile', profileId },
    },
  };
}

function codexBindings(profileId: string): ConnectedServiceBindingsV2 {
  return {
    v: 2,
    bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId },
    },
  };
}

function claudeSubscriptionBindings(profileId: string): ConnectedServiceBindingsV2 {
  return {
    v: 2,
    bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId },
    },
  };
}

function multiServiceBindings(input: Readonly<{
  anthropicProfileId: string;
  claudeSubscriptionProfileId: string;
}>): ConnectedServiceBindingsV2 {
  return {
    v: 2,
    bindingsByServiceId: {
      'happier.agent.claude/anthropic': { source: 'connected', selection: 'profile', profileId: input.anthropicProfileId },
      'happier.agent.claude/claude-subscription': {
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
  it('keeps an approved switch armed through the turn boundary without holding its own restart', async () => {
    const tracked = trackedSession({ activeTurnId: 'turn-1', processCommandHash: 'hash', processStartTimeMs: 123 });
    const events: unknown[] = [];
    const writes: ConnectedServiceBindingsV2[] = [];
    const queue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false, emitSessionEvent: async (_, event) => { events.push(event); } });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'task_started' });
    // The approved Action remains in flight until its restart completes (r1110f).
    const operations = [{ method: 'approved-switch', activeForMs: 1,
      sessionEffect: { sessionId: 'sess_1', actionId: 'session.connected_services_auth.set' } }];
    let replacementOptions: TrackedSession['spawnOptions'];
    let completeRestart!: (value: RestartSessionRunnerCompletion) => void;
    const completion = new Promise<RestartSessionRunnerCompletion>(resolve => { completeRestart = resolve; });
    const respawn = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2,
      baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0, isSessionAlreadyRunning: () => false,
      spawnSession: async options => { replacementOptions = options; return { type: 'success', sessionId: 'sess_1' }; },
      onRespawnSuccess: () => completeRestart({ ok: true }),
      onRespawnTerminal: () => completeRestart({ ok: false, status: 'spawn_failed' }),
      random: () => 0, logDebug: () => {}, logWarn: () => {},
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const pending = switchSessionConnectedServiceAuth({ core: createCore(),
        postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(), getChildren: () => [tracked],
        api: { listConnectedServiceProfiles: async () => ({ serviceId: 'happier.agent.claude/anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }] }), getConnectedServiceAuthGroup: async () => null },
        resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
        persistSessionBindings: async ({ normalizedBindings }) => { writes.push(normalizedBindings); },
        restartSession: child => requestPlannedRunnerRestart({ sessionId: 'sess_1', tracked: child,
          deferral: { kind: 'connected_service_switch', source: 'manual', policy: 'defer_until_turn_boundary',
            target: { serviceId: 'happier.agent.claude/anthropic', profileId: 'new-profile', groupId: '', generation: 0 }, turnDeferralQueue: queue },
          restartRequestedSessions: new Set(), trackedSessionsByKey: new Map([[child.trackingKey, child]]),
          completion: { hasPending: () => false, join: () => null,
            create: () => ({ promise: completion, start: () => {}, cancel: () => {} }) },
          isProcessSafeToSignal: async () => true,
          canSignal: () => resolveTrackedSessionRunnerActivity(child, operations, 'session.connected_services_auth.set')?.reasonCode ?? true,
          requestSignal: async request => {
            const result = await requestConnectedServiceSessionRestartSignal({ pid: child.pid, delayMs: 0,
              shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure });
            if (result.status === 'requested') respawn.handleUnexpectedExit(child,
              { reason: 'process-exit', code: 143, signal: 'SIGTERM' }, { forceRestart: true, restartReason: 'connected_service_switch' });
            return result;
          },
        }),
        hotApply: async () => { throw new Error('restart continuity'); }, registerHotApplyTargets: () => {}, emitSessionEvent: () => {},
        request: { sessionId: 'sess_1', agentId: 'claude', bindings: bindings('new-profile') },
      });
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'connected_service_account_switch_deferred' })));
      expect(kill).not.toHaveBeenCalled();
      expect(writes).toEqual([bindings('new-profile')]);
      delete tracked.activeTurnId;
      queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
      const result = await pending;
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, action: 'restart_requested' });
      expect(kill).toHaveBeenCalledExactlyOnceWith(tracked.pid, 'SIGTERM');
      expect(writes).toEqual([bindings('new-profile')]);
      // The replacement/next prompt consumes these persisted spawn bindings.
      expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
      expect(replacementOptions?.connectedServices).toEqual(bindings('new-profile'));
    } finally { await queue.cancelAll('daemon_shutdown'); kill.mockRestore(); }
  });
  it('applies every committed group revision through one native effect when binding intent is unchanged', async () => {
    const serviceIds = ['happier.agent.claude/anthropic', 'happier.agent.claude/claude-subscription'] as const;
    const selectedBindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: Object.fromEntries(
      serviceIds.map(serviceId => [serviceId, { source: 'connected', selection: 'group', groupId: 'work', profileId: 'selected' }]),
    ) };
    const tracked = trackedSession({ spawnOptions: { directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'claude' }, connectedServices: selectedBindings } });
    const appliedServices: string[][] = [];
    const api = {
      listConnectedServiceProfiles: async ({ serviceId }: { serviceId: string }) => ({ serviceId,
        profiles: [{ profileId: 'selected', status: 'connected' as const }] }),
      getConnectedServiceAuthGroup: async () => group({ activeProfileId: 'selected', generation: 8,
        members: [{ ...group().members[0]!, profileId: 'selected' }] }),
    };
    const result = await switchSessionConnectedServiceAuth({ core: createCore(), getChildren: () => [tracked], api,
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      resolveContinuity: context => resolveSessionConnectedServiceSwitchContinuity({
        sessionId: context.sessionId, agentId: context.agentId, serviceId: context.serviceId,
        previousBinding: context.previous, nextBinding: context.next, tracked,
        fromBindingsRaw: context.previousBindings, toBindings: context.normalizedBindings, accountSettings: null,
      }),
      // Process replacement is the external effect. Both accepted services must
      // already be projected in the spawn environment before replacing the runner.
      restartSession: async child => { appliedServices.push(Array.from(readConnectedServiceChildSelectionsFromEnv(
        child.spawnOptions?.environmentVariables ?? {},
      )?.keys() ?? [])); },
      hotApply: async () => { throw new Error('Claude same-group continuity requires restart'); },
      persistSessionBindings: async () => {}, registerHotApplyTargets: () => {}, emitSessionEvent: () => {},
      request: { sessionId: 'sess_1', agentId: 'claude', bindings: selectedBindings,
        expectedGroupGenerationByServiceId: Object.fromEntries(serviceIds.map(serviceId => [serviceId, 8])) },
    });
    expect(result).toMatchObject({ ok: true, action: 'restart_requested', continuityByServiceId: {
      [serviceIds[0]]: 'restart_rematerialize', [serviceIds[1]]: 'restart_rematerialize',
    } });
    expect(appliedServices).toEqual([expect.arrayContaining([...serviceIds])]);
  });

  it.each([
    ['hot_apply', 'failed', 'exact', false], ['restart_rematerialize', 'failed', 'exact', false],
    ['hot_apply', 'newer_work', 'exact', false], ['restart_rematerialize', 'newer_work', 'exact', false],
    ['hot_apply', 'delayed_projection', 'exact', false], ['restart_rematerialize', 'delayed_projection', 'exact', false],
    ['hot_apply', 'failed', 'weak', false], ['hot_apply', 'failed', 'account_only', false],
    ['restart_unchanged', 'failed', 'exact', false],
    ['restart_rematerialize', 'failed', 'exact', true], ['restart_unchanged', 'failed', 'exact', true],
  ] as const)('uses only recovery continuation identity and admission through the real primitive (%s, %s, %s, replacement refresh=%s)', async (mode, projection, verification, replacementRefresh) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-primitive-recovery-'));
    const agentId = mode === 'hot_apply' ? 'codex' : 'claude';
    const serviceId = mode === 'hot_apply' ? 'happier.agent.codex/openai-codex' : 'happier.agent.claude/anthropic';
    const sessionId = 'c123456789012345678901234';
    const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const handedRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const replacementRevision = replacementRefresh ? 'csr_cccccccccccccccccccccc' : handedRevision;
    let materializationRevision = handedRevision;
    let stagedSelection: Parameters<typeof materializeSessionConnectedServiceRuntimeAuthSelection>[0]['input'] | undefined;
    const credentials = { token: 'fixture', encryption: null };
    const makeBindings = (profileId: string): ConnectedServiceBindingsV2 => ({ v: 2, bindingsByServiceId: {
      [serviceId]: { source: 'connected', selection: 'group', groupId: 'work', profileId },
    } });
    const tracked = trackedSession({ happySessionId: sessionId,
      activeTurnId: projection === 'newer_work' ? 'new-user-turn' : 'interrupted-turn',
      spawnOptions: { directory, backendTarget: { kind: 'backend', backendId: agentId }, connectedServices: makeBindings(mode === 'restart_unchanged' ? 'B' : 'A') } });
    let current: ConnectedServiceAuthGroupSwitchState = { serviceId, groupId: 'work', activeProfileId: 'A', generation: 1,
      credentialRevision: revision,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, autoSwitch: true, strategy: 'priority' },
      members: ['A', 'B'].map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: 1 })),
      memberStatesByProfileId: new Map([['B', { quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: 60 } }]]),
    };
    let runtime = { serviceId, groupId: 'work', profileId: 'A', generation: 1, credentialRevision: revision };
    const consumed = new Set<string>();
    const sends: string[] = [];
    let restarts = 0;
    let appliedResult: Awaited<ReturnType<typeof applyConnectedServiceAuthGenerationToTrackedSession>> | undefined;
    // Only Home HTTP, binding persistence, and provider/process application are replaced.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).includes('/v4/connect/qualified/credential')) return { status: 200,
        data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
          ref: { service: mode === 'hot_apply' ? { pluginId: 'happier.agent.codex', localId: 'openai-codex' }
            : { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'B' },
          authenticationModeId: mode === 'hot_apply' ? 'oauth' : 'api-key', revisionSemantics: 'revisioned', credentialRevision: materializationRevision,
          configurationRevision: null, content: { t: 'plain', v: { v: 1, values: mode === 'hot_apply'
            ? { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' } : { apiKey: 'fixture-key' } } }, metadata: { scopes: [] },
        }) };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        latestTurnId: 'interrupted-turn', latestTurnStatus: projection === 'delayed_projection' ? 'in_progress' : 'failed',
        latestTurnStatusObservedAt: 900, lastRuntimeIssue: null }) } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      if (!body || typeof body !== 'object' || !('localId' in body) || typeof body.localId !== 'string') {
        throw new Error('Expected continuation message at the HTTP boundary');
      }
      sends.push(body.localId);
      const didWrite = !consumed.has(body.localId);
      consumed.add(body.localId);
      return { status: 200, data: { didWrite, terminal: false } };
    });
    let interruptedOriginId: string | undefined;
    const api = { getAccountEncryptionMode: async () => 'plain' as const,
      listConnectedServiceProfiles: async () => ({ serviceId, profiles: ['A', 'B'].map(profileId => ({ profileId, status: 'connected' as const })) }),
      getConnectedServiceAuthGroup: async () => group({ activeProfileId: current.activeProfileId, generation: current.generation,
        members: ['A', 'B'].map(profileId => ({ ...group().members[0]!, profileId })) }) };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000,
      loadState: async () => current,
      commitSwitch: async ({ toProfileId }) => current = { ...current, activeProfileId: toProfileId, generation: 2 },
      applyGeneration: async input => {
        const adopted = () => { runtime = { ...runtime, profileId: input.activeProfileId!, generation: input.generation, credentialRevision: handedRevision }; };
        const result = await applyConnectedServiceAuthGenerationToTrackedSession({
          getChildren: () => [tracked], api, qualifiedConnectedAccountApi: qualifiedAuthGroupApiFromLegacyTestApi(api),
          reason: 'automatic_runtime_failure', runtimeAuthApplyReason: 'usage_limit',
          materializeRuntimeAuthSelection: selection => {
            stagedSelection = selection;
            return materializeSessionConnectedServiceRuntimeAuthSelection({
              credentials, api: api as unknown as ApiClient, input: selection,
            });
          },
          resolveContinuity: context => resolveSessionConnectedServiceSwitchContinuity({
            sessionId: context.sessionId, agentId: context.agentId, serviceId: context.serviceId,
            previousBinding: context.previous, nextBinding: context.next, tracked,
            fromBindingsRaw: context.previousBindings, toBindings: context.normalizedBindings, accountSettings: null,
          }),
          restartSession: async child => {
            restarts++;
            expect(readConnectedServiceChildSelectionsFromEnv(child.spawnOptions?.environmentVariables ?? {})?.get(serviceId))
              .toMatchObject({ credentialRevision: handedRevision });
            // Replacement launch resolves credentials again. Refresh Home between staging
            // and that resolution, retaining the same selected account and generation.
            materializationRevision = replacementRevision;
            if (!stagedSelection) throw new Error('Expected staged materialization input');
            const replacementSelection = await materializeSessionConnectedServiceRuntimeAuthSelection({
              credentials, api: api as unknown as ApiClient, input: stagedSelection,
            });
            expect(replacementSelection).toMatchObject({ credentialRevision: replacementRevision });
            if (!replacementSelection || typeof replacementSelection !== 'object'
              || !('credentialRevision' in replacementSelection) || typeof replacementSelection.credentialRevision !== 'string') {
              throw new Error('Expected replacement credential revision');
            }
            runtime = { ...runtime, profileId: input.activeProfileId!, generation: input.generation,
              credentialRevision: replacementSelection.credentialRevision };
            return { signaled: true, completion: { ok: true } };
          },
          persistSessionBindings: async () => {}, registerHotApplyTargets: () => {}, emitSessionEvent: () => {},
          hotApply: async () => { adopted(); return { ok: true }; },
          verifyProviderAccountAdoption: async () => verification === 'weak'
            ? { status: 'weakly_verified', providerAccountId: 'provider-B', reason: 'account_email_only' }
            : { status: 'verified', proofStrength: 'exact', providerAccountId: 'provider-B',
                ...(verification === 'exact' ? { generationApplication: { serviceId, groupId: 'work', profileId: 'B', generation: 2, credentialRevision: handedRevision,
                  credentialFingerprint: 'fixture-provider-B' } } : {}) },
          continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({ credentials, interruptedOriginId,
            resumePromptMode: 'standard', resolveInterruption: () => 'provider_failed_turn' }),
          request: { sessionId, agentId, bindings: makeBindings(input.activeProfileId!),
            expectedGroupGenerationByServiceId: { [serviceId]: input.generation } },
        });
        appliedResult = result;
        if (!result.ok) return result;
        return { ...result, mode: result.action === 'restart_requested' ? 'restart_resume' : 'hot_apply' };
      },
    });
    const makeScheduler = () => {
      const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1_000, jitterMs: () => 0,
        durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(join(directory, 'recovery.json')),
        recover: input => {
          interruptedOriginId = input.interruptedOriginId;
          return handleConnectedServiceRuntimeAuthFailureForSession({ ...input, getChildren: () => [tracked], switchCoordinator: coordinator,
            resolveRegisteredRuntimeAuthFailureSource: async () => runtime,
            continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({ credentials, interruptedOriginId,
              resumePromptMode: 'standard', resolveInterruption: () => 'provider_failed_turn',
              runtimeAuthRecovery: { armedAtMs: 1_000,
                isCurrent: () => scheduler.readForSession(sessionId).some(intent => intent.attemptId === interruptedOriginId
                  && (intent.status === 'waiting' || intent.status === 'checking' || intent.status === 'resumed_awaiting_proof')),
                readActiveTurnId: () => tracked.activeTurnId ?? null } }),
          });
        },
      });
      return scheduler;
    };
    const first = makeScheduler();
    let replacement: RuntimeAuthRecoveryScheduler | undefined;
    try {
      await first.beginClassifiedFailure({ reportId: 'runtime-auth-report:primitive-continuation', sessionId, switchesThisTurn: 0, classification: { kind: 'usage_limit', limitCategory: 'usage_limit',
        quotaScope: 'account', serviceId, profileId: 'A', groupId: 'work', groupGeneration: 1, expectedCredentialRevision: revision,
        resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' } });
      await first.wake({ sessionId, reason: 'manual' });
      expect(runtime.profileId).toBe('B');
      expect(restarts).toBe(mode === 'hot_apply' ? 0 : 1);
      expect(appliedResult?.ok).toBe(true);
      if (!appliedResult?.ok) throw new Error('Expected successful application');
      if (mode === 'hot_apply') {
        expect(appliedResult.materializedTargetByServiceId?.[serviceId]).toMatchObject({ profileId: 'B', generation: 2, credentialRevision: handedRevision });
      } else {
        // Process completion carries no replacement credential receipt. The staged
        // revision is not a fact about the replacement's actual materialization.
        expect(appliedResult.materializedTargetByServiceId).toBeUndefined();
        expect(appliedResult.verificationByServiceId).toBeUndefined();
      }
      if (mode === 'hot_apply' && verification !== 'exact') {
        expect(appliedResult.verificationByServiceId?.[serviceId]?.status).toBe(verification === 'weak' ? 'weakly_verified' : 'verified');
        expect(appliedResult.verificationByServiceId?.[serviceId]?.generationApplication).toBeUndefined();
      }
      expect(consumed.size).toBe(projection === 'failed' ? 1 : 0);
      expect(sends).toHaveLength(projection === 'failed' ? 1 : 0);
      if (projection === 'failed') {
        expect(first.readForSession(sessionId)[0]).toMatchObject({ pendingTargetCredentialRevision: mode === 'hot_apply' ? handedRevision : null });
        if (mode !== 'hot_apply') {
          expect(await first.markProviderOutcomeProofByIdentity({ sessionId, serviceId, groupId: 'work', profileId: 'B', groupGeneration: 2,
            credentialRevision: replacementRevision, proofKind: 'provider_activity', observedAtMs: 1_001 })).toEqual([]);
        }
      }
      // Existing retry/registration settlement reconstructs the replacement target
      // once Home catches up; the unproven result itself must not admit activity.
      current = { ...current, credentialRevision: replacementRevision };
      first.dispose();
      replacement = makeScheduler();
      replacement.hydratePassive();
      await replacement.wake({ sessionId, reason: 'manual' });
      expect(consumed.size).toBe(projection === 'failed' ? 1 : 0);
      if (projection === 'failed') expect(sends).toHaveLength(2);
      if (projection === 'delayed_projection') expect(replacement.readForSession(sessionId)[0]).toMatchObject({ status: 'waiting' });
      if (projection === 'failed') {
        expect(replacement.readForSession(sessionId)[0]).toMatchObject({ pendingTargetCredentialRevision: replacementRevision });
        expect(await replacement.markProviderOutcomeProofByIdentity({ sessionId, serviceId, groupId: 'work', profileId: 'B', groupGeneration: 2,
          credentialRevision: replacementRevision, proofKind: 'provider_activity', observedAtMs: 1_001 }))
          .toEqual([expect.objectContaining({ status: 'recovered' })]);
      }
    } finally { first.dispose(); replacement?.dispose(); get.mockRestore(); post.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  });
  it.each(['manual', 'automatic', 'rematerialize', 'rollback_failed'] as const)('retains a deferred executable replacement refusal (%s)', async mode => {
    const tracked = trackedSession({ processStartTimeMs: 100, processCommandHash: 'launcher-hash' });
    const runner = { pid: 124, processStartTimeMs: 200, processCommandHash: 'runner-hash', processCommand: 'runner' };
    adoptTrackedSessionRunnerIdentity(tracked, runner);
    const groupBindings = (profileId: string): ConnectedServiceBindingsV2 => ({ v: 2, bindingsByServiceId: {
      'happier.agent.claude/anthropic': { source: 'connected', selection: 'group', groupId: 'work', profileId },
    } });
    const previousBindings = groupBindings(mode === 'rematerialize' ? 'new-profile' : 'old-profile');
    tracked.spawnOptions = { ...tracked.spawnOptions!, connectedServices: previousBindings };
    const previousSpawnOptions = tracked.spawnOptions;
    const profileId = 'new-profile';
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    let deferred!: () => void;
    const pendingBoundary = new Promise<void>(resolve => { deferred = resolve; });
    const queue = createConnectedServiceSwitchDeferralQueue({ disableDeferral: false,
      emitSessionEvent: (_sessionId, event) => {
        if (typeof event === 'object' && event !== null && 'type' in event
          && event.type === 'connected_service_account_switch_deferred') deferred();
      },
    });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'prompt_or_steer' });
    const persisted: ConnectedServiceBindingsV2[] = [];
    // Process identity observations and signalling are the OS boundaries.
    const signals = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const selectedGroup = group({ activeProfileId: profileId, members: ['old-profile', profileId].map(id => ({
      ...group().members[0]!, profileId: id,
    })) });
    const api = { listConnectedServiceProfiles: async () => ({ serviceId: 'happier.agent.claude/anthropic',
      profiles: [{ profileId, status: 'connected' as const }] }), getConnectedServiceAuthGroup: async () => selectedGroup };
    const input: SwitchSessionConnectedServiceAuthInput = {
      core: createCore(), getChildren: () => [tracked], api,
      qualifiedConnectedAccountApi: qualifiedAuthGroupApiFromLegacyTestApi(api),
      reason: mode === 'manual' ? 'manual' : 'automatic_runtime_failure',
      resolveContinuity: context => resolveSessionConnectedServiceSwitchContinuity({
        sessionId: context.sessionId, agentId: context.agentId, serviceId: context.serviceId,
        previousBinding: context.previous, nextBinding: context.next, tracked,
        fromBindingsRaw: context.previousBindings, toBindings: context.normalizedBindings, accountSettings: null,
      }),
      restartSession: child => requestPlannedRunnerRestart({ sessionId: 'sess_1', tracked: child,
        restartRequestedSessions, trackedSessionsByKey: new Map([[child.trackingKey, child]]),
        deferral: { kind: 'connected_service_switch', source: mode === 'manual' ? 'manual' : 'automatic',
          policy: 'defer_until_turn_boundary', turnDeferralQueue: queue,
          target: { serviceId: 'happier.agent.claude/anthropic', profileId, groupId: 'work', generation: 4 } },
        isProcessSafeToSignal: witness => isPidSafeHappySessionProcess(witness, {
          readProcessIdentityByPidFn: async pid => ({ pid, processStartTimeMs: pid === child.pid ? 100 : 200,
            command: 'fixture-runner' }),
        }),
        requestSignal: request => requestConnectedServiceSessionRestartSignal({ pid: child.pid, delayMs: 0,
          shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure }),
      }),
      persistSessionBindings: async ({ normalizedBindings }) => {
        if (mode === 'rollback_failed' && persisted.length > 0) throw new Error('Metadata transport unavailable');
        persisted.push(normalizedBindings);
      },
      hotApply: async () => { throw new Error('Unexpected hot apply'); },
      registerHotApplyTargets: () => {}, emitSessionEvent: () => {},
      request: { sessionId: 'sess_1', agentId: 'claude', bindings: groupBindings(profileId),
        ...(mode === 'rematerialize' ? { rematerializeServiceId: 'happier.agent.claude/anthropic' } : {}) },
    };
    try {
      const pending = mode === 'manual' ? switchSessionConnectedServiceAuthImpl(input)
        : applyConnectedServiceAuthGenerationToTrackedSession(input);
      await Promise.race([pendingBoundary, pending.then(result => {
        throw new Error(`Switch settled before restart deferral: ${JSON.stringify(result)}`);
      })]);
      adoptTrackedSessionRunnerIdentity(tracked, { ...runner, pid: 125, processStartTimeMs: 300 });
      queue.recordTurnLifecycleEvent({ sessionId: 'sess_1', event: 'assistant_message_end' });
      await expect(pending).resolves.toMatchObject({ ok: false,
        errorCode: mode === 'rollback_failed' ? 'partial_applied_pending_reconciliation' : 'restart_failed',
        diagnostics: { failurePhase: mode === 'rollback_failed' ? 'reconciliation' : 'restart',
          restartRefusalReason: 'runner_identity_changed', retryable: false } });
      expect(signals).not.toHaveBeenCalled();
      expect(restartRequestedSessions.size).toBe(0);
      expect(tracked.spawnOptions).toBe(previousSpawnOptions);
      if (mode !== 'rematerialize' && mode !== 'rollback_failed') expect(persisted.at(-1)).toEqual(previousBindings);
    } finally {
      await queue.cancelAll('daemon_shutdown');
      signals.mockRestore();
    }
  });

  it.each(['profile', 'group', 'group_activity', 'group_capture', 'group_overlap_failed', 'group_overlap_thrown', 'group_overlap_accepted'] as const)('admits one account-change restart only for a fresh credential revision (%s)', async scenario => {
    const selection = scenario === 'profile' ? 'profile' : 'group';
    const serviceId = selection === 'profile' ? 'happier.agent.codex/openai-codex' : 'happier.agent.claude/anthropic';
    const agentId = selection === 'profile' ? 'codex' : 'claude';
    const selectedBindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: { [serviceId]: selection === 'group'
      ? { source: 'connected', selection: 'group', profileId: 'selected', groupId: 'pool' }
      : { source: 'connected', selection: 'profile', profileId: 'selected' },
    } };
    const selectedGroup = group({ groupId: 'pool', activeProfileId: 'selected', generation: 7,
      members: group().members.map(member => ({ ...member, profileId: 'selected' })) });
    let revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    let tracked = trackedSession({ pid: 2147482901, processStartTimeMs: 1, processCommandHash: 'a'.repeat(64), spawnOptions: {
      directory: '/tmp/project', backendTarget: { kind: 'backend', backendId: agentId, sourceKind: 'built_in' },
      connectedServices: selectedBindings,
      connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_revision_cutover', createdAt: 1 },
      environmentVariables: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
        selection === 'profile' ? { kind: 'profile', serviceId, profileId: 'selected', credentialRevision: revision }
          : { kind: 'group', serviceId, groupId: 'pool', activeProfileId: 'selected', fallbackProfileId: 'selected',
              generation: 7, policy: selectedGroup.policy, credentialRevision: revision },
      ]) },
    } });
    const accountApi = { getAccountEncryptionMode: async () => 'plain' as const,
      getConnectedServiceAuthGroup: async () => selectedGroup,
      listConnectedServiceProfiles: async () => ({ serviceId: selectedGroup.serviceId,
        profiles: [{ profileId: 'selected', status: 'connected' as const }] }) };
    // Qualified Home HTTP and the physical restart are the external boundaries.
    const transport = vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200,
      data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: { service: selection === 'profile' ? { pluginId: 'happier.agent.codex', localId: 'openai-codex' }
          : { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'selected' },
        authenticationModeId: selection === 'profile' ? 'oauth' : 'api-key', revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null,
        content: { t: 'plain', v: { v: 1, values: selection === 'profile'
          ? { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' } : { apiKey: 'synthetic-key' } } },
        metadata: { scopes: [] },
      }) }));
    const restarts: number[] = [];
    const trackedByPid = new Map([[tracked.trackingKey, tracked]]);
    const restartRequestedSessions = new Set<SessionTrackingKey>();
    const handoff = createVersionRuntimeRefreshAttemptHandoff<RestartSessionRunnerCompletion>({ timeoutMs: null,
      timeoutCompletion: { ok: false, status: 'partial_failure' },
      supersededCompletion: { ok: false, status: 'partial_failure' },
      cancelledCompletion: { ok: false, status: 'partial_failure', diagnostics: { respawnTerminalReason: 'cancelled_before_signal' } },
    });
    let signalAllowed = false;
    let successor: TrackedSession | undefined;
    let resolveSuccessor!: () => void;
    const successorReady = new Promise<void>(resolve => { resolveSuccessor = resolve; });
    const respawn = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2,
      baseDelayMs: 50, maxDelayMs: 50, jitterMs: 0,
      isSessionAlreadyRunning: sessionId => [...trackedByPid.values()].some(child => child.happySessionId === sessionId),
      // This is the OS spawn boundary. Observe the actual respawn owner's options.
      spawnSession: async options => {
        successor = { trackingKey: legacyPidSessionTrackingKey(tracked.pid + 1), startedBy: 'daemon', happySessionId: 'sess_1', pid: tracked.pid + 1,
          processStartTimeMs: 2, processCommandHash: 'b'.repeat(64), spawnOptions: options };
        tracked = successor;
        trackedByPid.set(tracked.trackingKey, tracked);
        return { type: 'success', sessionId: tracked.happySessionId };
      },
      onRespawnSuccess: ({ sessionId, previousPid, previousTrackingKey }) => {
        restartRequestedSessions.delete(previousTrackingKey);
        handoff.settle(sessionId, previousPid, { ok: true });
        resolveSuccessor();
      },
      onRespawnTerminal: ({ sessionId, previousPid, previousTrackingKey }) => {
        restartRequestedSessions.delete(previousTrackingKey);
        handoff.settle(sessionId, previousPid, { ok: false, status: 'spawn_failed' });
      },
      random: () => 0, logDebug: () => {}, logWarn: () => {},
    });
    const signalBoundary = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== tracked.pid || signal !== 'SIGTERM') throw new Error('Unexpected process signal');
      restarts.push(pid);
      return true;
    });
    const core = createCore();
    const overlaps = scenario === 'group_overlap_failed' || scenario === 'group_overlap_thrown' || scenario === 'group_overlap_accepted';
    let pauseAdmission = overlaps;
    let releaseAdmission!: () => void;
    let enterAdmission!: () => void;
    const admissionEntered = new Promise<void>(resolve => { enterAdmission = resolve; });
    const admissionRelease = new Promise<void>(resolve => { releaseAdmission = resolve; });
    const { resolveSessionConnectedServiceSwitchContinuity } = await import('@/daemon/startup/startDaemonSessionControlRuntime');
    const apply = (materialize = true) => applyConnectedServiceAuthGenerationToTrackedSession({
      getChildren: () => [...trackedByPid.values()], api: accountApi,
      qualifiedConnectedAccountApi: qualifiedAuthGroupApiFromLegacyTestApi(accountApi),
      runtimeAuthApplyReason: 'account_changed',
      materializeRuntimeAuthSelection: materialize ? input => materializeSessionConnectedServiceRuntimeAuthSelection({
        credentials: { token: 'synthetic-token', encryption: null }, api: accountApi as unknown as ApiClient, input,
      }) : undefined,
      resolveContinuity: input => resolveSessionConnectedServiceSwitchContinuity({
        sessionId: input.sessionId, agentId: input.agentId, serviceId: input.serviceId,
        previousBinding: input.previous, nextBinding: input.next, tracked,
        fromBindingsRaw: tracked.spawnOptions?.connectedServices, toBindings: input.normalizedBindings,
        accountSettings: null, runtimeAuthSelection: input.runtimeAuthSelection,
      }),
      restartSession: async child => await requestPlannedRunnerRestart({
        sessionId: 'sess_1', tracked: child, reason: 'account_changed', deferral: { kind: 'none' },
        restartRequestedSessions, trackedSessionsByKey: trackedByPid,
        completion: {
          hasPending: () => handoff.has('sess_1', child.pid),
          join: () => handoff.join({ sessionId: 'sess_1', previousPid: child.pid, tracked: child,
            transientSpawnOptions: child.spawnOptions }),
          create: () => handoff.create({ sessionId: 'sess_1', previousPid: child.pid, tracked: child,
            transientSpawnOptions: child.spawnOptions }),
        },
        isProcessSafeToSignal: async witness => witness.pid === child.pid
          && witness.expectedProcessStartTimeMs === child.processStartTimeMs
          && witness.expectedProcessCommandHash === child.processCommandHash,
        canSignal: async () => {
          const allowed = signalAllowed || scenario === 'group_capture';
          if (pauseAdmission) { pauseAdmission = false; enterAdmission(); await admissionRelease; }
          if (!allowed && scenario === 'group_overlap_thrown') throw new Error('External restart refused before signal');
          // `false` is the gate's activity refusal; a named reason is a restart-disabled refusal.
          return allowed ? true : scenario === 'group_activity' ? false : 'approval_pending';
        },
        captureRunnerRemainder: scenario === 'group_capture' ? async () => signalAllowed
          ? { scope: 'subtree', roots: [], ownership: [] } : undefined : undefined,
        requestSignal: async request => {
          const result = await requestConnectedServiceSessionRestartSignal({ pid: child.pid, delayMs: 0,
            shouldSignal: request.shouldSignal, onSignalFailure: request.onSignalFailure });
          if (result.status === 'requested') {
            trackedByPid.delete(child.trackingKey);
            respawn.handleUnexpectedExit(child, { reason: 'process-exit', code: 143, signal: 'SIGTERM' },
              { forceRestart: true, restartReason: 'account_changed' });
          }
          return result;
        },
      }),
      hotApply: async () => { throw new Error('Unexpected hot apply'); },
      registerHotApplyTargets: () => {}, emitSessionEvent: async () => {},
      request: { sessionId: 'sess_1', agentId, bindings: selectedBindings, rematerializeServiceId: serviceId,
        ...(selection === 'group' ? { expectedGroupGenerationByServiceId: { [serviceId]: 7 } } : {}) },
    });
    const admittedRevisions: Array<string | undefined> = [];
    const pendingApplications: Promise<unknown>[] = [];
    const notify = () => {
      const application = applyConnectedServiceCredentialUpdate({ sessionId: 'sess_1', serviceId,
      profileId: 'selected', core,
      getTrackedSession: sessionId => {
        const child = [...trackedByPid.values()].find(item => item.happySessionId === sessionId) ?? null;
        admittedRevisions.push(readConnectedServiceChildSelectionsFromEnv(child?.spawnOptions?.environmentVariables ?? {})
          ?.get(serviceId)?.credentialRevision);
        return child;
      },
        applyGeneration: () => apply(),
      });
      pendingApplications.push(application);
      return application;
    };
    try {
      const unchanged = await apply();
      expect(unchanged.ok && unchanged.action, JSON.stringify(unchanged)).toBe('unchanged');
      expect(restarts).toEqual([]);
      await expect(apply(false)).resolves.toMatchObject({ ok: false, errorCode: 'profile_missing',
        diagnostics: { failurePhase: 'materialization' } });
      expect(restarts).toEqual([]);
      // Codex supports in-place application; the restart-required cutover is
      // exercised through Claude's real same-group continuity contribution.
      if (selection === 'profile') return;
      revision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
      const original = tracked;
      const originalSpawnOptions = tracked.spawnOptions;
      if (overlaps) {
        signalAllowed = scenario === 'group_overlap_accepted';
        const first = notify();
        await admissionEntered;
        expect(readConnectedServiceChildSelectionsFromEnv(original.spawnOptions?.environmentVariables ?? {})
          ?.get(serviceId)?.credentialRevision).toBe(revision);
        const second = notify();
        let secondSettled = false;
        void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(secondSettled).toBe(false);
        signalAllowed = true;
        releaseAdmission();
        const results = await Promise.all([first, second]);
        expect(results).toEqual(scenario === 'group_overlap_accepted'
          ? [{ status: 'restart_requested' }, { status: 'unchanged' }]
          : [{ status: 'failed', errorCode: 'restart_failed' }, { status: 'restart_requested' }]);
        expect(admittedRevisions).toEqual(scenario === 'group_overlap_accepted'
          ? ['csr_aaaaaaaaaaaaaaaaaaaaaa', revision]
          : ['csr_aaaaaaaaaaaaaaaaaaaaaa', 'csr_aaaaaaaaaaaaaaaaaaaaaa']);
      } else {
        const declined = await notify();
        expect(declined).toEqual({ status: 'failed', errorCode: 'restart_failed' });
        expect(restarts).toEqual([]);
        expect(tracked.spawnOptions).toBe(originalSpawnOptions);
        expect(restartRequestedSessions.size).toBe(0);
        expect(successor).toBeUndefined();
        signalAllowed = true;
        expect(await notify()).toEqual({ status: 'restart_requested' });
      }
      await successorReady;
      expect(restarts).toEqual([original.pid]);
      expect(successor?.pid).not.toBe(original.pid);
      expect(readConnectedServiceChildSelectionsFromEnv(successor?.spawnOptions?.environmentVariables ?? {})?.get(serviceId))
        .toMatchObject({ kind: 'group', credentialRevision: revision });
      const repeated = await notify();
      expect(repeated).toEqual({ status: 'unchanged' });
      expect(restarts).toEqual([original.pid]);
    } finally {
      releaseAdmission();
      await Promise.allSettled(pendingApplications);
      if (restarts.length > 0) await successorReady;
      transport.mockRestore(); signalBoundary.mockRestore();
    }
  });
  it('preflights an inactive account change against its actual target without writing credentials or metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-inactive-target-preflight-'));
    const unexpectedAccountBoundary = async (): Promise<never> => { throw new Error('Inactive preflight must not write account state or credentials'); };
    const purposeOwner = createConnectedAccountPurposeBindingOwner({
      store: { read: unexpectedAccountBoundary, update: unexpectedAccountBoundary, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpectedAccountBoundary,
      projectTargetAccounts: unexpectedAccountBoundary,
      assertTargetAccountMaterializable: unexpectedAccountBoundary,
      resolveTarget: async target => target.kind === 'account'
        ? { displayName: target.account.accountId, account: target.account }
        : { displayName: target.groupId, account: { service: target.service, accountId: 'backup' } },
      materializeAccount: unexpectedAccountBoundary,
    });
    const runtime = await createAdmittedPluginRuntimeFixture({
      runtimeOptions: { pluginIds: ['happier.agent.codex'], connectedAccounts: purposeOwner } });
    const vendorResumeId = '019c1234-1234-7123-8123-123456789abc';
    const serviceId = 'happier.agent.codex/openai-codex';
    const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const nextBindings = codexBindings('next');
    const accountApi = { getAccountEncryptionMode: async () => 'plain' as const,
      getConnectedServiceAuthGroup: async () => null,
      listConnectedServiceProfiles: async () => ({ serviceId: 'openai-codex' as const,
        profiles: [{ profileId: 'next', status: 'connected' as const }] }) };
    const transport = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'next' },
      authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision, configurationRevision: null,
      content: { t: 'plain', v: { v: 1, values: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' } } },
      metadata: { scopes: [] },
    }) });
    try {
      const target = join(resolveConnectedServiceHomeDir({
        activeServerDir: root, serviceId, profileId: 'next', agentId: 'codex',
      }), 'codex-home');
      await mkdir(join(target, 'sessions'), { recursive: true });
      await writeFile(join(target, 'sessions', `rollout-2026-10-11T12-00-00-${vendorResumeId}.jsonl`), '{}\n');
      const materializationIdentity = ConnectedServiceMaterializationIdentityV1Schema.parse({ v: 1, id: 'csm_inactive_target', createdAt: 0 });
      const runtimeTargets = new ConnectedServiceRuntimeRegistry();
      const { commitConnectedServiceHotApplyRuntimeTarget } = await import('@/daemon/startup/startDaemonSessionControlRuntime');
      const persistSessionBindings = vi.fn();
      const result = await switchSessionConnectedServiceAuth({
        core: createConnectedServiceSessionAuthSwitchCore({ locks: new ConnectedServiceSessionAuthSwitchLockRegistry() }),
        dryRun: true, getChildren: () => [], api: accountApi,
        resolveInactiveSession: async () => ({ agentId: 'codex', connectedServices: codexBindings('old'),
          connectedServiceMaterializationIdentityV1: materializationIdentity, vendorResumeId, cwd: root,
          metadata: { path: root, runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { providerSessionId: vendorResumeId } } } }),
        materializeRuntimeAuthSelection: async (input) => await materializeSessionConnectedServiceRuntimeAuthSelection({
          credentials: { token: 'synthetic-account-token', encryption: null }, api: accountApi as unknown as ApiClient,
          activeServerDir: root, baseDir: join(root, 'materialized'), input,
          connectedAccountsOwner: purposeOwner, activatePurposeBindings: purposeOwner.activatePurposeBindings,
          processEnv: { HOME: join(root, 'empty-native-home') },
        }),
        resolveContinuity: async (input) => {
          const context = resolveTrackedConnectedServiceSwitchContinuityContext({
            agentId: input.agentId, baseDir: root, tracked: input.tracked,
            connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1,
            vendorResumeId: input.vendorResumeId, cwd: root, runtimeAuthSelection: input.runtimeAuthSelection,
          });
          const reachable = await canResumeFromMaterializedState({
            agentId: 'codex', serviceId, targetMaterializedRoot: context.targetMaterializedRoot ?? '',
            requestedStateMode: 'isolated', effectiveStateMode: 'isolated',
            materializationIdentity: { v: 1, id: 'csm_inactive_target' }, vendorResumeId, cwd: root,
          });
          return reachable.ok ? { mode: 'restart_rematerialize' } : { mode: 'unsupported', reason: 'provider_session_state_unavailable_for_resume', errorCode: 'provider_session_state_unavailable_for_resume' };
        },
        registerHotApplyTargets: input => commitConnectedServiceHotApplyRuntimeTarget({
          ...input, agentId: 'codex', materializationIdentity, registry: runtimeTargets,
        }),
        persistSessionBindings, emitSessionEvent: async () => {},
        restartSession: async () => { throw new Error('inactive preflight cannot restart'); },
        hotApply: async () => { throw new Error('inactive preflight cannot hot-apply'); },
        request: { sessionId: 'inactive', agentId: 'codex', bindings: nextBindings },
      });
      expect(result).toMatchObject({ ok: true, action: 'metadata_updated' });
      expect(persistSessionBindings).not.toHaveBeenCalled();
      expect(runtimeTargets.getBySessionId('inactive')).toBeNull();
      expect(await stat(join(target, 'auth.json')).catch(() => null)).toBeNull();
    } finally { transport.mockRestore(); await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it('persists an exact team-resource V2 selection for an inactive Session', async () => {
    const serviceKey = 'happier.agent.claude/anthropic';
    const requested = {
      v: 2 as const,
      bindingsByServiceId: {
        [serviceKey]: {
          source: 'team_resource' as const,
          resourceId: 'resource-1',
          deliveryMode: 'direct' as const,
          disclosedMember: {
            service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            accountId: 'account-1',
          },
        },
      },
    };
    const persistSessionBindings = vi.fn(async () => {});

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: { v: 2, bindingsByServiceId: {} },
      }),
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'anthropic', profiles: [] }),
      },
      qualifiedConnectedAccountApi: {
        listAccounts: async () => { throw new Error('not used'); },
        readGroup: async () => { throw new Error('not used'); },
      },
      resolveContinuity: async ({ next }) => {
        expect(next).toMatchObject({
          source: 'team_resource',
          resourceId: 'resource-1',
          deliveryMode: 'direct',
          disclosedMember: {
            service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            accountId: 'account-1',
          },
        });
        return { mode: 'restart_rematerialize' };
      },
      restartSession: vi.fn(async () => {}),
      persistSessionBindings,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_team_resource',
        agentId: 'claude',
        bindings: requested,
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'metadata_updated',
      normalizedBindings: requested,
    });
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      normalizedBindings: requested,
    }));
  });

  it('preserves a qualified Connected Account service through inactive Session switching', async () => {
    const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' } as const;
    const serviceKey = 'happier.agent.claude/anthropic';
    const requested: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [serviceKey]: {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'new-profile',
        },
      },
    };
    const normalizedRequested = requested;
    const persistSessionBindings = vi.fn(async () => {});

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            [serviceKey]: {
              source: 'connected',
              selection: 'profile',
              profileId: 'old-profile',
            },
          },
        },
      }),
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'anthropic', profiles: [] }),
      },
      qualifiedConnectedAccountApi: {
        listAccounts: async () => QualifiedConnectedAccountListResponseV4Schema.parse({
          service,
          accounts: [{
            ref: {
              service: { pluginId: service.pluginId, localId: service.localId },
              accountId: 'new-profile',
            },
            status: 'connected',
            authenticationModeId: null,
            configurationReady: true,
            configurationRevision: null,
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            scopes: [],
          }],
        }),
        readGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: vi.fn(async () => {}),
      persistSessionBindings,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_external_qualified',
        agentId: 'claude',
        bindings: requested,
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'metadata_updated',
      normalizedBindings: normalizedRequested,
    });

    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      normalizedBindings: normalizedRequested,
    }));
  });

  it('rejects a missing session without mutating or restarting', async () => {
    const restartSession = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [],
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'happier.agent.claude/anthropic', profiles: [] }),
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
          serviceId: 'happier.agent.claude/anthropic',
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
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'restart_rematerialize' },
    });

    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      tracked: null,
      serviceId: 'happier.agent.claude/anthropic',
    }));
    expect(restartSession).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_inactive', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'happier.agent.claude/anthropic',
      fromProfileId: 'old-profile',
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
  });

  it('emits the resolved auth-group label on canonical account switch events', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();
    const qualifiedConnectedAccountApi = qualifiedAuthGroupApiForLegacyGroup(
      group({ displayName: 'Work Pool' }),
    );

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [{ profileId: 'group-active', status: 'connected' }],
        }),
      },
      qualifiedConnectedAccountApi,
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
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
      serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
      serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
      serviceId: 'happier.agent.claude/anthropic',
      reason: 'pre_turn_group_policy',
    }));
  });

  it('keeps a declined predictive soft-threshold hot-apply out of the transcript (benign fail-safe)', async () => {
    // Live incident 2026-07-10 19:10: the burn-rate soft-switch targeted several sessions; idle
    // siblings hot-applied instantly, but the one MID-TURN session had no safe apply window and
    // surfaced "Authentication could not be switched (hot_apply_failed)" to the user. A predictive
    // soft-threshold switch is a background optimization that fails BEFORE side effects by design: it
    // only ever hot-applies (never restarts a working session), the session keeps working on its
    // current account, the next poll/in-band tick retries, and hard-limit recovery remains the
    // backstop. The benign decline must not surface as a user-facing failure. Side-effectful failure
    // codes stay loud, and the FSM result is unchanged so coordinator retry bookkeeping still works.
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      runtimeAuthApplyReason: 'soft_threshold',
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      // Mid-turn decline: the hot-apply found no safe apply window and failed BEFORE side effects.
      // The service-level failure does not require a restart (a predictive switch never restarts a
      // working session), so the switch surfaces a top-level hot_apply_failed.
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_failed',
        serviceId: 'happier.agent.claude/anthropic',
        serviceResultsByServiceId: {
          'happier.agent.claude/anthropic': { status: 'failed', errorCode: 'no_safe_apply_window' },
        },
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
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
        serviceId: 'happier.agent.claude/anthropic',
        profileId: 'old-profile',
      }));
      expect(next).toEqual(expect.objectContaining({
        serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceId: 'happier.agent.claude/anthropic',
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
        serviceId: 'happier.agent.claude/anthropic',
        profileId: 'old-profile',
      }));
      expect(next).toEqual(expect.objectContaining({
        serviceId: 'happier.agent.claude/anthropic',
        profileId: 'old-profile',
      }));
      expect(resolvedPreviousBindings).toEqual(previousBindings);
      return { kind: 'materialized' };
    });
    const resolveContinuity = vi.fn(async ({ previous, next, previousBindings: resolvedPreviousBindings }) => {
      expect(previous).toEqual(expect.objectContaining({
        serviceId: 'happier.agent.claude/anthropic',
        profileId: 'old-profile',
      }));
      expect(next).toEqual(expect.objectContaining({
        serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
        rematerializeServiceId: 'happier.agent.claude/anthropic',
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      normalizedBindings: previousBindings,
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'hot_apply' },
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
            serviceId: 'happier.agent.claude/claude-subscription',
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
        serviceId: 'happier.agent.claude/claude-subscription',
        diagnostics: {
          failurePhase: 'materialization',
          uxDiagnostic: expect.objectContaining({
            code: 'connected_service_credential_scope_missing',
            failurePhase: 'materialization',
            source: expectedSource,
            serviceId: 'happier.agent.claude/claude-subscription',
            agentId: 'claude',
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
          code: 'connected_service_credential_scope_missing',
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
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': { source: 'native' },
            'happier.agent.claude/claude-subscription': { source: 'native' },
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
        'happier.agent.claude/anthropic': 'restart_rematerialize',
        'happier.agent.claude/claude-subscription': 'restart_rematerialize',
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
          serviceId: 'happier.agent.claude/anthropic',
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

  it.each(['thrown', 'declined', 'completion_failed'] as const)('returns restart failure diagnostics when a switch cannot restart the active session (%s)', async failure => {
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
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {
        if (failure === 'declined') return { signaled: false };
        if (failure === 'completion_failed') return { signaled: true, completion: { ok: false } };
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
          serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
        v: 2,
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
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ next }) => {
        expect(next).toMatchObject({
          source: 'native',
          selection: 'native',
          serviceId: 'happier.agent.claude/anthropic',
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
          v: 2,
          bindingsByServiceId: {},
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {},
      },
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'happier.agent.claude/anthropic',
      fromProfileId: 'old-profile',
      toProfileId: null,
      reason: 'manual',
    }));
  });

  it('rejects connected-service bindings unsupported by the target agent before profile lookup', async () => {
    const tracked = trackedSession();
    const listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'happier.agent.codex/openai-codex' as const,
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
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
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
      serviceId: 'happier.agent.codex/openai-codex',
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
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceId: 'happier.agent.claude/anthropic',
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
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: bindings('old-profile'),
      },
    });
    const restartSession = vi.fn(async () => {
      // The child env adopts the CURRENT generation (5), not the caller's stale expectation (4).
      expect(tracked.spawnOptions?.environmentVariables).toEqual({
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'happier.agent.claude/anthropic',
            groupId: 'work',
            activeProfileId: 'group-active',
            fallbackProfileId: 'group-active',
            generation: 5,
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
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [{ profileId: 'group-active', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({ generation: 5 }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { 'happier.agent.claude/anthropic': 4 },
        bindings: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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

  it('returns pre-effect supersession to the source owner without replaying the selection locally', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: bindings('old-profile'),
      },
    });
    const groups = [
      group({
        activeProfileId: 'first-active',
        generation: 337,
        members: [
          {
            v: 1,
            serviceId: 'anthropic',
            groupId: 'work',
            profileId: 'first-active',
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
        activeProfileId: 'second-active',
        generation: 338,
        members: [
          {
            v: 1,
            serviceId: 'anthropic',
            groupId: 'work',
            profileId: 'first-active',
            priority: 90,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'anthropic',
            groupId: 'work',
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
    const hotApply = vi.fn(async () => {
      if (hotApply.mock.calls.length === 1) {
        return {
          ok: false as const,
          errorCode: 'credential_revision_superseded' as const,
          serviceId: 'happier.agent.claude/anthropic' as const,
          serviceResultsByServiceId: {
            'happier.agent.claude/anthropic': {
              status: 'failed' as const,
              errorCode: 'credential_revision_superseded' as const,
            },
          },
        };
      }
      return { ok: true as const };
    });
    const materializeRuntimeAuthSelection = vi.fn(async ({ groupMetadata }) => ({
      groupGeneration: groupMetadata?.generation,
    }));
    const persistSessionBindings = vi.fn(async () => {});
    const restartSession = vi.fn(async () => {});

    const input: SwitchTestInput = {
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [
            { profileId: 'first-active', status: 'connected' },
            { profileId: 'second-active', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup,
      },
      materializeRuntimeAuthSelection,
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply,
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'first-active',
            },
          },
        },
      },
    };

    const result = await switchSessionConnectedServiceAuth(input);
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_revision_superseded' });
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(getConnectedServiceAuthGroup).toHaveBeenCalledTimes(1);
    expect(materializeRuntimeAuthSelection).toHaveBeenNthCalledWith(1, expect.objectContaining({
      groupMetadata: expect.objectContaining({
        activeProfileId: 'first-active',
        generation: 337,
      }),
    }));
    expect(hotApply).toHaveBeenCalledTimes(1);
    expect(restartSession).not.toHaveBeenCalled();
    expect(persistSessionBindings).toHaveBeenLastCalledWith(expect.objectContaining({ normalizedBindings: bindings('old-profile') }));
    // The source owner can admit the newly committed target as a fresh apply;
    // supersession is not a Session retry budget and must not poison later work.
    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({ ok: true, action: 'hot_applied' });
    expect(materializeRuntimeAuthSelection).toHaveBeenLastCalledWith(expect.objectContaining({
      groupMetadata: expect.objectContaining({ activeProfileId: 'second-active', generation: 338 }),
    }));
    expect(hotApply).toHaveBeenCalledTimes(2);
  });

  it('keeps the strict generation check for dry-run preflights (prospective generations only)', async () => {
    // A dry-run preflight validates a PROSPECTIVE switch (expected == current + 1 is the committed
    // shape). A stale/other expectation must still abort so the coordinator re-resolves before
    // committing — convergence applies only to REAL applies.
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      dryRun: true,
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'happier.agent.claude/anthropic', profiles: [] }),
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
        expectedGroupGenerationByServiceId: { 'happier.agent.claude/anthropic': 3 },
        bindings: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
      serviceId: 'happier.agent.claude/anthropic',
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
            serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceId: 'happier.agent.claude/anthropic',
      diagnostics: {
        failurePhase: 'continuity',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it.each([
    { identity: null, resumeId: 'native-session', code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing },
    { identity: { v: 1 as const, id: 'csm_missing_resume' }, resumeId: null, code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing },
  ])('presents the actual missing continuity input ($code) and preserves the current account', async ({ identity, resumeId, code }) => {
    const tracked = trackedSession();
    const result = await switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => resolveSharedStateRequiredSwitchContinuity({
        agentId: 'claude',
        serviceId: 'happier.agent.claude/anthropic',
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'linked', stateMode: 'shared' }, byAgentId: {},
        } },
        targetMaterializedRoot: '/tmp/materialized',
        materializationIdentity: identity,
        vendorResumeId: resumeId,
      }),
      restartSession: async () => { throw new Error('refused switch must not restart'); },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: { sessionId: 'sess_1', agentId: 'claude', bindings: bindings('new-profile') },
    });
    expect(result).toMatchObject({ ok: false, diagnostics: { uxDiagnostic: { code } } });
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
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
          'happier.agent.claude/anthropic': { status: 'failed', errorCode: 'provider_rejected' },
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
          serviceId: 'happier.agent.claude/anthropic',
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
    expect(registerHotApplyTargets).toHaveBeenCalledWith(expect.objectContaining({
      tracked,
      runtimeAuthSelectionsByServiceId: expect.any(Map),
    }));
  });

  it('keeps the applied epoch and reports pending reconciliation when post-hot-apply registration fails', async () => {
    const tracked = trackedSession();
    const runtimeAuthSelection = {
      targetMaterializedRoot: '/tmp/materialized/csm_atomic',
      targetMaterializedEnv: {
        HAPPIER_TEST_CONNECTED_SERVICE_SELECTION_IDENTITY: 'selection-atomic',
      },
    };
    const persistSessionBindings = vi.fn(async () => undefined);
    const registerHotApplyTargets = vi.fn(async (input: unknown) => {
      expect(input).toEqual(expect.objectContaining({
        tracked,
        runtimeAuthSelectionsByServiceId: new Map([['happier.agent.claude/anthropic', runtimeAuthSelection]]),
      }));
      throw new Error('runtime target registration rejected');
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      materializeRuntimeAuthSelection: async () => runtimeAuthSelection,
      restartSession: vi.fn(),
      persistSessionBindings,
      hotApply: async () => ({ ok: true as const }),
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'partial_applied_pending_reconciliation',
      diagnostics: {
        failurePhase: 'reconciliation',
        rollback: {
          status: 'post_apply_commit_failed',
          pendingReconciliation: true,
        },
      },
    });

    expect(persistSessionBindings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      normalizedBindings: bindings('new-profile'),
    }));
    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
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
          serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceIds: new Set(['happier.agent.claude/anthropic']),
    }));
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).toHaveBeenCalledWith(expect.objectContaining({ tracked }));
  });

  it('reports a hot-apply adoption mismatch without replacing the provider runtime (cmptxauhy0k2ptmqe6o4l8i48)', async () => {
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
      ok: false,
      errorCode: 'provider_account_adoption_mismatch',
      diagnostics: {
        attemptedAction: 'hot_applied',
        failurePhase: 'post_switch_verification',
      },
    });
    expect(JSON.stringify(result)).not.toContain('raw-secret-token');

    expect(restartSession).not.toHaveBeenCalled();
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).toHaveBeenNthCalledWith(1, expect.objectContaining({
      serviceId: 'happier.agent.codex/openai-codex',
      target: expect.objectContaining({ profileId: 'bot' }),
      action: 'hot_applied',
    }));
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      attemptedContinuityMode: 'hot_apply',
    }));
  });

  it('reports unavailable hot-apply verification without replacing the provider runtime', async () => {
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
          serviceId: 'happier.agent.codex/openai-codex',
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
      ok: false,
      errorCode: 'post_switch_verification_failed',
      diagnostics: {
        attemptedAction: 'hot_applied',
        failurePhase: 'post_switch_verification',
      },
    });
    expect(restartSession).not.toHaveBeenCalled();
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'happier.agent.codex/openai-codex',
      target: expect.objectContaining({ profileId: 'bot' }),
      action: 'hot_applied',
    }));
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      attemptedContinuityMode: 'hot_apply',
    }));
  });

  it('keeps a retryable hot-apply adoption mismatch within the declared hot-apply contract', async () => {
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
          serviceId: 'happier.agent.codex/openai-codex',
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
      ok: false,
      errorCode: 'provider_account_adoption_mismatch',
      diagnostics: { attemptedAction: 'hot_applied' },
    });

    expect(hotApply).toHaveBeenCalledOnce();
    expect(restartSession).not.toHaveBeenCalled();
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceId: 'happier.agent.codex/openai-codex',
      target: expect.objectContaining({ profileId: 'leeroy' }),
    }));
    expect(calls).toEqual([
      'hot_apply',
      'verify:hot_applied',
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
          serviceId: 'happier.agent.claude/anthropic',
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
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'restart_rematerialize' },
    });

    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'restart_rematerialize' },
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
          serviceId: 'happier.agent.codex/openai-codex',
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
      continuityByServiceId: { 'happier.agent.codex/openai-codex': 'hot_apply' },
      verificationByServiceId: {
        'happier.agent.codex/openai-codex': {
          status: 'weakly_verified',
          reason: 'provider_account_email_verified_without_account_id',
        },
      },
    });

    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceId: 'happier.agent.codex/openai-codex',
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
          serviceId: 'happier.agent.claude/anthropic',
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
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'restart_rematerialize' },
    });

    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      action: 'restart_requested',
      serviceIds: new Set(['happier.agent.claude/anthropic']),
    }));
  });

  it('invokes the continuation producer after requesting restart recovery', async () => {
    const tracked = trackedSession();
    const calls: string[] = [];
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
    });

    const input = {
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceIds: new Set(['happier.agent.claude/anthropic']),
    }));
    expect(verifyProviderAccountAdoption).not.toHaveBeenCalled();
    expect(calls).toEqual(['restart', 'continue']);
  });

  it.each(['usage_limit', 'automatic_runtime_failure', 'pre_turn_group_policy'] as const)('preserves application actor and public switch reason %s', async (runtimeAuthApplyReason) => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.claude/anthropic',
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
      runtimeAuthApplyReason,
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
      reason: runtimeAuthApplyReason,
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
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [{ profileId: 'old-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ previous, next }) => {
        expect(previous).toEqual(expect.objectContaining({
          serviceId: 'happier.agent.claude/anthropic',
          profileId: 'old-profile',
        }));
        expect(next).toEqual(expect.objectContaining({
          serviceId: 'happier.agent.claude/anthropic',
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
        rematerializeServiceId: 'happier.agent.claude/anthropic',
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('old-profile'),
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'restart_rematerialize' },
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
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
          serviceId: 'happier.agent.claude/anthropic',
          profiles: [{ profileId: 'group-active', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'group-active',
          generation: 67,
        }),
      },
      resolveContinuity: async ({ previous, next }) => {
        expect(previous).toEqual(expect.objectContaining({
          serviceId: 'happier.agent.claude/anthropic',
          selection: 'group',
          groupId: 'work',
          profileId: 'group-active',
        }));
        expect(next).toEqual(expect.objectContaining({
          serviceId: 'happier.agent.claude/anthropic',
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
        expectedGroupGenerationByServiceId: { 'happier.agent.claude/anthropic': 67 },
        bindings: {
          v: 2 as const,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        } satisfies ConnectedServiceBindingsV2,
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.claude/anthropic': {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
          },
        },
      },
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'hot_apply' },
    });

    expect(hotApply).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      attemptId: 'connected-service-auth-switch|hot_applied|happier.agent.claude/anthropic:group:work::67',
      action: 'hot_applied',
    }));
  });

  it('does not treat tracked launch selection and generation as proof that the live runtime adopted an unchanged group binding', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
            serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic',
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
        expectedGroupGenerationByServiceId: { 'happier.agent.claude/anthropic': 67 },
        bindings: {
          v: 2 as const,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
      action: 'hot_applied',
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.claude/anthropic': {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
          },
        },
      },
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'hot_apply' },
    });
    expect(materializeRuntimeAuthSelection).toHaveBeenCalledOnce();
    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(hotApply).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
  });

  it('does not treat tracked env adoption as runtime proof for direct-live-required same-account fanout', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
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
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'work',
            activeProfileId: 'backup',
            fallbackProfileId: 'backup',
            generation: 5,
          }]),
        },
      },
    });
    const runtimeAuthSelection = { kind: 'runtime-auth-selection' };
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
        expectedGroupGenerationByServiceId: { 'happier.agent.codex/openai-codex': 5 },
        bindings: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
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
      continuityByServiceId: { 'happier.agent.codex/openai-codex': 'hot_apply' },
    });

    expect(materializeRuntimeAuthSelection).toHaveBeenCalledOnce();
    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(hotApply).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('reports an unchanged-group hot-apply adoption mismatch without replacing the provider runtime', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
          serviceId: 'happier.agent.claude/anthropic',
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
        expectedGroupGenerationByServiceId: { 'happier.agent.claude/anthropic': 68 },
        bindings: {
          v: 2 as const,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'provider_account_adoption_mismatch',
      diagnostics: {
        attemptedAction: 'hot_applied',
        failurePhase: 'post_switch_verification',
      },
    });

    expect(restartSession).not.toHaveBeenCalled();
    expect(recoverAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledOnce();
    expect(verifyProviderAccountAdoption).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceId: 'happier.agent.claude/anthropic',
    }));
    expect(calls).toEqual([
      'verify:hot_applied',
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
        providerAccountId: 'acct-backup',
        providerEmail: 'backup@example.com',
      },
    });
    let nativeAuthFiles: Readonly<Record<string, Uint8Array>> = {};
    const runtimeAuthSelection = {
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 7,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      credential: record,
      nativeHome: {
        readFiles: vi.fn(async () => nativeAuthFiles),
        replaceFiles: vi.fn(async (files: Readonly<Record<string, Uint8Array>>) => {
          nativeAuthFiles = files;
        }),
      },
      client: {
        request: vi.fn(async () => ({ ok: true })),
      },
      applyConnectedServiceAuthGeneration: async () => ({ ok: true }),
      invalidateTransports: async () => undefined,
    };
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
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
              serviceId: 'happier.agent.codex/openai-codex',
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'fallback',
              generation: 7,
            },
          ]),
        },
      },
    });
    const codexRuntimeAuthAdapter = (await readCodexRuntimeAuthAdapterRegistration()) as
      ConnectedServiceProviderRuntimeAuthAdapter;
    const hotApply = createSessionConnectedServiceAuthHotApply({
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
      resolveRuntimeAuthAdapter: async () => codexRuntimeAuthAdapter,
      validateGroupMutationCurrentness: async () => ({ current: true }),
    });
    const resolveContinuity = vi.fn(async (input: RuntimeAuthSelectionContinuityInput) => {
      const hotApplySupport = codexRuntimeAuthAdapter.canHotApply(
        projectConnectedServiceRuntimeAuthTargetInput({
          agentId: input.agentId,
          materializedSelection: input.runtimeAuthSelection,
          fallbackSelection: {},
        }),
      );
      if (hotApplySupport.supported === true) return { mode: 'hot_apply' as const };
      throw new Error('Expected native Codex hot_apply continuity');
    });
    const hotApplySelections: unknown[] = [];
    const registerHotApplyTargets = vi.fn<SwitchSessionConnectedServiceAuthInput['registerHotApplyTargets']>();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.codex/openai-codex',
          profiles: [
            { profileId: 'backup', status: 'connected' },
            { profileId: 'primary', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => group({
          serviceId: 'openai-codex',
          activeProfileId: 'backup',
          generation: 7,
          members: [
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'work',
              profileId: 'backup',
              priority: 1,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      },
      resolveContinuity,
      materializeRuntimeAuthSelection: async () => runtimeAuthSelection,
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async (input) => {
        hotApplySelections.push(input.runtimeAuthSelectionsByServiceId?.get('happier.agent.codex/openai-codex'));
        return await hotApply(input);
      },
      persistSessionBindings: async () => undefined,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
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
      continuityByServiceId: { 'happier.agent.codex/openai-codex': 'hot_apply' },
    });

    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      runtimeAuthSelection,
    }));
    expect(hotApplySelections).toEqual([runtimeAuthSelection]);
    expect(registerHotApplyTargets).toHaveBeenCalledWith(expect.objectContaining({
      acceptedConnectedServicesBindingsRaw: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
          },
        },
      },
      acceptedConnectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'happier.agent.codex/openai-codex',
            groupId: 'work',
            activeProfileId: 'backup',
            fallbackProfileId: 'fallback',
            generation: 7,
            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
          },
        ]),
      },
    }));
    expect(tracked.spawnOptions?.environmentVariables?.[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]).toBe(JSON.stringify([
      {
        kind: 'group',
        serviceId: 'happier.agent.codex/openai-codex',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 7,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      },
    ]));
  });

  it('dry-runs runtime-auth generation apply without mutating session state or emitting events', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
          serviceId: 'happier.agent.claude/anthropic' as const,
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
        expectedGroupGenerationByServiceId: { 'happier.agent.claude/anthropic': 67 },
        bindings: {
          v: 2 as const,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'group-active',
            },
          },
        } satisfies ConnectedServiceBindingsV2,
      },
    };

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'hot_apply' },
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
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
            serviceId: 'happier.agent.claude/anthropic',
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
          serviceId: 'happier.agent.claude/anthropic' as const,
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
        expectedGroupGenerationByServiceId: { 'happier.agent.claude/anthropic': 5 },
        bindings: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
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
      continuityByServiceId: { 'happier.agent.claude/anthropic': 'hot_apply' },
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
        connectedServices: { v: 2, bindingsByServiceId: {} },
      },
    });
    const resolveContinuity = vi.fn(async ({ serviceId }) => {
      if (serviceId === 'happier.agent.codex/openai-codex') return { mode: 'hot_apply' as const };
      return { mode: 'unsupported' as const, errorCode: 'unsupported_service' as const };
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.codex/openai-codex',
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
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'happier' },
            'happier.voice.openai/openai': { source: 'native' },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'happier.agent.codex/openai-codex': 'hot_apply' },
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'happier' },
        },
      },
    });

    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'happier.agent.codex/openai-codex',
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
          serviceId: 'happier.agent.claude/anthropic',
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

  it('does not turn a declared hot-apply continuity into restart recovery', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
    const serviceKey = 'happier.agent.codex/openai-codex';
    const oldBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'old-profile' },
      },
    };
    const newBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'new-profile' },
      },
    };
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: oldBindings,
      },
    });
    const restartSession = vi.fn(async () => {});
    const persistSessionBindings = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'happier.agent.codex/openai-codex', profiles: [] }),
      },
      qualifiedConnectedAccountApi: {
        readGroup: async () => null,
        listAccounts: async () => QualifiedConnectedAccountListResponseV4Schema.parse({
          service,
          accounts: [{
            ref: { service, accountId: 'new-profile' },
            status: 'connected',
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            configurationReady: true,
            configurationRevision: null,
            scopes: [],
          }],
        }),
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      persistSessionBindings,
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_restart_required',
        serviceId: serviceKey,
        serviceResultsByServiceId: {
          [serviceKey]: { status: 'failed', errorCode: 'hot_apply_restart_required' },
        },
      }),
      registerHotApplyTargets,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: newBindings,
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'hot_apply_failed',
      diagnostics: {
        failurePhase: 'hot_apply',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(oldBindings);
    expect(persistSessionBindings).toHaveBeenCalledTimes(2);
    expect(persistSessionBindings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: newBindings,
    }));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: oldBindings,
    }));
    expect(restartSession).not.toHaveBeenCalled();
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
          serviceId: 'happier.agent.claude/anthropic',
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
      serviceId: 'happier.agent.claude/anthropic',
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
        serviceId: 'happier.agent.claude/claude-subscription',
        serviceResultsByServiceId: {
          'happier.agent.claude/anthropic': { status: 'applied' },
          'happier.agent.claude/claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
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
      // POST-EFFECT PARTIAL: `anthropic` already took the new credential and there is no rollback
      // API for it, so this is not a rollback-safe failure. It settles as the partial state the
      // session-scope Retry/Revert surface already reconciles.
      errorCode: 'partial_applied_pending_reconciliation',
      serviceId: 'happier.agent.claude/claude-subscription',
      diagnostics: {
        failurePhase: 'reconciliation',
        application: {
          status: 'partial_applied_pending_reconciliation',
          phase: 'hot_apply',
        },
        serviceResultsByServiceId: {
          'happier.agent.claude/anthropic': { status: 'applied' },
          'happier.agent.claude/claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      },
    });

    // Persisted state must NOT be rolled back over the applied service: doing so would make the
    // canonical record claim `anthropic` still holds the old account while its runtime already
    // holds the new one. The staged target stays persisted so a later restart converges the
    // still-unapplied service through the ONE canonical apply path.
    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: multiServiceBindings({
        anthropicProfileId: 'new-anthropic',
        claudeSubscriptionProfileId: 'new-claude-subscription',
      }),
    }));
    expect(tracked.spawnOptions?.connectedServices).toEqual(multiServiceBindings({
      anthropicProfileId: 'new-anthropic',
      claudeSubscriptionProfileId: 'new-claude-subscription',
    }));
  });

  it('marks the partial-apply attempt event as partially applied instead of a clean failure', async () => {
    // The session badge and the transcript entry describe the same settled outcome; leaving
    // `partialState: null` here would tell the transcript the attempt left nothing behind.
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
    const emitSessionEvent = vi.fn();

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
      persistSessionBindings: vi.fn(),
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_failed',
        serviceId: 'happier.agent.claude/claude-subscription',
        serviceResultsByServiceId: {
          'happier.agent.claude/anthropic': { status: 'applied' },
          'happier.agent.claude/claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      }),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: multiServiceBindings({
          anthropicProfileId: 'new-anthropic',
          claudeSubscriptionProfileId: 'new-claude-subscription',
        }),
      },
    })).resolves.toMatchObject({ ok: false, errorCode: 'partial_applied_pending_reconciliation' });

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      errorCode: 'partial_applied_pending_reconciliation',
      partialState: 'runtime_auth_partially_applied',
    }));
  });

  it('still rolls persisted bindings back when a hot apply fails before any service applied', async () => {
    // Guards the post-effect rule against over-reach: with NO applied service the operation really
    // is rollback-safe, so the previous bindings must be restored and the typed hot-apply failure
    // must survive.
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
        errorCode: 'credential_revision_superseded',
        serviceId: 'happier.agent.claude/anthropic',
        serviceResultsByServiceId: {
          'happier.agent.claude/anthropic': { status: 'failed', errorCode: 'credential_revision_superseded' },
          'happier.agent.claude/claude-subscription': { status: 'not_attempted' },
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
      errorCode: 'credential_revision_superseded',
    });

    expect(persistSessionBindings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: multiServiceBindings({
        anthropicProfileId: 'old-anthropic',
        claudeSubscriptionProfileId: 'old-claude-subscription',
      }),
    }));
    expect(tracked.spawnOptions?.connectedServices).toEqual(multiServiceBindings({
      anthropicProfileId: 'old-anthropic',
      claudeSubscriptionProfileId: 'old-claude-subscription',
    }));
  });

  it('keeps an applied switch applied when the final switch event cannot be admitted', async () => {
    // POST-EFFECT EVIDENCE: the Provider effect and every canonical projection already completed.
    // A throw from the final transcript admission must not surface as an untyped failure for a
    // switch whose new authority is already ACTIVE.
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn(async () => {
      throw new Error('transcript_admission_failed');
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.claude/anthropic',
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
      warnings: ['connected_service_switch_event_admission_failed'],
    });

    expect(emitSessionEvent).toHaveBeenCalled();
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
          serviceId: 'happier.agent.codex/openai-codex',
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
          'happier.agent.codex/openai-codex': {
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
        'happier.agent.codex/openai-codex': {
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
        serviceId === 'happier.agent.claude/anthropic'
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
        'happier.agent.claude/anthropic': 'hot_apply',
        'happier.agent.claude/claude-subscription': 'restart_rematerialize',
      },
    });

    expect(hotApply).not.toHaveBeenCalled();
    expect(restartSession).toHaveBeenCalledWith(tracked);
  });
  it('keeps a partly applied multi-service switch applied without translating hot apply into restart', async () => {
    // POST-EFFECT SETTLEMENT: `anthropic` already took the new credential. Restoring the previous
    // persisted bindings would make the canonical record contradict the live runtime, while a
    // provider-declared hot apply must never authorize replacing that runtime.
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
      restartSession: vi.fn(async () => {}),
      persistSessionBindings,
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_restart_required',
        serviceId: 'happier.agent.claude/claude-subscription',
        serviceResultsByServiceId: {
          'happier.agent.claude/anthropic': { status: 'applied' },
          'happier.agent.claude/claude-subscription': { status: 'failed', errorCode: 'hot_apply_restart_required' },
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
      errorCode: 'partial_applied_pending_reconciliation',
      diagnostics: {
        failurePhase: 'reconciliation',
        application: {
          status: 'partial_applied_pending_reconciliation',
          phase: 'hot_apply',
        },
      },
    });

    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    expect(tracked.spawnOptions?.connectedServices).toEqual(multiServiceBindings({
      anthropicProfileId: 'new-anthropic',
      claudeSubscriptionProfileId: 'new-claude-subscription',
    }));
  });

  it('keeps a hot-applied switch applied and reports inconclusive verification without restart', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: codexBindings('codex3'),
      },
    });
    const persistSessionBindings = vi.fn(async () => {});
    const verifyProviderAccountAdoption = vi.fn<VerifyProviderAccountAdoption>(async () => ({
      status: 'mismatch',
      expectedProviderAccountId: 'acct_bot',
      actualProviderAccountId: 'acct_codex3',
      retryable: true,
      reason: 'provider_account_adoption_mismatch',
    }));

    const input: SwitchInputWithVerification = {
      core: createCore(),
      postSwitchVerificationMode: testOnlyPostSwitchVerificationBypass(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'happier.agent.codex/openai-codex',
          profiles: [{ profileId: 'bot', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(async () => {}),
      hotApply: async () => ({ ok: true }),
      recoverAfterRuntimeAuthSwitch: vi.fn<RecoverAfterRuntimeAuthSwitch>(async () => ({ ok: true })),
      continueAfterRuntimeAuthSwitch: vi.fn(async () => {}),
      verifyProviderAccountAdoption,
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('bot'),
      },
    };

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: false,
      errorCode: 'provider_account_adoption_mismatch',
      diagnostics: {
        attemptedAction: 'hot_applied',
        failurePhase: 'post_switch_verification',
      },
    });

    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: codexBindings('bot'),
    }));
    expect(tracked.spawnOptions?.connectedServices).toEqual(codexBindings('bot'));
  });
});
