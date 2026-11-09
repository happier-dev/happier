import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { isApprovalRequiredByActionsSettings } from '../actionApprovalPolicy.js';
import {
  buildBuiltInAccountSettingMutationV1,
  readBuiltInAccountSettingValueV1,
  readBuiltInSettingDeclarationV1,
  readBuiltInSettingsWriteSafetyV1,
  resolveBuiltInAccountSettingResetValueV1,
} from './settingsDeclarations.js';

describe('Bot and Session appearance preferences', () => {
  it('defaults Bots to Dither while preserving saved Session styles and the brutalist fallback', () => {
    expect(accountSettingsParse({})).toMatchObject({ botFaceStyle: 'dither', avatarStyle: 'brutalist' });
    expect(accountSettingsParse({ botFaceStyle: 'digits', avatarStyle: 'unknown' }))
      .toMatchObject({ botFaceStyle: 'dither', avatarStyle: 'brutalist' });
    for (const avatarStyle of ['pixelated', 'gradient', 'brutalist', 'planet']) {
      expect(accountSettingsParse({ avatarStyle })).toHaveProperty('avatarStyle', avatarStyle);
    }
  });

  it('discovers, reads, edits and resets both cosmetics through their declared Account owner', () => {
    for (const [anchor, key, choices, fallback] of [
      ['appearance.botFaceStyle', 'botFaceStyle', ['dither', 'pixel', 'solid', 'dots', 'planet'], 'dither'],
      ['appearance.botMotion', 'botMotion', ['lively', 'reactions', 'still'], 'lively'],
      ['appearance.avatarStyle', 'avatarStyle', ['pixelated', 'gradient', 'brutalist', 'planet'], 'brutalist'],
    ] as const) {
      const declaration = readBuiltInSettingDeclarationV1(anchor);
      expect(declaration).toMatchObject({ agentSafety: 'safe', sensitive: false,
        storage: { scope: 'account', key, access: 'read_write', allowedValues: choices } });
      if (!declaration) throw new Error(`Missing appearance preference: ${anchor}`);
      const baseline = accountSettingsParse({});
      expect(readBuiltInAccountSettingValueV1(declaration, baseline)).toBe(fallback);
      expect(readBuiltInSettingsWriteSafetyV1({ anchor })).toBe('safe');
      for (const actionId of ['settings.set', 'settings.reset'] as const) {
        expect(isApprovalRequiredByActionsSettings(actionId, baseline.actionsSettingsV1,
          { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
          undefined, undefined, { anchor, value: fallback })).toBe(false);
      }
      for (const value of choices) {
        const delta = buildBuiltInAccountSettingMutationV1(declaration, baseline, value);
        expect(delta).toEqual({ [key]: value });
        expect(readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({ ...baseline, ...delta }))).toBe(value);
      }
      expect(buildBuiltInAccountSettingMutationV1(declaration, baseline, 'digits')).toBeNull();
      expect(resolveBuiltInAccountSettingResetValueV1(declaration)).toEqual({ success: true, value: fallback });
    }
  });
});
