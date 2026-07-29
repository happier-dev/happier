import { describe, expect, it } from 'vitest';

import { sanitizeVoiceOutputEventForDisplay } from './sanitizeVoiceOutputEventForDisplay';

describe('sanitizeVoiceOutputEventForDisplay', () => {
  it('redacts paths and token-shaped values from display status only', () => {
    expect(sanitizeVoiceOutputEventForDisplay({
      v: 1,
      kind: 'display_status',
      turnId: 'turn-1',
      seq: 0,
      statusId: 'status-1',
      text: 'Reading /Users/alice/private token=super-secret-value',
    })).toMatchObject({
      kind: 'display_status',
      text: expect.not.stringContaining('super-secret-value'),
    });
    expect(sanitizeVoiceOutputEventForDisplay({
      v: 1,
      kind: 'speech_segment',
      turnId: 'turn-1',
      seq: 0,
      segmentId: 'segment-1',
      text: 'Speak this unchanged',
    })).toMatchObject({ text: 'Speak this unchanged' });
  });
});
