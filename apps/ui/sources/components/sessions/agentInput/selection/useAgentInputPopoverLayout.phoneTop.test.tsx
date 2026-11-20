/**
 * A composer popover on a phone opens below the page's top chrome (its header band and status line), as a
 * desktop window's keeps its title strip clear (PICKER-ACCEPT-1120 fix 9).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

const windowSize = vi.hoisted(() => ({ width: 390, height: 844 }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    useWindowDimensions: () => ({
      width: windowSize.width,
      height: windowSize.height,
      scale: 1,
      fontScale: 1,
    }),
    Dimensions: {
      get: () => ({
        width: windowSize.width,
        height: windowSize.height,
        scale: 1,
        fontScale: 1,
      }),
    },
  });
});

const { useAgentInputPopoverLayout } =
  await import('./useAgentInputPopoverLayout');

afterEach(() => {
  windowSize.width = 390;
});

describe('useAgentInputPopoverLayout phone top', () => {
  it("keeps a phone composer popover below the page's header band", async () => {
    const layout = await renderHook(() =>
      useAgentInputPopoverLayout({ open: true }),
    );
    const top =
      layout.getCurrent().edgePadding.top ??
      layout.getCurrent().edgePadding.vertical;
    expect(top).toBeGreaterThanOrEqual(HAPPIER_PAGE_METRICS.paneHeaderHeightPx);
    await layout.unmount();
  });
});
