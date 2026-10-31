import { describe, expect, it } from 'vitest';

import { stripTrailingJsonObjectFromText } from './stripTrailingJsonObjectFromText';

describe('stripTrailingJsonObjectFromText', () => {
  it('holds known output prefixes and JSON fences while preserving ordinary JSON in prose', () => {
    for (const text of ['{', '{\n"walk', '`', '```j', '```json\n', '```json\n{"walkthrough":']) {
      expect(stripTrailingJsonObjectFromText(text, ['walkthrough'])).toBe('');
    }
    expect(stripTrailingJsonObjectFromText('The config uses {"allow":true} exactly.', ['walkthrough']))
      .toBe('The config uses {"allow":true} exactly.');
    const nestedExample = 'The config uses {"allow":{"walkthrough":"example"}} exactly.';
    expect(stripTrailingJsonObjectFromText(nestedExample, ['walkthrough'])).toBe(nestedExample);
    const arrayExample = 'Examples: [{"walkthrough":"quoted \\"{\\" content"}].';
    expect(stripTrailingJsonObjectFromText(arrayExample, ['walkthrough'])).toBe(arrayExample);
    expect(stripTrailingJsonObjectFromText(`${nestedExample}\n{"walkthrough":`, ['walkthrough'])).toBe(nestedExample);
    expect(stripTrailingJsonObjectFromText('Updated: {"walkthrough":', ['walkthrough'])).toBe('Updated:');
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
