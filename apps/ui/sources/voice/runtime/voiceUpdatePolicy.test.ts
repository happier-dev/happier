import { describe, expect, it } from 'vitest';

import { resolveVoiceSessionUpdatePolicy } from '@/voice/runtime/voiceUpdatePolicy';

describe('voiceUpdatePolicy', () => {
  it('treats tracked sessions as activeSession policy level', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's1',
      trackedSessionIds: ['s1'],
      settings: {
        voice: {
          ui: {
            updates: {
              activeSession: 'snippets',
              otherSessions: 'none',
              snippetsMaxMessages: 5,
              includeUserMessagesInSnippets: true,
              otherSessionsSnippetsMode: 'never',
            },
          },
        },
      },
    });

    expect(policy.isTrackedSession).toBe(true);
    expect(policy.level).toBe('snippets');
    expect(policy.snippetsMaxMessages).toBe(5);
    expect(policy.includeUserMessagesInSnippets).toBe(true);
  });

  it('downgrades otherSessions snippets to summaries unless otherSessionsSnippetsMode is auto', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's2',
      trackedSessionIds: ['s1'],
      settings: {
        voice: {
          ui: {
            updates: {
              activeSession: 'none',
              otherSessions: 'snippets',
              otherSessionsSnippetsMode: 'on_demand_only',
            },
          },
        },
      },
    });

    expect(policy.isTrackedSession).toBe(false);
    expect(policy.level).toBe('summaries');
  });

  it('allows otherSessions snippets when otherSessionsSnippetsMode is auto', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's2',
      trackedSessionIds: ['s1'],
      settings: {
        voice: {
          ui: {
            updates: {
              otherSessions: 'snippets',
              otherSessionsSnippetsMode: 'auto',
            },
          },
        },
      },
    });

    expect(policy.isTrackedSession).toBe(false);
    expect(policy.level).toBe('snippets');
  });
});
