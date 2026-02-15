import { beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { VoiceSession } from '@/realtime/types';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

const { realtimeState, appendLocalVoiceAgentContextUpdate, isLocalVoiceAgentActive } = vi.hoisted(() => ({
  realtimeState: {
    started: false,
    session: null as Pick<VoiceSession, 'sendContextualUpdate' | 'sendTextMessage'> | null,
  },
  appendLocalVoiceAgentContextUpdate: vi.fn(),
  isLocalVoiceAgentActive: vi.fn((_sessionId: string) => true),
}));

vi.mock('@/realtime/RealtimeSession', () => ({
  getVoiceSession: () => realtimeState.session,
  isVoiceSessionStarted: () => realtimeState.started,
}));

vi.mock('@/voice/local/localVoiceEngine', () => ({
  isLocalVoiceAgentActive: (sessionId: string) => isLocalVoiceAgentActive(sessionId),
  appendLocalVoiceAgentContextUpdate: (sessionId: string, update: string) =>
    appendLocalVoiceAgentContextUpdate(sessionId, update),
}));

import { voiceHooks } from './voiceHooks';

describe('voiceHooks sink routing', () => {
  beforeEach(() => {
    appendLocalVoiceAgentContextUpdate.mockReset();
    isLocalVoiceAgentActive.mockReset();
    isLocalVoiceAgentActive.mockReturnValue(true);
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
      },
      sessionMessages: {
        ...state.sessionMessages,
        s1: { messages: [] },
      },
    }));
  });

  it('routes ready updates to the local agent when active and no remote voice session is started', () => {
    voiceHooks.onReady('s1');

    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      VOICE_AGENT_GLOBAL_SESSION_ID,
      expect.stringContaining('# Session ID: s1'),
    );
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(
      VOICE_AGENT_GLOBAL_SESSION_ID,
      expect.stringContaining('Coding assistant done working in session: s1'),
    );
  });

  it('prefers active remote voice session over local agent routing', () => {
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onReady('s1');

    expect(sendContextualUpdate).toHaveBeenCalledWith(expect.stringContaining('# Session ID: s1'));
    expect(sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('Coding assistant done working in session: s1'));
    expect(appendLocalVoiceAgentContextUpdate).not.toHaveBeenCalled();
  });

  it('does not route to agent when agent is inactive', () => {
    isLocalVoiceAgentActive.mockReturnValue(false);

    voiceHooks.onReady('s1');

    expect(appendLocalVoiceAgentContextUpdate).not.toHaveBeenCalled();
  });
});
