import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';

describe('ActionsSettingsV1Schema', () => {
  it('accepts a v1 settings object with disabled actions', async () => {
    const { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } = await import('./actionSettings.js');

    const parsed = ActionsSettingsV1Schema.parse({
      v: 1,
      disabledActionIds: ['review.start'],
    });
    expect(parsed.v).toBe(1);
    expect(parsed.disabledActionIds).toEqual(['review.start']);

    expect(isActionEnabledByActionsSettings('review.start' as any, parsed)).toBe(false);
    expect(isActionEnabledByActionsSettings('plan.start' as any, parsed)).toBe(true);

    // Ensure action ids remain the canonical ActionId schema.
    expect(() => ActionIdSchema.parse('review.start')).not.toThrow();
  });
});

