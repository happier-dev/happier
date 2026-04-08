import { describe, expect, it } from 'vitest';

import { getVoiceContextFormatterPrefs } from './voiceContextPrefs';

describe('getVoiceContextFormatterPrefs', () => {
  it('treats padded tracked session ids as tracked when resolving voice context prefs', () => {
    const prefs = getVoiceContextFormatterPrefs({
      settings: {
        voice: {
          privacy: {
            shareSessionSummary: true,
            shareRecentMessages: true,
            recentMessagesCount: 4,
            shareToolNames: true,
            shareToolArgs: true,
            shareFilePaths: false,
          },
          ui: {
            updates: {
              activeSession: 'snippets',
              otherSessions: 'activity',
            },
          },
        },
      },
      sessionId: ' session-1 ',
      trackedSessionIds: [' session-1 '],
    });

    expect(prefs.voiceShareSessionSummary).toBe(true);
    expect(prefs.voiceShareRecentMessages).toBe(true);
  });
});
