import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderScreen } from '@/dev/testkit';
import { hitAreaClippingAncestors } from '@/dev/testkit/harness/hitFrameReach';
import { LookChip, LookPopover } from './LookChip';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('@/components/ui/popover', async importOriginal =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

describe('LookChip', () => {
  it('mounts the Look surface only while the chip is open', async () => {
    const screen = await renderScreen(<LookChip target={{ surface: 'home' }} />);
    try {
      expect(screen.root.findAllByType(LookPopover)).toHaveLength(0);
      await act(async () => { screen.pressByTestId('look-chip'); });
      await vi.waitFor(() => expect(screen.findByTestId('look-panel')).toBeTruthy());
      await act(async () => { screen.root.findByType(LookPopover).props.onRequestClose(); });
      expect(screen.root.findAllByType(LookPopover)).toHaveLength(0);
    } finally { await screen.unmount(); }
  });

  it('lets a finger reach the 28 px chip past its glass pill (the pill never clips its button)', async () => {
    const screen = await renderScreen(<LookChip target={{ surface: 'home' }} testID="look-chip" />);
    expect(hitAreaClippingAncestors(screen.findHostByTestId('look-chip')!).map((node) => String(node.props.testID ?? node.type))).toEqual([]);
  });
});
