import { describe, expect, it } from 'vitest';

import { collectVoiceSessionRows } from './voiceSessionRows';

describe('collectVoiceSessionRows', () => {
  it('excludes the hidden Voice History carrier when only a session-list projection has its owner metadata', () => {
    const rows = collectVoiceSessionRows({
      sessions: {
        visible: {
          id: 'visible',
          updatedAt: 20,
          active: true,
          presence: 'online',
          metadata: {
            summary: { text: 'Visible session' },
          },
        },
      },
      sessionListRenderables: {
        voice_history: {
          id: 'voice_history',
          updatedAt: 30,
          active: false,
          presence: 'offline',
          metadata: {
            hiddenSystemSession: true,
          },
        },
      },
      sessionListIndexByServerId: {
        server: [{
          type: 'session',
          sessionId: 'voice_history',
          serverId: 'server',
          serverName: 'Server',
        }],
      },
    });

    expect(rows.map((row) => row.id)).toEqual(['visible']);
  });

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
