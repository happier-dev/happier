import { describe, expect, it } from 'vitest';

import { stripTrailingJsonObjectFromText } from './stripTrailingJsonObjectFromText';

describe('stripTrailingJsonObjectFromText', () => {
  it('removes a trailing JSON object from prose', () => {
    expect(stripTrailingJsonObjectFromText([
      'Plan prose',
      '{"summary":"Ok","sections":[]}',
    ].join('\n'))).toBe('Plan prose');
  });

  it('removes a fenced trailing JSON object from prose', () => {
    expect(stripTrailingJsonObjectFromText([
      'Plan prose',
      '```json',
      '{',
      '  "summary": "Ok",',
      '  "sections": [{ "title": "Steps", "items": ["Step 1"], }],',
      '}',
      '```',
    ].join('\n'))).toBe('Plan prose');
  });

  it('leaves text unchanged when no trailing JSON object is present', () => {
    const text = 'Plan prose only';
    expect(stripTrailingJsonObjectFromText(text)).toBe(text);
  });
});
