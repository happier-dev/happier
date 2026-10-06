import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Conversation, TextConversation } from '@elevenlabs/client';
import { createElevenLabsVoiceProviderRuntime } from '../../../../../packages/plugins/elevenlabs/src/ui/voice/runtime';
import { createSdkHandleConnection } from '@/voice/runtime/connection/VoiceRealtimeConnection';
import {
  bindVoiceRuntimeAttemptBinding, createVoiceRuntimeAttemptBindingOwner,
  unbindVoiceRuntimeAttemptBindingIfOwned,
} from '@/voice/binding/voiceConversationBindingStore';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_UI_HOST_API_VERSION_V1, PLUGIN_UI_HOST_API_WIRE_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import {
  resetSessionListPaneRetentionForTests,
  retainSessionListPaneState,
} from '@/components/sessions/shell/sessionListPaneRetention';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { AuthContextType } from '@/auth/context/AuthContext';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';

import { createVoiceToolHandlers, serializeVoiceActionExecuteResult } from './handlers';

const trackPermissionResponse = vi.fn();
const sendMessage = vi.fn();
const submitMessage = vi.fn();
const ensureSessionVisibleForMessageRoute = vi.fn();
const refreshSessionMessages = vi.fn();
const getSessionEncryption = vi.fn<(sessionId: string) => unknown>((_sessionId) => ({}));
const executionRunStart = vi.fn();
const executionRunList = vi.fn();
const executionRunGet = vi.fn();
const executionRunSend = vi.fn();
const executionRunStop = vi.fn();
const executionRunAction = vi.fn();
const machineRpcWithServerScope = vi.fn();
const setActiveServerAndSwitch = vi.fn(async (_params?: any) => false);
const routerNavigate = vi.fn();
const refreshFromActiveServer = vi.fn(async () => {});
const applySettingsLocal = vi.fn();
const sendSessionMessageWithServerScope = vi.fn();
const sessionRpcWithServerScope = vi.fn();
const teleportVoiceAgentToSessionRoot = vi.fn();
const createArtifactWithHeader = vi.fn();
const artifactCreateRequests = vi.fn();
const voiceSessionStop = vi.hoisted(() => vi.fn(async () => {}));
const runtimeFetchWithServerReachability = vi.hoisted(() => vi.fn());
const readOrdinarySessionListCoverage = vi.fn<() => {
  serverId: string | null;
  coverage: 'complete' | 'incomplete';
}>(() => ({
  serverId: 'server-a',
  coverage: 'complete' as const,
}));

function createBaseState(): any {
  return {
    addArtifact: vi.fn(),
    profileScope: { serverId: 'server-a', accountId: 'voice-tools-account' },
    settingsScope: { serverId: 'server-a', accountId: 'voice-tools-account' },
    sessions: {
      s1: {
        id: 's1',
        serverId: 'server-a',
        thinking: false,
        active: true,
        updatedAt: 200,
        presence: 'online',
        agentState: {
          requests: {
            req_a: { id: 'req_a', tool: 'Bash', kind: 'permission' },
            req_b: { id: 'req_b', tool: 'Read', kind: 'permission' },
          },
        },
        metadata: { path: '/Users/alice/project-alpha', homeDir: '/Users/alice', machineId: 'm1', host: 'a-host', summary: { text: 'S1 summary' } },
      },
      s2: {
        id: 's2',
        serverId: 'server-a',
        thinking: false,
        active: true,
        updatedAt: 100,
        presence: 'offline',
        agentState: {
          requests: {
            req_c: { id: 'req_c', tool: 'Bash', kind: 'permission' },
          },
        },
        metadata: { path: '/tmp/s2', machineId: 'm1', host: 'a-host', summary: { text: 'S2 summary' } },
      },
      sys_voice: {
        id: 'sys_voice',
        serverId: 'server-a',
        thinking: false,
        active: false,
        updatedAt: 300,
        presence: 'offline',
        agentState: { requests: {} },
        metadata: { path: '/tmp/sys', machineId: 'm1', host: 'a-host', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
      },
      s_matrix: {
        id: 's_matrix',
        serverId: 'server-a',
        thinking: false,
        active: false,
        updatedAt: 60,
        presence: 'offline',
        agentState: { requests: {} },
        metadata: { path: '/tmp/matrix', machineId: 'm1', host: 'a-host', name: 'leeroy' },
      },
    },
    sessionListIndexByServerId: {
      'server-a': [
        { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
        { type: 'session', sessionId: 's2', serverId: 'server-a', serverName: 'Server A' },
        { type: 'session', sessionId: 's_visible_only', serverId: 'server-a', serverName: 'Server A' },
        { type: 'session', sessionId: 's_matrix', serverId: 'server-a', serverName: 'Server A' },
      ],
      'server-b': [
        { type: 'session', sessionId: 's_other', serverId: 'server-b', serverName: 'Server B' },
      ],
    },
    sessionListRowsByServerId: {
      'server-a': {
        s_visible_only: {
          id: 's_visible_only',
          active: true,
          updatedAt: 75,
          activeAt: 75,
          createdAt: 70,
          seq: 2,
          metadataVersion: 1,
          agentStateVersion: 1,
          thinking: false,
          thinkingAt: 0,
          presence: 'online',
          metadata: { summaryText: 'Visible only in current list', path: '/tmp/visible-only' },
        },
        s_matrix: {
          id: 's_matrix',
          active: false,
          updatedAt: 60,
          activeAt: 60,
          createdAt: 50,
          seq: 1,
          metadataVersion: 1,
          agentStateVersion: 1,
          thinking: false,
          thinkingAt: 0,
          presence: 'offline',
          metadata: { summaryText: 'Session QA Voice Matrix', path: '/tmp/matrix' },
        },
      },
      'server-b': {
        s_other: {
          id: 's_other',
          active: false,
          updatedAt: 50,
          presence: 'offline',
          agentState: { requests: {} },
          metadata: { path: '/tmp/other', host: 'b-host', summary: { text: 'Other summary' } },
        },
      },
    },
    ordinarySessionListMembershipByServerId: {
      'server-a': ['s_visible_only', 's_matrix'],
      'server-b': ['s_other'],
    },
    concurrentSessionListCacheByServerId: {
      'server-b': {
        serverName: 'Server B',
      },
    },
    machines: {
      m1: { id: 'm1', active: true, metadata: { host: 'a-host' } },
      m2: { id: 'm2', active: true, metadata: { host: 'b-host' } },
    },
    machineListByServerId: {
      'server-a': [{
        id: 'm1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: { host: 'a-host' }, metadataVersion: 1,
        daemonState: null, daemonStateVersion: 1,
      }],
    },
    sessionMessages: {
      s1: {
        isLoaded: true,
        messages: [
          { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, text: 'u1' },
          { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'a2' },
        ],
      },
      s2: {
        isLoaded: true,
        messages: [
          { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, text: 's2 latest' },
          {
            kind: 'tool-call',
            id: 'm4',
            localId: null,
            createdAt: 4,
            children: [],
            tool: {
              name: 'read',
              description: 'Read a file',
              state: 'completed',
              input: { path: '/Users/alice/SecretRepo/README.md' },
              createdAt: 4,
              startedAt: 4,
              completedAt: 5,
            },
          },
        ],
      },
    },
    settings: {
      ...settingsDefaults,
      // These handlers are only reachable from an admitted Voice attempt. Keep
      // the shared fixture at that real boundary; individual policy tests below
      // deliberately revoke Voice or a specific Action after capture.
      experiments: true,
      featureToggles: {
        ...settingsDefaults.featureToggles,
        voice: true,
        'execution.runs': true,
      },
      voice: {
        ...settingsDefaults.voice,
        ui: {
          ...settingsDefaults.voice.ui,
          updates: {
            ...settingsDefaults.voice.ui.updates,
            snippetsMaxMessages: 3,
            includeUserMessagesInSnippets: false,
            otherSessionsSnippetsMode: 'on_demand_only',
          },
        },
        privacy: {
          ...settingsDefaults.voice.privacy,
          shareRecentMessages: true,
          shareToolNames: true,
          shareDeviceInventory: true,
        },
      },
    },
    authoringMemory: {
      recentMachinePaths: [
        { machineId: 'm1', path: '/tmp/s1' },
        { machineId: 'm1', path: '/tmp/s2' },
      ],
    },
  };
}

let state: any = createBaseState();
const readMockStorageState = () => ({ ...state, applySettingsLocal });

async function createElevenLabsToolHarness() {
  const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
  // UI interactions leave the runtime under test and are not part of tool custody.
  // Refuse unexpected use while keeping the current public UI boundary shape.
  const unavailableUi = (): never => { throw new Error('unexpected Voice UI interaction'); };
  let incoming!: (event: unknown) => Promise<void>;
  const sent: Array<Record<string, unknown>> = [];
  const network = {
    conversationId: 'elevenlabs-custody',
    onMessage(callback: typeof incoming) { incoming = callback; },
    onDisconnect() {}, onModeChange() {}, onOutgoingMessage() {},
    sendMessage(event: Record<string, unknown>) { sent.push(event); },
    close: vi.fn(),
  };
  // Only external network/media startup is replaced. The installed 1.18 SDK
  // dispatches real callbacks and sends real client_tool_result envelopes.
  const start = vi.spyOn(Conversation, 'startSession').mockImplementation(async (options) =>
    Reflect.construct(TextConversation, [options, network]));
  onTestFinished(() => start.mockRestore());
  const runtime = createElevenLabsVoiceProviderRuntime();
  const lifetime = new AbortController();
  const directEffect = vi.fn(async () => { throw new Error('voice_effect_call_custody_unavailable'); });
  const connection = await runtime.createConnection({
    session: { config: { textOnly: true, dynamicVariables: { sessionId: 's1' } }, safeMetadata: null },
    attemptId: 1,
    execution: { kind: 'direct_media' },
    mic: {
      ensureActive: async () => {}, teardown: async () => {},
      setMuted() {}, isMuted: () => false, getStream: () => null,
    },
    interruption: { duckGain: 0.18, retainedOutputMaxMs: 1500 },
    levels: { onOutputLevel() {} },
    media: {
      createSdkHandleConnection,
      createWebRtcConnection() { throw new Error('unexpected WebRTC media'); },
      createPcmConnection() { throw new Error('unexpected PCM media'); },
    },
    tools: [{
      name: 'sendSessionMessage', description: 'Message a session',
      parameters: { type: 'object' }, execute: directEffect,
    }],
    ui: {
      version: () => ({ apiVersion: PLUGIN_UI_HOST_API_VERSION_V1, wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1, methods: [] }),
      context: async () => unavailableUi(), watchContext: unavailableUi,
      widgetArea: async () => unavailableUi(),
      readEntityDragItem: async () => unavailableUi(),
      updateEntityDragDrop: async () => unavailableUi(),
      watchEntityDragDrop: async () => unavailableUi(),
      publishCurrentUiContext: unavailableUi,
      activeComposer: async () => unavailableUi(), readComposer: async () => unavailableUi(),
      watchComposer: async () => unavailableUi(), applyComposer: async () => unavailableUi(),
      focusComposer: async () => unavailableUi(), setComposerDecorations: async () => unavailableUi(),
      acquireComposerInputLock: async () => unavailableUi(), pickComposerMedia: async () => unavailableUi(),
      inspectComposerContent: async () => unavailableUi(), releaseComposerContent: async () => unavailableUi(),
      readSession: async () => unavailableUi(), watchSession: async () => unavailableUi(),
      respondToSessionPermission: async () => unavailableUi(), executeAction: async () => unavailableUi(),
      selectActionInput: async () => unavailableUi(), openNewSession: async () => unavailableUi(),
      openConnectedAccounts: async () => unavailableUi(), settleEphemeralInput: async () => unavailableUi(),
      readResource: async () => unavailableUi(), statOpenableContent: async () => unavailableUi(),
      readOpenableContent: async () => unavailableUi(), watchResource: async () => unavailableUi(),
      readStoredImage: async () => unavailableUi(), watchLiveStream: async () => unavailableUi(),
      openSurface: async () => unavailableUi(), replacePageLocation: async () => unavailableUi(),
      notify: async () => unavailableUi(), confirm: async () => unavailableUi(), diagnostic: unavailableUi,
      readClipboard: async () => unavailableUi(), writeClipboard: async () => unavailableUi(),
      openExternalLink: async () => unavailableUi(),
    },
    credentials: { phase: 'connection', mediated: null, raw: null },
    signal: lifetime.signal,
  });
  const hostLease = createBundledConversationRuntimeHostLease();
  const bindingOwner = createVoiceRuntimeAttemptBindingOwner();
  const adapterId = 'happier.voice.elevenlabs/conversation';
  const controlSessionId = 'elevenlabs-custody-control';
  bindVoiceRuntimeAttemptBinding({ owner: bindingOwner, binding: {
    adapterId, controlSessionId, conversationSessionId: 's1',
    conversationSessionAddress: { serverId: 'server-a', sessionId: 's1' },
    lifetime: 'runtime_attempt', transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt: 1,
  } });
  const barrierInput = {
    adapterId, controlSessionId,
    resolveSessionId: () => 's1', effectCalls: 'stable_ids',
    async submitResults(_responseId: string, results: readonly import('@happier-dev/protocol').VoiceRealtimeToolResultV1[]) {
      for (const event of runtime.encodeToolResults(results)) await connection.sendControl(event);
    },
    async continueResponse(responseId: string) {
      await connection.sendControl(runtime.encodeToolContinuation(responseId));
    },
  } as const;
  const barrier = hostLease.host.createToolBarrier(barrierInput);
  await connection.connect(lifetime.signal);
  const failures: unknown[] = [];
  const tasks = new Set<Promise<unknown>>();
  const pump = (async () => {
    for await (const control of connection.controlEvents(lifetime.signal)) {
      for (const event of runtime.protocol.decodeControl(control)) {
        if (event.type !== 'tool_calls') continue;
        const task = barrier.run({
          responseId: event.responseId, calls: event.calls, signal: lifetime.signal,
        }).catch(async (error) => {
          failures.push(error);
          // The production controller terminates the attempt when canonical
          // custody rejects conflicting response/call identity.
          lifetime.abort(); barrier.dispose();
          await connection.close({ code: 'error', detail: 'voice_tool_barrier_failed' });
        }).finally(() => tasks.delete(task));
        tasks.add(task);
      }
    }
  })();
  const close = async () => {
    lifetime.abort(); barrier.dispose();
    await connection.close({ code: 'user_stop' });
    await pump;
    await Promise.all(tasks);
    await runtime.dispose?.();
    unbindVoiceRuntimeAttemptBindingIfOwned({ conversationSessionId: 's1', owner: bindingOwner });
    hostLease.revoke();
  };
  onTestFinished(close);
  return {
    sent, failures, directEffect, connection, close,
    deliver(callId: string | undefined, message: string) {
      return incoming({ type: 'client_tool_call', client_tool_call: {
        tool_name: 'sendSessionMessage', tool_call_id: callId, parameters: { message },
      } });
    },
  };
}

function retainVoiceSessionReferenceCorpus(input: Readonly<{
  addresses: ReadonlyArray<Readonly<{ serverId: string; sessionId: string }>>;
  complete: boolean;
  sourceScopeKey?: string;
  referenceCorpusActive?: boolean;
}>): void {
  const statesByServerId = Object.fromEntries(
    [...new Set(input.addresses.map((address) => address.serverId))].map((serverId) => [
      serverId,
      {
        requestedQueryKey: `query:${serverId}`,
        appliedQueryKey: input.complete ? `query:${serverId}` : null,
        addresses: input.addresses.filter((address) => address.serverId === serverId),
        nextCursor: input.complete ? null : 'ordinary-next',
        hasNext: !input.complete,
        attentionNextCursor: null,
        attentionHasNext: false,
        phase: input.complete ? 'ready' as const : 'loading' as const,
        freshnessAt: 1,
        failureReason: null,
        failureCode: null,
        appliedSourceKind: input.complete ? 'query' as const : null,
      },
    ]),
  );
  retainSessionListPaneState({
    storageKind: 'all',
    pathname: '/',
    sourceScopeKey: input.sourceScopeKey ?? 'voice-reference-test-scope',
    paneState: {
      summary: { sessionsReady: input.complete, sessionCount: input.addresses.length },
      visibleSessionListIndex: [],
      hasHiddenInactiveSessions: false,
      folderFeatureEnabledServerIds: [],
      folderFocus: null,
      showLoading: false,
      showEmptyState: false,
      query: {
        active: true,
        statesByServerId,
        byServerId: {},
        source: [],
        coverageComplete: input.complete,
        loadNext: async () => {},
        refresh: async () => {},
      },
    },
    queryMembershipActive: true,
    referenceCorpusActive: input.referenceCorpusActive ?? true,
    selectedServerIds: [...new Set(input.addresses.map((address) => address.serverId))],
  });
}

function retainOrdinaryVoiceSessionReferenceCorpus(input: Readonly<{
  selectedServerIds: readonly string[];
  referenceCorpusActive?: boolean;
  sourceScopeKey?: string;
}>): void {
  retainSessionListPaneState({
    storageKind: 'all',
    pathname: '/',
    sourceScopeKey: input.sourceScopeKey ?? 'voice-ordinary-reference-test-scope',
    paneState: {
      summary: { sessionsReady: true, sessionCount: 1 },
      visibleSessionListIndex: [],
      hasHiddenInactiveSessions: false,
      folderFeatureEnabledServerIds: [],
      folderFocus: null,
      showLoading: false,
      showEmptyState: false,
      query: {
        active: false,
        statesByServerId: {},
        byServerId: {},
        source: null,
        coverageComplete: false,
        loadNext: async () => {},
        refresh: async () => {},
      },
    },
    queryMembershipActive: true,
    referenceCorpusActive: input.referenceCorpusActive ?? true,
    selectedServerIds: input.selectedServerIds,
  });
}

// The mounted Sessions pane, not retained lookup rows, owns Voice membership.
function retainFixtureSessionListCorpus(): void {
  retainVoiceSessionReferenceCorpus({
    addresses: Object.entries(state.sessionListIndexByServerId).flatMap(([serverId, entries]) =>
      (entries as Array<{ sessionId: string }>).map(({ sessionId }) => ({ serverId, sessionId }))),
    complete: true,
  });
}

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => ({ ...state, applySettingsLocal }),
  },
});
});

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
  const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
  return await createTokenStorageModuleMock({
    importOriginal,
    tokenStorage: {
      getCredentialsForServerUrl: vi.fn(async () => ({
        token: 'e30.eyJzdWIiOiJ2b2ljZS10b29scy1hY2NvdW50In0.signature',
      })),
    },
  });
});

vi.mock('@/voice/session/voiceSession', () => ({
  voiceSessionManager: { stop: voiceSessionStop },
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => ({ applySettings: applySettingsLocal }),
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
  runtimeFetchWithServerReachability: (params: unknown) => runtimeFetchWithServerReachability(params),
}));

vi.mock('@/sync/ops', () => ({
  // Permission RPC is executed via server-scoped session RPC in the action executor.
}));

vi.mock('@/track', () => ({
  trackPermissionResponse: (...args: any[]) => trackPermissionResponse(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    sendMessage: (sessionId: string, message: string) => sendMessage(sessionId, message),
    submitMessage: (...args: any[]) => submitMessage(...args),
    ensureSessionVisibleForMessageRoute: (sessionId: string, options?: { forceRefresh?: boolean }) =>
      ensureSessionVisibleForMessageRoute(sessionId, options),
    refreshSessionMessages: (sessionId: string) => refreshSessionMessages(sessionId),
    createArtifactWithHeader: (...args: any[]) => createArtifactWithHeader(...args),
    readOrdinarySessionListCoverage: () => readOrdinarySessionListCoverage(),
    encryption: {
      getSessionEncryption: (sessionId: string) => getSessionEncryption(sessionId),
    },
  },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
  sendSessionMessageWithServerScope: (args: any) => sendSessionMessageWithServerScope(args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: (args: any) => sessionRpcWithServerScope(args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (args: any) => machineRpcWithServerScope(args),
}));

vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({
  teleportVoiceAgentToSessionRoot: (args: any) => teleportVoiceAgentToSessionRoot(args),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunStart: (sessionId: string, request: any, opts?: any) => executionRunStart(sessionId, request, opts),
  sessionExecutionRunList: (sessionId: string, request: any, opts?: any) => executionRunList(sessionId, request, opts),
  sessionExecutionRunGet: (sessionId: string, request: any, opts?: any) => executionRunGet(sessionId, request, opts),
  sessionExecutionRunSend: (sessionId: string, request: any, opts?: any) => executionRunSend(sessionId, request, opts),
  sessionExecutionRunStop: (sessionId: string, request: any, opts?: any) => executionRunStop(sessionId, request, opts),
  sessionExecutionRunAction: (sessionId: string, request: any, opts?: any) => executionRunAction(sessionId, request, opts),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
  setActiveServerAndSwitch: (params: any) => setActiveServerAndSwitch(params),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({
    serverId: 'server-a',
    serverUrl: 'https://server-a.test',
    generation: 1,
  }),
  getActiveServerHomeCarrier: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
  const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
  return await createPartialServerProfilesModuleMock(importOriginal, {
    profiles: [
      { id: 'server-a', name: 'Server A', serverUrl: 'https://server-a.test', serverIdentityId: 'server-identity-a' },
      { id: 'server-b', name: 'Server B', serverUrl: 'https://server-b.test', serverIdentityId: 'server-identity-b' },
    ],
  });
});

const authFixture = {
  isAuthenticated: true,
  credentials: { token: 'account-token' },
  credentialAuthorityKind: 'account',
  login: async () => ({ kind: 'completed' as const }),
  loginWithCredentials: async () => ({ kind: 'completed' as const }),
  logout: async () => ({ kind: 'completed' as const }),
  refreshFromActiveServer,
} satisfies AuthContextType;
let previousAuth: AuthContextType | null;

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { navigate: (...args: any[]) => routerNavigate(...args) },
    });
    return expoRouterMock.module;
});

describe('voice tool handlers', () => {
  it('routes real ElevenLabs duplicate and concurrent calls through canonical Action custody', async () => {
    const harness = await createElevenLabsToolHarness();
    const first = harness.deliver('provider-a', 'first');
    const duplicate = harness.deliver('provider-a', 'first');
    const sibling = harness.deliver('provider-b', 'second');
    await vi.waitFor(() => expect(sendSessionMessageWithServerScope).toHaveBeenCalledTimes(2));
    await Promise.all([first, duplicate, sibling]);
    expect(harness.directEffect).not.toHaveBeenCalled();
    expect(harness.sent.filter((event) => event.type === 'client_tool_result').map((event) => event.tool_call_id))
      .toEqual(expect.arrayContaining(['provider-a', 'provider-a', 'provider-b']));
    expect(harness.sent.filter((event) => event.type === 'client_tool_result')).toHaveLength(3);
    await harness.deliver('provider-a', 'first');
    expect(sendSessionMessageWithServerScope).toHaveBeenCalledTimes(2);
    expect(harness.sent.filter((event) => event.tool_call_id === 'provider-a')).toHaveLength(3);
    expect(harness.failures).toEqual([]);
    await harness.deliver(undefined, 'missing identity');
    expect(sendSessionMessageWithServerScope).toHaveBeenCalledTimes(2);
    expect(harness.sent.at(-1)).toMatchObject({ is_error: true });
    expect(harness.connection.state()).toBe('open');
  });

  it('keeps real ElevenLabs identified calls behind canonical Action approval', async () => {
    state.settings.actionsSettingsV1 = {
      v: 1, actions: { 'session.message.send': { approvalRequiredSurfaces: ['voice'] } },
    };
    const harness = await createElevenLabsToolHarness();
    const delivery = harness.deliver('provider-approval', 'requires approval');
    await vi.waitFor(() => expect(artifactCreateRequests).toHaveBeenCalledTimes(1));
    await delivery;
    expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();
    expect(harness.directEffect).not.toHaveBeenCalled();
    const result = harness.sent.find((event) => event.tool_call_id === 'provider-approval');
    expect(JSON.parse(String(result?.result))).toMatchObject({
      ok: true, kind: 'approval_request_created', actionId: 'session.message.send',
    });
  });

  it('rejects real ElevenLabs conflicting duplicates without assigning the first result to the conflicting callback', async () => {
    let release!: (value: unknown) => void;
    sendSessionMessageWithServerScope.mockImplementationOnce(async () =>
      await new Promise((resolve) => { release = resolve; }));
    const harness = await createElevenLabsToolHarness();
    const first = harness.deliver('provider-conflict', 'first');
    await vi.waitFor(() => expect(sendSessionMessageWithServerScope).toHaveBeenCalledTimes(1));
    const conflict = harness.deliver('provider-conflict', 'different effect');
    await Promise.all([first, conflict]);
    expect(harness.failures).toEqual([expect.objectContaining({ code: 'response_conflict' })]);
    expect(harness.connection.state()).toBe('closed');
    expect(harness.sent.filter((event) => event.type === 'client_tool_result'))
      .toEqual([expect.objectContaining({ is_error: true }), expect.objectContaining({ is_error: true })]);
    expect(sendSessionMessageWithServerScope).toHaveBeenCalledTimes(1);
    expect(harness.directEffect).not.toHaveBeenCalled();
    release({ ok: true, ack: { ok: true, localId: 'after-conflict', persistence: 'pending', accepted: true } });
  });

  it('settles real ElevenLabs cancelled callbacks and cannot deliver late results or replay them on a new connection', async () => {
    let release!: (value: unknown) => void;
    sendSessionMessageWithServerScope.mockImplementationOnce(async () =>
      await new Promise((resolve) => { release = resolve; }));
    const harness = await createElevenLabsToolHarness();
    const delivery = harness.deliver('provider-cancelled', 'pending message');
    await vi.waitFor(() => expect(sendSessionMessageWithServerScope).toHaveBeenCalledTimes(1));
    await harness.close();
    await delivery;
    const resultsAtClose = harness.sent.length;
    release({ ok: true, ack: { ok: true, localId: 'late', persistence: 'pending', accepted: true } });
    await Promise.resolve(); await Promise.resolve();
    expect(harness.sent).toHaveLength(resultsAtClose);
    await harness.deliver('late-start-call', 'must not execute');
    expect(sendSessionMessageWithServerScope).toHaveBeenCalledTimes(1);
    const replacement = await createElevenLabsToolHarness();
    expect(replacement.sent).toEqual([]);
    expect(replacement.connection.state()).toBe('open');
  });
  beforeEach(() => {
    previousAuth = getCurrentAuth();
    setCurrentAuth(authFixture);
    state = createBaseState();
    resetServerFeaturesClientForTests();
    resetSessionListPaneRetentionForTests();
    registerStorageStateReader(readMockStorageState);
    trackPermissionResponse.mockReset();
    sendMessage.mockReset();
    submitMessage.mockReset();
    submitMessage.mockResolvedValue(undefined);
    ensureSessionVisibleForMessageRoute.mockReset();
    ensureSessionVisibleForMessageRoute.mockResolvedValue({ kind: 'available' });
    refreshSessionMessages.mockReset();
    sendSessionMessageWithServerScope.mockReset();
    sendSessionMessageWithServerScope.mockResolvedValue({
      ok: true,
      ack: { ok: true, localId: 'voice-input-1', persistence: 'pending', accepted: true },
    });
    sessionRpcWithServerScope.mockReset();
    executionRunStart.mockReset();
    executionRunList.mockReset();
    executionRunGet.mockReset();
    executionRunSend.mockReset();
    executionRunStop.mockReset();
    executionRunAction.mockReset();
    machineRpcWithServerScope.mockReset();
    setActiveServerAndSwitch.mockReset();
    routerNavigate.mockReset();
    refreshFromActiveServer.mockReset();
    applySettingsLocal.mockReset();
    teleportVoiceAgentToSessionRoot.mockReset();
    createArtifactWithHeader.mockReset();
    artifactCreateRequests.mockReset();
    createArtifactWithHeader.mockResolvedValue('approval-artifact-1');
    voiceSessionStop.mockClear();
    runtimeFetchWithServerReachability.mockReset();
    readOrdinarySessionListCoverage.mockClear();
    readOrdinarySessionListCoverage.mockReturnValue({ serverId: 'server-a', coverage: 'complete' });
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
    const respond = async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/v1/features') {
        return Response.json(createRootLayoutFeaturesResponse());
      }
      if (pathname === '/v1/account/encryption') {
        return Response.json({ mode: 'plain', updatedAt: 1 });
      }
      if (pathname === '/v2/account/settings') {
        return Response.json({ content: { t: 'plain', v: state.settings }, version: 1 });
      }
      if (pathname === '/v1/artifacts' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as {
          id: string;
          header: string;
          body: string;
          dataEncryptionKey: string;
        };
        artifactCreateRequests(request);
        return Response.json({
          ...request,
          ownerAccountId: 'voice-tools-account', access: 'owner', encryptionMode: 'plain',
          headerVersion: 1,
          bodyVersion: 1,
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      if (pathname === '/v2/account/session-follow-voice-inclusions' && init?.method === 'PUT') {
        const request = JSON.parse(String(init.body)) as { sessionIds: string[] };
        return Response.json({ changed: true, sessionIds: request.sessionIds });
      }
      throw new Error(`Unexpected Voice Action account request: ${pathname}`);
    };
    setRuntimeFetch(respond);
    runtimeFetchWithServerReachability.mockImplementation(async (request: {
      url: string;
      init?: RequestInit;
    }) => await respond(request.url, request.init));
  });

  afterEach(() => {
    setCurrentAuth(previousAuth);
    resetRuntimeFetch();
  });

  it('routes sendSessionMessage through canonical Voice Message admission for the resolved session', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.sendSessionMessage({ message: 'hi' });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(sendSessionMessageWithServerScope).toHaveBeenCalledWith({
      sessionId: 's1',
      serverId: 'server-a',
      message: 'hi',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      hostAdmissionOrigin: 'voice',
    });
    expect(submitMessage).not.toHaveBeenCalled();

  });

  it('preserves an execution-run recipient through canonical Voice Message admission', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentSessionAddress: { serverId: 'server-a', sessionId: 's1' },
    });

    const result = await tools.sendSessionMessage({
      message: 'Continue this run',
      recipient: { kind: 'execution_run', runId: 'run-1' },
    });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(sendSessionMessageWithServerScope).toHaveBeenCalledWith({
      sessionId: 's1',
      serverId: 'server-a',
      message: 'Continue this run',
      recipient: { kind: 'execution_run', runId: 'run-1' },
      requestedAction: { v: 1, kind: 'steer_if_active' },
      hostAdmissionOrigin: 'voice',
    });
  });

  it('does not admit a Voice session message after its invocation was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await (tools.sendSessionMessage as any)({ message: 'hi' }, { signal: controller.signal });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'tool_cancelled' });
    expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it('routes sendSessionMessage through canonical Voice approval before delivery', async () => {
    state.settings.actionsSettingsV1 = {
      v: 1,
      actions: {
        'session.message.send': {
          approvalRequiredSurfaces: ['voice'],
        },
      },
    };
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentSessionAddress: { serverId: 'server-a', sessionId: 's1' },
    });

    const result = JSON.parse(await tools.sendSessionMessage(
      { message: 'requires approval' },
      { effectId: 'effect-message-approval' },
    ));

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      kind: 'approval_request_created',
      artifactId: expect.any(String),
      actionId: 'session.message.send',
    });
    expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it('reports a target update requirement from canonical Voice admission without retaining an unknown outcome', async () => {
    sendSessionMessageWithServerScope.mockResolvedValueOnce({
      ok: false,
      errorCode: 'session_input_target_update_required',
      error: 'session_input_target_update_required',
    });
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await tools.sendSessionMessage({ message: 'hi' });

    expect(JSON.parse(result)).toEqual({
      ok: false,
      errorCode: 'session_input_target_update_required',
      errorMessage: 'session_input_target_update_required',
      actionId: 'session.message.send',
      sessionId: 's1',
    });
  });

  it('exposes review.start through the catalog voice binding', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });
    expect(tools.startReview).toEqual(expect.any(Function));
  });

  it('reads the descriptor-only current UI snapshot through the attempt-scoped port', async () => {
    const snapshot = {
      navigation: {
        area: 'plugin' as const,
        screen: 'page',
        title: 'PLUGIN_LABEL_SENTINEL',
      },
      commands: [{ id: 'opaque-command', title: 'Open issue #124' }],
    };
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: {
        readCurrentUiContext: () => snapshot,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
      },
    });

    await expect(tools.readCurrentUiContext({})).resolves.toBe(JSON.stringify(snapshot));
  });

  it('does not expose current UI read or command tools when UI context sharing is off', async () => {
    state.settings.voice.privacy.currentUiContextMode = 'off';
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: {
        readCurrentUiContext: () => ({
          navigation: { area: 'app', screen: 'home' },
          commands: [],
        }),
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeCurrentUiCommand: async () => ({ ok: true as const }),
      },
    });

    expect(tools.readCurrentUiContext).toBeUndefined();
    expect(tools.invokeCurrentUiCommand).toBeUndefined();
  });

  it('withholds current-UI Action specs from generic Voice discovery when sharing is off', async () => {
    state.settings.voice.privacy.currentUiContextMode = 'off';
    const { getActionSpec } = await import('@happier-dev/protocol');
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: {
        readCurrentUiContext: () => null,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
      },
    });
    const searchToolName = getActionSpec('action.spec.search').bindings?.voiceClientToolName;
    if (!searchToolName) throw new Error('Missing action.spec.search Voice binding');

    const result = JSON.parse(await tools[searchToolName]!({ query: '', limit: 100 }));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.actionSpecs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ui.current_context.read' }),
      expect.objectContaining({ id: 'ui.current_context.command.invoke' }),
    ]));
  });

  it('denies captured current-UI handlers when an active Local Voice attempt turns sharing off', async () => {
    const readCurrentUiContext = vi.fn(() => ({
      navigation: { area: 'app' as const, screen: 'home' },
      commands: [],
    }));
    const invokeCurrentUiCommand = vi.fn(async () => ({ ok: true as const }));
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: {
        readCurrentUiContext,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeCurrentUiCommand,
      },
    });
    const read = tools.readCurrentUiContext;
    const invoke = tools.invokeCurrentUiCommand;
    if (!read || !invoke) throw new Error('Expected current-UI handlers while sharing is enabled');

    state.settings.voice.privacy.currentUiContextMode = 'off';

    await expect(read({})).resolves.toBe(JSON.stringify({
      ok: false,
      errorCode: 'current_ui_context_unavailable',
      errorMessage: 'current_ui_context_unavailable',
    }));
    await expect(invoke({ commandId: 'opaque-command' })).resolves.toBe(JSON.stringify({
      ok: false,
      errorCode: 'current_ui_command_unavailable',
      errorMessage: 'current_ui_command_unavailable',
    }));
    expect(readCurrentUiContext).not.toHaveBeenCalled();
    expect(invokeCurrentUiCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid string', 'always'],
    ['invalid non-string', true],
  ])('does not expose current UI tools when the persisted mode is an %s', async (_caseName, currentUiContextMode) => {
    state.settings.voice.privacy.currentUiContextMode = currentUiContextMode;
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: {
        readCurrentUiContext: () => ({
          navigation: { area: 'app', screen: 'home' },
          commands: [],
        }),
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeCurrentUiCommand: async () => ({ ok: true as const }),
      },
    });

    expect(tools.readCurrentUiContext).toBeUndefined();
    expect(tools.invokeCurrentUiCommand).toBeUndefined();
  });

  it('delegates current UI commands without exposing their private semantic payload', async () => {
    const invokeCurrentUiCommand = vi.fn(async () => ({
      ok: true as const,
      result: { opened: true },
    }));
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: {
        readCurrentUiContext: () => null,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeCurrentUiCommand,
      },
    });

    const result = await tools.invokeCurrentUiCommand({ commandId: 'opaque-command' });

    expect(invokeCurrentUiCommand).toHaveBeenCalledWith({ commandId: 'opaque-command' });
    expect(JSON.parse(result)).toEqual({ ok: true, result: { opened: true } });
    expect(result).not.toContain('opaque-command');
  });

  it('delegates contributed Actions by identity through the same current UI port', async () => {
    const invokeAction = vi.fn(async () => ({
      ok: true as const,
      result: { refreshed: true },
    }));
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: {
        readCurrentUiContext: () => null,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeAction,
      },
    });

    const result = await tools.invokeAction({
      action: { pluginId: 'acme.triage', localId: 'refresh-issues' },
      input: { repository: 'acme/widgets' },
    });

    expect(invokeAction).toHaveBeenCalledWith({
      action: { pluginId: 'acme.triage', localId: 'refresh-issues' },
      input: { repository: 'acme/widgets' },
    });
    expect(JSON.parse(result)).toEqual({ ok: true, result: { refreshed: true } });
    expect(result).not.toContain('acme/widgets');
  });

  it('denies the captured contributed Action tool when the user disables action.invoke mid-attempt', async () => {
    const invokeAction = vi.fn(async () => ({ ok: true as const, result: { refreshed: true } }));
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: {
        readCurrentUiContext: () => null,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeAction,
      },
    });
    const invoke = tools.invokeAction;
    if (!invoke) throw new Error('Expected the contributed Action tool while the Action is enabled');

    state.settings.actionsSettingsV1 = {
      v: 1,
      actions: { 'action.invoke': { enabled: false } },
    };

    await expect(invoke({
      action: { pluginId: 'acme.triage', localId: 'refresh-issues' },
    })).resolves.toBe(JSON.stringify({
      ok: false,
      errorCode: 'action_unavailable',
      errorMessage: 'action_unavailable',
    }));
    expect(invokeAction).not.toHaveBeenCalled();
  });

  it('does not expose the contributed Action tool when action.invoke is already disabled', async () => {
    state.settings.actionsSettingsV1 = {
      v: 1,
      actions: { 'action.invoke': { disabledSurfaces: ['voice'] } },
    };
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: {
        readCurrentUiContext: () => null,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => {},
        invokeAction: async () => ({ ok: true as const }),
      },
    });

    expect(tools.invokeAction).toBeUndefined();
  });

  it('denies a captured read-only tool when the Voice feature is disabled mid-attempt', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });
    const listSessions = tools.listSessions;
    if (!listSessions) throw new Error('Expected the session list tool while Voice is enabled');

    state.settings = {
      ...state.settings,
      featureToggles: { ...state.settings.featureToggles, voice: false },
    };

    await expect(listSessions({ limit: 1 })).resolves.toBe(JSON.stringify({
      ok: false,
      errorCode: 'action_disabled',
      errorMessage: 'action_disabled',
      actionId: 'session.list',
    }));
  });

  it('starts an execution run through the canonical Voice Action binding', async () => {
    const startArgs = {
      intent: 'voice_agent',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    };
    executionRunStart.mockResolvedValue({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await tools.startExecutionRun(startArgs);

    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining(startArgs),
      { serverId: 'server-a' },
    );
    expect(JSON.parse(result)).toMatchObject({ ok: true, runId: 'run_1' });
  });

  it('can apply an execution run action via sessionExecutionRunAction', async () => {
    executionRunAction.mockResolvedValue({ ok: true, updatedToolResult: { ok: true } });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.actionExecutionRun({ runId: 'run_1', actionId: 'review.triage', input: { findings: [] } });
    expect(executionRunAction).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ runId: 'run_1', actionId: 'review.triage' }),
      { serverId: 'server-a' },
    );
    expect(JSON.parse(res)).toMatchObject({ ok: true });
  });

  it('can list execution runs via sessionExecutionRunList', async () => {
    executionRunList.mockResolvedValue({ runs: [] });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listExecutionRuns({});
    expect(executionRunList).toHaveBeenCalledWith('s1', {}, { serverId: 'server-a' });
    expect(JSON.parse(res)).toMatchObject({ runs: [] });
  });

  it('can get an execution run via sessionExecutionRunGet', async () => {
    executionRunGet.mockResolvedValue({
      run: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        status: 'succeeded',
        startedAtMs: 1,
        finishedAtMs: 2,
        availableActionIds: ['voice_agent.welcome'],
      },
    });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.getExecutionRun({ runId: 'run_1' });
    expect(executionRunGet).toHaveBeenCalledWith('s1', { runId: 'run_1', includeStructured: false }, { serverId: 'server-a' });
    expect(JSON.parse(res)).toMatchObject({ run: { runId: 'run_1', availableActionIds: ['voice_agent.welcome'] } });
  });

  it('does not expose a detached run send on the Session Voice surface', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });
    expect(tools).not.toHaveProperty('sendExecutionRunMessage');
  });

  it('can stop an execution run via sessionExecutionRunStop', async () => {
    executionRunStop.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.stopExecutionRun({ runId: 'run_1' });
    expect(executionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_1' }, { serverId: 'server-a' });
    expect(JSON.parse(res)).toMatchObject({ ok: true });
  });

  it('routes strict V2 session creation through the canonical Voice Action executor', async () => {
    const spawnInput = {
      creationKey: 'manual:voice-v2-contract',
      executionTarget: {
        serverId: 'server-a',
        machineId: 'm1',
      },
      directory: { kind: 'path', path: '/tmp/s1' },
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      initialInput: {
        text: 'Inspect this project.',
      },
    };
    const spawnResult = {
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 's_new',
      executionTarget: {
        serverId: 'server-a',
        machineId: 'm1',
      },
      organizationPlacement: {
        folderId: null,
        tagIds: [],
      },
      initialInput: {
        status: 'notRequested' as const,
      },
    };
    machineRpcWithServerScope.mockResolvedValue(spawnResult);

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const { getActionSpec } = await import('@happier-dev/protocol');
    const parsedSpawnInput = getActionSpec('session.spawn_new').inputSchema.safeParse(spawnInput);
    expect(parsedSpawnInput.success, JSON.stringify(parsedSpawnInput)).toBe(true);
    const response = JSON.parse(await tools.spawnSession(spawnInput, {
      serverId: 'server-a',
      callId: 'voice-spawn-call',
      effectId: 'voice-spawn-effect',
    }));

    expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
    expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-a',
      machineId: 'm1',
      method: RPC_METHODS.SESSION_SPAWN_NEW,
      payload: spawnInput,
      signal: undefined,
    }));
    expect(response).toEqual({ ok: true, ...spawnResult });
  });

  it('rejects retired flat spawnSession arguments before dispatching', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const response = JSON.parse(await tools.spawnSession({ tag: 't1' }));

    expect(response).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(machineRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('lists recent paths without exposing raw paths', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listRecentPaths({ limit: 10 });
    const parsed = JSON.parse(res);
    expect(parsed, res).toMatchObject({ ok: true });
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.every((item: any) => typeof item.label === 'string')).toBe(true);
    expect(parsed.items.every((item: any) => !String(item.label ?? '').includes('/tmp/'))).toBe(true);
    expect(parsed.items.every((item: any) => !String(item.label ?? '').includes('/Users/alice/'))).toBe(true);
  });

  it('disambiguates duplicate path labels with human-readable path tails', async () => {
    state.authoringMemory.recentMachinePaths = [
      { machineId: 'm1', path: '/Users/leeroy/workspaces/apps/leeroy' },
      { machineId: 'm1', path: '/Users/leeroy/workspaces/docs/leeroy' },
    ];
    state.sessions = {
      ...state.sessions,
      s3: {
        id: 's3',
        active: true,
        presence: 'online',
        updatedAt: 3000,
        metadata: { path: '/Users/leeroy/workspaces/apps/leeroy', machineId: 'm1', host: 'a-host', summary: { text: 'Apps session' } },
      },
      s4: {
        id: 's4',
        active: true,
        presence: 'online',
        updatedAt: 4000,
        metadata: { path: '/Users/leeroy/workspaces/docs/leeroy', machineId: 'm1', host: 'a-host', summary: { text: 'Docs session' } },
      },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listRecentPaths({ limit: 10 });
    const parsed = JSON.parse(res);

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.items.map((item: any) => item.label)).toEqual(
      expect.arrayContaining([
        'apps/leeroy — a-host',
        'docs/leeroy — a-host',
      ]),
    );
  });

  it('lists only the requested machine paths when another machine shares the same collapsed label', async () => {
    state.settings.voice.privacy.shareDeviceInventory = true;
    state.authoringMemory.recentMachinePaths = [
      { machineId: 'm1', path: '/Users/leeroy' },
      { machineId: 'm1_alias', path: '/Users/leeroy' },
    ];
    state.machines = {
      ...state.machines,
      m1_alias: { id: 'm1_alias', metadata: { host: 'a-host' } },
    };
    state.sessions = {
      ...state.sessions,
      s5: {
        id: 's5',
        active: true,
        presence: 'online',
        updatedAt: 5000,
        metadata: { path: '/Users/leeroy', machineId: 'm1_alias', host: 'a-host', summary: { text: 'Alias workspace session' } },
      },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listRecentPaths({ limit: 10, machineId: 'm1' });
    const parsed = JSON.parse(res);

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.items.some((item: any) => item.label === 'leeroy — a-host')).toBe(true);
    expect(parsed.items.every((item: any) => item.machineId === undefined)).toBe(true);
    expect(parsed.items.every((item: any) => !String(item.label ?? '').includes('m1_alias'))).toBe(true);
  });

  it('can list machines and servers for voice discovery', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const machinesRaw = await tools.listMachines({ limit: 10 });
    const machines = JSON.parse(machinesRaw);
    expect(machines).toMatchObject({ ok: true });
    expect(Array.isArray(machines.items)).toBe(true);
    expect(machines.items.map((m: any) => m.machineId)).toContain('m1');

    const serversRaw = await tools.listServers({ limit: 10 });
    const servers = JSON.parse(serversRaw);
    expect(servers).toMatchObject({ ok: true });
    expect(Array.isArray(servers.items)).toBe(true);
    expect(servers.items.map((s: any) => s.serverId)).toContain('server-a');
  });

  it('fails closed for inventory tools when shareDeviceInventory is disabled', async () => {
    state.settings.voice.privacy = { ...state.settings.voice.privacy, shareDeviceInventory: false };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const machinesRaw = await tools.listMachines({ limit: 10 });
    expect(JSON.parse(machinesRaw)).toMatchObject({ ok: false, errorCode: 'action_disabled' });

    const pathsRaw = await tools.listRecentPaths({ limit: 10 });
    expect(JSON.parse(pathsRaw)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
  });

  it('can list agent backends and models for spawning via voice', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const backendsRaw = await tools.listAgentBackends({});
    const backends = JSON.parse(backendsRaw);
    expect(backends).toMatchObject({ ok: true });
    expect(Array.isArray(backends.items)).toBe(true);
    expect(backends.items.length).toBeGreaterThan(0);

    const modelsRaw = await tools.listAgentModels({ agentId: 'claude' });
    const models = JSON.parse(modelsRaw);
    expect(models).toMatchObject({ ok: true });
    expect(Array.isArray(models.items)).toBe(true);
    expect(models.items.map((m: any) => m.modelId)).toContain('default');
  });

  it('still redacts recent paths when a raw voice privacy blob tries to enable file path sharing', async () => {
    state.settings.voice.privacy = {
      ...state.settings.voice.privacy,
      shareDeviceInventory: true,
      shareFilePaths: true,
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const pathsRaw = await tools.listRecentPaths({ limit: 10 });
    const parsed = JSON.parse(pathsRaw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) {
      expect(parsed.errorCode).toBe('privacy_disabled');
    }
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.every((item: any) => item.machineId === undefined && item.path === undefined)).toBe(true);
    expect(parsed.items.every((item: any) => !String(item.label ?? '').includes('/tmp/'))).toBe(true);
  });

  it('opens an exact Home-qualified session without re-inferring its Home from cache or focus', async () => {
    setActiveServerAndSwitch.mockResolvedValue(true);

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });

    const res = await tools.openSession({ sessionId: 's_other' }, { serverId: 'server-b' });
    expect(JSON.parse(res)).toMatchObject({ ok: true, sessionId: 's_other' });
    expect(setActiveServerAndSwitch).toHaveBeenCalledWith({
      serverId: 'server-b',
      scope: 'device',
      refreshAuth: refreshFromActiveServer,
    });
    expect(routerNavigate).toHaveBeenCalledWith('/session/s_other?serverId=server-b', expect.any(Object));
    expect(readOrdinarySessionListCoverage).not.toHaveBeenCalled();
  });

  it('resolves a unique natural Session title through the complete mounted Sessions corpus', async () => {
    setActiveServerAndSwitch.mockResolvedValue(true);
    retainVoiceSessionReferenceCorpus({
      addresses: [{ serverId: 'server-a', sessionId: 's_matrix' }],
      complete: true,
    });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Session QA Voice Matrix' }));

    expect(result).toMatchObject({ ok: true, sessionId: 's_matrix' });
    expect(routerNavigate).toHaveBeenCalledWith('/session/s_matrix?serverId=server-a', expect.any(Object));
  });

  it('keeps an exhausted feature-off ordinary corpus incomplete for strict My Work title resolution', async () => {
    setActiveServerAndSwitch.mockResolvedValue(true);
    retainOrdinaryVoiceSessionReferenceCorpus({ selectedServerIds: ['server-a'] });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Session QA Voice Matrix' }));

    expect(result).toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('keeps feature-off ordinary title resolution incomplete while its list corpus is not exhausted', async () => {
    retainOrdinaryVoiceSessionReferenceCorpus({ selectedServerIds: ['server-a'] });
    readOrdinarySessionListCoverage.mockReturnValue({ serverId: 'server-a', coverage: 'incomplete' });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Session QA Voice Matrix' }));

    expect(result).toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('does not treat an exhausted empty feature-off ordinary corpus as authoritative absence', async () => {
    state.ordinarySessionListMembershipByServerId['server-a'] = [];
    retainOrdinaryVoiceSessionReferenceCorpus({ selectedServerIds: ['server-a'] });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Missing session' }));

    expect(result).toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });
  });

  it('uses the focused retained Sessions corpus when another data-active pane remains mounted', async () => {
    setActiveServerAndSwitch.mockResolvedValue(true);
    retainVoiceSessionReferenceCorpus({
      addresses: [{ serverId: 'server-b', sessionId: 's_other' }],
      complete: true,
      sourceScopeKey: 'background-pane',
      referenceCorpusActive: false,
    });
    retainVoiceSessionReferenceCorpus({
      addresses: [{ serverId: 'server-a', sessionId: 's_matrix' }],
      complete: true,
      sourceScopeKey: 'focused-pane',
      referenceCorpusActive: true,
    });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Session QA Voice Matrix' }));

    expect(result).toMatchObject({ ok: true, sessionId: 's_matrix' });
    expect(routerNavigate).toHaveBeenCalledWith('/session/s_matrix?serverId=server-a', expect.any(Object));
  });

  it('fails duplicate natural Session ids and titles as ambiguous through the mounted Sessions corpus', async () => {
    state.sessionListRowsByServerId['server-b'].s_matrix = {
      ...state.sessionListRowsByServerId['server-a'].s_matrix,
      metadata: { summaryText: 'Session QA Voice Matrix', path: '/tmp/other' },
    };
    state.ordinarySessionListMembershipByServerId['server-b'] = ['s_matrix'];
    retainVoiceSessionReferenceCorpus({
      addresses: [
        { serverId: 'server-a', sessionId: 's_matrix' },
        { serverId: 'server-b', sessionId: 's_matrix' },
      ],
      complete: true,
    });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const titleResult = JSON.parse(await tools.openSession({ sessionTitle: 'Session QA Voice Matrix' }));
    const idResult = JSON.parse(await tools.openSession({ sessionId: 's_matrix' }));

    expect(titleResult).toMatchObject({ ok: false, errorCode: 'session_id_ambiguous' });
    expect(idResult).toMatchObject({ ok: false, errorCode: 'session_id_ambiguous' });
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('distinguishes absent from incomplete natural Session title resolution', async () => {
    retainVoiceSessionReferenceCorpus({
      addresses: [{ serverId: 'server-a', sessionId: 's_matrix' }],
      complete: true,
    });
    const completeTools = createVoiceToolHandlers({ resolveSessionId: () => null });
    expect(JSON.parse(await completeTools.openSession({ sessionTitle: 'Missing session' })))
      .toMatchObject({ ok: false, errorCode: 'session_not_found' });

    resetSessionListPaneRetentionForTests();
    const absentCorpusTools = createVoiceToolHandlers({ resolveSessionId: () => null });
    expect(JSON.parse(await absentCorpusTools.openSession({ sessionTitle: 'Session QA Voice Matrix' })))
      .toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });

    retainVoiceSessionReferenceCorpus({
      addresses: [{ serverId: 'server-a', sessionId: 's_matrix' }],
      complete: false,
    });
    const incompleteTools = createVoiceToolHandlers({ resolveSessionId: () => null });
    expect(JSON.parse(await incompleteTools.openSession({ sessionTitle: 'Session QA Voice Matrix' })))
      .toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('exposes review.start for cross-server sessions through the catalog voice binding', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : null) });
    expect(tools.startReview).toEqual(expect.any(Function));
  });

  it.each([
    { serverId: undefined, expected: { ok: false, errorCode: 'approval_origin_unavailable' } },
    { serverId: 'server-a', expected: { ok: true, kind: 'approval_request_created', actionId: 'ui.voice_global.reset' } },
  ])('keeps global agent memory intact until Voice reset approval (Home: $serverId)', async ({ serverId, expected }) => {
    const current = state.settings.voice.providers.local_conversation;
    state.settings.voice.providers.local_conversation = {
      ...current,
      config: {
        ...current.config,
        agent: {
          ...current.config.agent,
          transcript: { persistenceMode: 'persistent', epoch: 2 },
        },
      },
    };
    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });

    const result = JSON.parse(await tools.resetGlobalVoiceAgent({}, {
      ...(serverId ? { serverId } : {}),
      effectId: 'effect-reset-approval',
    }));

    expect(result).toMatchObject(expected);
    expect(voiceSessionStop).not.toHaveBeenCalled();
    expect(applySettingsLocal).not.toHaveBeenCalled();
    expect(state.settings.voice.providers.local_conversation.config.agent.transcript.epoch).toBe(2);
    if (serverId) {
      expect(result.artifactId).toEqual(expect.any(String));
      expect(artifactCreateRequests).toHaveBeenCalled();
    } else {
      expect(artifactCreateRequests).not.toHaveBeenCalled();
    }
  });

  it('increments agent transcript epoch for a direct UI reset when persistence is enabled', async () => {
    const current = state.settings.voice.providers.local_conversation;
    state.settings.voice.providers.local_conversation = {
      ...current,
      config: {
        ...current.config,
        agent: {
          ...current.config.agent,
          transcript: { persistenceMode: 'persistent', epoch: 2 },
        },
      },
    };

    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

    const result = await createDefaultActionExecutor().execute('ui.voice_global.reset', {}, {
      surface: 'ui', serverId: 'server-a',
    });
    expect(result).toMatchObject({ ok: true });
    expect(applySettingsLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({
          providers: expect.objectContaining({
            local_conversation: expect.objectContaining({
              config: expect.objectContaining({
                agent: expect.objectContaining({
                  transcript: expect.objectContaining({ epoch: 3 }),
                }),
              }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        source: 'ui',
        expectedSettingsScope: {
          serverId: 'server-a',
          accountId: 'voice-tools-account',
        },
      }),
    );
  });

  it('teleports the voice agent to the resolved session root', async () => {
    teleportVoiceAgentToSessionRoot.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.teleportVoiceAgentToSessionRoot({});
    expect(JSON.parse(res)).toMatchObject({ ok: true });
    expect(teleportVoiceAgentToSessionRoot).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('does not answer a covered user-action request', async () => {
    const questionPayload = { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] };
    state.sessions.s1.agentState.requests = {
      req_question_done: {
        id: 'req_question_done',
        tool: 'AskUserQuestion',
        kind: 'user_action',
        arguments: questionPayload,
        createdAt: 10,
      },
    };
    state.sessions.s1.agentState.completedRequests = {
      req_question_done: {
        tool: 'AskUserQuestion',
        kind: 'user_action',
        arguments: questionPayload,
        completedAt: 11,
        status: 'approved',
      },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({
      ok: false,
      errorCode: 'no_permission_request',
      sessionId: 's1',
    });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('requires present-user authority for a pending AskUserQuestion despite structured spoken answers', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: { id: 'req_question', tool: 'AskUserQuestion', kind: 'user_action' },
      req_permission: { id: 'req_permission', tool: 'Bash', kind: 'permission' },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('does not turn an approval-required setting into present-user authority for a spoken answer', async () => {
    state.settings.actionsSettingsV1 = {
      v: 1,
      actions: {
        'session.user_action.answer': {
          approvalRequiredSurfaces: ['voice'],
        },
      },
    };
    state.sessions.s1.agentState.requests = {
      req_question: { id: 'req_question', tool: 'AskUserQuestion', kind: 'user_action' },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = JSON.parse(await tools.answerUserActionRequest(
      { answers: [{ question: 'Continue?', values: ['Yes'] }] },
      { callId: 'call-user-action-approval' },
    ));

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      errorCode: 'present_user_required',
      actionId: 'session.user_action.answer',
    });
    expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
    expect(artifactCreateRequests).not.toHaveBeenCalled();
  });

  it('does not grant present-user authority to a spoken reject decision for a permission-labelled question', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: {
        id: 'req_question',
        tool: 'AskUserQuestion',
        kind: 'user_action',
        arguments: {
          questions: [
            {
              question: 'May I create QA_DENY_PATH.txt?',
              header: 'Permission',
              options: [
                { label: 'Yes, create it', description: 'Create the file' },
                { label: `No, don't create it`, description: 'Skip file creation' },
              ],
            },
          ],
        },
      },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      decision: 'reject',
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required', sessionId: 's1', requestId: 'req_question' });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('requires present-user authority for ExitPlanMode even when Voice requests changes', async () => {
    state.sessions.s1.agentState.requests = {
      req_exit_plan: { id: 'req_exit_plan', tool: 'ExitPlanMode', kind: 'user_action' },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      decision: 'request_changes',
      reason: 'The plan needs another pass before exiting plan mode.',
    });

    expect(JSON.parse(result), result).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('rejects a spoken user-action answer before entering the scoped RPC', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: { id: 'req_question', tool: 'AskUserQuestion', kind: 'user_action' },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found' });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('retains present-user authority requirements for a transcript-backed user-action request', async () => {
    state.sessions.sys_voice.agentState.requests = {};
    state.sessions.s1.agentState.requests = {};
    state.sessions.s2.agentState.requests = {};
    state.sessionMessages.s1.messages = [
      {
        kind: 'tool-call',
        id: 'm_pending_question',
        localId: null,
        createdAt: 11,
        children: [],
        tool: {
          id: 'req_question',
          name: 'AskUserQuestion',
          description: 'Ask the user a question',
          state: 'running',
          input: { questions: [{ question: 'Continue?' }] },
          createdAt: 11,
          startedAt: null,
          completedAt: null,
          permission: { id: 'req_question', status: 'pending', kind: 'user_action' },
        },
      },
    ];
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required', sessionId: 's1', requestId: 'req_question' });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('refreshes the resolved target session messages before failing a user-action response', async () => {
    state.sessions.s1.agentState.requests = {};
    state.sessionMessages.s1.messages = [];
    refreshSessionMessages.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 's1') return;
      state.sessionMessages.s1.messages = [
        {
          kind: 'tool-call',
          id: 'm_pending_question_after_refresh',
          localId: null,
          createdAt: 16,
          children: [],
          tool: {
            id: 'req_question_after_refresh',
            name: 'AskUserQuestion',
            description: 'Ask the user a question',
            state: 'running',
            input: { questions: [{ question: 'Continue with the write?' }] },
            createdAt: 16,
            startedAt: null,
            completedAt: null,
            permission: { id: 'req_question_after_refresh', status: 'pending', kind: 'user_action' },
          },
        },
      ];
    });
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue with the write?', values: ['Yes'] }],
    });

    expect(refreshSessionMessages).toHaveBeenCalledWith('s1');
    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required', sessionId: 's1', requestId: 'req_question_after_refresh' });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('forces a session refresh before failing a user-action response when the known session state is stale', async () => {
    state.sessions.s1.agentState.requests = {};
    state.sessionMessages.s1.messages = [];
    ensureSessionVisibleForMessageRoute.mockImplementation(async (sessionId: string, options?: { forceRefresh?: boolean }) => {
      if (sessionId !== 's1' || options?.forceRefresh !== true) return;
      state.sessions.s1.agentState.requests = {
        req_question_after_force_refresh: {
          id: 'req_question_after_force_refresh',
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: { questions: [{ question: 'Continue with local voice QA?' }] },
        },
      };
    });
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue with local voice QA?', values: ['Yes'] }],
    });

    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s1', { forceRefresh: true });
    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required', sessionId: 's1', requestId: 'req_question_after_force_refresh' });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('routes sendSessionMessage to an explicit sessionId through canonical Voice admission', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.sendSessionMessage({ sessionId: 's2', message: 'hello' });

    expect(JSON.parse(result), result).toMatchObject({ ok: true });
    expect(sendSessionMessageWithServerScope).toHaveBeenCalledWith({
      sessionId: 's2',
      serverId: 'server-a',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      hostAdmissionOrigin: 'voice',
    });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it('can set the primary action session', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.setPrimaryActionSession({ serverId: 'server-a', sessionId: 's2' });

    expect(JSON.parse(result), result).toMatchObject({ ok: true });
    expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: 'server-a', sessionId: 's2' });
  });

  it('does not serialize a partial tracked-set Action result as full success', () => {
    const serialized = serializeVoiceActionExecuteResult('session.target.tracked.set', {
      ok: true,
      result: {
        ok: false,
        status: 'partial',
        sessionIds: [],
        sessionAddresses: [],
        sessions: [],
        error: {
          code: 'session_follow_partial',
          message: 'Include in Voice was updated for only some sessions. Retry to finish the requested set.',
          operation: 'include',
          address: { serverId: 'server-a', sessionId: 's2' },
          reason: 'unavailable',
        },
      },
    });

    expect(JSON.parse(serialized)).toMatchObject({
      ok: false,
      status: 'partial',
      sessionAddresses: [],
      error: { code: 'session_follow_partial' },
    });
  });

  it('lists sessions as JSON', async () => {
    retainFixtureSessionListCorpus();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const defaultRes = await tools.listSessions({ view: 'summary', limit: 1 });
    const defaultParsed = JSON.parse(defaultRes) as any;
    expect(defaultParsed.sessions[0].lastMessagePreview).toBeUndefined();

    const res = await tools.listSessions({ view: 'summary', limit: 1, includeLastMessagePreview: true });
    const parsed = JSON.parse(res) as any;
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.length).toBe(1);
    expect(parsed.sessions[0].id).toBe('s1');
    expect(parsed.sessions.some((s: any) => s.id === 'sys_voice')).toBe(false);
    expect(typeof parsed.sessions[0].title).toBe('string');
    expect(parsed.sessions[0].lastMessagePreview?.text).toContain('a2');
    expect(typeof parsed.nextCursor === 'string').toBe(true);

    const res2 = await tools.listSessions({ view: 'summary', limit: 10, cursor: parsed.nextCursor, includeLastMessagePreview: true });
    const parsed2 = JSON.parse(res2) as any;
    expect(parsed2.sessions.some((s: any) => s.id === 's2')).toBe(true);
    const s2 = parsed2.sessions.find((s: any) => s.id === 's2');
    expect(s2?.lastMessagePreview?.role).toBe('tool');
    expect(s2?.lastMessagePreview?.text).toContain('Tool: read');
    expect(s2?.lastMessagePreview?.text).not.toContain('/Users/alice/SecretRepo/README.md');
    expect(s2?.lastMessagePreview?.text).not.toContain('Args:');

  });

  it('includes cached sessions from other servers in listSessions (with serverId)', async () => {
    retainFixtureSessionListCorpus();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ view: 'summary', limit: 10, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const other = parsed.sessions.find((s: any) => s.id === 's_other');
    expect(other).toBeTruthy();
    expect(other.serverId).toBe('server-b');
  });

  it('includes sessions that only exist in the current visible session list', async () => {
    retainFixtureSessionListCorpus();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ view: 'summary', limit: 20, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const visibleOnly = parsed.sessions.find((s: any) => s.id === 's_visible_only');
    expect(visibleOnly).toBeTruthy();
    expect(visibleOnly).toMatchObject({
      title: 'Visible only in current list',
      active: true,
      presence: 'online',
    });
  });

  it('omits the location label from listSessions results because file-path sharing is hardened off', async () => {
    retainFixtureSessionListCorpus();
    // `voiceSettingsParse` force-disables shareFilePaths over the voice transport, so the
    // workspace location label must not be surfaced to the provider.
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ view: 'summary', limit: 20, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const session = parsed.sessions.find((entry: any) => entry.id === 's1');
    expect(session).toMatchObject({ id: 's1' });
    expect(session.locationLabel).toBeUndefined();
  });

  it('prefers the visible human title over a stale raw session title for the same session id', async () => {
    retainFixtureSessionListCorpus();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ view: 'summary', limit: 20, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const matrix = parsed.sessions.find((s: any) => s.id === 's_matrix');
    expect(matrix).toBeTruthy();
    expect(matrix).toMatchObject({
      id: 's_matrix',
      title: 'Session QA Voice Matrix',
    });
  });

  it('uses session list renderables as a fallback human title source when raw sessions are stale', async () => {
    retainFixtureSessionListCorpus();
    state.sessionListViewData = null;

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ view: 'summary', limit: 20, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const matrix = parsed.sessions.find((s: any) => s.id === 's_matrix');
    expect(matrix).toBeTruthy();
    expect(matrix).toMatchObject({
      id: 's_matrix',
      title: 'Session QA Voice Matrix',
    });
  });

  it('uses a larger default session list page when limit is omitted so older visible titles stay discoverable', async () => {
    state.sessionListViewData = [
      ...Array.from({ length: 30 }, (_, index) => ({
        type: 'session',
        session: {
          id: `s_recent_${index + 1}`,
          active: true,
          updatedAt: 1000 - index,
          presence: 'online',
          metadata: { summaryText: `Recent session ${index + 1}`, path: `/tmp/recent-${index + 1}` },
        },
      })),
      {
        type: 'session',
        session: {
          id: 's_matrix',
          active: false,
          updatedAt: 60,
          presence: 'offline',
          metadata: { summaryText: 'Session QA Voice Matrix', path: '/tmp/matrix' },
        },
      },
    ];

    state.sessionListRowsByServerId['server-a'] = Object.fromEntries(
      state.sessionListViewData.map((entry: { session: { id: string } }) => [entry.session.id, entry.session]),
    );
    retainVoiceSessionReferenceCorpus({
      addresses: state.sessionListViewData.map((entry: { session: { id: string } }) => ({
        serverId: 'server-a', sessionId: entry.session.id,
      })),
      complete: true,
    });
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ view: 'summary', includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    expect(parsed.sessions.find((session: any) => session.id === 's_matrix')).toMatchObject({
      id: 's_matrix',
      title: 'Session QA Voice Matrix',
    });
  });

  it('redacts tool args in previews when shareToolArgs is false', async () => {
    retainFixtureSessionListCorpus();
    state.settings.voice.privacy.shareToolArgs = false;

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.listSessions({ view: 'summary', limit: 10, includeLastMessagePreview: true });
    const parsed = JSON.parse(res) as any;
    const s2 = parsed.sessions.find((s: any) => s.id === 's2');
    expect(s2?.lastMessagePreview?.text).toContain('Tool: read');
    expect(s2?.lastMessagePreview?.text).not.toContain('/Users/alice/SecretRepo/README.md');
    expect(s2?.lastMessagePreview?.text).not.toContain('Args:');
  });

  it('does not include user/assistant text previews in listSessions when shareRecentMessages is false', async () => {
    retainFixtureSessionListCorpus();
    state.settings.voice.privacy.shareRecentMessages = false;

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.listSessions({ view: 'summary', limit: 10, includeLastMessagePreview: true });
    const parsed = JSON.parse(res) as any;

    const s1 = parsed.sessions.find((s: any) => s.id === 's1');
    expect(s1?.lastMessagePreview).toBeUndefined();

    const s2 = parsed.sessions.find((s: any) => s.id === 's2');
    expect(s2?.lastMessagePreview?.role).toBe('tool');
    expect(s2?.lastMessagePreview?.text).toContain('Tool: read');
  });

  it('returns transcript messages for a session when allowed', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 2 });
    const parsed = JSON.parse(res) as any;
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBe(2);
    expect(parsed.items[0].role).toBe('user');
    expect(parsed.items[1].role).toBe('assistant');
    expect(tools.getSessionRecentMessages).toBeUndefined();
  });

  it('accepts larger on-demand limits for getSessionTranscript (up to 50)', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 20 });
    const parsed = JSON.parse(res) as any;
    expect(parsed.error).toBeUndefined();
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it('treats Account Follow Include in Voice sessions as active for snippets gating', async () => {
    state.settings.voice.ui.updates.otherSessionsSnippetsMode = 'never';
    state.sessions.s2.viewer = {
      follow: { follows: true, notificationLevel: 'important', includeInVoice: true },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's2', limit: 1 });
    const parsed = JSON.parse(res) as any;
    expect(parsed.error).toBeUndefined();
    expect(parsed.sessionId).toBe('s2');
  });

  it('redacts file paths in message text when shareFilePaths is false', async () => {
    state.settings.voice.privacy.shareFilePaths = false;
    (state.sessionMessages.s1.messages as any[]).push({
      kind: 'agent-text',
      id: 'm_path',
      localId: null,
      createdAt: 10,
      text: 'See /Users/alice/SecretRepo/README.md for details.',
    });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 1, roles: ['assistant'], maxCharsPerMessage: null });
    const parsed = JSON.parse(res) as any;
    expect(parsed.items[0].text).toContain('<path_redacted>');
    expect(parsed.items[0].text).not.toContain('/Users/alice/SecretRepo/README.md');
  });

  it('does not clamp message text by default', async () => {
    const long = 'x'.repeat(9001);
    state.sessionMessages.s1.messages = [
      { kind: 'agent-text', id: 'm_long', localId: null, createdAt: 100, text: long },
    ];

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 1, roles: ['assistant'] });
    const parsed = JSON.parse(res) as any;
    expect(parsed.items[0].text.length).toBe(9001);
  });

  it('returns a session activity digest without transcript content', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionActivity({ sessionId: 's1' });
    const parsed = JSON.parse(res) as any;

    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed.sessionId).toBe('s1');
    expect(Array.isArray(parsed.permissionRequestIds)).toBe(true);
    expect(parsed.permissionRequestIds).toContain('req_a');
    expect(parsed.messageCounts).toEqual(expect.any(Object));
    expect(parsed.messageCounts).toEqual({ total: 2, assistant: 1, user: 1 });
    expect(parsed.recentMessages).toBeUndefined();
  });

  it('requests the marked awareness view through the Voice Action executor for the captured Home', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionActivity(
      { sessionId: 's1', view: 'awareness' },
      { serverId: 'server-a' },
    );
    const parsed = JSON.parse(res) as any;

    expect(parsed).toMatchObject({
      ok: true,
      v: 1,
      sessionId: 's1',
    });
    expect(parsed.messageCounts).toBeUndefined();
    expect(parsed.permissionRequestIds).toBeUndefined();
    expect(parsed.recentMessages).toBeUndefined();
    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s1', {
      serverId: 'server-a',
      forceRefresh: true,
      includeTurnsProjection: false,
      hydrateMessages: false,
    });
  });

  it('respects actionsSettingsV1 disabledSurfaces for voice_tool surface', async () => {
    // Configure settings to disable session.message.send for voice_tool surface
    state.settings.actionsSettingsV1 = {
      v: 1,
      actions: {
        'session.message.send': {
          disabledSurfaces: ['voice_tool'],
        },
      },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await tools.sendSessionMessage({ message: 'hi' });
    const parsed = JSON.parse(result);

    // Should fail because action is disabled for voice_tool surface
    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBe('action_disabled');
    expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();
    expect(submitMessage).not.toHaveBeenCalled();
  });
});
