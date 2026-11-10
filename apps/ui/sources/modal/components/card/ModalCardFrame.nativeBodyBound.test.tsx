import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));

// An iPhone-sized native window: the card owner sizes its sheet from it.
installPopoverCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock(
      { platformOS: 'ios' },
      {
        useWindowDimensions: () => viewport,
        Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
      },
    );
  },
});

const { ModalCardFrame } = await import('./ModalCardFrame');

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style))
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flattenStyle(entry) }),
      {},
    );
  return typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

// NATIVE-AUDIT-1109: a native ScrollView lays its content out with unbounded height. The phone Customize (Bar)
// sheet's own row list therefore never got a height, never scrolled, and its last row (Settings) stayed clipped.
describe('ModalCardFrame body on native', () => {
  it.each(['body', 'bounded'] as const)(
    'hands content that owns its scrolling exactly the %s card body, so its last row is reachable',
    async (scrollHost) => {
      const screen = await renderScreen(
        <ModalCardFrame
          presentation="sheet"
          scrollHost={scrollHost}
          bodyScroll="none"
          title="Bar"
          dimensions={{ size: 'lg' }}
        >
          {React.createElement('RowList')}
        </ModalCardFrame>,
      );
      const body = () => screen.findAllByType('ScrollView')[0]!;
      act(() =>
        body().props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 612 } },
        }),
      );
      // The one scroller is the content's own list: the body stays still and bounds it to its own height.
      expect(body().props.scrollEnabled).toBe(false);
      expect(flattenStyle(body().props.contentContainerStyle).maxHeight).toBe(
        612,
      );
    },
  );

  it('leaves a scrolling body unbounded: there the body is the one scroller', async () => {
    const screen = await renderScreen(
      <ModalCardFrame
        presentation="sheet"
        scrollHost="bounded"
        bodyScroll="auto"
        title="Form"
        dimensions={{ size: 'lg' }}
      >
        {React.createElement('Form')}
      </ModalCardFrame>,
    );
    const body = screen.findAllByType('ScrollView')[0]!;
    expect(body.props.scrollEnabled).toBe(true);
    expect(body.props.onLayout).toBeUndefined();
    expect(
      flattenStyle(body.props.contentContainerStyle).maxHeight,
    ).toBeUndefined();
  });
});
