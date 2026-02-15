import { describe, expect, it } from 'vitest';

import { parseRawJsonLinesLine, parseRawJsonLinesObject } from './parseRawJsonLines';

describe('parseRawJsonLines', () => {
  it('returns null for empty lines', () => {
    expect(parseRawJsonLinesLine('')).toBeNull();
    expect(parseRawJsonLinesLine('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseRawJsonLinesLine('{')).toBeNull();
    expect(parseRawJsonLinesLine('not json')).toBeNull();
  });

  it('parses a valid assistant message and preserves unknown fields', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      extra_field: { nested: true },
    });
    const parsed = parseRawJsonLinesLine(line);
    expect(parsed?.type).toBe('assistant');
    expect((parsed as any).uuid).toBe('u1');
    expect((parsed as any).extra_field).toEqual({ nested: true });
  });

  it('parses a valid user message', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'user',
      uuid: 'u2',
      message: { role: 'user', content: 'hello' },
    });
    expect(parsed?.type).toBe('user');
    expect((parsed as any).uuid).toBe('u2');
  });

  it('parses a progress message', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'progress',
      uuid: 'p1',
      status: 'running',
    });
    expect(parsed?.type).toBe('progress');
    expect((parsed as any)?.uuid).toBe('p1');
  });
});
