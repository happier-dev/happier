import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceStorageModuleMocks } from '@/voice/persistence/installVoiceStorageModuleMocks';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

// Hydrated `sessions` fixtures below belong to the active Home's entity map, so the
// qualified switch-note targets address that Home.
const activeServerId = getActiveServerSnapshot().serverId;

const appendVoiceConversationNoteText = vi.fn();

let state: any = {
  settings: {
    voice: {
      privacy: {
        shareSessionSummary: true,
        shareFilePaths: true,
      },
    },
  },
  sessions: {
    s1: { id: 's1', metadata: { summary: { text: 'Private summary A' } } },
    s2: { id: 's2', metadata: { summary: { text: 'Private summary B' } } },
  },
  sessionListRowsByServerId: {},
  ordinarySessionListMembershipByServerId: {},
  sessionListIndexByServerId: {},
  concurrentSessionListCacheByServerId: {},
};

installVoiceStorageModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => state,
            },
        });
    },
});

vi.mock('@/voice/transcript/voiceConversationTranscript', () => ({
  appendVoiceConversationNoteText: (params: any) => appendVoiceConversationNoteText(params),
}));

describe('appendVoiceTargetSessionSwitchNote', () => {
  beforeEach(() => {
    vi.resetModules();
    appendVoiceConversationNoteText.mockReset();
    state.settings.voice.privacy.shareSessionSummary = true;
    state.settings.voice.privacy.shareFilePaths = true;
    state.sessions = {
      s1: { id: 's1', metadata: { summary: { text: 'Private summary A' } } },
      s2: { id: 's2', metadata: { summary: { text: 'Private summary B' } } },
    };
    state.sessionListRowsByServerId = {};
    state.ordinarySessionListMembershipByServerId = {};
    state.sessionListIndexByServerId = {};
    state.concurrentSessionListCacheByServerId = {};
  });

  it('falls back to human-readable generic labels when voice privacy disables summary sharing', async () => {
    state.settings.voice.privacy.shareSessionSummary = false;
    const { appendVoiceTargetSessionSwitchNote } = await import('./appendVoiceTargetSessionSwitchNote');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionAddress: { serverId: activeServerId, sessionId: 's1' },
      targetSessionAddress: { serverId: activeServerId, sessionId: 's2' },
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'Target session changed from the previous session to the current session',
    });
    expect(appendVoiceConversationNoteText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Private summary') }),
    );
  });

  it('can use session summaries when summary sharing remains enabled', async () => {
    const { appendVoiceTargetSessionSwitchNote } = await import('./appendVoiceTargetSessionSwitchNote');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionAddress: { serverId: activeServerId, sessionId: 's1' },
      targetSessionAddress: { serverId: activeServerId, sessionId: 's2' },
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'Target session changed from Private summary A to Private summary B',
    });
  });

  it('redacts file paths inside session-summary labels when file path sharing is disabled', async () => {
    state.settings.voice.privacy.shareFilePaths = false;
    state.sessions = {
      ...state.sessions,
      s1: { id: 's1', metadata: { summary: { text: 'Editing /Users/alice/SecretRepo/src/a.ts' } } },
      s2: { id: 's2', metadata: { summary: { text: 'Reviewing /Users/alice/SecretRepo/src/b.ts' } } },
    };
    // The canonical testkit reader, like Zustand, admits a new snapshot identity.
    state = { ...state };
    const { appendVoiceTargetSessionSwitchNote } = await import('./appendVoiceTargetSessionSwitchNote');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionAddress: { serverId: activeServerId, sessionId: 's1' },
      targetSessionAddress: { serverId: activeServerId, sessionId: 's2' },
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'Target session changed from Editing <path_redacted> to Reviewing <path_redacted>',
    });
  });

  it('does not disclose lookup session-list names when summary sharing is disabled', async () => {
    state.settings.voice.privacy.shareSessionSummary = false;
    state.sessions = {};
    state.sessionListRowsByServerId = {
      [activeServerId]: {
        s1: {
          id: 's1',
          updatedAt: 1,
          metadata: { name: 'Voice Target Alpha', summaryText: 'Private summary A', path: '/tmp/alpha' },
        },
        s2: {
          id: 's2',
          updatedAt: 2,
          metadata: { name: 'Voice Tracked Beta', summaryText: 'Private summary B', path: '/tmp/beta' },
        },
      },
    };
    state.ordinarySessionListMembershipByServerId = { [activeServerId]: ['s1', 's2'] };
    state.sessionListIndexByServerId = {
      [activeServerId]: [
        { type: 'session', sessionId: 's1', serverId: activeServerId, serverName: 'Active' },
        { type: 'session', sessionId: 's2', serverId: activeServerId, serverName: 'Active' },
      ],
    };
    const { appendVoiceTargetSessionSwitchNote } = await import('./appendVoiceTargetSessionSwitchNote');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionAddress: { serverId: activeServerId, sessionId: 's1' },
      targetSessionAddress: { serverId: activeServerId, sessionId: 's2' },
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'Target session changed from the previous session to the current session',
    });
  });

  it('treats raw session-id metadata labels as unresolved and falls back to generic labels', async () => {
    state.settings.voice.privacy.shareSessionSummary = false;
    state.sessions = {
      s1: { id: 's1', metadata: { name: 's1' } },
      s2: { id: 's2', metadata: { name: 's2' } },
    };
    const { appendVoiceTargetSessionSwitchNote } = await import('./appendVoiceTargetSessionSwitchNote');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionAddress: { serverId: activeServerId, sessionId: 's1' },
      targetSessionAddress: { serverId: activeServerId, sessionId: 's2' },
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'Target session changed from the previous session to the current session',
    });
  });
});
