import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

// The virtualized list's imperative scroll is the platform boundary: it is what moves rows under the pointer.
const scrollToIndex =
  vi.fn<
    (args: { index: number; animated?: boolean; viewPosition?: number }) => void
  >();
const { module: capturedLegendList } = createCapturingLegendListMock({
  renderItems: true,
  refHandle: { scrollToIndex, scrollToOffset: vi.fn() },
});
vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LegendList: capturedLegendList.LegendList,
}));

const { SelectionList } = await import('../SelectionList');

const ROOT_STEP: SelectionListStep = {
  id: 'root',
  inputPlaceholder: 'Search',
  sections: [
    {
      kind: 'static',
      id: 'sessions',
      virtualization: 'force',
      options: Array.from({ length: 60 }, (_, index) => ({
        id: `opt-${index}`,
        label: `Session ${index}`,
      })),
    },
  ],
};

function props(): SelectionListProps {
  return {
    rootStep: ROOT_STEP,
    onSelect: vi.fn(),
    onRequestClose: vi.fn(),
    keyboardHintsEnabled: false,
    disableTransitions: true,
    testID: 'sl',
  };
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

async function movePointerOver(screen: Screen, id: string): Promise<void> {
  const root = screen
    .findAllByTestId('sl')
    .find((node) => typeof node.props?.onMouseMove === 'function');
  const row = screen
    .findAllByTestId(`sl:root:option:${id}`)
    .find((node) => typeof node.props?.onHoverIn === 'function');
  expect(root).toBeDefined();
  expect(row).toBeDefined();
  await act(async () => {
    (root!.props.onMouseMove as () => void)();
  });
  await act(async () => {
    (row!.props.onHoverIn as () => void)();
  });
}

async function pressKey(screen: Screen, key: string): Promise<void> {
  const header = screen
    .findAllByTestId('sl:header')
    .find((node) => typeof node.props?.onKeyPress === 'function');
  await act(async () => {
    (header!.props.onKeyPress as (event: unknown) => void)({
      key,
      nativeEvent: { key },
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  });
}

function activeDescendant(screen: Screen): string | undefined {
  return screen
    .findAllByTestId('sl:header')
    .map((node) => node.props?.activeDescendantId)
    .find((value) => typeof value === 'string');
}

describe('SelectionList virtualized reveal follows the keyboard, never the pointer', () => {
  beforeEach(() => scrollToIndex.mockClear());

  it('highlights a hovered row without scrolling, then reveals the row an arrow key moves to', async () => {
    const screen = await renderScreen(<SelectionList {...props()} />);
    scrollToIndex.mockClear();

    await movePointerOver(screen, 'opt-30');
    expect(activeDescendant(screen)).toBe('sl:root:option:opt-30');
    // A hover that scrolled would slide the row away and snap every wheel scroll back to it.
    expect(scrollToIndex).not.toHaveBeenCalled();

    await pressKey(screen, 'ArrowDown');
    expect(activeDescendant(screen)).toBe('sl:root:option:opt-31');
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ viewPosition: 0.5 }),
    );
  });
});
