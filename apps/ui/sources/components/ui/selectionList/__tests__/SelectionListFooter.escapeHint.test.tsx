/**
 * The Escape hint is left out on a phone, whose surfaces carry a visible way out (Cancel, Back) that a keyboard
 * hint would only repeat. A narrow footer inside a desktop popover keeps it: there Esc is the only way out the
 * keys offer (PICKER-ACCEPT-1120, the model picker's ~455 px footer at 1440).
 */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const windowSize = vi.hoisted(() => ({ width: 1440, height: 900 }));

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

afterEach(() => {
  windowSize.width = 1440;
  windowSize.height = 900;
});

async function renderFooterAt(footerWidth: number) {
  const { SelectionListFooter } = await import('../SelectionListFooter');
  const screen = await renderScreen(
    <SelectionListFooter
      hints={[
        { id: 'move', label: '↑↓', description: 'move' },
        { id: 'close', label: 'esc', description: 'close' },
      ]}
      hardwareKeyboardAvailable
      testID="footer"
    />,
  );
  await act(async () => {
    screen
      .findByTestId('footer')
      ?.props.onLayout({ nativeEvent: { layout: { width: footerWidth } } });
  });
  return screen;
}

describe('SelectionListFooter Escape hint', () => {
  it('keeps the Escape hint in a narrow footer inside a desktop window', async () => {
    const screen = await renderFooterAt(366);
    expect(screen.findByTestId('footer:hint:close')).not.toBeNull();
    expect(screen.findByTestId('footer:hint:move')).not.toBeNull();
  });

  it('leaves the Escape hint out on a phone', async () => {
    windowSize.width = 390;
    windowSize.height = 844;
    const screen = await renderFooterAt(366);
    expect(screen.findByTestId('footer:hint:close')).toBeNull();
    expect(screen.findByTestId('footer:hint:move')).not.toBeNull();
  });
});
