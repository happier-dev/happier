import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

import {
  isHiddenVoiceQaConversationSessionId,
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
});
