import { describe, it, expect, vi, beforeEach } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { Message } from '@/sync/domains/messages/messageTypes';

const { fakeSink, getVoiceContextSinkForSession } = vi.hoisted(() => {
  const fakeSink = {
    sendTextMessage: vi.fn(),
    sendContextualUpdate: vi.fn(),
  };
  return {
    fakeSink,
    getVoiceContextSinkForSession: vi.fn(() => fakeSink),
  };
});

vi.mock('@/voice/context/getVoiceContextSinkForSession', () => ({
  getVoiceContextSinkForSession,
}));

import { voiceHooks } from './voiceHooks';

function createUserTextMessage(text: string, createdAt: number): Message {
  return {
    kind: 'user-text',
    id: `msg_${createdAt}`,
    localId: null,
    createdAt,
    text,
  };
}

function seedSession(sessionId: string) {
  storage.setState((state: any) => ({
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: {
        id: sessionId,
        metadata: { path: '/tmp/project', host: 'localhost', summary: { text: 'Summary', updatedAt: Date.now() } },
        presence: 'online',
      },
    },
    sessionMessages: {
      ...state.sessionMessages,
      [sessionId]: {
        messages: [],
      },
    },
  }));
}

describe('voiceHooks privacy settings', () => {
  beforeEach(() => {
    fakeSink.sendTextMessage.mockReset();
    fakeSink.sendContextualUpdate.mockReset();
    getVoiceContextSinkForSession.mockClear();
    storage.setState((s: any) => ({ ...s, settings: { ...settingsDefaults } }));
    seedSession('s1');
  });

  it('does not forward permission requests when voiceSharePermissionRequests is false', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: { ...s.settings, voiceSharePermissionRequests: false },
    }));

    voiceHooks.onPermissionRequested('s1', 'r1', 'rm', { path: '/tmp' });
    expect(getVoiceContextSinkForSession).not.toHaveBeenCalled();
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalled();
  });

  it('forwards permission requests when voiceSharePermissionRequests is true', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: { ...s.settings, voiceSharePermissionRequests: true },
    }));

    voiceHooks.onPermissionRequested('s1', 'r1', 'execute', { secret: 'do_not_leak' });

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('<request_id>r1</request_id>'),
    );
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith(
      's1',
      expect.stringContaining('do_not_leak'),
    );
  });

  it('does not forward message updates when voiceShareRecentMessages is false', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: { ...s.settings, voiceShareRecentMessages: false },
    }));

    voiceHooks.onMessages('s1', [createUserTextMessage('hi', 1)]);
    expect(getVoiceContextSinkForSession).not.toHaveBeenCalled();
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalled();
  });

  it('forwards message updates when voiceShareRecentMessages is true', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: { ...s.settings, voiceShareRecentMessages: true },
    }));

    const messages = [createUserTextMessage('Hello from user', 1)];
    voiceHooks.onMessages('s1', messages);

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('New messages in session: s1'),
    );
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledWith('s1', expect.stringContaining('Hello from user'));
  });
});
