import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACTIONS_SETTINGS_V1 } from '@happier-dev/protocol';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  AgentSessionRealtimeHandle,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  PluginVoiceAgentSessionRealtimeService,
} from '@happier-dev/plugin-sdk/voice/client';
import type { BundledConversationRuntimeHost } from '@/voice/registry/bundledConversationRuntimeHost';
import type { BundledConversationRuntimeEntry } from '@/voice/registry/bundledConversationRuntimes';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { createDeferred, createMachineFixture, createSessionFixture } from '@/dev/testkit';
import {
  audioSessionRelease,
  localVoiceHomeId,
  localVoiceSpeechOutputBoundary,
  loadLocalVoiceEngineWithCompatState,
  machineRpcWithServerScope,
  registerLocalVoiceEngineHarnessHooks,
  sessionRpcWithServerScope,
  warmLocalVoiceEngineHarnessGraph,
} from '@/voice/local/localVoiceEngine.testHarness';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { VOICE_ACTION_EXECUTE_TOOL_NAME } from '@/voice/tools/voiceActionExecution';

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());
const [
  { storage }, { createBuiltinVoiceAdapterAssembly },
  { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES },
  { voiceSessionBindingStore }, { clearDaemonMergedProjectionCacheForTests },
  { getCurrentBundledConversationRuntimeHost },
] = await Promise.all([
  import('@/sync/domains/state/storage'), import('./registerBuiltinVoiceAdapters'),
  import('@/voice/registry/generatedBundledVoiceRuntimeEntries'),
  import('@/voice/binding/voiceConversationBindingStore'),
  import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs'),
  import('@/voice/registry/bundledConversationRuntimeHost'),
]);
// These observers sit beneath the real scoped RPC wrappers on the Socket SDK.
const sessionRpcBoundary = { sessionRpc: sessionRpcWithServerScope };
const machineRpcBoundary = { machineRpc: machineRpcWithServerScope };
const initialSettings = structuredClone(storage.getState().settings);
const installedTestSessionIds = new Set<string>();

function requireTestServerId(): string {
  if (!localVoiceHomeId) throw new Error('Adapter test Account was not applied');
  return localVoiceHomeId;
}

function requireBundledRuntimeHost(
  host: BundledConversationRuntimeHost | null,
  message: string,
): BundledConversationRuntimeHost {
  if (!host) throw new Error(message);
  return host;
}

function createPublicEntry(input: Readonly<{
  providerId: string;
  onCreate?: (host: BundledConversationRuntimeHost) => void;
  dispose?: (host: BundledConversationRuntimeHost) => Promise<void>;
}>): BundledConversationRuntimeEntry {
  const localId = input.providerId.replaceAll('_', '-');
  const declaration = Object.freeze({
    id: localId,
    title: input.providerId,
    kind: 'conversation' as const,
    roles: ['realtime_conversation' as const],
    // The authored fixture declines connections on every platform; its
    // activation/lifetime hooks also exercise the genuine native audio owner.
    platforms: ['web' as const, 'ios' as const, 'android' as const],
    capabilities: Object.freeze({
      turn: Object.freeze({ cancelResponse: false, bargeIn: false }),
      tools: Object.freeze({ effectCalls: 'none' as const }),
    }),
    client: Object.freeze({
      artifactId: 'voice-runtime',
      exportName: 'activate' as const,
    }),
  });
  return Object.freeze({
    pluginId: 'test.voice',
    providerId: `test.voice/${localId}`,
    declaration,
    activate(api: Pick<PluginApi, 'voiceProviders'>) {
      const host = getCurrentBundledConversationRuntimeHost();
      if (!host) throw new Error('test bundled runtime host is unavailable');
      const bundledHost = host as BundledConversationRuntimeHost;
      input.onCreate?.(bundledHost);
      api.voiceProviders.register(localId, Object.freeze({
        kind: 'conversation' as const,
        protocol: Object.freeze({
          prepare: async () => Object.freeze({ kind: 'declined' as const, code: 'test' }),
          decodeControl: () => [],
          encodeTurnControl: () => null,
        }),
        createConnection: async () => { throw new Error('not_used'); },
        encodeToolResults: () => [],
        encodeToolContinuation: () => Object.freeze({}),
        encodeContextUpdate: () => [],
        encodeTextTurn: () => [],
        microphoneMode: 'provider_managed' as const,
        setInputMuted: () => {},
        ...(input.dispose ? { dispose: () => input.dispose!(bundledHost) } : {}),
      }));
    },
  });
}

function readBundledEntryProviderId(entry: BundledConversationRuntimeEntry): string {
  return entry.providerId;
}

describe('createBuiltinVoiceAdapterAssembly', () => {
  registerLocalVoiceEngineHarnessHooks();
  beforeEach(async () => {
    // Preserve the genuine neighboring RPC responders installed by the
    // canonical Account/native fixture; each case overrides only its wire leaf.
    sessionRpcBoundary.sessionRpc.mockClear();
    machineRpcBoundary.machineRpc.mockClear();
    clearDaemonMergedProjectionCacheForTests();
    const machines = ['machine-voice-agent-race-a', 'machine-voice-agent-race-b',
      'machine-voice-generation-cleanup'].map(id => createMachineFixture({
        id, active: true, activeAt: Date.now(),
      }));
    storage.setState(state => ({
      machines: { ...state.machines, ...Object.fromEntries(machines.map(machine => [machine.id, machine])) },
      machineListByServerId: { ...state.machineListByServerId,
        [requireTestServerId()]: [...Object.values(state.machines), ...machines] },
    }));
    const [{ resetBundledConversationRuntimeGenerationForTests }, store] = await Promise.all([
      import('@/voice/registry/bundledConversationRuntimeGeneration'),
      import('@/voice/runtime/machine/voiceConversationRuntimeStore'),
    ]);
    resetBundledConversationRuntimeGenerationForTests();
    store.setVoiceConversationRuntimeSnapshot(store.DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
    for (const binding of voiceSessionBindingStore.getState().list()) {
      voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
    }
  });

  afterEach(async () => {
    storage.setState((current) => {
      const sessions = { ...current.sessions };
      for (const sessionId of installedTestSessionIds) delete sessions[sessionId];
      return {
        ...current,
        settings: structuredClone(initialSettings),
        sessions,
      };
    });
    installedTestSessionIds.clear();
    for (const binding of voiceSessionBindingStore.getState().list()) {
      voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
    }
  });

  it('uses generated public entries as the only production realtime adapter owners', async () => {
    for (const localId of [
      'realtime-elevenlabs',
      'realtime-codex',
      'realtime-openai',
      'realtime-grok',
    ] as const) {
      const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(
        (candidate) => candidate.declaration.id === localId,
      );
      expect(entry).toBeDefined();
      expect(entry?.activate).toBeTypeOf('function');
      expect(entry?.providerId).toContain('/');
    }

    const assembly = createBuiltinVoiceAdapterAssembly();
    const generatedProviderIds = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.map(
      readBundledEntryProviderId,
    );
    const ids = assembly.adapters.map((adapter) => adapter.id);
    const elevenLabsProviderId = 'happier.voice.elevenlabs/realtime-elevenlabs';
    const productionElevenLabs = assembly.adapters.find((adapter) => adapter.id === elevenLabsProviderId);

    expect(generatedProviderIds).toEqual([
      'happier.agent.codex/realtime-codex',
      elevenLabsProviderId,
      'happier.voice.openai/realtime-openai',
      'happier.voice.xai/realtime-grok',
    ]);
    expect(ids).toEqual([
      ...generatedProviderIds,
      'local_direct',
      'local_conversation',
    ]);
    expect(productionElevenLabs).toBeDefined();
    expect(productionElevenLabs?.resolveSurfaceCapabilities).toBeTypeOf('function');
    const voiceSettings = {
      providerId: elevenLabsProviderId,
      providers: {
        [elevenLabsProviderId]: {
          schemaVersion: 2,
          config: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        },
      },
    };
    const directVoiceCapabilities =
      productionElevenLabs?.resolveSurfaceCapabilities?.(voiceSettings);
    expect(directVoiceCapabilities).toMatchObject({
      allowsGlobalStart: true,
      controlSessionScope: 'global',
      cancelResponse: 'unsupported',
    });
    expect(directVoiceCapabilities).toEqual(
      productionElevenLabs?.resolveSurfaceCapabilities?.({ voice: voiceSettings }),
    );
    await assembly.dispose();
  });

  it('still assembles every healthy provider when one bundled leaf throws while activating', async () => {
    const failingEntry = createPublicEntry({
      providerId: 'test_failing_leaf',
      onCreate() { throw new ReferenceError('leaf_symbol_is_not_defined'); },
    });

    // The shell mounting this assembly must keep booting, and Voice must stay
    // available for every provider the broken leaf does not own.
    const assembly = createBuiltinVoiceAdapterAssembly({
      bundledEntries: [failingEntry, ...BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES],
    });

    expect(assembly.adapters.map((adapter) => adapter.id)).toEqual([
      ...BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.map(readBundledEntryProviderId),
      'local_direct',
      'local_conversation',
    ]);
    await assembly.dispose();
  });

  it('removes executable bundled adapters when their first-party package contribution is absent', async () => {
    const assembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [] });
    const ids = assembly.adapters.map((adapter) => adapter.id);

    expect(ids).toEqual(['local_direct', 'local_conversation']);
    await assembly.dispose();
  });

  it('does not let a retired assembly stop the process-global Local Voice owner after remount', async () => {
    const retiredAssembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [] });
    const freshAssembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [] });
    const localDirect = freshAssembly.adapters.find(adapter => adapter.id === 'local_direct');
    if (!localDirect) throw new Error('Fresh Local Direct adapter unavailable');
    storage.setState(state => ({ settings: {
      ...state.settings,
      ...normalizeVoiceSettingsLocalDelta({ voice: { ...state.settings.voice, providerId: 'local_direct' } }),
    } }));
    const engine = await loadLocalVoiceEngineWithCompatState();
    await localDirect.start({ sessionId: 's1', requestedTargetSessionAddress: {
      serverId: requireTestServerId(), sessionId: 's1',
    } });
    expect(engine.getLocalVoiceState()).toMatchObject({ sessionId: 's1', status: 'recording' });
    const nativeStopsBeforeRetirement = localVoiceSpeechOutputBoundary.fileRecording.stop.mock.calls.length;
    await retiredAssembly.dispose();
    expect(engine.getLocalVoiceState()).toMatchObject({ sessionId: 's1', status: 'recording' });
    expect(localVoiceSpeechOutputBoundary.fileRecording.stop).toHaveBeenCalledTimes(nativeStopsBeforeRetirement);
    await localDirect.stop({ sessionId: 's1' });
    expect(engine.getLocalVoiceState().status).toBe('idle');
    await freshAssembly.dispose();
  });

  it('re-enables a fresh executable runtime after a physically absent contribution without retaining cached state', async () => {
    const enabled = createBuiltinVoiceAdapterAssembly();
    const firstRealtime = enabled.adapters.find((adapter) => adapter.engineKind === 'realtime');
    expect(firstRealtime).toBeDefined();
    await enabled.dispose();

    const disabled = createBuiltinVoiceAdapterAssembly({ bundledEntries: [] });
    expect(disabled.adapters.some((adapter) => adapter.engineKind === 'realtime')).toBe(false);
    await disabled.dispose();

    const reEnabled = createBuiltinVoiceAdapterAssembly();
    const secondRealtime = reEnabled.adapters.find((adapter) => adapter.engineKind === 'realtime');
    expect(secondRealtime).toBeDefined();
    expect(secondRealtime).not.toBe(firstRealtime);
    await reEnabled.dispose();
  });

  it('projects a nonempty canonical tool inventory and applies action and inventory-privacy filters at the host owner', async () => {
    const capturedHostRef: { current: BundledConversationRuntimeHost | null } = { current: null };
    const entry = createPublicEntry({
      providerId: 'test_tool_projection',
      onCreate(host) { capturedHostRef.current = host; },
    });
    storage.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        actionsSettingsV1: DEFAULT_ACTIONS_SETTINGS_V1,
        ...normalizeVoiceSettingsLocalDelta({ voice: {
          ...state.settings.voice,
          privacy: { ...state.settings.voice.privacy, shareDeviceInventory: true },
        } }, state.settings),
      },
    }));
    const assembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] });
    const host = capturedHostRef.current;
    if (!host) throw new Error('tool projection test runtime did not receive a host');

    const baselineDefinitions = host.getRealtimeClientToolDefinitions({ effectCalls: 'none', exposure: 'voice_assistant' });
    const baselineNames = baselineDefinitions.map((tool) => tool.name);
    expect(baselineNames.length).toBeGreaterThan(0);
    expect(baselineNames).toContain('searchActionSpecs');
    // Inventory actions are catalog-discovered, not separate direct tools.
    const executeAction = baselineDefinitions.find((tool) => tool.name === VOICE_ACTION_EXECUTE_TOOL_NAME);
    if (!executeAction) throw new Error('Expected canonical Voice Action execution entry');
    const machines = await executeAction.execute({ actionId: 'machines.list', input: {} });
    expect(machines).toMatchObject({ ok: true });
    expect(JSON.stringify(machines)).toContain('machine-1');

    storage.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        actionsSettingsV1: {
          ...DEFAULT_ACTIONS_SETTINGS_V1,
          actions: {
            ...DEFAULT_ACTIONS_SETTINGS_V1.actions,
            'machines.list': {
              ...DEFAULT_ACTIONS_SETTINGS_V1.actions['machines.list'],
              enabled: false,
              enabledPlacements: [],
              disabledSurfaces: [],
              disabledPlacements: [],
              approvalRequiredSurfaces: [],
              toolExposureModes: {},
            },
          },
        },
      },
    }));
    await expect(executeAction.execute({ actionId: 'machines.list', input: {} })).rejects.toThrow('voice_action_unavailable');

    storage.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        actionsSettingsV1: DEFAULT_ACTIONS_SETTINGS_V1,
        ...normalizeVoiceSettingsLocalDelta({ voice: {
          ...state.settings.voice,
          privacy: { ...state.settings.voice.privacy, shareDeviceInventory: false },
        } }, state.settings),
      },
    }));
    const privateNames = host.getRealtimeClientToolDefinitions({ effectCalls: 'none', exposure: 'voice_assistant' }).map((tool) => tool.name);
    expect(privateNames).not.toContain('listRecentPaths');
    expect(privateNames).not.toContain('listMachines');
    expect(privateNames).not.toContain('listServers');
    await expect(executeAction.execute({ actionId: 'machines.list', input: {} })).rejects.toThrow('voice_action_unavailable');

    await assembly.dispose();
  });

  it('ignores a disposed generation late callback after a fresh runtime owns the machine', async () => {
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const oldDisposal = createDeferred<void>();
    let oldHost: BundledConversationRuntimeHost;
    const freshHostRef: { current: BundledConversationRuntimeHost | null } = { current: null };
    const oldEntry = createPublicEntry({
      providerId: 'test_old',
      onCreate(host) { oldHost = host; },
      async dispose(host) {
        await oldDisposal.promise;
        host.machine.transitionToDisconnected('old-session', 'test_old', null);
      },
    });
    const freshEntry = createPublicEntry({
      providerId: 'test_fresh',
      onCreate(host) { freshHostRef.current = host; },
    });

    const oldAssembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [oldEntry] });
    const oldDisposePromise = oldAssembly.dispose();
    const freshAssembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [freshEntry] });
    const freshHost = freshHostRef.current;
    if (!freshHost) throw new Error('fresh test runtime did not receive a host');
    freshHost.machine.transitionToConnecting('fresh-session', 'test_fresh');
    freshHost.machine.transitionToConnected('fresh-session', 'test_fresh');

    oldDisposal.resolve();
    await oldDisposePromise;

    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      adapterId: 'test_fresh',
      controlSessionId: 'fresh-session',
      state: 'connected',
    });
    await freshAssembly.dispose();
  });

  it('releases an acquired audio lease even when a replacement generation exists before old disposal', async () => {
    let oldHost: BundledConversationRuntimeHost | null = null;
    let oldAudioLease: Promise<Readonly<{ release(): Promise<void> }>> | null = null;
    const oldEntry = createPublicEntry({
      providerId: 'test_old_audio',
      onCreate(host) {
        oldHost = host;
        oldAudioLease = host.acquireAudioMode('test_old_audio');
      },
      async dispose() {
        await oldAudioLease?.then((lease) => lease.release());
      },
    });

    const freshHostRef: { current: BundledConversationRuntimeHost | null } = { current: null };
    const freshEntry = createPublicEntry({
      providerId: 'test_fresh_audio',
      onCreate(host) { freshHostRef.current = host; },
    });
    const oldAssembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [oldEntry] });
    if (!oldHost) throw new Error('old test runtime did not receive a host');
    await oldAudioLease;
    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(1);
    const freshAssembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [freshEntry] });

    await oldAssembly.dispose();

    expect(audioSessionRelease).toHaveBeenCalledTimes(1);
    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    const freshHost = freshHostRef.current;
    if (!freshHost) throw new Error('fresh test runtime did not receive a host');
    const freshLease = await freshHost.acquireAudioMode('test_fresh_audio');
    await freshLease.release();
    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    await freshAssembly.dispose();
  });

  it('declines Agent realtime execution authority when the bound session belongs to a different qualified Agent', async () => {
    const providerId = 'test_agent_realtime_binding';
    const controlSessionId = `${providerId}-control`;
    const conversationSessionId = `${providerId}-session`;
    let host: BundledConversationRuntimeHost | null = null;
    const entry = createPublicEntry({
      providerId,
      onCreate(runtimeHost) {
        host = runtimeHost;
      },
    });
    const assembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] });
    const runtimeHost = requireBundledRuntimeHost(
      host,
      'Agent realtime binding test runtime did not receive a host',
    );
    installedTestSessionIds.add(conversationSessionId);
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        [conversationSessionId]: createSessionFixture({
          id: conversationSessionId,
          serverId: requireTestServerId(),
          active: true,
          encryptionMode: 'plain',
          metadata: {
            path: '/workspace/voice-agent-binding',
            host: 'test.local',
            homeDir: '/Users/tester',
            flavor: 'codex',
          } as ReturnType<typeof createSessionFixture>['metadata'],
        }),
      },
    }) as never);
    voiceSessionBindingStore.getState().bind({
      adapterId: providerId,
      controlSessionId,
      conversationSessionId,
      conversationSessionAddress: { serverId: requireTestServerId(), sessionId: conversationSessionId },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: requireTestServerId(), sessionId: conversationSessionId },
      updatedAt: Date.now(),
    });

    const createAuthority = (agent: Readonly<{ pluginId: string; localId: string }>) => (
      runtimeHost.createAgentSessionRealtimeService?.({
        provider: {
          pluginId: 'happier.agent.codex',
          localId: 'realtime-codex',
        },
        agent,
        adapterId: providerId,
        controlSessionId,
        applicationAttemptId: 'voice:1',
        signal: new AbortController().signal,
        onStarted: vi.fn(),
      }) ?? null
    );

    const mismatchedAuthority = await createAuthority({
      pluginId: 'happier.agent.claude',
      localId: 'claude',
    });
    expect(mismatchedAuthority).toBeNull();
    expect(sessionRpcBoundary.sessionRpc).not.toHaveBeenCalled();
    const matchingAuthority = await createAuthority({
      pluginId: 'happier.agent.codex',
      localId: 'codex',
    });
    expect(matchingAuthority).not.toBeNull();
    expect(sessionRpcBoundary.sessionRpc).not.toHaveBeenCalled();

    await assembly.dispose();
  });

  it.each([
    { invalidation: 'binding rebind' as const },
    { invalidation: 'generation revoke' as const },
    { invalidation: 'attempt abort' as const },
    { invalidation: 'session deactivation' as const },
    { invalidation: 'session machine change' as const },
    { invalidation: 'session backend change' as const },
  ])(
    'does not mint Agent realtime authority after an async qualified-Agent check races a $invalidation',
    async ({ invalidation }) => {
      const providerId = `test_agent_realtime_race_${invalidation.replaceAll(' ', '_')}`;
      const controlSessionId = `${providerId}-control`;
      const conversationSessionIdA = `${providerId}-session-a`;
      const conversationSessionIdB = `${providerId}-session-b`;
      const attemptLifetime = new AbortController();
      const projection = createDeferred<unknown>();
      const projectionEntered = createDeferred<void>();
      machineRpcBoundary.machineRpc.mockImplementationOnce(() => {
        projectionEntered.resolve();
        return projection.promise;
      });
      let host: BundledConversationRuntimeHost | null = null;
      const entry = createPublicEntry({
        providerId,
        onCreate(runtimeHost) {
          host = runtimeHost;
        },
      });
      const assembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] });
      const runtimeHost = requireBundledRuntimeHost(
        host,
        'Agent realtime race test runtime did not receive a host',
      );
      installedTestSessionIds.add(conversationSessionIdA);
      installedTestSessionIds.add(conversationSessionIdB);
      storage.setState((current) => ({
        ...current,
        sessions: {
          ...current.sessions,
          [conversationSessionIdA]: createSessionFixture({
            id: conversationSessionIdA,
            serverId: requireTestServerId(),
            active: true,
            encryptionMode: 'plain',
            metadata: {
              path: '/workspace/voice-agent-race-a',
              host: 'test.local',
              homeDir: '/Users/tester',
              machineId: 'machine-voice-agent-race-a',
              flavor: 'codex',
            } as ReturnType<typeof createSessionFixture>['metadata'],
          }),
          [conversationSessionIdB]: createSessionFixture({
            id: conversationSessionIdB,
            serverId: requireTestServerId(),
            active: true,
            encryptionMode: 'plain',
            metadata: {
              path: '/workspace/voice-agent-race-b',
              host: 'test.local',
              homeDir: '/Users/tester',
              machineId: 'machine-voice-agent-race-b',
              flavor: 'codex',
            } as ReturnType<typeof createSessionFixture>['metadata'],
          }),
        },
      }) as never);
      const bindConversation = (conversationSessionId: string, updatedAt: number): void => {
        voiceSessionBindingStore.getState().bind({
          adapterId: providerId,
          controlSessionId,
          conversationSessionId,
          conversationSessionAddress: { serverId: requireTestServerId(), sessionId: conversationSessionId },
          transcriptMode: 'native_session',
          targetSessionAddress: { serverId: requireTestServerId(), sessionId: conversationSessionId },
          updatedAt,
        });
      };
      bindConversation(conversationSessionIdA, 1);
      const pendingAuthority = runtimeHost.createAgentSessionRealtimeService?.({
        provider: {
          pluginId: 'happier.agent.codex',
          localId: 'realtime-codex',
        },
        agent: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
        adapterId: providerId,
        controlSessionId,
        applicationAttemptId: 'voice:1',
        signal: attemptLifetime.signal,
        onStarted: vi.fn(),
      });
      if (!pendingAuthority) throw new Error('Agent realtime race authority did not begin');
      await projectionEntered.promise;
      expect(machineRpcBoundary.machineRpc).toHaveBeenCalledTimes(1);

      let replacementAssembly: ReturnType<typeof createBuiltinVoiceAdapterAssembly> | null = null;
      if (invalidation === 'binding rebind') {
        bindConversation(conversationSessionIdB, 2);
      } else if (invalidation === 'generation revoke') {
        replacementAssembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [] });
      } else if (invalidation === 'attempt abort') {
        attemptLifetime.abort();
      } else {
        storage.setState((current) => {
          const session = current.sessions[conversationSessionIdA];
          if (!session) throw new Error('Agent realtime race session A disappeared');
          const metadata = session.metadata;
          if (!metadata) throw new Error('Agent realtime race session A metadata disappeared');
          const nextSession: typeof session = invalidation === 'session deactivation'
            ? { ...session, active: false }
            : {
                ...session,
                metadata: {
                  ...metadata,
                  ...(invalidation === 'session machine change'
                    ? { machineId: 'machine-voice-agent-race-changed' }
                    : { flavor: 'claude' }),
                },
              };
          return {
            ...current,
            sessions: {
              ...current.sessions,
              [conversationSessionIdA]: nextSession,
            },
          };
        });
      }
      projection.resolve(undefined);

      await expect(pendingAuthority).resolves.toBeNull();
      expect(sessionRpcBoundary.sessionRpc).not.toHaveBeenCalled();

      await assembly.dispose();
      await replacementAssembly?.dispose();
    },
  );

  it.each([
    {
      name: 'assembly retirement',
      installReplacement: false,
    },
    {
      name: 'replacement generation before old disposal',
      installReplacement: true,
    },
  ])(
    'stops one started bound Agent realtime attachment during $name while retaining stale-call rejection',
    async ({ installReplacement }) => {
      const providerId = installReplacement
        ? 'test_agent_realtime_replaced'
        : 'test_agent_realtime_retired';
      const controlSessionId = `${providerId}-control`;
      const conversationSessionId = `${providerId}-session`;
      const oldAttemptLifetime = new AbortController();
      const replacementAttemptLifetime = new AbortController();
      const deferredOldStop = createDeferred<void>();
      const oldStopEntered = createDeferred<void>();
      let oldHost: BundledConversationRuntimeHost | null = null;
      let replacementHost: BundledConversationRuntimeHost | null = null;
      let oldStartedHandle: AgentSessionRealtimeHandle | null = null;
      let replacementStartedHandle: AgentSessionRealtimeHandle | null = null;
      const activeAttemptIds = new Set<string>();
      const readApplicationAttemptId = (payload: unknown): string => {
        if (
          !payload
          || typeof payload !== 'object'
          || Array.isArray(payload)
          || typeof (payload as Readonly<{ applicationAttemptId?: unknown }>)
            .applicationAttemptId !== 'string'
        ) {
          throw new Error('test Agent realtime RPC omitted applicationAttemptId');
        }
        return (payload as Readonly<{ applicationAttemptId: string }>)
          .applicationAttemptId;
      };
      const oldEntry = createPublicEntry({
        providerId,
        onCreate(host) {
          oldHost = host;
        },
        async dispose() {
          oldAttemptLifetime.abort();
          await oldStartedHandle?.dispose();
        },
      });
      const replacementEntry = createPublicEntry({
        providerId,
        onCreate(host) {
          replacementHost = host;
        },
        async dispose() {
          replacementAttemptLifetime.abort();
          await replacementStartedHandle?.dispose();
        },
      });
      sessionRpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
        method: string;
        payload: unknown;
      }>) => {
        if (input.method.endsWith('.start')) {
          activeAttemptIds.add(readApplicationAttemptId(input.payload));
          return {
            ok: true,
            status: 'started',
            transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=answer\r\n' },
          };
        }
        if (input.method.endsWith('.watch')) {
          return await new Promise<never>(() => undefined);
        }
        if (input.method.endsWith('.stop')) {
          oldStopEntered.resolve();
          await deferredOldStop.promise;
          activeAttemptIds.delete(readApplicationAttemptId(input.payload));
          return { ok: true, status: 'stopped' };
        }
        if (input.method.endsWith('.inspect')) {
          return { ok: true, status: 'available', transport: 'webrtc' };
        }
        throw new Error(`unexpected session RPC: ${input.method}`);
      });

      const oldAssembly = createBuiltinVoiceAdapterAssembly({ bundledEntries: [oldEntry] });
      const oldRuntimeHost = requireBundledRuntimeHost(
        oldHost,
        'old Agent realtime runtime did not receive a host',
      );
      installedTestSessionIds.add(conversationSessionId);
      storage.setState((current) => ({
        ...current,
        sessions: {
          ...current.sessions,
          [conversationSessionId]: createSessionFixture({
            id: conversationSessionId,
            serverId: requireTestServerId(),
            active: true,
            encryptionMode: 'plain',
            metadata: {
              path: '/workspace/voice-generation-cleanup',
              host: 'test.local',
              homeDir: '/Users/tester',
              machineId: 'machine-voice-generation-cleanup',
              flavor: 'codex',
            } as ReturnType<typeof createSessionFixture>['metadata'],
          }),
        },
      }) as never);
      voiceSessionBindingStore.getState().bind({
        adapterId: providerId,
        controlSessionId,
        conversationSessionId,
        conversationSessionAddress: { serverId: requireTestServerId(), sessionId: conversationSessionId },
        transcriptMode: 'native_session',
        targetSessionAddress: { serverId: requireTestServerId(), sessionId: conversationSessionId },
        updatedAt: Date.now(),
      });
      const createBoundService = async (
        host: BundledConversationRuntimeHost,
        signal: AbortSignal,
      ): Promise<PluginVoiceAgentSessionRealtimeService | null> => (
        await host.createAgentSessionRealtimeService?.({
          provider: {
            pluginId: 'happier.agent.codex',
            localId: 'realtime-codex',
          },
          agent: {
            pluginId: 'happier.agent.codex',
            localId: 'codex',
          },
          adapterId: providerId,
          controlSessionId,
          // Every controller starts from attempt 1. The host binding must
          // qualify this repeated local identity before daemon RPC.
          applicationAttemptId: 'voice:1',
          signal,
          onStarted: vi.fn(),
        }) ?? null
      );
      const oldService = await createBoundService(oldRuntimeHost, oldAttemptLifetime.signal);
      if (!oldService) throw new Error('bound Agent realtime service was not created');
      const oldStarted = await oldService.start({
        transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=offer\r\n' },
      });
      if (oldStarted.status !== 'started') {
        throw new Error(`bound Agent realtime service did not start: ${oldStarted.status}`);
      }
      oldStartedHandle = oldStarted.handle;
      const oldStartCall = sessionRpcBoundary.sessionRpc.mock.calls.find(
        ([input]) => (input as Readonly<{ method: string }>).method.endsWith('.start'),
      );
      if (!oldStartCall) throw new Error('old Agent realtime START RPC was not observed');
      const oldBoundApplicationAttemptId = readApplicationAttemptId((
        oldStartCall[0] as Readonly<{ payload: unknown }>
      ).payload);
      expect(oldBoundApplicationAttemptId).toMatch(
        /^voice:1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const replacementAssembly = installReplacement
        ? createBuiltinVoiceAdapterAssembly({ bundledEntries: [replacementEntry] })
        : null;
      let replacementService: PluginVoiceAgentSessionRealtimeService | null = null;
      let replacementBoundApplicationAttemptId: string | null = null;
      if (replacementAssembly) {
        if (!replacementHost) {
          throw new Error('replacement Agent realtime runtime did not receive a host');
        }
        const inspectCallsBeforeReplacement = sessionRpcBoundary.sessionRpc.mock.calls.filter(
          ([input]) => (
            input as Readonly<{ method: string }>
          ).method.endsWith('.inspect'),
        ).length;
        await expect(oldService.inspect()).resolves.toMatchObject({
          status: 'unavailable',
          diagnostic: { code: 'agent_realtime_attempt_aborted' },
        });
        expect(sessionRpcBoundary.sessionRpc.mock.calls.filter(
          ([input]) => (
            input as Readonly<{ method: string }>
          ).method.endsWith('.inspect'),
        )).toHaveLength(inspectCallsBeforeReplacement);
        replacementService = await createBoundService(
          replacementHost,
          replacementAttemptLifetime.signal,
        );
        if (!replacementService) {
          throw new Error('replacement bound Agent realtime service was not created');
        }
        const replacementStarted = await replacementService.start({
          transport: { kind: 'webrtc', offerSdp: 'v=0\r\na=replacement-offer\r\n' },
        });
        if (replacementStarted.status !== 'started') {
          throw new Error(
            `replacement bound Agent realtime service did not start: ${replacementStarted.status}`,
          );
        }
        replacementStartedHandle = replacementStarted.handle;
        const startedAttemptIds = sessionRpcBoundary.sessionRpc.mock.calls
          .filter(([input]) => (
            input as Readonly<{ method: string }>
          ).method.endsWith('.start'))
          .map(([input]) => readApplicationAttemptId((
            input as Readonly<{ payload: unknown }>
          ).payload));
        expect(startedAttemptIds).toHaveLength(2);
        expect(new Set(startedAttemptIds).size).toBe(2);
        replacementBoundApplicationAttemptId = startedAttemptIds[1] ?? null;
        expect(replacementBoundApplicationAttemptId).toMatch(
          /^voice:1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        await oldStopEntered.promise;
        expect(sessionRpcBoundary.sessionRpc.mock.calls.filter(
            ([input]) => (
              input as Readonly<{ method: string }>
            ).method.endsWith('.stop'),
          )).toHaveLength(1);
        const callerOnlyStop = new AbortController();
        const staleStopResult = oldStarted.handle.stop({
          signal: callerOnlyStop.signal,
        });
        callerOnlyStop.abort();
        await expect(staleStopResult).resolves.toEqual({ status: 'aborted' });
        expect(sessionRpcBoundary.sessionRpc.mock.calls.filter(
          ([input]) => (
            input as Readonly<{ method: string }>
          ).method.endsWith('.stop'),
        )).toHaveLength(1);
      }
      let firstDisposeSettled = false;
      let secondDisposeSettled = false;
      const firstDispose = oldAssembly.dispose().then(() => {
        firstDisposeSettled = true;
      });
      await oldStopEntered.promise;
      expect(sessionRpcBoundary.sessionRpc.mock.calls.filter(
          ([input]) => (
            input as Readonly<{ method: string }>
          ).method.endsWith('.stop'),
        )).toHaveLength(1);
      const secondDispose = oldAssembly.dispose().then(() => {
        secondDisposeSettled = true;
      });
      await Promise.resolve();

      expect(firstDisposeSettled).toBe(false);
      expect(secondDisposeSettled).toBe(false);
      expect(sessionRpcBoundary.sessionRpc.mock.calls.filter(
        ([input]) => (
          input as Readonly<{ method: string }>
        ).method.endsWith('.stop'),
      )).toHaveLength(1);

      deferredOldStop.resolve();
      await Promise.all([firstDispose, secondDispose]);
      expect(firstDisposeSettled).toBe(true);
      expect(secondDisposeSettled).toBe(true);

      const stopCalls = sessionRpcBoundary.sessionRpc.mock.calls.filter(
        ([input]) => (input as Readonly<{ method: string }>).method.endsWith('.stop'),
      );
      expect(stopCalls).toHaveLength(1);
      const stoppedAttemptId = readApplicationAttemptId((
        stopCalls[0]?.[0] as Readonly<{ payload: unknown }>
      ).payload);
      expect(stoppedAttemptId).toBe(oldBoundApplicationAttemptId);
      expect(activeAttemptIds.has(oldBoundApplicationAttemptId)).toBe(false);
      if (replacementBoundApplicationAttemptId) {
        expect(activeAttemptIds.has(replacementBoundApplicationAttemptId)).toBe(true);
      }
      expect(activeAttemptIds.size).toBe(installReplacement ? 1 : 0);
      const callsBeforeStaleInspect = sessionRpcBoundary.sessionRpc.mock.calls.length;
      await expect(oldService.inspect()).resolves.toMatchObject({
        status: 'unavailable',
        diagnostic: { code: 'agent_realtime_attempt_aborted' },
      });
      expect(sessionRpcBoundary.sessionRpc).toHaveBeenCalledTimes(callsBeforeStaleInspect);
      await expect(oldRuntimeHost.createAgentSessionRealtimeService?.({
        provider: {
          pluginId: 'happier.agent.codex',
          localId: 'realtime-codex',
        },
        agent: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
        adapterId: providerId,
        controlSessionId,
        applicationAttemptId: 'voice:2',
        signal: new AbortController().signal,
        onStarted: vi.fn(),
      })).resolves.toBeNull();

      await replacementAssembly?.dispose();
      expect(activeAttemptIds.size).toBe(0);
      const finalStopCalls = sessionRpcBoundary.sessionRpc.mock.calls.filter(
        ([input]) => (input as Readonly<{ method: string }>).method.endsWith('.stop'),
      );
      expect(finalStopCalls).toHaveLength(installReplacement ? 2 : 1);
    },
  );
});
