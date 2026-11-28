import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppLaunchState } from './AppLaunchState';

const reducedMotion = vi.hoisted(() => ({ value: false }));

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' },
  ),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => reducedMotion.value,
}));
vi.mock('@/components/atmosphere/glyph/glyphAtlas.native', async () => ({
  glyphAtlas: (await import('@/dev/testkit/mocks/reactNativeSkia'))
    .createGlyphAtlasRasterMock,
}));
vi.mock('@shopify/react-native-skia', async () =>
  (
    await import('@/dev/testkit/mocks/reactNativeSkia')
  ).createReactNativeSkiaGlyphMock(),
);

afterEach(() => {
  standardCleanup();
  reducedMotion.value = false;
});

// Phones have no launch curtain (boot stays under the Expo splash): Account restore continues the splash's planet itself.
it('continues the splash with the live Loading planet while Account restore is pending', async () => {
  const screen = await renderScreen(
    <AppLaunchState testID="workspace-account-restoring" />,
  );
  await vi.dynamicImportSettled();

  expect(screen.findHostByTestId('launch-curtain-live')).not.toBeNull();
});

it("keeps reduced motion on the splash's still planet", async () => {
  reducedMotion.value = true;
  const screen = await renderScreen(
    <AppLaunchState testID="workspace-account-restoring" />,
  );
  await vi.dynamicImportSettled();

  expect(screen.findHostByTestId('launch-curtain-still')).not.toBeNull();
  expect(screen.findHostByTestId('launch-curtain-live')).toBeNull();
});
