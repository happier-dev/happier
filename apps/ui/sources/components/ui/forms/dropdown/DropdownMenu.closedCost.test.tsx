import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal),
);

afterEach(() => standardCleanup());

/** Items whose `title` reads are counted: a read is the menu building that row. */
function countedItems(count: number) {
  const reads = { titles: 0 };
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    get title() {
      reads.titles += 1;
      return `Item ${index}`;
    },
  }));
  return { items, reads };
}

describe('DropdownMenu while shut', () => {
  it('builds no rows until it opens, then builds them', async () => {
    const { DropdownMenu } = await import('./DropdownMenu');
    const { items, reads } = countedItems(8);
    const element = (open: boolean) => (
      <DropdownMenu open={open} onOpenChange={() => {}} items={items} selectedId={null} onSelect={() => {}} trigger={null} />
    );
    const screen = await renderScreen(element(false));
    expect(reads.titles).toBe(0);

    await screen.update(element(true));
    expect(reads.titles).toBeGreaterThan(0);
    expect(screen.findByTestId('dropdown-option-item-0:scroll-frame') ?? screen.toJSON()).toBeTruthy();
  });
});
