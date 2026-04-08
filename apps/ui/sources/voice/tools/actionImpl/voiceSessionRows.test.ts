import { describe, expect, it } from 'vitest';

import { collectVoiceSessionRows } from './voiceSessionRows';

describe('collectVoiceSessionRows', () => {
  it('ignores stale renderable-only rows and keeps canonical session rows', () => {
    const rows = collectVoiceSessionRows({
      sessions: {
        s1: {
          id: 's1',
          updatedAt: 50,
          active: true,
          presence: 'online',
          metadata: {
            summary: { text: 'Direct summary' },
            path: '/Users/alice/project-one/session-1',
            homeDir: '/Users/alice',
          },
        },
      },
      sessionListRenderables: {
        s2: {
          id: 's2',
          updatedAt: 60,
          active: true,
          presence: 'away',
          metadata: {
            summaryText: 'Visible active session',
            path: '/Users/alice/project-two/session-2',
          },
        },
        stale_only: {
          id: 'stale_only',
          updatedAt: 999,
          activeAt: 999,
          createdAt: 998,
          seq: 1,
          metadataVersion: 1,
          agentStateVersion: 1,
          thinking: false,
          thinkingAt: 0,
          active: false,
          presence: 'offline',
          metadata: {
            summaryText: 'Renderable-only row',
            path: '/tmp/stale-only',
          },
        },
      },
      sessionListIndexByServerId: {
        'active-server': [
          {
            type: 'session',
            sessionId: 's2',
            serverId: 'active-server',
            serverName: 'Active',
          },
        ],
      },
      concurrentSessionListCacheByServerId: {
        'side-server': {
          serverName: 'Side',
          sessions: {
            s3: {
              id: 's3',
              updatedAt: 70,
              active: false,
              presence: 'offline',
              metadata: {
                summaryText: 'Cached side-server session',
                path: '/Users/alice/project-three/session-3',
              },
            },
          },
        },
      },
    });

    expect(rows.map((row) => row.id)).toEqual(['s3', 's2', 's1']);
    expect(rows.find((row) => row.id === 'stale_only')).toBeUndefined();
  });
});
