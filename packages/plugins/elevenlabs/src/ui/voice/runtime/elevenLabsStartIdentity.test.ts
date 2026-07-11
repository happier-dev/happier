import { describe, expect, it } from 'vitest';

import { resolveElevenLabsStartIdentity } from './elevenLabsStartIdentity.js';

const VOICE_AGENT_GLOBAL_SESSION_ID = '__voice_agent__';

describe('resolveElevenLabsStartIdentity', () => {
  it('uses the global carrier for empty input without binding it as a target', () => {
    expect(resolveElevenLabsStartIdentity('', VOICE_AGENT_GLOBAL_SESSION_ID)).toEqual({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: null,
    });
  });

  it('keeps the global carrier sentinel out of target selection', () => {
    expect(resolveElevenLabsStartIdentity(VOICE_AGENT_GLOBAL_SESSION_ID, VOICE_AGENT_GLOBAL_SESSION_ID)).toEqual({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: null,
    });
  });

  it('uses an exact normalized session identity as both carrier and requested target', () => {
    expect(resolveElevenLabsStartIdentity(' session-1 ', VOICE_AGENT_GLOBAL_SESSION_ID)).toEqual({
      controlSessionId: 'session-1',
      requestedTargetSessionId: 'session-1',
    });
  });
});
