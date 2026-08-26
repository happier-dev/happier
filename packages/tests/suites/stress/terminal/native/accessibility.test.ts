import { describe, expect, it } from 'vitest';

import { listTerminalNativeDeviceRecipes } from '../../../../src/testkit/terminal/native';

describe('stress: native terminal device recipe boundary', () => {
  it('does not treat host-suite success as native device or accessibility evidence', () => {
    const recipes = listTerminalNativeDeviceRecipes();

    expect(recipes).toHaveLength(2);
    expect(recipes.every((recipe) => recipe.hostContractIsDeviceEvidence === false)).toBe(true);
    expect(recipes.every((recipe) => recipe.evidenceSource === 'loaded-native-app')).toBe(true);
  });
});
