import { describe, expect, it } from 'vitest';

import {
  assertTerminalNativeDeviceRecipeCoverage,
  getTerminalNativeDeviceRecipe,
} from '../../../../src/testkit/terminal/native';

describe('stress: Android Termux device recipe contract', () => {
  it('requires Android native rendering, interaction, fallback, and loaded-app evidence', () => {
    const recipe = getTerminalNativeDeviceRecipe('android-termux');

    expect(recipe.platform).toBe('android');
    expect(recipe.requiredWorkloads).toEqual(expect.arrayContaining([
      'ansi-burst',
      'heavy-tui-redraw',
      'bracketed-paste-echo',
      'long-scrollback',
    ]));
    expect(recipe.requiredActions).toEqual(expect.arrayContaining([
      'async-byte-write-ack-reject-retry',
      'ime-composition',
      'selection-copy',
      'renderer-crash-fallback',
      'background-resume',
    ]));
    expect(() => assertTerminalNativeDeviceRecipeCoverage(recipe)).not.toThrow();
  });
});
