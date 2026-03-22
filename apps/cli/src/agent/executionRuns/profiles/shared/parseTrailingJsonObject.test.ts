import { describe, expect, it } from 'vitest';

import { parseTrailingJsonObject } from './parseTrailingJsonObject';

describe('parseTrailingJsonObject', () => {
  it('parses the last JSON object from prose + json', () => {
    const parsed = parseTrailingJsonObject([
      'Here is some prose.',
      '',
      '{ "ok": true }',
    ].join('\n'));

    expect(parsed).toEqual({ ok: true });
  });

  it('parses a JSON object wrapped in markdown fences', () => {
    const parsed = parseTrailingJsonObject([
      'Some prose.',
      '```json',
      '{ "ok": true }',
      '```',
    ].join('\n'));

    expect(parsed).toEqual({ ok: true });
  });

  it('parses a JSON object that contains trailing commas', () => {
    const parsed = parseTrailingJsonObject([
      'Here is the payload:',
      '{',
      '  "summary": "Ok",',
      '  "deliverables": [{ "id": "d1", "title": "t1", }],',
      '}',
    ].join('\n'));

    expect(parsed).toEqual({
      summary: 'Ok',
      deliverables: [{ id: 'd1', title: 't1' }],
    });
  });

  it('parses trailing-comma JSON when strings contain escaped quotes and backslashes', () => {
    const parsed = parseTrailingJsonObject([
      'Here is the payload:',
      '{',
      '  "summary": "Say \\"hi\\"",',
      '  "path": "C:\\\\temp",',
      '}',
    ].join('\n'));

    expect(parsed).toEqual({
      summary: 'Say "hi"',
      path: 'C:\\temp',
    });
  });

  it('parses JSON when strings contain escaped quotes and braces', () => {
    const parsed = parseTrailingJsonObject([
      'Here is the payload:',
      '{',
      '  "summary": "Escaped quote: \\\" and brace: }",',
      '  "ok": true,',
      '}',
    ].join('\n'));

    expect(parsed).toEqual({
      summary: 'Escaped quote: " and brace: }',
      ok: true,
    });
  });
});
