import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { View } from 'react-native';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'android' });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@react-native-masked-view/masked-view', () => ({
  default: 'MaskedView',
}));

const { AgentInputScrollableChipRow } =
  await import('./AgentInputScrollableChipRow');

afterEach(standardCleanup);

function renderMask(element: unknown): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(element as React.ReactElement);
  });
  return tree;
}

const CONTENT_STYLE = { flexDirection: 'row' } as const;
// Four chips in content coordinates; the rail shows 300 of them.
const CHIPS = [
  [0, 80],
  [90, 200],
  [210, 260],
  [270, 360],
] as const;
const VIEWPORT = 300;

function rect(left: number, right: number) {
  return { left, right, width: right - left, top: 0, bottom: 32, height: 32 };
}

/** React Native's element tree (DOM node API) for the rail's content view, scrolled by `scrollX()`. */
function contentNode(scrollX: () => number) {
  const children = CHIPS.map(([left, right]) => ({
    getBoundingClientRect: () => rect(left - scrollX(), right - scrollX()),
  }));
  return {
    children,
    getBoundingClientRect: () => rect(-scrollX(), 384 - scrollX()),
  };
}

describe('AgentInputScrollableChipRow (native)', () => {
  it('masks an overflowing rail so its trailing edge ends between two whole chips', async () => {
    let scrollX = 0;
    const screen = await renderScreen(
      <AgentInputScrollableChipRow
        indicatorColor="#888"
        contentStyle={CONTENT_STYLE}
      >
        {CHIPS.map(([left]) => (
          <View key={left} />
        ))}
      </AgentInputScrollableChipRow>,
      {
        createNodeMock: (element) =>
          element.props.style === CONTENT_STYLE
            ? contentNode(() => scrollX)
            : {},
      },
    );
    const scroll = () =>
      screen.root.find(
        (node) =>
          typeof node.type === 'string' &&
          node.props.accessibilityRole === 'toolbar',
      );
    await act(async () => {
      scroll().props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: VIEWPORT, height: 32 } },
      });
      scroll().props.onContentSizeChange(384, 32);
    });
    // The rail remounts inside the mask once it overflows; it measures again from there.
    await act(async () => {
      scroll().props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: VIEWPORT, height: 32 } },
      });
      scroll().props.onContentSizeChange(384, 32);
    });

    const masked = screen.root.find((node) => node.type === 'MaskedView');
    const shape = renderMask(masked.props.maskElement as React.ReactElement,
    );
    const solid = shape.root.find(
      (node) => node.props.testID === 'scroll-edge-mask-solid',
    );
    const end = shape.root.find(
      (node) => node.props.testID === 'scroll-edge-mask-end',
    );
    const flat = (style: unknown) =>
      Object.assign({}, ...([style].flat(3) as object[]));
    // Solid through the third chip (ends at 260), clear from the fourth (starts at 270): the cut chip goes whole.
    expect(flat(solid.props.style)).toMatchObject({ left: 0, width: 260 });
    expect(flat(end.props.style)).toMatchObject({ left: 260, width: 10 });

    // Scrolled part-way, the leading edge also ends between chips (the first chip is cut).
    scrollX = 50;
    await act(async () => {
      scroll().props.onScroll({
        nativeEvent: {
          contentOffset: { x: 50, y: 0 },
          contentSize: { width: 384, height: 32 },
          layoutMeasurement: { width: VIEWPORT, height: 32 },
        },
      });
    });
    const scrolled = renderMask(screen.root.find((node) => node.type === 'MaskedView').props
        .maskElement as React.ReactElement,
    );
    const start = scrolled.root.find(
      (node) => node.props.testID === 'scroll-edge-mask-start',
    );
    expect(flat(start.props.style)).toMatchObject({ left: 30, width: 10 });
  });
  it('comes to rest with a whole chip after the leading indicator, never part-way into one', async () => {
    const screen = await renderScreen(
      <AgentInputScrollableChipRow indicatorColor="#888" contentStyle={CONTENT_STYLE}>
        {CHIPS.map(([left]) => (
          <View key={left} />
        ))}
      </AgentInputScrollableChipRow>,
      {
        createNodeMock: (element) =>
          element.props.style === CONTENT_STYLE ? contentNode(() => 0) : {},
      },
    );
    const scroll = () =>
      screen.root.find(
        (node) =>
          typeof node.type === 'string' &&
          node.props.accessibilityRole === 'toolbar',
      );
    for (let pass = 0; pass < 2; pass += 1) {
      await act(async () => {
        scroll().props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: VIEWPORT, height: 32 } },
        });
        scroll().props.onContentSizeChange(384, 32);
      });
    }
    // Rest points: the start, then each chip seated 24 px in (the indicator's room), within the 84 px
    // scroll range; the range's end stays a rest point of its own.
    expect(scroll().props.snapToOffsets).toEqual([0, 66]);
    expect(scroll().props.snapToEnd).not.toBe(false);
  });
});
