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

// C77 (Home widget cards, 11-17): a card's scroll area whose content ran past it held no control, so a keyboard could
// never reach or scroll it. A scroll area takes focus exactly while its content overflows it.
describe('HappierScrollArea keyboard reach', () => {
  function layoutTo(view: { props: Record<string, unknown> }, size: Readonly<{ width: number; height: number }>, content: Readonly<{ width: number; height: number }>) {
    act(() => {
      (view.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, ...size } } });
      (view.props.onContentSizeChange as (width: number, height: number) => void)(content.width, content.height);
    });
  }
  const area = () => renderer!.root.find((node) => (node.type as unknown) === 'ScrollView');

  it('is focusable while its content overflows it, and not while everything fits', () => {
    act(() => { renderer = create(<HappierScrollArea testID="area" />); });
    expect(area().props.focusable).toBeUndefined();
    layoutTo(area(), { width: 497, height: 232 }, { width: 497, height: 235 });
    expect(area().props.focusable).toBe(true);
    layoutTo(area(), { width: 497, height: 232 }, { width: 497, height: 200 });
    expect(area().props.focusable).toBeUndefined();
  });

  it('measures a horizontal strip along its own axis, and never focuses a scroll area that cannot scroll', () => {
    act(() => { renderer = create(<HappierScrollArea testID="row" horizontal />); });
    layoutTo(area(), { width: 300, height: 40 }, { width: 640, height: 40 });
    expect(area().props.focusable).toBe(true);
    act(() => { renderer!.update(<HappierScrollArea testID="row" horizontal scrollEnabled={false} />); });
    expect(area().props.focusable).toBeUndefined();
  });
});
