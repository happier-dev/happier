import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';

function seedSession(privacyOverrides: Record<string, unknown>): void {
  storage.setState((current) => ({
    ...current,
    settings: {
      ...settingsDefaults,
      voice: {
        ...settingsDefaults.voice,
        privacy: {
          ...settingsDefaults.voice.privacy,
          ...privacyOverrides,
        },
      },
    },
    sessions: {
      s1: {
        id: 's1',
        seq: 0,
        createdAt: 0,
        updatedAt: 100,
        active: true,
        activeAt: 0,
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        agentState: null,
        metadata: {
          path: '/Users/leeroy/Documents/secret-workspace/payments',
          host: 'leeroy-mbp',
          summary: { text: 'Confidential billing rewrite', updatedAt: 0 },
        },
      },
    },
    sessionListIndexByServerId: {
      'server-a': [
        { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
      ],
    },
    concurrentSessionListCacheByServerId: {},
  }) as never);
}

describe('listSessionsForVoiceTool privacy', () => {
  afterEach(() => {
    storage.setState((current) => ({
      ...current,
      settings: settingsDefaults,
      sessions: {},
      sessionListIndexByServerId: {},
    }) as never);
  });

  it('omits the session summary title when shareSessionSummary is disabled', async () => {
    seedSession({ shareSessionSummary: false });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({});
    const session = result.sessions[0] as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain('Confidential billing rewrite');
    expect(session.id).toBe('s1');
  });

  it('keeps the session summary title when shareSessionSummary is enabled', async () => {
    seedSession({ shareSessionSummary: true });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({});
    const session = result.sessions[0] as Record<string, unknown>;
    expect(session.title).toBe('Confidential billing rewrite');
  });

  it('omits the location label because shareFilePaths is hardened off for the voice transport', async () => {
    // `voiceSettingsParse` force-disables shareFilePaths regardless of the persisted config, so the
    // location label (a workspace path tail) must never reach the voice provider.
    seedSession({ shareSessionSummary: true, shareFilePaths: true });
    const { listSessionsForVoiceTool } = await import('./sessionList');

    const result = await listSessionsForVoiceTool({});
    const session = result.sessions[0] as Record<string, unknown>;
    expect(session.locationLabel).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('payments');
  });
});
