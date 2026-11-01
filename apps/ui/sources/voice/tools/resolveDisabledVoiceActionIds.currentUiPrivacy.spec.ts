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
      experiments: true,
      featureToggles: {
        ...settingsDefaults.featureToggles,
        voice: true,
      },
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
  it('uses the admitted Session memory choice for offered write tools while global Voice keeps its own availability', () => {
    const state = stateWithCurrentUiContextMode('automatic');
    const off = { sessionMetadata: { work: { memoryEnabled: false } } };
    const on = { sessionMetadata: { work: { memoryEnabled: true } } };
    const writes = ['memory.remember', 'memory.update', 'memory.forget'] as const;
    expect(resolveDisabledVoiceActionIdsFromState(state, off)).toEqual(expect.arrayContaining([...writes]));
    const offEnabled = resolveEnabledVoiceToolActionSpecsFromState(state, off).map(spec => spec.id);
    const onEnabled = resolveEnabledVoiceToolActionSpecsFromState(state, on).map(spec => spec.id);
    const globalEnabled = enabledVoiceActionIds(state);
    const onDisabled = resolveDisabledVoiceActionIdsFromState(state, on);
    const globalDisabled = resolveDisabledVoiceActionIdsFromState(state);
    for (const actionId of writes) {
      expect(offEnabled).not.toContain(actionId);
      expect(onDisabled).not.toContain(actionId);
      expect(globalDisabled).not.toContain(actionId);
      expect(onEnabled).toContain(actionId);
      expect(globalEnabled).toContain(actionId);
    }
    expect(offEnabled).toContain('memory.read');
  });
  it('withholds current-UI Action specs from the next Local Voice attempt when sharing is off', () => {
    const state = stateWithCurrentUiContextMode('off');
    const enabledIds = enabledVoiceActionIds(state);
    const disabledIds = resolveDisabledVoiceActionIdsFromState(state);

    for (const actionId of CURRENT_UI_ACTION_IDS) expect(enabledIds).not.toContain(actionId);
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
      for (const actionId of CURRENT_UI_ACTION_IDS) expect(disabledIds).not.toContain(actionId);
    },
  );

  it('withholds every retained Voice Action when the Voice feature is disabled', () => {
    const state = stateWithCurrentUiContextMode('automatic');
    state.settings = {
      ...state.settings,
      experiments: true,
      featureToggles: { ...state.settings.featureToggles, voice: false },
    };

    expect(enabledVoiceActionIds(state)).toEqual([]);
    expect(resolveDisabledVoiceActionIdsFromState(state)).toContain('action.spec.search');
  });
});
