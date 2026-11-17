import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { ExecutionRunTurnStreamStartResponseSchema, ExecutionRunTurnStreamReadResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import { createStandaloneVoicePolicyHarness, prepareStandaloneVoicePolicyHarness } from '@/dev/testkit/harness/standaloneVoicePolicyHarness';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { VoiceSession } from '@/realtime/types';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { waitForTestEvent } from '@/dev/testkit';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';

await prepareStandaloneVoicePolicyHarness();

const { storage } = await import('@/sync/domains/state/storage');
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
const { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } = await import('@/voice/session/voiceAdapterRegistry');
const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');

const realtimeState = {
  started: false,
  hostAuthoredContext: 'session_context' as 'session_context' | 'current_ui_only',
  session: null as Pick<VoiceSession, 'sendContextualUpdate' | 'sendTextMessage'> | null,
};
const localProviderTurns = vi.fn<(input: unknown) => void>();
const { createCurrentUiContextAutomaticUpdateProjector, voiceHooks } = await import('./voiceHooks');
const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getVoiceContextSinkForSession } = await import('./getVoiceContextSinkForSession');
let TEST_SERVER_ID: string;
let fixture: Awaited<ReturnType<typeof createStandaloneVoicePolicyHarness>>;
let activation: Awaited<ReturnType<typeof fixture.activateLocalAgent>> | undefined;

function announcementTexts(sessionId: string): string[] {
  return readStoredSessionMessages(storage.getState(), sessionId).flatMap(message =>
    message.kind === 'agent-text' ? [message.text] : []);
}

describe('voiceHooks sink routing', () => {
  beforeEach(async () => {
    const daemon = await createRetainedVoiceAgentRpcBoundary({
      handleOtherRpc: async (method, input) => {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
          localProviderTurns(input);
          return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId: 'context-stream' });
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) return ExecutionRunTurnStreamReadResponseSchema.parse({
          streamId: 'context-stream', events: [{ t: 'done', assistantText: 'Probe reply', actions: [] }], nextCursor: 1, done: true });
        throw new Error(`Unexpected context Agent RPC: ${method}`);
      },
    });
    fixture = await createStandaloneVoicePolicyHarness({ mode: 'off',
      existingSession: createSessionFixture({ id: 'voice-conversation-1', active: true, activeAt: Date.now(), metadata: {
        path: '/voice', host: 'voice.test', flavor: 'claude',
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
        agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
      } }),
      sessions: ['s1', 's2', 'voice-hidden-s1'].map(id => createSessionFixture({ id, active: true, activeAt: Date.now(),
        metadata: { path: '/voice', host: 'voice.test', flavor: 'claude',
          agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } })),
      dispatch: daemon.dispatch,
    });
    TEST_SERVER_ID = getActiveServerSnapshot().serverId;
  });
  afterEach(async () => {
    try {
      if (voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)) {
        await voiceAgentSessions.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'CONTEXT_QUEUE_PROBE');
        // An accidental second foreground Follow queue is observable on the next
        // real provider turn, even if it produced no immediate transport call.
        expect(localProviderTurns.mock.calls.at(-1)?.[0]).toMatchObject({ message: 'CONTEXT_QUEUE_PROBE' });
      }
    } finally {
      await activation?.dispose();
      activation = undefined;
      voiceSessionBindingStore.setState({ bindingsByConversationSessionId: {},
        runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {} });
      voiceHooks.onVoiceStopped();
      await fixture?.dispose();
    }
  });
  beforeEach(async () => {
    resetVoiceAdapterRegistryForTests();
    registerVoiceAdapters([{
      id: 'happier.voice.elevenlabs/realtime-elevenlabs',
      engineKind: 'realtime',
      start: async () => {},
      stop: async () => {},
      toggle: async () => {},
      interrupt: async () => {},
      setMuted: async () => {},
      sendContextUpdate: ({ update }) => realtimeState.session?.sendContextualUpdate(update),
      sendContextText: ({ text }) => realtimeState.session?.sendTextMessage(text),
      resolveContextChannel: () => realtimeState.session ? {
        hostAuthoredContext: realtimeState.hostAuthoredContext,
        sendContextualUpdate: (update) => realtimeState.session?.sendContextualUpdate(update),
        sendTextMessage: (text) => realtimeState.session?.sendTextMessage(text),
      } : null,
      getSnapshot: () => ({
        adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs', sessionId: 'realtime-s1',
        status: realtimeState.started ? 'connected' : 'disconnected', mode: 'idle', canStop: realtimeState.started,
      }),
    }, createLocalConversationVoiceAdapter()]);
    voiceSessionBindingStore.setState({
      bindingsByConversationSessionId: {},
      runtimeBindingsByConversationSessionId: {},
      persistedBindingsByConversationSessionId: {},
    });
    localProviderTurns.mockClear();
    realtimeState.started = false;
    realtimeState.hostAuthoredContext = 'session_context';
    realtimeState.session = null;
    voiceHooks.onVoiceStopped();
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([{ serverId: TEST_SERVER_ID, sessionId: 's1' }]);
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    const localConversationDefaults = readLocalConversationVoiceSettings(settingsDefaults.voice);
    const liveSessions = {
      s1: createSessionFixture({ id: 's1', serverId: TEST_SERVER_ID, active: true, activeAt: Date.now(), metadata: {
        path: '/tmp/project', host: 'localhost', flavor: 'claude',
        agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
        summary: { text: 'Session summary', updatedAt: Date.now() },
      } }),
      s2: createSessionFixture({ id: 's2', serverId: TEST_SERVER_ID, active: true, activeAt: Date.now(), metadata: {
        path: '/tmp/other-project', host: 'localhost', flavor: 'claude',
        agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
        summary: { text: 'Other session summary', updatedAt: Date.now() },
      } }),
    };
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...settingsDefaults.voice,
          providerId: 'local_conversation',
          privacy: {
            shareSessionSummary: true,
            shareRecentMessages: true,
            recentMessagesCount: 3,
            shareToolNames: true,
            sharePermissionRequests: true,
            shareDeviceInventory: true,
            shareFilePaths: false,
            shareToolArgs: false,
          },
          providers: {
            ...settingsDefaults.voice.providers,
            local_conversation: {
              schemaVersion: 1,
              config: {
                ...localConversationDefaults,
                conversationMode: 'agent',
              },
            },
          },
        },
      },
      sessions: {
        ...state.sessions,
        'voice-hidden-s1': createSessionFixture({ id: 'voice-hidden-s1', serverId: TEST_SERVER_ID }),
        ...liveSessions,
      },
      sessionListRowsByServerId: {
        [TEST_SERVER_ID]: liveSessions,
      },
      ordinarySessionListMembershipByServerId: {
        [TEST_SERVER_ID]: ['s1', 's2'],
      },
      sessionMessages: {
        ...state.sessionMessages,
        s1: createSessionMessagesFixture(),
        s2: createSessionMessagesFixture(),
        'voice-conversation-1': createSessionMessagesFixture(),
        'voice-hidden-s1': createSessionMessagesFixture(),
      },
    }));
    activation = await fixture.activateLocalAgent();
    expect(activation.controller.isAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
    // These cases decide whether a canonical binding is available independently
    // from an already running Agent; positive cases install their exact binding.
    voiceSessionBindingStore.getState().unbind(fixture.sessionId);
  });

  it('does not route ready updates when local agent mode is selected without a canonical binding', () => {

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    expect(localProviderTurns).not.toHaveBeenCalled();
  });

  it('does not fall back to a stale remote voice session while local agent mode is selected without a canonical binding', () => {
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    expect(localProviderTurns).not.toHaveBeenCalled();
    expect(sendContextualUpdate).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('includes fresh agent-text content in the remote ready-event announcement when available', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        },
      },
    }));
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };
    setVoiceSessionSnapshot({
      adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      sessionId: 'realtime-s1',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'agent-text',
      text: 'Implemented the change and updated the tests.',
      createdAt: 2,
    } as any]);

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.stringContaining('Implemented the change and updated the tests.'),
    );
  });

  it('falls back to stored recent agent-text content when the ready event arrives without a fresh batch', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        },
      },
    }));
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };
    setVoiceSessionSnapshot({
      adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      sessionId: 'realtime-s1',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });

    storage.setState((state: any) => ({
      ...state,
      sessionMessages: {
        ...state.sessionMessages,
        s1: {
          messageIdsOldestFirst: ['m1', 'm2'],
          messagesById: {
            m1: { id: 'm1', kind: 'user-text', text: 'Please inspect this.', createdAt: 1 },
            m2: { id: 'm2', kind: 'agent-text', text: 'I found the root cause in the session sync path.', createdAt: 2 },
          },
          messagesMap: {
            m1: { id: 'm1', kind: 'user-text', text: 'Please inspect this.', createdAt: 1 },
            m2: { id: 'm2', kind: 'agent-text', text: 'I found the root cause in the session sync path.', createdAt: 2 },
          },
        },
      },
    }));

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.stringContaining('I found the root cause in the session sync path.'),
    );
  });

  it('does not route to realtime from selected settings alone while the canonical voice snapshot is disconnected', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        },
      },
    }));
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'agent-text',
      text: 'Should not route through a disconnected realtime owner.',
      createdAt: 2,
    } as any]);

    expect(sendContextualUpdate).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('does not route to agent when agent is inactive', async () => {
    voiceSessionBindingStore.getState().bind(activation!.binding);
    await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });

    expect(getVoiceContextSinkForSession('s1')).toBeNull();
    expect(announcementTexts('voice-conversation-1')).toEqual([]);
  });

  it('does not fall back to a stale remote voice session when local agent mode is selected but inactive', async () => {
    voiceSessionBindingStore.getState().bind(activation!.binding);
    await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    expect(localProviderTurns).not.toHaveBeenCalled();
    expect(sendContextualUpdate).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('prefers the active realtime owner over newly selected local-agent settings during ready-event routing', () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-conversation-1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });
    setVoiceSessionSnapshot({
      adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      sessionId: 'realtime-s1',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });

    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'agent-text',
      text: 'The coding assistant finished the review.',
      createdAt: 1,
    } as any]);

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.stringContaining('The coding assistant finished the review.'),
    );
    expect(localProviderTurns).not.toHaveBeenCalled();
  });

  it('prefers the active local-agent owner over newly selected realtime settings during ready-event routing', async () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        },
      },
    }));
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-conversation-1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });
    setVoiceSessionSnapshot({
      adapterId: 'local_conversation',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });

    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'agent-text',
      text: 'The coding assistant finished the review.',
      createdAt: 1,
    } as any]);
    // The connected owner's completion is spoken without another Agent turn,
    // including after the selected provider changes.
    await waitForTestEvent(storage.subscribe, () => {
      expect(announcementTexts('voice-conversation-1')).toEqual(['The coding assistant finished the review.']);
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(sendContextualUpdate).not.toHaveBeenCalled();
  });

  it('leaves local ready catch-up to daemon turn admission', () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-conversation-1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });
    expect(localProviderTurns).not.toHaveBeenCalled();
  });

  it('routes non-target session updates when other-session voice updates are enabled', () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-conversation-1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's2' }, [{
      kind: 'agent-text', id: 'other-completion', localId: null, createdAt: 2, text: 'Unrelated background result.',
    }]);
    expect(announcementTexts('voice-conversation-1')).toEqual([]);
    expect(localProviderTurns).not.toHaveBeenCalled();
  });

  it('interrupts the active target with assistant message content instead of only a contextual update', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        },
      },
    }));
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };
    setVoiceSessionSnapshot({
      adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      sessionId: 'realtime-s1',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });

    voiceHooks.onMessages({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'agent-text',
      text: 'The coding assistant finished the review.',
      createdAt: 1,
    } as any]);

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.stringContaining('The coding assistant finished the review.'),
    );
    expect(sendContextualUpdate).not.toHaveBeenCalledWith(
      expect.stringContaining('The coding assistant finished the review.'),
    );
  });

  it('routes active-target assistant replies to local voice as deterministic foreground announcements only', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-conversation-1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });

    const completion = [{
      kind: 'agent-text',
      text: 'The coding assistant needs approval.',
      createdAt: 1,
    } as any];
    voiceHooks.onMessages({ serverId: TEST_SERVER_ID, sessionId: 's1' }, completion);
    expect(announcementTexts('voice-conversation-1')).toEqual([]);
    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' }, completion);

    await waitForTestEvent(storage.subscribe, () => {
      expect(announcementTexts('voice-conversation-1')).toEqual(expect.arrayContaining([expect.stringContaining('The coding assistant needs approval.')]));
    });
    expect(localProviderTurns).not.toHaveBeenCalled();
  });

  it('announces failed sub-agent run summaries immediately in the bound hidden voice conversation', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-hidden-s1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });

    voiceHooks.onMessages({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'tool-call',
      id: 'tool_1',
      localId: null,
      createdAt: 1,
      children: [],
      tool: {
        name: 'SubAgentRun',
        state: 'completed',
        input: { intent: 'review' },
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
        result: {
          status: 'failed',
          summary: 'Invalid review output (expected strict JSON).',
          error: { code: 'invalid_output' },
        },
      },
    } as any]);

    await waitForTestEvent(storage.subscribe, () => {
      expect(announcementTexts('voice-hidden-s1')).toEqual(expect.arrayContaining([expect.stringContaining('Invalid review output (expected strict JSON).')]));
    });
  });

  it('mirrors active-target assistant replies into the bound hidden voice conversation for hands-free follow-up', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-hidden-s1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'agent-text',
      text: 'What do you want handled in this workspace?',
      createdAt: 1,
    } as any]);

    await waitForTestEvent(storage.subscribe, () => {
      expect(announcementTexts('voice-hidden-s1')).toEqual(expect.arrayContaining([expect.stringContaining('What do you want handled in this workspace?')]));
    });
    expect(localProviderTurns).not.toHaveBeenCalled();
  });

  it('treats the bound local target session as the primary action session without retaining background context when the target store is stale', async () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-hidden-s1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });

    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'agent-text',
      text: 'Choose one of the onboarding options.',
      createdAt: 1,
    } as any]);

    await waitForTestEvent(storage.subscribe, () => {
      expect(announcementTexts('voice-hidden-s1')).toEqual(expect.arrayContaining([expect.stringContaining('Choose one of the onboarding options.')]));
    });
    expect(localProviderTurns).not.toHaveBeenCalled();
  });

  it('announces permission requests immediately without retaining a second detailed-request queue', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-conversation-1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });

    voiceHooks.onAgentRequest({ serverId: TEST_SERVER_ID, sessionId: 's1' }, 'req_1', 'permission', 'Bash', { command: 'rm -rf /tmp/x' });

    await waitForTestEvent(storage.subscribe, () => {
      expect(announcementTexts('voice-conversation-1')).toEqual(expect.arrayContaining([expect.stringContaining('needs permission')]));
    });
    expect(localProviderTurns).not.toHaveBeenCalled();
  });

  it('announces non-target user-action requests in the local hidden voice conversation when other-session updates are enabled', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      conversationSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 'voice-conversation-1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: TEST_SERVER_ID, sessionId: 's1' },
      updatedAt: 1,
    });

    voiceHooks.onAgentRequest({ serverId: TEST_SERVER_ID, sessionId: 's2' }, 'req_2', 'user_action', 'AskUserQuestion', {
      prompt: 'Pick a shape',
      answers: [{ value: 'circle', title: 'Circle' }, { value: 'square', title: 'Square' }],
    });

    await waitForTestEvent(storage.subscribe, () => {
      expect(announcementTexts('voice-conversation-1')).toEqual(expect.arrayContaining([expect.stringContaining('needs your input')]));
    });
    expect(localProviderTurns).not.toHaveBeenCalled();
  });

  it('leaves non-target Session catch-up to daemon turn admission', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        },
      },
    }));
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };
    setVoiceSessionSnapshot({
      adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      sessionId: 'realtime-s1',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: TEST_SERVER_ID, sessionId: 'other-session' });

    voiceHooks.onMessages({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'agent-text',
      text: 'Background session reply.',
      createdAt: 1,
    } as any]);

    expect(sendContextualUpdate).toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('Background session reply.'),
    );
  });
  it('withholds host-authored session context from a provider whose Agent runtime owns the prompt, while keeping authorized current-UI metadata', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
          privacy: { ...state.settings.voice.privacy, currentUiContextMode: 'automatic' },
        },
      },
    }));
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.hostAuthoredContext = 'current_ui_only';
    realtimeState.session = { sendContextualUpdate, sendTextMessage };
    setVoiceSessionSnapshot({
      adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      sessionId: 'realtime-s1',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });

    voiceHooks.onSessionOnline({ serverId: TEST_SERVER_ID, sessionId: 's1' }, { summary: { text: 'Session summary' } } as any);
    voiceHooks.onSessionFocus({ serverId: TEST_SERVER_ID, sessionId: 's1' }, { summary: { text: 'Session summary' } } as any);
    voiceHooks.onMessages({ serverId: TEST_SERVER_ID, sessionId: 's1' }, [{
      kind: 'agent-text',
      text: 'Stored transcript content.',
      createdAt: 1,
    } as any]);

    expect(sendContextualUpdate).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();

    voiceHooks.onCurrentUiContextChanged(
      's1',
      { navigation: { area: 'app', screen: 'home' }, commands: [] } as any,
      createCurrentUiContextAutomaticUpdateProjector(),
    );

    expect(sendContextualUpdate).toHaveBeenCalledTimes(1);
    expect(sendContextualUpdate.mock.calls[0]?.[0]).toContain('CURRENT UI CONTEXT');
  });

  it('withholds announced stored-session text from a provider whose Agent runtime owns the prompt', () => {
    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...state.settings,
        voice: {
          ...state.settings.voice,
          providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        },
      },
    }));
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.hostAuthoredContext = 'current_ui_only';
    realtimeState.session = { sendContextualUpdate, sendTextMessage };
    setVoiceSessionSnapshot({
      adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      sessionId: 'realtime-s1',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    });
    storage.setState((state: any) => ({
      ...state,
      sessionMessages: {
        ...state.sessionMessages,
        s1: {
          messageIdsOldestFirst: ['m1', 'm2'],
          messagesById: {
            m1: { id: 'm1', kind: 'user-text', text: 'Please inspect this.', createdAt: 1 },
            m2: { id: 'm2', kind: 'agent-text', text: 'I found the root cause in the session sync path.', createdAt: 2 },
          },
          messagesMap: {
            m1: { id: 'm1', kind: 'user-text', text: 'Please inspect this.', createdAt: 1 },
            m2: { id: 'm2', kind: 'agent-text', text: 'I found the root cause in the session sync path.', createdAt: 2 },
          },
        },
      },
    }));

    // An announced ready/assistant update is stored-session context whichever
    // transport the sink offers, so the text-turn channel must withhold it too.
    voiceHooks.onReady({ serverId: TEST_SERVER_ID, sessionId: 's1' });

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(sendContextualUpdate).not.toHaveBeenCalled();
  });

  it('routes duplicate-id lifecycle events only by their exact Home and fails closed for a bare id', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        ...state.sessions,
        same: {
          id: 'same',
          serverId: TEST_SERVER_ID,
          metadata: { summary: { text: 'Home A session' } },
          presence: 'online',
        },
      },
      sessionListRowsByServerId: {
        ...state.sessionListRowsByServerId,
        [TEST_SERVER_ID]: {
          ...state.sessionListRowsByServerId?.[TEST_SERVER_ID],
          same: {
            id: 'same',
            serverId: TEST_SERVER_ID,
            metadata: { summary: { text: 'Home A session' } },
            presence: 'online',
          },
        },
        'server-b': {
          same: {
            id: 'same',
            serverId: 'server-b',
            metadata: { summary: { text: 'Home B session' } },
            presence: 'online',
            viewer: { follow: { following: true, includeInVoice: true } },
          },
        },
      },
      ordinarySessionListMembershipByServerId: {
        ...state.ordinarySessionListMembershipByServerId,
        [TEST_SERVER_ID]: [...(state.ordinarySessionListMembershipByServerId?.[TEST_SERVER_ID] ?? []), 'same'],
        'server-b': ['same'],
      },
    }));
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: TEST_SERVER_ID, sessionId: 'same' });
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([{ serverId: TEST_SERVER_ID, sessionId: 'same' }]);

    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };
    setVoiceSessionSnapshot({
      adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      sessionId: 'realtime-s1',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });

    const homeB = { serverId: 'server-b', sessionId: 'same' } as const;
    voiceHooks.onSessionFocus(homeB);
    voiceHooks.onSessionOnline(homeB, { summary: { text: 'Home B session' } });
    voiceHooks.onSessionOffline(homeB, { summary: { text: 'Home B session' } });
    voiceHooks.onMessages(homeB, [{ kind: 'agent-text', text: 'Only Home B changed.', createdAt: 1 } as any]);
    voiceHooks.onReady(homeB, [{ kind: 'agent-text', text: 'Home B is ready.', createdAt: 2 } as any]);

    expect(useVoiceTargetStore.getState().lastFocusedSessionAddress).toEqual(homeB);
    expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: TEST_SERVER_ID, sessionId: 'same' });
    expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([{ serverId: TEST_SERVER_ID, sessionId: 'same' }]);
    expect([...sendContextualUpdate.mock.calls, ...sendTextMessage.mock.calls].flat().join('\n'))
      .toContain('Home B');
    expect([...sendContextualUpdate.mock.calls, ...sendTextMessage.mock.calls].flat().join('\n'))
      .not.toContain('Home A');

    sendContextualUpdate.mockClear();
    sendTextMessage.mockClear();
    const focusedBeforeAmbiguousEvent = useVoiceTargetStore.getState().lastFocusedSessionAddress;
    Reflect.apply(voiceHooks.onSessionFocus, voiceHooks, ['same']);
    Reflect.apply(voiceHooks.onSessionOnline, voiceHooks, ['same']);
    Reflect.apply(voiceHooks.onSessionOffline, voiceHooks, ['same']);
    Reflect.apply(voiceHooks.onMessages, voiceHooks, ['same', [{
      kind: 'agent-text',
      text: 'Ambiguous update must not escape.',
      createdAt: 3,
    }]]);
    Reflect.apply(voiceHooks.onReady, voiceHooks, ['same', [{
      kind: 'agent-text',
      text: 'Ambiguous ready must not escape.',
      createdAt: 4,
    }]]);

    expect(useVoiceTargetStore.getState().lastFocusedSessionAddress).toEqual(focusedBeforeAmbiguousEvent);
    expect(sendContextualUpdate).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});
