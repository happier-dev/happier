import { describe, expect, it } from 'vitest';

import {
  accountSettingsParse,
  DEFAULT_ACTIONS_SETTINGS_V1,
  DEFAULT_NOTIFICATIONS_SETTINGS_V1,
  type AccountSettings,
} from './accountSettings.js';

describe('accountSettingsParse', () => {
  it('applies defaults for known subtrees', () => {
    const parsed = accountSettingsParse({});

    expect(parsed.notificationsSettingsV1).toEqual(DEFAULT_NOTIFICATIONS_SETTINGS_V1);
    expect(parsed.actionsSettingsV1).toEqual(DEFAULT_ACTIONS_SETTINGS_V1);
  });

  it('preserves unknown keys', () => {
    const parsed = accountSettingsParse({ someNewKey: { nested: true } });
    expect((parsed as any).someNewKey).toEqual({ nested: true });
  });

  it('tolerates invalid known subtrees (falls back to defaults for that subtree)', () => {
    const parsed = accountSettingsParse({
      actionsSettingsV1: 'nope',
      notificationsSettingsV1: { v: 1, ready: 'nope' },
      unknownStillThere: 123,
    });

    expect(parsed.actionsSettingsV1).toEqual(DEFAULT_ACTIONS_SETTINGS_V1);
    expect(parsed.notificationsSettingsV1).toEqual(DEFAULT_NOTIFICATIONS_SETTINGS_V1);
    expect((parsed as any).unknownStillThere).toBe(123);
  });

  it('returns defaults when raw is not an object', () => {
    const parsed = accountSettingsParse(null);
    expect(parsed.notificationsSettingsV1).toEqual(DEFAULT_NOTIFICATIONS_SETTINGS_V1);
  });

  it('returns a stable object shape', () => {
    const parsed: AccountSettings = accountSettingsParse({ schemaVersion: 2 });
    expect(typeof parsed.schemaVersion).toBe('number');
  });
});

