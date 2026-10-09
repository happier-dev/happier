import { describe, expect, it } from 'vitest';
import { isAccountSettingActionSurfaceAllowedV1, isPresentUserSettingWriteV1 } from './accountSettingDeclarations.js';

describe('Account transcript visibility setting admission', () => {
  it('keeps every preference mutation human-only without restricting unrelated settings', () => {
    for (const actionId of ['settings.set', 'settings.reset', 'settings.invoke']) {
      const input = { anchor: 'transcript.showToolCalls' };
      expect(isPresentUserSettingWriteV1(actionId, input)).toBe(true);
      for (const surface of ['agent', 'mcp']) {
        expect(isAccountSettingActionSurfaceAllowedV1(actionId, input, surface)).toBe(false);
        expect(isAccountSettingActionSurfaceAllowedV1(actionId, { anchor: 'delegation.workDepthLimit' }, surface)).toBe(true);
      }
      expect(isAccountSettingActionSurfaceAllowedV1(actionId, input, 'ui')).toBe(true);
      expect(isAccountSettingActionSurfaceAllowedV1(actionId, input, 'cli')).toBe(true);
    }
  });
});
