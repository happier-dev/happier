import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import {
  resolveDisabledVoiceActionIdsFromState,
  resolveEnabledVoiceToolActionSpecsFromState,
} from './resolveDisabledVoiceActionIds';

const CURRENT_UI_ACTION_IDS = [
  'ui.current_context.read',
  'ui.current_context.command.invoke',
] as const;

function stateWithCurrentUiContextMode(currentUiContextMode: 'off' | 'on_demand' | 'automatic') {
  return {
    settings: {
      ...settingsDefaults,
      voice: {
        ...settingsDefaults.voice,
        privacy: {
          ...settingsDefaults.voice.privacy,
          currentUiContextMode,
          shareDeviceInventory: true,
        },
      },
    },
  };
}

function enabledVoiceActionIds(state: Readonly<{ settings?: unknown }>): readonly string[] {
  return resolveEnabledVoiceToolActionSpecsFromState(state).map((spec) => String(spec.id));
}

describe('voice Action catalog current-UI privacy', () => {
  it('withholds current-UI Action specs from the next Local Voice attempt when sharing is off', () => {
    const state = stateWithCurrentUiContextMode('off');
    const enabledIds = enabledVoiceActionIds(state);
    const disabledIds = resolveDisabledVoiceActionIdsFromState(state);

    expect(enabledIds).not.toEqual(expect.arrayContaining([...CURRENT_UI_ACTION_IDS]));
    expect(disabledIds).toEqual(expect.arrayContaining([...CURRENT_UI_ACTION_IDS]));
    expect(enabledIds).toContain('action.spec.search');
    expect(disabledIds).not.toContain('action.spec.search');
  });

  it.each(['on_demand', 'automatic'] as const)(
    'keeps current-UI Action specs in the next Local Voice attempt when sharing is %s',
    (currentUiContextMode) => {
      const state = stateWithCurrentUiContextMode(currentUiContextMode);
      const enabledIds = enabledVoiceActionIds(state);
      const disabledIds = resolveDisabledVoiceActionIdsFromState(state);

      expect(enabledIds).toEqual(expect.arrayContaining([...CURRENT_UI_ACTION_IDS]));
      expect(disabledIds).not.toEqual(expect.arrayContaining([...CURRENT_UI_ACTION_IDS]));
    },
  );
});
