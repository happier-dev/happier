import * as React from 'react';
import { router } from 'expo-router';
import type { ExtendedStackNavigationOptions } from 'expo-router/build/layouts/StackClient';

import { DefaultBackButton } from '@/components/navigation/Header';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

type StackScreenOptions = ExtendedStackNavigationOptions;
type ScreenNavigation = Parameters<typeof safeRouterBack>[0]['navigation'];

/**
 * A pushed phone page reloaded on the web rebuilds with nothing below it, so the stack reports no `back`.
 * Such a page names its own way back, returning to Sessions and its bottom bar when nothing is behind it.
 */
export function withSessionsFallbackBack(
  base: StackScreenOptions,
  testID: string,
) {
  return ({
    navigation,
  }: {
    navigation: ScreenNavigation;
  }): StackScreenOptions => ({
    ...base,
    headerLeft: ({ tintColor }: { tintColor?: string }) => (
      <DefaultBackButton
        testID={testID}
        tintColor={tintColor}
        onPress={() =>
          safeRouterBack({ router, navigation, fallbackHref: '/' })
        }
      />
    ),
  });
}
