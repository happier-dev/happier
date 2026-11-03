import { describe, expect, it } from 'vitest';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import {
  isVoiceConversationSystemSessionMetadata,
  isVoiceConversationCustodySessionMetadata,
  resolveVoiceConversationSessionMetadataFromState,
} from './voiceConversationSystemSessionLookup';

describe('voiceConversationSystemSessionLookup', () => {
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

    expect(isVoiceConversationSystemSessionMetadata(resolveVoiceConversationSessionMetadataFromState(state, 'voice_cached'))).toBe(true);
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

    expect(isVoiceConversationSystemSessionMetadata(resolveVoiceConversationSessionMetadataFromState(state, 'legacy_voice_carrier'))).toBe(true);
  });

  it('admits retired Voice sessions only to the custody classifier', () => {
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
    expect(isVoiceConversationSystemSessionMetadata(resolveVoiceConversationSessionMetadataFromState(state, 'retired_voice'))).toBe(false);
  });

  it('prefers visible lookup metadata over stale raw session metadata', () => {
    const serverId = getActiveServerSnapshot().serverId;
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
      sessionListRowsByServerId: {
        [serverId]: {
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
      },
      ordinarySessionListMembershipByServerId: { [serverId]: ['voice_cached'] },
      sessionListIndexByServerId: {
        [serverId]: [
          { type: 'session', sessionId: 'voice_cached', serverId, serverName: 'Active' },
        ],
      },
    };

    expect(resolveVoiceConversationSessionMetadataFromState(state, 'voice_cached')).toMatchObject({
      machineId: 'machine-1', path: '/tmp/canonical',
    });
    expect(isVoiceConversationSystemSessionMetadata(resolveVoiceConversationSessionMetadataFromState(state, 'voice_cached'))).toBe(true);
  });

  it('preserves canonical Voice markers when preferred session-list metadata is flattened', () => {
    const serverId = getActiveServerSnapshot().serverId;
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
      sessionListRowsByServerId: {
        [serverId]: {
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
      },
      ordinarySessionListMembershipByServerId: { [serverId]: ['voice_cached'] },
      sessionListIndexByServerId: {
        [serverId]: [
          { type: 'session', sessionId: 'voice_cached', serverId, serverName: 'Active' },
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
    expect(isVoiceConversationSystemSessionMetadata(resolveVoiceConversationSessionMetadataFromState(state, 'voice_cached'))).toBe(true);
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

    const state = {
      sessions: {
        voice_owner: ownerSession,
        voice_missing_owner: missingOwnerSession,
      },
    };
    expect(isVoiceConversationSystemSessionMetadata(resolveVoiceConversationSessionMetadataFromState(state, 'voice_owner'))).toBe(true);
    expect(isVoiceConversationSystemSessionMetadata(resolveVoiceConversationSessionMetadataFromState(state, 'voice_missing_owner'))).toBe(false);
  });
});
