/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StyleSheet, View } from 'react-native';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

const { PaneHeader } = await import('./PaneHeader');

describe('PaneHeader band', () => {
  it('leaves the identity block the room a header action reaches into: half of the 6 px an action keeps from its neighbour', async () => {
    const screen = await renderScreen(
      <PaneHeader
        testID="header"
        title="Title"
        actions={<View testID="first-action" />}
      />,
    );
    const band = StyleSheet.flatten(screen.findHostByTestId('header')!.props.style) as { gap?: number };
    const actions = StyleSheet.flatten(screen.findHostByTestId('first-action')!.parent!.props.style) as { marginLeft?: number };
    // The leading action's hit area reaches 3 px toward the title; the title block's own controls
    // (a flush lineage link) keep the other 3, so the two never overlap.
    expect((band.gap ?? 0) + (actions.marginLeft ?? 0)).toBeGreaterThanOrEqual(6);
  });

  it('bounds Back to half of the band gap before the identity block, so the mark beside it never covers its reach', async () => {
    const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
    const { layoutHitArea } = await import('@/dev/testkit/harness/hitFrameReach');
    const screen = await renderScreen(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <PaneHeader testID="header" title="Title" navigation={{ onBack: () => {}, backTestID: 'back' }} />
      </HappierUiPlatformProvider>,
    );
    const back = await layoutHitArea(() => screen.findByTestId('back'), { width: 28, height: 28 });
    expect(back.insets.right).toBeLessThanOrEqual(1);
  });
});
