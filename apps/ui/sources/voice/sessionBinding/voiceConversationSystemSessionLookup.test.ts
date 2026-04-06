import { describe, expect, it } from 'vitest';

import { findReusableVoiceConversationRuntimeSessionId, findVoiceConversationSessionId } from './voiceConversationSystemSessionLookup';

describe('voiceConversationSystemSessionLookup', () => {
  it('prefers cached visible system-session metadata over stale raw metadata when finding reusable runtime sessions', () => {
    const state = {
      sessions: {
        voice_cached: {
          id: 'voice_cached',
          active: true,
          updatedAt: 7,
          metadata: {
            name: 'stale raw voice session',
          },
        },
      },
      sessionListViewData: [
        {
          type: 'session',
          session: {
            id: 'voice_cached',
            active: true,
            updatedAt: 7,
            metadata: {
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
              summary: { text: 'Cached voice session' },
            },
          },
        },
      ],
    };

    expect(findReusableVoiceConversationRuntimeSessionId(state)).toBe('voice_cached');
    expect(findVoiceConversationSessionId(state)).toBe('voice_cached');
  });
});
