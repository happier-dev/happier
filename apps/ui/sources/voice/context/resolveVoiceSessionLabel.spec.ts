import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

import { resolveVoiceSessionAuthoredLabel, resolveVoiceSessionLabel } from './resolveVoiceSessionLabel';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

describe('resolveVoiceSessionLabel', () => {
  it('does not use another Home raw metadata when the qualified target is unavailable', () => {
    storage.setState((state) => ({
      ...state,
      sessions: { same: { id: 'same', metadata: { summaryText: 'Active Home private title' } } },
    }) as never);
    expect(resolveVoiceSessionLabel({ serverId: 'unavailable-home', sessionId: 'same' }, {
      voiceShareSessionSummary: true, voiceShareFilePaths: false,
    })).toBe('the current session');
  });
  beforeEach(() => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {},
      sessionListRowsByServerId: {},
      ordinarySessionListMembershipByServerId: {},
      sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
    }));
  });

  it('names authored metadata while rejecting transient list and display-only title fields', () => {
    const prefs = { voiceShareSessionSummary: true, voiceShareFilePaths: false };
    const session = createSessionFixture({ metadata: { ...createSessionFixture().metadata!, path: '/project' } });
    const row = buildSessionListRenderableFromSession(session, undefined, [
      { id: 'dictated', kind: 'user-text', localId: null, createdAt: 1, text: 'A transient request' },
    ]);
    expect(resolveVoiceSessionAuthoredLabel(session.metadata, prefs)).toBeNull();
    expect(resolveVoiceSessionAuthoredLabel(row.metadata, prefs)).toBeNull();
    expect(resolveVoiceSessionAuthoredLabel({ summaryText: 'A transient request' }, prefs)).toBeNull();
    expect(resolveVoiceSessionAuthoredLabel({ summary: { text: 'Release /home/alice/project' } }, prefs))
      .toBe('Release <path_redacted>');
    expect(resolveVoiceSessionAuthoredLabel({ name: 'Release planning' }, prefs))
      .toBe('Release planning');
    expect(resolveVoiceSessionAuthoredLabel({ summary: { text: 'Saved title' } },
      { ...prefs, voiceShareSessionSummary: false })).toBeNull();
  });

  it('uses the owner title instead of a projected lookup label', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        s_matrix: {
          id: 's_matrix',
          metadata: {
            summary: { text: 'Authored session title', updatedAt: 1 },
            path: '/Users/alice/project-alpha',
          },
        },
      },
      sessionListRowsByServerId: {
        [getActiveServerSnapshot().serverId]: {
          s_matrix: {
            id: 's_matrix',
            updatedAt: 42,
            metadata: {
              summaryText: 'Lookup session summary',
              path: '/Users/alice/project-alpha',
            },
          },
        },
      },
      ordinarySessionListMembershipByServerId: {
        [getActiveServerSnapshot().serverId]: ['s_matrix'],
      },
      sessionListIndexByServerId: {
        [getActiveServerSnapshot().serverId]: [
          {
            type: 'session',
            sessionId: 's_matrix',
            serverId: getActiveServerSnapshot().serverId,
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
    ).toBe('Authored session title');
  });

  it('trims the session id before resolving the label', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        s_matrix: {
          id: 's_matrix',
          metadata: {
            summary: { text: 'Authored session title', updatedAt: 1 },
            path: '/Users/alice/project-alpha',
          },
        },
      },
      sessionListRowsByServerId: {
        [getActiveServerSnapshot().serverId]: {
          s_matrix: {
            id: 's_matrix',
            updatedAt: 42,
            metadata: {
              summaryText: 'Trimmed session summary',
              path: '/Users/alice/project-alpha',
            },
          },
        },
      },
      ordinarySessionListMembershipByServerId: {
        [getActiveServerSnapshot().serverId]: ['s_matrix'],
      },
      sessionListIndexByServerId: {
        [getActiveServerSnapshot().serverId]: [
          {
            type: 'session',
            sessionId: 's_matrix',
            serverId: getActiveServerSnapshot().serverId,
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
    ).toBe('Authored session title');
  });

  it('does not disclose a raw session name when summary sharing is disabled', () => {
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
    ).toBe('the current session');
  });

  it.each([undefined, null, 'true', 1, {}, []])(
    'fails closed for omitted or malformed privacy prefs=%p',
    (privacyPrefs) => {
      const label = Reflect.apply(resolveVoiceSessionLabel, undefined, [
        's_private',
        privacyPrefs,
        {
          metadata: {
            summaryText: 'PRIVATE SESSION SUMMARY',
            path: '/Users/alice/Company/PrivateProject',
          },
        },
      ]);

      expect(label).toBe('the current session');
      expect(label).not.toContain('PRIVATE SESSION SUMMARY');
      expect(label).not.toContain('PrivateProject');
    },
  );

  it('uses only the layout-v1 owner view for authored titles', () => {
    storage.setState((state: any) => ({
      ...state,
      sessions: {
        s_private: {
          id: 's_private',
          metadataLayoutVersion: 1,
          metadata: { v: 1, summary: { text: 'Shared lookalike', updatedAt: 1 } },
          ownerMetadataView: { summary: { text: 'Owner title', updatedAt: 1 } },
        },
      },
    }));

    expect(resolveVoiceSessionLabel('s_private', {
      voiceShareSessionSummary: true,
      voiceShareFilePaths: true,
    })).toBe('Owner title');

    storage.setState((state: any) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_private: {
          ...state.sessions.s_private,
          ownerMetadataView: null,
        },
      },
    }));

    expect(resolveVoiceSessionLabel('s_private', {
      voiceShareSessionSummary: true,
      voiceShareFilePaths: true,
    })).toBe('the current session');
  });
});
