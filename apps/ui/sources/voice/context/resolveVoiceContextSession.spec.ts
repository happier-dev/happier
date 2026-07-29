import { describe, expect, it } from 'vitest';

import { resolveVoiceContextSessionFromState } from './resolveVoiceContextSession';

describe('resolveVoiceContextSessionFromState', () => {
  it('prefers the visible lookup session object over stale raw session state', () => {
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
      sessionListRenderables: {
        s1: {
          id: 's1',
          active: false,
          updatedAt: 99,
          presence: 'away',
          metadata: {
            path: '/lookup/path',
            homeDir: '/lookup/home',
            name: 'lookup name',
            machineId: 'lookup-machine',
            summaryText: 'Lookup summary',
            summary: { text: 'Lookup summary', updatedAt: 99 },
          },
        },
      },
      sessionListIndexByServerId: {
        'server-a': [
          { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
        ],
      },
      concurrentSessionListCacheByServerId: {},
    };

    const resolved = resolveVoiceContextSessionFromState('s1', state);

    expect(resolved).toMatchObject({
      id: 's1',
      active: false,
      updatedAt: 99,
      presence: 'away',
      metadata: {
        path: '/lookup/path',
        homeDir: '/lookup/home',
        name: 'lookup name',
        machineId: 'lookup-machine',
        summaryText: 'Lookup summary',
        summary: { text: 'Lookup summary', updatedAt: 99 },
      },
    });
  });

  it('falls back to raw session state when the visible lookup session has the wrong id', () => {
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
      sessionListRenderables: {
        'wrong-id': {
          id: 'wrong-id',
          active: false,
          updatedAt: 99,
          presence: 'away',
          metadata: {
            path: '/lookup/path',
            homeDir: '/lookup/home',
            name: 'lookup name',
            machineId: 'lookup-machine',
            summaryText: 'Lookup summary',
            summary: { text: 'Lookup summary', updatedAt: 99 },
          },
        },
      },
      sessionListIndexByServerId: {
        'server-a': [
          { type: 'session', sessionId: 'wrong-id', serverId: 'server-a', serverName: 'Server A' },
        ],
      },
      concurrentSessionListCacheByServerId: {},
    };

    const resolved = resolveVoiceContextSessionFromState('s1', state);

    expect(resolved).toMatchObject({
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
    });
  });

  it('keeps a layout-v1 hydrated owner session instead of substituting a shared list projection', () => {
    const ownerMetadataView = {
      path: '/owner/path',
      machineId: 'owner-machine',
    };
    const state = {
      sessions: {
        s1: {
          id: 's1',
          metadataLayoutVersion: 1,
          metadata: { v: 1, path: '/shared/private-lookalike' },
          ownerMetadataView,
        },
      },
      sessionListRenderables: {
        s1: {
          id: 's1',
          updatedAt: 99,
          metadataLayoutVersion: 1,
          metadata: { summaryText: 'Shared summary', path: '/shared/list-lookalike' },
        },
      },
      sessionListIndexByServerId: {
        server: [{ type: 'session', sessionId: 's1', serverId: 'server' }],
      },
    };

    expect(resolveVoiceContextSessionFromState('s1', state)?.ownerMetadataView).toBe(ownerMetadataView);
  });
});
