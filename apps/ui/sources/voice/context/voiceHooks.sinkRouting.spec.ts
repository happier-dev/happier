import { beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { VoiceSession } from '@/realtime/types';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceSessionBinding } from '@/voice/sessionBinding/voiceSessionBindingTypes';

const { realtimeState, appendLocalVoiceAgentContextUpdate, sendLocalVoiceAgentTextUpdate, announceLocalVoiceAgentAssistantText, isLocalVoiceAgentActive, resolveVoiceBindingByControlSessionId } = vi.hoisted(() => ({
  realtimeState: {
    started: false,
    session: null as Pick<VoiceSession, 'sendContextualUpdate' | 'sendTextMessage'> | null,
  },
  appendLocalVoiceAgentContextUpdate: vi.fn<(sessionId: string, update: string) => void>(),
  sendLocalVoiceAgentTextUpdate: vi.fn<(sessionId: string, update: string) => Promise<void>>(async () => undefined),
  announceLocalVoiceAgentAssistantText: vi.fn<(sessionId: string, text: string) => void>(),
  isLocalVoiceAgentActive: vi.fn<(sessionId: string) => boolean>((_sessionId: string) => true),
  resolveVoiceBindingByControlSessionId: vi.fn<(controlSessionId: string) => VoiceSessionBinding | null>(() => null),
}));

vi.mock('@/realtime/RealtimeSession', () => ({
  getVoiceSession: () => realtimeState.session,
  isVoiceSessionStarted: () => realtimeState.started,
}));

vi.mock('@/voice/local/localVoiceEngine', () => ({
  isLocalVoiceAgentActive: (sessionId: string) => isLocalVoiceAgentActive(sessionId),
  appendLocalVoiceAgentContextUpdate: (sessionId: string, update: string) =>
    appendLocalVoiceAgentContextUpdate(sessionId, update),
  sendLocalVoiceAgentTextUpdate: (sessionId: string, update: string) =>
    sendLocalVoiceAgentTextUpdate(sessionId, update),
  announceLocalVoiceAgentAssistantText: (sessionId: string, text: string) =>
    announceLocalVoiceAgentAssistantText(sessionId, text),
}));

vi.mock('@/voice/sessionBinding/resolveVoiceSessionBinding', () => ({
  resolveVoiceSessionBindingByControlSessionId: (params: { controlSessionId: string }) =>
    resolveVoiceBindingByControlSessionId(params.controlSessionId),
}));

import { voiceHooks } from './voiceHooks';

describe('voiceHooks sink routing', () => {
  beforeEach(() => {
    appendLocalVoiceAgentContextUpdate.mockReset();
    sendLocalVoiceAgentTextUpdate.mockReset();
    announceLocalVoiceAgentAssistantText.mockReset();
    isLocalVoiceAgentActive.mockReset();
    isLocalVoiceAgentActive.mockReturnValue(true);
    resolveVoiceBindingByControlSessionId.mockReset();
    resolveVoiceBindingByControlSessionId.mockReturnValue(null);
    realtimeState.started = false;
    realtimeState.session = null;
    voiceHooks.onVoiceStopped();
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);

    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...settingsDefaults,
        voice: {
          ...settingsDefaults.voice,
          providerId: 'local_conversation',
          adapters: {
            ...settingsDefaults.voice.adapters,
            local_conversation: {
              ...settingsDefaults.voice.adapters.local_conversation,
              conversationMode: 'agent',
            },
          },
        },
      },
      sessions: {
        ...state.sessions,
        s1: {
          id: 's1',
          metadata: { path: '/tmp/project', host: 'localhost', summary: { text: 'Session summary', updatedAt: Date.now() } },
          presence: 'online',
        },
        s2: {
          id: 's2',
          metadata: { path: '/tmp/other-project', host: 'localhost', summary: { text: 'Other session summary', updatedAt: Date.now() } },
          presence: 'online',
        },
      },
      sessionMessages: {
        ...state.sessionMessages,
        s1: { messages: [] },
        s2: { messages: [] },
      },
    }));
  });

  it('routes ready updates to the local agent as contextual background when deterministic local announcements are available', () => {
    voiceHooks.onReady('s1');

    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      VOICE_AGENT_GLOBAL_SESSION_ID,
      expect.stringContaining('# Session: Session summary'),
    );
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      VOICE_AGENT_GLOBAL_SESSION_ID,
      expect.stringContaining('Coding assistant finished working in “Session summary”'),
    );
    expect(sendLocalVoiceAgentTextUpdate).not.toHaveBeenCalledWith(
      VOICE_AGENT_GLOBAL_SESSION_ID,
      expect.stringContaining('Coding assistant finished working in “Session summary”'),
    );
  });

  it('prefers active remote voice session over local agent routing', () => {
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onReady('s1');

    expect(sendContextualUpdate).toHaveBeenCalledWith(expect.stringContaining('# Session: Session summary'));
    expect(sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('Coding assistant finished working in “Session summary”'));
    expect(appendLocalVoiceAgentContextUpdate).not.toHaveBeenCalled();
  });

  it('includes fresh agent-text content in the remote ready-event announcement when available', () => {
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onReady('s1', [{
      kind: 'agent-text',
      text: 'Implemented the change and updated the tests.',
      createdAt: 2,
    } as any]);

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.stringContaining('Implemented the change and updated the tests.'),
    );
  });

  it('falls back to stored recent agent-text content when the ready event arrives without a fresh batch', () => {
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

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

    voiceHooks.onReady('s1');

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.stringContaining('I found the root cause in the session sync path.'),
    );
  });

  it('does not route to agent when agent is inactive', () => {
    isLocalVoiceAgentActive.mockReturnValue(false);

    voiceHooks.onReady('s1');

    expect(appendLocalVoiceAgentContextUpdate).not.toHaveBeenCalled();
  });

  it('routes local ready updates to the bound hidden conversation session as contextual background', () => {
    resolveVoiceBindingByControlSessionId.mockReturnValue({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    isLocalVoiceAgentActive.mockImplementation((sessionId: string) => sessionId === 'voice-conversation-1');

    voiceHooks.onReady('s1');

    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('# Session: Session summary'),
    );
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('Coding assistant finished working in “Session summary”'),
    );
    expect(sendLocalVoiceAgentTextUpdate).not.toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('Coding assistant finished working in “Session summary”'),
    );
  });

  it('routes non-target session updates when other-session voice updates are enabled', () => {
    resolveVoiceBindingByControlSessionId.mockReturnValue({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    isLocalVoiceAgentActive.mockImplementation((sessionId: string) => sessionId === 'voice-conversation-1');

    voiceHooks.onReady('s2');

    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('Coding assistant finished working in'),
    );
    expect(sendLocalVoiceAgentTextUpdate).not.toHaveBeenCalled();
  });

  it('interrupts the active target with assistant message content instead of only a contextual update', () => {
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onMessages('s1', [{
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

  it('routes active-target assistant replies to local voice as deterministic announcements plus contextual background', () => {
    resolveVoiceBindingByControlSessionId.mockReturnValue({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    isLocalVoiceAgentActive.mockImplementation((sessionId: string) => sessionId === 'voice-conversation-1');

    voiceHooks.onMessages('s1', [{
      kind: 'agent-text',
      text: 'The coding assistant needs approval.',
      createdAt: 1,
    } as any]);

    expect(announceLocalVoiceAgentAssistantText).toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('The coding assistant needs approval.'),
    );
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('The coding assistant needs approval.'),
    );
    expect(sendLocalVoiceAgentTextUpdate).not.toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('The coding assistant needs approval.'),
    );
  });

  it('announces failed sub-agent run summaries immediately in the bound hidden voice conversation', () => {
    resolveVoiceBindingByControlSessionId.mockReturnValue({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    isLocalVoiceAgentActive.mockImplementation((sessionId: string) => sessionId === 'voice-hidden-s1');

    voiceHooks.onMessages('s1', [{
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

    expect(announceLocalVoiceAgentAssistantText).toHaveBeenCalledWith(
      'voice-hidden-s1',
      expect.stringContaining('Invalid review output (expected strict JSON).'),
    );
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      'voice-hidden-s1',
      expect.stringContaining('Invalid review output (expected strict JSON).'),
    );
  });

  it('mirrors active-target assistant replies into the bound hidden voice conversation for hands-free follow-up', () => {
    resolveVoiceBindingByControlSessionId.mockReturnValue({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    isLocalVoiceAgentActive.mockImplementation((sessionId: string) => sessionId === 'voice-hidden-s1');

    voiceHooks.onMessages('s1', [{
      kind: 'agent-text',
      text: 'What do you want handled in this workspace?',
      createdAt: 1,
    } as any]);

    expect(announceLocalVoiceAgentAssistantText).toHaveBeenCalledWith(
      'voice-hidden-s1',
      expect.stringContaining('What do you want handled in this workspace?'),
    );
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      'voice-hidden-s1',
      expect.stringContaining('What do you want handled in this workspace?'),
    );
    expect(sendLocalVoiceAgentTextUpdate).not.toHaveBeenCalledWith(
      'voice-hidden-s1',
      expect.stringContaining('What do you want handled in this workspace?'),
    );
  });

  it('treats the bound local target session as the primary action session and keeps replies in contextual background even when the voice target store is stale', () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionId(null);
    useVoiceTargetStore.getState().setTrackedSessionIds([]);
    resolveVoiceBindingByControlSessionId.mockReturnValue({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    isLocalVoiceAgentActive.mockImplementation((sessionId: string) => sessionId === 'voice-hidden-s1');

    voiceHooks.onMessages('s1', [{
      kind: 'agent-text',
      text: 'Choose one of the onboarding options.',
      createdAt: 1,
    } as any]);

    expect(announceLocalVoiceAgentAssistantText).toHaveBeenCalledWith(
      'voice-hidden-s1',
      expect.stringContaining('Choose one of the onboarding options.'),
    );
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      'voice-hidden-s1',
      expect.stringContaining('Choose one of the onboarding options.'),
    );
    expect(sendLocalVoiceAgentTextUpdate).not.toHaveBeenCalledWith(
      'voice-hidden-s1',
      expect.stringContaining('Choose one of the onboarding options.'),
    );
  });

  it('announces permission requests immediately in the local hidden voice conversation and keeps the detailed request as contextual background', () => {
    resolveVoiceBindingByControlSessionId.mockReturnValue({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    isLocalVoiceAgentActive.mockImplementation((sessionId: string) => sessionId === 'voice-conversation-1');

    voiceHooks.onAgentRequest('s1', 'req_1', 'permission', 'Bash', { command: 'rm -rf /tmp/x' });

    expect(announceLocalVoiceAgentAssistantText).toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('needs permission'),
    );
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('<request_id>req_1</request_id>'),
    );
    expect(sendLocalVoiceAgentTextUpdate).not.toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('<request_id>req_1</request_id>'),
    );
  });

  it('announces non-target user-action requests in the local hidden voice conversation when other-session updates are enabled', () => {
    resolveVoiceBindingByControlSessionId.mockReturnValue({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-conversation-1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    isLocalVoiceAgentActive.mockImplementation((sessionId: string) => sessionId === 'voice-conversation-1');

    voiceHooks.onAgentRequest('s2', 'req_2', 'user_action', 'AskUserQuestion', {
      prompt: 'Pick a shape',
      answers: [{ value: 'circle', title: 'Circle' }, { value: 'square', title: 'Square' }],
    });

    expect(announceLocalVoiceAgentAssistantText).toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('needs your input'),
    );
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      'voice-conversation-1',
      expect.stringContaining('<request_id>req_2</request_id>'),
    );
    expect(sendLocalVoiceAgentTextUpdate).not.toHaveBeenCalled();
  });

  it('keeps non-target session assistant updates as contextual background updates', () => {
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };
    useVoiceTargetStore.getState().setPrimaryActionSessionId('other-session');

    voiceHooks.onMessages('s1', [{
      kind: 'agent-text',
      text: 'Background session reply.',
      createdAt: 1,
    } as any]);

    expect(sendContextualUpdate).toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('Background session reply.'),
    );
  });
});
