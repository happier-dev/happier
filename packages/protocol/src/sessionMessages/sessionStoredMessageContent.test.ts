import { describe, expect, it } from 'vitest';

import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';

describe('SessionStoredMessageContentSchema', () => {
  it('accepts encrypted envelope', () => {
    const parsed = SessionStoredMessageContentSchema.safeParse({ t: 'encrypted', c: 'aGVsbG8=' });
    expect(parsed.success).toBe(true);
  });

  it('accepts plain envelope', () => {
    const parsed = SessionStoredMessageContentSchema.safeParse({ t: 'plain', v: { type: 'user', text: 'hi' } });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown envelope', () => {
    const parsed = SessionStoredMessageContentSchema.safeParse({ t: 'nope', c: 'x' });
    expect(parsed.success).toBe(false);
  });
});

