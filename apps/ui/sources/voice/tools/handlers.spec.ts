import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import * as React from 'react';
import { Conversation, TextConversation } from '@elevenlabs/client';
import { createElevenLabsVoiceProviderRuntime } from '../../../../../packages/plugins/elevenlabs/src/ui/voice/runtime';
import { createSdkHandleConnection } from '@/voice/runtime/connection/VoiceRealtimeConnection';
import {
  bindVoiceRuntimeAttemptBinding, createVoiceRuntimeAttemptBindingOwner,
  unbindVoiceRuntimeAttemptBindingIfOwned,
} from '@/voice/binding/voiceConversationBindingStore';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { ApprovalRequestSchema, DEFAULT_SESSION_CAPABILITIES, SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { SessionMessageV1Schema, SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { RawRecordSchema } from '@happier-dev/session-core/raw';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { readSessionMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { createDeferred, createSessionFixture, createSessionListRenderableSessionFixture, createSessionMessagesFixture, createSessionViewerFixture, createToolCallMessageFixture, renderHook, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import type { Message } from '@happier-dev/session-core/messages';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { PLUGIN_UI_HOST_API_VERSION_V1, PLUGIN_UI_HOST_API_WIRE_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import {
  resetSessionListPaneRetentionForTests,
  retainSessionListPaneState,
} from '@/components/sessions/shell/sessionListPaneRetention';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { AuthContextType } from '@/auth/context/AuthContext';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile, getServerProfileById, removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { currentPendingEnqueueAck } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createStandaloneVoicePolicyHarness, prepareStandaloneVoicePolicyHarness } from '@/dev/testkit/harness/standaloneVoicePolicyHarness';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { createExistingSessionDirectoryPreflightResult, createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

import { createVoiceToolHandlers, serializeVoiceActionExecuteResult } from './handlers';

// The daemon response is authored at the genuine Socket.IO boundary. Session
// eligibility, scoped Account admission, RPC framing and response parsing run.
const daemonRpc = vi.fn<(request: Readonly<{ serverUrl: string; sessionId: string; method: string; payload: unknown }>) => Promise<unknown>>();
const routerNavigate = vi.fn();
const refreshFromActiveServer = vi.fn(async () => {});
const pendingEnqueue = vi.fn<(request: Readonly<{ serverUrl: string; sessionId: string; runId: string | null; init: RequestInit }>) => Promise<Response>>();
const artifactCreateRequests = vi.fn();
let homeA = '';
let homeB = '';
let homeUrlA = '';
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
let accountHttp: NonNullable<ReturnType<typeof account.request.getMockImplementation>>;
let restoreCredentials: (() => Promise<boolean>) | undefined;
const sessionDetailReplies = new Map<string, ReturnType<typeof createSessionFixture>>();
const sessionDetailReads: string[] = [];
const messagePages = new Map<string, ReturnType<typeof SessionMessagesPageV1Schema.parse>>();
const messageReads: string[] = [];

function expectVoicePendingInput(sessionId: string, text: string, runId: string | null = null) {
  expect(pendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: homeUrlA, sessionId, runId }));
  const request = pendingEnqueue.mock.calls.find(([candidate]) => candidate.sessionId === sessionId)?.[0];
  if (!request) throw new Error('Voice input did not reach the Pending HTTP boundary');
  const body: unknown = JSON.parse(String(request.init.body));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected Pending HTTP body');
  const envelope = StrictSessionStoredMessageContentEnvelopeSchema.parse(Reflect.get(body, 'content'));
  if (envelope.t !== 'plain') throw new Error('Plain Account input must use the plain envelope');
  const record = RawRecordSchema.parse(envelope.v);
  expect(record).toMatchObject({ role: 'user', content: { text } });
  expect(readSessionMessageProvenanceV1(record.meta)).toEqual({ v: 1, kind: 'voice' });
  expect(PendingRequestedActionV1Schema.parse(Reflect.get(body, 'requestedAction'))).toEqual({ v: 1, kind: 'steer_if_active' });
}

function messagesFixture(messages: readonly Message[]) {
  return createSessionMessagesFixture({ isLoaded: true,
    messageIdsOldestFirst: messages.map(message => message.id),
    messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
  });
}

function seedMessages(sessionId: string, messages: readonly Message[]) {
  storage.setState({ sessionMessages: { ...storage.getState().sessionMessages, [sessionId]: messagesFixture(messages) } });
}

/** Committed HTTP rows, separate from the loaded transcript window. */
function seedTranscriptPage(sessionId: string, records: readonly unknown[]) {
  messagePages.set(sessionId, SessionMessagesPageV1Schema.parse({
    messages: records.map((record, index) => ({
      id: `committed-${index + 1}`, seq: index + 1, localId: null, createdAt: index + 1, updatedAt: index + 1,
      content: { t: 'plain', v: RawRecordSchema.parse(record) },
    })), hasMore: false,
  }));
}

async function mountCurrentUiContext(wireResult: Readonly<Record<string, boolean>> = { opened: true }) {
  const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
  const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
  const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
  const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
  const { CurrentUiContextProvider, useOptionalCurrentUiContextReader, usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
  const { useCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
  const { AppShellPluginUiProjectionProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
  const { usePluginUiProjectionCurrentness } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
  const { PluginProjectionV2Schema, PluginProjectedActionV2Schema, formatQualifiedPluginActionId,
    DaemonPluginActionSchemasReadResponseSchema, DaemonPluginStructuredMessageActionExecuteResponseSchema } = await import('@happier-dev/protocol');
  // These are daemon-authored declarations, consumed by the real normalizer,
  // origin union and effect dispatcher, not fabricated AppShell decisions.
  const sourceCustody = { kind: 'development' as const, registeredRootId: 'voice-tools-current-ui' };
  const executionOrigin = { serverIdentityId: 'srv_voice_tools_a',
    sourceRef: { machineId: 'm1', pluginId: 'acme.triage', sourceCustody } };
  const { setPluginMachineExecutionOriginPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
  storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: setPluginMachineExecutionOriginPreference(
    storage.getState().settings.machineAdministrationTargetsLocalV1, 'acme.triage', executionOrigin,
  ) });
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
      installedPackagesById: { 'acme.triage': { id: 'acme.triage', displayName: 'Triage', version: '1.0.0',
        enabled: true, source: { kind: 'localPath', locator: sourceCustody.registeredRootId },
        sourceCustody, executionOrigin, occurrenceId: 'voice-tools-current-ui' } }, agentsById: {},
      actionsById: { 'acme.triage/refresh-issues': PluginProjectedActionV2Schema.parse({
        id: 'refresh-issues', pluginId: 'acme.triage', occurrenceId: 'voice-tools-current-ui', title: 'Refresh issues',
        executionOrigin,
        scopes: ['global'], surfaces: ['voice'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
      }) },   resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] });
  const previous = daemonRpc.getMockImplementation();
  daemonRpc.mockImplementation(async request => {
    if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
    if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return DaemonPluginActionSchemasReadResponseSchema.parse({ ok: true,
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true } });
    if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true, result: wireResult });
    if (!previous) throw new Error('Voice daemon boundary is unavailable');
    return previous(request);
  });
  const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
  const { resetMachineProjectionReadsForTests } = await import('@/sync/ops/machineContributionRegistryProjection');
  clearDaemonMergedProjectionCacheForTests();
  resetMachineProjectionReadsForTests();
  storage.getState().applyMachines([storage.getState().machines.m1], true);
  const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
  observeMachinePresenceForTest(account.scope, ['m1']);
  const enrichment = { entity: { kind: 'plugin', label: 'PLUGIN_LABEL_SENTINEL' }, commands: [{
    title: 'Open issue #124', command: { kind: 'executeAction' as const,
      action: { pluginId: 'acme.triage', localId: 'refresh-issues' },
      input: { repository: 'acme/widgets', privateQuery: 'must-remain-local' } },
  }] };
  function Publication() {
    // The presented Machine surface owns acquisition; AppShell only observes it.
    usePluginUiProjectionCurrentness({ machineId: 'm1', serverId: homeA });
    usePublishCurrentUiContext(enrichment);
    return null;
  }
  const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(InjectedAuthProvider,
    { credentials: account.credentials, children: null }, React.createElement(MainAppTabStateProvider, null,
      React.createElement(AppPaneProvider, null, React.createElement(AppShellPluginUiProjectionProvider, null,
        React.createElement(CurrentUiContextProvider, null,
        React.createElement(PluginSurfaceFocusEligibilityProvider, { active: true, currentUiContextActive: true, children: null },
          React.createElement(Publication), children))))));
  const mounted = await renderHook(() => ({ reader: useOptionalCurrentUiContextReader(), port: useCurrentUiContextVoiceToolPort(),
    projection: useAppShellPluginUiProjection() }), { wrapper });
  const { reader, port } = mounted.getCurrent();
  if (!reader) throw new Error('Canonical Current UI owner did not mount');
  if (!port) throw new Error('Canonical Current UI Voice port did not mount');
  await waitForTestEvent(mounted.subscribe, mounted.getCurrent, value => (
    value.port?.listCurrentContributedActionDefinitions?.().some(action => action.id === formatQualifiedPluginActionId({ pluginId: 'acme.triage', localId: 'refresh-issues' })) === true
  ));
  {
    const { projection: current } = mounted.getCurrent();
    expect(mounted.getCurrent().port?.listCurrentContributedActionDefinitions?.(), JSON.stringify({
      phase: current.phase, reason: current.unavailableReasonCode, interactionEnabled: current.interactionEnabled,
      machineId: current.machineId, actionIds: Object.keys(current.pluginUiProjection?.actionsById ?? {}),
      daemonMethods: daemonRpc.mock.calls.map(([request]) => request.method),
    })).toEqual(expect.arrayContaining([expect.objectContaining({ id: formatQualifiedPluginActionId({ pluginId: 'acme.triage', localId: 'refresh-issues' }) })]));
  }
  const commandId = reader.readCurrentUiContext()?.commands[0]?.id;
  return { port: mounted.getCurrent().port!, reader, commandId };
}

function createBaseState(): any {
  return {
    profileScope: { serverId: homeA, accountId: 'account-a' },
    settingsScope: { serverId: homeA, accountId: 'account-a' },
    sessionListViewData: null,
    sessions: {
      s1: createSessionFixture({
        id: 's1',
        serverId: homeA,
        thinking: false,
        active: true,
        updatedAt: 200,
        presence: 'online',
        agentState: {
          requests: {
            req_a: { tool: 'Bash', kind: 'permission', arguments: {} },
            req_b: { tool: 'Read', kind: 'permission', arguments: {} },
          },
        },
        metadata: { path: '/Users/alice/project-alpha', homeDir: '/Users/alice', machineId: 'm1', host: 'a-host', flavor: 'claude', summary: { text: 'S1 summary', updatedAt: 200 } },
      }),
      s2: createSessionFixture({
        id: 's2',
        serverId: homeA,
        thinking: false,
        active: true,
        updatedAt: 100,
        presence: 0,
        agentState: {
          requests: {
            req_c: { tool: 'Bash', kind: 'permission', arguments: {} },
          },
        },
        metadata: { path: '/tmp/s2', machineId: 'm1', host: 'a-host', summary: { text: 'S2 summary', updatedAt: 100 } },
      }),
      sys_voice: createSessionFixture({
        id: 'sys_voice',
        serverId: homeA,
        thinking: false,
        active: false,
        updatedAt: 300,
        presence: 0,
        agentState: { requests: {} },
        metadata: { path: '/tmp/sys', machineId: 'm1', host: 'a-host', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
      }),
      s_matrix: createSessionFixture({
        id: 's_matrix',
        serverId: homeA,
        thinking: false,
        active: false,
        updatedAt: 60,
        presence: 0,
        agentState: { requests: {} },
        metadata: { path: '/tmp/matrix', machineId: 'm1', host: 'a-host', name: 'leeroy' },
      }),
    },
    sessionListIndexByServerId: {
      [homeA]: [
        { type: 'session', sessionId: 's1', serverId: homeA, serverName: 'Server A' },
        { type: 'session', sessionId: 's2', serverId: homeA, serverName: 'Server A' },
        { type: 'session', sessionId: 's_visible_only', serverId: homeA, serverName: 'Server A' },
        { type: 'session', sessionId: 's_matrix', serverId: homeA, serverName: 'Server A' },
      ],
      [homeB]: [
        { type: 'session', sessionId: 's_other', serverId: homeB, serverName: 'Server B' },
      ],
    },
    sessionListRowsByServerId: {
      [homeA]: {
        s_visible_only: createSessionListRenderableSessionFixture({
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
        }),
        s_matrix: createSessionListRenderableSessionFixture({
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
          presence: 0,
          metadata: { summaryText: 'Session QA Voice Matrix', path: '/tmp/matrix' },
        }),
      },
      [homeB]: {
        s_other: createSessionListRenderableSessionFixture({
          id: 's_other',
          active: false,
          updatedAt: 50,
          presence: 0,
          metadata: { path: '/tmp/other', host: 'b-host', summaryText: 'Other summary' },
        }),
      },
    },
    ordinarySessionListMembershipByServerId: {
      [homeA]: ['s_visible_only', 's_matrix'],
      [homeB]: ['s_other'],
    },
    concurrentSessionListCacheByServerId: {
      [homeB]: {
        serverName: 'Server B',
      },
    },
    machines: {
      m1: createMachineFixture({ id: 'm1', activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, host: 'a-host' } }),
      m2: createMachineFixture({ id: 'm2', activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, host: 'b-host' } }),
    },
    machineListByServerId: {
      [homeA]: [createMachineFixture({ id: 'm1', activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, host: 'a-host' } })],
    },
    machineListStatusByServerId: { [homeA]: 'idle', [homeB]: 'idle' },
    sessionMessages: {
      s1: messagesFixture([
          { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, text: 'u1' },
          { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'a2' },
      ]),
      s2: messagesFixture([
          { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, text: 's2 latest' },
          createToolCallMessageFixture({
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
          }),
      ]),
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
  const runtime = createElevenLabsVoiceProviderRuntime({
    loadConversationSdk: () => import('@elevenlabs/client'),
  });
  const lifetime = new AbortController();
  // Observe an accidental provider-direct bypass without substituting the
  // Action owner: even this forbidden branch delegates to the real handler.
  const directEffect = vi.fn(createVoiceToolHandlers({ resolveSessionId: () => 's1',
    currentSessionAddress: { serverId: homeA, sessionId: 's1' } }).sendSessionMessage);
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
      actionControl: async () => unavailableUi(),
      readEntityDragItem: async () => unavailableUi(),
      updateEntityDragDrop: async () => unavailableUi(),
      watchEntityDragDrop: async () => unavailableUi(),
      publishCurrentUiContext: unavailableUi,
      activeComposer: async () => unavailableUi(), readComposer: async () => unavailableUi(),
      readDiscussionComposer: async () => unavailableUi(),
      watchComposer: async () => unavailableUi(), applyComposer: async () => unavailableUi(),
      focusComposer: async () => unavailableUi(), setComposerDecorations: async () => unavailableUi(),
      acquireComposerInputLock: async () => unavailableUi(), pickComposerMedia: async () => unavailableUi(),
      inspectComposerContent: async () => unavailableUi(), releaseComposerContent: async () => unavailableUi(),
      readSession: async () => unavailableUi(), watchSession: async () => unavailableUi(),
      respondToSessionPermission: async () => unavailableUi(), executeAction: async () => unavailableUi(),
      admitAction: async () => unavailableUi(),
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
    conversationSessionAddress: { serverId: homeA, sessionId: 's1' },
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
        retry: async () => {},
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
        retry: async () => {},
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

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

function installVoiceSocketBoundary() { installDisconnectedServerSocketBoundary((socket, serverUrl) => {
  configureConnectedServerSocketBoundary(socket);
  socket.emitWithAck = vi.fn(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!serverUrl) throw new Error(`Unexpected Voice daemon event: ${event}`);
    // Socket.IO's SDK is untyped here; this is the real shared RPC producer's envelope.
    const request = payload as SocketRpcRequestPayload;
    const separator = request.method.indexOf(':');
    const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.params, request.method);
    const response = await daemonRpc({ serverUrl,
      sessionId: request.method.slice(0, separator), method: request.method.slice(separator + 1), payload: decoded.params,
    });
    return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, response, decoded.callId) };
  });
}); }
installVoiceSocketBoundary();
const authFixture = {
  isAuthenticated: true,
  credentials: { token: 'e30.eyJzdWIiOiJ2b2ljZS10b29scy1hY2NvdW50In0.signature' },
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

await prepareStandaloneVoicePolicyHarness();
await loadSyncSingletonForTests();

describe('voice tool handlers', () => {
  it('routes real ElevenLabs duplicate and concurrent calls through canonical Action custody', async () => {
    const harness = await createElevenLabsToolHarness();
    const first = harness.deliver('provider-a', 'first');
    const duplicate = harness.deliver('provider-a', 'first');
    const sibling = harness.deliver('provider-b', 'second');
    await Promise.all([first, duplicate, sibling]);
    expect(pendingEnqueue).toHaveBeenCalledTimes(2);
    expect(harness.directEffect).not.toHaveBeenCalled();
    expect(harness.sent.filter((event) => event.type === 'client_tool_result').map((event) => event.tool_call_id))
      .toEqual(expect.arrayContaining(['provider-a', 'provider-a', 'provider-b']));
    expect(harness.sent.filter((event) => event.type === 'client_tool_result')).toHaveLength(3);
    await harness.deliver('provider-a', 'first');
    expect(pendingEnqueue).toHaveBeenCalledTimes(2);
    expect(harness.sent.filter((event) => event.tool_call_id === 'provider-a')).toHaveLength(3);
    expect(harness.failures).toEqual([]);
    await harness.deliver(undefined, 'missing identity');
    expect(pendingEnqueue).toHaveBeenCalledTimes(2);
    expect(harness.sent.at(-1)).toMatchObject({ is_error: true });
    expect(harness.connection.state()).toBe('open');
  });

  it('keeps real ElevenLabs identified calls behind canonical Action approval', async () => {
    state.settings.actionsSettingsV1 = {
      v: 1, actions: { 'session.message.send': { approvalRequiredSurfaces: ['voice'] } },
    };
    const harness = await createElevenLabsToolHarness();
    const delivery = harness.deliver('provider-approval', 'requires approval');
    await delivery;
    expect(artifactCreateRequests).toHaveBeenCalledTimes(1);
    expect(pendingEnqueue).not.toHaveBeenCalled();
    expect(harness.directEffect).not.toHaveBeenCalled();
    const result = harness.sent.find((event) => event.tool_call_id === 'provider-approval');
    expect(JSON.parse(String(result?.result))).toMatchObject({
      ok: true, kind: 'approval_request_created', actionId: 'session.message.send',
    });
  });

  it('rejects real ElevenLabs conflicting duplicates without assigning the first result to the conflicting callback', async () => {
    const enqueueStarted = createDeferred<void>();
    let release!: (value: Response) => void;
    let requestInit!: RequestInit;
    pendingEnqueue.mockImplementationOnce(async request => {
      requestInit = request.init;
      return await new Promise<Response>((resolve) => { release = resolve; enqueueStarted.resolve(); });
    });
    const harness = await createElevenLabsToolHarness();
    const first = harness.deliver('provider-conflict', 'first');
    await enqueueStarted.promise;
    expect(pendingEnqueue).toHaveBeenCalledTimes(1);
    const conflict = harness.deliver('provider-conflict', 'different effect');
    await Promise.all([first, conflict]);
    expect(harness.failures).toEqual([expect.objectContaining({ code: 'response_conflict' })]);
    expect(harness.connection.state()).toBe('closed');
    expect(harness.sent.filter((event) => event.type === 'client_tool_result'))
      .toEqual([expect.objectContaining({ is_error: true }), expect.objectContaining({ is_error: true })]);
    expect(pendingEnqueue).toHaveBeenCalledTimes(1);
    expect(harness.directEffect).not.toHaveBeenCalled();
    release(currentPendingEnqueueAck(requestInit));
  });

  it('settles real ElevenLabs cancelled callbacks and cannot deliver late results or replay them on a new connection', async () => {
    const enqueueStarted = createDeferred<void>();
    let release!: (value: Response) => void;
    let requestInit!: RequestInit;
    pendingEnqueue.mockImplementationOnce(async request => {
      requestInit = request.init;
      return await new Promise<Response>((resolve) => { release = resolve; enqueueStarted.resolve(); });
    });
    const harness = await createElevenLabsToolHarness();
    const delivery = harness.deliver('provider-cancelled', 'pending message');
    await enqueueStarted.promise;
    expect(pendingEnqueue).toHaveBeenCalledTimes(1);
    await harness.close();
    await delivery;
    const resultsAtClose = harness.sent.length;
    release(currentPendingEnqueueAck(requestInit));
    await Promise.resolve(); await Promise.resolve();
    expect(harness.sent).toHaveLength(resultsAtClose);
    await harness.deliver('late-start-call', 'must not execute');
    expect(pendingEnqueue).toHaveBeenCalledTimes(1);
    const replacement = await createElevenLabsToolHarness();
    expect(replacement.sent).toEqual([]);
    expect(replacement.connection.state()).toBe('open');
  });
  beforeEach(async () => {
    installVoiceSocketBoundary();
    previousAuth = getCurrentAuth();
    resetServerFeaturesClientForTests();
    account = await createVoiceSettingsAccountTestHarness(settingsParse(createBaseState().settings), {
      token: createAccountTokenForTests('account-a', { currentAccount: true }), serverIdentityId: 'srv_voice_tools_a',
      features: createRootLayoutFeaturesResponse({
      capabilities: { serverIdentity: { serverIdentityId: 'srv_voice_tools_a' },
        session: { ...DEFAULT_SESSION_CAPABILITIES, pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } } },
    }) });
    homeA = account.scope.serverId;
    const primary = getServerProfileById(homeA);
    if (!primary) throw new Error('Voice tool Account Home is missing');
    homeUrlA = primary.serverUrl;
    await adoptHomeProfile({ descriptor: { serverUrl: homeUrlA, homeServerIdentityId: 'srv_voice_tools_a', displayName: 'Server A' }, source: 'manual' });
    homeA = getActiveServerSnapshot().serverId;
    const other = await adoptHomeProfile({ descriptor: { serverUrl: 'https://server-b.test', homeServerIdentityId: 'srv_voice_tools_b', displayName: 'Server B' }, source: 'manual' });
    homeB = other.serverIdentityId ?? other.id;
    const otherCredentials = await TokenStorage.setCredentialsForServerUrlWithRollback(
      other.serverUrl, { serverId: other.id }, account.credentials);
    if (!otherCredentials) throw new Error('Second Voice tool Home credentials could not be stored');
    restoreCredentials = () => otherCredentials.rollback();
    setCurrentAuth({ ...authFixture, credentials: account.credentials });
    state = createBaseState();
    storage.setState({ ...state, settings: account.settings });
    state = storage.getState();
    resetSessionListPaneRetentionForTests();
    pendingEnqueue.mockReset();
    pendingEnqueue.mockImplementation(async request => currentPendingEnqueueAck(request.init,
      request.runId ? { recipient: { kind: 'execution_run', runId: request.runId } } : {}));
    daemonRpc.mockReset();
    daemonRpc.mockImplementation(async request => { throw new Error(`Unexpected Voice daemon RPC: ${request.method}`); });
    routerNavigate.mockReset();
    refreshFromActiveServer.mockReset();
    artifactCreateRequests.mockReset();
    sessionDetailReplies.clear();
    sessionDetailReads.length = 0;
    messagePages.clear();
    messageReads.length = 0;
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
    const existingHttp = account.request.getMockImplementation();
    if (!existingHttp) throw new Error('Account HTTP boundary is missing');
    accountHttp = existingHttp;
    const reviewInventoryBoundaries = await Promise.all([
      { serverUrl: homeUrlA, serverIdentityId: 'srv_voice_tools_a' },
      { serverUrl: other.serverUrl, serverIdentityId: 'srv_voice_tools_b' },
    ].map(target => createExternalActionAccountHttpBoundary({ ...target, accountId: 'account-a',
      machineId: 'm1', actionId: 'review.engines.list', tokenEpoch: 0, requesterInvocation: 'none',
      execute: () => ({ items: [{ engineId: 'claude', value: 'claude', label: 'Claude', backendId: 'claude',
        enabled: true, capabilities: { structuredNarration: true } }] }),
    })));
    account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      if (pathname === '/health' || pathname === '/v1/auth/ping') return Response.json({});
      for (const boundary of reviewInventoryBoundaries) {
        const reply = await boundary.handle(url, init);
        if (reply) return reply;
      }
      if (pathname === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
        snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0,
          pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
      }));
      if (pathname === '/v2/sessions' || pathname === '/v2/sessions/active') {
        const serverId = url.origin === homeUrlA ? homeA : homeB;
        // The HTTP census reflects the authored Home fixture, not rows the
        // client replaces while hydrating an earlier page of that census.
        const currentState = state;
        const entries = serverId === homeA && Array.isArray(currentState.sessionListViewData)
          ? currentState.sessionListViewData.map((entry: { type: string; session?: { id: string } }) => ({
            type: entry.type, sessionId: entry.session?.id,
          })) : currentState.sessionListIndexByServerId[serverId] ?? [];
        const records = entries.flatMap((entry: { type: string; sessionId?: string }) => {
          if (entry.type !== 'session' || !entry.sessionId) return [];
          const fixture = currentState.sessionListRowsByServerId[serverId]?.[entry.sessionId]
            ?? (serverId === homeA ? currentState.sessions[entry.sessionId] : undefined);
          if (!fixture) return [];
          const { summaryText, ...ownerMetadata } = fixture.metadata ?? {};
          const metadata = summaryText
            ? { ...createSessionFixture().metadata, ...ownerMetadata, summary: { text: summaryText, updatedAt: fixture.updatedAt } }
            : { ...createSessionFixture().metadata, ...ownerMetadata };
          return [createPlainSessionCurrentProjectionRecordFixture({
            id: entry.sessionId, seq: fixture.seq, createdAt: fixture.createdAt, updatedAt: fixture.updatedAt,
            active: fixture.active, activeAt: fixture.presence === 'online' ? Date.now() : fixture.activeAt, metadata,
          })];
        }).sort((left: { updatedAt: number }, right: { updatedAt: number }) => right.updatedAt - left.updatedAt);
        const offset = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? records.length);
        const nextOffset = offset + limit;
        return Response.json(V2SessionListResponseSchema.parse({ sessions: records.slice(offset, nextOffset),
          hasNext: nextOffset < records.length, nextCursor: nextOffset < records.length ? String(nextOffset) : null }));
      }
      const pending = /^\/v2\/sessions\/([^/]+)(?:\/execution-runs\/([^/]+))?\/pending$/.exec(pathname);
      if (pending) {
        if (init?.method === 'POST') return pendingEnqueue({ serverUrl: new URL(String(input)).origin,
          sessionId: decodeURIComponent(pending[1]), runId: pending[2] ? decodeURIComponent(pending[2]) : null, init });
        return Response.json({ pending: [], discarded: [] });
      }
      const turns = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(pathname);
      if (turns) {
        const id = decodeURIComponent(turns[1]!);
        const session = state.sessions[id];
        return session ? Response.json(SessionTurnsProjectionV1Schema.parse(session.sessionTurns ?? {
          v: 1, sessionId: id, updatedAt: session.updatedAt, turns: [],
        })) : Response.json({ error: 'not_found' }, { status: 404 });
      }
      const messages = /^\/v[12]\/sessions\/([^/]+)\/messages$/.exec(pathname);
      if (messages && (init?.method ?? 'GET') === 'GET') {
        const id = decodeURIComponent(messages[1]);
        messageReads.push(id);
        return Response.json(messagePages.get(id) ?? SessionMessagesPageV1Schema.parse({ messages: [], hasMore: false }));
      }
      const session = /^\/v2\/sessions\/([^/]+)$/.exec(pathname);
      if (session) {
        const id = decodeURIComponent(session[1]);
        sessionDetailReads.push(id);
        const fixture = sessionDetailReplies.get(id) ?? state.sessions[id] ?? createSessionFixture({ id, serverId: homeA });
        return Response.json({ session: SessionCurrentProjectionRecordV1Schema.parse({
          ...fixture, metadataLayoutVersion: 0, metadata: JSON.stringify(fixture.metadata),
          agentState: fixture.agentState === null ? null : JSON.stringify(fixture.agentState),
          effectiveAccess: { v: 1, level: fixture.access.level, sources: [{ kind: 'owner' }], capabilities: fixture.access.capabilities },
          responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
          dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
        }) });
      }
      if (pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
        id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
      const machine = /^\/v1\/machines\/([^/]+)$/.exec(pathname);
      if (machine) return Response.json({ machine: createPlainMachineRowFixture({
        id: decodeURIComponent(machine[1]), accountId: 'account-a',
      }) });
      if (pathname === ACP_CATALOG_ROWS_ROUTE_V1) {
        return Response.json({ status: 'present', revision: 1,
          content: { t: 'plain', v: { v: 1, definitions: [] } } });
      }
      const machineAccess = /^\/v1\/machines\/([^/]+)\/access$/.exec(pathname);
      if (machineAccess) {
        const custodian = { accountId: 'account-a', displayName: 'Voice Tools Account' };
        return Response.json(MachineAccessGrantsListResponseV1Schema.parse({
          machineId: decodeURIComponent(machineAccess[1]), custodian,
          access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
          canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
        }));
      }
      if (pathname === '/v1/artifacts' && init?.method === 'POST') artifactCreateRequests(JSON.parse(String(init.body)));
      if (pathname === '/v2/account/session-follow-voice-inclusions' && init?.method === 'PUT') {
        const request = JSON.parse(String(init.body)) as { sessionIds: string[] };
        return Response.json({ changed: true, sessionIds: request.sessionIds });
      }
      return accountHttp(input, init);
    }));
    setRuntimeFetch(account.request);
    // Complete the Account bootstrap before publishing test-owned current rows.
    // Otherwise its legitimate HTTP census can replace them during an assertion.
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    storage.setState({ ...createBaseState(), settings: account.settings });
    state = storage.getState();
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    expect(captureActiveServerAccountScopeLifetime()?.scope, JSON.stringify({ selected: getActiveServerSnapshot(),
      applied: getAppliedActiveServerSnapshot(), available: isAppliedActiveServerRuntimeAvailable(),
      profile: storage.getState().profileScope })).toEqual({ serverId: homeA, accountId: 'account-a' });
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const features = await getServerFeaturesSnapshot({ serverId: homeA, force: true });
    expect(features, JSON.stringify(features)).toMatchObject({ status: 'ready', features: { capabilities: {
      session: { pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } },
    } } });
    // Assertions below observe the invoked tool, not the Account's joined bootstrap reads.
    daemonRpc.mockClear();
    sessionDetailReads.length = 0;
    messageReads.length = 0;
  });

  afterEach(async () => {
    await standardCleanup();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await restoreCredentials?.();
    restoreCredentials = undefined;
    await account?.dispose();
    const otherProfile = getServerProfileById(homeB);
    if (otherProfile) await removeServerProfile(otherProfile.id);
    const primaryProfile = getServerProfileById(homeA);
    if (primaryProfile) await removeServerProfile(primaryProfile.id);
    setCurrentAuth(previousAuth);
    resetRuntimeFetch();
  });

  it('routes sendSessionMessage through canonical Voice Message admission for the resolved session', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.sendSessionMessage({ message: 'hi' });

    expect(JSON.parse(result), result).toMatchObject({ ok: true, status: 'accepted' });
    expectVoicePendingInput('s1', 'hi');

  });

  it('preserves an execution-run recipient through canonical Voice Message admission', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentSessionAddress: { serverId: homeA, sessionId: 's1' },
    });

    const result = await tools.sendSessionMessage({
      message: 'Continue this run',
      recipient: { kind: 'execution_run', runId: 'run-1' },
    });

    expect(JSON.parse(result), result).toMatchObject({ ok: true });
    expectVoicePendingInput('s1', 'Continue this run', 'run-1');
  });

  it('does not admit a Voice session message after its invocation was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await (tools.sendSessionMessage as any)({ message: 'hi' }, { signal: controller.signal });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'tool_cancelled' });
    expect(pendingEnqueue).not.toHaveBeenCalled();
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
      currentSessionAddress: { serverId: homeA, sessionId: 's1' },
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
    expect(pendingEnqueue).not.toHaveBeenCalled();
  });

  it.each(['named', 'discovered'] as const)('freezes the bound Voice Session as the later-return destination in the existing approval (%s)', async route => {
    const { actionSpecToActionDefinitionV1 } = await import('@happier-dev/protocol/actions/actionCatalog');
    const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
    const invocations: unknown[] = [];
    const boundaries = await Promise.all((['action.spec.get', 'session.message.send'] as const).map(actionId =>
      createExternalActionAccountHttpBoundary({ serverUrl: homeUrlA, serverIdentityId: 'srv_voice_tools_a',
        accountId: 'account-a', machineId: 'm1', tokenEpoch: 0, actionId,
        execute: (input, context) => {
          if (actionId === 'action.spec.get') return { actionSpec: actionSpecToActionDefinitionV1(getActionSpec('session.message.send'), {
            surface: 'voice', includeOutputSchema: true,
          }) };
          invocations.push({ input, invocation: context.invocation });
          return { status: 'accepted', localId: 'voice-later-return' };
        },
      })));
    const previousHttp = account.request.getMockImplementation();
    if (!previousHttp) throw new Error('Voice Account HTTP boundary missing');
    account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (url, init) => {
      for (const boundary of boundaries) {
        const response = await boundary.handle(new URL(String(url)), init);
        if (!response) continue;
        if (new URL(String(url)).pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
          id => id === boundary.machine.id ? { ...boundary.machine,
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: { sessionMessageReply: { protocolVersions: [1] } },
          } : null);
        if (new URL(String(url)).pathname !== '/v1/machines') return response;
        const rows = await response.json();
        return Response.json(rows.map((row: ReturnType<typeof createPlainMachineRowFixture>) => ({ ...row,
          operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: { sessionMessageReply: { protocolVersions: [1] } },
        })));
      }
      return previousHttp(url, init);
    }));
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 'another-visible-session',
      currentSessionAddress: { serverId: homeA, sessionId: 's1' } });
    const callerContext = { effectId: 'voice-return-approval', authority: 'present_user', bypassApprovals: true };
    const input = { sessionId: 's2', message: 'Return the result here.', reply: 'return', localId: 'voice-later-return' };
    const wireResult = JSON.parse(await (route === 'named' ? tools.sendSessionMessage(input, callerContext)
      : tools.action_execute({ actionId: 'session.message.send', input }, callerContext)));
    // Generic execution retains the canonical Action result envelope.
    const result = route === 'named' ? wireResult : { ok: wireResult.ok, ...wireResult.result };
    expect(result).toMatchObject({ ok: true, kind: 'approval_request_created', actionId: 'session.message.send' });
    const request = ApprovalRequestSchema.parse(JSON.parse(account.artifacts.readPlainBody(result.artifactId) ?? 'null'));
    expect(request).toMatchObject({ actionArgs: { sessionId: 's2', reply: 'return', returnToSessionId: 's1',
      localId: 'voice-later-return' }, executionOriginV1: { authority: 'account_automation', surface: 'voice' } });
    expect(pendingEnqueue).not.toHaveBeenCalled();
    expect(invocations).toEqual([]);
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    state.settings.voice.canApproveRequests = false;
    expect(await createDefaultActionExecutor().execute('approval.request.decide', {
      artifactId: result.artifactId, decision: 'approve',
    }, { surface: 'voice', serverId: homeA, authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(invocations).toEqual([]);
    const decision = await createDefaultActionExecutor().execute('approval.request.decide', {
      artifactId: result.artifactId, decision: 'approve',
    }, { surface: 'ui', serverId: homeA, defaultSessionId: 'different-visible-session' });
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(invocations).toEqual([{ input: expect.objectContaining({ sessionId: 's2', reply: 'return', returnToSessionId: 's1',
      localId: 'voice-later-return' }), invocation: expect.objectContaining({ authority: 'present_user', surface: 'voice',
        caller: { kind: 'host' } }) }]);
    expect(pendingEnqueue).not.toHaveBeenCalled();
  });

  it.each(['unbound', 'different-home', 'cancelled'] as const)('refuses a %s Voice later-return without input or approval effects', async (scenario) => {
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1',
      ...(scenario === 'unbound' ? {} : { currentSessionAddress: { serverId: homeA, sessionId: 's1' } }) });
    const controller = new AbortController();
    if (scenario === 'cancelled') controller.abort();
    const result = JSON.parse(await tools.sendSessionMessage({ sessionId: 's2', message: 'Return here.', reply: 'return' }, {
      effectId: `voice-return-${scenario}`, signal: controller.signal,
      ...(scenario === 'different-home' ? { serverId: homeB } : {}),
    }));
    expect(result).toMatchObject({ ok: false, errorCode: scenario === 'unbound' ? 'session_not_selected'
      : scenario === 'different-home' ? 'server_target_mismatch' : 'tool_cancelled' });
    expect(account.artifacts.list()).toEqual([]);
    expect(pendingEnqueue).not.toHaveBeenCalled();
  });

  it('refuses a caller-authored Voice return destination instead of treating it as a bound source', async () => {
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1',
      currentSessionAddress: { serverId: homeA, sessionId: 's1' } });
    const result = JSON.parse(await tools.sendSessionMessage({ sessionId: 's2', message: 'Return it elsewhere.',
      reply: 'return', returnToSessionId: 'unrelated-session' }, { effectId: 'voice-forged-return' }));
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(account.artifacts.list()).toEqual([]);
    expect(pendingEnqueue).not.toHaveBeenCalled();
  });

  it('reports a target update requirement from canonical Voice admission without retaining an unknown outcome', async () => {
    pendingEnqueue.mockResolvedValueOnce(Response.json({ code: 'session_input_target_update_required' }, { status: 409 }));
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await tools.sendSessionMessage({ message: 'hi' });

    expect(JSON.parse(result)).toEqual({
      ok: false,
      errorCode: 'session_input_target_update_required',
      errorMessage: 'session_input_target_update_required',
      actionId: 'session.message.send',
    });
  });

  it('starts review through the catalog Voice binding, executor and Session RPC', async () => {
    const { ExecutionRunStartResponseSchema } = await import('@happier-dev/protocol/execution/runs/responseSchemas');
    daemonRpc.mockImplementation(async request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
      ? { error: 'RPC_METHOD_NOT_FOUND' }
      : ExecutionRunStartResponseSchema.parse({ runId: 'run-review', callId: 'call-review', sidechainId: 'call-review' }));
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1'),
      currentSessionAddress: { serverId: homeA, sessionId: 's1' } });
    const inventory = JSON.parse(await tools.listReviewEngines({ sessionId: 's1' }, { serverId: homeA }));
    expect(inventory, JSON.stringify(inventory)).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ engineId: 'claude', enabled: true })]) });
    const result = JSON.parse(await tools.startReview({ engineIds: ['claude'], instructions: 'Review the current worktree.' }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sessionId: 's1', results: [
      { ok: true, result: { runId: 'run-review' } },
    ] });
    expect(daemonRpc.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
      serverUrl: homeUrlA, sessionId: 's1', method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
      payload: expect.objectContaining({ runId: null, resume: false,
        start: expect.objectContaining({ intent: 'review', instructions: 'Review the current worktree.' }) }),
    }));
  });

  it('reads the descriptor-only current UI snapshot through the attempt-scoped port', async () => {
    const current = await mountCurrentUiContext();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: current.port,
    });

    const snapshot = JSON.parse(await tools.readCurrentUiContext({}));
    expect(snapshot).toEqual(current.reader.readCurrentUiContext());
    expect(snapshot).toMatchObject({ entity: { label: 'PLUGIN_LABEL_SENTINEL' }, commands: [
      { id: expect.any(String), title: 'Open issue #124' },
    ] });
    expect(JSON.stringify(snapshot)).not.toContain('must-remain-local');
    expect(JSON.stringify(snapshot)).not.toContain('acme/widgets');
  });

  it('does not expose current UI read or command tools when UI context sharing is off', async () => {
    const current = await mountCurrentUiContext();
    account.replaceVoice({ ...storage.getState().settings.voice,
      privacy: { ...storage.getState().settings.voice.privacy, currentUiContextMode: 'off' } });
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: current.port,
    });

    expect(tools.readCurrentUiContext).toBeUndefined();
    expect(tools.invokeCurrentUiCommand).toBeUndefined();
  });

  it('withholds current-UI Action specs from generic Voice discovery when sharing is off', async () => {
    const current = await mountCurrentUiContext();
    account.replaceVoice({ ...storage.getState().settings.voice,
      privacy: { ...storage.getState().settings.voice.privacy, currentUiContextMode: 'off' } });
    const { getActionSpec } = await import('@happier-dev/protocol');
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: current.port,
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
    const current = await mountCurrentUiContext();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: current.port,
    });
    const read = tools.readCurrentUiContext;
    const invoke = tools.invokeCurrentUiCommand;
    if (!read || !invoke) throw new Error('Expected current-UI handlers while sharing is enabled');

    account.replaceVoice({ ...storage.getState().settings.voice,
      privacy: { ...storage.getState().settings.voice.privacy, currentUiContextMode: 'off' } });

    await expect(read({})).resolves.toBe(JSON.stringify({
      ok: false,
      errorCode: 'current_ui_context_unavailable',
      errorMessage: 'current_ui_context_unavailable',
    }));
    await expect(invoke({ commandId: current.commandId })).resolves.toBe(JSON.stringify({
      ok: false,
      errorCode: 'current_ui_command_unavailable',
      errorMessage: 'current_ui_command_unavailable',
    }));
    expect(daemonRpc.mock.calls.map(([request]) => request.method)).not.toContain(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
  });

  it.each([
    ['invalid string', 'always'],
    ['invalid non-string', true],
  ])('does not expose current UI tools when the persisted mode is an %s', async (_caseName, currentUiContextMode) => {
    const current = await mountCurrentUiContext();
    // Deliberately corrupt persisted input: the real owner must fail closed.
    state = storage.getState();
    state.settings.voice.privacy.currentUiContextMode = currentUiContextMode;
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: current.port,
    });

    expect(tools.readCurrentUiContext).toBeUndefined();
    expect(tools.invokeCurrentUiCommand).toBeUndefined();
  });

  it('delegates current UI commands without exposing their private semantic payload', async () => {
    const current = await mountCurrentUiContext();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: current.port,
    });

    const result = await tools.invokeCurrentUiCommand({ commandId: current.commandId });

    expect(JSON.parse(result), result).toEqual({ ok: true, result: { opened: true } });
    expect(daemonRpc.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
      serverUrl: homeUrlA, sessionId: 'm1', method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
      payload: expect.objectContaining({ qualifiedActionId: 'acme.triage/refresh-issues', input: {
        repository: 'acme/widgets', privateQuery: 'must-remain-local',
      } }),
    }));
    expect(result).not.toContain(current.commandId);
    expect(result).not.toContain('must-remain-local');
  });

  it('delegates contributed Actions by identity through the same current UI port', async () => {
    const current = await mountCurrentUiContext({ refreshed: true });
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: current.port,
    });

    const result = await tools.invokeAction({
      action: { pluginId: 'acme.triage', localId: 'refresh-issues' },
      input: { repository: 'acme/widgets' },
    });

    expect(daemonRpc.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
      serverUrl: homeUrlA, sessionId: 'm1', method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
      payload: expect.objectContaining({ qualifiedActionId: 'acme.triage/refresh-issues', input: { repository: 'acme/widgets' } }),
    }));
    expect(JSON.parse(result), result).toEqual({ ok: true, result: { refreshed: true } });
    expect(result).not.toContain('acme/widgets');
  });

  it('denies the captured contributed Action tool when the user disables action.invoke mid-attempt', async () => {
    const current = await mountCurrentUiContext({ refreshed: true });
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: current.port,
    });
    const invoke = tools.invokeAction;
    if (!invoke) throw new Error('Expected the contributed Action tool while the Action is enabled');

    storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1,
      actions: { 'action.invoke': { enabled: false } },
    }) });

    await expect(invoke({
      action: { pluginId: 'acme.triage', localId: 'refresh-issues' },
    })).resolves.toBe(JSON.stringify({
      ok: false,
      errorCode: 'action_unavailable',
      errorMessage: 'action_unavailable',
    }));
    expect(daemonRpc.mock.calls.map(([request]) => request.method)).not.toContain(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
  });

  it('does not expose the contributed Action tool when action.invoke is already disabled', async () => {
    const current = await mountCurrentUiContext();
    storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1,
      actions: { 'action.invoke': { disabledSurfaces: ['voice'] } },
    }) });
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({
      resolveSessionId: () => 's1',
      currentUiContext: current.port,
    });

    expect(tools.invokeAction).toBeUndefined();
  });

  it('denies a captured read-only tool when the Voice feature is disabled mid-attempt', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });
    const listSessions = tools.listSessions;
    if (!listSessions) throw new Error('Expected the session list tool while Voice is enabled');

    account.replaceSettings(settingsParse({ ...storage.getState().settings,
      featureToggles: { ...storage.getState().settings.featureToggles, voice: false },
    }));

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
    const { ExecutionRunStartResponseSchema } = await import('@happier-dev/protocol/execution/runs/responseSchemas');
    daemonRpc.mockResolvedValue(ExecutionRunStartResponseSchema.parse({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await tools.startExecutionRun(startArgs);

    expect(JSON.parse(result), result).toMatchObject({ ok: true, runId: 'run_1' });
    expect(daemonRpc).toHaveBeenCalledWith({ serverUrl: homeUrlA, sessionId: 's1',
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
      payload: { runId: null, resume: false, start: expect.objectContaining(startArgs) },
    });
  });

  it('can apply an execution run action via sessionExecutionRunAction', async () => {
    daemonRpc.mockResolvedValue({ ok: true, updatedToolResult: { ok: true } });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.actionExecutionRun({ runId: 'run_1', actionId: 'review.triage', input: { findings: [] } });
    expect(JSON.parse(res), res).toMatchObject({ ok: true });
    expect(daemonRpc).toHaveBeenCalledWith({ serverUrl: homeUrlA, sessionId: 's1',
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
      payload: expect.objectContaining({ runId: 'run_1', actionId: 'review.triage' }),
    });
    expect(JSON.parse(res)).toMatchObject({ ok: true });
  });

  it('can list execution runs via sessionExecutionRunList', async () => {
    const { ExecutionRunListResponseSchema } = await import('@happier-dev/protocol/execution/runs/responseSchemas');
    daemonRpc.mockResolvedValue(ExecutionRunListResponseSchema.parse({ runs: [] }));

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listExecutionRuns({});
    expect(JSON.parse(res), res).toMatchObject({ runs: [] });
    expect(daemonRpc).toHaveBeenCalledWith({ serverUrl: homeUrlA, sessionId: 's1',
      method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, payload: {},
    });
    expect(JSON.parse(res)).toMatchObject({ runs: [] });
  });

  it('can get an execution run via sessionExecutionRunGet', async () => {
    const { ExecutionRunGetResponseSchema } = await import('@happier-dev/protocol/execution/runs/responseSchemas');
    daemonRpc.mockResolvedValue(ExecutionRunGetResponseSchema.parse({
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
    }));

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.getExecutionRun({ runId: 'run_1' });
    expect(JSON.parse(res), res).toMatchObject({ run: { runId: 'run_1' } });
    expect(daemonRpc).toHaveBeenCalledWith({ serverUrl: homeUrlA, sessionId: 's1',
      method: SESSION_RPC_METHODS.EXECUTION_RUN_GET, payload: { runId: 'run_1', includeStructured: false },
    });
    expect(JSON.parse(res)).toMatchObject({ run: { runId: 'run_1', availableActionIds: ['voice_agent.welcome'] } });
  });

  it('does not expose a detached run send on the Session Voice surface', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });
    expect(tools).not.toHaveProperty('sendExecutionRunMessage');
  });

  it('can stop an execution run via sessionExecutionRunStop', async () => {
    daemonRpc.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.stopExecutionRun({ runId: 'run_1' });
    expect(JSON.parse(res), res).toMatchObject({ ok: true });
    expect(daemonRpc).toHaveBeenCalledWith({ serverUrl: homeUrlA, sessionId: 's1',
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, payload: { runId: 'run_1' },
    });
    expect(JSON.parse(res)).toMatchObject({ ok: true });
  });

  it('routes strict V2 session creation through the canonical Voice Action executor', async () => {
    const { getAppliedActiveServerSnapshot, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const incumbentHome = getAppliedActiveServerSnapshot();
    // Restored runtime scopes carry the durable Home identity, not its device alias.
    publishAppliedActiveServerSnapshot({ ...incumbentHome, serverId: 'srv_voice_tools_a' });
    onTestFinished(() => publishAppliedActiveServerSnapshot(incumbentHome));
    const spawnInput = {
      creationKey: 'manual:voice-v2-contract',
      executionTarget: {
        serverId: homeA,
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
        serverId: homeA,
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
    daemonRpc.mockImplementation(async request => {
      if (request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
        return createExistingSessionDirectoryPreflightResult(request.payload);
      }
      if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) return spawnResult;
      throw new Error(`Unexpected Voice spawn daemon RPC: ${request.method}`);
    });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const { getActionSpec } = await import('@happier-dev/protocol');
    const parsedSpawnInput = getActionSpec('session.spawn_new').inputSchema.safeParse(spawnInput);
    expect(parsedSpawnInput.success, JSON.stringify(parsedSpawnInput)).toBe(true);
    const response = JSON.parse(await tools.spawnSession(spawnInput, {
      serverId: homeA,
      callId: 'voice-spawn-call',
      effectId: 'voice-spawn-effect',
    }));

    expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
    expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: homeUrlA,
      sessionId: 'm1',
      method: RPC_METHODS.SESSION_SPAWN_NEW,
      payload: spawnInput,
    }));
    expect(response).toEqual({ ok: true, ...spawnResult });
  });

  it('rejects retired flat spawnSession arguments before dispatching', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const response = JSON.parse(await tools.spawnSession({ tag: 't1' }));

    expect(response).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(daemonRpc).not.toHaveBeenCalled();
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
    storage.setState({ sessions: {
      ...storage.getState().sessions,
      s3: createSessionFixture({
        id: 's3',
        serverId: homeA,
        active: true,
        presence: 'online',
        updatedAt: 3000,
        metadata: { path: '/Users/leeroy/workspaces/apps/leeroy', machineId: 'm1', host: 'a-host', summary: { text: 'Apps session', updatedAt: 3000 } },
      }),
      s4: createSessionFixture({
        id: 's4',
        serverId: homeA,
        active: true,
        presence: 'online',
        updatedAt: 4000,
        metadata: { path: '/Users/leeroy/workspaces/docs/leeroy', machineId: 'm1', host: 'a-host', summary: { text: 'Docs session', updatedAt: 4000 } },
      }),
    } });

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
    storage.setState({ machines: {
      ...storage.getState().machines,
      m1_alias: createMachineFixture({ id: 'm1_alias', metadata: { ...createMachineFixture().metadata!, host: 'a-host' } }),
    }, sessions: {
      ...storage.getState().sessions,
      s5: createSessionFixture({
        id: 's5',
        serverId: homeA,
        active: true,
        presence: 'online',
        updatedAt: 5000,
        metadata: { path: '/Users/leeroy', machineId: 'm1_alias', host: 'a-host', summary: { text: 'Alias workspace session', updatedAt: 5000 } },
      }),
    } });

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
    expect(servers.items.map((s: any) => s.serverId)).toContain(homeA);
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
    const { getAppliedActiveServerSnapshot, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const incumbentHome = getAppliedActiveServerSnapshot();
    publishAppliedActiveServerSnapshot({ ...incumbentHome, serverId: 'srv_voice_tools_a' });
    onTestFinished(() => publishAppliedActiveServerSnapshot(incumbentHome));
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1',
      currentSessionAddress: { serverId: homeA, sessionId: 's1' },
    });

    const backendsRaw = await tools.listAgentBackends({});
    const backends = JSON.parse(backendsRaw);
    expect(backends, backendsRaw).toMatchObject({ ok: true });
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

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });

    const res = await tools.openSession({ sessionId: 's_other' }, { serverId: homeB });
    expect(JSON.parse(res)).toMatchObject({ ok: true, sessionId: 's_other' });
    expect(getActiveServerSnapshot().serverId).toBe(homeB);
    expect(routerNavigate).toHaveBeenCalledWith(`/session/s_other?serverId=${homeB}`, expect.any(Object));
  });

  it('resolves a unique natural Session title through the complete mounted Sessions corpus', async () => {
    retainVoiceSessionReferenceCorpus({
      addresses: [{ serverId: homeA, sessionId: 's_matrix' }],
      complete: true,
    });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Session QA Voice Matrix' }));

    expect(result).toMatchObject({ ok: true, sessionId: 's_matrix' });
    expect(routerNavigate).toHaveBeenCalledWith(`/session/s_matrix?serverId=${homeA}`, expect.any(Object));
  });

  it('keeps an exhausted feature-off ordinary corpus incomplete for strict My Work title resolution', async () => {
    retainOrdinaryVoiceSessionReferenceCorpus({ selectedServerIds: [homeA] });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Session QA Voice Matrix' }));

    expect(result).toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('keeps feature-off ordinary title resolution incomplete while its list corpus is not exhausted', async () => {
    retainOrdinaryVoiceSessionReferenceCorpus({ selectedServerIds: [homeA] });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Session QA Voice Matrix' }));

    expect(result).toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('does not treat an exhausted empty feature-off ordinary corpus as authoritative absence', async () => {
    state.ordinarySessionListMembershipByServerId[homeA] = [];
    retainOrdinaryVoiceSessionReferenceCorpus({ selectedServerIds: [homeA] });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Missing session' }));

    expect(result).toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });
  });

  it('uses the focused retained Sessions corpus when another data-active pane remains mounted', async () => {
    retainVoiceSessionReferenceCorpus({
      addresses: [{ serverId: homeB, sessionId: 's_other' }],
      complete: true,
      sourceScopeKey: 'background-pane',
      referenceCorpusActive: false,
    });
    retainVoiceSessionReferenceCorpus({
      addresses: [{ serverId: homeA, sessionId: 's_matrix' }],
      complete: true,
      sourceScopeKey: 'focused-pane',
      referenceCorpusActive: true,
    });

    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
    const result = JSON.parse(await tools.openSession({ sessionTitle: 'Session QA Voice Matrix' }));

    expect(result).toMatchObject({ ok: true, sessionId: 's_matrix' });
    expect(routerNavigate).toHaveBeenCalledWith(`/session/s_matrix?serverId=${homeA}`, expect.any(Object));
  });

  it('fails duplicate natural Session ids and titles as ambiguous through the mounted Sessions corpus', async () => {
    state.sessionListRowsByServerId[homeB].s_matrix = {
      ...state.sessionListRowsByServerId[homeA].s_matrix,
      metadata: { summaryText: 'Session QA Voice Matrix', path: '/tmp/other' },
    };
    state.ordinarySessionListMembershipByServerId[homeB] = ['s_matrix'];
    retainVoiceSessionReferenceCorpus({
      addresses: [
        { serverId: homeA, sessionId: 's_matrix' },
        { serverId: homeB, sessionId: 's_matrix' },
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
      addresses: [{ serverId: homeA, sessionId: 's_matrix' }],
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
      addresses: [{ serverId: homeA, sessionId: 's_matrix' }],
      complete: false,
    });
    const incompleteTools = createVoiceToolHandlers({ resolveSessionId: () => null });
    expect(JSON.parse(await incompleteTools.openSession({ sessionTitle: 'Session QA Voice Matrix' })))
      .toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });
    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it('starts review on the exact captured Home while another Home is active', async () => {
    const { ExecutionRunStartResponseSchema } = await import('@happier-dev/protocol/execution/runs/responseSchemas');
    const machineInventory = createReadyMachineAgentInventoryFixture([{ agentId: 'claude', title: 'Claude' }]);
    sessionDetailReplies.set('s_other', createSessionFixture({ id: 's_other', serverId: homeB, active: true,
      metadata: { ...createSessionFixture().metadata!, machineId: 'm1' },
    }));
    storage.getState().applyServerScopedSessionListRows(homeB, [createSessionListRenderableSessionFixture({
      ...state.sessionListRowsByServerId[homeB].s_other,
      metadata: { ...state.sessionListRowsByServerId[homeB].s_other.metadata, machineId: 'm1' },
    })], { source: 'ordinary', mode: 'replace' });
    daemonRpc.mockImplementation(async request => {
      if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return { protocolVersion: 1, projection: machineInventory.projection };
      }
      if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return machineInventory.capabilities;
      return ExecutionRunStartResponseSchema.parse({ runId: 'run-other-review', callId: 'call-other-review', sidechainId: 'call-other-review' });
    });
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : null) });
    const result = JSON.parse(await tools.startReview({ sessionId: 's_other', engineIds: ['claude'], instructions: 'Review the other Home.' }, { serverId: homeB }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sessionId: 's_other', results: [
      { ok: true, result: { runId: 'run-other-review' } },
    ] });
    expect(daemonRpc.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
      serverUrl: 'https://server-b.test', sessionId: 's_other', method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
      payload: expect.objectContaining({ runId: null, resume: false,
        start: expect.objectContaining({ intent: 'review', instructions: 'Review the other Home.' }) }),
    }));
    expect(getActiveServerSnapshot().serverId).toBe(homeA);
  });

  it.each([
    { hasHome: false, expected: { ok: false, errorCode: 'approval_origin_unavailable' } },
    { hasHome: true, expected: { ok: true, kind: 'approval_request_created', actionId: 'ui.voice_global.reset' } },
  ])('keeps global agent memory intact until Voice reset approval (Home: $hasHome)', async ({ hasHome, expected }) => {
    const serverId = hasHome ? homeA : undefined;
    const current = state.settings.voice.providers.local_conversation;
    state.settings.voice.providers.local_conversation = {
      ...current,
      config: {
        ...current.config,
        agent: {
          ...current.config.agent,
          transcript: { persistenceMode: 'persistent' },
        },
      },
    };
    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });

    const result = JSON.parse(await tools.resetGlobalVoiceAgent({}, {
      ...(serverId ? { serverId } : {}),
      effectId: 'effect-reset-approval',
    }));

    expect(result).toMatchObject(expected);
    const { readPersistentVoiceTranscriptEpoch } = await import('@/voice/persistence/voiceTranscriptMemory');
    expect(await readPersistentVoiceTranscriptEpoch()).toBe(0);
    if (serverId) {
      expect(result.artifactId).toEqual(expect.any(String));
      expect(artifactCreateRequests).toHaveBeenCalled();
    } else {
      expect(artifactCreateRequests).not.toHaveBeenCalled();
    }
  });

  it('advances transcript memory for an approved direct UI reset without writing preferences', async () => {
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
      surface: 'ui', serverId: homeA, authority: 'present_user',
      presentUserConfirmation: { actionId: 'ui.voice_global.reset' },
    });
    expect(result).toMatchObject({ ok: true });
    const { readPersistentVoiceTranscriptEpoch } = await import('@/voice/persistence/voiceTranscriptMemory');
    expect(await readPersistentVoiceTranscriptEpoch()).toBe(1);
    expect(account.writes).toHaveLength(0);
  });
  it('teleports the voice agent to the resolved session root', async () => {
    const { writeVoiceConversationScopeMetadata } = await import('@/voice/persistence/voiceConversationScopeMetadata');
    const machineRow = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' });
    const daemon = await createRetainedVoiceAgentRpcBoundary({ handleOtherRpc: async (method, input) => {
      if (method === RPC_METHODS.SPAWN_HAPPY_SESSION || method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
        const request = SessionResumeRequestV1Schema.parse(input);
        expect(request.sessionId).toBe('carrier-1');
        return { type: 'success', sessionId: request.sessionId };
      }
      throw new Error(`Unexpected Voice teleport RPC: ${method}`);
    } });
    daemonRpc.mockImplementation(request => daemon.dispatch(request.method, request.payload));
    const harness = await createStandaloneVoicePolicyHarness({ mode: 'off', dispatch: daemon.dispatch,
      handleRequest: async (path, init) => {
        const pathname = new URL(path, 'https://voice.test').pathname;
        if (pathname === '/v1/machines') return Response.json([machineRow]);
        if (pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
          id => id === machineRow.id ? machineRow : null);
        if (pathname === '/v1/machines/machine-1') return Response.json({ machine: machineRow });
        return null;
      },
      initializeSessionId: 'carrier-1',
      existingSession: { id: 'carrier-1', active: true, metadata: writeVoiceConversationScopeMetadata({
        path: '/repo', host: 'voice.test', machineId: 'machine-1', flavor: 'claude',
        permissionMode: 'read-only', connectedServices: { v: 2, bindingsByServiceId: {} },
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
        agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
      } satisfies NonNullable<ReturnType<typeof createSessionFixture>['metadata']>, { kind: 'session_root', sessionRootId: 's1' }) },
      sessions: [createSessionFixture({ id: 's1', active: true, activeAt: Date.now(), metadata: {
        path: '/repo', host: 'voice.test', machineId: 'machine-1', flavor: 'claude',
        agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
      } })],
    });
    const active = await harness.activateLocalAgent();
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    try {
      const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now(),
        access: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }).access });
      storage.setState({ machines: { [machine.id]: machine },
        machineListByServerId: { [active.binding.conversationSessionAddress.serverId]: [machine] } });
      const { writeVoiceProviderSettingsConfig, readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
      const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
      const voice = storage.getState().settings.voice;
      const config = readLocalConversationVoiceSettings(voice);
      storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: writeVoiceProviderSettingsConfig(voice, 'local_conversation', {
        ...config, conversationMode: 'agent', agent: { ...config.agent, teleportEnabled: true, stayInVoiceHome: false },
      }) }, storage.getState().settings));
      expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).agent)
        .toMatchObject({ teleportEnabled: true, stayInVoiceHome: false });
      daemon.requests.length = 0;
      const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1',
        currentSessionAddress: { serverId: active.binding.conversationSessionAddress.serverId, sessionId: 's1' } });
      const result = JSON.parse(await tools.teleportVoiceAgentToSessionRoot({}));
      expect(result, JSON.stringify({ result, methods: daemon.requests.map(request => request.method) })).toMatchObject({ ok: true });
      expect(voiceSessionBindingStore.getState().getByConversationSessionId('carrier-1')).toMatchObject({
        targetSessionAddress: { serverId: active.binding.conversationSessionAddress.serverId, sessionId: 's1' },
      });
      expect(daemon.readRetainedRun()).toBeNull();
      expect(daemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP))
        .toEqual([{ method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, input: { runId: 'local-agent-run' } }]);
    } finally {
      await active.dispose();
      // Teleport persisted a replacement binding outside the original attempt's
      // ownership. Retire only this fixture's runtime projection before its Home.
      const bindings = voiceSessionBindingStore.getState();
      if (bindings.runtimeBindingsByConversationSessionId['carrier-1']?.conversationSessionAddress.serverId
        === active.binding.conversationSessionAddress.serverId) bindings.unbind('carrier-1');
      await harness.dispose();
    }
  });

  describe('question answers with Voice request approval turned off', () => {
  beforeEach(() => {
    // An Action waiver cannot override the person's Voice opt-out.
    // The default approval/replay path is composed in defaultActionExecutor.planMode.test.ts.
    state.settings.voice.canApproveRequests = false;
    state.settings.actionsSettingsV1 = { v: 1, approvalWaivedSurfaces: { 'session.user_action.answer': ['voice'] } };
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
    expect(daemonRpc.mock.calls.map(([request]) => request.method)).not.toContain(RPC_METHODS.SESSION_USER_ACTION_ANSWER);
  });

  it('requires present-user authority for a pending AskUserQuestion despite structured spoken answers', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: { id: 'req_question', tool: 'AskUserQuestion', kind: 'user_action' },
      req_permission: { id: 'req_permission', tool: 'Bash', kind: 'permission' },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  it('requests person approval without executing an approval-required spoken answer', async () => {
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

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = JSON.parse(await tools.answerUserActionRequest(
      { answers: [{ question: 'Continue?', values: ['Yes'] }] },
      { callId: 'call-user-action-approval' },
    ));

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      kind: 'approval_request_created',
      actionId: 'session.user_action.answer',
    });
    expect(pendingEnqueue).not.toHaveBeenCalled();
    expect(daemonRpc).not.toHaveBeenCalled();
    expect(artifactCreateRequests).toHaveBeenCalled();
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

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      decision: 'reject',
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required', sessionId: 's1', requestId: 'req_question' });
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  it('requires present-user authority for ExitPlanMode even when Voice requests changes', async () => {
    state.sessions.s1.agentState.requests = {
      req_exit_plan: { id: 'req_exit_plan', tool: 'ExitPlanMode', kind: 'user_action' },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      decision: 'request_changes',
      reason: 'The plan needs another pass before exiting plan mode.',
    });

    expect(JSON.parse(result), result).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  it('rejects a spoken user-action answer before entering the scoped RPC', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: { id: 'req_question', tool: 'AskUserQuestion', kind: 'user_action' },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  it('retains present-user authority requirements for a transcript-backed user-action request', async () => {
    state.sessions.sys_voice.agentState.requests = {};
    state.sessions.s1.agentState.requests = {};
    state.sessions.s2.agentState.requests = {};
    seedMessages('s1', [
      createToolCallMessageFixture({
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
      }),
    ]);

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required', sessionId: 's1', requestId: 'req_question' });
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  it('refreshes the resolved target session messages before failing a user-action response', async () => {
    state.sessions.s1.agentState.requests = {};
    seedMessages('s1', []);
    messagePages.set('s1', SessionMessagesPageV1Schema.parse({ messages: [SessionMessageV1Schema.parse({
      id: 'm_pending_question_after_refresh', seq: 1, localId: null, createdAt: 16, updatedAt: 16, messageRole: 'agent',
      content: { t: 'plain', v: RawRecordSchema.parse({ role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
        type: 'permission-request', permissionId: 'req_question_after_refresh', toolName: 'AskUserQuestion',
        description: 'Ask the user a question', options: { permissionId: 'req_question_after_refresh', status: 'pending',
          questions: [{ question: 'Continue with the write?' }] },
      } } }) },
    })], hasMore: false }));

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue with the write?', values: ['Yes'] }],
    });

    expect(messageReads).toContain('s1');
    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required', sessionId: 's1', requestId: 'req_question_after_refresh' });
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  it('forces a session refresh before failing a user-action response when the known session state is stale', async () => {
    state.sessions.s1.agentState.requests = {};
    seedMessages('s1', []);
    sessionDetailReplies.set('s1', createSessionFixture({ ...state.sessions.s1, agentState: { requests: {
        req_question_after_force_refresh: {
          id: 'req_question_after_force_refresh',
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: { questions: [{ question: 'Continue with local voice QA?' }] },
        },
      } } }));

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue with local voice QA?', values: ['Yes'] }],
    });

    expect(sessionDetailReads).toContain('s1');
    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'present_user_required', sessionId: 's1', requestId: 'req_question_after_force_refresh' });
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  });

  it('routes sendSessionMessage to an explicit sessionId through canonical Voice admission', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.sendSessionMessage({ sessionId: 's2', message: 'hello' });

    expect(JSON.parse(result), result).toMatchObject({ ok: true });
    expectVoicePendingInput('s2', 'hello');
  });

  it('can set the primary action session', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.setPrimaryActionSession({ serverId: homeA, sessionId: 's2' });

    expect(JSON.parse(result), result).toMatchObject({ ok: true });
    expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: homeA, sessionId: 's2' });
  });

  it('does not expose raw Action failure prose in Voice tool results', () => {
    const serialized = serializeVoiceActionExecuteResult('session.spawn_new', {
      ok: false,
      errorCode: 'action_failed',
      error: 'private connected-service credential refresh transport detail',
      details: { sessionId: 's1' },
    });

    expect(JSON.parse(serialized)).toMatchObject({
      ok: false,
      errorCode: 'action_failed',
      errorMessage: 'action_failed',
      sessionId: 's1',
    });
    expect(serialized).not.toContain('private connected-service');
  });

  it.each(['session_stop_failed', 'session_stop_requested'] as const)(
    'reports an unconfirmed Session Stop as a Voice tool failure (%s)', (code) => {
      const serialized = serializeVoiceActionExecuteResult('session.stop', {
        ok: true,
        result: {
          sessionId: 's1', stopped: false, success: false, code,
          message: 'Session stop incomplete: private host diagnostic',
        },
      });

      expect(JSON.parse(serialized)).toMatchObject({
        ok: false, actionId: 'session.stop', errorCode: code, errorMessage: code,
      });
      expect(serialized).not.toContain('private host diagnostic');
    },
  );

  it('preserves a confirmed Session Stop in the Voice tool result', () => {
    const result = { sessionId: 's1', stopped: true, success: true };
    expect(JSON.parse(serializeVoiceActionExecuteResult('session.stop', { ok: true, result })))
      .toEqual({ ok: true, ...result });
  });

  it.each(['session_stop', 'action_execute'] as const)(
    'carries the daemon Stop refusal through the real Voice front door (%s)', async toolName => {
      const previous = daemonRpc.getMockImplementation();
      daemonRpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.STOP_SESSION) {
          return { status: 'incomplete', reason: 'missing_topology_proof' };
        }
        if (!previous) throw new Error('Voice daemon boundary is unavailable');
        return previous(request);
      });
      const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });
      const input = { sessionId: 's1', serverId: homeA, stopIntent: 'lifecycle_control' };
      const parameters = toolName === 'action_execute' ? { actionId: 'session.stop', input } : input;

      const result = JSON.parse(await tools[toolName]!(parameters, { serverId: homeA }));

      expect(result).toMatchObject({ ok: false, errorCode: 'session_stop_failed' });
      // A topology refusal is terminal for this invocation; reporting it must
      // not retry Stop against a replacement runner or another authority.
      expect(daemonRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.STOP_SESSION))
        .toHaveLength(1);
    },
  );

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
          address: { serverId: homeA, sessionId: 's2' },
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
    const { listSessionsForVoiceTool } = await import('./actionImpl/sessionList');
    await listSessionsForVoiceTool({ view: 'summary', limit: 1 });
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const defaultRes = await tools.listSessions({ view: 'summary', limit: 1 });
    const defaultParsed = JSON.parse(defaultRes) as any;
    expect(defaultParsed, defaultRes).toHaveProperty('sessions');
    expect(defaultParsed.sessions[0].lastMessagePreview).toBeUndefined();

    const res = await tools.listSessions({ view: 'summary', limit: 1, includeLastMessagePreview: true });
    const parsed = JSON.parse(res) as any;
    expect(Array.isArray(parsed.sessions), parsed.errorCode).toBe(true);
    expect(parsed.sessions.length).toBe(1);
    expect(parsed.sessions[0].id).toBe('s1');
    expect(parsed.sessions.some((s: any) => s.id === 'sys_voice')).toBe(false);
    expect(typeof parsed.sessions[0].title).toBe('string');
    expect(parsed.sessions[0].lastMessagePreview?.text).toContain('a2');
    expect(typeof parsed.nextCursor === 'string').toBe(true);

    const res2 = await tools.listSessions({ view: 'summary', limit: 10, cursor: parsed.nextCursor, includeLastMessagePreview: true });
    const parsed2 = JSON.parse(res2) as any;
    expect(parsed2, res2).toHaveProperty('sessions');
    expect(parsed2.sessions.some((s: any) => s.id === 's2')).toBe(true);
    const s2 = parsed2.sessions.find((s: any) => s.id === 's2');
    expect(s2?.lastMessagePreview?.role).toBe('tool');
    expect(s2?.lastMessagePreview?.text).toContain('Tool: read');
    expect(s2?.lastMessagePreview?.text).not.toContain('/Users/alice/SecretRepo/README.md');
    expect(s2?.lastMessagePreview?.text).not.toContain('Args:');

  });

  it('lists sessions only for the captured Home and reaches another Home through its explicit scope', async () => {
    retainFixtureSessionListCorpus();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ view: 'summary', limit: 10, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;
    expect(parsed, res).toHaveProperty('sessions');

    expect(parsed.sessions.some((session: { id: string }) => session.id === 's_other')).toBe(false);
    expect(parsed.sessions.every((session: { serverId: string }) => session.serverId === homeA)).toBe(true);

    const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
    const { isSessionListQueryHomeOnline } = await import('@/sync/domains/session/listing/sessionListQueryRuntime');
    const { loadEffectiveHomeViewState, updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
    const previousSelection = loadEffectiveHomeViewState();
    const previousConcurrentFlag = process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
    try {
      startConcurrentSessionCacheSync();
      await updateEffectiveHomeViewState(current => ({ ...current,
        groups: [{ id: 'voice-tool-homes', name: 'Voice tool Homes', serverIds: [homeA, homeB] }],
        activeTargetKind: 'group', activeTargetId: 'voice-tool-homes',
      }), { scope: 'device' });
      await waitForTestEvent(storage.subscribe, () => isSessionListQueryHomeOnline(homeB), Boolean);
      expect(isSessionListQueryHomeOnline(homeB)).toBe(true);
      const otherRaw = await tools.listSessions(
        { view: 'summary', limit: 10, includeLastMessagePreview: false },
        { serverId: homeB },
      );
      const otherHome = JSON.parse(otherRaw);
      expect(otherHome, otherRaw).toMatchObject({ ok: true, sessions: [{ id: 's_other', serverId: homeB }] });
      expect(otherHome.sessions.some((session: { id: string }) => session.id === 's1')).toBe(false);
      expect(getActiveServerSnapshot().serverId).toBe(homeA);
    } finally {
      stopConcurrentSessionCacheSync();
      if (previousSelection) await updateEffectiveHomeViewState(() => previousSelection, { scope: 'device' });
      if (previousConcurrentFlag === undefined) delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
      else process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = previousConcurrentFlag;
    }
  });

  it('includes sessions that only exist in the current visible session list', async () => {
    retainFixtureSessionListCorpus();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ view: 'summary', limit: 20, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;
    expect(parsed, res).toHaveProperty('sessions');

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
    expect(parsed, res).toHaveProperty('sessions');

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
    expect(parsed, res).toHaveProperty('sessions');

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
    expect(parsed, res).toHaveProperty('sessions');

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
        session: createSessionListRenderableSessionFixture({
          id: `s_recent_${index + 1}`,
          active: true,
          updatedAt: 1000 - index,
          presence: 'online',
          metadata: { summaryText: `Recent session ${index + 1}`, path: `/tmp/recent-${index + 1}` },
        }),
      })),
      {
        type: 'session',
        session: createSessionListRenderableSessionFixture({
          id: 's_matrix',
          active: false,
          updatedAt: 60,
          presence: 0,
          metadata: { summaryText: 'Session QA Voice Matrix', path: '/tmp/matrix' },
        }),
      },
    ];

    storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId,
      [homeA]: Object.fromEntries(state.sessionListViewData.map((entry: { session: { id: string } }) => [entry.session.id, entry.session])),
    } });
    retainVoiceSessionReferenceCorpus({
      addresses: state.sessionListViewData.map((entry: { session: { id: string } }) => ({
        serverId: homeA, sessionId: entry.session.id,
      })),
      complete: true,
    });
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ view: 'summary', includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;
    expect(parsed, res).toHaveProperty('sessions');

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
    expect(parsed, res).toHaveProperty('sessions');
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
    expect(parsed, res).toHaveProperty('sessions');

    const s1 = parsed.sessions.find((s: any) => s.id === 's1');
    expect(s1?.lastMessagePreview).toBeUndefined();

    const s2 = parsed.sessions.find((s: any) => s.id === 's2');
    expect(s2?.lastMessagePreview?.role).toBe('tool');
    expect(s2?.lastMessagePreview?.text).toContain('Tool: read');
  });

  it('returns transcript messages for a session when allowed', async () => {
    seedTranscriptPage('s1', [
      { role: 'user', content: { type: 'text', text: 'Committed user message' } },
      { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: 'Committed assistant message' } } },
    ]);
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 2 });
    const parsed = JSON.parse(res) as any;
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBe(2);
    expect(parsed.items[0].role).toBe('user');
    expect(parsed.items[1].role).toBe('assistant');
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
    state.sessions.s2.viewer = createSessionViewerFixture({
      follow: { follows: true, notificationLevel: 'important', includeInVoice: true },
    });
    seedTranscriptPage('s2', [{ role: 'user', content: { type: 'text', text: 'Followed private text' } }]);

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's2', limit: 1 });
    const parsed = JSON.parse(res) as any;
    expect(parsed, res).toMatchObject({ ok: true, sessionId: 's2', items: [{ text: 'Followed private text' }] });
    const beforeDenied = messageReads.length;
    state.sessions.s2.viewer = createSessionViewerFixture({
      follow: { follows: true, notificationLevel: 'important', includeInVoice: false },
    });
    const denied = await tools.getSessionTranscript({ sessionId: 's2', limit: 1 });
    expect(JSON.parse(denied), denied).toMatchObject({ ok: false, errorCode: 'other_sessions_snippets_disabled' });
    expect(denied).not.toContain('Followed private text');
    expect(messageReads).toHaveLength(beforeDenied);
  });

  it('redacts file paths in message text when shareFilePaths is false', async () => {
    state.settings.voice.privacy.shareFilePaths = false;
    seedTranscriptPage('s1', [{ role: 'agent', content: { type: 'acp', agentId: 'codex',
      data: { type: 'message', message: 'See /Users/alice/SecretRepo/README.md for details.' } } }]);

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 1, roles: ['assistant'], maxCharsPerMessage: null });
    const parsed = JSON.parse(res) as any;
    expect(parsed.items[0].text).toContain('<path_redacted>');
    expect(parsed.items[0].text).not.toContain('/Users/alice/SecretRepo/README.md');
  });

  it('does not clamp message text by default', async () => {
    const long = 'x'.repeat(9001);
    seedTranscriptPage('s1', [{ role: 'agent', content: { type: 'acp', agentId: 'codex',
      data: { type: 'message', message: long } } }]);

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 1, roles: ['assistant'] });
    const parsed = JSON.parse(res) as any;
    expect(parsed.items[0].text.length).toBe(9001);
  });

  it('returns a session activity digest without transcript content', async () => {
    const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionActivity({ sessionId: 's1' });
    const parsed = JSON.parse(res) as any;

    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed.sessionId).toBe('s1');
    expect(Array.isArray(parsed.permissionRequestIds)).toBe(true);
    expect(parsed.permissionRequestIds).toEqual(expect.arrayContaining(['req_a', 'req_b']));
    const messages = readStoredSessionMessages(storage.getState(), 's1');
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', kind: 'user-text', text: 'u1' }),
      expect.objectContaining({ id: 'm2', kind: 'agent-text', text: 'a2' }),
    ]));
    // The real reducer materializes the two pending permissions as assistant
    // tool messages; authored user/assistant messages remain in the same window.
    expect(messages.filter(message => message.kind === 'tool-call')).toHaveLength(2);
    expect(parsed.messageCounts).toEqual({ total: 4, assistant: 3, user: 1 });
    expect(parsed.recentMessages).toBeUndefined();
    expect(res).not.toContain('u1');
    expect(res).not.toContain('a2');
  });

  it('requests the marked awareness view through the Voice Action executor for the captured Home', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionActivity(
      { sessionId: 's1', view: 'awareness' },
      { serverId: homeA },
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
    expect(sessionDetailReads).toContain('s1');
    expect(messageReads).toEqual([]);
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
    expect(pendingEnqueue).not.toHaveBeenCalled();
  });
});

describe('voice tool reset Account authority', () => {
  it('executes a non-hot-path Action through generic Voice discovery and execution with real approval and Account settings', async () => {
    let account: Awaited<ReturnType<typeof import('@/voice/settings/panels/voiceSettingsAccountTestHarness')['createVoiceSettingsAccountTestHarness']>> | undefined;
    const controller = new AbortController();
    let pendingReset: Promise<string> | undefined;
    try {
      const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
      installDisconnectedServerSocketBoundary();
      const { adoptHomeProfile, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
      const { settingsParse } = await import('@/sync/domains/settings/settings');
      const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
      account = await createVoiceSettingsAccountTestHarness(settingsParse({ experiments: true,
        featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true },
        voiceSettingsV1: { providerId: 'local_conversation', providers: { local_conversation: { schemaVersion: 1,
          config: { agent: { transcript: { persistenceMode: 'persistent', epoch: 2 } } } } } },
      }));
      const accountHome = getServerProfileById(account.scope.serverId);
      if (!accountHome) throw new Error('Restored Account Home missing');
      await adoptHomeProfile({ descriptor: { serverUrl: accountHome.serverUrl,
        homeServerIdentityId: 'srv_voice-settings-account', displayName: 'Voice Settings Home' }, source: 'manual' });
      const { createArtifactStoreBoundary } = await import('@/dev/testkit/harness/artifactStoreBoundary');
      const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => account?.scope.accountId ?? null, encryptionMode: 'plain' });
      const approvalCreated = createDeferred<void>();
      artifacts.afterNextCreate(async () => { approvalCreated.resolve(); });
      const settingsRequest = account.request.getMockImplementation();
      if (!settingsRequest) throw new Error('Account HTTP boundary missing');
      account.request.mockImplementation(async (url, init) => {
        const parsed = new URL(String(url));
        const response = await (artifacts.handle(`${parsed.pathname}${parsed.search}`, init) ?? settingsRequest(url, init));
        return response;
      });
      const { VOICE_TRANSCRIPT_MEMORY_KEY, readPersistentVoiceTranscriptEpoch } = await import('@/voice/persistence/voiceTranscriptMemory');
      const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
      await account.kv.handleFetch('https://fixture.test/v1/kv', { method: 'POST', body: JSON.stringify({ mutations: [{
        key: VOICE_TRANSCRIPT_MEMORY_KEY, version: -1,
        value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, epoch: 2 } }),
      }] }) });
      const { createVoiceToolHandlers } = await import('./handlers');
      const tools = createVoiceToolHandlers({ resolveSessionId: () => null });
      const { getActionSpec, isVoicePromptHotPathSpec } = await import('@happier-dev/protocol');
      const { readHappierActionToolResultCandidates } = await import('@happier-dev/protocol/actions/happierActionToolResult');
      expect(isVoicePromptHotPathSpec(getActionSpec('ui.voice_global.reset'))).toBe(false);
      const searched = JSON.parse(await tools.searchActionSpecs({ query: 'ui.voice_global.reset' }));
      expect(searched.actionSpecs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ui.voice_global.reset' })]));
      const discovered = JSON.parse(await tools.getActionSpec({ id: 'ui.voice_global.reset' }));
      expect(discovered.ok).toBe(true);
      pendingReset = tools.action_execute({ actionId: 'ui.voice_global.reset', input: {} },
        { serverId: account.scope.serverId, effectId: 'voice-reset-test', signal: controller.signal });
      const { ApprovalRequestSchema } = await import('@happier-dev/protocol');
      await approvalCreated.promise;
      const approval = (() => {
        const row = artifacts.list().find((candidate) => {
          const body = artifacts.readPlainBody(candidate.id);
          return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
        });
        expect(row).toBeDefined();
        return row!;
      })();
      const request = ApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(approval.id) ?? 'null'));
      expect(request).toMatchObject({ v: 2, status: 'open', actionId: 'ui.voice_global.reset', executionOriginV1: {
        authority: 'account_automation', surface: 'voice', serverId: account.scope.serverId,
        serverIdentityId: 'srv_voice-settings-account', accountId: account.scope.accountId, requestId: 'voice-reset-test',
      } });
      expect(account.writes).toHaveLength(0);
      expect(await readPersistentVoiceTranscriptEpoch()).toBe(2);
      const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
      const decision = await createDefaultActionExecutor().execute('approval.request.decide',
        { artifactId: approval.id, decision: 'approve' }, { surface: 'ui', serverId: account.scope.serverId });
      expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
      const result = JSON.parse(await pendingReset);
      expect(result).toMatchObject({ ok: true });
      expect(readHappierActionToolResultCandidates(result)).toContainEqual({ ok: true, result: expect.objectContaining({
        kind: 'approval_request_created', actionId: 'ui.voice_global.reset', artifactId: approval.id,
      }) });
      expect(await readPersistentVoiceTranscriptEpoch()).toBe(3);
      expect(account.writes).toHaveLength(0);
      expect(JSON.parse(artifacts.readPlainBody(approval.id) ?? 'null')).toMatchObject({ status: 'executed' });
    } finally {
      controller.abort();
      await pendingReset?.catch(() => {});
      await account?.dispose();
    }
  });
});
