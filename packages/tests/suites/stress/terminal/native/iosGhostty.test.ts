import { describe, expect, it } from 'vitest';

import {
  classifyTerminalAccessibilityGate,
} from '../../../../src/testkit/terminal/accessibility';
import { shouldSelectNativeTerminalRenderer } from '../../../../src/testkit/terminal/native';

describe('stress: iOS Ghostty terminal renderer gates', () => {
  it('keeps iOS Ghostty unselected until package and accessibility proof pass', () => {
    const accessibility = classifyTerminalAccessibilityGate({
      renderer: 'ios-ghosttykit',
      platform: 'ios',
      nodes: [{ role: 'other' }],
      actions: [],
    });

    expect(shouldSelectNativeTerminalRenderer({
      renderer: 'ios-ghosttykit',
      embeddedPtyEnabled: true,
      byteStreamEnabled: true,
      nativeRendererEnabled: true,
      platformRendererEnabled: true,
      packageAvailable: false,
      runtimeAvailable: false,
      fallbackAvailable: true,
      accessibility,
    })).toBe(false);
  });
});
