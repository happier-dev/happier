import { describe, expect, it } from 'vitest';

import { resolveVoiceSessionRef } from './sessionReference';

describe('resolveVoiceSessionRef', () => {
  it('prefers the visible cached session metadata over stale raw metadata for the same session id', () => {
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
      sessionListViewData: [
        {
          type: 'session',
          session: {
            id: 's_matrix',
            updatedAt: 42,
            metadata: {
              summaryText: 'Session QA Voice Matrix',
              path: '/Users/alice/project-alpha',
            },
          },
        },
      ],
    });

    expect(result).toEqual({
      id: 's_matrix',
      title: 'Session QA Voice Matrix',
      locationLabel: 'project-alpha',
    });
  });
});
