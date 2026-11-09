import { describe, expect, it } from 'vitest';

import { UpdateBodySchema } from './index.js';

describe('account settings update bodies', () => {
  it('carries bounded policy status beside Settings versions without changing the Settings envelope', () => {
    for (const status of ['current', 'stale', 'disabled']) {
      const account = { t: 'update-account', id: 'account', settingsV2: { content: null, version: 12 }, remoteAlertPolicyStatus: status };
      const hint = { t: 'account-settings-changed', settingsVersion: 12, remoteAlertPolicyStatus: status };
      expect(UpdateBodySchema.parse(account)).toEqual(account);
      expect(UpdateBodySchema.parse(hint)).toEqual(hint);
    }
    expect(UpdateBodySchema.safeParse({ t: 'update-account', id: 'account', remoteAlertPolicyStatus: 'allowed' }).success).toBe(false);
    expect(UpdateBodySchema.safeParse({ t: 'account-settings-changed', settingsVersion: 12, remoteAlertPolicyStatus: 'allowed' }).success).toBe(false);
  });

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
