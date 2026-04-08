import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

import { resolveVoiceSessionLabel } from './resolveVoiceSessionLabel';

describe('resolveVoiceSessionLabel', () => {
  beforeEach(() => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {},
      sessionListRenderables: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
    }));
  });

  it('prefers the visible lookup session metadata over stale raw session metadata', () => {
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
      sessionListRenderables: {
        s_matrix: {
          id: 's_matrix',
          updatedAt: 42,
          metadata: {
            summaryText: 'Lookup session summary',
            path: '/Users/alice/project-alpha',
          },
        },
      },
      sessionListIndexByServerId: {
        'active-server': [
          {
            type: 'session',
            sessionId: 's_matrix',
            serverId: 'active-server',
            serverName: 'Active',
          },
        ],
      },
    }));

    expect(
      resolveVoiceSessionLabel('s_matrix', {
        voiceShareSessionSummary: true,
        voiceShareFilePaths: true,
      }),
    ).toBe('Lookup session summary');
  });

  it('trims the session id before resolving the label', () => {
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
      sessionListRenderables: {
        s_matrix: {
          id: 's_matrix',
          updatedAt: 42,
          metadata: {
            summaryText: 'Trimmed session summary',
            path: '/Users/alice/project-alpha',
          },
        },
      },
      sessionListIndexByServerId: {
        'active-server': [
          {
            type: 'session',
            sessionId: 's_matrix',
            serverId: 'active-server',
            serverName: 'Active',
          },
        ],
      },
    }));

    expect(
      resolveVoiceSessionLabel(' s_matrix ', {
        voiceShareSessionSummary: true,
        voiceShareFilePaths: true,
      }),
    ).toBe('Trimmed session summary');
  });

  it('trims the session id before resolving a raw session name', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        s_matrix: {
          id: 's_matrix',
          metadata: {
            name: 'Raw session name',
            path: '/Users/alice/project-alpha',
          },
        },
      },
      sessionListIndexByServerId: {},
    }));

    expect(
      resolveVoiceSessionLabel(' s_matrix ', {
        voiceShareSessionSummary: false,
        voiceShareFilePaths: true,
      }),
    ).toBe('Raw session name');
  });
});
