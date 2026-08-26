import { describe, expect, it } from 'vitest';

import {
  assertTerminalNativeDeviceRecipeCoverage,
  listTerminalNativeDeviceRecipes,
} from './native';

describe('terminal native device recipes', () => {
  it('covers every required TERM-7b workload, interaction, and accessibility observation', () => {
    const recipes = listTerminalNativeDeviceRecipes();

    expect(recipes.map((recipe) => recipe.renderer)).toEqual([
      'ios-ghosttykit',
      'android-termux',
    ]);
    expect(() => {
      for (const recipe of recipes) {
        assertTerminalNativeDeviceRecipeCoverage(recipe);
      }
    }).not.toThrow();
  });

  it('labels every recipe as a host contract rather than device evidence', () => {
    expect(listTerminalNativeDeviceRecipes()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceSource: 'loaded-native-app',
        hostContractIsDeviceEvidence: false,
      }),
    ]));
  });
});
