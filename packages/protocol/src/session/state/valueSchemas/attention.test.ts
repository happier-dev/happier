import { describe, expect, it } from 'vitest';

import { SessionStateAttentionValueSchema } from './attention.js';

describe('SessionStateAttentionValueSchema', () => {
  it('accepts the semantic attention field value without persisted metadata wrapper keys', () => {
    expect(SessionStateAttentionValueSchema.safeParse({
      observedProgressToken: '10:m1',
      observedAtMs: 10,
    }).success).toBe(true);

    expect(SessionStateAttentionValueSchema.safeParse({
      v: 1,
      observedProgressToken: '10:m1',
      observedAtMs: 10,
    }).success).toBe(false);
  });
});
