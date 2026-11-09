import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { hitAreaClippingAncestors } from '@/dev/testkit/harness/hitFrameReach';
import { LookChip } from './LookChip';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

describe('LookChip', () => {
  it('lets a finger reach the 28 px chip past its glass pill (the pill never clips its button)', async () => {
    const screen = await renderScreen(<LookChip target={{ surface: 'home' }} testID="look-chip" />);
    expect(hitAreaClippingAncestors(screen.findHostByTestId('look-chip')!).map((node) => String(node.props.testID ?? node.type))).toEqual([]);
  });
});
