import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

// The in-app font preference is device-local storage, outside the text owner.
vi.mock('@/sync/store/settingsReadHooks', () => ({ useLocalSetting: () => 1 }));

const { TextInput } = await import('./Text');
const { useUnistyles } = await import('react-native-unistyles');

afterEach(() => {
  standardCleanup();
});

describe('TextInput placeholder ink', () => {
  it('draws a placeholder in the theme placeholder ink unless the field names its own', async () => {
    let ink: string | null = null;
    function Probe() {
      ink = useUnistyles().theme.colors.input.placeholder;
      return null;
    }
    const screen = await renderScreen(
      <>
        <Probe />
        <TextInput testID="plain" placeholder="Enter URL" value="" />
        <TextInput
          testID="own"
          placeholder="Search"
          placeholderTextColor="#123456"
          value=""
        />
      </>,
    );
    expect(screen.findHostByTestId('plain')?.props.placeholderTextColor).toBe(
      ink,
    );
    expect(screen.findHostByTestId('own')?.props.placeholderTextColor).toBe(
      '#123456',
    );
  });
});
