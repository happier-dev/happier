import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureBound = vi.fn();

vi.mock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
  voiceSessionBindingManager: {
    ensureBound: (params: any) => ensureBound(params),
  },
}));

import { ensureDefaultLocalVoiceQaBinding } from './ensureDefaultLocalVoiceQaBinding';

describe('ensureDefaultLocalVoiceQaBinding', () => {
  beforeEach(() => {
    ensureBound.mockReset();
  });

  it('returns the bound native-session conversation binding from the shared binding manager', async () => {
    const binding = {
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      transcriptMode: 'native_session' as const,
      targetSessionId: 's1',
      updatedAt: 1,
    };
    ensureBound.mockResolvedValue(binding);

    await expect(
      ensureDefaultLocalVoiceQaBinding({
        controlSessionId: '__voice_agent__',
        requestedTargetSessionId: 's1',
      }),
    ).resolves.toEqual(binding);

    expect(ensureBound).toHaveBeenCalledWith({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1',
    });
  });
});
