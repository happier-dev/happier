import { describe, expect, it } from 'vitest';

import { resolveVoiceSessionRef } from './sessionReference';

describe('resolveVoiceSessionRef', () => {
  it('prefers the visible lookup session metadata over stale raw metadata for the same session id', () => {
    const result = resolveVoiceSessionRef('s_matrix', {
      sessions: {
        s_matrix: {
          id: 's_matrix',
          metadata: {
            summaryText: 'Session QA Voice Matrix!',
            path: '/Users/alice/project-alpha',
          },
        },
      },
      sessionListRenderables: {
        s_matrix: {
          id: 's_matrix',
          updatedAt: 42,
          metadata: {
            summaryText: 'Session QA Voice Matrix',
            path: '/Users/alice/project-alpha',
          },
        },
      },
      sessionListIndexByServerId: {
        'server-a': [
          { type: 'session', sessionId: 's_matrix', serverId: 'server-a', serverName: 'Server A' },
        ],
      },
      concurrentSessionListCacheByServerId: {},
    });

    expect(result).toEqual({
      id: 's_matrix',
      title: 'Session QA Voice Matrix',
      locationLabel: 'project-alpha',
      serverId: 'server-a',
      serverName: 'Server A',
    });
  });
});
