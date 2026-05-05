import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { resolveEffectiveSessionTmuxFromAccountSettings } from './resolveEffectiveSessionTmuxFromAccountSettings';

describe('resolveEffectiveSessionTmuxFromAccountSettings', () => {
  it('uses the global session tmux setting when no machine override exists', () => {
    expect(resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: accountSettingsParse({ sessionUseTmux: true }),
      currentMachineId: 'machine-a',
    })).toEqual({ useTmux: true, source: 'global' });
  });

  it('uses the matching machine override ahead of the global setting', () => {
    expect(resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: accountSettingsParse({
        sessionUseTmux: true,
        sessionTmuxByMachineId: {
          'machine-a': { useTmux: false },
        },
      }),
      currentMachineId: 'machine-a',
    })).toEqual({ useTmux: false, source: 'machine-override' });
  });

  it('falls back to the default when settings are unavailable', () => {
    expect(resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: null,
      currentMachineId: 'machine-a',
    })).toEqual({ useTmux: false, source: 'default' });
  });
});
