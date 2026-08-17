import { describe, expect, it } from 'vitest';

import { UpdateBodySchema } from './index.js';

describe('AccountChange update bodies', () => {
  it('accepts only the content-free AccountChange wake arm', () => {
    expect(UpdateBodySchema.safeParse({ t: 'account-change' }).success).toBe(true);
    expect(UpdateBodySchema.safeParse({
      t: 'account-change',
      pluginId: 'example.tasks',
    }).success).toBe(false);
  });
});
