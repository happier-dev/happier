import { describe, expect, it } from 'vitest';

import { classifyTerminalAccessibilityGate } from './accessibility';
import { shouldSelectNativeTerminalRenderer } from './native';

function acceptedAccessibility() {
  return classifyTerminalAccessibilityGate({
    renderer: 'ios-ghosttykit',
    platform: 'ios',
    nodes: [{ role: 'text', label: 'terminal output summary' }],
    actions: ['copy'],
  });
}

describe('terminal native renderer selection', () => {
  it('requires every TERM native rollout gate before selecting a native renderer', () => {
    const ready = {
      renderer: 'ios-ghosttykit',
      embeddedPtyEnabled: true,
      byteStreamEnabled: true,
      nativeRendererEnabled: true,
      platformRendererEnabled: true,
      packageAvailable: true,
      runtimeAvailable: true,
      fallbackAvailable: true,
      accessibility: acceptedAccessibility(),
    } as const;

    expect(shouldSelectNativeTerminalRenderer(ready)).toBe(true);
    expect(shouldSelectNativeTerminalRenderer({ ...ready, embeddedPtyEnabled: false })).toBe(false);
    expect(shouldSelectNativeTerminalRenderer({ ...ready, byteStreamEnabled: false })).toBe(false);
    expect(shouldSelectNativeTerminalRenderer({ ...ready, nativeRendererEnabled: false })).toBe(false);
    expect(shouldSelectNativeTerminalRenderer({ ...ready, platformRendererEnabled: false })).toBe(false);
    expect(shouldSelectNativeTerminalRenderer({ ...ready, packageAvailable: false })).toBe(false);
    expect(shouldSelectNativeTerminalRenderer({ ...ready, runtimeAvailable: false })).toBe(false);
    expect(shouldSelectNativeTerminalRenderer({ ...ready, fallbackAvailable: false })).toBe(false);
  });

  it('rejects accessibility evidence collected for a different renderer', () => {
    expect(shouldSelectNativeTerminalRenderer({
      renderer: 'android-termux',
      embeddedPtyEnabled: true,
      byteStreamEnabled: true,
      nativeRendererEnabled: true,
      platformRendererEnabled: true,
      packageAvailable: true,
      runtimeAvailable: true,
      fallbackAvailable: true,
      accessibility: acceptedAccessibility(),
    })).toBe(false);
  });
});
