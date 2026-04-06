import { describe, expect, it } from 'vitest';

import { resolveVoiceContextSessionFromState } from './resolveVoiceContextSession';

describe('resolveVoiceContextSessionFromState', () => {
  it('prefers the cached visible session object over stale raw session state', () => {
    const state = {
      sessions: {
        s1: {
          id: 's1',
          active: true,
          updatedAt: 1,
          presence: 'online',
          metadata: {
            path: '/raw/path',
            homeDir: '/raw/home',
            name: 'raw name',
            machineId: 'raw-machine',
            summaryText: 'Raw summary',
          },
        },
      },
      sessionListViewData: [
        {
          type: 'session',
          session: {
            id: 's1',
            active: false,
            updatedAt: 99,
            presence: 'away',
            metadata: {
              path: '/cached/path',
              homeDir: '/cached/home',
              name: 'cached name',
              machineId: 'cached-machine',
              summaryText: 'Cached summary',
              summary: { text: 'Cached summary', updatedAt: 99 },
            },
          },
        },
      ],
    };

    const resolved = resolveVoiceContextSessionFromState('s1', state);

    expect(resolved).toMatchObject({
      id: 's1',
      active: false,
      updatedAt: 99,
      presence: 'away',
      metadata: {
        path: '/cached/path',
        homeDir: '/cached/home',
        name: 'cached name',
        machineId: 'cached-machine',
        summaryText: 'Cached summary',
        summary: { text: 'Cached summary', updatedAt: 99 },
      },
    });
  });
});
