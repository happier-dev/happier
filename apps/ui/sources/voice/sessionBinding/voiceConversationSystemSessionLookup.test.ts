import { describe, expect, it } from 'vitest';

import { findReusableVoiceConversationRuntimeSessionId, findVoiceConversationSessionId } from './voiceConversationSystemSessionLookup';

describe('voiceConversationSystemSessionLookup', () => {
  it('finds voice conversation system sessions via canonical session metadata', () => {
    const state = {
      sessions: {
        voice_cached: {
          id: 'voice_cached',
          active: true,
          updatedAt: 7,
          metadata: {
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            summary: { text: 'Lookup voice session' },
          },
        },
      },
    };

    expect(findReusableVoiceConversationRuntimeSessionId(state)).toBe('voice_cached');
    expect(findVoiceConversationSessionId(state)).toBe('voice_cached');
  });

  it('accepts trimmed voice conversation system-session keys', () => {
    const state = {
      sessions: {
        voice_cached: {
          id: 'voice_cached',
          active: true,
          updatedAt: 7,
          metadata: {
            systemSessionV1: { v: 1, key: ' voice_conversation ', hidden: true },
            summary: { text: 'Lookup voice session' },
          },
        },
      },
    };

    expect(findReusableVoiceConversationRuntimeSessionId(state)).toBe('voice_cached');
    expect(findVoiceConversationSessionId(state)).toBe('voice_cached');
  });
});
