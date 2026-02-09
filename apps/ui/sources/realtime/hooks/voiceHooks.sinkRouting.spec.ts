import { beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { VoiceSession } from '@/realtime/types';

const { realtimeState, appendLocalVoiceMediatorContextUpdate, isLocalVoiceMediatorActive } = vi.hoisted(() => ({
  realtimeState: {
    started: false,
    session: null as Pick<VoiceSession, 'sendContextualUpdate' | 'sendTextMessage'> | null,
  },
  appendLocalVoiceMediatorContextUpdate: vi.fn(),
  isLocalVoiceMediatorActive: vi.fn(() => true),
}));

vi.mock('@/realtime/RealtimeSession', () => ({
  getVoiceSession: () => realtimeState.session,
  isVoiceSessionStarted: () => realtimeState.started,
}));

vi.mock('@/voice/local/localVoiceEngine', () => ({
  isLocalVoiceMediatorActive: (sessionId: string) => isLocalVoiceMediatorActive(sessionId),
  appendLocalVoiceMediatorContextUpdate: (sessionId: string, update: string) =>
    appendLocalVoiceMediatorContextUpdate(sessionId, update),
}));

import { voiceHooks } from './voiceHooks';

describe('voiceHooks sink routing', () => {
  beforeEach(() => {
    appendLocalVoiceMediatorContextUpdate.mockReset();
    isLocalVoiceMediatorActive.mockReset();
    isLocalVoiceMediatorActive.mockReturnValue(true);
    realtimeState.started = false;
    realtimeState.session = null;
    voiceHooks.onVoiceStopped();

    storage.setState((state: any) => ({
      ...state,
      settings: {
        ...settingsDefaults,
        voiceProviderId: 'local_openai_stt_tts',
        voiceLocalConversationMode: 'mediator',
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

  it('routes ready updates to the local mediator when active and no remote voice session is started', () => {
    voiceHooks.onReady('s1');

    expect(appendLocalVoiceMediatorContextUpdate).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('# Session ID: s1'),
    );
    expect(appendLocalVoiceMediatorContextUpdate).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('Claude Code done working in session: s1'),
    );
  });

  it('prefers active remote voice session over local mediator routing', () => {
    const sendContextualUpdate = vi.fn();
    const sendTextMessage = vi.fn();
    realtimeState.started = true;
    realtimeState.session = { sendContextualUpdate, sendTextMessage };

    voiceHooks.onReady('s1');

    expect(sendContextualUpdate).toHaveBeenCalledWith(expect.stringContaining('# Session ID: s1'));
    expect(sendTextMessage).toHaveBeenCalledWith(expect.stringContaining('Claude Code done working in session: s1'));
    expect(appendLocalVoiceMediatorContextUpdate).not.toHaveBeenCalled();
  });

  it('does not route to mediator when mediator is inactive', () => {
    isLocalVoiceMediatorActive.mockReturnValue(false);

    voiceHooks.onReady('s1');

    expect(appendLocalVoiceMediatorContextUpdate).not.toHaveBeenCalled();
  });
});
