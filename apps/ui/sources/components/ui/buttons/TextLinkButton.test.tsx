import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { renderScreen } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';

// A finger is the primary pointer (the platform fact the touch floor reads); everything above it is real.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});

const { TextLinkButton } = await import('./TextLinkButton');

function flattenStyle(styleProp: unknown): Record<string, unknown> {
  const resolved =
    typeof styleProp === 'function'
      ? (styleProp as (s: Record<string, boolean>) => unknown)({
          pressed: false,
          hovered: false,
          focused: false,
          selected: false,
          highlighted: false,
          busy: false,
          disabled: false,
        })
      : styleProp;
  const entries = Array.isArray(resolved)
    ? (resolved as unknown[]).flat(Infinity)
    : [resolved];
  return Object.assign({}, ...(entries.filter(Boolean) as object[]));
}

describe('TextLinkButton', () => {
  it('reaches the touch floor through the shared hit area: above and below its line, never sideways, never in flow', async () => {
    const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
    const screen = await renderScreen(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <TextLinkButton
          testID="link"
          label="Don't show again"
          onPress={() => {}}
        />
      </HappierUiPlatformProvider>,
    );
    const line = happierPageTextMetrics('rowDescription').lineHeight;
    const area = await layoutHitArea(() => screen.findByTestId('link'), { width: 96, height: line });
    const grow = (44 - line) / 2;
    expect(area.insets).toEqual({ top: grow, bottom: grow, left: 0, right: 0 });
    // None of it in flow: the words keep the sentence's line and baseline.
    const frame = flattenStyle(screen.findByTestId('link')!.props.style);
    for (const key of ['paddingTop', 'paddingBottom', 'marginTop', 'marginBottom']) expect(frame[key] ?? 0).toBe(0);
  });

  it('keeps its hit area inside the free space a host declares above and below the line', async () => {
    const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
    const { HappierTextLinkButton } = await import('@happier-dev/plugin-ui/presentation');
    const screen = await renderScreen(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <HappierTextLinkButton
          testID="link"
          label="Retry"
          onPress={() => {}}
          verticalReach={6}
          Text={({ children, style }) => <>{children}{void style}</>}
          labelStyle={{ fontSize: 12, lineHeight: 16 }}
          hoverColor="#000"
          focusColor="#000"
        />
      </HappierUiPlatformProvider>,
    );
    const area = await layoutHitArea(() => screen.findByTestId('link'), { width: 40, height: 16 });
    // The 44 px target alone would reach 14 px; the note's own padding leaves 6.
    expect(area.insets).toEqual({ top: 6, bottom: 6, left: 0, right: 0 });
  });

  it('reaches a host-requested pointer floor without a finger, still only above and below', async () => {
    const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
    const { HappierTextLinkButton } = await import('@happier-dev/plugin-ui/presentation');
    const screen = await renderScreen(
      <HappierUiPlatformProvider platform={{ platform: 'web', colorScheme: 'light' }}>
        <HappierTextLinkButton
          testID="link"
          label="Retry"
          onPress={() => {}}
          minimumTargetSize={24}
          Text={({ children }) => <>{children}</>}
          labelStyle={{ fontSize: 12, lineHeight: 16 }}
          hoverColor="#000"
          focusColor="#000"
        />
      </HappierUiPlatformProvider>,
    );
    const area = await layoutHitArea(() => screen.findByTestId('link'), { width: 40, height: 16 });
    expect(area.insets).toEqual({ top: 4, bottom: 4, left: 0, right: 0 });
  });
});
