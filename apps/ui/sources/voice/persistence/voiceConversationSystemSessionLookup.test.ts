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

  it('does not treat the retired voice_carrier system-session key as canonical', () => {
    const state = {
      sessions: {
        legacy_voice_carrier: {
          id: 'legacy_voice_carrier',
          active: true,
          updatedAt: 7,
          metadata: {
            systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
          },
        },
      },
    };

    expect(findReusableVoiceConversationRuntimeSessionId(state)).toBeNull();
    expect(findVoiceConversationSessionId(state)).toBeNull();
  });

  it('prefers visible lookup metadata over stale raw session metadata when resolving reusable sessions', () => {
    const state = {
      sessions: {
        voice_cached: {
          id: 'voice_cached',
          active: true,
          updatedAt: 7,
          metadata: {
            machineId: 'machine-stale',
            path: '/tmp/stale',
          },
        },
      },
      sessionListRenderables: {
        voice_cached: {
          id: 'voice_cached',
          active: true,
          updatedAt: 7,
          metadata: {
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            machineId: 'machine-1',
            path: '/tmp/canonical',
          },
        },
      },
      sessionListIndexByServerId: {
        'server-1': [
          { type: 'session', sessionId: 'voice_cached', serverId: 'server-1', serverName: 'Server 1' },
        ],
      },
    };

    expect(findReusableVoiceConversationRuntimeSessionId(state)).toBe('voice_cached');
    expect(findVoiceConversationSessionId(state)).toBe('voice_cached');
  });
});
