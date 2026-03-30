import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceSessionBindingCommonModuleMocks } from './voiceSessionBindingTestHelpers';

const applyMessages = vi.fn();
const applyMessagesLoaded = vi.fn();

installVoiceSessionBindingCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => ({
          applyMessages,
          applyMessagesLoaded,
        }),
      },
    });
  },
});

describe('voiceConversationTranscript', () => {
  beforeEach(() => {
    applyMessages.mockReset();
    applyMessagesLoaded.mockReset();
  });

  it('appends a user-text transcript message', async () => {
    const { appendVoiceConversationUserText } = await import('./voiceConversationTranscript');

    appendVoiceConversationUserText({
      conversationSessionId: 'carrier-s1',
      text: 'hello from voice',
    });

    expect(applyMessagesLoaded).toHaveBeenCalledWith('carrier-s1');
    expect(applyMessages).toHaveBeenCalledWith(
      'carrier-s1',
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: { type: 'text', text: 'hello from voice' },
          isSidechain: false,
        }),
      ]),
    );
  });

  it('appends assistant text and plain note messages as agent transcript messages', async () => {
    const {
      appendVoiceConversationAssistantText,
      appendVoiceConversationNoteText,
    } = await import('./voiceConversationTranscript');

    appendVoiceConversationAssistantText({
      conversationSessionId: 'carrier-s1',
      text: 'I checked the workspace.',
    });
    appendVoiceConversationNoteText({
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Target session changed to s2',
    });

    expect(applyMessages).toHaveBeenNthCalledWith(
      1,
      'carrier-s1',
      expect.arrayContaining([
        expect.objectContaining({
          role: 'agent',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: 'I checked the workspace.',
            }),
          ]),
        }),
      ]),
    );
    expect(applyMessages).toHaveBeenNthCalledWith(
      2,
      'carrier-s1',
      expect.arrayContaining([
        expect.objectContaining({
          role: 'agent',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: '[Voice] Target session changed to s2',
            }),
          ]),
        }),
      ]),
    );
  });
});
