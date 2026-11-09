import { describe, expect, it } from 'vitest';

import { collectVoiceSessionRows } from './voiceSessionRows';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

describe('collectVoiceSessionRows', () => {
  it('uses admitted layout-one list visibility without requiring private continuation metadata', () => {
    const visible = createSessionListRenderableSessionFixture({
      id: 'visible-bot', metadataLayoutVersion: 1, metadataUnavailable: false,
      metadata: { path: '/repo', bot: { kind: 'bot' }, botFace: { body: 'spider' } },
    });
    const hidden = createSessionListRenderableSessionFixture({
      id: 'hidden-carrier', metadataLayoutVersion: 1, metadataUnavailable: false,
      metadata: { path: '/repo', hiddenSystemSession: true },
    });
    const unavailable = createSessionListRenderableSessionFixture({
      id: 'unavailable-owner', metadataLayoutVersion: 1, metadataUnavailable: true, metadata: null,
    });
    const rows = collectVoiceSessionRows({
      sessionListRowsByServerId: { server: { 'visible-bot': visible, 'hidden-carrier': hidden, 'unavailable-owner': unavailable } },
      ordinarySessionListMembershipByServerId: { server: ['visible-bot', 'hidden-carrier', 'unavailable-owner'] },
    }, { activeServerId: 'server' });
    expect(rows.map(row => row.id)).toEqual(['visible-bot']);
  });

  it('keeps a current Team recipient visible without inventing a released direct share', () => {
    const rows = collectVoiceSessionRows({
      sessionListRowsByServerId: {
        server: {
          team_session: {
            id: 'team_session',
            serverId: 'server',
            updatedAt: 20,
            active: true,
            presence: 'online',
            metadataLayoutVersion: 1,
            metadataUnavailable: true,
            metadata: { v: 1, summary: { text: 'Team session', updatedAt: 20 } },
            access: {
              role: 'recipient',
              level: 'view',
              capabilities: {
                readTranscript: true,
                submitAgentInput: false,
                editSessionRecords: false,
                approveRuntimePermissions: false,
                manageAccess: false,
                managePermissionDelegation: false,
                managePublicLink: false,
                archiveSession: false,
                renameSession: false,
                assignResponsibility: false,
                stopSession: false,
                deleteSession: false,
              },
              sources: [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }],
            },
          },
        },
      },
      ordinarySessionListMembershipByServerId: { server: ['team_session'] },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        address: { serverId: 'server', sessionId: 'team_session' },
        title: 'Team session',
      }),
    ]);
  });

  it('keeps equal Session ids from different Homes as distinct qualified rows', () => {
    const rows = collectVoiceSessionRows({
      sessionListRowsByServerId: {
        'home-a': {
          same: {
            id: 'same',
            updatedAt: 20,
            active: true,
            presence: 'online',
            metadata: { summaryText: 'Alpha' },
          },
        },
        'https://home-b.example:8443': {
          same: {
            id: 'same',
            updatedAt: 10,
            active: false,
            presence: 'offline',
            metadata: { summaryText: 'Beta' },
          },
        },
      },
      ordinarySessionListMembershipByServerId: {
        'home-a': ['same'],
        'https://home-b.example:8443': ['same'],
      },
      concurrentSessionListCacheByServerId: {
        'home-a': {
          serverName: 'Home A',
        },
        'https://home-b.example:8443': {
          serverName: 'Home B',
        },
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        address: { serverId: 'home-a', sessionId: 'same' },
        id: 'same',
        title: 'Alpha',
      }),
      expect.objectContaining({
        address: { serverId: 'https://home-b.example:8443', sessionId: 'same' },
        id: 'same',
        title: 'Beta',
      }),
    ]);
  });

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
      sessionListRowsByServerId: {
        server: {
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
      },
      ordinarySessionListMembershipByServerId: { server: ['voice_history'] },
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

  it('ignores cache-only rows outside ordinary membership and keeps canonical session rows', () => {
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
        },
      },
      sessionListRowsByServerId: {
        'active-server': {
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
        'side-server': {
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
      ordinarySessionListMembershipByServerId: {
        'active-server': ['s2'],
        'side-server': ['s3'],
      },
    }, { activeServerId: 'active-server' });

    expect(rows.map((row) => row.id)).toEqual(['s3', 's2', 's1']);
    expect(rows.find((row) => row.id === 'stale_only')).toBeUndefined();
  });

  it('enumerates an explicitly admitted row-only address that has no ordinary membership', async () => {
    const { resolveVoiceSessionReference } = await import('./sessionReference');
    // A row-only acquisition hydrated this Home's row without publishing ordinary membership.
    const state = {
      sessionListRowsByServerId: {
        'home-a': {
          'deploy-session': {
            id: 'deploy-session',
            updatedAt: 20,
            active: true,
            presence: 'online',
            metadata: { summaryText: 'Deploy' },
          },
        },
      },
      ordinarySessionListMembershipByServerId: {},
    };
    const options = {
      knownServerIds: ['home-a'],
      coverage: 'complete' as const,
      addresses: [{ serverId: 'home-a', sessionId: 'deploy-session' }],
    };

    expect(resolveVoiceSessionReference({ sessionTitle: 'Deploy' }, state, options)).toMatchObject({
      kind: 'unique',
      address: { serverId: 'home-a', sessionId: 'deploy-session' },
    });
  });
});
