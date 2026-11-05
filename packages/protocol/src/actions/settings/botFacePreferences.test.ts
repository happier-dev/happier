import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';

describe('Bot and Session appearance preferences', () => {
  it('defaults Bots to Dither while preserving saved Session styles and the brutalist fallback', () => {
    expect(accountSettingsParse({})).toMatchObject({ botFaceStyle: 'dither', avatarStyle: 'brutalist' });
    expect(accountSettingsParse({ botFaceStyle: 'digits', avatarStyle: 'unknown' }))
      .toMatchObject({ botFaceStyle: 'dither', avatarStyle: 'brutalist' });
    for (const avatarStyle of ['pixelated', 'gradient', 'brutalist', 'planet']) {
      expect(accountSettingsParse({ avatarStyle })).toHaveProperty('avatarStyle', avatarStyle);
    }
  });
});
