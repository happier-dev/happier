import { describe, expect, it } from 'vitest';

import {
  findReusableVoiceConversationRuntimeSessionId,
  findVoiceConversationSessionId,
  isVoiceConversationCustodySessionMetadata,
  resolveVoiceConversationSessionMetadataFromState,
} from './voiceConversationSystemSessionLookup';

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

  it('reads the released voice_carrier system-session key during the bounded migration window', () => {
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

    expect(findReusableVoiceConversationRuntimeSessionId(state)).toBe('legacy_voice_carrier');
    expect(findVoiceConversationSessionId(state)).toBe('legacy_voice_carrier');
  });

  it('admits retired Voice sessions only to the custody classifier, never reuse lookup', () => {
    const metadata = {
      systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
    };
    const state = {
      sessions: {
        retired_voice: {
          id: 'retired_voice',
          active: true,
          updatedAt: 7,
          metadata,
        },
      },
    };

    expect(isVoiceConversationCustodySessionMetadata(metadata)).toBe(true);
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

  it('preserves canonical Voice markers when preferred session-list metadata is flattened', () => {
    const state = {
      sessions: {
        voice_cached: {
          id: 'voice_cached',
          active: true,
          updatedAt: 7,
          metadata: {
            machineId: 'machine-stale',
            path: '/tmp/stale',
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            voiceConversationScopeV1: {
              v: 1,
              kind: 'session_root',
              sessionRootId: 'root-session',
            },
          },
        },
      },
      sessionListRenderables: {
        voice_cached: {
          id: 'voice_cached',
          active: true,
          updatedAt: 7,
          metadata: {
            machineId: 'machine-current',
            path: '/tmp/current',
            hiddenSystemSession: true,
          },
        },
      },
      sessionListIndexByServerId: {
        'server-1': [
          { type: 'session', sessionId: 'voice_cached', serverId: 'server-1', serverName: 'Server 1' },
        ],
      },
    };

    expect(resolveVoiceConversationSessionMetadataFromState(state, 'voice_cached')).toEqual({
      machineId: 'machine-current',
      path: '/tmp/current',
      systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      voiceConversationScopeV1: {
        v: 1,
        kind: 'session_root',
        sessionRootId: 'root-session',
      },
      hiddenSystemSession: true,
    });
    expect(findReusableVoiceConversationRuntimeSessionId(state)).toBe('voice_cached');
  });

  it('uses the layout-v1 owner view and never a private-looking shared Voice marker', () => {
    const ownerSession = {
      id: 'voice_owner',
      active: true,
      updatedAt: 7,
      metadataLayoutVersion: 1,
      metadata: {
        v: 1,
        systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
      },
      ownerMetadataView: {
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
    };
    const missingOwnerSession = {
      id: 'voice_missing_owner',
      active: true,
      updatedAt: 8,
      metadataLayoutVersion: 1,
      metadata: {
        v: 1,
        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
      },
      ownerMetadataView: null,
    };

    expect(findVoiceConversationSessionId({
      sessions: {
        voice_owner: ownerSession,
        voice_missing_owner: missingOwnerSession,
      },
    })).toBe('voice_owner');
  });
});
