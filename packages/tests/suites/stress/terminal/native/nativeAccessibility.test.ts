import { describe, expect, it } from 'vitest';

import { classifyTerminalAccessibilityGate } from '../../../../src/testkit/terminal/accessibility';

describe('stress: native terminal accessibility model', () => {
  it('requires useful terminal content or explicit actions before accepting native accessibility', () => {
    expect(classifyTerminalAccessibilityGate({
      renderer: 'ios-ghosttykit',
      platform: 'ios',
      nodes: [{ role: 'other' }],
      actions: [],
    })).toEqual({
      state: 'fallback-required',
      reason: 'opaque-tree',
      renderer: 'ios-ghosttykit',
      platform: 'ios',
    });

    expect(classifyTerminalAccessibilityGate({
      renderer: 'android-termux',
      platform: 'android',
      nodes: [],
      actions: ['accessibility-summary'],
    })).toEqual({
      state: 'accepted',
      renderer: 'android-termux',
      platform: 'android',
    });
  });
});
