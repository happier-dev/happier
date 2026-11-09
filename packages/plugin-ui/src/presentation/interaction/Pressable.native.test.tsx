import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The native SDK is the boundary: Unistyles' native Pressable enumerates a
// static style with Object.keys (undefined defaults to {}, null throws).
// Keep the shared interaction and focus-style producers real beneath it.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  Pressable: React.forwardRef<unknown, Readonly<{ style?: unknown; children?: React.ReactNode }>>(
    function NativePressable({ style = {}, ...props }, ref) {
      if (typeof style !== 'function') Object.keys(style as object);
      return React.createElement('Pressable', { ...props, style, ref });
    },
  ),
}));

import { HappierPressable } from './Pressable.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE } from './focusVisible.js';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('native shared pressable', () => {
  it('mounts and activates a control whose focus ring is delegated to its child', async () => {
    const onPress = vi.fn();
    await act(async () => {
      renderer = create(<HappierPressable onPress={onPress} style={HAPPIER_FOCUS_RING_DELEGATED_STYLE}>Continue</HappierPressable>);
    });
    const control = renderer!.root.findByType('Pressable');
    await act(async () => { control.props.onPress(); });
    expect(onPress).toHaveBeenCalledOnce();
    expect(control.props.children).toBe('Continue');
  });
});
