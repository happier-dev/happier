import { describe, expect, it } from 'vitest';

import { resolveVoiceOperationalSessionId } from './resolveVoiceOperationalSessionId';

describe('resolveVoiceOperationalSessionId', () => {
  it('uses the hidden conversation session for native-session bindings', () => {
    expect(
      resolveVoiceOperationalSessionId(
        {
          adapterId: 'local_conversation',
          controlSessionId: '__voice_agent__',
          conversationSessionId: 'voice-hidden-s1',
          transcriptMode: 'native_session',
          targetSessionId: 's1',
          updatedAt: 1,
        },
        '__voice_agent__',
      ),
    ).toBe('voice-hidden-s1');
  });

  it('falls back to the control session when the native-session binding has no conversation session id', () => {
    expect(
      resolveVoiceOperationalSessionId(
        {
          adapterId: 'local_conversation',
          controlSessionId: '__voice_agent__',
          conversationSessionId: '',
          transcriptMode: 'native_session',
          targetSessionId: 's1',
          updatedAt: 1,
        },
        '__voice_agent__',
      ),
    ).toBe('__voice_agent__');
  });
});
