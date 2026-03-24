import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceSessionBindingCommonModuleMocks } from './voiceSessionBindingTestHelpers';

const appendVoiceConversationNoteText = vi.fn();

const state: any = {
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
  sessionListViewData: null,
  sessionListViewDataByServerId: {},
};

installVoiceSessionBindingCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => state,
            },
        });
    },
});

vi.mock('./voiceConversationTranscript', () => ({
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
    state.sessionListViewData = null;
    state.sessionListViewDataByServerId = {};
  });

  it('falls back to human-readable generic labels when voice privacy disables summary sharing', async () => {
    state.settings.voice.privacy.shareSessionSummary = false;
    const { appendVoiceTargetSessionSwitchNote } = await import('./voiceSessionTargetAnnotations');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionId: 's1',
      targetSessionId: 's2',
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Target session changed from the previous session to the current session',
    });
    expect(appendVoiceConversationNoteText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Private summary') }),
    );
  });

  it('can use session summaries when summary sharing remains enabled', async () => {
    const { appendVoiceTargetSessionSwitchNote } = await import('./voiceSessionTargetAnnotations');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionId: 's1',
      targetSessionId: 's2',
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Target session changed from Private summary A to Private summary B',
    });
  });

  it('redacts file paths inside session-summary labels when file path sharing is disabled', async () => {
    state.settings.voice.privacy.shareFilePaths = false;
    state.sessions.s1.metadata.summary.text = 'Editing /Users/alice/SecretRepo/src/a.ts';
    state.sessions.s2.metadata.summary.text = 'Reviewing /Users/alice/SecretRepo/src/b.ts';
    const { appendVoiceTargetSessionSwitchNote } = await import('./voiceSessionTargetAnnotations');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionId: 's1',
      targetSessionId: 's2',
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Target session changed from Editing <path_redacted> to Reviewing <path_redacted>',
    });
  });

  it('uses cached session-list names before generic placeholders when summaries are unavailable', async () => {
    state.settings.voice.privacy.shareSessionSummary = false;
    state.sessions = {};
    state.sessionListViewData = [
      {
        type: 'session',
        session: {
          id: 's1',
          metadata: { name: 'Voice Target Alpha', summaryText: 'Private summary A', path: '/tmp/alpha' },
        },
      },
      {
        type: 'session',
        session: {
          id: 's2',
          metadata: { name: 'Voice Tracked Beta', summaryText: 'Private summary B', path: '/tmp/beta' },
        },
      },
    ];
    const { appendVoiceTargetSessionSwitchNote } = await import('./voiceSessionTargetAnnotations');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionId: 's1',
      targetSessionId: 's2',
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Target session changed from Voice Target Alpha to Voice Tracked Beta',
    });
  });

  it('treats raw session-id metadata labels as unresolved and falls back to generic labels', async () => {
    state.settings.voice.privacy.shareSessionSummary = false;
    state.sessions = {
      s1: { id: 's1', metadata: { name: 's1' } },
      s2: { id: 's2', metadata: { name: 's2' } },
    };
    const { appendVoiceTargetSessionSwitchNote } = await import('./voiceSessionTargetAnnotations');

    appendVoiceTargetSessionSwitchNote({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionId: 's1',
      targetSessionId: 's2',
    });

    expect(appendVoiceConversationNoteText).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Target session changed from the previous session to the current session',
    });
  });
});
