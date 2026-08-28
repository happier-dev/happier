import { describe, expect, it } from 'vitest';

import {
  assertTerminalNativeDeviceRecipeCoverage,
  getTerminalNativeDeviceRecipe,
} from '../../../../src/testkit/terminal/native';

describe('stress: iOS Ghostty device recipe contract', () => {
  it('requires iOS native rendering, interaction, fallback, and loaded-app evidence', () => {
    const recipe = getTerminalNativeDeviceRecipe('ios-ghosttykit');

    expect(recipe.platform).toBe('ios');
    expect(recipe.requiredWorkloads).toEqual(expect.arrayContaining([
      'ansi-burst',
      'heavy-tui-redraw',
      'wide-combining',
      'link-heavy-output',
    ]));
    expect(recipe.requiredActions).toEqual(expect.arrayContaining([
      'async-byte-write-ack-reject-retry',
      'hardware-keyboard-chords',
      'selection-copy',
      'renderer-crash-fallback',
      'background-resume',
      'resize-orientation',
    ]));
    expect(() => assertTerminalNativeDeviceRecipeCoverage(recipe)).not.toThrow();
  });
});
