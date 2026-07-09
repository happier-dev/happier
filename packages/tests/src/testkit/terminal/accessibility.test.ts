import { describe, expect, it } from 'vitest';

import { classifyTerminalAccessibilityGate } from './accessibility';

describe('terminal accessibility gates', () => {
  it('requires fallback when a native terminal surface is an opaque node', () => {
    expect(
      classifyTerminalAccessibilityGate({
        renderer: 'ios-ghosttykit',
        platform: 'ios',
        nodes: [{ role: 'other', label: '' }],
        actions: [],
      }),
    ).toEqual({
      state: 'fallback-required',
      reason: 'opaque-tree',
      renderer: 'ios-ghosttykit',
      platform: 'ios',
    });
  });

  it('accepts a renderer when useful terminal text or actions are exposed', () => {
    expect(
      classifyTerminalAccessibilityGate({
        renderer: 'xterm-webview',
        platform: 'android',
        nodes: [{ role: 'text', label: 'build complete' }],
        actions: ['copy', 'open-link'],
      }).state,
    ).toBe('accepted');
  });
});
