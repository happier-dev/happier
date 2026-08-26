import { describe, expect, it } from 'vitest';

import {
  TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS,
} from '../../../../src/testkit/terminal/accessibility';
import { listTerminalNativeDeviceRecipes } from '../../../../src/testkit/terminal/native';

describe('stress: native terminal accessibility device recipe contract', () => {
  it('requires accessibility-tree, screen-reader, and terminal-affordance observations from the loaded app', () => {
    for (const recipe of listTerminalNativeDeviceRecipes()) {
      expect(recipe.requiredAccessibilityEvidence).toEqual(
        TERMINAL_NATIVE_ACCESSIBILITY_DEVICE_EVIDENCE_IDS,
      );
      expect(recipe.evidenceSource).toBe('loaded-native-app');
      expect(recipe.hostContractIsDeviceEvidence).toBe(false);
    }
  });
});
