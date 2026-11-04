import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunTurnStreamStartRequestSchema, ExecutionRunTurnStreamStartV2RequestSchema,
  ExecutionRunTurnStreamReadResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { createDeferred, createSessionFixture, renderScreen } from '@/dev/testkit';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
  expoSpeechSpeak, getStorage, loadLocalVoiceEngineWithCompatState, localVoiceAgentRpc,
  localVoiceHomeId, localVoiceRouteState, registerLocalVoiceEngineHarnessHooks, sessionRpcWithServerScope, warmLocalVoiceEngineHarnessGraph,
  waitForLocalVoiceBoundaryEvent, waitForLocalVoiceState,
} from '@/voice/local/localVoiceEngine.testHarness';

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());
const [
  { InjectedAuthProvider }, { MainAppTabStateProvider }, { AppPaneProvider },
  { CurrentUiContextProvider, usePublishCurrentUiContext }, { PluginSurfaceFocusEligibilityProvider },
  { useCurrentUiContextVoiceToolPort }, { TokenStorage }, { getActiveServerSnapshot },
] = await Promise.all([
  import('@/auth/context/AuthContext'),
  import('@/components/navigation/mobile/chrome/MainAppTabStateProvider'),
  import('@/components/appShell/panes/AppPaneProvider'),
  import('@/components/appShell/currentUiContext/CurrentUiContextProvider'),
  import('@/components/ui/presentation/PluginSurfaceFocusEligibility'),
  import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort'),
  import('@/auth/storage/tokenStorage'),
  import('@/sync/domains/server/serverRuntime'),
]);

function admittedProviderText() {
  const request = [...localVoiceAgentRpc.requests].reverse().find(request =>
    request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
    || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2);
  if (!request) throw new Error('No actual Agent turn was admitted');
  return (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
    ? ExecutionRunTurnStreamStartV2RequestSchema : ExecutionRunTurnStreamStartRequestSchema).parse(request.input).message;
}

describe('local conversation voice adapter', () => {
  registerLocalVoiceEngineHarnessHooks();
  let adapter: ReturnType<typeof import('./localConversationAdapter')['createLocalConversationVoiceAdapter']>;
  beforeEach(async () => {
    await loadLocalVoiceEngineWithCompatState();
    const storage = await getStorage();
    const state = storage.getState();
    const config = readLocalConversationVoiceSettings(state.settings.voice);
    storage.__setState({ settings: { ...state.settings, voice: { ...state.settings.voice,
      providerId: 'local_conversation', providers: { ...state.settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...config, conversationMode: 'agent',
          agent: { ...config.agent, prewarmOnConnect: false } } } } } } });
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    adapter = createLocalConversationVoiceAdapter();
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([adapter]);
  });

  async function send(text: string, localId: string, onAccepted: () => Promise<void> = async () => {}) {
    await adapter.sendTextTurn?.({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home-session', text, localId, deliveryCommand: 'interrupt_and_send', onAccepted });
  }

  it('toggle starts actual capture for the global Agent conversation', async () => {
    await adapter.toggle({ sessionId: 's1' });
    expect(adapter.getSnapshot()).toMatchObject({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected', mode: 'listening', canStop: true });
    const { voiceConversationBindingResolver } = await import('@/voice/binding/VoiceConversationBindingResolver');
    expect(voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID }))
      .toMatchObject({ conversationSessionId: 'voice-home-session' });
  });

  it('carries the provider-owned current UI port into actual Agent turn input', async () => {
    localVoiceRouteState.pathname = '/settings/voice';
    localVoiceRouteState.segments = ['(app)', 'settings', 'voice'];
    const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
    if (!credentials) throw new Error('Mounted AppShell requires restored Account credentials');
    const storage = await getStorage();
    const state = storage.getState();
    const config = readLocalConversationVoiceSettings(state.settings.voice);
    storage.__setState({ settings: { ...state.settings, voice: { ...state.settings.voice,
      privacy: { ...state.settings.voice.privacy, currentUiContextMode: 'automatic', shareSessionSummary: false },
      providers: { ...state.settings.voice.providers, local_conversation: { schemaVersion: 1,
        config: { ...config, agent: { ...config.agent, prewarmOnConnect: true } } } } } } });
    const mountedPort: { current: VoiceCurrentUiToolPort | null } = { current: null };
    const enrichment = { entity: { kind: 'adapter_ui', label: 'PRIVATE_UI_LABEL_SENTINEL' }, commands: [] };
    function Publication() {
      usePublishCurrentUiContext(enrichment);
      mountedPort.current = useCurrentUiContextVoiceToolPort();
      return null;
    }
    const tree = React.createElement(InjectedAuthProvider, { credentials, children:
      React.createElement(MainAppTabStateProvider, { children: React.createElement(AppPaneProvider, { children:
        React.createElement(CurrentUiContextProvider, { children: React.createElement(PluginSurfaceFocusEligibilityProvider,
          { active: true, currentUiContextActive: true, children: React.createElement(Publication) }) }) }) }) });
    const responder = sessionRpcWithServerScope.getMockImplementation();
    if (!responder) throw new Error('Missing local Voice Socket RPC boundary');
    const screen = await renderScreen(tree);
    const prewarmEntered = createDeferred<void>();
    const prewarmReply = createDeferred<void>();
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
        || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
        prewarmEntered.resolve();
        await prewarmReply.promise;
      }
      return responder(request);
    });
    try {
      const currentUiContext = mountedPort.current;
      if (!currentUiContext) throw new Error('Actual mounted Current UI port unavailable');
      const currentUi = currentUiContext.readCurrentUiContext();
      expect(currentUi).toMatchObject({ navigation: { area: 'settings' }, entity: { label: 'PRIVATE_UI_LABEL_SENTINEL' } });
      const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
      adapter = createLocalConversationVoiceAdapter({ currentUiContext });
      const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
      registerVoiceAdapters([adapter]);
      await React.act(async () => {
        await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
        await prewarmEntered.promise;
        const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
        // Join prewarm while its daemon reply is held, so initialization must
        // settle through the real metadata/policy owners before the UI turn.
        const agentReady = voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
        prewarmReply.resolve();
        await agentReady;
        expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID), 'Actual Agent prewarm').toBe(true);
        await send('Read the current screen', 'provider-ui-turn');
      });
      expect(admittedProviderText()).toContain('CURRENT UI CONTEXT');
      expect(admittedProviderText()).toContain('"area":"settings"');
      expect(admittedProviderText()).toContain(`"screen":${JSON.stringify(currentUi?.navigation.screen)}`);
      expect(admittedProviderText()).not.toContain('PRIVATE_UI_LABEL_SENTINEL');
    } finally {
      prewarmReply.resolve();
      await screen.unmount();
    }
  });

  it('owns configured agent capabilities independently of the next provider selection', async () => {
    const storage = await getStorage();
    const selected = storage.getState().settings.voice;
    expect(adapter.resolveSurfaceCapabilities?.(selected)).toEqual({ allowsGlobalStart: true,
      controlSessionScope: 'global', requiresVoiceAgentFeature: true, bargeInEnabled: true, cancelResponse: 'immediate' });
    expect(adapter.resolveSurfaceCapabilities?.({ ...selected, providerId: 'local_direct' }))
      .toEqual(adapter.resolveSurfaceCapabilities?.(selected));
  });

  it('publishes the fixed Agent\'s exact runtime identity, and none when the Voice Agent follows the session', async () => {
    const storage = await getStorage();
    const selected = storage.getState().settings.voice;
    const config = readLocalConversationVoiceSettings(selected);
    const withAgent = (agent: Partial<typeof config.agent>) => ({ ...selected, providers: { ...selected.providers,
      local_conversation: { schemaVersion: 1, config: { ...config, agent: { ...config.agent, ...agent } } } } });
    expect(adapter.resolveSurfaceCapabilities?.(withAgent({ agentSource: 'agent', agentId: 'codex' })))
      .toMatchObject({ agentRuntime: { pluginId: 'happier.agent.codex', localId: 'codex' } });
    expect(adapter.resolveSurfaceCapabilities?.(withAgent({ agentSource: 'session', agentId: 'codex' })))
      .not.toHaveProperty('agentRuntime');
  });

  it('another surface toggle finishes the active capture without retiring its global conversation', async () => {
    const storage = await getStorage();
    const current = storage.getState();
    const firstSession = current.sessions.s1;
    if (!firstSession) throw new Error('Missing canonical first Session fixture');
    storage.__setState({ sessions: { ...current.sessions,
      's-next': createSessionFixture({ ...firstSession, id: 's-next', serverId: localVoiceHomeId }) } });
    await adapter.toggle({ sessionId: 's1' });
    expect(adapter.getSnapshot(), JSON.stringify(adapter.getSnapshot())).toMatchObject({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, status: 'connected', mode: 'listening' });
    await adapter.toggle({ sessionId: 's-next' });
    expect(adapter.getSnapshot(), JSON.stringify(adapter.getSnapshot())).toMatchObject({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected', mode: 'idle', canStop: true });
  });

  it('does not retain synchronized Session updates in the actual Agent turn', async () => {
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    adapter.sendContextUpdate({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, update: 'SESSION_CONTEXT_SENTINEL' });
    await send('User request', 'session-context-turn');
    expect(admittedProviderText()).not.toContain('SESSION_CONTEXT_SENTINEL');
    expect(admittedProviderText()).toContain('User request');
  });

  it('admits only current-UI context through the active real Agent binding', async () => {
    const storage = await getStorage();
    const current = storage.getState();
    storage.__setState({ settings: { ...current.settings, voice: { ...current.settings.voice,
      privacy: { ...current.settings.voice.privacy, currentUiContextMode: 'automatic' } } } });
    expect(adapter.resolveContextChannel?.(storage.getState().settings.voice)).toBeNull();
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    await send('Initialize the Agent', 'initial-agent-turn');
    const channel = adapter.resolveContextChannel?.(storage.getState().settings.voice);
    expect(channel).not.toBeNull();
    channel?.sendContextualUpdate('SESSION_CONTEXT_SENTINEL', 'session_context');
    channel?.sendContextualUpdate('CURRENT_UI_SENTINEL', 'current_ui');
    await send('Read context', 'current-ui-turn');
    expect(admittedProviderText()).toContain('CURRENT_UI_SENTINEL');
    expect(admittedProviderText()).not.toContain('SESSION_CONTEXT_SENTINEL');
    await adapter.stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    expect(adapter.resolveContextChannel?.(storage.getState().settings.voice)).toBeNull();
  });

  it('reads a Brief through the connected unprewarmed Agent with its actual Inbox context', async () => {
    const { voiceHooks } = await import('@/voice/context/voiceHooks');
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
    const attention = { serverId: null, available: false, phase: 'idle' as const, runIds: [], refreshFailed: false,
      knownAt: null, hasMore: false, loadingMore: false, loadMoreFailed: false, retry: async () => {}, loadMore: async () => {} };
    const briefAdmitted = createDeferred<void>();
    const responder = sessionRpcWithServerScope.getMockImplementation();
    if (!responder) throw new Error('Missing local Voice Socket RPC boundary');
    sessionRpcWithServerScope.mockImplementation(async request => {
      const reply = await responder(request);
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
        || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) briefAdmitted.resolve();
      return reply;
    });
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: true });
    setVoiceSessionSnapshot(adapter.getSnapshot());
    expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
    try {
      expect(voiceHooks.onBriefRequested(VOICE_AGENT_GLOBAL_SESSION_ID, {
        source: { isDataReady: true, personalSessionListCoverageComplete: true },
        sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
        workGroups: [], automationAttentionItems: [], workflowAttention: attention, automationAttention: attention,
        isLoading: false, showCaughtUp: true,
      })).toBe(true);
      await briefAdmitted.promise;
      expect(admittedProviderText()).toContain('INBOX BRIEF');
      expect(admittedProviderText()).toContain('Voice approvals are enabled');
      expect(admittedProviderText()).toContain('Native Codex Realtime cannot decide requests');
    } finally {
      await adapter.stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
      setVoiceSessionSnapshot(adapter.getSnapshot());
    }
  });

  it('speaks the Home public Brief request through the connected Local Agent', async () => {
    const { InboxModelBoundary } = await import('@/hooks/inbox/useInboxModel');
    const { useVoiceBriefHomeRequest, useVoiceBriefRequest } = await import('@/components/voice/brief/useVoiceBriefRequest');
    const { executeVoiceBriefOperation } = await import('@/components/voice/brief/voiceBriefActionRuntime');
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
    if (!credentials) throw new Error('Home Brief requires restored Account credentials');
    const storage = await getStorage();
    const state = storage.getState();
    const config = readLocalConversationVoiceSettings(state.settings.voice);
    storage.__setState({ settings: { ...state.settings, voice: { ...state.settings.voice,
      providers: { ...state.settings.voice.providers, local_conversation: { schemaVersion: 1,
        config: { ...config, tts: { ...config.tts, provider: 'device', autoSpeakReplies: true } } } } } } });
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: true });
    setVoiceSessionSnapshot(adapter.getSnapshot());
    function HomeBrief() { useVoiceBriefRequest(); return null; }
    function Home() {
      const [open, setOpen] = React.useState(false);
      useVoiceBriefHomeRequest({ available: true, onOpen: () => setOpen(true) });
      return open ? React.createElement(InboxModelBoundary, { children: React.createElement(HomeBrief) }) : null;
    }
    const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials, children:
      React.createElement(MainAppTabStateProvider, { children: React.createElement(AppPaneProvider, { children:
        React.createElement(Home) }) }) }));
    try {
      await React.act(async () => { expect(executeVoiceBriefOperation('request').ok).toBe(true); });
      await waitForLocalVoiceBoundaryEvent('speech');
      await waitForLocalVoiceState(state => state.status === 'idle' || state.error !== null);
      expect(admittedProviderText()).toContain('INBOX BRIEF');
      expect(expoSpeechSpeak.mock.calls.some(([text]) => typeof text === 'string' && text.includes('Daemon reply'))).toBe(true);
      expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', mode: 'idle' });
      expect(adapter.getSnapshot().errorMessage).toBeUndefined();
    } finally {
      await screen.unmount();
      await adapter.stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
      setVoiceSessionSnapshot(adapter.getSnapshot());
    }
  });

  it('projects a disconnected runtime as an unavailable local session', () => {
    expect(adapter.getSnapshot()).toMatchObject({ status: 'disconnected', mode: 'idle', canStop: false });
  });

  it('projects connected idle after actual capture finishes with no transcript', async () => {
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    expect(adapter.getSnapshot()).toMatchObject({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected', mode: 'idle', canStop: true });
  });

  it('projects physical mute from the actual capture owner', async () => {
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: true });
    expect(adapter.getSnapshot()).toMatchObject({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, micMuted: true });
  });

  it('interrupt settles a held actual Agent stream without hanging up', async () => {
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    const read = createDeferred<ReturnType<typeof ExecutionRunTurnStreamReadResponseSchema.parse>>();
    const fallback = sessionRpcWithServerScope.getMockImplementation();
    const reading = createDeferred<void>();
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        reading.resolve();
        return read.promise;
      }
      if (!fallback) throw new Error('Missing daemon transport responder');
      return fallback(request);
    });
    const turn = send('A pending reply', 'interrupt-held-turn');
    await reading.promise;
    const interruption = adapter.interrupt({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    try {
      // Cancelling a reply retains the connection, including while the exact
      // daemon stream acknowledgement has not settled.
      expect(adapter.getSnapshot()).toMatchObject({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected', mode: 'idle', canStop: true });
      await interruption;
      expect(adapter.getSnapshot()).toMatchObject({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: 'connected', mode: 'idle', canStop: true });
      expect(localVoiceAgentRpc.readRetainedRun()?.status).toBe('running');
    } finally {
      read.resolve(ExecutionRunTurnStreamReadResponseSchema.parse({ streamId: 'stream-1', events: [], nextCursor: 0, done: true }));
      await interruption;
      await turn;
    }
  });

  it('text turns preserve durable acceptance and reach the actual Agent', async () => {
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    let accepted = false;
    await send('hello from composer', 'voice-local-1', async () => { accepted = true; });
    expect(accepted).toBe(true);
    expect(admittedProviderText()).toContain('hello from composer');
    expect(localVoiceAgentRpc.readRetainedRun()?.status).toBe('running');
  });

  it('mute is qualified by the resolved conversation control id', async () => {
    await adapter.toggle({ sessionId: 's1' });
    await adapter.setMuted({ sessionId: 's1', muted: true });
    expect(adapter.getSnapshot()).toMatchObject({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, micMuted: true });
    await adapter.setMuted({ sessionId: 'another-surface', muted: false });
    expect(adapter.getSnapshot().micMuted).not.toBe(true);
  });
});
