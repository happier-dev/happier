import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit';

import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { resetVoiceQaStoreForTests, useVoiceQaStore } from './voiceQaStore';

import {
  assertLocalVoiceAgentSupportedForQa,
  isHiddenVoiceQaConversationSessionId,
  resolveConfiguredVoiceQaProvider,
  syncLatestLocalVoiceQaResolvedSessions,
  resolveEffectiveVoiceQaSessionAddress,
} from './voiceQaSessionResolution';

// The hydrated `sessions` entry is the active Home's entity, so its canonical row must live
// under the same Home; a bare session id resolves through that address.
const activeServerId = getActiveServerSnapshot().serverId;
const initialStorage = storage.getState();
const initialTarget = useVoiceTargetStore.getState();

describe('voiceQaSessionResolution', () => {
  beforeEach(() => {
    storage.setState((current) => ({
      ...current,
      sessions: {
        s1: createSessionFixture({
          id: 's1',
          metadata: { ...createSessionFixture().metadata!,
            path: '/tmp/project-a',
          },
        }),
      },
      sessionListRowsByServerId: {
        [activeServerId]: {
          s1: createSessionListRenderableSessionFixture({
            id: 's1',
            updatedAt: 0,
            metadata: { ...createSessionListRenderableSessionFixture().metadata,
              path: '/tmp/project-a',
              ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
            },
          }),
        },
      },
      ordinarySessionListMembershipByServerId: { [activeServerId]: ['s1'] },
      sessionListIndexByServerId: {
        [activeServerId]: [
          { type: 'session', sessionId: 's1', serverId: activeServerId, serverName: 'Server A' },
        ],
      },
      concurrentSessionListCacheByServerId: {},
    }));
    resetVoiceQaStoreForTests();
  });

  afterEach(() => {
    storage.setState(initialStorage, true);
    useVoiceTargetStore.setState(initialTarget, true);
    resetVoiceQaStoreForTests();
  });

  it('prefers visible lookup hidden-session metadata over stale raw session metadata', () => {
    expect(isHiddenVoiceQaConversationSessionId('s1')).toBe(true);
  });

  it('normalizes the control session id before syncing latest QA resolution state', () => {
    const targetSessionAddress = { serverId: 'server-b', sessionId: 'target-1' };
    useVoiceTargetStore.setState({ primaryActionSessionAddress: targetSessionAddress, lastFocusedSessionAddress: null });
    syncLatestLocalVoiceQaResolvedSessions(
      {
        getVoiceTargetState: useVoiceTargetStore.getState,
        getLocalBinding: (controlSessionId) => voiceConversationBindingResolver.resolveByControlSessionId({
          controlSessionId,
          adapterId: 'local_conversation',
        }),
        qaStore: useVoiceQaStore,
      },
      ' __voice_agent__ ',
      null,
    );

    expect(useVoiceQaStore.getState()).toMatchObject({
        targetSessionAddress,
        runtimeSessionId: '__voice_agent__',
    });
  });

  it('keeps an explicit Global binding instead of reviving the last focused target', () => {
    const staleTarget = { serverId: 'server-b', sessionId: 'old-target' };
    useVoiceTargetStore.setState({ primaryActionSessionAddress: staleTarget, lastFocusedSessionAddress: staleTarget });
    syncLatestLocalVoiceQaResolvedSessions(
      { getVoiceTargetState: useVoiceTargetStore.getState, qaStore: useVoiceQaStore },
      '__voice_agent__',
      {
        adapterId: 'local_conversation', controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-carrier',
        conversationSessionAddress: { serverId: activeServerId, sessionId: 'voice-carrier' },
        targetSessionAddress: null, transcriptMode: 'native_session', updatedAt: 1,
      },
    );
    expect(useVoiceQaStore.getState()).toMatchObject({
      targetSessionAddress: null, runtimeSessionId: 'voice-carrier',
    });
  });

  it('rejects an ambiguous bare target', () => {
    storage.setState({ sessionListIndexByServerId: {
      a: [{ type: 'session', sessionId: 'same', serverId: 'a', serverName: 'A' }],
      b: [{ type: 'session', sessionId: 'same', serverId: 'b', serverName: 'B' }],
    } });
    useVoiceTargetStore.setState({
      primaryActionSessionAddress: { serverId: 'a', sessionId: 'same' },
      lastFocusedSessionAddress: null,
    });
    expect(() => resolveEffectiveVoiceQaSessionAddress('same', useVoiceTargetStore.getState))
      .toThrow('voice_qa_target_session_unresolved');
  });

  it('reads local conversation agent mode from the canonical provider envelope, not a stray top-level field', () => {
    expect(() => assertLocalVoiceAgentSupportedForQa({
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: {
            schemaVersion: 1,
            config: { conversationMode: 'agent' },
          },
        },
      },
    })).not.toThrow();
    // A top-level mode was never a stored shape; only the provider config decides.
    expect(() => assertLocalVoiceAgentSupportedForQa({
      voice: {
        providerId: 'local_conversation',
        conversationMode: 'agent',
        providers: {
          local_conversation: {
            schemaVersion: 1,
            config: { conversationMode: 'direct_session' },
          },
        },
      },
    })).toThrow('voice_qa_local_agent_requires_local_conversation_agent_mode');
  });

  it('classifies a registered conversation provider by capability instead of a vendor id', () => {
    expect(resolveConfiguredVoiceQaProvider({
      voice: { providerId: 'happier.voice.elevenlabs/realtime-elevenlabs' },
    })).toBe('realtime_conversation');
  });
});
