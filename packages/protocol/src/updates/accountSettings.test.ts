import { describe, expect, it } from 'vitest';

import { UpdateBodySchema } from './index.js';

describe('account settings update bodies', () => {
  it('accepts compact account settings changed hints without settings content', () => {
    const parsed = UpdateBodySchema.parse({
      t: 'account-settings-changed',
      settingsVersion: 12,
    });

    expect(parsed).toEqual({
      t: 'account-settings-changed',
      settingsVersion: 12,
    });
  });
});
