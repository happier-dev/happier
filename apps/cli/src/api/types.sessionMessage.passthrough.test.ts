import { describe, expect, it } from 'vitest';

import { SessionMessageSchema } from '@/api/types';

describe('SessionMessageSchema', () => {
  it('preserves unknown keys from server payloads (forward compatibility)', () => {
    const parsed = SessionMessageSchema.parse({
      id: 'm1',
      seq: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      localId: null,
      sidechainId: null,
      content: { t: 'plain', v: { ok: true } },
      someFutureServerField: { nested: true },
    });

    expect(parsed.id).toBe('m1');
    expect((parsed as any).someFutureServerField).toEqual({ nested: true });
  });
});

