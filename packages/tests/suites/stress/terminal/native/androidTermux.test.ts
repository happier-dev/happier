import { describe, expect, it } from 'vitest';

import {
  classifyTerminalAccessibilityGate,
} from '../../../../src/testkit/terminal/accessibility';
import { shouldSelectNativeTerminalRenderer } from '../../../../src/testkit/terminal/native';

describe('stress: Android Termux terminal renderer gates', () => {
  it('keeps Android Termux unselected until legal/package/runtime proof pass', () => {
    const accessibility = classifyTerminalAccessibilityGate({
      renderer: 'android-termux',
      platform: 'android',
      nodes: [{ role: 'text', label: 'terminal output summary' }],
      actions: ['copy'],
    });

    expect(shouldSelectNativeTerminalRenderer({
      renderer: 'android-termux',
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
