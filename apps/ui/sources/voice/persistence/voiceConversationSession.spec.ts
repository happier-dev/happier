import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
  GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
} from '@happier-dev/agents';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { buildVoiceSpawnUserAttemptId } from '@/voice/shared/voiceSpawnAttempt';

type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;
type MachinePluginSettingsGetFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machinePluginSettingsGet;
type MachinePluginSettingsSetFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machinePluginSettingsSet;
type MachineSpawnTrustedHiddenSystemSessionFn =
  typeof import('@/sync/ops/machines').machineSpawnTrustedHiddenSystemSession;
type CompletePendingMachineSpawnAttemptCustodyForSessionFn =
  typeof import('@/sync/ops/machines').completePendingMachineSpawnAttemptCustodyForSession;

const {
  machineContributionRegistryProjectionDescribe,
  machinePluginSettingsGet,
  machinePluginSettingsSet,
} = vi.hoisted(() => ({
  machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
  ),
  machinePluginSettingsGet: vi.fn<MachinePluginSettingsGetFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
  ),
  machinePluginSettingsSet: vi.fn<MachinePluginSettingsSetFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
  ),
}));
const sessionRpcBoundary = vi.hoisted(() => ({
  sessionRpcWithServerScope: vi.fn(),
}));

type TestState = {
  authoringMemory?: { recentMachinePaths: { machineId: string; path: string }[] };
  settingsScope?: { serverId: string; accountId: string } | null;
  settings: any;
  machines: Record<string, any>;
  sessions: Record<string, any>;
  sessionListRowsByServerId?: Record<string, Record<string, any>>;
  ordinarySessionListMembershipByServerId?: Record<string, string[]>;
  sessionListIndexByServerId?: Record<string, any>;
  concurrentSessionListCacheByServerId?: Record<string, any>;
  getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
};

let state: TestState;
const machineSpawnNewSession = vi.fn();
const machineSpawnTrustedHiddenSystemSession =
  vi.fn<MachineSpawnTrustedHiddenSystemSessionFn>();
const executeSessionSpawnNewAction = vi.fn();
const completePendingMachineSpawnAttemptCustodyForSession =
  vi.fn<CompletePendingMachineSpawnAttemptCustodyForSessionFn>();
const refreshSessions = vi.fn();
const patchSessionMetadataWithRetry = vi.fn();
const ensureSessionVisibleForMessageRoute = vi.fn();
const applySettings = vi.fn();
const globalVoiceStartupInstructionsMarker = Object.freeze({
  v: 1 as const,
  id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
  revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
});

function installSessionSpawnNewActionMock(): void {
  executeSessionSpawnNewAction.mockImplementation(async (input: any, context: any) => {
    if (context?.surface !== 'voice') {
      return {
        ok: false,
        errorCode: 'action_surface_unavailable',
        error: 'action_surface_unavailable',
      };
    }
    const pluginId = input.agentTarget.identity.pluginId;
    const backendId = pluginId === 'acme.voice'
      ? 'acme-voice-agent'
      : pluginId === 'acme.agent.codex'
        ? 'acme.agent.codex/codex'
        : input.agentTarget.identity.localId;
    const legacyOptions: Parameters<MachineSpawnTrustedHiddenSystemSessionFn>[0] = {
      machineId: input.executionTarget.machineId,
      serverId: input.executionTarget.serverId,
      directory: input.directory.path,
      transcriptStorage: input.transcriptStorage,
      permissionMode: input.permissionMode,
      connectedServices: input.connectedServices,
      userAttemptId: input.creationKey,
      backendTarget: { kind: 'backend', backendId },
    };
    const spawned = input.agentSessionStartupInstructionsV1
      ? await machineSpawnTrustedHiddenSystemSession(
          legacyOptions,
          input.agentSessionStartupInstructionsV1,
        )
      : await machineSpawnNewSession(legacyOptions);
    if (spawned.type !== 'success') {
      return {
        ok: true,
        result: {
          type: 'error',
          code: 'spawn_failed',
          retryable: true,
        },
      };
    }
    return {
      ok: true,
      result: {
        type: 'success',
        disposition: 'created',
        sessionId: spawned.sessionId,
        executionTarget: input.executionTarget,
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' },
      },
    };
  });
}

function enableCodexStartupInstructionsV1(): void {
  clearDaemonMergedProjectionCacheForTests();
  machineContributionRegistryProjectionDescribe.mockResolvedValue({
    supported: true,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      agentsById: {
        codex: {
          id: 'codex',
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
              startupInstructions: { versions: [1] },
            },
          },
        },
      },
      familiesById: {},
    }),
  });
}

/**
 * A novel external qualified Agent projected by the target machine, used by the
 * exact-target Voice selection corridors.
 */
function enableExternalVoiceAgentProjection(): void {
  clearDaemonMergedProjectionCacheForTests();
  machineContributionRegistryProjectionDescribe.mockResolvedValue({
    supported: true,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      agentsById: {
        'acme-voice-agent': {
          id: 'acme-voice-agent',
          identity: {
            pluginId: 'acme.voice',
            localId: 'agent',
          },
          title: 'Acme Voice Agent',
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
      },
      familiesById: {},
    }),
  });
}

function enableCollidingQualifiedAgentProjection(): void {
  clearDaemonMergedProjectionCacheForTests();
  machineContributionRegistryProjectionDescribe.mockResolvedValue({
    supported: true,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      agentsById: {
        codex: {
          id: 'codex',
          identity: {
            pluginId: 'happier.agent.codex',
            localId: 'codex',
          },
          isBuiltIn: true,
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
              startupInstructions: { versions: [1] },
            },
          },
        },
        'acme.agent.codex/codex': {
          id: 'acme.agent.codex/codex',
          identity: {
            pluginId: 'acme.agent.codex',
            localId: 'codex',
          },
          channel: 'plugin',
          isBuiltIn: false,
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
              startupInstructions: { versions: [1] },
            },
          },
        },
      },
      familiesById: {},
    }),
  });
}

function enableBundledCodexAgentOnlyProjection(): void {
  clearDaemonMergedProjectionCacheForTests();
  machineContributionRegistryProjectionDescribe.mockResolvedValue({
    supported: true,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      agentsById: {
        codex: {
          id: 'codex',
          identity: {
            pluginId: 'happier.agent.codex',
            localId: 'codex',
          },
          isBuiltIn: true,
        },
      },
      familiesById: {},
    }),
  });
}

function rejectNextMetadataCommitForSession(sessionId: string, error: Error): void {
  let shouldReject = true;
  patchSessionMetadataWithRetry.mockImplementation(async (
    targetSessionId: string,
    applyPatch: (metadata: any) => any,
  ) => {
    if (targetSessionId === sessionId && shouldReject) {
      shouldReject = false;
      throw error;
    }
    const session = state.sessions[targetSessionId];
    session.metadata = applyPatch(session.metadata ?? {});
  });
}

vi.mock('@/agents/registry/registryCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/registry/registryCore')>();
  return {
    ...actual,
    isBundledAgentId: (value: unknown) => actual.isBundledAgentId(value),
  };
});

// Focus is mutable so a case can move it across an await, exactly as a user switching Home does.
const activeServerRef = { current: 'server-1' };

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: activeServerRef.current }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  getMachineContributionRegistryProjectionRevision: () => 0,
  subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
  machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
    machineContributionRegistryProjectionDescribe(...args),
  machinePluginSettingsGet: (...args: Parameters<MachinePluginSettingsGetFn>) =>
    machinePluginSettingsGet(...args),
  machinePluginSettingsSet: (...args: Parameters<MachinePluginSettingsSetFn>) =>
    machinePluginSettingsSet(...args),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: sessionRpcBoundary.sessionRpcWithServerScope,
}));

vi.mock('@/sync/domains/session/external/readExternalSessionLink', () => ({
  readExternalSessionLink: () => null,
}));

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    storage: {
      // This fixture mutates its partial state in place; publish a new snapshot
      // so the canonical completion adapter observes each fixture update.
      getState: () => ({ ...state }),
    },
  });
});

vi.mock('@/sync/ops/machines', () => ({
  completePendingMachineSpawnAttemptCustodyForSession: (
    ...args: Parameters<CompletePendingMachineSpawnAttemptCustodyForSessionFn>
  ) =>
    completePendingMachineSpawnAttemptCustodyForSession(...args),
  machineSpawnNewSession: (...args: any[]) => machineSpawnNewSession(...args),
  machineSpawnTrustedHiddenSystemSession: (
    ...args: Parameters<MachineSpawnTrustedHiddenSystemSessionFn>
  ) =>
    machineSpawnTrustedHiddenSystemSession(...args),
}));

vi.mock('@/sync/ops/actions/sessionSpawnNewAction', () => ({
  executeSessionSpawnNewAction: (...args: unknown[]) => executeSessionSpawnNewAction(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessions: (...args: any[]) => refreshSessions(...args),
    patchSessionMetadataWithRetry: (...args: any[]) => patchSessionMetadataWithRetry(...args),
    ensureSessionVisibleForMessageRoute: (...args: any[]) => ensureSessionVisibleForMessageRoute(...args),
  },
}));

// The sticky auto-target write reaches the sync singleton through its own lazy accessor,
// which is a bundler-only `require` and therefore never sees the `@/sync/sync` mock above.
// Mock the accessor that owns it, exactly as `voiceAutoTargetMachineSettings.test.ts` does.
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => ({ applySettings }),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
  isMachineOnline: () => true,
}));

vi.mock('@/voice/runtime/voiceTargetStore', () => ({
  useVoiceTargetStore: {
    getState: () => ({
      primaryActionSessionAddress: null,
      lastFocusedSessionAddress: null,
    }),
  },
}));

// Load the real host graph during collection so binding assertions do not spend
// their deadline compiling the React Native and provider composition graph.
const { createBundledConversationRuntimeHostLease } = await import(
  '@/voice/registry/bundledConversationRuntimeHost'
);

describe('ensureVoiceConversationSessionForVoiceHome', () => {
  beforeEach(() => {
    activeServerRef.current = 'server-1';
    clearDaemonMergedProjectionCacheForTests();
    machineSpawnNewSession.mockReset();
    machineSpawnTrustedHiddenSystemSession.mockReset();
    executeSessionSpawnNewAction.mockReset();
    completePendingMachineSpawnAttemptCustodyForSession.mockReset();
    completePendingMachineSpawnAttemptCustodyForSession.mockResolvedValue(null);
    refreshSessions.mockReset();
    patchSessionMetadataWithRetry.mockReset();
    ensureSessionVisibleForMessageRoute.mockReset();
    applySettings.mockReset();
    sessionRpcBoundary.sessionRpcWithServerScope.mockReset();
    machineContributionRegistryProjectionDescribe.mockReset();
    machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
    machinePluginSettingsGet.mockReset();
    machinePluginSettingsGet.mockResolvedValue({ supported: false, reason: 'not-supported' });
    machinePluginSettingsSet.mockReset();
    machinePluginSettingsSet.mockResolvedValue({ supported: false, reason: 'not-supported' });

    state = {
      settingsScope: { serverId: 'server-1', accountId: 'account-1' },
      authoringMemory: {
        recentMachinePaths: [{ machineId: 'machine-1', path: '/Users/test/.happier/voice-agent' }],
      },
      settings: {
        lastUsedAgent: 'codex',
        voice: {
          executionMachine: { mode: 'auto', machineId: null, autoMachineId: null },
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              agent: {
                agentSource: 'session',
                voiceHomeSubdirName: 'voice-agent',
                rootSessionPolicy: 'keep_warm',
                maxWarmRoots: 1,
              },
            } },
          },
        },
      },
      machines: {
        'machine-1': {
          id: 'machine-1',
          active: true,
          metadata: {
            happyHomeDir: '/Users/test/.happier',
          },
        },
      },
      sessions: {},
      sessionListRowsByServerId: {},
      ordinarySessionListMembershipByServerId: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
      getProjectForSession: () => null,
    };

    machineSpawnNewSession.mockImplementation(async (params: any) => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return { type: 'success', sessionId: 'voice-home-session' };
    });
    machineSpawnTrustedHiddenSystemSession.mockImplementation(async (params) => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return { type: 'success', sessionId: 'voice-home-session' };
    });
    installSessionSpawnNewActionMock();
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, applyPatch: (metadata: any) => any) => {
      const session = state.sessions[sessionId];
      session.metadata = applyPatch(session.metadata ?? {});
    });
  });

  it('uses the bundled backend when the daemon projects its exact Agent identity without backend entries', async () => {
    enableBundledCodexAgentOnlyProjection();
    const { resolveQualifiedAgentBackendTargetForMachine } = await import(
      '@/voice/persistence/voiceConversationSession'
    );

    await expect(resolveQualifiedAgentBackendTargetForMachine({
      machineId: 'machine-1',
      agent: {
        pluginId: 'happier.agent.codex',
        localId: 'codex',
      },
    })).resolves.toEqual({
      kind: 'backend',
      backendId: 'codex',
    });
  });

  it('uses the qualified routing id when an external Agent has no legacy backend alias', async () => {
    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'acme-voice-agent': {
            id: 'acme-voice-agent',
            identity: { pluginId: 'acme.voice', localId: 'agent' },
          },
        },
        familiesById: {},
      }),
    });
    const { resolveQualifiedAgentBackendTargetForMachine } = await import(
      '@/voice/persistence/voiceConversationSession'
    );

    await expect(resolveQualifiedAgentBackendTargetForMachine({
      machineId: 'machine-1',
      agent: { pluginId: 'acme.voice', localId: 'agent' },
    })).resolves.toEqual({
      kind: 'backend',
      backendId: 'acme.voice/agent',
    });
  });

  it('admits a direct session only through the exact qualified Agent routing identity when local ids collide', async () => {
    enableCollidingQualifiedAgentProjection();
    state.sessions['installed-codex-direct'] = {
      id: 'installed-codex-direct',
      serverId: 'server-1',
      active: true,
      updatedAt: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/workspace',
        backendTarget: {
          kind: 'backend',
          backendId: 'acme.agent.codex/codex',
        },
      },
    };
    sessionRpcBoundary.sessionRpcWithServerScope.mockResolvedValue({
      ok: true,
      status: 'available',
      transport: 'webrtc',
    });

    const hostLease = createBundledConversationRuntimeHostLease();

    try {
      const resolveBinding = hostLease.host.resolveAgentRealtimeVoiceConversationBinding;
      if (!resolveBinding) throw new Error('Agent realtime binding resolver is unavailable');
      await expect(resolveBinding({
        provider: {
          pluginId: 'acme.voice.codex',
          localId: 'realtime-codex',
        },
        agent: {
          pluginId: 'acme.agent.codex',
          localId: 'codex',
        },
        controlSessionId: 'installed-codex-direct',
        requestedTargetSessionAddress: { serverId: 'server-1', sessionId: 'installed-codex-direct' },
        settings: state.settings,
      })).resolves.toEqual({
        conversationSessionAddress: { serverId: 'server-1', sessionId: 'installed-codex-direct' },
        transcriptMode: 'native_session',
        targetSessionAddress: { serverId: 'server-1', sessionId: 'installed-codex-direct' },
      });
      expect(sessionRpcBoundary.sessionRpcWithServerScope).toHaveBeenCalledWith({
        sessionId: 'installed-codex-direct',
        serverId: 'server-1',
        method: 'session.agentRealtime.inspect',
        payload: {
          v: 1,
          provider: {
            pluginId: 'acme.voice.codex',
            localId: 'realtime-codex',
          },
        },
      });
    } finally {
      hostLease.revoke();
    }
  });

  it('spawns a global hidden session with the exact qualified Agent backend when local ids collide', async () => {
    enableCollidingQualifiedAgentProjection();
    const connectedServices = {
      v: 2 as const,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'acme-codex-work',
        },
      },
    };
    machineSpawnTrustedHiddenSystemSession.mockImplementation(async (params) => {
      state.sessions['installed-codex-global'] = {
        id: 'installed-codex-global',
        serverId: 'server-1',
        active: true,
        updatedAt: 1,
        permissionMode: params.permissionMode,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
          backendTarget: params.backendTarget,
          connectedServices: params.connectedServices,
        },
      };
      return { type: 'success', sessionId: 'installed-codex-global' };
    });
    sessionRpcBoundary.sessionRpcWithServerScope.mockResolvedValue({
      ok: true,
      status: 'available',
      transport: 'webrtc',
    });

    const hostLease = createBundledConversationRuntimeHostLease();

    try {
      const resolveBinding = hostLease.host.resolveAgentRealtimeVoiceConversationBinding;
      if (!resolveBinding) throw new Error('Agent realtime binding resolver is unavailable');
      await expect(resolveBinding({
        provider: {
          pluginId: 'acme.voice.codex',
          localId: 'realtime-codex',
        },
        agent: {
          pluginId: 'acme.agent.codex',
          localId: 'codex',
        },
        controlSessionId: hostLease.host.globalVoiceSessionId,
        requestedTargetSessionAddress: null,
        settings: state.settings,
        connectedServices,
      })).resolves.toEqual({
        conversationSessionAddress: {
          serverId: 'server-1',
          sessionId: 'installed-codex-global',
        },
        transcriptMode: 'native_session',
        targetSessionAddress: null,
      });
      expect(machineSpawnTrustedHiddenSystemSession).toHaveBeenCalledWith(
        expect.objectContaining({
          backendTarget: {
            kind: 'backend',
            backendId: 'acme.agent.codex/codex',
          },
          connectedServices,
        }),
        expect.anything(),
      );
    } finally {
      hostLease.revoke();
    }
  });

  it('spawns on the preferred machine when auto mode has no active voice target session', async () => {
    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      permissionMode: 'read-only',
      serverId: 'server-1',
    }));
  });

  it('keeps sticky auto-target persistence bound to the Account selected before the spawn await', async () => {
    const spawned = createDeferred<{ type: 'success'; sessionId: string }>();
    machineSpawnNewSession.mockImplementation(async () => await spawned.promise);
    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    const pending = ensureVoiceConversationSessionForVoiceHome();
    await vi.waitFor(() => expect(machineSpawnNewSession).toHaveBeenCalledOnce());
    state.settingsScope = { serverId: 'server-2', accountId: 'account-2' };
    state.sessions['voice-home-session'] = {
      id: 'voice-home-session',
      active: true,
      updatedAt: 1,
      metadata: { machineId: 'machine-1', path: '/Users/test/.happier/voice-agent' },
    };
    spawned.resolve({ type: 'success', sessionId: 'voice-home-session' });

    await expect(pending).resolves.toBe('voice-home-session');
    expect(applySettings).toHaveBeenCalledWith(expect.any(Object), {
      expectedSettingsScope: { serverId: 'server-1', accountId: 'account-1' },
      source: 'ui',
    });
  });

  it('spawns the configured external Agent through its exact projected backend target', async () => {
    enableExternalVoiceAgentProjection();
    state.settings.voice.providers.local_conversation.config.agent = {
      agentSource: 'agent',
      agentId: 'acme-voice-agent',
      agentTargetKey: 'agent:acme.voice/agent',
      agentIdentity: { pluginId: 'acme.voice', localId: 'agent' },
      agentProjectionGeneration: 7,
    };
    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      backendTarget: { kind: 'backend', backendId: 'acme-voice-agent' },
    }));
  });

  it('fails the voice-home spawn closed when the configured external Agent is no longer projected', async () => {
    // No machine projection carries the configured Agent: its exact selection
    // is stale/unsupported on this machine, so no spawn may silently fall back
    // to a different Agent.
    state.settings.voice.providers.local_conversation.config.agent = {
      agentSource: 'agent',
      agentId: 'acme-voice-agent',
      agentTargetKey: 'agent:acme.voice/agent',
      agentIdentity: { pluginId: 'acme.voice', localId: 'agent' },
      agentProjectionGeneration: 7,
    };
    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
    });
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('coalesces concurrent voice-home ensures while the spawn is pending', async () => {
    const spawned = createDeferred<{ type: 'success'; sessionId: string }>();
    machineSpawnNewSession.mockImplementation((params: any) => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return spawned.promise;
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');
    const first = ensureVoiceConversationSessionForVoiceHome();
    const second = ensureVoiceConversationSessionForVoiceHome();

    await vi.waitFor(() => expect(machineSpawnNewSession).toHaveBeenCalledTimes(1));

    spawned.resolve({ type: 'success', sessionId: 'voice-home-session' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      'voice-home-session',
      'voice-home-session',
    ]);
  });

  it('releases a failed voice-home ensure so a later call can retry', async () => {
    const failedSpawn = createDeferred<{
      type: 'error';
      errorCode: string;
      errorMessage: string;
    }>();
    machineSpawnNewSession.mockImplementationOnce(() => failedSpawn.promise);

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');
    const first = ensureVoiceConversationSessionForVoiceHome();
    const second = ensureVoiceConversationSessionForVoiceHome();

    await vi.waitFor(() => expect(machineSpawnNewSession).toHaveBeenCalledTimes(1));

    failedSpawn.resolve({
      type: 'error',
      errorCode: 'TRANSIENT_FAILURE',
      errorMessage: 'temporary spawn failure',
    });

    await expect(Promise.all([first, second])).rejects.toMatchObject({
      code: 'spawn_failed',
    });
    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(machineSpawnNewSession).toHaveBeenCalledTimes(2);
  });

  it('does not expose private raw spawn diagnostics across the canonical Action boundary', async () => {
    const errorDetail = {
      kind: 'connected_service_ux_diagnostic' as const,
      uxDiagnostic: {
        code: 'connected_service_credential_refresh_unavailable' as const,
        failurePhase: 'materialization' as const,
        source: 'spawn_resume' as const,
        serviceId: 'openai-codex',
        agentId: 'codex',
        profileId: 'voice-profile',
        retryable: true,
        suggestedActions: ['retry', 'open_connected_accounts'] as const,
        diagnostics: {
          reason: 'spawn_preflight',
          status: 'refresh_failed',
          category: 'network_error',
        },
      },
    };
    machineSpawnNewSession.mockResolvedValueOnce({
      type: 'error',
      errorCode: 'SPAWN_VALIDATION_FAILED',
      errorMessage: 'connected_service_credential_refresh_unavailable',
      errorDetail,
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    const rejection = await ensureVoiceConversationSessionForVoiceHome().then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({ code: 'spawn_failed', message: 'spawn_failed' });
    expect(rejection).not.toHaveProperty('errorDetail');
  });

  it('uses the canonical absolute directory identity for voice-home reuse', async () => {
    state.machines['machine-1'].metadata = {
      homeDir: '/Users/test',
    };
    state.authoringMemory!.recentMachinePaths = [{
      machineId: 'machine-1',
      path: '~/repo',
    }];
    state.sessions['absolute-voice-home-session'] = {
      id: 'absolute-voice-home-session',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/repo',
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('absolute-voice-home-session');
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('uses the canonical absolute directory identity in the voice-home digest while preserving the raw spawn directory', async () => {
    state.machines['machine-1'].metadata = {
      homeDir: '/Users/test',
    };
    state.authoringMemory!.recentMachinePaths = [{
      machineId: 'machine-1',
      path: '~/repo',
    }];

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '~/repo',
      userAttemptId: buildVoiceSpawnUserAttemptId({
        surface: 'voice_home',
        serverId: 'server-1',
        machineId: 'machine-1',
        directory: '/Users/test/repo',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        requirements: null,
      }),
    }));
  });

  it('preserves the typed metadata failure with only a sanitized compensation identity when retirement also fails', async () => {
    const metadataFailure = new Error('private provider startup payload');
    const retirementFailure = new Error('private provider retirement payload');
    let failedPatchCount = 0;
    patchSessionMetadataWithRetry.mockImplementation(async (
      sessionId: string,
      applyPatch: (metadata: any) => any,
    ) => {
      if (sessionId === 'voice-home-session' && failedPatchCount < 2) {
        const failure = failedPatchCount === 0 ? metadataFailure : retirementFailure;
        failedPatchCount += 1;
        throw failure;
      }
      const session = state.sessions[sessionId];
      session.metadata = applyPatch(session.metadata ?? {});
    });

    const {
      ensureVoiceConversationSessionForVoiceHome,
      VoiceConversationSessionMetadataCommitError,
    } = await import('./voiceConversationSession');

    const failedEnsure = await ensureVoiceConversationSessionForVoiceHome().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failedEnsure).toBeInstanceOf(VoiceConversationSessionMetadataCommitError);
    expect(failedEnsure).toMatchObject({
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      sessionId: 'voice-home-session',
      compensationFailureCode: 'VOICE_CONVERSATION_RETIREMENT_FAILED',
    });
    expect(failedEnsure).not.toHaveProperty('cause');
    expect(JSON.stringify(failedEnsure)).not.toContain(metadataFailure.message);
    expect(JSON.stringify(failedEnsure)).not.toContain(retirementFailure.message);
  });

  it('distinguishes a session refresh failure from a metadata write rejection behind the typed commit error', async () => {
    const refreshFailure = new Error('private session refresh transport detail');
    refreshSessions.mockRejectedValueOnce(refreshFailure);

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    const refreshRejection = await ensureVoiceConversationSessionForVoiceHome().then(
      () => null,
      (error: unknown) => error,
    );

    const metadataFailure = new Error('private metadata write response');
    rejectNextMetadataCommitForSession('voice-home-session', metadataFailure);
    const writeRejection = await ensureVoiceConversationSessionForVoiceHome().then(
      () => null,
      (error: unknown) => error,
    );

    expect(refreshRejection).toMatchObject({
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      sessionId: 'voice-home-session',
      reason: 'session_refresh_failed',
    });
    expect(writeRejection).toMatchObject({
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      sessionId: 'voice-home-session',
      reason: 'metadata_write_rejected',
    });
    expect((refreshRejection as { reason?: unknown }).reason)
      .not.toBe((writeRejection as { reason?: unknown }).reason);
    const serializedRejections = `${JSON.stringify(refreshRejection)}${JSON.stringify(writeRejection)}`;
    expect(serializedRejections).not.toContain(refreshFailure.message);
    expect(serializedRejections).not.toContain(metadataFailure.message);
  });

  it('reports a stalled session-metadata wait as its own typed commit reason', async () => {
    machineSpawnNewSession.mockImplementation(async () => {
      state.sessions['voice-home-session'] = {
        id: 'voice-home-session',
        active: true,
        updatedAt: 1,
        metadata: null,
      };
      return { type: 'success', sessionId: 'voice-home-session' };
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    vi.useFakeTimers();
    try {
      const pending = ensureVoiceConversationSessionForVoiceHome().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toMatchObject({
        code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
        sessionId: 'voice-home-session',
        reason: 'session_metadata_wait_timed_out',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a raw online machine record reach the authoritative spawn operation without UI-only readiness projection', async () => {
    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      serverId: 'server-1',
    }));
  });

  it('surfaces the authoritative spawn operation failure for a raw online machine record', async () => {
    machineSpawnNewSession.mockResolvedValue({
      type: 'error',
      errorCode: 'RPC_METHOD_NOT_AVAILABLE',
      errorMessage: 'machine spawn method is unavailable',
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'spawn_failed',
      message: 'spawn_failed',
    });
    expect(machineSpawnNewSession).toHaveBeenCalledTimes(1);
  });

  it('routes recent voice-home spawn targets through active machine replacements', async () => {
    state.authoringMemory!.recentMachinePaths = [{
      machineId: 'machine-old',
      path: '/Users/test/.happier/voice-agent',
    }];
    state.machines = {
      'machine-old': {
        id: 'machine-old',
        active: false,
        replacedByMachineId: 'machine-new',
        replacedAt: 123,
        metadata: {},
      },
      'machine-new': {
        id: 'machine-new',
        active: true,
        metadata: {},
      },
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-new',
      directory: '/Users/test/.happier/voice-agent',
      serverId: 'server-1',
    }));
  });

  it('trims the configured agent id before choosing the spawned voice-home agent', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.voice.providers.local_conversation.config.agent.agentSource = 'agent';
    state.settings.voice.providers.local_conversation.config.agent.agentId = ' codex ';

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
      },
    }));
  });

  it('spawns the voice home on an externally installed configured Agent', async () => {
    enableExternalVoiceAgentProjection();
    state.settings.lastUsedAgent = 'claude';
    state.settings.voice.providers.local_conversation.config.agent.agentSource = 'agent';
    state.settings.voice.providers.local_conversation.config.agent.agentId = 'acme-voice-agent';

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(executeSessionSpawnNewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'acme.voice', localId: 'agent' },
        },
      }),
      expect.objectContaining({ surface: 'voice' }),
    );
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'acme-voice-agent',
      },
    }));
  });

  it('does not treat the legacy customAcp voice-home fallback as permission to select a plugin backend from merged projection truth', async () => {
    state.settings.lastUsedAgent = 'customAcp';
    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'acme.review.provider': {
            id: 'acme.review.provider',
            title: 'Acme Review Provider',
            channel: 'plugin',
            isBuiltIn: false,
            providerOwnedEnvironmentKeys: [],
            settingsBackendId: 'acme.review.backend',
          },
        },
      }),
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('machine-1', expect.objectContaining({
      serverId: 'server-1',
    }));
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'claude',
      },
    }));
  });

  it('falls back to the built-in last-used backend target when the stored configured backend is stale', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
      },
    }));
  });

  it('uses the fixed machine target when the target mode is padded', async () => {
    state.machines['machine-2'] = {
      id: 'machine-2',
      active: true,
      metadata: {
        happyHomeDir: '/Users/fixed/.happier/',
      },
    };
    state.settings.voice.executionMachine = {
      mode: ' fixed ',
      machineId: ' machine-2 ',
      autoMachineId: null,
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-2',
      directory: '/Users/fixed/.happier/voice-agent',
      serverId: 'server-1',
    }));
  });

  it('reuses visible lookup metadata while waiting for a freshly spawned voice home session to hydrate', async () => {
    vi.useFakeTimers();
    try {
      machineSpawnNewSession.mockImplementation(async () => {
        state.sessions['voice-home-session'] = {
          id: 'voice-home-session',
          active: true,
          updatedAt: 1,
          metadata: null,
        };
        return { type: 'success', sessionId: 'voice-home-session' };
      });
      refreshSessions.mockImplementation(async () => {
        state.sessionListRowsByServerId = {
          ...(state.sessionListRowsByServerId ?? {}),
          'server-1': {
            ...(state.sessionListRowsByServerId?.['server-1'] ?? {}),
            'voice-home-session': {
              id: 'voice-home-session',
              active: true,
              updatedAt: 1,
              presence: 'online',
              metadata: {
                machineId: 'machine-1',
                path: '/Users/test/.happier/voice-agent',
                voiceConversationScopeV1: {
                  v: 1,
                  kind: 'voice_home',
                },
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
              },
            },
          },
        };
        state.ordinarySessionListMembershipByServerId = {
          ...(state.ordinarySessionListMembershipByServerId ?? {}),
          'server-1': ['voice-home-session'],
        };
        state.sessionListIndexByServerId = {
          ...(state.sessionListIndexByServerId ?? {}),
          'server-1': [
            { type: 'session', sessionId: 'voice-home-session', serverId: 'server-1', serverName: 'Server 1' },
          ],
        };
      });

      const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');
      const pending = ensureVoiceConversationSessionForVoiceHome();

      await vi.advanceTimersByTimeAsync(15_000);

      await expect(pending).resolves.toBe('voice-home-session');
      expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine-1',
        directory: '/Users/test/.happier/voice-agent',
        serverId: 'server-1',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed instead of roaming when the sticky auto target has no voice-home directory', async () => {
    state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: 'stale-machine' };
    state.machines['stale-machine'] = {
      id: 'stale-machine',
      active: true,
      metadata: {},
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'VOICE_CONVERSATION_TARGET_MISSING',
    });
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('fails closed instead of roaming when the sticky auto target is inactive', async () => {
    state.settings.voice.executionMachine = { mode: 'auto', machineId: null, autoMachineId: 'stale-machine' };
    state.machines['stale-machine'] = {
      id: 'stale-machine',
      active: false,
      metadata: {
        happyHomeDir: '/Users/stale/.happier',
      },
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'VOICE_CONVERSATION_TARGET_MISSING',
    });
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('keeps host-global auto selection independent from the focused session after handoff', async () => {
    state.machines['machine-target'] = {
      id: 'machine-target',
      active: true,
      metadata: {
        happyHomeDir: '/Users/target/.happier',
        host: 'target.local',
      },
    };
    state.machines['machine-stale'] = {
      id: 'machine-stale',
      active: false,
      replacedByMachineId: 'machine-target',
      replacedAt: 123,
      metadata: {
        host: 'source.local',
      },
    };
    state.sessions['focus-session'] = {
      id: 'focus-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'source.local',
      },
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'focus-session'
        ? {
            key: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
            },
          }
        : null;

    vi.doMock('@/voice/runtime/voiceTargetStore', () => ({
      useVoiceTargetStore: {
        getState: () => ({
          primaryActionSessionAddress: { serverId: 'server-a', sessionId: 'focus-session' },
          lastFocusedSessionAddress: null,
        }),
      },
    }));

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/Users/test/.happier/voice-agent',
      serverId: 'server-1',
    }));
  });

  it('reuses an existing voice conversation session when the visible lookup metadata is fresh but raw metadata is stale', async () => {
    state.sessions['voice-home-session'] = {
      id: 'voice-home-session',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/.happier/voice-agent-old',
        voiceAgentRunV1: {
          v: 1, runId: 'run-retired', backendId: 'codex', resumeHandle: null,
          updatedAtMs: 1, transcriptContractVersion: 2,
        },
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessionListRowsByServerId = {
      ...(state.sessionListRowsByServerId ?? {}),
      'server-1': {
        ...(state.sessionListRowsByServerId?.['server-1'] ?? {}),
        'voice-home-session': {
          id: 'voice-home-session',
          active: true,
          updatedAt: 10,
          presence: 'online',
          metadata: {
            machineId: 'machine-1',
            path: '/Users/test/.happier/voice-agent',
            voiceConversationScopeV1: {
              v: 1,
              kind: 'voice_home',
            },
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          },
        },
      },
    };
    state.ordinarySessionListMembershipByServerId = {
      ...(state.ordinarySessionListMembershipByServerId ?? {}),
      'server-1': ['voice-home-session'],
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      'server-1': [
        { type: 'session', sessionId: 'voice-home-session', serverId: 'server-1', serverName: 'Server 1' },
      ],
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('reuses the newest exact-compatible voice-home session instead of a newer incompatible candidate', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['newer-incompatible'] = {
      id: 'newer-incompatible',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.voice.openai/openai': {
              source: 'connected',
              selection: 'profile',
              profileId: 'realtime-work',
            },
          },
        },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    state.sessions['older-compatible'] = {
      id: 'older-compatible',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.voice.openai/openai': {
              source: 'connected',
              selection: 'profile',
              profileId: 'realtime-work',
            },
          },
        },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    const isReusableSession = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === 'older-compatible');

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.voice.openai/openai': {
            source: 'connected',
            selection: 'profile',
            profileId: 'realtime-work',
          },
        },
      },
      permissionIntent: 'read-only',
      coldResumeStartupInstructionsEffective: true,
      isReusableSession,
    })).resolves.toBe('older-compatible');

    expect(isReusableSession).toHaveBeenCalledTimes(2);
    expect(isReusableSession.mock.calls.map(([candidate]) => candidate.sessionId)).toEqual([
      'newer-incompatible',
      'older-compatible',
    ]);
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(machineSpawnTrustedHiddenSystemSession).not.toHaveBeenCalled();
  });

  it('creates a fresh matching session when V1 create is supported but cold-resume effectiveness is unproven', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['unproven-cold-resume'] = {
      id: 'unproven-cold-resume',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    const isReusableSession = vi.fn(async () => true);

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'read-only',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession,
    })).resolves.toBe('voice-home-session');

    expect(isReusableSession).not.toHaveBeenCalled();
    expect(machineSpawnTrustedHiddenSystemSession).toHaveBeenCalledWith(
      expect.objectContaining({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        permissionMode: 'read-only',
      }),
      expect.objectContaining(globalVoiceStartupInstructionsMarker),
    );
  });

  it('spawns an exact voice-home session instead of reusing a stale-account candidate', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['wrong-account'] = {
      id: 'wrong-account',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.voice.openai/openai': {
              source: 'connected',
              selection: 'profile',
              profileId: 'realtime-old',
            },
          },
        },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'safe-yolo',
    };
    const isReusableSession = vi.fn(async () => true);

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.voice.openai/openai': {
            source: 'connected',
            selection: 'profile',
            profileId: 'realtime-work',
          },
        },
      },
      permissionIntent: 'safe-yolo',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession,
    })).resolves.toBe('voice-home-session');

    expect(isReusableSession).not.toHaveBeenCalled();
    expect(machineSpawnTrustedHiddenSystemSession).toHaveBeenCalledWith(
      expect.objectContaining({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        connectedServices: {
          v: 2,
          bindingsByServiceId: {
            'happier.voice.openai/openai': {
              source: 'connected',
              selection: 'profile',
              profileId: 'realtime-work',
            },
          },
        },
        permissionMode: 'safe-yolo',
      }),
      expect.objectContaining(globalVoiceStartupInstructionsMarker),
    );
  });

  it('rejects hidden candidates with the wrong backend target or permission intent before facet inspection', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['wrong-backend'] = {
      id: 'wrong-backend',
      active: true,
      updatedAt: 30,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        backendTarget: { kind: 'backend', backendId: 'claude' },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    state.sessions['wrong-permission'] = {
      id: 'wrong-permission',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'yolo',
    };
    const isReusableSession = vi.fn(async () => true);

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'read-only',
      coldResumeStartupInstructionsEffective: false,
      isReusableSession,
    })).resolves.toBe('voice-home-session');

    expect(isReusableSession).not.toHaveBeenCalled();
    expect(machineSpawnTrustedHiddenSystemSession).toHaveBeenCalledWith(
      expect.objectContaining({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        permissionMode: 'read-only',
      }),
      expect.objectContaining(globalVoiceStartupInstructionsMarker),
    );
  });

  it('spawns instead of reusing a candidate whose declaration-gated realtime facet is unavailable', async () => {
    enableCodexStartupInstructionsV1();
    state.sessions['facet-unavailable'] = {
      id: 'facet-unavailable',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        backendTarget: { kind: 'backend', backendId: 'codex' },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceAgentStartupInstructionsV1: globalVoiceStartupInstructionsMarker,
      },
      permissionMode: 'read-only',
    };
    const inspectRealtimeFacet = vi.fn(async (
      _sessionId: string,
    ): Promise<{ status: 'available' | 'unavailable' }> => ({ status: 'unavailable' }));
    const isReusableSession = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      (await inspectRealtimeFacet(sessionId)).status === 'available');

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome({
      backendTarget: { kind: 'backend', backendId: 'codex' },
      permissionIntent: 'read-only',
      coldResumeStartupInstructionsEffective: true,
      isReusableSession,
    })).resolves.toBe('voice-home-session');

    expect(inspectRealtimeFacet).toHaveBeenCalledWith('facet-unavailable');
    expect(machineSpawnTrustedHiddenSystemSession).toHaveBeenCalledWith(
      expect.objectContaining({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        permissionMode: 'read-only',
      }),
      expect.objectContaining(globalVoiceStartupInstructionsMarker),
    );
  });

  it('migrates a matching released voice_carrier home session in place instead of spawning a replacement', async () => {
    vi.useFakeTimers();
    try {
      state.sessions['legacy-voice-home-session'] = {
        id: 'legacy-voice-home-session',
        active: true,
        updatedAt: 10,
        metadata: {
          machineId: 'machine-1',
          path: '/Users/test/.happier/voice-agent',
          systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
        },
      };

      const {
        ensureVoiceConversationSessionForVoiceHome,
      } = await import('./voiceConversationSession');
      const {
        listVoiceConversationSystemSessions,
      } = await import('./voiceConversationSystemSessionLookup');
      expect(listVoiceConversationSystemSessions(state)).toEqual([
        expect.objectContaining({
          sessionId: 'legacy-voice-home-session',
          legacySystemKey: true,
          reusable: true,
        }),
      ]);

      const pending = ensureVoiceConversationSessionForVoiceHome();
      await vi.advanceTimersByTimeAsync(0);

      await expect(pending).resolves.toBe('legacy-voice-home-session');
      expect(machineSpawnNewSession).not.toHaveBeenCalled();
      expect(state.sessions['legacy-voice-home-session'].metadata).toMatchObject({
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires a legacy voice home session when visible lookup metadata matches the target but raw metadata is stale', async () => {
    vi.doMock('@/voice/runtime/voiceTargetStore', () => ({
      useVoiceTargetStore: {
        getState: () => ({
          primaryActionSessionAddress: null,
          lastFocusedSessionAddress: null,
        }),
      },
    }));
    state.sessions['legacy-session'] = {
      id: 'legacy-session',
      active: false,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/.happier/voice-agent-old',
      },
    };
    state.sessions['voice-home-session'] = {
      id: 'voice-home-session',
      active: true,
      updatedAt: 11,
      metadata: {
        machineId: 'machine-1',
        path: '/Users/test/.happier/voice-agent',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessionListRowsByServerId = {
      ...(state.sessionListRowsByServerId ?? {}),
      'server-1': {
        ...(state.sessionListRowsByServerId?.['server-1'] ?? {}),
        'legacy-session': {
          id: 'legacy-session',
          active: false,
          updatedAt: 10,
          presence: 'online',
          metadata: {
            machineId: 'machine-1',
            path: '/Users/test/.happier/voice-agent',
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'machine-1',
              remoteSessionId: 'remote-legacy',
              source: {
                kind: 'codexHome',
                home: 'user',
              },
            },
            voiceConversationScopeV1: {
              v: 1,
              kind: 'voice_home',
            },
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          },
        },
        'voice-home-session': {
          id: 'voice-home-session',
          active: true,
          updatedAt: 11,
          presence: 'online',
          metadata: {
            machineId: 'machine-1',
            path: '/Users/test/.happier/voice-agent',
            voiceConversationScopeV1: {
              v: 1,
              kind: 'voice_home',
            },
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          },
        },
      },
    };
    state.ordinarySessionListMembershipByServerId = {
      ...(state.ordinarySessionListMembershipByServerId ?? {}),
      'server-1': ['legacy-session', 'voice-home-session'],
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      'server-1': [
        { type: 'session', sessionId: 'legacy-session', serverId: 'server-1', serverName: 'Server 1' },
        { type: 'session', sessionId: 'voice-home-session', serverId: 'server-1', serverName: 'Server 1' },
      ],
    };

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).resolves.toBe('voice-home-session');

    expect(patchSessionMetadataWithRetry.mock.calls.some(([sessionId]) => sessionId === 'legacy-session')).toBe(true);
    expect(state.sessions['legacy-session'].metadata).not.toHaveProperty('voiceAgentRunV1');
    expect(state.sessions['legacy-session'].metadata).toMatchObject({
      machineId: 'machine-stale',
      path: '/Users/test/.happier/voice-agent-old',
      systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
    });
  });

  it('does not recover a timed-out voice home spawn by scanning unrelated late sessions', async () => {
    machineSpawnNewSession.mockResolvedValue({
      type: 'error',
      errorCode: 'SESSION_WEBHOOK_TIMEOUT',
      errorMessage: 'Session startup timed out',
    });
    refreshSessions.mockImplementation(async () => {
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          'late-session': {
            id: 'late-session',
            active: true,
            updatedAt: 2,
            metadata: null,
          },
        },
      };
    });
    ensureSessionVisibleForMessageRoute.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 'late-session') return;
      const nextRowsByServerId = {
        ...(state.sessionListRowsByServerId ?? {}),
        'server-1': {
          ...(state.sessionListRowsByServerId?.['server-1'] ?? {}),
          'late-session': {
            id: 'late-session',
            active: true,
            updatedAt: 2,
            presence: 'online',
            metadata: {
              machineId: 'machine-1',
              path: '/Users/test/.happier/voice-agent',
              voiceConversationScopeV1: {
                v: 1,
                kind: 'voice_home',
              },
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
          },
        },
      };
      const nextIndexByServerId = {
        ...(state.sessionListIndexByServerId ?? {}),
        'server-1': [
          { type: 'session', sessionId: 'late-session', serverId: 'server-1', serverName: 'Server 1' },
        ],
      };
      state = {
        ...state,
        sessionListRowsByServerId: nextRowsByServerId,
        ordinarySessionListMembershipByServerId: {
          ...(state.ordinarySessionListMembershipByServerId ?? {}),
          'server-1': ['late-session'],
        },
        sessionListIndexByServerId: nextIndexByServerId,
      };
    });

    const { ensureVoiceConversationSessionForVoiceHome } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'spawn_failed',
    });
    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: 'spawn_failed',
    });
    expect(machineSpawnNewSession.mock.calls[0]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(machineSpawnNewSession.mock.calls[1]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(ensureSessionVisibleForMessageRoute).not.toHaveBeenCalled();
  });
});

describe('ensureVoiceConversationSessionForSessionRoot', () => {
  beforeEach(() => {
    activeServerRef.current = 'server-1';
    vi.resetModules();
    clearDaemonMergedProjectionCacheForTests();
    machineSpawnNewSession.mockReset();
    machineSpawnTrustedHiddenSystemSession.mockReset();
    executeSessionSpawnNewAction.mockReset();
    installSessionSpawnNewActionMock();
    completePendingMachineSpawnAttemptCustodyForSession.mockReset();
    completePendingMachineSpawnAttemptCustodyForSession.mockResolvedValue(null);
    refreshSessions.mockReset();
    patchSessionMetadataWithRetry.mockReset();
    ensureSessionVisibleForMessageRoute.mockReset();
    machineContributionRegistryProjectionDescribe.mockReset();
    machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });

    state = {
      settings: {
        lastUsedAgent: 'codex',
        recentMachinePaths: [],
        voice: {
          executionMachine: { mode: 'auto', machineId: null, autoMachineId: null },
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              agent: {
                agentSource: 'session',
                voiceHomeSubdirName: 'voice-agent',
              },
            } },
          },
        },
      },
      machines: {
        'machine-stale': {
          id: 'machine-stale',
          active: false,
          replacedByMachineId: 'machine-target',
          replacedAt: 123,
          metadata: {
            host: 'source.local',
          },
        },
        'machine-target': {
          id: 'machine-target',
          active: true,
          metadata: {
            happyHomeDir: '/Users/target/.happier',
            host: 'target.local',
          },
        },
      },
      sessions: {},
      sessionListRowsByServerId: {},
      ordinarySessionListMembershipByServerId: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
      getProjectForSession: () => null,
    };

    machineSpawnNewSession.mockImplementation(async (params: any) => {
      state.sessions['voice-root-session'] = {
        id: 'voice-root-session',
        active: true,
        updatedAt: 1,
        metadata: {
          machineId: params.machineId,
          path: params.directory,
        },
      };
      return { type: 'success', sessionId: 'voice-root-session' };
    });

    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, applyPatch: (metadata: any) => any) => {
      const session = state.sessions[sessionId];
      session.metadata = applyPatch(session.metadata ?? {});
    });
  });

  it('refuses a root Session from an unmounted Home instead of spawning against the same id here', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'target.local',
      },
    };

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: 'server-2', sessionId: 'root-session' },
    })).rejects.toThrow('voice_conversation_session_home_not_mounted');
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(executeSessionSpawnNewAction).not.toHaveBeenCalled();
  });

  it('spawns on the reachable target machine when the root session metadata machine id is stale after handoff', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'source.local',
      },
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'root-session'
        ? {
            key: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
            },
          }
        : null;

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: 'server-1', sessionId: 'root-session' } })).resolves.toBe('voice-root-session');

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-target',
      directory: '/Users/test/workspace/rebound',
      serverId: 'server-1',
    }));
    expect(executeSessionSpawnNewAction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ surface: 'voice' }),
    );
  });

  it('reuses an existing voice conversation session when the visible lookup metadata is fresh but raw metadata is stale', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'source.local',
      },
    };
    state.sessions['voice-root-session'] = {
      id: 'voice-root-session',
      active: true,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/workspace/old',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessionListRowsByServerId = {
        ...(state.sessionListRowsByServerId ?? {}),
        'server-1': {
          ...(state.sessionListRowsByServerId?.['server-1'] ?? {}),
          'voice-root-session': {
            id: 'voice-root-session',
            active: true,
            updatedAt: 10,
            presence: 'online',
            metadata: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
              voiceConversationScopeV1: {
                v: 1,
                kind: 'session_root',
                sessionRootId: 'root-session',
              },
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
          },
      },
    };
    state.ordinarySessionListMembershipByServerId = {
      ...(state.ordinarySessionListMembershipByServerId ?? {}),
      'server-1': ['voice-root-session'],
    };
    state.sessionListIndexByServerId = {
      ...(state.sessionListIndexByServerId ?? {}),
      'server-1': [
        { type: 'session', sessionId: 'voice-root-session', serverId: 'server-1', serverName: 'Server 1' },
      ],
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'root-session'
        ? {
            key: {
              machineId: 'machine-target',
              rootPath: '/Users/test/workspace/rebound',
            },
          }
        : null;

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: 'server-1', sessionId: 'root-session' } })).resolves.toBe('voice-root-session');
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('keeps hydration and lookup on the root Home when focus moves to another Home mid-refresh', async () => {
    // Both Homes hold the SAME candidate session id. Home `server-2` already has a hydrated,
    // non-hidden row for it, so a lookup that re-reads focus after the await would skip
    // hydration and resolve the wrong Session; the root Home's row is still unhydrated.
    const visibilityCalls: Array<{ sessionId: string; serverId: string | null }> = [];
    ensureSessionVisibleForMessageRoute.mockImplementation(async (sessionId: string, options?: any) => {
      visibilityCalls.push({ sessionId, serverId: options?.serverId ?? null });
      if (sessionId === 'root-session') {
        state.sessions['root-session'] = {
          id: 'root-session',
          active: false,
          updatedAt: 5,
          metadata: {
            machineId: 'machine-target',
            path: '/Users/test/workspace/rebound',
            homeDir: '/Users/test',
            host: 'target.local',
          },
        };
        return;
      }
      state.sessions['voice-root-session'] = {
        id: 'voice-root-session',
        active: false,
        updatedAt: 10,
        metadata: {
          machineId: 'machine-target',
          path: '/Users/test/workspace/rebound',
          voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 'root-session' },
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      };
    });
    refreshSessions.mockImplementation(async () => {
      // The user switches Home while the authoritative list is still loading.
      activeServerRef.current = 'server-2';
      state.sessionListRowsByServerId ??= {};
      state.sessionListRowsByServerId['server-1'] ??= {};
      state.sessionListRowsByServerId['server-1']['voice-root-session'] = {
        id: 'voice-root-session', active: false, updatedAt: 10, metadataVersion: 1, metadata: null,
      } as any;
      state.sessionListRowsByServerId['server-2'] ??= {};
      state.sessionListRowsByServerId['server-2']['voice-root-session'] = {
        id: 'voice-root-session', active: true, updatedAt: 99, metadataVersion: 1,
        metadata: { path: '/other/home/project' },
      } as any;
      state.ordinarySessionListMembershipByServerId ??= {};
      state.ordinarySessionListMembershipByServerId['server-1'] = ['voice-root-session'];
      return { sessionIds: ['voice-root-session'], nextCursor: null, hasNext: false, source: 'v2' };
    });
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'root-session'
        ? { key: { machineId: 'machine-target', rootPath: '/Users/test/workspace/rebound' } }
        : null;

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');

    // Reuse/spawn is the incumbent case's contract; this one owns the Home binding, so it only
    // requires the attempt to settle.
    await ensureVoiceConversationSessionForSessionRoot({
      sessionRootAddress: { serverId: 'server-1', sessionId: 'root-session' },
    }).catch(() => null);

    // The candidate is still hydrated, and against the root Home rather than the newly focused
    // one: reading focus after the await would have consulted `server-2`'s already-hydrated row
    // and skipped this candidate entirely.
    expect(visibilityCalls).toContainEqual({ sessionId: 'voice-root-session', serverId: 'server-1' });
    expect(visibilityCalls.every((call) => call.serverId === 'server-1')).toBe(true);
  });

  it('awaits authoritative session-list hydration before reusing a matching inactive hidden session', async () => {
    const sessionListHydration = createDeferred<void>();
    ensureSessionVisibleForMessageRoute.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'root-session') {
        state.sessions['root-session'] = {
          id: 'root-session',
          active: false,
          updatedAt: 5,
          metadata: {
            machineId: 'machine-target',
            path: '/Users/test/workspace/rebound',
            homeDir: '/Users/test',
            host: 'target.local',
          },
        };
        return;
      }
      if (sessionId === 'unrelated-hidden-session') {
        throw new Error('unrelated hidden hydration failed');
      }
      expect(sessionId).toBe('voice-root-session');
      await sessionListHydration.promise;
      state.sessions['voice-root-session'] = {
        id: 'voice-root-session',
        active: false,
        updatedAt: 10,
        metadata: {
          machineId: 'machine-target',
          path: '/Users/test/workspace/rebound',
          voiceConversationScopeV1: {
            v: 1,
            kind: 'session_root',
            sessionRootId: 'root-session',
          },
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      };
    });
    refreshSessions.mockImplementation(async (options: unknown) => {
      if ((options as { awaitSessionListHydration?: boolean } | undefined)?.awaitSessionListHydration !== true) {
        return;
      }
      state.sessionListRowsByServerId ??= {};
      state.sessionListRowsByServerId['server-1'] ??= {};
      state.sessionListRowsByServerId['server-1']['voice-root-session'] = {
        id: 'voice-root-session',
        active: false,
        updatedAt: 10,
        metadataVersion: 1,
        metadata: null,
      } as any;
      state.sessionListRowsByServerId['server-1']['unrelated-hidden-session'] = {
        id: 'unrelated-hidden-session',
        active: false,
        updatedAt: 9,
        metadataVersion: 1,
        metadata: { hiddenSystemSession: true },
      } as any;
      state.ordinarySessionListMembershipByServerId ??= {};
      state.ordinarySessionListMembershipByServerId['server-1'] = [
        'voice-root-session',
        'unrelated-hidden-session',
      ];
      return {
        sessionIds: ['voice-root-session', 'unrelated-hidden-session'],
        nextCursor: null,
        hasNext: false,
        source: 'v2',
      };
    });

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');
    const ensured = ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: 'server-1', sessionId: 'root-session' } });

    await vi.waitFor(() => expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('root-session', { serverId: 'server-1' }));
    await vi.waitFor(() => expect(refreshSessions).toHaveBeenCalledWith({ awaitSessionListHydration: true }));
    await vi.waitFor(() => expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('voice-root-session', { serverId: 'server-1' }));
    expect(ensureSessionVisibleForMessageRoute.mock.invocationCallOrder[0]).toBeLessThan(
      refreshSessions.mock.invocationCallOrder[0]!,
    );
    expect(machineSpawnNewSession).not.toHaveBeenCalled();

    sessionListHydration.resolve();

    await expect(ensured).resolves.toBe('voice-root-session');
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('reuses an older inactive exact session-root conversation when a newer unrelated voice session exists', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'target.local',
      },
    };
    state.sessions['voice-root-session'] = {
      id: 'voice-root-session',
      active: false,
      updatedAt: 10,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'session_root',
          sessionRootId: 'root-session',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.sessions['newer-unrelated-voice-session'] = {
      id: 'newer-unrelated-voice-session',
      active: true,
      updatedAt: 20,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/other',
        voiceConversationScopeV1: {
          v: 1,
          kind: 'voice_home',
        },
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'root-session'
        ? {
            key: {
              machineId: 'machine-target',
              rootPath: '/Users/test/workspace/rebound',
            },
          }
        : null;

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: 'server-1', sessionId: 'root-session' } })).resolves.toBe('voice-root-session');
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('does not recover a timed-out session-root voice spawn by scanning unrelated late sessions', async () => {
    state.sessions['root-session'] = {
      id: 'root-session',
      active: true,
      updatedAt: 5,
      metadata: {
        machineId: 'machine-target',
        path: '/Users/test/workspace/rebound',
        homeDir: '/Users/test',
        host: 'target.local',
      },
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 'root-session'
        ? {
            key: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
            },
          }
        : null;
    machineSpawnNewSession.mockResolvedValue({
      type: 'error',
      errorCode: 'SESSION_WEBHOOK_TIMEOUT',
      errorMessage: 'Session startup timed out',
    });
    refreshSessions.mockImplementation(async () => {
      state = {
        ...state,
        sessions: {
          ...state.sessions,
          'late-root-session': {
            id: 'late-root-session',
            active: true,
            updatedAt: 20,
            metadata: {
              machineId: 'machine-target',
              path: '/Users/test/workspace/rebound',
            },
          },
        },
      };
    });

    const { ensureVoiceConversationSessionForSessionRoot } = await import('./voiceConversationSession');

    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: 'server-1', sessionId: 'root-session' } })).rejects.toMatchObject({
      code: 'spawn_failed',
    });
    await expect(ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: { serverId: 'server-1', sessionId: 'root-session' } })).rejects.toMatchObject({
      code: 'spawn_failed',
    });
    expect(machineSpawnNewSession.mock.calls[0]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(machineSpawnNewSession.mock.calls[1]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(refreshSessions).toHaveBeenCalledTimes(2);
    expect(refreshSessions).toHaveBeenNthCalledWith(1, { awaitSessionListHydration: true });
    expect(refreshSessions).toHaveBeenNthCalledWith(2, { awaitSessionListHydration: true });
    expect(ensureSessionVisibleForMessageRoute).not.toHaveBeenCalled();
  });
});
