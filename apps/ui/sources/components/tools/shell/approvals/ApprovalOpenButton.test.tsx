import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  layoutHitArea,
  readHitArea,
} from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

import { ApprovalOpenButton } from './ApprovalOpenButton';

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } =
    await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

afterEach(standardCleanup);

describe('ApprovalOpenButton', () => {
  // DESIGN-REVIEW-OPUS-1128 P02: a 44/48 px layout box set the approval card head to 68 px, so the
  // at-rest facts lost a row to the bottom fade at 390. The drawn control stays the head's compact
  // square; only its touch target reaches past it.
  it('draws a compact square that does not set the card head height, with a full touch target', async () => {
    const onPress = vi.fn();
    const screen = await renderScreen(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <ApprovalOpenButton testID="open" onPress={onPress} />
      </HappierUiPlatformProvider>,
    );

    const drawn = readHitArea(screen.findByTestId('open')!).drawn;
    expect(drawn.height).toBeLessThanOrEqual(28);
    const area = await layoutHitArea(() => screen.findByTestId('open'), drawn);
    expect(area.height).toBeGreaterThanOrEqual(44);
    expect(area.width).toBeGreaterThanOrEqual(44);

    await screen.pressByTestIdAsync('open');
    expect(onPress).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
});
