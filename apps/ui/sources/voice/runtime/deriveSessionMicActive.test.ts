import { describe, expect, it } from 'vitest';

import type { VoiceAssistantScope } from '@/voice/runtime/voiceTargetStore';
import type { VoiceSessionStatus } from '@/voice/session/types';

import { deriveSessionMicActive } from './deriveSessionMicActive';

describe('deriveSessionMicActive', () => {
  it('returns false when voice is disconnected', () => {
    expect(
      deriveSessionMicActive({
        voiceStatus: 'disconnected',
        scope: 'global',
        sessionId: 's1',
        primaryActionSessionId: 's1',
        lastFocusedSessionId: 's1',
      }),
    ).toBe(false);
  });

  it('returns true for session scope when voice is active', () => {
    expect(
      deriveSessionMicActive({
        voiceStatus: 'connected' satisfies VoiceSessionStatus,
        scope: 'session' satisfies VoiceAssistantScope,
        sessionId: 's1',
        primaryActionSessionId: null,
        lastFocusedSessionId: null,
      }),
    ).toBe(true);
  });

  it('returns true for global scope when primary action session matches', () => {
    expect(
      deriveSessionMicActive({
        voiceStatus: 'connected' satisfies VoiceSessionStatus,
        scope: 'global' satisfies VoiceAssistantScope,
        sessionId: 's1',
        primaryActionSessionId: 's1',
        lastFocusedSessionId: 's2',
      }),
    ).toBe(true);
  });

  it('returns true for global scope when primary action session is unset and last focused matches', () => {
    expect(
      deriveSessionMicActive({
        voiceStatus: 'connected' satisfies VoiceSessionStatus,
        scope: 'global' satisfies VoiceAssistantScope,
        sessionId: 's1',
        primaryActionSessionId: null,
        lastFocusedSessionId: 's1',
      }),
    ).toBe(true);
  });

  it('returns false for global scope when targeting a different session', () => {
    expect(
      deriveSessionMicActive({
        voiceStatus: 'connected' satisfies VoiceSessionStatus,
        scope: 'global' satisfies VoiceAssistantScope,
        sessionId: 's1',
        primaryActionSessionId: 's2',
        lastFocusedSessionId: 's1',
      }),
    ).toBe(false);
  });
});

