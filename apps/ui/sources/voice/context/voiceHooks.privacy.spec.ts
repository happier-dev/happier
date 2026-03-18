import { describe, it, expect, vi, beforeEach } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

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

describe('voiceHooks privacy settings (opt-out defaults)', () => {
  beforeEach(() => {
    fakeSink.sendTextMessage.mockReset();
    fakeSink.sendContextualUpdate.mockReset();
    getVoiceContextSinkForSession.mockClear();
    storage.setState((s: any) => ({ ...s, settings: { ...settingsDefaults } }));
    seedSession('s1');
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');
  });

  it('does not forward permission requests when sharePermissionRequests is false', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: {
        ...s.settings,
        voice: {
          ...s.settings.voice,
          privacy: {
            ...s.settings.voice.privacy,
            sharePermissionRequests: false,
          },
        },
      },
    }));

    (voiceHooks as any).onAgentRequest('s1', 'r1', 'permission', 'rm', { path: '/tmp' });
    expect(getVoiceContextSinkForSession).not.toHaveBeenCalled();
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalled();
  });

  it('redacts tool args in permission requests by default', () => {
    (voiceHooks as any).onAgentRequest('s1', 'r1', 'permission', 'execute', { secret: 'do_not_leak' });

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('<request_id>r1</request_id>'),
    );
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<tool_args_redacted>true</tool_args_redacted>'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith('s1', expect.stringContaining('do_not_leak'));
  });

  it('still redacts tool args when a raw voice privacy blob tries to enable shareToolArgs', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: {
        ...s.settings,
        voice: {
          ...s.settings.voice,
          privacy: {
            ...s.settings.voice.privacy,
            shareToolArgs: true,
          },
        },
      },
    }));

    (voiceHooks as any).onAgentRequest('s1', 'r1', 'permission', 'execute', { secret: 'do_not_leak' });

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<tool_args_redacted>true</tool_args_redacted>'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith('s1', expect.stringContaining('do_not_leak'));
  });

  it('forwards user-action requests with question details and answer guidance', () => {
    (voiceHooks as any).onAgentRequest(
      's1',
      'req_question',
      'user_action',
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Confirm',
            question: 'Continue with the deployment?',
            multiSelect: false,
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
    );

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<request_kind>user_action</request_kind>'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('Continue with the deployment?'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('answerUserActionRequest'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith('s1', expect.stringContaining('processPermissionRequest'));
  });

  it('keeps non-AskUserQuestion user-action requests actionable when tool args are redacted', () => {
    (voiceHooks as any).onAgentRequest(
      's1',
      'req_exit_plan',
      'user_action',
      'ExitPlanMode',
      { plan: 'Review changes under /Users/alice/SecretRepo before exiting plan mode.' },
    );

    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<request_kind>user_action</request_kind>'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('approve, reject, or request changes'));
    expect(fakeSink.sendTextMessage).toHaveBeenCalledWith('s1', expect.stringContaining('<request_payload_redacted>true</request_payload_redacted>'));
    expect(fakeSink.sendTextMessage).not.toHaveBeenCalledWith('s1', expect.stringContaining('/Users/alice/SecretRepo'));
  });

  it('still forwards activity-only message updates when shareRecentMessages is false (no transcript content)', () => {
    storage.setState((s: any) => ({
      ...s,
      settings: {
        ...s.settings,
        voice: {
          ...s.settings.voice,
          privacy: {
            ...s.settings.voice.privacy,
            shareRecentMessages: false,
          },
        },
      },
    }));

    voiceHooks.onMessages('s1', [createUserTextMessage('hi', 1)]);
    expect(getVoiceContextSinkForSession).toHaveBeenCalledWith('s1');
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalled();
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalledWith('s1', expect.stringContaining('hi'));
  });

  it('returns a global boot prompt when voice starts without a session id', () => {
    expect(() => voiceHooks.onVoiceStarted('')).not.toThrow();
    const prompt = voiceHooks.onVoiceStarted('');
    expect(prompt).toContain('<session_context>none</session_context>');
  });

  it('returns a safe boot prompt when voice starts with an unknown session id', () => {
    expect(() => voiceHooks.onVoiceStarted('missing_session')).not.toThrow();
    const prompt = voiceHooks.onVoiceStarted('missing_session');
    expect(prompt).toContain('<session_not_found>true</session_not_found>');
  });

  it('does not mark activity-only sessions as shown, so later tracking can emit full context', () => {
    // Ensure s1 is not tracked, so it uses otherSessions update level (default: activity).
    useVoiceTargetStore.getState().setTrackedSessionIds([]);

    voiceHooks.onReady('s1');
    // activity-only sessions should not emit a full session context block.
    expect(fakeSink.sendContextualUpdate).not.toHaveBeenCalledWith('s1', expect.stringContaining('# Session: Summary'));

    // Now track the session and ensure full context can be emitted.
    useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);
    voiceHooks.onReady('s1');
    expect(fakeSink.sendContextualUpdate).toHaveBeenCalledWith('s1', expect.stringContaining('# Session: Summary'));
  });
});
