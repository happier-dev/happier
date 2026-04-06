import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

import { isHiddenVoiceQaConversationSessionId } from './voiceQaSessionResolution';

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
      sessionListViewData: [
        {
          type: 'session',
          session: {
            id: 's1',
            metadata: {
              systemSessionV1: {
                v: 1,
                key: 'voice_conversation',
                hidden: true,
              },
            },
          },
        },
      ],
    } as any));
  });

  it('prefers cached visible hidden-session metadata over stale raw session metadata', () => {
    expect(isHiddenVoiceQaConversationSessionId('s1')).toBe(true);
  });
});
