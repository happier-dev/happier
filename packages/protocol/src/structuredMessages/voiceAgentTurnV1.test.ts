import { describe, expect, it } from 'vitest';

import { VoiceAgentTurnV1Schema } from './voiceAgentTurnV1.js';

describe('VoiceAgentTurnV1Schema', () => {
  it('accepts a minimal voice agent turn payload', () => {
    const parsed = VoiceAgentTurnV1Schema.parse({
      v: 1,
      epoch: 3,
      role: 'assistant',
      voiceAgentId: 'va_1',
      ts: 123,
    });
    expect(parsed.v).toBe(1);
    expect(parsed.role).toBe('assistant');
  });
});

