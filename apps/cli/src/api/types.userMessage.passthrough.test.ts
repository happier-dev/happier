import { describe, expect, it } from 'vitest';

import { UserMessageSchema } from '@/api/types';

describe('UserMessageSchema', () => {
  it('preserves unknown keys on user messages (forward compatibility)', () => {
    const parsed = UserMessageSchema.parse({
      role: 'user',
      content: { type: 'text', text: 'hello', extraBlockField: true },
      createdAt: Date.now(),
      someFutureField: { nested: true },
    });

    expect(parsed.role).toBe('user');
    expect((parsed as any).someFutureField).toEqual({ nested: true });
    expect((parsed.content as any).extraBlockField).toBe(true);
  });
});

