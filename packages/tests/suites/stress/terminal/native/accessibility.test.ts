import { describe, expect, it } from 'vitest';

import { classifyTerminalAccessibilityGate } from '../../../../src/testkit/terminal/accessibility';
import { shouldSelectNativeTerminalRenderer } from '../../../../src/testkit/terminal/native';

describe('stress: terminal native renderer accessibility gates', () => {
  it('keeps native renderers unselected when the platform accessibility tree is opaque', () => {
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
      packageAvailable: true,
      runtimeAvailable: true,
      fallbackAvailable: true,
      accessibility,
    })).toBe(false);
  });

  it('allows native renderer selection only when package and accessibility gates both pass', () => {
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
      packageAvailable: true,
      runtimeAvailable: true,
      fallbackAvailable: true,
      accessibility,
    })).toBe(true);
  });
});
