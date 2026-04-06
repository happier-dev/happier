import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

import { resolveVoiceSessionLabel } from './resolveVoiceSessionLabel';

describe('resolveVoiceSessionLabel', () => {
  beforeEach(() => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {},
      sessionListViewData: [],
      sessionListViewDataByServerId: {},
    }));
  });

  it('prefers the visible cached session metadata over stale raw session metadata', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        s_matrix: {
          id: 's_matrix',
          metadata: {
            summaryText: 'Raw session summary!',
            path: '/Users/alice/project-alpha',
          },
        },
      },
      sessionListViewData: [
        {
          type: 'session',
          session: {
            id: 's_matrix',
            updatedAt: 42,
            metadata: {
              summaryText: 'Cached session summary',
              path: '/Users/alice/project-alpha',
            },
          },
        },
      ],
    }));

    expect(
      resolveVoiceSessionLabel('s_matrix', {
        voiceShareSessionSummary: true,
        voiceShareFilePaths: true,
      }),
    ).toBe('Cached session summary');
  });
});
