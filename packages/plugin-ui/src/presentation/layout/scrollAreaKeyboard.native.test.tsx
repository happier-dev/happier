import * as React from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: {
    get OS() {
      return platform.OS;
    },
    select: <T,>(
      options: Readonly<{ ios?: T; android?: T; native?: T; default?: T }>,
    ) =>
      (platform.OS === 'ios' ? options.ios : options.android) ??
      options.native ??
      options.default,
  },
  ScrollView: 'ScrollView',
  View: 'View',
  Text: 'Text',
  StyleSheet: { hairlineWidth: 1, flatten: (style: unknown) => style },
}));

import { HappierScrollArea } from './Layout.js';

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

function scrollViewProps(): Record<string, unknown> {
  act(() => {
    renderer = create(<HappierScrollArea testID="area" />);
  });
  return renderer!.root.find((node) => (node.type as unknown) === 'ScrollView')
    .props;
}

// Live 2026-11-11 (iOS, Triage New task): a form opened with its title focused, and nothing could put the keyboard
// away, so the fields below it could not be reached. A scroll area's content lets the keyboard go when dragged.
describe('HappierScrollArea keyboard', () => {
  it('lets a drag of its content dismiss the keyboard on iOS, following the finger', () => {
    platform.OS = 'ios';
    expect(scrollViewProps().keyboardDismissMode).toBe('interactive');
  });

  it('dismisses the keyboard on drag on Android', () => {
    platform.OS = 'android';
    expect(scrollViewProps().keyboardDismissMode).toBe('on-drag');
  });

  it('keeps taps inside the content working while the keyboard is up', () => {
    platform.OS = 'ios';
    expect(scrollViewProps().keyboardShouldPersistTaps).toBe('handled');
  });
});
