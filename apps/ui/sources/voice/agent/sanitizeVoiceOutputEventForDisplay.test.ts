import { describe, expect, it } from 'vitest';

import { sanitizeVoiceOutputEventForDisplay } from './sanitizeVoiceOutputEventForDisplay';
import { t } from '@/text';

describe('sanitizeVoiceOutputEventForDisplay', () => {
  it('localizes the host context-fit status without treating it as speech', () => {
    const text = 'voiceSurface.earlierTurnsLeftOut';
    const localized = t('voiceSurface.earlierTurnsLeftOut');
    expect(localized).not.toBe(text);
    expect(sanitizeVoiceOutputEventForDisplay({ v: 1, kind: 'display_status', turnId: 'turn-1',
      seq: 0, statusId: 'turn-1:context-fit', text })).toMatchObject({ text: localized });
    const speech = { v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'segment-1', text } as const;
    expect(sanitizeVoiceOutputEventForDisplay(speech)).toBe(speech);
  });

  it('redacts paths and token-shaped values from display status only', () => {
    const status = sanitizeVoiceOutputEventForDisplay({
      v: 1,
      kind: 'display_status',
      turnId: 'turn-1',
      seq: 0,
      statusId: 'status-1',
      text: 'Reading /Users/alice/private token=super-secret-value',
    });
    expect(status).toMatchObject({
      kind: 'display_status',
      text: expect.not.stringContaining('super-secret-value'),
    });
    expect(status).toMatchObject({ text: expect.not.stringContaining('/Users/alice/private') });
    expect(status).toMatchObject({ text: expect.stringContaining('Reading') });
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
