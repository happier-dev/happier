import { describe, expect, it } from 'vitest';

import { writeVoiceConversationScopeMetadata } from './voiceConversationScopeMetadata';

describe('writeVoiceConversationScopeMetadata', () => {
  it('trims session root ids when writing metadata', () => {
    expect(
      writeVoiceConversationScopeMetadata(
        { existing: true },
        { kind: 'session_root', sessionRootId: '  root-session  ' },
      ),
    ).toEqual({
      existing: true,
      voiceConversationScopeV1: {
        v: 1,
        kind: 'session_root',
        sessionRootId: 'root-session',
      },
    });
  });

  it('rejects session root ids that normalize to empty strings', () => {
    expect(() =>
      writeVoiceConversationScopeMetadata(
        { existing: true },
        { kind: 'session_root', sessionRootId: '   ' },
      ),
    ).toThrow(TypeError);
  });
});
