import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { resolveEffectiveSessionTmuxFromAccountSettings } from './resolveEffectiveSessionTmuxFromAccountSettings';

describe('resolveEffectiveSessionTmuxFromAccountSettings', () => {
  it('returns the global value when no machine override is set', () => {
    const settings = accountSettingsParse({ sessionUseTmux: true });
    const resolved = resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: settings,
      currentMachineId: 'machine-a',
    });
    expect(resolved).toEqual({ useTmux: true, source: 'global' });
  });

  it('returns false from the global value when the user has not enabled tmux', () => {
    const settings = accountSettingsParse({ sessionUseTmux: false });
    const resolved = resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: settings,
      currentMachineId: 'machine-a',
    });
    expect(resolved).toEqual({ useTmux: false, source: 'global' });
  });

  it('returns the per-machine override when it is set, regardless of global', () => {
    // Global says off; override for this machine says on. Override must win.
    const settings = accountSettingsParse({
      sessionUseTmux: false,
      sessionTmuxByMachineId: {
        'machine-a': { useTmux: true },
      },
    });
    const resolved = resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: settings,
      currentMachineId: 'machine-a',
    });
    expect(resolved).toEqual({ useTmux: true, source: 'machine-override' });
  });

  it('uses the override even when it disables what the global enables', () => {
    // Global says on; override for this machine says off. Real-world case
    // we want the footer hint to recognise — user thinks tmux is on
    // because the global toggle is on, but they explicitly turned it off
    // for this machine.
    const settings = accountSettingsParse({
      sessionUseTmux: true,
      sessionTmuxByMachineId: {
        'machine-a': { useTmux: false },
      },
    });
    const resolved = resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: settings,
      currentMachineId: 'machine-a',
    });
    expect(resolved).toEqual({ useTmux: false, source: 'machine-override' });
  });

  it('falls through to the global when the override is for a different machine', () => {
    const settings = accountSettingsParse({
      sessionUseTmux: true,
      sessionTmuxByMachineId: {
        'other-machine': { useTmux: false },
      },
    });
    const resolved = resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: settings,
      currentMachineId: 'machine-a',
    });
    expect(resolved).toEqual({ useTmux: true, source: 'global' });
  });

  it('returns the default (off) when account settings is null or undefined', () => {
    expect(resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: null,
      currentMachineId: 'machine-a',
    })).toEqual({ useTmux: false, source: 'default' });
    expect(resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: undefined,
      currentMachineId: 'machine-a',
    })).toEqual({ useTmux: false, source: 'default' });
  });

  it('falls through to global when machineId is empty', () => {
    const settings = accountSettingsParse({
      sessionUseTmux: true,
      sessionTmuxByMachineId: {
        'machine-a': { useTmux: false },
      },
    });
    const resolved = resolveEffectiveSessionTmuxFromAccountSettings({
      accountSettings: settings,
      currentMachineId: null,
    });
    expect(resolved).toEqual({ useTmux: true, source: 'global' });
  });
});
