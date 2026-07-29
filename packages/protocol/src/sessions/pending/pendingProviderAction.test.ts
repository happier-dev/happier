import { describe, expect, it } from 'vitest';

import { PendingProviderActionSchema } from './pendingProviderAction.js';

describe('PendingProviderActionSchema', () => {
  it.each(['send', 'steer', 'interrupt_and_send'] as const)('accepts %s', (value) => {
    expect(PendingProviderActionSchema.parse(value)).toBe(value);
  });

  it.each([null, 'send_now', 'interrupt', ''])('rejects %j', (value) => {
    expect(PendingProviderActionSchema.safeParse(value).success).toBe(false);
  });
});
