import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

import {
  assertLocalVoiceAgentSupportedForQa,
  isHiddenVoiceQaConversationSessionId,
  resolveConfiguredVoiceQaProvider,
  syncLatestLocalVoiceQaResolvedSessions,
} from './voiceQaSessionResolution';

describe('voiceQaSessionResolution', () => {
  beforeEach(() => {
    storage.setState((current) => ({
      ...current,
      sessions: {
        s1: {
          id: 's1',
          metadata: {
            path: '/tmp/project-a',
          },
        },
      },
      sessionListRenderables: {
        s1: {
          id: 's1',
          updatedAt: 0,
          metadata: {
            path: '/tmp/project-a',
            systemSessionV1: {
              v: 1,
              key: 'voice_conversation',
              hidden: true,
            },
          },
        },
      },
      sessionListIndexByServerId: {
        'server-a': [
          { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
        ],
      },
      concurrentSessionListCacheByServerId: {},
    } as any));
  });

  it('prefers visible lookup hidden-session metadata over stale raw session metadata', () => {
    expect(isHiddenVoiceQaConversationSessionId('s1')).toBe(true);
  });

  it('normalizes the control session id before syncing latest QA resolution state', () => {
    const calls: Array<Readonly<{ targetSessionId: string; runtimeSessionId: string | null }>> = [];
    syncLatestLocalVoiceQaResolvedSessions(
      {
        getVoiceTargetState: () => ({ primaryActionSessionId: 'target-1', lastFocusedSessionId: 'target-2' }),
        getLocalBinding: () => null,
        qaStore: {
          getState: () => ({
            setResolvedSessions: (params: Readonly<{ targetSessionId: string; runtimeSessionId: string | null }>) => {
              calls.push(params);
            },
          }),
        },
      },
      ' __voice_agent__ ',
      null,
    );

    expect(calls).toEqual([
      {
        targetSessionId: 'target-1',
        runtimeSessionId: '__voice_agent__',
      },
    ]);
  });

  it('reads local conversation agent mode from the canonical provider envelope only', () => {
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
  });

  it('classifies a registered conversation provider by capability instead of a vendor id', () => {
    expect(resolveConfiguredVoiceQaProvider({
      voice: { providerId: 'happier.voice.elevenlabs/realtime-elevenlabs' },
    })).toBe('realtime_conversation');
  });
});
