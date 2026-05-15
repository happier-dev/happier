import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('session message role schema', () => {
  it('accepts supported role metadata values', () => {
    const schema = protocol.SessionMessageRoleSchema;

    expect(schema.safeParse('user').success).toBe(true);
    expect(schema.safeParse('agent').success).toBe(true);
    expect(schema.safeParse('event').success).toBe(true);
    expect(schema.safeParse('unknown').success).toBe(true);
  });

  it('rejects unsupported role metadata values', () => {
    const schema = protocol.SessionMessageRoleSchema;

    expect(schema.safeParse('tool').success).toBe(false);
  });
});
